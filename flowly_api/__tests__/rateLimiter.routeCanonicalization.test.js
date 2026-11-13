const request = require('supertest');

const mockAccount = { _id: '507f1f77bcf86cd799439011', senha: 'hash-guardado', save: jest.fn() };

jest.mock('@google-cloud/storage', () => ({
  Storage: jest.fn().mockImplementation(() => ({
    bucket: jest.fn().mockReturnValue({ file: jest.fn() }),
  })),
}));

jest.mock('../utils/sendEmail', () => jest.fn().mockResolvedValue(true));

jest.mock('argon2', () => ({
  verify: jest.fn(async () => false),
  hash: jest.fn(async () => 'hash'),
}));

jest.mock('../models/User', () => ({
  findOne: jest.fn(async () => null),
  findById: jest.fn(async () => mockAccount),
}));

jest.mock('../models/TwoFactorToken', () => ({
  findOne: jest.fn(async () => null),
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

const argon2 = require('argon2');
const { issueAuthToken } = require('../utils/faceAuth');
const app = require('../app');

const LIMIT_RESPONSE = { erro: 'Muitas tentativas. Aguarde alguns minutos e tente novamente.' };
const LOGIN = '/api/auth/login';
const LOGIN_BODY = { email: 'alvo@exemplo.com', senha: 'SenhaErrada@1' };
const LOGIN_VARIANTS = [
  '/api/auth/LOGIN',
  '/api/auth/Login',
  '/api/AUTH/login',
  '/api/auth/login/',
  '/API/AUTH/LOGIN',
  '/api/AUTH/LOGIN/',
  '/Api/Auth/Login',
];
// Grafias que o Express nao trata como a mesma rota: nao podem chegar a verificar a senha.
const OTHER_SPELLINGS = [
  '/api/auth/%6Cogin',
  '/api/auth/login%2F',
  '/api/auth//login',
  '/api/auth/login//',
  '/api//auth/login',
  '/api/auth/login;x=1',
  '/api/auth/./login',
];

const urlVariants = (url) => [
  url.toUpperCase(),
  url.replace('/auth', '/AUTH'),
  `${url}/`,
  `${url.toUpperCase()}/`,
  url.replace(/\/([a-z])/g, (_match, letter) => `/${letter.toUpperCase()}`),
];

const post = (url, body) => request(app).post(url).send(body);
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

describe('D53: a chave do limiter nao depende da URL recebida', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    buckets.clear();
  });

  describe('login', () => {
    const exhaust = () => repeat(10, () => post(LOGIN, LOGIN_BODY));

    test('a URL normal permite 10 tentativas e bloqueia a seguinte', async () => {
      const results = await exhaust();

      results.forEach((res) => expect(res.status).toBe(401));
      expectLimited(await post(LOGIN, LOGIN_BODY));
      expect(argon2.verify).toHaveBeenCalledTimes(10);
    });

    test.each(LOGIN_VARIANTS)('%s cai no mesmo contador ja bloqueado', async (url) => {
      await exhaust();
      argon2.verify.mockClear();

      expectLimited(await post(url, LOGIN_BODY));

      expect(argon2.verify).not.toHaveBeenCalled();
      expect(buckets.size).toBe(1);
    });

    test('alternar as variantes nao da tentativas a mais', async () => {
      const results = await repeat(10, (i) => post(LOGIN_VARIANTS[i % LOGIN_VARIANTS.length], LOGIN_BODY));

      results.forEach((res) => expect(res.status).toBe(401));
      expect(argon2.verify).toHaveBeenCalledTimes(10);
      expect(buckets.size).toBe(1);
      expectLimited(await post(LOGIN, LOGIN_BODY));
      expect(argon2.verify).toHaveBeenCalledTimes(10);
    });

    test('todas as variantes geram exatamente a mesma chave, sem a grafia recebida', async () => {
      await post(LOGIN, LOGIN_BODY);
      const [key] = buckets.keys();

      for (const url of LOGIN_VARIANTS) {
        await post(url, LOGIN_BODY);
      }

      expect([...buckets.keys()]).toEqual([key]);
      expect(key).toMatch(/^login:\/login:.+:[a-f0-9]{64}$/);
    });

    test.each(['?a=1', '?a=2', '?email=outro@exemplo.com'])('query string %s nao abre contador novo', async (query) => {
      await exhaust();

      expectLimited(await post(`${LOGIN}${query}`, LOGIN_BODY));

      expect(buckets.size).toBe(1);
    });

    test.each(OTHER_SPELLINGS)('%s nao chega a verificar a senha nem abre contador', async (url) => {
      await exhaust();
      argon2.verify.mockClear();

      const res = await post(url, LOGIN_BODY);

      expect([404, 429]).toContain(res.status);
      expect(argon2.verify).not.toHaveBeenCalled();
      expect(buckets.size).toBe(1);
    });
  });

  describe('registro', () => {
    const REGISTER = '/api/auth/registrar';

    test('a URL normal continua permitindo 10', async () => {
      const results = await repeat(10, () => post(REGISTER, {}));

      results.forEach((res) => expect(res.status).toBe(400));
      expectLimited(await post(REGISTER, {}));
    });

    test.each(urlVariants(REGISTER))('%s cai no mesmo contador ja bloqueado', async (url) => {
      await repeat(10, () => post(REGISTER, {}));

      expectLimited(await post(url, {}));

      expect(buckets.size).toBe(1);
    });

    test('alternar as variantes nao da tentativas a mais', async () => {
      const variants = urlVariants(REGISTER);

      const results = await repeat(10, (i) => post(variants[i % variants.length], {}));

      results.forEach((res) => expect(res.status).toBe(400));
      expectLimited(await post(REGISTER, {}));
      expect(buckets.size).toBe(1);
    });
  });

  describe('envio de codigo', () => {
    const body = { email: 'alvo@exemplo.com' };
    const VERIFY_SEND = '/api/auth/2fa/enviar-codigo';
    const RECOVERY_SEND = '/api/auth/recuperar-senha/enviar-codigo';

    describe.each([VERIFY_SEND, RECOVERY_SEND])('%s', (route) => {
      test('a URL normal continua permitindo 5', async () => {
        const results = await repeat(5, () => post(route, body));

        results.forEach((res) => expect(res.status).toBe(200));
        expectLimited(await post(route, body));
      });

      test.each(urlVariants(route))('%s cai no mesmo contador ja bloqueado', async (url) => {
        await repeat(5, () => post(route, body));

        expectLimited(await post(url, body));

        expect(buckets.size).toBe(1);
      });

      test('alternar as variantes nao da envios a mais', async () => {
        const variants = urlVariants(route);

        await repeat(5, (i) => post(variants[i], body));

        expectLimited(await post(route, body));
        expect(buckets.size).toBe(1);
      });
    });

    test('as duas rotas de envio continuam com contadores separados', async () => {
      await repeat(5, () => post(VERIFY_SEND, body));
      expectLimited(await post(VERIFY_SEND, body));

      expect((await post(RECOVERY_SEND, body)).status).toBe(200);
      expect(buckets.size).toBe(2);
    });
  });

  describe('validacao de codigo', () => {
    const code = { email: 'alvo@exemplo.com', codigo: '123456' };
    const ROUTES = [
      ['/api/auth/2fa/validar-codigo', (url) => post(url, code)],
      ['/api/auth/2fa/validar-token', (url) => request(app).get(`${url}?token=${'a'.repeat(64)}`)],
      ['/api/auth/recuperar-senha/validar-codigo', (url) => post(url, code)],
      ['/api/auth/recuperar-senha/redefinir', (url) => post(url, { ...code, novaSenha: 'NovaSenha@456' })],
    ];

    describe.each(ROUTES)('%s', (route, send) => {
      test('a URL normal continua permitindo 10', async () => {
        const results = await repeat(10, () => send(route));

        results.forEach((res) => expect(res.status).toBeLessThan(429));
        expectLimited(await send(route));
      });

      test.each(urlVariants(route))('%s cai no mesmo contador ja bloqueado', async (url) => {
        await repeat(10, () => send(route));

        expectLimited(await send(url));

        expect(buckets.size).toBe(1);
      });
    });

    test('rotas diferentes do mesmo limiter continuam com contadores separados', async () => {
      const [first, ...others] = ROUTES;
      await repeat(10, () => first[1](first[0]));
      expectLimited(await first[1](first[0]));

      for (const [route, send] of others) {
        expect((await send(route)).status).toBeLessThan(429);
      }

      expect(buckets.size).toBe(ROUTES.length);
    });
  });

  describe('a identidade continua importando', () => {
    test('e-mails diferentes seguem isolados, mesmo em variantes da URL', async () => {
      await repeat(10, () => post(LOGIN, { email: 'a@exemplo.com', senha: 'x' }));
      expectLimited(await post('/api/auth/LOGIN', { email: 'a@exemplo.com', senha: 'x' }));

      expect((await post('/api/auth/LOGIN', { email: 'b@exemplo.com', senha: 'x' })).status).toBe(401);
      expect(buckets.size).toBe(2);
    });

    test('e-mails equivalentes caem no mesmo contador em qualquer variante', async () => {
      await post('/api/auth/LOGIN', { email: 'USER@EXEMPLO.COM', senha: 'x' });
      await post('/api/auth/login/', { email: '  user@exemplo.com  ', senha: 'x' });

      expect(buckets.size).toBe(1);
    });

    test('o mesmo e-mail em outro IP segue isolado', async () => {
      app.set('trust proxy', true);

      try {
        await repeat(10, () => post(LOGIN, LOGIN_BODY).set('X-Forwarded-For', '203.0.113.1'));
        expectLimited(await post('/api/auth/LOGIN', LOGIN_BODY).set('X-Forwarded-For', '203.0.113.1'));

        expect((await post('/api/auth/LOGIN', LOGIN_BODY).set('X-Forwarded-For', '203.0.113.2')).status).toBe(401);
      } finally {
        app.set('trust proxy', false);
      }
    });

    test('limiters diferentes nao compartilham contador', async () => {
      await post(LOGIN, LOGIN_BODY);
      await post('/api/auth/registrar', {});
      await post('/api/auth/2fa/enviar-codigo', { email: LOGIN_BODY.email });
      await post('/api/auth/2fa/validar-codigo', { email: LOGIN_BODY.email, codigo: '123456' });

      expect(buckets.size).toBe(4);
    });
  });

  describe('o limiter do D33 nao muda', () => {
    const token = issueAuthToken({ _id: mockAccount._id, tipo: 'user' });
    const changePassword = (url) =>
      request(app)
        .put(url)
        .set('Authorization', `Bearer ${token}`)
        .send({ senhaAtual: 'SenhaErrada@1', novaSenha: 'NovaSenha@456' });
    const enrollProfile = (url) =>
      request(app)
        .post(url)
        .set('Authorization', `Bearer ${token}`)
        .send({ imagesBase64: ['rosto'], senhaAtual: 'SenhaErrada@1' });

    test('variantes das duas rotas gastam o mesmo contador da conta', async () => {
      const calls = [
        () => changePassword('/api/users/me/password'),
        () => enrollProfile('/api/face/enroll-profile'),
        () => changePassword('/api/users/ME/PASSWORD'),
        () => enrollProfile('/api/FACE/ENROLL-PROFILE'),
        () => changePassword('/api/users/me/password/'),
      ];

      const results = await repeat(calls.length, (i) => calls[i]());

      results.forEach((res) => expect(res.status).toBe(400));
      expect(argon2.verify).toHaveBeenCalledTimes(5);
      expect([...buckets.keys()]).toEqual([`current-password:${mockAccount._id}`]);
      expectLimited(await enrollProfile('/api/face/enroll-profile/'));
      expectLimited(await changePassword('/API/USERS/ME/PASSWORD'));
      expect(argon2.verify).toHaveBeenCalledTimes(5);
    });

    test('trocar de IP e de URL nao abre tentativas', async () => {
      app.set('trust proxy', true);

      try {
        await repeat(5, (i) => changePassword('/api/users/me/password').set('X-Forwarded-For', `198.51.100.${i + 1}`));

        expectLimited(await changePassword('/api/USERS/me/password').set('X-Forwarded-For', '203.0.113.9'));
      } finally {
        app.set('trust proxy', false);
      }
    });
  });
});
