const request = require('supertest');

jest.mock('@google-cloud/storage', () => ({
  Storage: jest.fn().mockImplementation(() => ({
    bucket: jest.fn().mockReturnValue({ file: jest.fn() }),
  })),
}));

jest.mock('../models/User', () => ({
  findById: jest.fn(),
}));

jest.mock('../models/FaceProfile', () => ({
  findOne: jest.fn(),
}));

// O limite de tentativas tem teste proprio: faceVerify.rateLimit.test.js.
jest.mock('../middlewares/rateLimiters', () => ({
  ...jest.requireActual('../middlewares/rateLimiters'),
  faceVerifyLimiter: (_req, _res, next) => next(),
}));

const config = require('../config/config');
const User = require('../models/User');
const FaceProfile = require('../models/FaceProfile');
const { issueFaceSessionToken } = require('../utils/faceAuth');
const app = require('../app');

const USER_ID = '507f1f77bcf86cd799439011';
const IMAGE = 'data:image/jpeg;base64,AAAA';
const WRONG_FACE_RESPONSE = { erro: 'Rosto não reconhecido. Tente capturar outra foto com o rosto bem visível.' };
const DISTANCE = 0.912345;
const THRESHOLD = 0.4567;
const INTERNAL_FIELDS = ['distance', 'threshold', 'score', 'similarity', 'embedding', 'embeddings', 'model', 'detector'];

// Corpos exatamente como flowly_iot_face/main.py responde.
const comparison = (match) => ({
  match,
  distance: DISTANCE,
  threshold: THRESHOLD,
  face_detected: true,
  model: 'VGG-Face',
});
const noFaceBody = {
  match: false,
  face_detected: false,
  erro: 'Não foi possível identificar um rosto na foto. Posicione-se de frente à câmera, com boa iluminação, e tente novamente.',
};

const serviceResponds = (status, body) => {
  global.fetch.mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: jest.fn().mockResolvedValue(body),
  });
};

const verify = () =>
  request(app)
    .post('/api/face/verify')
    .send({ faceSessionToken: issueFaceSessionToken(USER_ID, 'face_verify'), imageBase64: IMAGE });

const keysOf = (value) =>
  value && typeof value === 'object'
    ? Object.entries(value).flatMap(([key, item]) => [key, ...keysOf(item)])
    : [];

const expectNoInternalFields = (res) => {
  INTERNAL_FIELDS.forEach((field) => expect(keysOf(res.body)).not.toContain(field));
  expect(JSON.stringify(res.body)).not.toContain(String(DISTANCE));
  expect(JSON.stringify(res.body)).not.toContain(String(THRESHOLD));
  expect(JSON.stringify(res.body)).not.toContain('VGG-Face');
  expect(JSON.stringify(res.headers)).not.toContain(String(DISTANCE));
};

describe('D55: a resposta de /face/verify nao expoe dados da comparacao', () => {
  const originalFetch = global.fetch;
  const originalServiceSecret = config.face.serviceSecret;
  const originalEmbeddingKey = config.face.embeddingKey;

  beforeAll(() => {
    config.face.serviceSecret = 'segredo-de-teste';
    config.face.embeddingKey = Buffer.alloc(32, 1).toString('base64');
  });

  afterAll(() => {
    config.face.serviceSecret = originalServiceSecret;
    config.face.embeddingKey = originalEmbeddingKey;
    global.fetch = originalFetch;
  });

  beforeEach(() => {
    jest.clearAllMocks();
    global.fetch = jest.fn();
    User.findById.mockResolvedValue({ _id: USER_ID, nome: 'Conta', tipo: 'user', fotoPerfil: '' });
    FaceProfile.findOne.mockResolvedValue({ embeddings: [[0.1, 0.2]] });
  });

  describe.each([
    ['uma referencia', '/verify', [[0.1, 0.2]]],
    ['varias referencias', '/verify-multi', [[0.1, 0.2], [0.3, 0.4]]],
  ])('rosto errado, perfil com %s', (_label, servicePath, embeddings) => {
    beforeEach(() => {
      FaceProfile.findOne.mockResolvedValue({ embeddings });
      serviceResponds(200, comparison(false));
    });

    test('continua 401, sem JWT, so com a mensagem generica', async () => {
      const res = await verify();

      expect(res.status).toBe(401);
      expect(res.body.token).toBeUndefined();
      expect(res.body).toEqual(WRONG_FACE_RESPONSE);
      expect(global.fetch).toHaveBeenCalledWith(expect.stringContaining(servicePath), expect.anything());
    });

    test('nao contem distancia, limiar, score, similaridade, embedding nem modelo', async () => {
      const res = await verify();

      expectNoInternalFields(res);
    });
  });

  describe('outras falhas faciais', () => {
    test('foto sem rosto, com o corpo real de erro do servico: 400 sem dado biometrico', async () => {
      serviceResponds(400, noFaceBody);

      const res = await verify();

      expect(res.status).toBe(400);
      expect(res.body.token).toBeUndefined();
      expectNoInternalFields(res);
    });

    test('foto sem rosto informada com 200: 400 so com a mensagem', async () => {
      serviceResponds(200, noFaceBody);

      const res = await verify();

      expect(res.status).toBe(400);
      expect(Object.keys(res.body)).toEqual(['erro']);
      expectNoInternalFields(res);
    });
  });

  describe('o que nao muda', () => {
    test('rosto certo: 200 com JWT e sem dados da comparacao', async () => {
      serviceResponds(200, comparison(true));

      const res = await verify();

      expect(res.status).toBe(200);
      expect(res.body.token).toEqual(expect.any(String));
      expect(Object.keys(res.body).sort()).toEqual(['msg', 'token', 'user']);
      expectNoInternalFields(res);
    });

    test('a decisao continua vindo de match, nao da distancia', async () => {
      serviceResponds(200, { ...comparison(false), distance: 0.01 });
      expect((await verify()).status).toBe(401);

      serviceResponds(200, { ...comparison(true), distance: 0.99 });
      expect((await verify()).status).toBe(200);

      const { distance: _ignored, ...withoutDistance } = comparison(false);
      serviceResponds(200, withoutDistance);
      expect((await verify()).status).toBe(401);
    });

    test('o limiar enviado ao servico nao muda', async () => {
      serviceResponds(200, comparison(false));

      await verify();

      const sent = JSON.parse(global.fetch.mock.calls[0][1].body);
      expect(sent.threshold).toBe(config.face.verifyThreshold);
    });

    test('o mesmo token continua valendo depois de um rosto errado', async () => {
      const faceSessionToken = issueFaceSessionToken(USER_ID, 'face_verify');
      const send = () => request(app).post('/api/face/verify').send({ faceSessionToken, imageBase64: IMAGE });

      serviceResponds(200, comparison(false));
      expect((await send()).status).toBe(401);

      serviceResponds(200, comparison(true));
      const res = await send();

      expect(res.status).toBe(200);
      expect(res.body.token).toEqual(expect.any(String));
    });
  });
});
