const crypto = require('crypto');
const request = require('supertest');

const mockDb = { users: [], tokens: [] };

jest.mock('@google-cloud/storage', () => ({
  Storage: jest.fn().mockImplementation(() => ({
    bucket: jest.fn().mockReturnValue({ file: jest.fn() }),
  })),
}));

jest.mock('../utils/sendEmail', () => jest.fn().mockResolvedValue(true));

// O limite de tentativas tem testes proprios (D50, D53): aqui so a entrada importa.
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

jest.mock('argon2', () => ({
  hash: jest.fn(async () => 'hash-novo'),
  verify: jest.fn(async () => false),
}));

jest.mock('../models/User', () => ({
  findOne: jest.fn(async ({ email }) => mockDb.users.find((user) => user.email === email) || null),
  findById: jest.fn(async (id) => mockDb.users.find((user) => String(user._id) === String(id)) || null),
}));

jest.mock('../models/TwoFactorToken', () => {
  function Token(data) {
    Object.assign(this, { validado: false, tentativas: 0, ...data });
  }
  Token.prototype.save = jest.fn(async function save() {
    if (!mockDb.tokens.includes(this)) mockDb.tokens.push(this);
    return this;
  });
  const matches = (record, filter) =>
    Object.entries(filter).every(([key, expected]) =>
      expected && Array.isArray(expected.$in)
        ? expected.$in.some((item) => (item === null ? record[key] == null : item === record[key]))
        : String(record[key]) === String(expected)
    );
  Token.findOne = jest.fn(async (filter) => mockDb.tokens.find((record) => matches(record, filter)) || null);
  Token.deleteMany = jest.fn(async () => ({}));
  Token.updateOne = jest.fn(async () => ({}));
  Token.deleteOne = jest.fn(async () => ({}));
  return Token;
});

const argon2 = require('argon2');
const sendEmail = require('../utils/sendEmail');
const User = require('../models/User');
const TwoFactorToken = require('../models/TwoFactorToken');
const app = require('../app');

const USER_ID = '507f1f77bcf86cd799439011';
const EMAIL = 'conta@exemplo.com';
const CODE = '123456';
const LINK = 'a'.repeat(64);
const NEW_PASSWORD = 'NovaSenha@456';
const INTERNAL = 'connect ECONNREFUSED 10.0.0.5:27017 /app/segredo/main.js';
const LEAK_PATTERN = /Cannot (destructure|read)|TypeError|ECONNREFUSED|10\.0\.0\.5|27017|\/app\/|segredo|Unexpected (token|end)|not valid JSON|position \d|SenhaSecre|vitima|\bat .+:\d+/;
const INVALID_JSON = { success: false, error: 'JSON inválido.' };
const GENERIC_SEND = { message: 'Se o email estiver cadastrado, um codigo sera enviado.' };
const INVALID_VERIFICATION = { message: 'Codigo de verificacao invalido ou expirado.' };
const INVALID_RESET = { message: 'Codigo de recuperacao invalido ou expirado.' };
const sha256 = (value) => crypto.createHash('sha256').update(String(value)).digest('hex');
const NOT_TEXT = [
  ['objeto com operador', { $ne: null }],
  ['lista', ['a']],
  ['numero', 123],
  ['booleano', true],
];

const ROUTES = [
  ['/2fa/enviar-codigo', { message: 'Email e obrigatorio.' }],
  ['/2fa/validar-codigo', { message: 'Email ou UserId e código são obrigatórios.' }],
  ['/recuperar-senha/enviar-codigo', { message: 'Email e obrigatorio.' }],
  ['/recuperar-senha/validar-codigo', { message: 'Email e codigo sao obrigatorios.' }],
  ['/recuperar-senha/redefinir', { message: 'Email, codigo e nova senha sao obrigatorios.' }],
];

describe('D34 parte 2: entradas invalidas e erros internos na verificacao e na recuperacao', () => {
  let account;
  let errorSpy;

  beforeEach(() => {
    jest.clearAllMocks();
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    account = {
      _id: USER_ID,
      nome: 'Conta',
      email: EMAIL,
      senha: 'hash-original',
      tipo: 'user',
      verificado: false,
      fotoPerfil: '',
      save: jest.fn(async () => true),
    };
    mockDb.users = [account];
    mockDb.tokens = [];
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  const post = (path) => request(app).post(`/api/auth${path}`);
  const seedToken = (purpose, data = {}) => {
    const token = new TwoFactorToken({ userId: USER_ID, codigo: sha256(CODE), token: sha256(LINK), purpose, ...data });
    mockDb.tokens.push(token);
    return token;
  };

  const expectNoWork = () => {
    expect(User.findOne).not.toHaveBeenCalled();
    expect(User.findById).not.toHaveBeenCalled();
    expect(TwoFactorToken.findOne).not.toHaveBeenCalled();
    expect(TwoFactorToken.updateOne).not.toHaveBeenCalled();
    expect(TwoFactorToken.deleteMany).not.toHaveBeenCalled();
    expect(TwoFactorToken.prototype.save).not.toHaveBeenCalled();
    expect(sendEmail).not.toHaveBeenCalled();
    expect(argon2.hash).not.toHaveBeenCalled();
    expect(account.save).not.toHaveBeenCalled();
    expect(account.verificado).toBe(false);
    expect(account.senha).toBe('hash-original');
  };

  const expectNoLeak = (res) => {
    expect(JSON.stringify(res.body)).not.toMatch(LEAK_PATTERN);
    expect(res.body.detalhe).toBeUndefined();
    expect(res.body.stack).toBeUndefined();
    expect(res.body.token).toBeUndefined();
  };

  const loggedMessages = () => JSON.stringify(errorSpy.mock.calls.map((args) => args.map((arg) => arg?.message ?? arg)));

  describe.each(ROUTES)('corpo invalido em POST %s', (path, required) => {
    test.each([
      ['sem corpo', (r) => r],
      ['texto puro', (r) => r.set('Content-Type', 'text/plain').send('abc')],
      ['formato desconhecido', (r) => r.set('Content-Type', 'application/xml').send('<a/>')],
      ['formulario vazio', (r) => r.set('Content-Type', 'application/x-www-form-urlencoded').send('')],
      ['lista vazia', (r) => r.send([])],
      ['lista com itens', (r) => r.send([EMAIL, CODE])],
      ['objeto vazio', (r) => r.send({})],
    ])('%s responde 400 com a mensagem do campo obrigatorio', async (_label, build) => {
      const res = await build(post(path));

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
      ['com dados no meio', '{"email":"vitima@exemplo.com","novaSenha":SenhaSecreta@77}'],
    ])('JSON %s responde 400 generico, sem trecho do corpo', async (_label, raw) => {
      const res = await post(path).set('Content-Type', 'application/json').send(raw);

      expect(res.status).toBe(400);
      expect(res.body).toEqual(INVALID_JSON);
      expectNoLeak(res);
      expectNoWork();
    });
  });

  describe('campos com tipo errado chegam ao banco? nao', () => {
    test.each(NOT_TEXT)('envio de codigo de verificacao, e-mail %s: 400', async (_label, email) => {
      const res = await post('/2fa/enviar-codigo').send({ email });

      expect(res.status).toBe(400);
      expectNoWork();
    });

    test.each(NOT_TEXT)('envio de codigo de recuperacao, e-mail %s: 400', async (_label, email) => {
      const res = await post('/recuperar-senha/enviar-codigo').send({ email });

      expect(res.status).toBe(400);
      expectNoWork();
    });

    test.each([
      ['userId', (value) => ({ userId: value, codigo: CODE })],
      ['email', (value) => ({ email: value, codigo: CODE })],
      ['codigo', (value) => ({ email: EMAIL, codigo: value })],
    ])('validacao de e-mail, %s com tipo errado: 401 generico (D35)', async (_field, build) => {
      for (const [, value] of NOT_TEXT) {
        const res = await post('/2fa/validar-codigo').send(build(value));

        expect(res.status).toBe(401);
        expect(res.body).toEqual(INVALID_VERIFICATION);
      }
      expectNoWork();
    });

    test.each([
      ['/recuperar-senha/validar-codigo', 'email', (value) => ({ email: value, codigo: CODE })],
      ['/recuperar-senha/validar-codigo', 'codigo', (value) => ({ email: EMAIL, codigo: value })],
      ['/recuperar-senha/redefinir', 'email', (value) => ({ email: value, codigo: CODE, novaSenha: NEW_PASSWORD })],
      ['/recuperar-senha/redefinir', 'codigo', (value) => ({ email: EMAIL, codigo: value, novaSenha: NEW_PASSWORD })],
    ])('%s, %s com tipo errado: 401 generico (D38)', async (path, _field, build) => {
      for (const [, value] of NOT_TEXT) {
        const res = await post(path).send(build(value));

        expect(res.status).toBe(401);
        expect(res.body).toEqual(INVALID_RESET);
      }
      expectNoWork();
    });

    test.each(NOT_TEXT)('redefinir com nova senha %s: 400 pela regra de senha', async (_label, novaSenha) => {
      const res = await post('/recuperar-senha/redefinir').send({ email: EMAIL, codigo: CODE, novaSenha });

      expect(res.status).toBe(400);
      expect(res.body).toEqual({ message: 'A senha é obrigatória e deve ser informada como texto.' });
      expectNoWork();
    });

    test('link de verificacao sem token continua 400', async () => {
      const res = await request(app).get('/api/auth/2fa/validar-token');

      expect(res.status).toBe(400);
      expect(res.body).toEqual({ message: 'Token é obrigatório.' });
      expectNoWork();
    });
  });

  describe('erro interno inesperado', () => {
    test.each([
      ['/2fa/validar-codigo', () => post('/2fa/validar-codigo').send({ email: EMAIL, codigo: CODE }), 'Erro ao validar código.', () => User.findOne],
      ['/2fa/validar-token', () => request(app).get(`/api/auth/2fa/validar-token?token=${LINK}`), 'Erro ao validar token.', () => TwoFactorToken.findOne],
      ['/recuperar-senha/validar-codigo', () => post('/recuperar-senha/validar-codigo').send({ email: EMAIL, codigo: CODE }), 'Erro ao validar codigo de recuperacao.', () => User.findOne],
      ['/recuperar-senha/redefinir', () => post('/recuperar-senha/redefinir').send({ email: EMAIL, codigo: CODE, novaSenha: NEW_PASSWORD }), 'Erro ao redefinir senha.', () => User.findOne],
    ])('%s: falha do banco responde 500 generico, causa so no log', async (_route, send, message, failing) => {
      failing().mockRejectedValueOnce(new Error(INTERNAL));

      const res = await send();

      expect(res.status).toBe(500);
      expect(res.body).toEqual({ message });
      expectNoLeak(res);
      expect(loggedMessages()).toContain('ECONNREFUSED');
    });

    test('falha ao gravar a nova senha responde 500 sem trocar a senha', async () => {
      const user = { ...account, verificado: true };
      mockDb.users = [user];
      seedToken('password_reset', { validado: true });
      argon2.hash.mockRejectedValueOnce(new Error(INTERNAL));

      const res = await post('/recuperar-senha/redefinir').send({ email: EMAIL, codigo: CODE, novaSenha: NEW_PASSWORD });

      expect(res.status).toBe(500);
      expect(res.body).toEqual({ message: 'Erro ao redefinir senha.' });
      expect(user.senha).toBe('hash-original');
    });

    test.each([
      ['/2fa/enviar-codigo'],
      ['/recuperar-senha/enviar-codigo'],
    ])('%s: falha do banco continua 200 com a mensagem generica', async (path) => {
      User.findOne.mockRejectedValueOnce(new Error(INTERNAL));

      const res = await post(path).send({ email: EMAIL });

      expect(res.status).toBe(200);
      expect(res.body).toEqual(GENERIC_SEND);
      expect(sendEmail).not.toHaveBeenCalled();
    });
  });

  describe('o que nao muda', () => {
    test('envio para conta nao verificada continua mandando o codigo, com o e-mail normalizado', async () => {
      const res = await post('/2fa/enviar-codigo').send({ email: '  CONTA@Exemplo.com ' });

      expect(res.status).toBe(200);
      expect(res.body).toEqual(GENERIC_SEND);
      expect(User.findOne).toHaveBeenCalledWith({ email: EMAIL });
      expect(sendEmail).toHaveBeenCalledTimes(1);
    });

    test('codigo correto no cadastro continua concluindo a verificacao', async () => {
      seedToken('email_verification');

      const res = await post('/2fa/validar-codigo').send({ email: EMAIL, codigo: CODE });

      expect(res.status).toBe(200);
      expect(res.body.token).toEqual(expect.any(String));
      expect(account.verificado).toBe(true);
    });

    test('conta ja verificada continua sem JWT pelo codigo (D37)', async () => {
      account.verificado = true;
      seedToken('email_verification');

      const res = await post('/2fa/validar-codigo').send({ email: EMAIL, codigo: CODE });

      expect(res.status).toBe(401);
      expect(res.body).toEqual(INVALID_VERIFICATION);
      expect(res.body.token).toBeUndefined();
    });

    test('codigo errado continua 401 generico', async () => {
      seedToken('email_verification');

      const res = await post('/2fa/validar-codigo').send({ email: EMAIL, codigo: '000000' });

      expect(res.status).toBe(401);
      expect(res.body).toEqual(INVALID_VERIFICATION);
    });

    test('recuperacao completa continua funcionando', async () => {
      const user = { ...account, verificado: true };
      mockDb.users = [user];
      seedToken('password_reset');

      const validated = await post('/recuperar-senha/validar-codigo').send({ email: EMAIL, codigo: CODE });
      expect(validated.status).toBe(200);

      const reset = await post('/recuperar-senha/redefinir').send({ email: EMAIL, codigo: CODE, novaSenha: NEW_PASSWORD });

      expect(reset.status).toBe(200);
      expect(user.senha).toBe('hash-novo');
    });

    test('limite do proprio codigo continua 429', async () => {
      seedToken('email_verification', { tentativas: 5 });

      const res = await post('/2fa/validar-codigo').send({ email: EMAIL, codigo: CODE });

      expect(res.status).toBe(429);
    });
  });
});
