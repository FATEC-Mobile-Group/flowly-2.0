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
    sensitivePasswordActionLimiter: passThrough,
    faceVerifyLimiter: passThrough,
  };
});

jest.mock('../services/faceService', () => ({
  extractEmbedding: jest.fn(async (image) =>
    mockFaceVectors[image]
      ? { face_detected: true, embedding: mockFaceVectors[image], model: 'VGG-Face' }
      : { face_detected: false, erro: 'no face' }
  ),
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
  // Consulta do Mongoose: pode ser aguardada direto ou encadeada com select.
  const mockQuery = (value) => {
    const query = Promise.resolve(value);
    query.select = () => query;
    return query;
  };
  return {
    findOne: jest.fn(async ({ email }) => mockDb.users.find((user) => user.email === email) || null),
    findById: jest.fn((id) => mockQuery(mockDb.users.find((user) => String(user._id) === String(id)) || null)),
    find: jest.fn(() => mockQuery(mockDb.users)),
    // Update condicional que conclui a oferta facial.
    findOneAndUpdate: jest.fn(async ({ _id }, update) => {
      const user = mockDb.users.find((item) => String(item._id) === String(_id));
      return user && !user.faceEnrollmentOfferConcluded ? Object.assign(user, update.$set) : null;
    }),
  };
});

jest.mock('../models/FaceProfile', () => ({
  findOne: jest.fn(async ({ userId, enrolled }) =>
    mockDb.faces.find((face) => String(face.userId) === String(userId) && face.enrolled === enrolled) || null
  ),
  find: jest.fn((filter) => ({
    select: async () =>
      mockDb.faces.filter((face) => face.enrolled && String(face.userId) !== String(filter.userId.$ne)),
  })),
  findOneAndUpdate: jest.fn(async ({ userId }, update) => {
    let face = mockDb.faces.find((item) => String(item.userId) === String(userId));
    if (!face) {
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
const { issueAuthToken, verifyAuthToken } = require('../utils/faceAuth');
const { getStoredEmbeddings } = require('../utils/faceEmbeddings');
const app = require('../app');

const PASSWORD = 'SenhaOriginal@1';
const WRONG_PASSWORD = 'SenhaErrada@999';
const OWNER_FACE = 'rosto-dono';
const OTHER_FACE = 'rosto-outro';
const ADMIN_FACE = 'rosto-admin';
const REQUIRED_MESSAGE = 'Senha atual é obrigatória.';
const WRONG_MESSAGE = 'Senha atual incorreta.';

const enrollProfile = (token, body) => {
  const req = request(app).post('/api/face/enroll-profile');
  return (token ? req.set('Authorization', `Bearer ${token}`) : req).send(body);
};
const login = (email, senha = PASSWORD) => request(app).post('/api/auth/login').send({ email, senha });
const verifyFace = (faceSessionToken, imageBase64) =>
  request(app).post('/api/face/verify').send({ faceSessionToken, imageBase64 });
const enrollWithSession = (faceSessionToken, imagesBase64) =>
  request(app).post('/api/face/enroll').send({ faceSessionToken, imagesBase64 });
const skipOffer = (faceSessionToken) =>
  request(app).post('/api/face/skip-enrollment').send({ faceSessionToken });
const faceStatus = (token) => request(app).get('/api/face/status').set('Authorization', `Bearer ${token}`);
const adminRoute = (token) => request(app).get('/api/users').set('Authorization', `Bearer ${token}`);

describe('rosto e login', () => {
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
      faceEnrollmentOffered: true,
      faceEnrollmentSkipped: true,
      save: jest.fn().mockResolvedValue(true),
      ...data,
    };
    user.toObject = () => ({ ...user });
    mockDb.users.push(user);
    return user;
  };

  const seedFace = (user, face = OWNER_FACE, enrolled = true) => {
    mockDb.faces.push({ userId: user._id, enrolled, embeddings: [mockFaceVectors[face]] });
  };

  const facesOf = (user) => {
    const profile = mockDb.faces.find((face) => String(face.userId) === String(user._id));
    if (!profile) return null;
    return getStoredEmbeddings(profile).map((embedding) =>
      Object.keys(mockFaceVectors).find((name) => mockSameVector(mockFaceVectors[name], Array.from(embedding)))
    );
  };

  const expectAccessTokenOf = (res, user) => {
    expect(res.status).toBe(200);
    const decoded = verifyAuthToken(res.body.token);
    expect(String(decoded.id)).toBe(String(user._id));
    expect(decoded.tipo).toBe(user.tipo);
    expect(decoded.tokenType).toBe('access');
  };

  describe('D42: POST /api/face/enroll-profile exige reautenticacao', () => {
    describe('A: JWT valido sem senha atual', () => {
      test.each([
        ['ausente', {}],
        ['vazia', { senhaAtual: '' }],
        ['nula', { senhaAtual: null }],
        ['numero', { senhaAtual: 12345678 }],
        ['array', { senhaAtual: [PASSWORD] }],
        ['objeto', { senhaAtual: { $ne: null } }],
      ])('senha %s responde 400, sem perfil e sem chamar o servico facial', async (_label, extra) => {
        const user = createAccount('a@exemplo.com');

        const res = await enrollProfile(issueAuthToken(user), {
          imagesBase64: [OTHER_FACE, OTHER_FACE],
          ...extra,
        });

        expect(res.status).toBe(400);
        expect(res.body).toEqual({ erro: REQUIRED_MESSAGE });
        expect(mockDb.faces).toHaveLength(0);
        expect(faceService.extractEmbedding).not.toHaveBeenCalled();
      });

      test('o formato do mobile, com uma imagem, tambem exige a senha', async () => {
        const user = createAccount('a@exemplo.com');

        const res = await enrollProfile(issueAuthToken(user), { imageBase64: OTHER_FACE });

        expect(res.status).toBe(400);
        expect(mockDb.faces).toHaveLength(0);
      });

      test('sem imagem continua respondendo o erro de imagem', async () => {
        const user = createAccount('a@exemplo.com');

        const res = await enrollProfile(issueAuthToken(user), { senhaAtual: PASSWORD });

        expect(res.status).toBe(400);
        expect(res.body.erro).toMatch(/imageBase64/);
        expect(mockDb.faces).toHaveLength(0);
      });

      test('o dono continua entrando so com a senha depois da tentativa', async () => {
        const user = createAccount('a@exemplo.com');
        await enrollProfile(issueAuthToken(user), { imagesBase64: [OTHER_FACE, OTHER_FACE] });

        expectAccessTokenOf(await login(user.email), user);
      });
    });

    describe('B: senha atual errada', () => {
      test('responde 400, sem perfil e sem chamar o servico facial', async () => {
        const user = createAccount('a@exemplo.com');

        const res = await enrollProfile(issueAuthToken(user), {
          imagesBase64: [OTHER_FACE, OTHER_FACE],
          senhaAtual: WRONG_PASSWORD,
        });

        expect(res.status).toBe(400);
        expect(res.body).toEqual({ erro: WRONG_MESSAGE });
        expect(mockDb.faces).toHaveLength(0);
        expect(faceService.extractEmbedding).not.toHaveBeenCalled();
      });

      test('o JWT continua valido, pois a sessao nao deve cair', async () => {
        const user = createAccount('a@exemplo.com');
        const token = issueAuthToken(user);

        await enrollProfile(token, { imagesBase64: [OWNER_FACE, OWNER_FACE], senhaAtual: WRONG_PASSWORD });

        expect((await faceStatus(token)).status).toBe(200);
      });
    });

    describe('C: senha atual correta', () => {
      test('cadastra o rosto e responde sem token', async () => {
        const user = createAccount('a@exemplo.com');

        const res = await enrollProfile(issueAuthToken(user), {
          imagesBase64: [OWNER_FACE, OWNER_FACE],
          senhaAtual: PASSWORD,
        });

        expect(res.status).toBe(200);
        expect(res.body).toEqual({ msg: 'Verificação facial cadastrada com sucesso.', enrolled: true });
        expect(facesOf(user)).toEqual([OWNER_FACE, OWNER_FACE]);
      });

      test('aceita o formato do mobile, com uma imagem', async () => {
        const user = createAccount('a@exemplo.com');

        const res = await enrollProfile(issueAuthToken(user), { imageBase64: OWNER_FACE, senhaAtual: PASSWORD });

        expect(res.status).toBe(200);
        expect(facesOf(user)).toEqual([OWNER_FACE]);
      });

      test('admin tambem cadastra, com a propria senha', async () => {
        const admin = createAccount('admin@exemplo.com', { tipo: 'admin' });

        const res = await enrollProfile(issueAuthToken(admin), {
          imagesBase64: [ADMIN_FACE, ADMIN_FACE],
          senhaAtual: PASSWORD,
        });

        expect(res.status).toBe(200);
        expect(facesOf(admin)).toEqual([ADMIN_FACE, ADMIN_FACE]);
      });

      test('o proximo login passa a exigir o rosto cadastrado', async () => {
        const user = createAccount('a@exemplo.com');
        await enrollProfile(issueAuthToken(user), { imagesBase64: [OWNER_FACE, OWNER_FACE], senhaAtual: PASSWORD });

        const logged = await login(user.email);

        expect(logged.body.requiresFaceVerification).toBe(true);
        expect(logged.body.token).toBeUndefined();
        expectAccessTokenOf(await verifyFace(logged.body.faceSessionToken, OWNER_FACE), user);
      });

      test('falha do servico facial continua sem criar perfil', async () => {
        const user = createAccount('a@exemplo.com');

        const res = await enrollProfile(issueAuthToken(user), {
          imagesBase64: ['sem-rosto', OWNER_FACE],
          senhaAtual: PASSWORD,
        });

        expect(res.status).toBe(400);
        expect(mockDb.faces).toHaveLength(0);
      });

      test('rosto ja vinculado a outra conta continua recusado', async () => {
        const dono = createAccount('dono@exemplo.com');
        seedFace(dono, OWNER_FACE);
        const user = createAccount('a@exemplo.com');

        const res = await enrollProfile(issueAuthToken(user), {
          imagesBase64: [OWNER_FACE, OWNER_FACE],
          senhaAtual: PASSWORD,
        });

        expect(res.status).toBe(409);
        expect(res.body.codigo).toBe('FACE_DUPLICATE');
        expect(facesOf(user)).toBeNull();
      });
    });

    describe('D: sem JWT principal', () => {
      test('senha correta sem JWT responde 401', async () => {
        createAccount('a@exemplo.com');

        const res = await enrollProfile(null, { imagesBase64: [OWNER_FACE, OWNER_FACE], senhaAtual: PASSWORD });

        expect(res.status).toBe(401);
        expect(mockDb.faces).toHaveLength(0);
      });

      test('sessao facial no lugar do JWT responde 401', async () => {
        const user = createAccount('a@exemplo.com', { faceEnrollmentOffered: false, faceEnrollmentSkipped: false });
        const offer = await login(user.email);

        const res = await enrollProfile(offer.body.faceSessionToken, {
          imagesBase64: [OWNER_FACE, OWNER_FACE],
          senhaAtual: PASSWORD,
        });

        expect(res.status).toBe(401);
        expect(mockDb.faces).toHaveLength(0);
      });
    });

    describe('E: a identidade vem somente do JWT', () => {
      test('JWT e senha de A, com userId de B no corpo, cadastram apenas em A', async () => {
        const contaA = createAccount('a@exemplo.com');
        const contaB = createAccount('b@exemplo.com');

        const res = await enrollProfile(issueAuthToken(contaA), {
          imagesBase64: [OWNER_FACE, OWNER_FACE],
          senhaAtual: PASSWORD,
          userId: String(contaB._id),
          id: String(contaB._id),
          email: contaB.email,
        });

        expect(res.status).toBe(200);
        expect(facesOf(contaA)).toEqual([OWNER_FACE, OWNER_FACE]);
        expect(facesOf(contaB)).toBeNull();
      });

      test('a senha conferida e a da conta do JWT, nao a da conta do corpo', async () => {
        const contaA = createAccount('a@exemplo.com', { senha: await argon2.hash('SenhaDeA@1234') });
        const contaB = createAccount('b@exemplo.com');

        const res = await enrollProfile(issueAuthToken(contaA), {
          imagesBase64: [OWNER_FACE, OWNER_FACE],
          senhaAtual: PASSWORD,
          userId: String(contaB._id),
        });

        expect(res.status).toBe(400);
        expect(res.body).toEqual({ erro: WRONG_MESSAGE });
        expect(mockDb.faces).toHaveLength(0);
      });

      test('conta do JWT que nao existe mais responde 404', async () => {
        const removida = createAccount('a@exemplo.com');
        const token = issueAuthToken(removida);
        mockDb.users = [];

        const res = await enrollProfile(token, { imagesBase64: [OWNER_FACE, OWNER_FACE], senhaAtual: PASSWORD });

        expect(res.status).toBe(404);
        expect(mockDb.faces).toHaveLength(0);
      });
    });

    describe('F: perfil ja existente', () => {
      const withFace = () => {
        const user = createAccount('c@exemplo.com', { faceEnrollmentSkipped: false });
        seedFace(user, OWNER_FACE);
        return { user, token: issueAuthToken(user) };
      };

      test('o dono atualiza com todas as fotos dele e a senha', async () => {
        const { user, token } = withFace();

        const res = await enrollProfile(token, { imagesBase64: [OWNER_FACE, OWNER_FACE], senhaAtual: PASSWORD });

        expect(res.status).toBe(200);
        expect(facesOf(user)).toEqual([OWNER_FACE, OWNER_FACE]);
      });

      test('o dono tambem atualiza pelo formato do mobile', async () => {
        const { user, token } = withFace();

        const res = await enrollProfile(token, { imageBase64: OWNER_FACE, senhaAtual: PASSWORD });

        expect(res.status).toBe(200);
        expect(facesOf(user)).toEqual([OWNER_FACE]);
      });

      test('atualizar sem senha responde 400 e mantem o perfil', async () => {
        const { user, token } = withFace();

        const res = await enrollProfile(token, { imagesBase64: [OWNER_FACE, OWNER_FACE] });

        expect(res.status).toBe(400);
        expect(facesOf(user)).toEqual([OWNER_FACE]);
      });

      test('atualizar com senha errada responde 400 e mantem o perfil', async () => {
        const { user, token } = withFace();

        const res = await enrollProfile(token, { imagesBase64: [OWNER_FACE, OWNER_FACE], senhaAtual: WRONG_PASSWORD });

        expect(res.status).toBe(400);
        expect(facesOf(user)).toEqual([OWNER_FACE]);
      });

      test('so fotos de outra pessoa responde 403 e mantem o perfil', async () => {
        const { user, token } = withFace();

        const res = await enrollProfile(token, { imagesBase64: [OTHER_FACE, OTHER_FACE], senhaAtual: PASSWORD });

        expect(res.status).toBe(403);
        expect(facesOf(user)).toEqual([OWNER_FACE]);
      });

      test.each([
        ['dono primeiro', [OWNER_FACE, OTHER_FACE]],
        ['outra pessoa primeiro', [OTHER_FACE, OWNER_FACE]],
      ])('captura mista, %s, responde 403 e mantem o perfil', async (_label, imagesBase64) => {
        const { user, token } = withFace();

        const res = await enrollProfile(token, { imagesBase64, senhaAtual: PASSWORD });

        expect(res.status).toBe(403);
        expect(facesOf(user)).toEqual([OWNER_FACE]);
      });

      test('depois da captura mista recusada, a outra pessoa nao entra', async () => {
        const { user, token } = withFace();
        await enrollProfile(token, { imagesBase64: [OWNER_FACE, OTHER_FACE], senhaAtual: PASSWORD });

        const logged = await login(user.email);
        const res = await verifyFace(logged.body.faceSessionToken, OTHER_FACE);

        expect(res.status).toBe(401);
        expect(res.body.token).toBeUndefined();
      });
    });

    describe('G: fluxo inicial e sigilo da senha', () => {
      test('a oferta inicial cadastra pelo /face/enroll sem pedir a senha de novo', async () => {
        const user = createAccount('a@exemplo.com', { faceEnrollmentOffered: false, faceEnrollmentSkipped: false });

        const offer = await login(user.email);
        expect(offer.body.requiresFaceEnrollmentOffer).toBe(true);
        expect(offer.body.token).toBeUndefined();

        const enrolled = await enrollWithSession(offer.body.faceSessionToken, [OWNER_FACE, OWNER_FACE]);
        expectAccessTokenOf(enrolled, user);
        expect(facesOf(user)).toEqual([OWNER_FACE, OWNER_FACE]);

        const next = await login(user.email);
        expect(next.body.requiresFaceVerification).toBe(true);
        expect(next.body.token).toBeUndefined();
      });

      test('pular a oferta continua entregando o JWT', async () => {
        const user = createAccount('a@exemplo.com', { faceEnrollmentOffered: false, faceEnrollmentSkipped: false });
        const offer = await login(user.email);

        expectAccessTokenOf(await skipOffer(offer.body.faceSessionToken), user);
        expect(user.faceEnrollmentSkipped).toBe(true);
        expectAccessTokenOf(await login(user.email), user);
      });

      test.each([
        ['correta', PASSWORD],
        ['errada', WRONG_PASSWORD],
      ])('senha %s nao aparece na resposta nem nos logs', async (_label, senhaAtual) => {
        const logs = ['log', 'info', 'warn', 'error'].map((level) => jest.spyOn(console, level).mockImplementation(() => {}));
        const user = createAccount('a@exemplo.com');

        const res = await enrollProfile(issueAuthToken(user), {
          imagesBase64: [OWNER_FACE, OWNER_FACE],
          senhaAtual,
        });

        const logged = JSON.stringify(logs.flatMap((spy) => spy.mock.calls));
        logs.forEach((spy) => spy.mockRestore());
        expect(JSON.stringify(res.body)).not.toContain(senhaAtual);
        expect(JSON.stringify(res.body)).not.toContain(passwordHash);
        expect(logged).not.toContain(senhaAtual);
        expect(logged).not.toContain(passwordHash);
      });
    });
  });

  describe('D29: perfil facial vale para qualquer tipo de conta', () => {
    describe('admin sem perfil facial', () => {
      test('senha correta entrega o JWT, sem oferta de cadastro', async () => {
        const admin = createAccount('admin@exemplo.com', {
          tipo: 'admin',
          faceEnrollmentOffered: false,
          faceEnrollmentSkipped: false,
        });

        const res = await login(admin.email);

        expectAccessTokenOf(res, admin);
        expect(res.body.faceSessionToken).toBeUndefined();
        expect(res.body.requiresFaceEnrollmentOffer).toBeUndefined();
        expect(admin.save).not.toHaveBeenCalled();
      });

      test('perfil inativo nao exige rosto', async () => {
        const admin = createAccount('admin@exemplo.com', { tipo: 'admin' });
        seedFace(admin, ADMIN_FACE, false);

        const res = await login(admin.email);

        expectAccessTokenOf(res, admin);
        expect(res.body.faceSessionToken).toBeUndefined();
      });
    });

    describe('admin com perfil facial ativo', () => {
      const adminWithFace = () => {
        const admin = createAccount('admin@exemplo.com', { tipo: 'admin', faceEnrollmentSkipped: false });
        seedFace(admin, ADMIN_FACE);
        return admin;
      };

      test('senha correta entrega so a sessao facial, nunca o JWT', async () => {
        const admin = adminWithFace();

        const res = await login(admin.email);

        expect(res.status).toBe(200);
        expect(res.body.requiresFaceVerification).toBe(true);
        expect(res.body.faceSessionToken).toEqual(expect.any(String));
        expect(res.body.token).toBeUndefined();
        expect(res.body.user.tipo).toBe('admin');
      });

      test('a sessao facial nao abre rota de admin', async () => {
        const admin = adminWithFace();
        const { body } = await login(admin.email);

        expect((await adminRoute(body.faceSessionToken)).status).toBe(401);
      });

      test('senha errada continua 401, sem sessao facial', async () => {
        const admin = adminWithFace();

        const res = await login(admin.email, WRONG_PASSWORD);

        expect(res.status).toBe(401);
        expect(res.body.faceSessionToken).toBeUndefined();
        expect(res.body.token).toBeUndefined();
      });

      test('conta nao verificada continua barrada antes do rosto', async () => {
        const admin = adminWithFace();
        admin.verificado = false;

        const res = await login(admin.email);

        expect(res.status).toBe(403);
        expect(res.body.faceSessionToken).toBeUndefined();
      });

      test('rosto errado responde 401, sem JWT', async () => {
        const admin = adminWithFace();
        const { body } = await login(admin.email);

        const res = await verifyFace(body.faceSessionToken, OTHER_FACE);

        expect(res.status).toBe(401);
        expect(res.body.token).toBeUndefined();
      });

      test('rosto correto entrega JWT de admin, que abre rota de admin', async () => {
        const admin = adminWithFace();
        const { body } = await login(admin.email);

        const res = await verifyFace(body.faceSessionToken, ADMIN_FACE);

        expectAccessTokenOf(res, admin);
        expect(res.body.user.tipo).toBe('admin');
        expect((await adminRoute(res.body.token)).status).toBe(200);
      });
    });

    describe('usuario comum continua igual', () => {
      test('com rosto: senha, sessao facial, rosto correto e JWT', async () => {
        const user = createAccount('c@exemplo.com', { faceEnrollmentSkipped: false });
        seedFace(user, OWNER_FACE);

        const logged = await login(user.email);
        expect(logged.body.requiresFaceVerification).toBe(true);
        expect(logged.body.token).toBeUndefined();

        const wrong = await verifyFace(logged.body.faceSessionToken, OTHER_FACE);
        expect(wrong.status).toBe(401);

        const res = await verifyFace(logged.body.faceSessionToken, OWNER_FACE);
        expectAccessTokenOf(res, user);
        expect((await adminRoute(res.body.token)).status).toBe(403);
      });

      test('sem rosto e sem oferta anterior: oferta uma vez, sem JWT', async () => {
        const user = createAccount('a@exemplo.com', { faceEnrollmentOffered: false, faceEnrollmentSkipped: false });

        const offer = await login(user.email);

        expect(offer.body.requiresFaceEnrollmentOffer).toBe(true);
        expect(offer.body.faceSessionToken).toEqual(expect.any(String));
        expect(offer.body.token).toBeUndefined();
        expect(user.faceEnrollmentOffered).toBe(true);
        expect(user.save).toHaveBeenCalledTimes(1);
      });

      test.each([
        ['oferta ja feita, sem resposta', { faceEnrollmentOffered: true, faceEnrollmentSkipped: false }],
        ['oferta recusada', { faceEnrollmentOffered: true, faceEnrollmentSkipped: true }],
      ])('sem rosto, %s: JWT direto', async (_label, flags) => {
        const user = createAccount('a@exemplo.com', flags);

        const res = await login(user.email);

        expectAccessTokenOf(res, user);
        expect(res.body.faceSessionToken).toBeUndefined();
      });
    });
  });
});
