const request = require('supertest');
const argon2 = require('argon2');
const mongoose = require('mongoose');

const mockDb = { users: [], faces: [] };

// Cada rosto e um vetor ortogonal: so o mesmo rosto corresponde a uma referencia guardada.
const mockFaceVectors = {
  'rosto-dono': [1, 0, 0, 0],
  'rosto-outro': [0, 1, 0, 0],
  'rosto-admin': [0, 0, 1, 0],
};
const mockSameVector = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// Portoes: seguram uma chamada em um ponto do fluxo ate o teste liberar, como um servico lento.
const mockGates = { extraction: null, profileLookup: null };
const mockPassGate = async (name) => {
  const gate = mockGates[name];
  if (!gate) return;
  gate.arrived += 1;
  gate.onArrival();
  await gate.opened;
};

const mockMatches = (record, filter) =>
  Object.entries(filter).every(([key, expected]) => {
    if (expected && Object.prototype.hasOwnProperty.call(expected, '$ne')) {
      return record[key] !== expected.$ne;
    }
    return String(record[key]) === String(expected);
  });

jest.mock('@google-cloud/storage', () => ({
  Storage: jest.fn().mockImplementation(() => ({
    bucket: jest.fn().mockReturnValue({ file: jest.fn() }),
  })),
}));

jest.mock('../utils/sendEmail', () => jest.fn().mockResolvedValue(true));

jest.mock('../middlewares/rateLimiters', () => {
  const passThrough = (_req, _res, next) => next();
  return {
    loginLimiter: passThrough,
    registerLimiter: passThrough,
    emailCodeLimiter: passThrough,
    codeValidationLimiter: passThrough,
  };
});

jest.mock('../services/faceService', () => ({
  extractEmbedding: jest.fn(async (image) => {
    const waits = image.startsWith('espera:');
    const name = waits ? image.slice('espera:'.length) : image;
    if (waits) await mockPassGate('extraction');
    return mockFaceVectors[name]
      ? { face_detected: true, embedding: mockFaceVectors[name], model: 'VGG-Face' }
      : { face_detected: false, erro: 'no face' };
  }),
  verifyFace: jest.fn(async (reference, image) => ({
    face_detected: true,
    match: mockSameVector(reference, mockFaceVectors[image]),
    distance: 0.1,
  })),
  // Como o /verify-multi: basta corresponder a uma das referencias.
  verifyFaceMulti: jest.fn(async (references, image) => ({
    face_detected: true,
    match: references.some((reference) => mockSameVector(reference, mockFaceVectors[image])),
    distance: 0.1,
  })),
}));

jest.mock('../models/User', () => {
  // Como o Mongoose: cada leitura e uma copia do momento da consulta, e save grava so o que mudou.
  const mockSnapshot = (record) => {
    if (!record) return null;
    const { save: _ignored, ...original } = record;
    const copy = { ...original };
    copy.save = async () => {
      Object.keys(copy).forEach((key) => {
        if (key !== 'save' && copy[key] !== original[key]) record[key] = copy[key];
      });
      return copy;
    };
    return copy;
  };
  const mockQuery = (value) => {
    const query = Promise.resolve(value);
    query.select = () => query;
    return query;
  };
  return {
    findOne: jest.fn(async ({ email }) => mockSnapshot(mockDb.users.find((user) => user.email === email))),
    findById: jest.fn((id) => mockQuery(mockSnapshot(mockDb.users.find((user) => String(user._id) === String(id))))),
    find: jest.fn(() => mockQuery(mockDb.users)),
    // A escrita condicional e atomica, como um update do MongoDB em um unico documento.
    findOneAndUpdate: jest.fn(async (filter, update) => {
      const user = mockDb.users.find((item) => mockMatches(item, filter));
      if (!user) return null;
      Object.assign(user, update.$set);
      return mockSnapshot(user);
    }),
  };
});

jest.mock('../models/FaceProfile', () => ({
  findOne: jest.fn(async (filter) => {
    await mockPassGate('profileLookup');
    return mockDb.faces.find((face) => mockMatches(face, filter)) || null;
  }),
  find: jest.fn((filter) => ({
    select: async () =>
      mockDb.faces.filter((face) => face.enrolled && String(face.userId) !== String(filter.userId.$ne)),
  })),
  // Upsert com indice unico em userId: filtro sem correspondencia e userId ja gravado dao E11000.
  findOneAndUpdate: jest.fn(async (filter, update) => {
    let face = mockDb.faces.find((item) => mockMatches(item, filter));
    if (!face) {
      if (mockDb.faces.some((item) => String(item.userId) === String(filter.userId))) {
        throw Object.assign(new Error('E11000 duplicate key error'), { code: 11000 });
      }
      face = {};
      mockDb.faces.push(face);
    }
    Object.assign(face, update.$set);
    Object.keys(update.$unset || {}).forEach((key) => delete face[key]);
    return face;
  }),
}));

const config = require('../config/config');
const faceService = require('../services/faceService');
const FaceProfile = require('../models/FaceProfile');
const { issueAuthToken, issueFaceSessionToken, verifyAuthToken } = require('../utils/faceAuth');
const { getStoredEmbeddings } = require('../utils/faceEmbeddings');
const app = require('../app');

const PASSWORD = 'SenhaOriginal@1';
const OWNER_FACE = 'rosto-dono';
const OTHER_FACE = 'rosto-outro';
const ADMIN_FACE = 'rosto-admin';
const NO_FACE = 'sem-rosto';
const SESSION_REJECTED = { erro: 'Sessão de verificação facial inválida ou expirada. Faça login novamente.' };

const login = (email, senha = PASSWORD) => request(app).post('/api/auth/login').send({ email, senha });
const enroll = (faceSessionToken, imagesBase64 = [OWNER_FACE, OWNER_FACE]) =>
  request(app).post('/api/face/enroll').send({ faceSessionToken, imagesBase64 });
const skip = (faceSessionToken) => request(app).post('/api/face/skip-enrollment').send({ faceSessionToken });
const verify = (faceSessionToken, imageBase64) =>
  request(app).post('/api/face/verify').send({ faceSessionToken, imageBase64 });
const enrollProfile = (token, body) =>
  request(app).post('/api/face/enroll-profile').set('Authorization', `Bearer ${token}`).send(body);
const adminRoute = (token) => request(app).get('/api/users').set('Authorization', `Bearer ${token}`);
// supertest so dispara ao ser aguardado: then inicia a chamada sem esperar a resposta.
const start = (call) => call.then((res) => res);

const closeGate = (name) => {
  const gate = { arrived: 0, waiters: [] };
  gate.opened = new Promise((resolve) => {
    gate.open = resolve;
  });
  gate.onArrival = () => {
    gate.waiters = gate.waiters.filter(({ count, resolve }) => {
      if (gate.arrived < count) return true;
      resolve();
      return false;
    });
  };
  gate.reached = (count) =>
    gate.arrived >= count ? Promise.resolve() : new Promise((resolve) => gate.waiters.push({ count, resolve }));
  mockGates[name] = gate;
  return gate;
};

describe('D48: a oferta de cadastro facial termina uma unica vez', () => {
  const originalEmbeddingKey = config.face.embeddingKey;
  let passwordHash;

  beforeAll(async () => {
    passwordHash = await argon2.hash(PASSWORD);
    config.face.embeddingKey = Buffer.alloc(32, 1).toString('base64');
  });

  afterAll(() => {
    config.face.embeddingKey = originalEmbeddingKey;
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockDb.users = [];
    mockDb.faces = [];
    mockGates.extraction = null;
    mockGates.profileLookup = null;
  });

  // Um teste que falha com o portao fechado nao pode deixar requisicao presa nem segurar o Jest.
  afterEach(() => {
    Object.values(mockGates).forEach((gate) => gate?.open());
  });

  const createAccount = (email, data = {}) => {
    const user = {
      _id: new mongoose.Types.ObjectId(),
      nome: `Nome ${email}`,
      email,
      senha: passwordHash,
      tipo: 'user',
      verificado: true,
      fotoPerfil: '',
      faceEnrollmentOffered: false,
      faceEnrollmentSkipped: false,
      ...data,
    };
    mockDb.users.push(user);
    return user;
  };

  const seedFace = (user, face = OWNER_FACE, enrolled = true) => {
    mockDb.faces.push({ userId: user._id, enrolled, embeddings: [mockFaceVectors[face]] });
  };

  const profilesOf = (user) => mockDb.faces.filter((face) => String(face.userId) === String(user._id));

  const facesOf = (user) => {
    const [profile] = profilesOf(user);
    if (!profile) return null;
    return getStoredEmbeddings(profile).map((embedding) =>
      Object.keys(mockFaceVectors).find((name) => mockSameVector(mockFaceVectors[name], Array.from(embedding)))
    );
  };

  const flagsOf = ({ faceEnrollmentOffered, faceEnrollmentSkipped }) => ({ faceEnrollmentOffered, faceEnrollmentSkipped });

  const expectAccessTokenOf = (res, user) => {
    expect(res.status).toBe(200);
    const decoded = verifyAuthToken(res.body.token);
    expect(String(decoded.id)).toBe(String(user._id));
    expect(decoded.tokenType).toBe('access');
  };

  const expectRejected = (res) => {
    expect(res.status).toBe(401);
    expect(res.body).toEqual(SESSION_REJECTED);
  };

  // Oferta real: login com senha correta de uma conta que ainda nao recebeu a oferta.
  const startOffer = async (email = 'a@exemplo.com', data = {}) => {
    const user = createAccount(email, data);
    const res = await login(email);
    expect(res.body.requiresFaceEnrollmentOffer).toBe(true);
    expect(res.body.token).toBeUndefined();
    return { user, offerToken: res.body.faceSessionToken };
  };

  describe('A: primeiro cadastro legitimo', () => {
    test('a oferta cadastra o rosto e entrega o JWT', async () => {
      const { user, offerToken } = await startOffer();

      const res = await enroll(offerToken);

      expectAccessTokenOf(res, user);
      expect(facesOf(user)).toEqual([OWNER_FACE, OWNER_FACE]);
    });

    test('o formato do mobile, com uma imagem, tambem cadastra', async () => {
      const { user, offerToken } = await startOffer();

      const res = await request(app)
        .post('/api/face/enroll')
        .send({ faceSessionToken: offerToken, imageBase64: OWNER_FACE });

      expectAccessTokenOf(res, user);
      expect(facesOf(user)).toEqual([OWNER_FACE]);
    });

    test('o login seguinte exige o rosto cadastrado', async () => {
      const { user, offerToken } = await startOffer();
      await enroll(offerToken);

      const next = await login(user.email);

      expect(next.body.requiresFaceVerification).toBe(true);
      expect(next.body.token).toBeUndefined();
      expectAccessTokenOf(await verify(next.body.faceSessionToken, OWNER_FACE), user);
    });
  });

  describe('B: mesmo token depois do cadastro', () => {
    test('/enroll de novo e recusado, sem JWT, sem processar a imagem e sem tocar no perfil', async () => {
      const { user, offerToken } = await startOffer();
      await enroll(offerToken);
      faceService.extractEmbedding.mockClear();

      const res = await enroll(offerToken, [OTHER_FACE, OTHER_FACE]);

      expectRejected(res);
      expect(res.body.token).toBeUndefined();
      expect(faceService.extractEmbedding).not.toHaveBeenCalled();
      expect(facesOf(user)).toEqual([OWNER_FACE, OWNER_FACE]);
    });

    test('a outra pessoa continua sem entrar e o dono continua entrando', async () => {
      const { user, offerToken } = await startOffer();
      await enroll(offerToken);
      await enroll(offerToken, [OTHER_FACE, OTHER_FACE]);

      const { body } = await login(user.email);

      expect((await verify(body.faceSessionToken, OTHER_FACE)).status).toBe(401);
      expectAccessTokenOf(await verify(body.faceSessionToken, OWNER_FACE), user);
    });
  });

  describe('C: cadastro e depois pular', () => {
    test('/skip-enrollment e recusado, sem JWT e sem alterar o estado', async () => {
      const { user, offerToken } = await startOffer();
      await enroll(offerToken);
      const flags = flagsOf(user);

      const res = await skip(offerToken);

      expectRejected(res);
      expect(res.body.token).toBeUndefined();
      expect(flagsOf(user)).toEqual(flags);
      expect(user.faceEnrollmentSkipped).toBe(false);
    });

    test('o rosto continua exigido no login seguinte', async () => {
      const { user, offerToken } = await startOffer();
      await enroll(offerToken);
      await skip(offerToken);

      const next = await login(user.email);

      expect(next.body.requiresFaceVerification).toBe(true);
      expect(next.body.token).toBeUndefined();
    });
  });

  describe('D: pular legitimo', () => {
    test('entrega o JWT e registra a recusa', async () => {
      const { user, offerToken } = await startOffer();

      const res = await skip(offerToken);

      expectAccessTokenOf(res, user);
      expect(user.faceEnrollmentSkipped).toBe(true);
      expect(user.faceEnrollmentOffered).toBe(true);
    });

    test('o login seguinte entrega o JWT, sem nova oferta', async () => {
      const { user, offerToken } = await startOffer();
      await skip(offerToken);

      const next = await login(user.email);

      expectAccessTokenOf(next, user);
      expect(next.body.requiresFaceEnrollmentOffer).toBeUndefined();
    });
  });

  describe('E: pular e depois cadastrar', () => {
    test('/enroll e recusado e nenhum perfil e criado', async () => {
      const { user, offerToken } = await startOffer();
      await skip(offerToken);
      faceService.extractEmbedding.mockClear();

      const res = await enroll(offerToken, [OTHER_FACE, OTHER_FACE]);

      expectRejected(res);
      expect(res.body.token).toBeUndefined();
      expect(faceService.extractEmbedding).not.toHaveBeenCalled();
      expect(profilesOf(user)).toHaveLength(0);
    });
  });

  describe('F: pular duas vezes', () => {
    test('a segunda chamada e recusada, sem JWT', async () => {
      const { offerToken } = await startOffer();
      await skip(offerToken);

      const res = await skip(offerToken);

      expectRejected(res);
      expect(res.body.token).toBeUndefined();
    });
  });

  describe('G: token de verify nao conclui oferta', () => {
    test.each([
      ['/enroll', (token) => enroll(token, [OTHER_FACE, OTHER_FACE])],
      ['/skip-enrollment', (token) => skip(token)],
    ])('%s recusa o token de quem ja tem rosto', async (_route, call) => {
      const user = createAccount('c@exemplo.com', { faceEnrollmentOffered: true });
      seedFace(user);
      const { body } = await login(user.email);
      expect(body.requiresFaceVerification).toBe(true);

      const res = await call(body.faceSessionToken);

      expectRejected(res);
      expect(facesOf(user)).toEqual([OWNER_FACE]);
      expect(user.faceEnrollmentSkipped).toBe(false);
    });

    test.each([
      ['/enroll', (token) => enroll(token, [OTHER_FACE, OTHER_FACE])],
      ['/skip-enrollment', (token) => skip(token)],
    ])('%s recusa o token de verify mesmo com a oferta pendente', async (_route, call) => {
      const { user, offerToken } = await startOffer();

      expectRejected(await call(issueFaceSessionToken(user._id, 'face_verify')));

      expect(profilesOf(user)).toHaveLength(0);
      expect(user.faceEnrollmentSkipped).toBe(false);
      expectAccessTokenOf(await enroll(offerToken), user);
    });
  });

  describe('H: token de oferta nao serve para /verify', () => {
    test('nem com o rosto certo', async () => {
      const { user, offerToken } = await startOffer();
      await enroll(offerToken);

      const res = await verify(offerToken, OWNER_FACE);

      expectRejected(res);
      expect(res.body.token).toBeUndefined();
    });
  });

  describe('perfil existente nunca e substituido por /face/enroll', () => {
    test('conta com perfil, flags de antes da correcao: /enroll recusa e o perfil fica intacto', async () => {
      const user = createAccount('a@exemplo.com', { faceEnrollmentOffered: true });
      seedFace(user);

      const res = await enroll(issueFaceSessionToken(user._id, 'face_enroll'), [OTHER_FACE, OTHER_FACE]);

      expectRejected(res);
      expect(facesOf(user)).toEqual([OWNER_FACE]);
      expect(FaceProfile.findOneAndUpdate).not.toHaveBeenCalled();
    });

    test('conta com perfil: /skip-enrollment nao burla o rosto', async () => {
      const user = createAccount('a@exemplo.com', { faceEnrollmentOffered: true });
      seedFace(user);

      const res = await skip(issueFaceSessionToken(user._id, 'face_enroll'));

      expectRejected(res);
      expect(res.body.token).toBeUndefined();
      expect(user.faceEnrollmentSkipped).toBe(false);
    });

    test('perfil criado por /enroll-profile depois da oferta: o token antigo nao substitui nem pula', async () => {
      const { user, offerToken } = await startOffer();
      const saved = await enrollProfile(issueAuthToken(user), {
        imagesBase64: [OWNER_FACE, OWNER_FACE],
        senhaAtual: PASSWORD,
      });
      expect(saved.status).toBe(200);

      expectRejected(await enroll(offerToken, [OTHER_FACE, OTHER_FACE]));
      expectRejected(await skip(offerToken));

      expect(facesOf(user)).toEqual([OWNER_FACE, OWNER_FACE]);
      expect(user.faceEnrollmentSkipped).toBe(false);
    });

    test('recusar a oferta e cadastrar pelo perfil: o token antigo nao pula o rosto', async () => {
      const { user, offerToken } = await startOffer();
      const skipped = await skip(offerToken);
      await enrollProfile(skipped.body.token, { imagesBase64: [OWNER_FACE, OWNER_FACE], senhaAtual: PASSWORD });

      const res = await skip(offerToken);

      expectRejected(res);
      expect((await login(user.email)).body.requiresFaceVerification).toBe(true);
    });

    test('admin com rosto: o token de oferta nao troca nem pula o rosto', async () => {
      const admin = createAccount('admin@exemplo.com', { tipo: 'admin', faceEnrollmentOffered: true });
      seedFace(admin, ADMIN_FACE);
      const offerToken = issueFaceSessionToken(admin._id, 'face_enroll');

      expectRejected(await enroll(offerToken, [OTHER_FACE, OTHER_FACE]));
      expectRejected(await skip(offerToken));

      expect(facesOf(admin)).toEqual([ADMIN_FACE]);
    });

    test('perfil inativo nao conta como cadastro: a oferta ainda conclui', async () => {
      const user = createAccount('a@exemplo.com', { faceEnrollmentOffered: true });
      seedFace(user, OTHER_FACE, false);

      const res = await enroll(issueFaceSessionToken(user._id, 'face_enroll'));

      expectAccessTokenOf(res, user);
      expect(profilesOf(user)).toHaveLength(1);
      expect(facesOf(user)).toEqual([OWNER_FACE, OWNER_FACE]);
    });
  });

  describe('estado da oferta', () => {
    const OFFER_ROUTES = [
      ['/enroll', (token) => enroll(token)],
      ['/skip-enrollment', (token) => skip(token)],
    ];

    describe.each(OFFER_ROUTES)('%s', (_route, call) => {
      test('oferta nunca feita e recusada', async () => {
        const user = createAccount('a@exemplo.com', { faceEnrollmentOffered: false });

        expectRejected(await call(issueFaceSessionToken(user._id, 'face_enroll')));

        expect(profilesOf(user)).toHaveLength(0);
        expect(user.faceEnrollmentSkipped).toBe(false);
      });

      test('recusa gravada antes da correcao e recusada', async () => {
        const user = createAccount('a@exemplo.com', { faceEnrollmentOffered: true, faceEnrollmentSkipped: true });

        expectRejected(await call(issueFaceSessionToken(user._id, 'face_enroll')));

        expect(profilesOf(user)).toHaveLength(0);
      });

      test('oferta ja concluida e recusada, mesmo sem perfil', async () => {
        const user = createAccount('a@exemplo.com', {
          faceEnrollmentOffered: true,
          faceEnrollmentOfferConcluded: true,
        });

        expectRejected(await call(issueFaceSessionToken(user._id, 'face_enroll')));

        expect(profilesOf(user)).toHaveLength(0);
        expect(user.faceEnrollmentSkipped).toBe(false);
      });

      test('conta antiga, sem o campo novo, conclui normalmente', async () => {
        const user = createAccount('a@exemplo.com', { faceEnrollmentOffered: true });
        expect(user.faceEnrollmentOfferConcluded).toBeUndefined();

        expectAccessTokenOf(await call(issueFaceSessionToken(user._id, 'face_enroll')), user);
      });
    });
  });

  describe('uma tentativa que falhou nao gasta a oferta', () => {
    test('foto sem rosto responde 400 e o mesmo token cadastra depois', async () => {
      const { user, offerToken } = await startOffer();

      expect((await enroll(offerToken, [NO_FACE, NO_FACE])).status).toBe(400);
      expect(profilesOf(user)).toHaveLength(0);

      expectAccessTokenOf(await enroll(offerToken), user);
      expect(facesOf(user)).toEqual([OWNER_FACE, OWNER_FACE]);
    });

    test('segunda foto sem rosto nao salva nada e o mesmo token ainda pode pular', async () => {
      const { user, offerToken } = await startOffer();

      expect((await enroll(offerToken, [OWNER_FACE, NO_FACE])).status).toBe(400);

      expect(profilesOf(user)).toHaveLength(0);
      expectAccessTokenOf(await skip(offerToken), user);
    });

    test('rosto de outra conta responde 409 e o mesmo token cadastra outro rosto', async () => {
      const dono = createAccount('dono@exemplo.com', { faceEnrollmentOffered: true });
      seedFace(dono, OTHER_FACE);
      const { user, offerToken } = await startOffer();

      const duplicate = await enroll(offerToken, [OTHER_FACE, OTHER_FACE]);
      expect(duplicate.status).toBe(409);
      expect(duplicate.body.codigo).toBe('FACE_DUPLICATE');
      expect(profilesOf(user)).toHaveLength(0);

      expectAccessTokenOf(await enroll(offerToken), user);
    });

    test('servico facial fora do ar nao gasta a oferta', async () => {
      const { user, offerToken } = await startOffer();
      faceService.extractEmbedding.mockRejectedValueOnce(
        Object.assign(new Error('Serviço facial indisponível.'), { statusCode: 503 })
      );

      expect((await enroll(offerToken)).status).toBe(503);

      expectAccessTokenOf(await enroll(offerToken), user);
    });
  });

  describe('falha ao salvar o perfil', () => {
    test('responde 500 sem JWT, nada e salvo e a conta segue entrando com a senha', async () => {
      const { user, offerToken } = await startOffer();
      FaceProfile.findOneAndUpdate.mockRejectedValueOnce(new Error('banco indisponivel'));

      const res = await enroll(offerToken);

      expect(res.status).toBe(500);
      expect(res.body.token).toBeUndefined();
      expect(profilesOf(user)).toHaveLength(0);
      // A oferta ja foi assumida: o token nao vale de novo e o cadastro segue possivel pelo perfil.
      expectRejected(await enroll(offerToken));
      expectAccessTokenOf(await login(user.email), user);
    });
  });

  describe('chamadas simultaneas com o mesmo token', () => {
    test('/enroll + /enroll: uma conclui, a outra e recusada e nao sobrescreve', async () => {
      const { user, offerToken } = await startOffer();
      const gate = closeGate('extraction');

      const calls = [
        start(enroll(offerToken, [`espera:${OWNER_FACE}`])),
        start(enroll(offerToken, [`espera:${OTHER_FACE}`])),
      ];
      await gate.reached(2);
      gate.open();
      const results = await Promise.all(calls);

      const winners = results.filter((res) => res.status === 200);
      const losers = results.filter((res) => res.status !== 200);
      expect(winners).toHaveLength(1);
      expectAccessTokenOf(winners[0], user);
      expectRejected(losers[0]);
      expect(losers[0].body.token).toBeUndefined();
      expect(profilesOf(user)).toHaveLength(1);
      expect(facesOf(user)).toEqual(winners[0] === results[0] ? [OWNER_FACE] : [OTHER_FACE]);
    });

    test('/skip durante a extracao do /enroll: o /enroll atrasado e recusado e nada e salvo', async () => {
      const { user, offerToken } = await startOffer();
      const gate = closeGate('extraction');

      const enrolling = start(enroll(offerToken, [`espera:${OTHER_FACE}`]));
      await gate.reached(1);
      const skipped = await skip(offerToken);
      gate.open();
      const late = await enrolling;

      expectAccessTokenOf(skipped, user);
      expectRejected(late);
      expect(late.body.token).toBeUndefined();
      expect(profilesOf(user)).toHaveLength(0);
      expect(user.faceEnrollmentSkipped).toBe(true);
    });

    test('/enroll + /skip depois de ambos lerem a oferta: uma conclui, a outra e recusada', async () => {
      const { user, offerToken } = await startOffer();
      const gate = closeGate('profileLookup');

      const calls = [start(enroll(offerToken)), start(skip(offerToken))];
      await gate.reached(2);
      gate.open();
      const results = await Promise.all(calls);

      expect(results.filter((res) => res.status === 200)).toHaveLength(1);
      expect(results.filter((res) => res.status === 401)).toHaveLength(1);
      // Cadastro e recusa nunca ficam registrados juntos.
      expect(profilesOf(user).length + (user.faceEnrollmentSkipped ? 1 : 0)).toBe(1);
    });

    test('/skip + /skip depois de ambos lerem a oferta: so um JWT', async () => {
      const { offerToken } = await startOffer();
      const gate = closeGate('profileLookup');

      const calls = [start(skip(offerToken)), start(skip(offerToken))];
      await gate.reached(2);
      gate.open();
      const results = await Promise.all(calls);

      expect(results.filter((res) => res.body.token)).toHaveLength(1);
      expect(results.filter((res) => res.status === 401)).toHaveLength(1);
    });

    test('/enroll-profile conclui durante a extracao: o /enroll atrasado nao sobrescreve', async () => {
      const { user, offerToken } = await startOffer();
      const gate = closeGate('extraction');

      const enrolling = start(enroll(offerToken, [`espera:${OTHER_FACE}`]));
      await gate.reached(1);
      const saved = await enrollProfile(issueAuthToken(user), {
        imagesBase64: [OWNER_FACE, OWNER_FACE],
        senhaAtual: PASSWORD,
      });
      gate.open();
      const late = await enrolling;

      expect(saved.status).toBe(200);
      expectRejected(late);
      expect(late.body.token).toBeUndefined();
      expect(profilesOf(user)).toHaveLength(1);
      expect(facesOf(user)).toEqual([OWNER_FACE, OWNER_FACE]);
    });
  });

  describe('o que nao muda', () => {
    test('login facial: o token de verify segue reutilizavel entre tentativas', async () => {
      const user = createAccount('c@exemplo.com', { faceEnrollmentOffered: true });
      seedFace(user);
      const { body } = await login(user.email);

      expect((await verify(body.faceSessionToken, OTHER_FACE)).status).toBe(401);
      expectAccessTokenOf(await verify(body.faceSessionToken, OWNER_FACE), user);
      expectAccessTokenOf(await verify(body.faceSessionToken, OWNER_FACE), user);
    });

    test('admin com rosto: senha, sessao facial, rosto correto e rota de admin', async () => {
      const admin = createAccount('admin@exemplo.com', { tipo: 'admin', faceEnrollmentOffered: true });
      seedFace(admin, ADMIN_FACE);

      const { body } = await login(admin.email);
      expect(body.requiresFaceVerification).toBe(true);
      expect(body.token).toBeUndefined();
      expect((await verify(body.faceSessionToken, OTHER_FACE)).status).toBe(401);

      const res = await verify(body.faceSessionToken, ADMIN_FACE);

      expectAccessTokenOf(res, admin);
      expect((await adminRoute(res.body.token)).status).toBe(200);
    });

    test('admin sem rosto: JWT direto, sem oferta', async () => {
      const admin = createAccount('admin@exemplo.com', { tipo: 'admin' });

      const res = await login(admin.email);

      expectAccessTokenOf(res, admin);
      expect(res.body.requiresFaceEnrollmentOffer).toBeUndefined();
      expect(admin.faceEnrollmentOffered).toBe(false);
    });

    test('oferta sem resposta: o segundo login entra direto e o token anterior ainda conclui uma vez', async () => {
      const { user, offerToken } = await startOffer();

      expectAccessTokenOf(await login(user.email), user);

      expectAccessTokenOf(await skip(offerToken), user);
      expectRejected(await skip(offerToken));
    });

    describe('/face/enroll-profile continua sendo a rota de atualizacao (D42)', () => {
      const afterOffer = async () => {
        const { user, offerToken } = await startOffer();
        const res = await enroll(offerToken);
        return { user, token: res.body.token };
      };

      test('sem a senha atual: 400 e perfil intacto', async () => {
        const { user, token } = await afterOffer();

        const res = await enrollProfile(token, { imagesBase64: [OWNER_FACE] });

        expect(res.status).toBe(400);
        expect(facesOf(user)).toEqual([OWNER_FACE, OWNER_FACE]);
      });

      test('captura mista: 403 e perfil intacto', async () => {
        const { user, token } = await afterOffer();

        const res = await enrollProfile(token, { imagesBase64: [OWNER_FACE, OTHER_FACE], senhaAtual: PASSWORD });

        expect(res.status).toBe(403);
        expect(facesOf(user)).toEqual([OWNER_FACE, OWNER_FACE]);
      });

      test('dono com a senha atual atualiza', async () => {
        const { user, token } = await afterOffer();

        const res = await enrollProfile(token, { imagesBase64: [OWNER_FACE], senhaAtual: PASSWORD });

        expect(res.status).toBe(200);
        expect(facesOf(user)).toEqual([OWNER_FACE]);
      });
    });
  });
});
