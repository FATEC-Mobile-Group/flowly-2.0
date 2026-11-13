const request = require('supertest');

jest.mock('@google-cloud/storage', () => ({
  Storage: jest.fn().mockImplementation(() => ({
    bucket: jest.fn().mockReturnValue({ file: jest.fn() }),
  })),
}));

jest.mock('../utils/sendEmail', () => jest.fn().mockResolvedValue(true));

jest.mock('../models/User', () => ({
  findOne: jest.fn(async () => null),
  findById: jest.fn(async () => null),
}));

const WINDOW_MS = 15 * 60 * 1000;
const LIMIT_RESPONSE = { erro: 'Muitas tentativas. Aguarde alguns minutos e tente novamente.' };
const ONE_MB_EMAIL = `${'x'.repeat(1024 * 1024)}@exemplo.com`;
const MAX_KEY_LENGTH = 200;

// Captura o Map interno sem exportar nada da producao e conta as entradas visitadas nas varreduras.
const load = ({ withApp = false } = {}) => {
  const loaded = {};

  jest.isolateModules(() => {
    const RealMap = global.Map;
    global.Map = class CountingMap extends RealMap {
      constructor(...args) {
        super(...args);
        this.visits = 0;
        loaded.buckets = this;
      }

      *[Symbol.iterator]() {
        for (const entry of super[Symbol.iterator]()) {
          this.visits += 1;
          yield entry;
        }
      }

      *entries() {
        for (const entry of super.entries()) {
          this.visits += 1;
          yield entry;
        }
      }

      forEach(callback, thisArg) {
        super.forEach((...args) => {
          this.visits += 1;
          callback.apply(thisArg, args);
        });
      }
    };

    try {
      loaded.limiters = require('../middlewares/rateLimiters');
    } finally {
      global.Map = RealMap;
    }

    if (withApp) {
      loaded.app = require('../app');
    }
  });

  return loaded;
};

const call = (limiter, { ip = '203.0.113.1', baseUrl = '/api/auth', path = '/login', email, body, user } = {}) => {
  const res = {
    headers: {},
    statusCode: 200,
    body: undefined,
    passed: false,
    set(name, value) {
      this.headers[name] = value;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
  limiter({ ip, baseUrl, path, route: { path }, user, body: body ?? (email === undefined ? {} : { email }) }, res, () => {
    res.passed = true;
  });
  return res;
};

const repeat = (times, action) => Array.from({ length: times }, (_item, index) => action(index));

const expectLimited = (res) => {
  expect(res.passed).toBe(false);
  expect(res.statusCode).toBe(429);
  expect(res.body).toEqual(LIMIT_RESPONSE);
};

describe('D50: buckets do rate limiter', () => {
  describe('rotas publicas, por HTTP', () => {
    let app;
    let buckets;

    beforeAll(() => {
      ({ app, buckets } = load({ withApp: true }));
    });

    beforeEach(() => {
      buckets.clear();
    });

    test.each([
      ['login', () => request(app).post('/api/auth/login').send({ email: ONE_MB_EMAIL, senha: 'qualquer' })],
      ['2fa/enviar-codigo', () => request(app).post('/api/auth/2fa/enviar-codigo').send({ email: ONE_MB_EMAIL })],
      ['recuperar-senha/enviar-codigo', () => request(app).post('/api/auth/recuperar-senha/enviar-codigo').send({ email: ONE_MB_EMAIL })],
      ['recuperar-senha/validar-codigo', () => request(app).post('/api/auth/recuperar-senha/validar-codigo').send({ email: ONE_MB_EMAIL, codigo: '123456' })],
    ])('%s: um e-mail de 1 MB nao vira uma chave de 1 MB', async (_route, send) => {
      const res = await send();

      expect(res.status).toBeLessThan(500);
      expect(buckets.size).toBe(1);
      const [key] = buckets.keys();
      expect(key.length).toBeLessThanOrEqual(MAX_KEY_LENGTH);
      expect(key).not.toContain('xxxxxxxxxx');
    });
  });

  describe('chamando os limiters', () => {
    let limiters;
    let buckets;
    let clock;

    beforeEach(() => {
      ({ limiters, buckets } = load());
      clock = 1_800_000_000_000;
      jest.spyOn(Date, 'now').mockImplementation(() => clock);
    });

    afterEach(() => {
      jest.restoreAllMocks();
    });

    const EMAIL_LIMITERS = [
      ['loginLimiter', 10],
      ['emailCodeLimiter', 5],
      ['codeValidationLimiter', 10],
    ];
    const keys = () => [...buckets.keys()];

    describe('A: a chave tem tamanho limitado', () => {
      test.each(EMAIL_LIMITERS)('%s: o e-mail enorme nao fica na chave', (name) => {
        call(limiters[name], { email: ONE_MB_EMAIL });

        expect(buckets.size).toBe(1);
        expect(keys()[0].length).toBeLessThanOrEqual(MAX_KEY_LENGTH);
        expect(keys()[0]).not.toContain('xxxxxxxxxx');
      });

      test('nada do e-mail enorme fica guardado, nem na chave nem no valor do bucket', () => {
        call(limiters.loginLimiter, { email: ONE_MB_EMAIL });

        expect(JSON.stringify([...buckets]).length).toBeLessThanOrEqual(MAX_KEY_LENGTH);
      });

      test('e-mail curto e e-mail enorme geram chaves do mesmo tamanho', () => {
        call(limiters.loginLimiter, { email: 'a@b.c' });
        call(limiters.loginLimiter, { email: ONE_MB_EMAIL });

        const [short, huge] = keys();
        expect(short.length).toBe(huge.length);
      });

      test('o e-mail em claro nao fica guardado na chave', () => {
        call(limiters.loginLimiter, { email: 'usuario@exemplo.com' });

        expect(keys()[0]).not.toContain('usuario');
        expect(keys()[0]).not.toContain('exemplo.com');
      });

      test('a chave mantem rota e IP, com o e-mail reduzido a um digest', () => {
        call(limiters.loginLimiter, { email: 'usuario@exemplo.com' });

        expect(keys()[0]).toMatch(/^login:\/login:203\.0\.113\.1:[a-f0-9]{64}$/);
      });

      test.each([
        ['objeto com operador', { $gt: 'x'.repeat(1024 * 1024) }],
        ['lista', ['x'.repeat(1024 * 1024)]],
        ['numero', 123],
        ['nulo', null],
      ])('%s no lugar do e-mail: sem erro, no bucket dos pedidos sem e-mail', (_label, email) => {
        const semEmail = call(limiters.loginLimiter, { email: undefined });
        const res = call(limiters.loginLimiter, { body: { email } });

        expect(semEmail.passed).toBe(true);
        expect(res.passed).toBe(true);
        expect(buckets.size).toBe(1);
        expect(keys()[0].length).toBeLessThanOrEqual(MAX_KEY_LENGTH);
      });
    });

    describe('B: normalizacao e isolamento continuam iguais', () => {
      test('maiusculas e espacos caem no mesmo contador', () => {
        repeat(10, (i) => call(limiters.loginLimiter, { email: i % 2 ? 'USER@EXEMPLO.COM' : '  user@exemplo.com  ' }));

        expect(buckets.size).toBe(1);
        expectLimited(call(limiters.loginLimiter, { email: 'User@Exemplo.com' }));
      });

      test('e-mails diferentes nao compartilham contador', () => {
        repeat(11, () => call(limiters.loginLimiter, { email: 'user1@exemplo.com' }));

        expect(call(limiters.loginLimiter, { email: 'user2@exemplo.com' }).passed).toBe(true);
        expect(buckets.size).toBe(2);
      });

      test('e-mails enormes que diferem so no fim nao compartilham contador', () => {
        repeat(11, () => call(limiters.loginLimiter, { email: `${ONE_MB_EMAIL}1` }));

        expect(call(limiters.loginLimiter, { email: `${ONE_MB_EMAIL}2` }).passed).toBe(true);
      });

      test('nao ha canonicalizacao especifica de provedor', () => {
        ['user.name@gmail.com', 'username@gmail.com', 'username+1@gmail.com'].forEach((email) =>
          call(limiters.loginLimiter, { email })
        );

        expect(buckets.size).toBe(3);
      });

      test('o mesmo e-mail em outro IP tem outro contador', () => {
        repeat(11, () => call(limiters.loginLimiter, { email: 'user@exemplo.com', ip: '203.0.113.1' }));

        expect(call(limiters.loginLimiter, { email: 'user@exemplo.com', ip: '203.0.113.2' }).passed).toBe(true);
      });

      test('o mesmo e-mail em outra rota tem outro contador', () => {
        repeat(11, () => call(limiters.codeValidationLimiter, { email: 'user@exemplo.com', path: '/2fa/validar-codigo' }));

        expect(call(limiters.codeValidationLimiter, { email: 'user@exemplo.com', path: '/recuperar-senha/redefinir' }).passed).toBe(true);
      });
    });

    describe('C: os limites nao mudam', () => {
      test.each([
        ['loginLimiter', 10],
        ['registerLimiter', 10],
        ['emailCodeLimiter', 5],
        ['codeValidationLimiter', 10],
        ['sensitivePasswordActionLimiter', 5],
      ])('%s permite %i requisicoes e barra a seguinte', (name, max) => {
        const context = { email: 'user@exemplo.com', user: { id: 'usuario-1' } };

        const results = repeat(max, () => call(limiters[name], context));

        results.forEach((res) => expect(res.passed).toBe(true));
        expect(results[0].headers['RateLimit-Limit']).toBe(String(max));
        expect(results[max - 1].headers['RateLimit-Remaining']).toBe('0');
        expectLimited(call(limiters[name], context));
      });
    });

    describe('D: entradas expiradas saem do Map', () => {
      test('na requisicao seguinte depois da janela, mesmo de outra identidade', () => {
        call(limiters.loginLimiter, { email: 'a@exemplo.com' });
        call(limiters.loginLimiter, { email: 'b@exemplo.com' });
        expect(buckets.size).toBe(2);

        clock += WINDOW_MS + 1;
        call(limiters.loginLimiter, { email: 'c@exemplo.com' });

        expect(buckets.size).toBe(1);
      });

      test('a requisicao de um limiter limpa entradas expiradas dos outros', () => {
        call(limiters.loginLimiter, { email: 'a@exemplo.com' });
        call(limiters.emailCodeLimiter, { email: 'a@exemplo.com', path: '/2fa/enviar-codigo' });
        call(limiters.sensitivePasswordActionLimiter, { user: { id: 'usuario-1' } });

        clock += WINDOW_MS + 1;
        call(limiters.registerLimiter, { path: '/registrar' });

        expect(buckets.size).toBe(1);
      });

      test('no instante exato do fim da janela a entrada ja expirou', () => {
        repeat(11, () => call(limiters.loginLimiter, { email: 'a@exemplo.com' }));

        clock += WINDOW_MS;
        const res = call(limiters.loginLimiter, { email: 'a@exemplo.com' });

        expect(res.passed).toBe(true);
        expect(buckets.size).toBe(1);
      });

      test('um instante antes do fim da janela a entrada continua e o bloqueio tambem', () => {
        repeat(10, () => call(limiters.loginLimiter, { email: 'a@exemplo.com' }));

        clock += WINDOW_MS - 1;
        call(limiters.loginLimiter, { email: 'b@exemplo.com' });

        expect(buckets.size).toBe(2);
        expectLimited(call(limiters.loginLimiter, { email: 'a@exemplo.com' }));
      });

      test('so as expiradas saem: quem ainda esta na janela mantem o contador', () => {
        call(limiters.loginLimiter, { email: 'antigo@exemplo.com' });
        clock += 10 * 60 * 1000;
        repeat(10, () => call(limiters.loginLimiter, { email: 'recente@exemplo.com' }));

        clock += 5 * 60 * 1000 + 1;
        const blocked = call(limiters.loginLimiter, { email: 'recente@exemplo.com' });

        expectLimited(blocked);
        expect(buckets.size).toBe(1);
      });

      test('reutilizar a chave apos expirar nao atrasa a limpeza de quem vem depois', () => {
        call(limiters.loginLimiter, { email: 'a@exemplo.com' });
        clock += 1000;
        call(limiters.loginLimiter, { email: 'b@exemplo.com' });

        clock += WINDOW_MS;
        call(limiters.loginLimiter, { email: 'a@exemplo.com' });
        expect(buckets.size).toBe(1);

        clock += WINDOW_MS + 1;
        call(limiters.loginLimiter, { email: 'b@exemplo.com' });
        expect(buckets.size).toBe(1);
      });
    });

    describe('E: contador novo depois da janela', () => {
      test.each(EMAIL_LIMITERS)('%s: remaining e reset recomecam', (name, max) => {
        const context = { email: 'user@exemplo.com' };
        repeat(max + 1, () => call(limiters[name], context));

        clock += WINDOW_MS + 1;
        const first = call(limiters[name], context);
        const second = call(limiters[name], context);

        expect(first.passed).toBe(true);
        expect(first.headers['RateLimit-Remaining']).toBe(String(max - 1));
        expect(second.headers['RateLimit-Remaining']).toBe(String(max - 2));
        expect(second.headers['RateLimit-Reset']).toBe(String(Math.ceil((clock + WINDOW_MS) / 1000)));
      });

      test('o contador novo volta a bloquear no limite', () => {
        const context = { email: 'user@exemplo.com' };
        repeat(11, () => call(limiters.loginLimiter, context));

        clock += WINDOW_MS + 1;
        const results = repeat(10, () => call(limiters.loginLimiter, context));

        results.forEach((res) => expect(res.passed).toBe(true));
        expectLimited(call(limiters.loginLimiter, context));
      });
    });

    describe('F: o Map nao cresce sem parar', () => {
      test('2.000 identidades somem depois da janela', () => {
        repeat(2000, (i) => call(limiters.loginLimiter, { email: `pessoa${i}@exemplo.com` }));
        expect(buckets.size).toBe(2000);

        clock += WINDOW_MS + 1;
        call(limiters.loginLimiter, { email: 'nova@exemplo.com' });

        expect(buckets.size).toBe(1);
      });

      test('janelas seguidas nao acumulam entradas', () => {
        const sizes = repeat(5, (round) => {
          repeat(500, (i) => call(limiters.loginLimiter, { email: `r${round}p${i}@exemplo.com` }));
          const size = buckets.size;
          clock += WINDOW_MS + 1;
          return size;
        });

        sizes.forEach((size) => expect(size).toBe(500));
      });

      test('o trafego espalhado na janela mantem so quem ainda esta nela', () => {
        repeat(30, (minute) => {
          call(limiters.loginLimiter, { email: `minuto${minute}@exemplo.com` });
          clock += 60 * 1000;
        });

        expect(buckets.size).toBeLessThanOrEqual(15);
      });
    });

    describe('G: a limpeza nao percorre o Map inteiro a cada requisicao', () => {
      test('com 1.000 entradas validas, uma requisicao visita no maximo uma', () => {
        repeat(1000, (i) => call(limiters.loginLimiter, { email: `pessoa${i}@exemplo.com` }));
        buckets.visits = 0;

        call(limiters.loginLimiter, { email: 'nova@exemplo.com' });

        expect(buckets.visits).toBeLessThanOrEqual(1);
      });

      test('depois de limpar, a requisicao seguinte volta a visitar no maximo uma', () => {
        repeat(1000, (i) => call(limiters.loginLimiter, { email: `pessoa${i}@exemplo.com` }));
        clock += WINDOW_MS + 1;
        call(limiters.loginLimiter, { email: 'a@exemplo.com' });
        buckets.visits = 0;

        call(limiters.loginLimiter, { email: 'b@exemplo.com' });

        expect(buckets.size).toBe(2);
        expect(buckets.visits).toBeLessThanOrEqual(1);
      });
    });

    describe('H: nenhum timer', () => {
      test('carregar e usar os limiters nao agenda nada', () => {
        const timers = [
          jest.spyOn(global, 'setTimeout'),
          jest.spyOn(global, 'setInterval'),
          jest.spyOn(global, 'setImmediate'),
        ];

        const fresh = load();
        repeat(20, (i) => call(fresh.limiters.loginLimiter, { email: `p${i}@exemplo.com` }));
        clock += WINDOW_MS + 1;
        call(fresh.limiters.loginLimiter, { email: 'nova@exemplo.com' });

        expect(fresh.buckets.size).toBe(1);
        timers.forEach((spy) => expect(spy).not.toHaveBeenCalled());
      });
    });

    describe('I: o limiter do D33 nao muda', () => {
      const passwordRoute = { baseUrl: '/api/users', path: '/me/password' };
      const faceRoute = { baseUrl: '/api/face', path: '/enroll-profile' };
      const user = { id: 'usuario-a' };

      test('as duas rotas compartilham o contador da conta', () => {
        repeat(5, (i) =>
          call(limiters.sensitivePasswordActionLimiter, { ...(i % 2 ? faceRoute : passwordRoute), user })
        );

        expect(buckets.size).toBe(1);
        expectLimited(call(limiters.sensitivePasswordActionLimiter, { ...passwordRoute, user }));
        expectLimited(call(limiters.sensitivePasswordActionLimiter, { ...faceRoute, user }));
      });

      test('trocar de IP nao abre novas tentativas', () => {
        repeat(5, (i) =>
          call(limiters.sensitivePasswordActionLimiter, { ...passwordRoute, user, ip: `198.51.100.${i + 1}` })
        );

        expectLimited(call(limiters.sensitivePasswordActionLimiter, { ...passwordRoute, user, ip: '203.0.113.99' }));
      });

      test('outra conta tem outro contador', () => {
        repeat(6, () => call(limiters.sensitivePasswordActionLimiter, { ...passwordRoute, user }));

        expect(
          call(limiters.sensitivePasswordActionLimiter, { ...passwordRoute, user: { id: 'usuario-b' } }).passed
        ).toBe(true);
      });

      test('o corpo da requisicao nao entra na chave', () => {
        const body = { email: ONE_MB_EMAIL, senhaAtual: 'SenhaSecreta@1', novaSenha: 'y'.repeat(1024 * 1024) };

        call(limiters.sensitivePasswordActionLimiter, { ...passwordRoute, user, body });

        expect(keys()[0]).toBe('current-password:usuario-a');
      });

      test('a entrada expira e o contador recomeca', () => {
        repeat(6, () => call(limiters.sensitivePasswordActionLimiter, { ...passwordRoute, user }));

        clock += WINDOW_MS + 1;
        const res = call(limiters.sensitivePasswordActionLimiter, { ...faceRoute, user });

        expect(res.passed).toBe(true);
        expect(res.headers['RateLimit-Remaining']).toBe('4');
        expect(buckets.size).toBe(1);
      });
    });
  });
});
