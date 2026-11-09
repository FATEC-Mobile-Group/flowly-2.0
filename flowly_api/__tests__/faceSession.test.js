const request = require('supertest');
const jwt = require('jsonwebtoken');

jest.mock('@google-cloud/storage', () => ({
  Storage: jest.fn().mockImplementation(() => ({
    bucket: jest.fn().mockReturnValue({ file: jest.fn() }),
  })),
}));

jest.mock('../models/User', () => ({
  findById: jest.fn(),
  findOneAndUpdate: jest.fn(),
}));

jest.mock('../models/FaceProfile', () => ({
  findOne: jest.fn(),
  findOneAndUpdate: jest.fn(),
}));

jest.mock('../utils/faceEnrollmentGuard', () => ({
  assertUniqueFaceEnrollment: jest.fn().mockResolvedValue(),
  isSamePersonFaceUpdate: jest.fn().mockReturnValue(true),
}));

const config = require('../config/config');
const User = require('../models/User');
const FaceProfile = require('../models/FaceProfile');
const app = require('../app');

const USER_ID = '507f1f77bcf86cd799439011';
const IMAGE = 'data:image/jpeg;base64,AAAA';
const PUBLIC_MESSAGE = 'Sessão de verificação facial inválida ou expirada. Faça login novamente.';
const TECHNICAL_TEXT =
  /jwt|JsonWebToken|TokenExpired|NotBefore|invalid signature|malformed|expired|audience|issuer|signature/i;

const ENDPOINTS = [
  {
    route: '/api/face/verify',
    purpose: 'face_verify',
    wrongPurpose: 'face_enroll',
    body: (token) => ({ faceSessionToken: token, imageBase64: IMAGE }),
  },
  {
    route: '/api/face/enroll',
    purpose: 'face_enroll',
    wrongPurpose: 'face_verify',
    body: (token) => ({ faceSessionToken: token, imagesBase64: [IMAGE, IMAGE] }),
  },
  {
    route: '/api/face/skip-enrollment',
    purpose: 'face_enroll',
    wrongPurpose: 'face_verify',
    body: (token) => ({ faceSessionToken: token }),
  },
];

const [VERIFY, ENROLL, SKIP] = ENDPOINTS;

const signFaceToken = (purpose, { payload = {}, secret = config.jwt.faceSecret, options = {} } = {}) =>
  jwt.sign({ id: USER_ID, purpose, tokenType: 'face-session', ...payload }, secret, {
    issuer: config.jwt.issuer,
    audience: config.jwt.faceAudience,
    ...options,
  });

// /verify exige perfil; /enroll e /skip-enrollment so valem enquanto nao existe perfil.
const post = (endpoint, token) => {
  FaceProfile.findOne.mockResolvedValue(endpoint === VERIFY ? { embeddings: [[0.1, 0.2]] } : null);
  return request(app).post(endpoint.route).send(endpoint.body(token));
};

const INVALID_TOKENS = [
  ['malformado', () => 'token-invalido'],
  ['expirado', ({ purpose }) => signFaceToken(purpose, { options: { expiresIn: -10 } })],
  ['assinado com segredo incorreto', ({ purpose }) => signFaceToken(purpose, { secret: 'segredo-incorreto' })],
  ['com audience incorreta', ({ purpose }) =>
    signFaceToken(purpose, { options: { audience: config.jwt.accessAudience } })],
  ['com emissor incorreto', ({ purpose }) => signFaceToken(purpose, { options: { issuer: 'outro-emissor' } })],
  ['ainda nao ativo', ({ purpose }) => signFaceToken(purpose, { options: { notBefore: 600 } })],
  ['sem assinatura (alg none)', ({ purpose }) =>
    jwt.sign({ id: USER_ID, purpose, tokenType: 'face-session' }, '', {
      algorithm: 'none',
      issuer: config.jwt.issuer,
      audience: config.jwt.faceAudience,
    })],
  ['que nao e texto', () => 12345],
  ['JWT principal no lugar do token facial', () =>
    jwt.sign({ id: USER_ID, tipo: 'user', tokenType: 'access' }, config.jwt.secret, {
      issuer: config.jwt.issuer,
      audience: config.jwt.accessAudience,
    })],
  ['com finalidade incorreta', ({ wrongPurpose }) => signFaceToken(wrongPurpose)],
  ['com tipo incorreto', ({ purpose }) => signFaceToken(purpose, { payload: { tokenType: 'access' } })],
  ['sem id de usuario', ({ purpose }) => signFaceToken(purpose, { payload: { id: undefined } })],
];

const fetchResponse = (status, body) => ({
  ok: status >= 200 && status < 300,
  status,
  json: jest.fn().mockResolvedValue(body),
});

describe('faceSessionToken nas rotas faciais', () => {
  const originalFetch = global.fetch;
  const originalServiceSecret = config.face.serviceSecret;
  const originalEmbeddingKey = config.face.embeddingKey;
  let user;

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
    user = {
      _id: USER_ID,
      nome: 'Usuario Teste',
      tipo: 'user',
      fotoPerfil: '',
      faceEnrollmentOffered: true,
      faceEnrollmentSkipped: false,
    };
    User.findById.mockResolvedValue(user);
    User.findOneAndUpdate.mockImplementation(async (_filter, update) => Object.assign(user, update.$set));
    FaceProfile.findOneAndUpdate.mockResolvedValue({});
  });

  describe.each(ENDPOINTS)('$route', (endpoint) => {
    test.each(INVALID_TOKENS)('token %s responde 401 com mensagem publica', async (_label, buildToken) => {
      const res = await post(endpoint, buildToken(endpoint));

      expect(res.status).toBe(401);
      expect(res.body).toEqual({ erro: PUBLIC_MESSAGE });
      expect(JSON.stringify(res.body)).not.toMatch(TECHNICAL_TEXT);
      expect(User.findById).not.toHaveBeenCalled();
      expect(global.fetch).not.toHaveBeenCalled();
    });

    test('erro inesperado na validacao nao vira 401', async () => {
      const spy = jest.spyOn(jwt, 'verify').mockImplementationOnce(() => {
        throw new Error('falha inesperada');
      });

      const res = await post(endpoint, signFaceToken(endpoint.purpose));
      spy.mockRestore();

      expect(res.status).toBe(500);
    });

    test('falha do banco continua sendo 500', async () => {
      User.findById.mockRejectedValue(new Error('banco indisponivel'));

      const res = await post(endpoint, signFaceToken(endpoint.purpose));

      expect(res.status).toBe(500);
    });
  });

  describe('corpo sem os campos obrigatorios continua 400', () => {
    test.each([
      [VERIFY.route, {}, 'faceSessionToken e imageBase64 são obrigatórios.'],
      [VERIFY.route, { faceSessionToken: 'qualquer' }, 'faceSessionToken e imageBase64 são obrigatórios.'],
      [ENROLL.route, {}, 'faceSessionToken e ao menos uma imagem (imageBase64 ou imagesBase64) são obrigatórios.'],
      [ENROLL.route, { faceSessionToken: 'qualquer' }, 'faceSessionToken e ao menos uma imagem (imageBase64 ou imagesBase64) são obrigatórios.'],
      [SKIP.route, {}, 'faceSessionToken é obrigatório.'],
    ])('%s com corpo %j', async (route, body, message) => {
      const res = await request(app).post(route).send(body);

      expect(res.status).toBe(400);
      expect(res.body).toEqual({ erro: message });
    });
  });

  describe('erros reais do servico facial nao viram 401', () => {
    const SERVICE_CALLS = [
      [VERIFY.route, VERIFY, '/verify'],
      [ENROLL.route, ENROLL, '/embed'],
    ];

    test.each(SERVICE_CALLS)('%s: erro interno do servico continua 500', async (_route, endpoint, path) => {
      global.fetch.mockResolvedValue(fetchResponse(500, { erro: 'Falha interna do servico' }));

      const res = await post(endpoint, signFaceToken(endpoint.purpose));

      expect(res.status).toBe(500);
      expect(global.fetch).toHaveBeenCalledWith(expect.stringContaining(path), expect.anything());
    });

    test.each(SERVICE_CALLS)('%s: servico indisponivel continua 503', async (_route, endpoint) => {
      global.fetch.mockRejectedValue(new Error('connect ECONNREFUSED'));

      const res = await post(endpoint, signFaceToken(endpoint.purpose));

      expect(res.status).toBe(503);
      expect(res.body.erro).toContain('Serviço facial indisponível');
    });

    test.each(SERVICE_CALLS)('%s: servico sem resposta continua 504', async (_route, endpoint) => {
      global.fetch.mockRejectedValue(Object.assign(new Error('aborted'), { name: 'AbortError' }));

      const res = await post(endpoint, signFaceToken(endpoint.purpose));

      expect(res.status).toBe(504);
    });

    test.each(SERVICE_CALLS)('%s: foto sem rosto continua 400', async (_route, endpoint) => {
      global.fetch.mockResolvedValue(
        fetchResponse(400, { face_detected: false, erro: 'Face could not be detected' }),
      );

      const res = await post(endpoint, signFaceToken(endpoint.purpose));

      expect(res.status).toBe(400);
    });
  });

  describe('token valido chega a logica de biometria', () => {
    test('/verify com correspondencia conclui o login', async () => {
      global.fetch.mockResolvedValue(
        fetchResponse(200, { match: true, face_detected: true, distance: 0.1 }),
      );

      const res = await post(VERIFY, signFaceToken(VERIFY.purpose));

      expect(res.status).toBe(200);
      expect(res.body.token).toEqual(expect.any(String));
      expect(res.body.user.id).toBe(USER_ID);
      expect(User.findById).toHaveBeenCalledWith(USER_ID);
      expect(global.fetch).toHaveBeenCalledWith(expect.stringContaining('/verify'), expect.anything());
    });

    test('/verify sem correspondencia continua 401 com a mensagem de rosto', async () => {
      global.fetch.mockResolvedValue(
        fetchResponse(200, { match: false, face_detected: true, distance: 0.9 }),
      );

      const res = await post(VERIFY, signFaceToken(VERIFY.purpose));

      expect(res.status).toBe(401);
      expect(res.body.erro).toContain('Rosto não reconhecido');
    });

    test('/enroll extrai os embeddings, salva o perfil e conclui o login', async () => {
      global.fetch.mockResolvedValue(
        fetchResponse(200, { face_detected: true, embedding: [0.1, 0.2], model: 'VGG-Face' }),
      );

      const res = await post(ENROLL, signFaceToken(ENROLL.purpose));

      expect(res.status).toBe(200);
      expect(res.body.token).toEqual(expect.any(String));
      expect(global.fetch).toHaveBeenCalledTimes(2);
      expect(FaceProfile.findOneAndUpdate).toHaveBeenCalledTimes(1);
    });

    test('/skip-enrollment marca a recusa e conclui o login', async () => {
      const res = await post(SKIP, signFaceToken(SKIP.purpose));

      expect(res.status).toBe(200);
      expect(res.body.token).toEqual(expect.any(String));
      expect(user.faceEnrollmentSkipped).toBe(true);
      expect(user.faceEnrollmentOffered).toBe(true);
      expect(User.findOneAndUpdate).toHaveBeenCalledTimes(1);
    });
  });
});
