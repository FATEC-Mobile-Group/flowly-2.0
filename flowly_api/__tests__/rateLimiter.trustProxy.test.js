const request = require('supertest');
const express = require('express');

jest.mock('@google-cloud/storage', () => ({
  Storage: jest.fn().mockImplementation(() => ({
    bucket: jest.fn().mockReturnValue({ file: jest.fn() }),
  })),
}));

// Um .env local nao pode trocar o ambiente que o teste define.
jest.mock('dotenv', () => ({ config: jest.fn() }));

jest.mock('../utils/sendEmail', () => jest.fn().mockResolvedValue(true));

jest.mock('argon2', () => ({
  verify: jest.fn(async () => false),
  hash: jest.fn(async () => 'hash'),
}));

const mockSavedUsers = [];
jest.mock('../models/User', () => {
  const User = jest.fn(function User(data) {
    Object.assign(this, data);
    this.save = jest.fn(async () => {
      mockSavedUsers.push(data);
    });
  });
  User.findOne = jest.fn(async () => null);
  User.findById = jest.fn(async () => null);
  return User;
});

jest.mock('../models/TwoFactorToken', () => ({
  findOne: jest.fn(async () => null),
}));

// Cada bloco recarrega o app com outro ambiente, o que pesa com a suite inteira em paralelo.
jest.setTimeout(30000);

const OFFICIAL = 'https://green-cliff-033f5810f.3.azurestaticapps.net';
const LIMIT_RESPONSE = { erro: 'Muitas tentativas. Aguarde alguns minutos e tente novamente.' };
const REGISTER = '/api/auth/registrar';
const LOGIN = '/api/auth/login';

// Os contadores ficam na memoria do modulo: cada teste usa clientes e e-mails proprios.
let sequence = 0;
const nextClient = () => {
  sequence += 1;
  return `203.0.113.${sequence}`;
};
const nextEmail = () => {
  sequence += 1;
  return `pessoa${sequence}@exemplo.com`;
};

// O proxy do Cloud Run acrescenta o IP real ao fim do X-Forwarded-For;
// o que o cliente escreveu no cabecalho fica antes dele.
const viaCloudRun = (req, clientIp, forged = []) => req.set('X-Forwarded-For', [...forged, clientIp].join(', '));

const repeat = async (times, action) => {
  const results = [];
  for (let i = 0; i < times; i += 1) {
    results.push(await action(i));
  }
  return results;
};

const expectLimited = (res) => {
  expect(res.status).toBe(429);
  expect(res.body).toEqual(LIMIT_RESPONSE);
};

describe('D51: identidade de rede dos rate limiters atras do proxy', () => {
  const originalEnv = process.env;
  let app;

  const loadApp = (env) => {
    process.env = { ...originalEnv, JWT_SECRET: 'a'.repeat(32), ...env };
    jest.resetModules();
    app = require('../app');
  };

  const restoreEnv = () => {
    process.env = originalEnv;
    jest.resetModules();
  };

  // Le req.ip com a mesma configuracao do app, sem criar rota nele.
  const readIp = async (clientIp, forged) => {
    const probe = express();
    probe.set('trust proxy', app.get('trust proxy'));
    probe.get('/', (req, res) => res.json({ ip: req.ip, ips: req.ips }));

    const req = request(probe).get('/');
    return (await (clientIp ? viaCloudRun(req, clientIp, forged) : req)).body;
  };

  const post = (url, body) => request(app).post(url).send(body);

  // Limiters que usam req.ip: [nome, limite, como enviar a requisicao].
  const IP_LIMITERS = [
    ['cadastro', 10, () => post(REGISTER, {})],
    ['login', 10, (email) => post(LOGIN, { email, senha: 'SenhaErrada@123' })],
    ['envio de codigo de verificacao', 5, (email) => post('/api/auth/2fa/enviar-codigo', { email })],
    ['envio de codigo de recuperacao', 5, (email) => post('/api/auth/recuperar-senha/enviar-codigo', { email })],
    ['validacao de codigo', 10, (email) => post('/api/auth/2fa/validar-codigo', { email, codigo: '123456' })],
    ['validacao de token', 10, () => request(app).get(`/api/auth/2fa/validar-token?token=${'a'.repeat(64)}`)],
    [
      'validacao de codigo de recuperacao',
      10,
      (email) => post('/api/auth/recuperar-senha/validar-codigo', { email, codigo: '123456' }),
    ],
    [
      'redefinicao de senha',
      10,
      (email) => post('/api/auth/recuperar-senha/redefinir', { email, codigo: '123456', novaSenha: 'NovaSenha@456' }),
    ],
  ];

  beforeEach(() => {
    mockSavedUsers.length = 0;
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('producao (Cloud Run)', () => {
    beforeAll(() => loadApp({ NODE_ENV: 'production', CORS_ORIGIN: OFFICIAL }));
    afterAll(restoreEnv);

    test('confia em exatamente um salto', () => {
      const trust = app.get('trust proxy fn');

      expect(app.get('trust proxy')).toBe(1);
      expect(trust('169.254.1.1', 0)).toBe(true);
      expect(trust('203.0.113.10', 1)).toBe(false);
    });

    describe('req.ip', () => {
      test.each([
        ['cliente A', '203.0.113.10', []],
        ['cliente B', '198.51.100.20', []],
        ['cliente IPv6', '2001:db8::10', []],
        ['A forjando um endereco', '203.0.113.10', ['1.1.1.1']],
        ['A forjando uma cadeia', '203.0.113.10', ['1.1.1.1', '2.2.2.2', '3.3.3.3']],
        ['A forjando o endereco de B', '203.0.113.10', ['198.51.100.20']],
        ['A forjando endereco interno', '203.0.113.10', ['127.0.0.1', '169.254.1.1', '10.0.0.1']],
      ])('%s: e o endereco acrescentado pelo proxy', async (_label, clientIp, forged) => {
        expect(await readIp(clientIp, forged)).toEqual({ ip: clientIp, ips: [clientIp] });
      });

      test('sem X-Forwarded-For e o endereco do socket', async () => {
        const { ip, ips } = await readIp();

        expect(ip).toMatch(/127\.0\.0\.1$|^::1$/);
        expect(ips).toEqual([]);
      });
    });

    describe.each(IP_LIMITERS)('%s', (_name, max, send) => {
      test('clientes distintos nao dividem o contador', async () => {
        const [clientA, clientB, email] = [nextClient(), nextClient(), nextEmail()];

        await repeat(max, () => viaCloudRun(send(email), clientA));
        expectLimited(await viaCloudRun(send(email), clientA));

        const res = await viaCloudRun(send(email), clientB);
        expect(res.status).not.toBe(429);
        expect(res.headers['ratelimit-remaining']).toBe(String(max - 1));
      });

      test('trocar o X-Forwarded-For forjado nao da tentativas a mais', async () => {
        const [attacker, email] = [nextClient(), nextEmail()];

        const allowed = await repeat(max, (i) => viaCloudRun(send(email), attacker, [`10.9.${i}.1`]));
        allowed.forEach((res) => expect(res.status).not.toBe(429));

        const blocked = await repeat(5, (i) => viaCloudRun(send(email), attacker, [`10.8.${i}.1`, `10.7.${i}.1`]));
        blocked.forEach(expectLimited);
      });

      test('forjar o endereco de outro cliente nao gasta o contador dele', async () => {
        const [attacker, victim, email] = [nextClient(), nextClient(), nextEmail()];

        await repeat(max + 1, () => viaCloudRun(send(email), attacker, [victim]));

        const res = await viaCloudRun(send(email), victim);
        expect(res.status).not.toBe(429);
        expect(res.headers['ratelimit-remaining']).toBe(String(max - 1));
      });
    });

    describe('sem X-Forwarded-For', () => {
      test('a requisicao segue e conta pelo endereco do socket', async () => {
        const email = nextEmail();
        const send = () => post(LOGIN, { email, senha: 'SenhaErrada@123' });

        const [first, second] = await repeat(2, send);

        expect(first.status).toBe(401);
        expect(first.headers['ratelimit-remaining']).toBe('9');
        expect(second.status).toBe(401);
        expect(second.headers['ratelimit-remaining']).toBe('8');
      });

      test('nao divide o contador com quem veio pelo proxy', async () => {
        const [client, email] = [nextClient(), nextEmail()];
        const send = () => post(LOGIN, { email, senha: 'SenhaErrada@123' });

        await repeat(10, () => viaCloudRun(send(), client));
        expectLimited(await viaCloudRun(send(), client));

        expect((await send()).status).toBe(401);
      });
    });

    test('o cadastro grava o IP do cliente, nao o do proxy nem o forjado', async () => {
      const client = nextClient();
      const body = { nome: 'Pessoa', email: nextEmail(), senha: 'SenhaCorreta@123', termsAccepted: true };

      const res = await viaCloudRun(post(REGISTER, body), client, ['1.1.1.1']);

      expect(res.status).toBe(201);
      expect(mockSavedUsers).toHaveLength(1);
      expect(mockSavedUsers[0].termsAcceptedIp).toBe(client);
    });
  });

  // Sem proxy na frente, o cabecalho e escrito pelo proprio cliente e nao pode valer como identidade.
  describe.each(['development', 'test'])('fora de producao (%s)', (nodeEnv) => {
    beforeAll(() => loadApp({ NODE_ENV: nodeEnv, CORS_ORIGIN: undefined }));
    afterAll(restoreEnv);

    test('nao confia em proxy', () => {
      expect(app.get('trust proxy')).toBe(false);
    });

    test('req.ip e o endereco do socket, com ou sem X-Forwarded-For', async () => {
      const direct = await readIp();

      expect(direct.ip).toMatch(/127\.0\.0\.1$|^::1$/);
      expect(await readIp('203.0.113.10')).toEqual(direct);
      expect(await readIp('203.0.113.10', ['1.1.1.1'])).toEqual(direct);
    });

    test('trocar o X-Forwarded-For nao da tentativas a mais', async () => {
      const email = nextEmail();
      const send = (i) => post(LOGIN, { email, senha: 'SenhaErrada@123' }).set('X-Forwarded-For', `10.6.${i}.1`);

      const allowed = await repeat(10, send);
      allowed.forEach((res) => expect(res.status).toBe(401));

      expectLimited(await send(99));
    });
  });
});
