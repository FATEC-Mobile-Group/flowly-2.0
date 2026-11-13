const request = require('supertest');

jest.mock('@google-cloud/storage', () => ({
  Storage: jest.fn().mockImplementation(() => ({
    bucket: jest.fn().mockReturnValue({ file: jest.fn() }),
  })),
}));

// Uma rota real, com o controller trocado para lancar o erro que o teste precisa.
jest.mock('../controllers/notificationController', () => ({
  ...jest.requireActual('../controllers/notificationController'),
  contarNaoLidas: jest.fn(),
}));

const notificationController = require('../controllers/notificationController');
const { issueAuthToken } = require('../utils/faceAuth');
const app = require('../app');

const INTERNAL = 'connect ECONNREFUSED 10.0.0.5:27017 /app/segredo/main.js';
const GENERIC = { success: false, error: 'Erro interno do servidor' };
const LEAK_PATTERN = /ECONNREFUSED|10\.0\.0\.5|27017|\/app\/|segredo|TypeError|Cannot read|\bat .+:\d+/;

describe('D62: tratamento global de erros nao repassa falha interna', () => {
  const originalEnv = process.env.NODE_ENV;
  let errorSpy;

  beforeEach(() => {
    jest.clearAllMocks();
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    process.env.NODE_ENV = originalEnv;
    jest.restoreAllMocks();
  });

  const count = () =>
    request(app)
      .get('/api/notificacoes/count')
      .set('Authorization', `Bearer ${issueAuthToken({ _id: '507f1f77bcf86cd799439011', tipo: 'user' })}`);

  const throwing = (err) =>
    notificationController.contarNaoLidas.mockImplementation(async () => {
      throw err;
    });

  describe('erro de servidor nao tratado', () => {
    test.each([
      ['erro comum', () => new Error(INTERNAL), 500],
      ['erro de programacao', () => new TypeError("Cannot read properties of undefined (reading 'x')"), 500],
      ['com status 500', () => Object.assign(new Error(INTERNAL), { status: 500 }), 500],
      ['com status 502', () => Object.assign(new Error(INTERNAL), { status: 502 }), 502],
      ['com status 503', () => Object.assign(new Error(INTERNAL), { status: 503 }), 503],
      ['sem mensagem', () => new Error(), 500],
    ])('%s: mantem o status e responde mensagem generica', async (_label, build, status) => {
      throwing(build());

      const res = await count();

      expect(res.status).toBe(status);
      expect(res.body).toEqual(GENERIC);
      expect(JSON.stringify(res.body)).not.toMatch(LEAK_PATTERN);
    });

    test('em desenvolvimento tambem nao envia o stack', async () => {
      process.env.NODE_ENV = 'development';
      throwing(new Error(INTERNAL));

      const res = await count();

      expect(res.status).toBe(500);
      expect(res.body).toEqual(GENERIC);
    });

    test('o erro completo continua no log do servidor', async () => {
      throwing(new Error(INTERNAL));

      await count();

      const logged = JSON.stringify(errorSpy.mock.calls.map((args) => args.map((arg) => arg?.message ?? arg)));
      expect(logged).toContain('ECONNREFUSED');
    });
  });

  describe('erro do cliente conhecido mantem a mensagem', () => {
    test.each([
      [400, 'Parametro invalido.'],
      [403, 'Acesso negado.'],
      [404, 'Recurso nao encontrado.'],
      [409, 'Conflito conhecido.'],
      [422, 'Dados nao processaveis.'],
    ])('status %i continua com a mensagem do erro', async (status, message) => {
      throwing(Object.assign(new Error(message), { status }));

      const res = await count();

      expect(res.status).toBe(status);
      expect(res.body).toEqual({ success: false, error: message });
    });

    test('corpo acima do limite continua 413 com a mensagem atual', async () => {
      const res = await request(app)
        .post('/api/auth/login')
        .set('Content-Type', 'application/json')
        .send(JSON.stringify({ email: 'a'.repeat(16 * 1024 * 1024) }));

      expect(res.status).toBe(413);
      expect(res.body).toEqual({ success: false, error: 'request entity too large' });
    });

    test('JSON invalido continua generico (D34 parte 2)', async () => {
      const res = await request(app).post('/api/auth/login').set('Content-Type', 'application/json').send('{');

      expect(res.status).toBe(400);
      expect(res.body).toEqual({ success: false, error: 'JSON inválido.' });
    });
  });

  test('rota inexistente continua 404 com a mensagem atual', async () => {
    const res = await request(app).get('/api/nao-existe');

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ success: false, error: 'Rota não encontrada' });
  });
});
