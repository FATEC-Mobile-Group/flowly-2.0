const request = require('supertest');
const argon2 = require('argon2');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');

const mockDb = { users: [], faces: [] };
const mockHooks = { save: null };

jest.mock('@google-cloud/storage', () => ({
  Storage: jest.fn().mockImplementation(() => ({
    bucket: jest.fn().mockReturnValue({ file: jest.fn() }),
  })),
}));

jest.mock('../utils/sendEmail', () => jest.fn().mockResolvedValue(true));

// O limite de tentativas tem testes proprios (D33, D50, D53): aqui so a entrada importa.
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

jest.mock('../models/User', () => {
  const { ObjectId } = jest.requireActual('mongoose').Types;
  function User(data) {
    Object.assign(this, { _id: new ObjectId(), tipo: 'user', verificado: false, fotoPerfil: '', ...data });
    this.save = jest.fn(async () => (mockHooks.save ? mockHooks.save(this) : mockDb.users.push(this)));
  }
  User.findOne = jest.fn(async ({ email }) => mockDb.users.find((user) => user.email === email) || null);
  User.findById = jest.fn(async (id) => mockDb.users.find((user) => String(user._id) === String(id)) || null);
  return User;
});

jest.mock('../models/FaceProfile', () => ({
  findOne: jest.fn(async ({ userId }) => mockDb.faces.find((face) => String(face.userId) === String(userId)) || null),
}));

jest.mock('../models/TwoFactorToken', () => {
  function Token(data) {
    Object.assign(this, data);
  }
  Token.prototype.save = jest.fn(async function save() {
    return this;
  });
  Token.findOne = jest.fn(async () => null);
  Token.deleteMany = jest.fn(async () => ({}));
  Token.updateOne = jest.fn(async () => ({}));
  Token.deleteOne = jest.fn(async () => ({}));
  return Token;
});

const sendEmail = require('../utils/sendEmail');
const User = require('../models/User');
const TwoFactorToken = require('../models/TwoFactorToken');
const config = require('../config/config');
const { issueAuthToken, verifyAuthToken } = require('../utils/faceAuth');
const app = require('../app');

const PASSWORD = 'SenhaOriginal@1';
const NEW_PASSWORD = 'NovaSenha@456';
const INTERNAL = 'connect ECONNREFUSED 10.0.0.5:27017 /app/segredo/main.js';
const SECRET_IN_BODY = 'SenhaSecreta@77';
const LEAK_PATTERN = /Cannot (destructure|read)|TypeError|ECONNREFUSED|10\.0\.0\.5|27017|\/app\/|segredo|E11000|Flowly\.users|dup key|validation failed|Cast to|Unexpected (token|end)|not valid JSON|position \d|SenhaSecre|vitima|\bat .+:\d+/;
const INVALID_JSON = { success: false, error: 'JSON inválido.' };
const LOGIN_REQUIRED = { erro: 'E-mail e senha sao obrigatorios.' };
const REGISTER_REQUIRED = { erro: 'Nome e obrigatorio.' };
const PASSWORD_REQUIRED = { erro: 'Senha atual e nova senha sao obrigatorias' };
const NOT_TEXT = [
  ['objeto com operador', { $gt: '' }],
  ['lista', ['a']],
  ['numero', 123],
  ['booleano', true],
];

describe('D34 parte 2: entradas invalidas e erros internos em login, cadastro e troca de senha', () => {
  let passwordHash;
  let verifySpy;
  let hashSpy;
  let errorSpy;
  let account;

  beforeAll(async () => {
    passwordHash = await argon2.hash(PASSWORD, { memoryCost: 1024, timeCost: 2, parallelism: 1 });
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockDb.users = [];
    mockDb.faces = [];
    mockHooks.save = null;
    verifySpy = jest.spyOn(argon2, 'verify');
    hashSpy = jest.spyOn(argon2, 'hash');
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    account = new User({
      nome: 'Conta',
      email: 'conta@exemplo.com',
      senha: passwordHash,
      verificado: true,
      faceEnrollmentOffered: true,
      faceEnrollmentSkipped: true,
    });
    mockDb.users.push(account);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  const bearer = () => `Bearer ${issueAuthToken(account)}`;
  const login = () => request(app).post('/api/auth/login');
  const register = () => request(app).post('/api/auth/registrar');
  const changePassword = () => request(app).put('/api/users/me/password').set('Authorization', bearer());
  const validRegistration = (data = {}) => ({
    nome: 'Pessoa Nova',
    email: 'nova@exemplo.com',
    senha: PASSWORD,
    termsAccepted: true,
    termsVersion: '2026-06-08',
    ...data,
  });

  const expectNoWork = () => {
    expect(User.findOne).not.toHaveBeenCalled();
    expect(User.findById).not.toHaveBeenCalled();
    expect(verifySpy).not.toHaveBeenCalled();
    expect(hashSpy).not.toHaveBeenCalled();
    expect(sendEmail).not.toHaveBeenCalled();
    expect(TwoFactorToken.findOne).not.toHaveBeenCalled();
    expect(TwoFactorToken.prototype.save).not.toHaveBeenCalled();
    expect(account.save).not.toHaveBeenCalled();
    expect(account.senha).toBe(passwordHash);
  };

  const expectNoLeak = (res) => {
    expect(JSON.stringify(res.body)).not.toMatch(LEAK_PATTERN);
    expect(res.body.detalhe).toBeUndefined();
    expect(res.body.stack).toBeUndefined();
    expect(res.body.token).toBeUndefined();
  };

  const ROUTES = [
    ['POST /api/auth/login', login, LOGIN_REQUIRED],
    ['POST /api/auth/registrar', register, REGISTER_REQUIRED],
    ['PUT /api/users/me/password', changePassword, PASSWORD_REQUIRED],
  ];

  describe.each(ROUTES)('corpo invalido em %s', (_name, call, required) => {
    test.each([
      ['sem corpo', (r) => r],
      ['texto puro', (r) => r.set('Content-Type', 'text/plain').send('abc')],
      ['formato desconhecido', (r) => r.set('Content-Type', 'application/xml').send('<a/>')],
      ['formulario vazio', (r) => r.set('Content-Type', 'application/x-www-form-urlencoded').send('')],
      ['lista vazia', (r) => r.send([])],
      ['lista com itens', (r) => r.send(['conta@exemplo.com', PASSWORD])],
      ['objeto vazio', (r) => r.send({})],
    ])('%s responde 400 com a mensagem do campo obrigatorio', async (_label, build) => {
      const res = await build(call());

      expect(res.status).toBe(400);
      expect(res.body).toEqual(required);
      expectNoWork();
    });

    test.each([
      ['null', 'null'],
      ['texto', '"abc"'],
      ['numero', '123'],
      ['booleano', 'true'],
      ['so a chave de abertura', '{'],
      ['com a senha no meio', `{"email":"vitima@exemplo.com","senha":${SECRET_IN_BODY}}`],
    ])('JSON %s responde 400 generico, sem trecho do corpo nem mensagem do parser', async (_label, raw) => {
      const res = await call().set('Content-Type', 'application/json').send(raw);

      expect(res.status).toBe(400);
      expect(res.body).toEqual(INVALID_JSON);
      expectNoLeak(res);
      expectNoWork();
    });
  });

  describe('o corpo de um JSON quebrado nao vai para o log', () => {
    test('a senha enviada nao aparece em nenhum log', async () => {
      const logs = ['log', 'info', 'warn', 'error'].map((level) => jest.spyOn(console, level).mockImplementation(() => {}));

      await login().set('Content-Type', 'application/json').send(`{"email":"vitima@exemplo.com","senha":${SECRET_IN_BODY}}`);

      const logged = JSON.stringify(logs.flatMap((spy) => spy.mock.calls), (_key, value) =>
        value instanceof Error ? { ...value, message: value.message } : value
      );
      expect(logged).not.toContain('SenhaSecre');
      expect(logged).not.toContain('vitima');
    });
  });

  describe('login', () => {
    test.each(NOT_TEXT)('e-mail %s: 400 sem consultar o banco', async (_label, email) => {
      const res = await login().send({ email, senha: PASSWORD });

      expect(res.status).toBe(400);
      expect(res.body).toEqual(LOGIN_REQUIRED);
      expectNoWork();
    });

    test.each(NOT_TEXT)('senha %s: 400 sem consultar o banco', async (_label, senha) => {
      const res = await login().send({ email: account.email, senha });

      expect(res.status).toBe(400);
      expect(res.body).toEqual(LOGIN_REQUIRED);
      expectNoWork();
    });

    test('falha do banco: 500 generico, causa so no log', async () => {
      User.findOne.mockRejectedValueOnce(new Error(INTERNAL));

      const res = await login().send({ email: account.email, senha: PASSWORD });

      expect(res.status).toBe(500);
      expect(res.body).toEqual({ erro: 'Erro no login' });
      expectNoLeak(res);
      expect(JSON.stringify(errorSpy.mock.calls.map(([, err]) => err?.message))).toContain('ECONNREFUSED');
    });

    test('falha ao verificar a senha: 500 generico', async () => {
      verifySpy.mockRejectedValueOnce(new Error(INTERNAL));

      const res = await login().send({ email: account.email, senha: PASSWORD });

      expect(res.status).toBe(500);
      expect(res.body).toEqual({ erro: 'Erro no login' });
    });

    describe('o que nao muda', () => {
      test('senha correta entrega o JWT, com o e-mail normalizado', async () => {
        const res = await login().send({ email: '  CONTA@Exemplo.COM ', senha: PASSWORD });

        expect(res.status).toBe(200);
        expect(String(verifyAuthToken(res.body.token).id)).toBe(String(account._id));
        expect(User.findOne).toHaveBeenCalledWith({ email: 'conta@exemplo.com' });
      });

      test('senha errada continua 401 generico', async () => {
        const res = await login().send({ email: account.email, senha: 'SenhaErrada@1' });

        expect(res.status).toBe(401);
        expect(res.body).toEqual({ erro: 'Credenciais inválidas' });
      });

      test('conta inexistente continua 401 e ainda verifica um hash ficticio', async () => {
        const res = await login().send({ email: 'ninguem@exemplo.com', senha: PASSWORD });

        expect(res.status).toBe(401);
        expect(res.body).toEqual({ erro: 'Credenciais inválidas' });
        expect(verifySpy).toHaveBeenCalledTimes(1);
      });

      test('conta nao verificada continua 403', async () => {
        account.verificado = false;

        const res = await login().send({ email: account.email, senha: PASSWORD });

        expect(res.status).toBe(403);
        expect(res.body.token).toBeUndefined();
      });

      test('conta com rosto continua exigindo o rosto', async () => {
        mockDb.faces.push({ userId: account._id, enrolled: true });

        const res = await login().send({ email: account.email, senha: PASSWORD });

        expect(res.status).toBe(200);
        expect(res.body.requiresFaceVerification).toBe(true);
        expect(res.body.token).toBeUndefined();
      });
    });
  });

  describe('cadastro', () => {
    test.each(NOT_TEXT)('termsVersion %s: 400 antes do Argon2 e do banco', async (_label, termsVersion) => {
      const res = await register().send(validRegistration({ termsVersion }));

      expect(res.status).toBe(400);
      expect(res.body).toEqual({ erro: 'Versão dos termos inválida.' });
      expect(hashSpy).not.toHaveBeenCalled();
      expect(mockDb.users).toHaveLength(1);
    });

    test.each([
      ['ausente', undefined],
      ['nula', null],
      ['vazia', ''],
    ])('termsVersion %s continua usando a versao atual', async (_label, termsVersion) => {
      const res = await register().send(validRegistration({ termsVersion }));

      expect(res.status).toBe(201);
      expect(mockDb.users[1].termsVersion).toBe('2026-06-08');
    });

    test.each([
      ['nome', { nome: { $gt: '' } }, 'Nome e obrigatorio.'],
      ['e-mail', { email: ['a@exemplo.com'] }, 'E-mail e obrigatorio.'],
      ['senha', { senha: { a: 1 } }, 'A senha é obrigatória e deve ser informada como texto.'],
      ['aceite dos termos', { termsAccepted: 'true' }, 'Para criar a conta, leia e aceite os Termos de Uso e a Política de Privacidade.'],
    ])('%s com tipo errado continua 400 sem trabalho', async (_label, data, message) => {
      const res = await register().send(validRegistration(data));

      expect(res.status).toBe(400);
      expect(res.body).toEqual({ erro: message });
      expectNoWork();
    });

    test('e-mail ja cadastrado: continua 400, sem a mensagem do banco', async () => {
      mockHooks.save = async () => {
        throw Object.assign(
          new Error('E11000 duplicate key error collection: Flowly.users index: email_1 dup key: { email: "conta@exemplo.com" }'),
          { code: 11000 }
        );
      };

      const res = await register().send(validRegistration({ email: account.email }));

      expect(res.status).toBe(400);
      expect(res.body).toEqual({ erro: 'Erro ao registrar' });
      expectNoLeak(res);
    });

    test('dado recusado pelo modelo: continua 400, sem a mensagem do Mongoose', async () => {
      mockHooks.save = async () => {
        const err = new mongoose.Error.ValidationError();
        err.message = 'User validation failed: nome: Cast to string failed at path "nome"';
        throw err;
      };

      const res = await register().send(validRegistration());

      expect(res.status).toBe(400);
      expect(res.body).toEqual({ erro: 'Erro ao registrar' });
      expectNoLeak(res);
    });

    test('falha do banco: 500 generico, nao 400', async () => {
      mockHooks.save = async () => {
        throw new Error(INTERNAL);
      };

      const res = await register().send(validRegistration());

      expect(res.status).toBe(500);
      expect(res.body).toEqual({ erro: 'Erro ao registrar' });
      expectNoLeak(res);
      expect(JSON.stringify(errorSpy.mock.calls.map(([, err]) => err?.message))).toContain('ECONNREFUSED');
    });

    test('cadastro valido continua 201, sempre como usuario comum', async () => {
      const res = await register().send(validRegistration({ tipo: 'admin', email: '  Nova@Exemplo.com ' }));

      expect(res.status).toBe(201);
      expect(mockDb.users[1].tipo).toBe('user');
      expect(mockDb.users[1].email).toBe('nova@exemplo.com');
    });
  });

  describe('troca de senha', () => {
    test.each(NOT_TEXT)('senha atual %s: 400 sem verificar a senha', async (_label, senhaAtual) => {
      const res = await changePassword().send({ senhaAtual, novaSenha: NEW_PASSWORD });

      expect(res.status).toBe(400);
      expect(res.body).toEqual(PASSWORD_REQUIRED);
      expectNoWork();
    });

    test.each(NOT_TEXT)('nova senha %s: 400 sem verificar a senha', async (_label, novaSenha) => {
      const res = await changePassword().send({ senhaAtual: PASSWORD, novaSenha });

      expect(res.status).toBe(400);
      expect(res.body).toEqual({ erro: 'A senha é obrigatória e deve ser informada como texto.' });
      expectNoWork();
    });

    test('falha do banco continua 500 generico', async () => {
      User.findById.mockRejectedValueOnce(new Error(INTERNAL));

      const res = await changePassword().send({ senhaAtual: PASSWORD, novaSenha: NEW_PASSWORD });

      expect(res.status).toBe(500);
      expect(res.body).toEqual({ erro: 'Erro ao atualizar senha' });
    });

    test('sem JWT continua 401, mesmo sem corpo', async () => {
      const res = await request(app).put('/api/users/me/password');

      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
    });

    test('JWT expirado continua 401', async () => {
      const expired = jwt.sign({ id: account._id, tipo: 'user', tokenType: 'access' }, config.jwt.secret, {
        issuer: config.jwt.issuer,
        audience: config.jwt.accessAudience,
        expiresIn: -10,
      });

      const res = await request(app).put('/api/users/me/password').set('Authorization', `Bearer ${expired}`).send({});

      expect(res.status).toBe(401);
    });

    test('senha atual errada continua 400, sem encerrar a sessao', async () => {
      const res = await changePassword().send({ senhaAtual: 'SenhaErrada@1', novaSenha: NEW_PASSWORD });

      expect(res.status).toBe(400);
      expect(res.body).toEqual({ erro: 'Senha atual invalida' });
    });

    test('senha atual correta continua trocando a senha', async () => {
      const res = await changePassword().send({ senhaAtual: PASSWORD, novaSenha: NEW_PASSWORD });

      expect(res.status).toBe(200);
      expect(account.save).toHaveBeenCalledTimes(1);
      expect(account.senha).not.toBe(passwordHash);
    });
  });

  describe('outros erros do parser nao mudam', () => {
    test('corpo acima do limite continua 413', async () => {
      const res = await login()
        .set('Content-Type', 'application/json')
        .send(JSON.stringify({ email: 'a'.repeat(16 * 1024 * 1024) }));

      expect(res.status).toBe(413);
      expectNoLeak(res);
    });
  });
});
