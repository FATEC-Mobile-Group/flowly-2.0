const request = require('supertest');
const argon2 = require('argon2');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');

const mockDb = { users: [], faces: [] };

// Cada rosto e um vetor ortogonal: so o mesmo rosto corresponde a uma referencia guardada.
const mockFaceVectors = {
  'rosto-dono': [1, 0, 0, 0],
  'rosto-outro': [0, 1, 0, 0],
  'rosto-admin': [0, 0, 1, 0],
  'rosto-b': [0, 0, 0, 1],
};
const mockSameVector = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const mockCompare = (references, image) =>
  mockFaceVectors[image]
    ? {
        face_detected: true,
        match: references.some((reference) => mockSameVector(reference, mockFaceVectors[image])),
        distance: 0.1,
      }
    : { face_detected: false, erro: 'no face' };

jest.mock('@google-cloud/storage', () => ({
  Storage: jest.fn().mockImplementation(() => ({
    bucket: jest.fn().mockReturnValue({ file: jest.fn() }),
  })),
}));

jest.mock('../utils/sendEmail', () => jest.fn().mockResolvedValue(true));

jest.mock('../services/faceService', () => ({
  extractEmbedding: jest.fn(async (image) =>
    mockFaceVectors[image]
      ? { face_detected: true, embedding: mockFaceVectors[image], model: 'VGG-Face' }
      : { face_detected: false, erro: 'no face' }
  ),
  verifyFace: jest.fn(async (reference, image) => mockCompare([reference], image)),
  verifyFaceMulti: jest.fn(async (references, image) => mockCompare(references, image)),
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
    return face;
  }),
}));

// Captura o Map interno sem exportar nada da producao.
const RealMap = global.Map;
let buckets;
global.Map = class extends RealMap {
  constructor(...args) {
    super(...args);
    buckets = this;
  }
};
require('../middlewares/rateLimiters');
global.Map = RealMap;

const config = require('../config/config');
const faceService = require('../services/faceService');
const User = require('../models/User');
const FaceProfile = require('../models/FaceProfile');
const { issueAuthToken, issueFaceSessionToken, verifyAuthToken } = require('../utils/faceAuth');
const app = require('../app');

const MAX_ATTEMPTS = 5;
const WINDOW_MS = 15 * 60 * 1000;
const PASSWORD = 'SenhaOriginal@1';
const OWNER_FACE = 'rosto-dono';
const OTHER_FACE = 'rosto-outro';
const ADMIN_FACE = 'rosto-admin';
const NO_FACE = 'sem-rosto';
const LIMIT_RESPONSE = { erro: 'Muitas tentativas. Aguarde alguns minutos e tente novamente.' };
const SESSION_REJECTED = { erro: 'Sessão de verificação facial inválida ou expirada. Faça login novamente.' };
const WRONG_FACE_MESSAGE = 'Rosto não reconhecido';

const verify = (faceSessionToken, imageBase64 = OTHER_FACE, url = '/api/face/verify') =>
  request(app).post(url).send({ faceSessionToken, imageBase64 });
const login = (email, senha = PASSWORD) => request(app).post('/api/auth/login').send({ email, senha });
const repeat = async (times, action) => {
  const results = [];
  for (let i = 0; i < times; i += 1) {
    results.push(await action(i));
  }
  return results;
};

describe('D52: tentativas em POST /api/face/verify', () => {
  const originalEmbeddingKey = config.face.embeddingKey;
  let passwordHash;

  beforeAll(async () => {
    passwordHash = await argon2.hash(PASSWORD, { memoryCost: 1024, timeCost: 2, parallelism: 1 });
    config.face.embeddingKey = Buffer.alloc(32, 1).toString('base64');
  });

  afterAll(() => {
    config.face.embeddingKey = originalEmbeddingKey;
  });

  beforeEach(() => {
    jest.clearAllMocks();
    buckets.clear();
    mockDb.users = [];
    mockDb.faces = [];
  });

  afterEach(() => {
    jest.restoreAllMocks();
    app.set('trust proxy', false);
  });

  const createAccount = (email = 'c@exemplo.com', data = {}) => {
    const user = {
      _id: new mongoose.Types.ObjectId(),
      nome: `Nome ${email}`,
      email,
      senha: passwordHash,
      tipo: 'user',
      verificado: true,
      fotoPerfil: '',
      faceEnrollmentOffered: true,
      faceEnrollmentSkipped: false,
      save: jest.fn().mockResolvedValue(true),
      ...data,
    };
    user.toObject = () => ({ ...user });
    mockDb.users.push(user);
    return user;
  };

  const seedFace = (user, ...faces) => {
    const profile = {
      userId: user._id,
      enrolled: true,
      embeddings: (faces.length ? faces : [OWNER_FACE]).map((face) => mockFaceVectors[face]),
    };
    mockDb.faces.push(profile);
    return profile;
  };

  const accountWithFace = (email, data, ...faces) => {
    const user = createAccount(email, data);
    seedFace(user, ...faces);
    return user;
  };

  const startSession = async (user) => {
    const res = await login(user.email);
    expect(res.body.requiresFaceVerification).toBe(true);
    expect(res.body.token).toBeUndefined();
    return res.body.faceSessionToken;
  };

  const expectLimited = (res) => {
    expect(res.status).toBe(429);
    expect(res.body).toEqual(LIMIT_RESPONSE);
  };

  const expectRejected = (res) => {
    expect(res.status).toBe(401);
    expect(res.body).toEqual(SESSION_REJECTED);
  };

  const expectAccessTokenOf = (res, user) => {
    expect(res.status).toBe(200);
    const decoded = verifyAuthToken(res.body.token);
    expect(String(decoded.id)).toBe(String(user._id));
    expect(decoded.tipo).toBe(user.tipo);
  };

  const comparisons = () =>
    faceService.verifyFace.mock.calls.length + faceService.verifyFaceMulti.mock.calls.length;

  describe('limite de tentativas', () => {
    test('as 5 primeiras com rosto errado chegam ao comparador e a 6a responde 429', async () => {
      const token = await startSession(accountWithFace());

      const results = await repeat(MAX_ATTEMPTS, () => verify(token));

      results.forEach((res) => {
        expect(res.status).toBe(401);
        expect(res.body.erro).toContain(WRONG_FACE_MESSAGE);
        expect(res.body.token).toBeUndefined();
      });
      expect(comparisons()).toBe(MAX_ATTEMPTS);

      expectLimited(await verify(token));
      expect(comparisons()).toBe(MAX_ATTEMPTS);
    });

    test('depois do limite nem o rosto certo entra, e nada caro e executado', async () => {
      const user = accountWithFace();
      const profile = mockDb.faces[0];
      const before = JSON.stringify(profile);
      const token = await startSession(user);
      await repeat(MAX_ATTEMPTS, () => verify(token));
      jest.clearAllMocks();

      const res = await verify(token, OWNER_FACE);

      expectLimited(res);
      expect(res.body.token).toBeUndefined();
      expect(faceService.verifyFace).not.toHaveBeenCalled();
      expect(faceService.verifyFaceMulti).not.toHaveBeenCalled();
      expect(faceService.extractEmbedding).not.toHaveBeenCalled();
      expect(User.findById).not.toHaveBeenCalled();
      expect(FaceProfile.findOne).not.toHaveBeenCalled();
      expect(FaceProfile.findOneAndUpdate).not.toHaveBeenCalled();
      expect(JSON.stringify(profile)).toBe(before);
    });

    test('perfil com varias referencias segue o mesmo limite', async () => {
      const token = await startSession(accountWithFace('c@exemplo.com', {}, OWNER_FACE, ADMIN_FACE));

      await repeat(MAX_ATTEMPTS, () => verify(token));

      expect(faceService.verifyFaceMulti).toHaveBeenCalledTimes(MAX_ATTEMPTS);
      expectLimited(await verify(token, OWNER_FACE));
      expect(faceService.verifyFaceMulti).toHaveBeenCalledTimes(MAX_ATTEMPTS);
    });

    test('rajada simultanea: so o limite chega ao comparador', async () => {
      const token = await startSession(accountWithFace());

      const results = await Promise.all(
        Array.from({ length: MAX_ATTEMPTS * 4 }, () => verify(token).then((res) => res))
      );

      expect(results.filter((res) => res.status === 401)).toHaveLength(MAX_ATTEMPTS);
      expect(results.filter((res) => res.status === 429)).toHaveLength(MAX_ATTEMPTS * 3);
      expect(comparisons()).toBe(MAX_ATTEMPTS);
    });

    test('a resposta 429 nao traz distancia, limiar nem outro detalhe', async () => {
      const token = await startSession(accountWithFace());
      await repeat(MAX_ATTEMPTS, () => verify(token));

      const res = await verify(token);

      expect(Object.keys(res.body)).toEqual(['erro']);
    });
  });

  describe('o token continua reutilizavel antes do limite', () => {
    test('errado, errado, certo: a terceira tentativa entrega o JWT', async () => {
      const user = accountWithFace();
      const token = await startSession(user);

      expect((await verify(token)).status).toBe(401);
      expect((await verify(token)).status).toBe(401);

      expectAccessTokenOf(await verify(token, OWNER_FACE), user);
    });

    test('o rosto certo na ultima tentativa permitida entra', async () => {
      const user = accountWithFace();
      const token = await startSession(user);
      await repeat(MAX_ATTEMPTS - 1, () => verify(token));

      expectAccessTokenOf(await verify(token, OWNER_FACE), user);
    });

    test('entrar nao torna o token de uso unico', async () => {
      const user = accountWithFace();
      const token = await startSession(user);

      expectAccessTokenOf(await verify(token, OWNER_FACE), user);
      expectAccessTokenOf(await verify(token, OWNER_FACE), user);
    });
  });

  describe('token invalido nunca vira 429', () => {
    const accessToken = (user) => issueAuthToken(user);
    const INVALID_TOKENS = [
      ['malformado', () => 'token-invalido'],
      ['que nao e texto', () => 12345],
      ['expirado', (user) =>
        jwt.sign({ id: user._id, purpose: 'face_verify', tokenType: 'face-session' }, config.jwt.faceSecret, {
          issuer: config.jwt.issuer,
          audience: config.jwt.faceAudience,
          expiresIn: -10,
        })],
      ['assinado com outro segredo', (user) =>
        jwt.sign({ id: user._id, purpose: 'face_verify', tokenType: 'face-session' }, 'outro-segredo', {
          issuer: config.jwt.issuer,
          audience: config.jwt.faceAudience,
        })],
      ['com finalidade face_enroll', (user) => issueFaceSessionToken(user._id, 'face_enroll')],
      ['JWT principal', accessToken],
    ];

    test.each(INVALID_TOKENS)('%s responde 401 sempre, sem contar tentativa', async (_label, build) => {
      const user = accountWithFace();
      const token = build(user);

      const results = await repeat(MAX_ATTEMPTS * 2 + 1, () => verify(token, OWNER_FACE));

      results.forEach(expectRejected);
      expect(comparisons()).toBe(0);
      expect(User.findById).not.toHaveBeenCalled();
      expect(buckets.size).toBe(0);
    });

    test('sessao no limite nao muda a resposta de um token invalido', async () => {
      const user = accountWithFace();
      const token = await startSession(user);
      await repeat(MAX_ATTEMPTS + 1, () => verify(token));

      expectRejected(await verify('token-invalido'));
      expectRejected(await verify(issueFaceSessionToken(user._id, 'face_enroll')));
    });
  });

  describe('corpo incompleto continua 400 e nao conta', () => {
    test.each([
      ['sem token', { imageBase64: OWNER_FACE }],
      ['sem imagem, com token invalido', { faceSessionToken: 'qualquer' }],
      ['vazio', {}],
    ])('%s', async (_label, body) => {
      const results = await repeat(MAX_ATTEMPTS + 2, () => request(app).post('/api/face/verify').send(body));

      results.forEach((res) => {
        expect(res.status).toBe(400);
        expect(res.body).toEqual({ erro: 'faceSessionToken e imageBase64 são obrigatórios.' });
      });
      expect(buckets.size).toBe(0);
    });

    test('sem imagem, com token valido: nao gasta tentativa da sessao', async () => {
      const user = accountWithFace();
      const token = await startSession(user);
      buckets.clear();

      const results = await repeat(MAX_ATTEMPTS + 2, () =>
        request(app).post('/api/face/verify').send({ faceSessionToken: token })
      );

      results.forEach((res) => expect(res.status).toBe(400));
      expect(buckets.size).toBe(0);
      expectAccessTokenOf(await verify(token, OWNER_FACE), user);
    });
  });

  describe('outra sessao tem contador proprio', () => {
    // Dois logins no mesmo segundo geram o mesmo token: o relogio avanca para abrir outra sessao.
    const nextSecond = () => {
      const realNow = Date.now;
      jest.spyOn(Date, 'now').mockImplementation(() => realNow.call(Date) + 2000);
    };

    test('a sessao A no limite nao bloqueia a sessao B da mesma conta', async () => {
      const user = accountWithFace();
      const sessionA = await startSession(user);
      await repeat(MAX_ATTEMPTS, () => verify(sessionA));
      expectLimited(await verify(sessionA));

      nextSecond();
      const sessionB = await startSession(user);

      expect(sessionB).not.toBe(sessionA);
      expectAccessTokenOf(await verify(sessionB, OWNER_FACE), user);
    });

    test('um novo login nao devolve tentativas a sessao antiga', async () => {
      const user = accountWithFace();
      const sessionA = await startSession(user);
      await repeat(MAX_ATTEMPTS, () => verify(sessionA));

      nextSecond();
      await startSession(user);

      expectLimited(await verify(sessionA, OWNER_FACE));
    });

    test('a sessao B tambem para no proprio limite', async () => {
      const user = accountWithFace();
      await startSession(user);

      nextSecond();
      const sessionB = await startSession(user);
      await repeat(MAX_ATTEMPTS, () => verify(sessionB));

      expectLimited(await verify(sessionB, OWNER_FACE));
    });
  });

  describe('outro usuario', () => {
    test('a conta A no limite nao bloqueia a conta B', async () => {
      const a = accountWithFace('a@exemplo.com');
      const b = accountWithFace('b@exemplo.com', {}, 'rosto-b');
      const sessionA = await startSession(a);
      const sessionB = await startSession(b);
      await repeat(MAX_ATTEMPTS, () => verify(sessionA));
      expectLimited(await verify(sessionA));

      expectAccessTokenOf(await verify(sessionB, 'rosto-b'), b);
    });
  });

  describe('a chave depende so da sessao', () => {
    test('trocar de IP nao abre tentativas', async () => {
      const token = await startSession(accountWithFace());
      app.set('trust proxy', true);

      await repeat(MAX_ATTEMPTS, (i) => verify(token).set('X-Forwarded-For', `198.51.100.${i + 1}`));

      expectLimited(await verify(token, OWNER_FACE).set('X-Forwarded-For', '203.0.113.50'));
    });

    test('trocar a imagem nao abre tentativas', async () => {
      const token = await startSession(accountWithFace());
      const images = [OTHER_FACE, ADMIN_FACE, 'rosto-b', NO_FACE, 'outra-imagem'];

      await repeat(MAX_ATTEMPTS, (i) => verify(token, images[i]));

      expectLimited(await verify(token, OWNER_FACE));
    });

    test('trocar a grafia da URL nao abre tentativas', async () => {
      const token = await startSession(accountWithFace());
      const urls = ['/api/face/verify', '/api/face/VERIFY', '/api/FACE/verify', '/api/face/verify/', '/API/FACE/VERIFY/'];

      await repeat(MAX_ATTEMPTS, (i) => verify(token, OTHER_FACE, urls[i]));

      expectLimited(await verify(token, OWNER_FACE, '/Api/Face/Verify'));
    });

    test('a chave guarda so um digest de tamanho fixo, nunca o token', async () => {
      const token = await startSession(accountWithFace());
      buckets.clear();

      await verify(token);

      const [key] = buckets.keys();
      expect(key).toMatch(/^face-verify:[a-f0-9]{64}$/);
      expect(JSON.stringify([...buckets])).not.toContain(token);
      expect(JSON.stringify([...buckets])).not.toContain(token.split('.')[2]);
    });

    test('token nao aparece na resposta, nos cabecalhos nem nos logs', async () => {
      const logs = ['log', 'info', 'warn', 'error'].map((level) => jest.spyOn(console, level).mockImplementation(() => {}));
      const token = await startSession(accountWithFace());

      const results = await repeat(MAX_ATTEMPTS + 1, () => verify(token));

      const logged = JSON.stringify(logs.flatMap((spy) => spy.mock.calls));
      expect(logged).not.toContain(token);
      results.forEach((res) => {
        expect(JSON.stringify(res.body)).not.toContain(token);
        expect(JSON.stringify(res.headers)).not.toContain(token);
      });
    });
  });

  describe('admin com rosto', () => {
    const adminWithFace = () => accountWithFace('admin@exemplo.com', { tipo: 'admin' }, ADMIN_FACE);

    test('tentativas erradas contam e o rosto certo antes do limite entrega JWT de admin', async () => {
      const admin = adminWithFace();
      const token = await startSession(admin);
      expect((await verify(token)).status).toBe(401);
      expect((await verify(token)).status).toBe(401);

      const res = await verify(token, ADMIN_FACE);

      expectAccessTokenOf(res, admin);
      expect((await request(app).get('/api/users').set('Authorization', `Bearer ${res.body.token}`)).status).toBe(200);
    });

    test('no limite, admin nao recebe JWT nem com o rosto certo', async () => {
      const admin = adminWithFace();
      const token = await startSession(admin);
      await repeat(MAX_ATTEMPTS, () => verify(token));

      const res = await verify(token, ADMIN_FACE);

      expectLimited(res);
      expect(res.body.token).toBeUndefined();
    });
  });

  describe('o que nao passa por este limite', () => {
    test('conta sem perfil, com token de verify: continua 404 e sem comparar', async () => {
      const user = createAccount();

      const res = await verify(issueFaceSessionToken(user._id, 'face_verify'));

      expect(res.status).toBe(404);
      expect(res.body).toEqual({ erro: 'Perfil facial não encontrado.' });
      expect(comparisons()).toBe(0);
    });

    test('a oferta de cadastro nao e limitada por esta regra', async () => {
      const user = createAccount('oferta@exemplo.com', { faceEnrollmentOffered: false });
      const offer = await login(user.email);
      expect(offer.body.requiresFaceEnrollmentOffer).toBe(true);

      const failures = await repeat(MAX_ATTEMPTS + 2, () =>
        request(app).post('/api/face/enroll').send({ faceSessionToken: offer.body.faceSessionToken, imagesBase64: [NO_FACE] })
      );

      failures.forEach((res) => expect(res.status).toBe(400));
      expect([...buckets.keys()].some((key) => key.startsWith('face-verify'))).toBe(false);

      const enrolled = await request(app)
        .post('/api/face/enroll')
        .send({ faceSessionToken: offer.body.faceSessionToken, imagesBase64: [OWNER_FACE] });
      expectAccessTokenOf(enrolled, user);
    });

    test('pular a oferta continua funcionando', async () => {
      const user = createAccount('oferta@exemplo.com', { faceEnrollmentOffered: false });
      const offer = await login(user.email);

      const res = await request(app).post('/api/face/skip-enrollment').send({ faceSessionToken: offer.body.faceSessionToken });

      expectAccessTokenOf(res, user);
    });

    test('conta com rosto no limite continua podendo pedir nova sessao', async () => {
      const user = accountWithFace();
      const token = await startSession(user);
      await repeat(MAX_ATTEMPTS + 1, () => verify(token));

      const res = await login(user.email);

      expect(res.status).toBe(200);
      expect(res.body.requiresFaceVerification).toBe(true);
    });
  });

  describe('toda tentativa com sessao valida conta, nao so o rosto errado', () => {
    test('foto sem rosto gasta tentativa', async () => {
      const token = await startSession(accountWithFace());

      const results = await repeat(MAX_ATTEMPTS, () => verify(token, NO_FACE));

      results.forEach((res) => expect(res.status).toBe(400));
      expectLimited(await verify(token, OWNER_FACE));
    });

    test('servico facial fora do ar gasta tentativa', async () => {
      const token = await startSession(accountWithFace());
      faceService.verifyFace.mockRejectedValue(
        Object.assign(new Error('Serviço facial indisponível.'), { statusCode: 503 })
      );

      const results = await repeat(MAX_ATTEMPTS, () => verify(token));

      faceService.verifyFace.mockImplementation(async (reference, image) => mockCompare([reference], image));
      results.forEach((res) => expect(res.status).toBe(503));
      expectLimited(await verify(token, OWNER_FACE));
    });
  });

  describe('janela', () => {
    test('segue bloqueado enquanto o token vale e, depois, o token expirado responde 401', async () => {
      const start = Date.now();
      const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(start);
      const token = await startSession(accountWithFace());
      await repeat(MAX_ATTEMPTS, () => verify(token));

      nowSpy.mockReturnValue(start + 4 * 60 * 1000);
      expectLimited(await verify(token, OWNER_FACE));

      nowSpy.mockReturnValue(start + WINDOW_MS + 1);
      expectRejected(await verify(token, OWNER_FACE));
    });

    test('o bucket expirado sai do Map na requisicao seguinte (D50)', async () => {
      const start = Date.now();
      const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(start);
      const token = await startSession(accountWithFace());
      await verify(token);
      expect([...buckets.keys()].filter((key) => key.startsWith('face-verify'))).toHaveLength(1);

      nowSpy.mockReturnValue(start + WINDOW_MS + 1);
      const b = accountWithFace('b@exemplo.com', {}, 'rosto-b');
      await verify(await startSession(b));

      expect([...buckets.keys()].filter((key) => key.startsWith('face-verify'))).toHaveLength(1);
    });
  });
});
