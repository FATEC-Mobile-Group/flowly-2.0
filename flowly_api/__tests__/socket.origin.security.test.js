const http = require('http');
const crypto = require('crypto');
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
const POLLING = '/socket.io/?EIO=4&transport=polling';
const WEBSOCKET = '/socket.io/?EIO=4&transport=websocket';
const USER_ID = '507f1f77bcf86cd799439011';

// Cada bloco sobe um servidor com outro ambiente, o que pesa com a suite inteira em paralelo.
jest.setTimeout(30000);

describe('D04: origem no handshake do Socket.IO', () => {
  const originalEnv = process.env;
  let server;
  let io;
  let port;
  let issueAuthToken;

  // Sobe o servidor como o server.js faz: Express e Socket.IO no mesmo http.Server.
  const start = async (env) => {
    const next = { ...originalEnv, JWT_SECRET: 'a'.repeat(32), ...env };
    Object.keys(next).forEach((key) => next[key] === undefined && delete next[key]);
    process.env = next;
    jest.resetModules();

    const app = require('../app');
    const setupSocketInteractions = require('../socket_handler');
    ({ issueAuthToken } = require('../utils/faceAuth'));

    server = http.createServer(app);
    io = setupSocketInteractions(server);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = server.address().port;
  };

  const stop = async () => {
    if (io) await new Promise((resolve) => io.close(resolve));
    io = undefined;
    server = undefined;
    process.env = originalEnv;
    jest.resetModules();
  };

  const withOrigin = (req, origin) => (origin === undefined ? req : req.set('Origin', origin));

  const pollingHandshake = (origin) => withOrigin(request(server).get(POLLING), origin);

  const websocketHandshake = (origin) =>
    new Promise((resolve, reject) => {
      const req = http.request({
        host: '127.0.0.1',
        port,
        path: WEBSOCKET,
        agent: false,
        headers: {
          Connection: 'Upgrade',
          Upgrade: 'websocket',
          'Sec-WebSocket-Version': '13',
          'Sec-WebSocket-Key': crypto.randomBytes(16).toString('base64'),
          ...(origin === undefined ? {} : { Origin: origin }),
        },
      });
      req.on('upgrade', (res, socket) => {
        socket.destroy();
        resolve({ upgraded: true, status: res.statusCode });
      });
      req.on('response', (res) => {
        res.resume();
        resolve({ upgraded: false, status: res.statusCode });
      });
      req.on('error', reject);
      req.end();
    });

  // Decisao do allowRequest configurado no servidor, sem passar pela rede.
  const allowRequestDecision = (origin) => {
    const callback = jest.fn();
    io.engine.opts.allowRequest({ headers: origin === undefined ? {} : { origin } }, callback);
    return callback;
  };

  const httpAllows = async (origin) => {
    const res = await withOrigin(request(server).get('/api/nao-existe'), origin);
    return res.status !== 403;
  };

  const sidOf = (res) => JSON.parse(res.text.slice(1)).sid;

  const waitFor = async (condition) => {
    const deadline = Date.now() + 2000;
    while (!condition()) {
      if (Date.now() > deadline) throw new Error('condicao nao atingida em 2s');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };

  beforeEach(() => {
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('producao com a origem oficial', () => {
    beforeAll(() => start({ NODE_ENV: 'production', CORS_ORIGIN: OFFICIAL }));
    afterAll(stop);

    // Cada teste comeca sem sessao aberta.
    afterEach(async () => {
      Object.values(io.engine.clients).forEach((client) => client.close(true));
      await waitFor(() => io.engine.clientsCount === 0 && io.of('/').sockets.size === 0);
    });

    test('allowRequest: origem oficial -> true', () => {
      expect(allowRequestDecision(OFFICIAL)).toHaveBeenCalledWith(null, true);
    });

    test('allowRequest: origem externa -> false', () => {
      const callback = allowRequestDecision(EVIL);

      expect(callback).toHaveBeenCalledTimes(1);
      expect(callback).toHaveBeenCalledWith(null, false);
    });

    test('allowRequest: sem Origin -> true', () => {
      expect(allowRequestDecision(undefined)).toHaveBeenCalledWith(null, true);
    });

    test('polling: origem oficial abre a sessao e recebe a propria origem', async () => {
      const res = await pollingHandshake(OFFICIAL);

      expect(res.status).toBe(200);
      expect(sidOf(res)).toEqual(expect.any(String));
      expect(res.headers['access-control-allow-origin']).toBe(OFFICIAL);
      expect(io.engine.clientsCount).toBe(1);
    });

    test('polling: origem externa e recusada sem criar sessao', async () => {
      const res = await pollingHandshake(EVIL);

      expect(res.status).toBe(403);
      expect(res.text).not.toContain('"sid"');
      expect(res.headers['access-control-allow-origin']).toBeUndefined();
      expect(io.engine.clientsCount).toBe(0);
    });

    test('polling: sem Origin abre a sessao', async () => {
      const res = await pollingHandshake(undefined);

      expect(res.status).toBe(200);
      expect(sidOf(res)).toEqual(expect.any(String));
      expect(io.engine.clientsCount).toBe(1);
    });

    test('websocket: origem oficial faz o upgrade', async () => {
      expect(await websocketHandshake(OFFICIAL)).toEqual({ upgraded: true, status: 101 });
    });

    test('websocket: origem externa e recusada sem upgrade nem sessao', async () => {
      const res = await websocketHandshake(EVIL);

      expect(res.upgraded).toBe(false);
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.status).toBeLessThan(500);
      expect(io.engine.clientsCount).toBe(0);
    });

    test('websocket: sem Origin faz o upgrade (cliente mobile)', async () => {
      expect(await websocketHandshake(undefined)).toEqual({ upgraded: true, status: 101 });
    });

    test.each([
      ['sufixo extra', `${OFFICIAL}.evil.example`],
      ['outro esquema', OFFICIAL.replace('https://', 'http://')],
      ['Origin null', 'null'],
    ])('polling: origem parecida e recusada: %s', async (_label, origin) => {
      expect((await pollingHandshake(origin)).status).toBe(403);
      expect(io.engine.clientsCount).toBe(0);
    });

    describe('o JWT continua exigido depois do handshake', () => {
      const connectNamespace = async (auth) => {
        const sid = sidOf(await pollingHandshake(OFFICIAL));
        const url = `${POLLING}&sid=${sid}`;
        const packet = auth ? `40${JSON.stringify(auth)}` : '40';

        const post = await request(server).post(url).set('Origin', OFFICIAL).type('text/plain').send(packet);
        expect(post.status).toBe(200);

        return { url, reply: await request(server).get(url).set('Origin', OFFICIAL) };
      };

      test('origem oficial sem token nao entra no namespace', async () => {
        const { reply } = await connectNamespace();

        expect(reply.text).toMatch(/^44/);
        expect(reply.text).toContain('Não autorizado.');
        expect(io.of('/').sockets.size).toBe(0);
      });

      test('origem oficial com token invalido nao entra no namespace', async () => {
        const { reply } = await connectNamespace({ token: 'nao-e-um-jwt' });

        expect(reply.text).toMatch(/^44/);
        expect(io.of('/').sockets.size).toBe(0);
      });

      test('origem oficial com token valido conecta e entra na propria sala', async () => {
        const token = issueAuthToken({ _id: USER_ID, tipo: 'user' });
        const { url, reply } = await connectNamespace({ token });

        expect(reply.text).toMatch(/^40\{"sid":/);
        expect(io.of('/').sockets.size).toBe(1);

        const post = await request(server).post(url).set('Origin', OFFICIAL).type('text/plain').send('42["join_user"]');
        expect(post.status).toBe(200);

        await waitFor(() => io.of('/').adapter.rooms.has(`user_${USER_ID}`));
      });
    });
  });

  describe('Express e Socket.IO decidem igual', () => {
    const ORIGINS = [
      ['oficial', OFFICIAL],
      ['segunda origem', SECOND],
      ['externa', EVIL],
      ['ausente', undefined],
      ['Origin null', 'null'],
      ['sufixo extra', `${OFFICIAL}.evil.example`],
    ];

    describe.each([
      ['producao, uma origem', { NODE_ENV: 'production', CORS_ORIGIN: OFFICIAL }, [true, false, false, true, false, false]],
      [
        'producao, varias origens com espacos',
        { NODE_ENV: 'production', CORS_ORIGIN: `  ${OFFICIAL} ,  ${SECOND}  ` },
        [true, true, false, true, false, false],
      ],
      ['producao, curinga', { NODE_ENV: 'production', CORS_ORIGIN: '*' }, [false, false, false, true, false, false]],
      ['producao, sem CORS_ORIGIN', { NODE_ENV: 'production', CORS_ORIGIN: undefined }, [false, false, false, true, false, false]],
      ['desenvolvimento, curinga', { NODE_ENV: 'development', CORS_ORIGIN: '*' }, [true, true, true, true, true, true]],
      [
        'desenvolvimento, sem CORS_ORIGIN',
        { NODE_ENV: 'development', CORS_ORIGIN: undefined },
        [true, true, true, true, true, true],
      ],
    ])('%s', (_label, env, expected) => {
      beforeAll(() => start(env));
      afterAll(stop);

      test.each(ORIGINS.map(([name, origin], index) => [name, origin, expected[index]]))(
        'origem %s',
        async (_name, origin, allowed) => {
          const decision = allowRequestDecision(origin);
          const polling = await pollingHandshake(origin);

          expect({
            http: await httpAllows(origin),
            allowRequest: decision.mock.calls[0][1],
            polling: polling.status === 200,
          }).toEqual({ http: allowed, allowRequest: allowed, polling: allowed });
        }
      );
    });
  });
});
