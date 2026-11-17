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
const IMAGE = 'data:image/jpeg;base64,/9j/c2ludGV0aWNh';
const REFERENCE = [0.7311, -0.2417];
const PHOTO_MESSAGE = 'Tire outra imagem';

// Corpos exatamente como flowly_iot_face/main.py responde em cada categoria de falha.
const serviceBody = (erro) => ({ match: false, face_detected: false, erro });
const SERVICE_FAILURES = {
  model_unavailable: [503, serviceBody('Serviço facial indisponível no momento. Tente novamente em instantes.')],
  internal_error: [500, serviceBody('Erro interno no serviço facial.')],
  invalid_reference: [500, serviceBody('Erro interno no serviço facial.')],
  invalid_input: [
    400,
    serviceBody('Não foi possível processar a foto. Tire outra imagem com o rosto bem visível e tente novamente.'),
  ],
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

describe('falhas classificadas do servico facial chegam ao cliente sem detalhe tecnico', () => {
  const originalFetch = global.fetch;
  const originalServiceSecret = config.face.serviceSecret;
  let consoleError;

  beforeAll(() => {
    config.face.serviceSecret = 'segredo-de-teste';
  });

  afterAll(() => {
    config.face.serviceSecret = originalServiceSecret;
    global.fetch = originalFetch;
  });

  beforeEach(() => {
    jest.clearAllMocks();
    global.fetch = jest.fn();
    consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
    User.findById.mockResolvedValue({ _id: USER_ID, nome: 'Conta', tipo: 'user', fotoPerfil: '' });
    FaceProfile.findOne.mockResolvedValue({ embeddings: [REFERENCE] });
  });

  afterEach(() => {
    consoleError.mockRestore();
  });

  test.each([
    ['model_unavailable', 503, 'Serviço facial indisponível.'],
    ['internal_error', 500, 'Erro na verificação facial.'],
    ['invalid_reference', 500, 'Erro na verificação facial.'],
  ])('%s: %s generico, sem JWT e sem pedir outra foto', async (category, expectedStatus, expectedMessage) => {
    serviceResponds(...SERVICE_FAILURES[category]);

    const res = await verify();

    expect(res.status).toBe(expectedStatus);
    expect(res.body).toEqual({ erro: expectedMessage });
    expect(res.body.token).toBeUndefined();
    expect(JSON.stringify(res.body)).not.toContain(PHOTO_MESSAGE);
  });

  test('falha do servico vai para o log da API sem imagem nem embedding', async () => {
    serviceResponds(...SERVICE_FAILURES.model_unavailable);

    await verify();

    expect(consoleError).toHaveBeenCalled();
    const logged = consoleError.mock.calls.flat().map((item) => String(item?.stack || JSON.stringify(item))).join('\n');
    expect(logged).not.toContain('c2ludGV0aWNh');
    expect(logged).not.toContain('0.7311');
  });

  test('erro de entrada continua 400 com a mensagem de nova foto', async () => {
    serviceResponds(...SERVICE_FAILURES.invalid_input);

    const res = await verify();

    expect(res.status).toBe(400);
    expect(res.body.erro).toContain(PHOTO_MESSAGE);
    expect(res.body.token).toBeUndefined();
  });

  test('o segredo interno continua indo no cabecalho de toda chamada', async () => {
    serviceResponds(...SERVICE_FAILURES.internal_error);

    await verify();

    const [, options] = global.fetch.mock.calls[0];
    expect(options.headers['X-Flowly-Service-Secret']).toBe('segredo-de-teste');
  });
});
