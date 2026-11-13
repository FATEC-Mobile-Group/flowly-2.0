const request = require('supertest');

jest.mock('@google-cloud/storage', () => ({
  Storage: jest.fn().mockImplementation(() => ({
    bucket: jest.fn().mockReturnValue({ file: jest.fn() }),
  })),
}));

// Um .env local nao pode devolver o CORS_ORIGIN que o teste remove.
jest.mock('dotenv', () => ({ config: jest.fn() }));

const OFFICIAL = 'https://green-cliff-033f5810f.3.azurestaticapps.net';
const SECOND = 'https://flowly.example';
const EVIL = 'https://evil.example';
const FORBIDDEN_BODY = { success: false, error: 'Origem nao permitida pelo CORS.' };
const LOGIN = '/api/auth/login';
const UNKNOWN = '/api/nao-existe';

// Cada bloco recarrega o app com outro ambiente, o que pesa com a suite inteira em paralelo.
jest.setTimeout(30000);

describe('D04: CORS HTTP', () => {
  const originalEnv = process.env;

  const loadApp = (env) => {
    const next = { ...originalEnv, ...env };
    Object.keys(next).forEach((key) => next[key] === undefined && delete next[key]);
    process.env = next;
    jest.resetModules();
    return require('../app');
  };

  const send = (app, method, path, origin) => {
    const req = request(app)[method](path);
    return origin === undefined ? req : req.set('Origin', origin);
  };

  const expectForbidden = (res) => {
    expect(res.status).toBe(403);
    expect(res.body).toEqual(FORBIDDEN_BODY);
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  };

  beforeEach(() => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  const restoreEnv = () => {
    process.env = originalEnv;
    jest.resetModules();
  };

  describe('producao com a origem oficial', () => {
    let app;

    beforeAll(() => {
      app = loadApp({ NODE_ENV: 'production', CORS_ORIGIN: OFFICIAL });
    });
    afterAll(restoreEnv);

    test('preflight da origem oficial responde 204 com a propria origem', async () => {
      const res = await send(app, 'options', LOGIN, OFFICIAL).set('Access-Control-Request-Method', 'POST');

      expect(res.status).toBe(204);
      expect(res.headers['access-control-allow-origin']).toBe(OFFICIAL);
    });

    test('requisicao da origem oficial chega ate a aplicacao', async () => {
      const res = await send(app, 'get', UNKNOWN, OFFICIAL);

      expect(res.status).toBe(404);
      expect(res.headers['access-control-allow-origin']).toBe(OFFICIAL);
    });

    test('preflight de origem externa responde 403 controlado, sem ACAO', async () => {
      const res = await send(app, 'options', LOGIN, EVIL).set('Access-Control-Request-Method', 'POST');

      expectForbidden(res);
    });

    test.each([
      ['get', UNKNOWN],
      ['post', LOGIN],
    ])('%s %s de origem externa responde 403 antes da rota', async (method, path) => {
      expectForbidden(await send(app, method, path, EVIL));
    });

    test('a recusa nao expoe stack nem detalhe interno', async () => {
      const res = await send(app, 'get', UNKNOWN, EVIL);

      expect(Object.keys(res.body).sort()).toEqual(['error', 'success']);
      expect(res.text).not.toMatch(/\bat .+:\d+|node_modules|app\.js|Error:/);
    });

    test.each([
      ['sufixo extra', `${OFFICIAL}.evil.example`],
      ['outro esquema', OFFICIAL.replace('https://', 'http://')],
      ['barra final', `${OFFICIAL}/`],
      ['Origin null', 'null'],
    ])('origem parecida e recusada: %s', async (_label, origin) => {
      expectForbidden(await send(app, 'get', UNKNOWN, origin));
    });

    test('sem Origin o preflight continua 204', async () => {
      const res = await send(app, 'options', LOGIN);

      expect(res.status).toBe(204);
    });

    test('sem Origin a requisicao chega ate a aplicacao', async () => {
      const res = await send(app, 'get', UNKNOWN);

      expect(res.status).toBe(404);
      expect(res.body).toEqual({ success: false, error: 'Rota não encontrada' });
    });
  });

  describe('producao com varias origens e espacos na configuracao', () => {
    let app;

    beforeAll(() => {
      app = loadApp({ NODE_ENV: 'production', CORS_ORIGIN: `  ${OFFICIAL} ,  ${SECOND}  ` });
    });
    afterAll(restoreEnv);

    test.each([OFFICIAL, SECOND])('%s e permitida', async (origin) => {
      const res = await send(app, 'options', LOGIN, origin);

      expect(res.status).toBe(204);
      expect(res.headers['access-control-allow-origin']).toBe(origin);
    });

    test('origem externa continua recusada', async () => {
      expectForbidden(await send(app, 'options', LOGIN, EVIL));
    });
  });

  describe('producao nunca libera curinga', () => {
    describe.each([
      ['CORS_ORIGIN=*', '*'],
      ['CORS_ORIGIN ausente', undefined],
      ['CORS_ORIGIN vazio', ''],
    ])('%s', (_label, corsOrigin) => {
      let app;

      beforeAll(() => {
        app = loadApp({ NODE_ENV: 'production', CORS_ORIGIN: corsOrigin });
      });
      afterAll(restoreEnv);

      test('origem externa responde 403', async () => {
        expectForbidden(await send(app, 'options', LOGIN, EVIL));
        expectForbidden(await send(app, 'get', UNKNOWN, EVIL));
      });

      test('sem Origin continua permitido', async () => {
        expect((await send(app, 'get', UNKNOWN)).status).toBe(404);
      });
    });
  });

  describe('desenvolvimento continua permissivo com curinga', () => {
    describe.each([
      ['CORS_ORIGIN=*', '*'],
      ['CORS_ORIGIN ausente', undefined],
    ])('%s', (_label, corsOrigin) => {
      let app;

      beforeAll(() => {
        app = loadApp({ NODE_ENV: 'development', CORS_ORIGIN: corsOrigin });
      });
      afterAll(restoreEnv);

      test('qualquer origem e permitida', async () => {
        const preflight = await send(app, 'options', LOGIN, 'http://localhost:5173');
        expect(preflight.status).toBe(204);
        expect(preflight.headers['access-control-allow-origin']).toBeDefined();

        expect((await send(app, 'get', UNKNOWN, 'http://localhost:5173')).status).toBe(404);
      });
    });

    describe('lista explicita', () => {
      let app;

      beforeAll(() => {
        app = loadApp({ NODE_ENV: 'development', CORS_ORIGIN: 'http://localhost:5173' });
      });
      afterAll(restoreEnv);

      test('ainda recusa origem externa', async () => {
        const res = await send(app, 'get', UNKNOWN, EVIL);

        expect(res.status).toBe(403);
        expect(res.headers['access-control-allow-origin']).toBeUndefined();
      });
    });
  });
});
