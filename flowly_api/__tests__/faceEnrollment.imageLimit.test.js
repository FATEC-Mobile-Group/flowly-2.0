const request = require('supertest');
const argon2 = require('argon2');
const mongoose = require('mongoose');

const mockDb = { users: [], faces: [] };
const mockFaceVectors = { 'rosto-dono': [1, 0, 0, 0], 'rosto-outro': [0, 1, 0, 0] };
const mockSame = (a, b) => String(a) === String(b);

jest.mock('@google-cloud/storage', () => ({
  Storage: jest.fn().mockImplementation(() => ({
    bucket: jest.fn().mockReturnValue({ file: jest.fn() }),
  })),
}));

jest.mock('../utils/sendEmail', () => jest.fn().mockResolvedValue(true));

// Os limites de tentativas tem testes proprios (D33, D52): aqui so a quantidade de imagens importa.
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
  verifyFace: jest.fn(),
  verifyFaceMulti: jest.fn(),
}));

jest.mock('../models/User', () => {
  const mockQuery = (value) => {
    const query = Promise.resolve(value);
    query.select = () => query;
    return query;
  };
  return {
    findOne: jest.fn(async ({ email }) => mockDb.users.find((user) => user.email === email) || null),
    findById: jest.fn((id) => mockQuery(mockDb.users.find((user) => mockSame(user._id, id)) || null)),
    find: jest.fn(() => mockQuery(mockDb.users)),
    // Update condicional que conclui a oferta facial (D48).
    findOneAndUpdate: jest.fn(async ({ _id }, update) => {
      const user = mockDb.users.find((item) => mockSame(item._id, _id));
      return user && !user.faceEnrollmentOfferConcluded ? Object.assign(user, update.$set) : null;
    }),
  };
});

jest.mock('../models/FaceProfile', () => ({
  findOne: jest.fn(async ({ userId, enrolled }) =>
    mockDb.faces.find((face) => mockSame(face.userId, userId) && face.enrolled === enrolled) || null
  ),
  find: jest.fn((filter) => ({
    select: async () => mockDb.faces.filter((face) => face.enrolled && !mockSame(face.userId, filter.userId.$ne)),
  })),
  // Upsert com indice unico em userId: perfil ativo com filtro { enrolled: { $ne: true } } da E11000.
  findOneAndUpdate: jest.fn(async (filter, update) => {
    let face = mockDb.faces.find((item) => mockSame(item.userId, filter.userId));
    if (face && filter.enrolled && filter.enrolled.$ne === true && face.enrolled === true) {
      throw Object.assign(new Error('E11000 duplicate key'), { code: 11000 });
    }
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
const User = require('../models/User');
const FaceProfile = require('../models/FaceProfile');
const { issueAuthToken, issueFaceSessionToken } = require('../utils/faceAuth');
const { getStoredEmbeddings } = require('../utils/faceEmbeddings');
const app = require('../app');

const MAX = 2;
const PASSWORD = 'SenhaOriginal@1';
const OWNER = 'rosto-dono';
const OTHER = 'rosto-outro';
const TOO_MANY = { erro: 'Quantidade de imagens excede o limite permitido.' };
const SESSION_REJECTED = { erro: 'Sessão de verificação facial inválida ou expirada. Faça login novamente.' };
const images = (count, face = OWNER) => Array.from({ length: count }, () => face);

describe('D61: limite de imagens no cadastro facial', () => {
  const originalEmbeddingKey = config.face.embeddingKey;
  let passwordHash;
  let account;
  let verifySpy;

  beforeAll(async () => {
    passwordHash = await argon2.hash(PASSWORD, { memoryCost: 1024, timeCost: 2, parallelism: 1 });
    config.face.embeddingKey = Buffer.alloc(32, 1).toString('base64');
  });

  afterAll(() => {
    config.face.embeddingKey = originalEmbeddingKey;
  });

  beforeEach(() => {
    jest.clearAllMocks();
    verifySpy = jest.spyOn(argon2, 'verify');
    jest.spyOn(console, 'error').mockImplementation(() => {});
    account = {
      _id: new mongoose.Types.ObjectId(),
      nome: 'Conta',
      email: 'conta@exemplo.com',
      senha: passwordHash,
      tipo: 'user',
      verificado: true,
      fotoPerfil: '',
      faceEnrollmentOffered: true,
      faceEnrollmentSkipped: false,
    };
    mockDb.users = [account];
    mockDb.faces = [];
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  const offer = () => issueFaceSessionToken(account._id, 'face_enroll');
  const enroll = (body) => request(app).post('/api/face/enroll').send(body);
  const enrollProfile = (body, token = issueAuthToken(account)) => {
    const req = request(app).post('/api/face/enroll-profile');
    return (token ? req.set('Authorization', `Bearer ${token}`) : req).send(body);
  };
  const calls = () => faceService.extractEmbedding.mock.calls.length;
  const facesOf = () => {
    const profile = mockDb.faces.find((face) => mockSame(face.userId, account._id));
    if (!profile) return null;
    return getStoredEmbeddings(profile).map((embedding) =>
      Object.keys(mockFaceVectors).find((name) => JSON.stringify(mockFaceVectors[name]) === JSON.stringify(Array.from(embedding)))
    );
  };
  const seedProfile = (face = OWNER) => {
    mockDb.faces.push({ userId: account._id, enrolled: true, embeddings: [mockFaceVectors[face]] });
    account.faceEnrollmentOfferConcluded = true;
  };

  describe('POST /api/face/enroll', () => {
    test('A: uma imagem em imageBase64 continua funcionando', async () => {
      const res = await enroll({ faceSessionToken: offer(), imageBase64: OWNER });

      expect(res.status).toBe(200);
      expect(res.body.token).toEqual(expect.any(String));
      expect(calls()).toBe(1);
    });

    test('A: uma imagem em imagesBase64 continua funcionando', async () => {
      const res = await enroll({ faceSessionToken: offer(), imagesBase64: images(1) });

      expect(res.status).toBe(200);
      expect(calls()).toBe(1);
    });

    test('B: o maximo exato funciona', async () => {
      const res = await enroll({ faceSessionToken: offer(), imagesBase64: images(MAX) });

      expect(res.status).toBe(200);
      expect(calls()).toBe(MAX);
      expect(facesOf()).toEqual(images(MAX));
    });

    test.each([
      ['maximo + 1', MAX + 1],
      ['200 imagens', 200],
    ])('C/D: %s responde 400 sem chamar o servico nem gastar a oferta', async (_label, count) => {
      const res = await enroll({ faceSessionToken: offer(), imagesBase64: images(count) });

      expect(res.status).toBe(400);
      expect(res.body).toEqual(TOO_MANY);
      expect(calls()).toBe(0);
      expect(FaceProfile.findOneAndUpdate).not.toHaveBeenCalled();
      expect(User.findOneAndUpdate).not.toHaveBeenCalled();
      expect(account.faceEnrollmentOfferConcluded).toBeUndefined();
      expect(facesOf()).toBeNull();
    });

    test('E: depois do excesso, a mesma oferta conclui com a quantidade certa', async () => {
      const token = offer();
      expect((await enroll({ faceSessionToken: token, imagesBase64: images(MAX + 1) })).status).toBe(400);

      const res = await enroll({ faceSessionToken: token, imagesBase64: images(MAX) });

      expect(res.status).toBe(200);
      expect(res.body.token).toEqual(expect.any(String));
      expect(calls()).toBe(MAX);
    });

    test('excesso com token invalido tambem nao chega ao servico', async () => {
      const res = await enroll({ faceSessionToken: 'token-invalido', imagesBase64: images(200) });

      expect(res.status).toBe(400);
      expect(calls()).toBe(0);
    });

    test('F: perfil existente continua sem ser sobrescrito, com ou sem excesso', async () => {
      seedProfile(OWNER);

      const valid = await enroll({ faceSessionToken: offer(), imagesBase64: images(MAX, OTHER) });
      const excess = await enroll({ faceSessionToken: offer(), imagesBase64: images(MAX + 1, OTHER) });

      expect(valid.status).toBe(401);
      expect(valid.body).toEqual(SESSION_REJECTED);
      expect(excess.status).toBe(400);
      expect(calls()).toBe(0);
      expect(facesOf()).toEqual([OWNER]);
    });

    test.each([
      ['lista vazia', { imagesBase64: [] }],
      ['objeto na lista', { imagesBase64: [{}] }],
      ['numero na lista', { imagesBase64: [123] }],
      ['nulo na lista', { imagesBase64: [null] }],
      ['imageBase64 objeto', { imageBase64: { a: 1 } }],
    ])('D34: %s continua 400 sem chamar o servico', async (_label, body) => {
      const res = await enroll({ faceSessionToken: offer(), ...body });

      expect(res.status).toBe(400);
      expect(res.body.erro).toContain('são obrigatórios');
      expect(calls()).toBe(0);
    });

    test('duas chamadas validas simultaneas: so uma conclui a oferta (D48)', async () => {
      const token = offer();

      const results = await Promise.all([
        enroll({ faceSessionToken: token, imagesBase64: images(MAX) }).then((res) => res),
        enroll({ faceSessionToken: token, imagesBase64: images(MAX) }).then((res) => res),
      ]);

      expect(results.filter((res) => res.status === 200)).toHaveLength(1);
      expect(results.filter((res) => res.status === 401)).toHaveLength(1);
      expect(mockDb.faces).toHaveLength(1);
    });
  });

  describe('POST /api/face/enroll-profile', () => {
    test('A: quantidade valida com a senha correta cadastra', async () => {
      const res = await enrollProfile({ imagesBase64: images(MAX), senhaAtual: PASSWORD });

      expect(res.status).toBe(200);
      expect(res.body.enrolled).toBe(true);
      expect(calls()).toBe(MAX);
    });

    test('A: uma imagem em imageBase64 continua funcionando', async () => {
      const res = await enrollProfile({ imageBase64: OWNER, senhaAtual: PASSWORD });

      expect(res.status).toBe(200);
      expect(calls()).toBe(1);
    });

    test.each([
      ['maximo + 1', MAX + 1],
      ['200 imagens', 200],
    ])('B/C: %s responde 400 sem verificar a senha nem chamar o servico', async (_label, count) => {
      const res = await enrollProfile({ imagesBase64: images(count), senhaAtual: PASSWORD });

      expect(res.status).toBe(400);
      expect(res.body).toEqual(TOO_MANY);
      expect(calls()).toBe(0);
      expect(verifySpy).not.toHaveBeenCalled();
      expect(FaceProfile.findOneAndUpdate).not.toHaveBeenCalled();
    });

    test('D: excesso nao altera o perfil existente', async () => {
      seedProfile(OWNER);

      const res = await enrollProfile({ imagesBase64: images(MAX + 1, OTHER), senhaAtual: PASSWORD });

      expect(res.status).toBe(400);
      expect(facesOf()).toEqual([OWNER]);
    });

    test('E: depois do excesso, uma tentativa valida continua possivel', async () => {
      seedProfile(OWNER);
      expect((await enrollProfile({ imagesBase64: images(MAX + 1), senhaAtual: PASSWORD })).status).toBe(400);

      const res = await enrollProfile({ imagesBase64: images(MAX), senhaAtual: PASSWORD });

      expect(res.status).toBe(200);
      expect(facesOf()).toEqual(images(MAX));
    });

    test('D42: senha continua obrigatoria e senha errada continua 400', async () => {
      expect((await enrollProfile({ imagesBase64: images(MAX) })).body).toEqual({ erro: 'Senha atual é obrigatória.' });

      const wrong = await enrollProfile({ imagesBase64: images(MAX), senhaAtual: 'SenhaErrada@1' });

      expect(wrong.status).toBe(400);
      expect(wrong.body).toEqual({ erro: 'Senha atual incorreta.' });
      expect(calls()).toBe(0);
    });

    test('D42: captura mista continua 403', async () => {
      seedProfile(OWNER);

      const res = await enrollProfile({ imagesBase64: [OWNER, OTHER], senhaAtual: PASSWORD });

      expect(res.status).toBe(403);
      expect(facesOf()).toEqual([OWNER]);
    });

    test('sem JWT continua 401, mesmo com excesso', async () => {
      const res = await enrollProfile({ imagesBase64: images(200), senhaAtual: PASSWORD }, null);

      expect(res.status).toBe(401);
      expect(calls()).toBe(0);
    });
  });
});
