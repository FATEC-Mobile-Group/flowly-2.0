const request = require('supertest');
const argon2 = require('argon2');

const mockDb = { users: [], tokens: [] };

jest.mock('@google-cloud/storage', () => ({
  Storage: jest.fn().mockImplementation(() => ({
    bucket: jest.fn().mockReturnValue({ file: jest.fn() }),
  })),
}));

jest.mock('../utils/sendEmail', () => jest.fn().mockResolvedValue(true));

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

// Como no MongoDB, a comparacao de e-mail e exata: o schema nao usa lowercase.
jest.mock('../models/User', () => ({
  findOne: jest.fn(async ({ email }) => mockDb.users.find((user) => user.email === email) || null),
  findById: jest.fn(async (id) => mockDb.users.find((user) => String(user._id) === String(id)) || null),
}));

jest.mock('../models/TwoFactorToken', () => {
  const matches = (record, filter) => Object.entries(filter).every(([key, expected]) => (
    expected && expected.$in
      ? expected.$in.includes(record[key] ?? null)
      : String(record[key]) === String(expected)
  ));

  function Token(data) {
    Object.assign(this, { validado: false, tentativas: 0, ...data });
  }
  Token.prototype.save = async function save() {
    if (!mockDb.tokens.includes(this)) mockDb.tokens.push(this);
    return this;
  };
  Token.findOne = jest.fn(async (filter) => mockDb.tokens.find((record) => matches(record, filter)) || null);
  Token.deleteMany = jest.fn(async (filter) => {
    mockDb.tokens = mockDb.tokens.filter((record) => !matches(record, filter));
  });
  Token.updateOne = jest.fn(async () => ({}));
  Token.deleteOne = jest.fn(async () => ({}));
  return Token;
});

const sendEmail = require('../utils/sendEmail');
const app = require('../app');

const EMAIL = 'usuario1@exemplo.com';
const OTHER_EMAIL = 'usuario2@exemplo.com';
const NEW_PASSWORD = 'NovaSenha@456';

const EQUIVALENT_EMAILS = [
  ['maiusculas e minusculas', 'Usuario1@Exemplo.com'],
  ['tudo em maiusculas', 'USUARIO1@EXEMPLO.COM'],
  ['espacos nas pontas', '  usuario1@exemplo.com  '],
  ['espacos e maiusculas', ' \tUsuario1@EXEMPLO.com\n '],
  ['forma ja normalizada', EMAIL],
];

const DIFFERENT_EMAILS = [
  ['outra conta', OTHER_EMAIL],
  ['outra conta em maiusculas', ' USUARIO2@Exemplo.COM '],
  ['alias com +', 'usuario1+alias@exemplo.com'],
  ['com ponto no nome', 'usuario.1@exemplo.com'],
  ['outro dominio', 'usuario1@exemplo.com.br'],
  ['inexistente', 'ninguem@exemplo.com'],
];

const buildUser = (id, email) => ({
  _id: id,
  nome: 'Usuario Teste',
  email,
  senha: 'hash-original',
  tipo: 'user',
  verificado: false,
  fotoPerfil: '',
  save: jest.fn().mockResolvedValue(true),
});

const post = (path, body) => request(app).post(`/api/auth${path}`).send(body);

const lastEmailHtml = () => sendEmail.mock.calls.at(-1)[3];
const lastCode = () => lastEmailHtml().match(/class="code">(\d{6})</)[1];
const lastLinkToken = () => lastEmailHtml().match(/verificar-2fa\?token=([a-f0-9]{64})/)[1];

const requestVerificationCode = async (email = EMAIL) => {
  const res = await post('/2fa/enviar-codigo', { email });
  expect(res.status).toBe(200);
  return lastCode();
};

const requestRecoveryCode = async (email = EMAIL) => {
  const res = await post('/recuperar-senha/enviar-codigo', { email });
  expect(res.status).toBe(200);
  return lastCode();
};

describe('normalizacao de e-mail nos fluxos de verificacao e recuperacao', () => {
  let user;
  let otherUser;

  beforeEach(() => {
    jest.clearAllMocks();
    user = buildUser('507f1f77bcf86cd799439011', EMAIL);
    otherUser = buildUser('507f1f77bcf86cd799439012', OTHER_EMAIL);
    mockDb.users = [user, otherUser];
    mockDb.tokens = [];
  });

  describe('verificacao de e-mail', () => {
    test.each(EQUIVALENT_EMAILS)('A/B: valida o codigo com %s', async (_label, email) => {
      const codigo = await requestVerificationCode();

      const res = await post('/2fa/validar-codigo', { email, codigo });

      expect(res.status).toBe(200);
      expect(res.body.token).toEqual(expect.any(String));
      expect(res.body.userId).toBe(user._id);
      expect(user.verificado).toBe(true);
    });

    test.each(EQUIVALENT_EMAILS)('envio com %s e validacao em outra forma sao a mesma conta', async (_label, email) => {
      const codigo = await requestVerificationCode(email);

      const res = await post('/2fa/validar-codigo', { email: 'USUARIO1@exemplo.COM', codigo });

      expect(res.status).toBe(200);
      expect(sendEmail.mock.calls.at(-1)[0]).toBe(EMAIL);
    });

    test('o link de confirmacao continua funcionando apos envio com maiusculas', async () => {
      await requestVerificationCode('  USUARIO1@Exemplo.com ');

      const res = await request(app).get('/api/auth/2fa/validar-token').query({ token: lastLinkToken() });

      expect(res.status).toBe(200);
      expect(res.body.userId).toBe(user._id);
      expect(user.verificado).toBe(true);
    });

    test('validar por userId continua funcionando', async () => {
      const codigo = await requestVerificationCode();

      const res = await post('/2fa/validar-codigo', { userId: user._id, codigo });

      expect(res.status).toBe(200);
    });
  });

  describe('recuperacao de senha', () => {
    test.each(EQUIVALENT_EMAILS)('C: valida o codigo com %s', async (_label, email) => {
      const codigo = await requestRecoveryCode();

      const res = await post('/recuperar-senha/validar-codigo', { email, codigo });

      expect(res.status).toBe(200);
      expect(mockDb.tokens[0].validado).toBe(true);
    });

    test.each(EQUIVALENT_EMAILS)('D: conclui a redefinicao com %s', async (_label, email) => {
      const codigo = await requestRecoveryCode();
      await post('/recuperar-senha/validar-codigo', { email: EMAIL, codigo });

      const res = await post('/recuperar-senha/redefinir', { email, codigo, novaSenha: NEW_PASSWORD });

      expect(res.status).toBe(200);
      expect(await argon2.verify(user.senha, NEW_PASSWORD)).toBe(true);
      expect(user.save).toHaveBeenCalledTimes(1);
      expect(mockDb.tokens).toHaveLength(0);
    });

    test('D: fluxo completo usando uma forma diferente em cada etapa', async () => {
      const codigo = await requestRecoveryCode(' Usuario1@exemplo.com');

      const validated = await post('/recuperar-senha/validar-codigo', {
        email: 'USUARIO1@EXEMPLO.COM',
        codigo,
      });
      const reset = await post('/recuperar-senha/redefinir', {
        email: 'usuario1@EXEMPLO.com  ',
        codigo,
        novaSenha: NEW_PASSWORD,
      });

      expect(validated.status).toBe(200);
      expect(reset.status).toBe(200);
      expect(await argon2.verify(user.senha, NEW_PASSWORD)).toBe(true);
    });
  });

  describe('E: e-mail realmente diferente nao e a mesma conta', () => {
    test.each(DIFFERENT_EMAILS)('verificacao recusa %s', async (_label, email) => {
      const codigo = await requestVerificationCode();

      const res = await post('/2fa/validar-codigo', { email, codigo });

      expect(res.status).toBe(401);
      expect(res.body.token).toBeUndefined();
      expect(user.verificado).toBe(false);
      expect(otherUser.verificado).toBe(false);
      expect(mockDb.tokens[0].validado).toBe(false);
    });

    test.each(DIFFERENT_EMAILS)('recuperacao recusa %s', async (_label, email) => {
      const codigo = await requestRecoveryCode();

      const res = await post('/recuperar-senha/validar-codigo', { email, codigo });

      expect(res.status).toBe(401);
      expect(mockDb.tokens[0].validado).toBe(false);
    });

    test.each(DIFFERENT_EMAILS)('redefinicao recusa %s', async (_label, email) => {
      const codigo = await requestRecoveryCode();
      await post('/recuperar-senha/validar-codigo', { email: EMAIL, codigo });

      const res = await post('/recuperar-senha/redefinir', { email, codigo, novaSenha: NEW_PASSWORD });

      expect(res.status).toBe(401);
      expect(user.senha).toBe('hash-original');
      expect(otherUser.senha).toBe('hash-original');
    });

    test('envio para outra forma de alias nao gera codigo para a conta', async () => {
      const res = await post('/recuperar-senha/enviar-codigo', { email: 'usuario1+alias@exemplo.com' });

      expect(res.status).toBe(200);
      expect(sendEmail).not.toHaveBeenCalled();
      expect(mockDb.tokens).toHaveLength(0);
    });
  });

  describe('F: valor ausente ou invalido preserva o comportamento', () => {
    test.each([
      ['/2fa/enviar-codigo', {}],
      ['/2fa/enviar-codigo', { email: '   ' }],
      ['/2fa/enviar-codigo', { email: 123 }],
      ['/recuperar-senha/enviar-codigo', {}],
      ['/recuperar-senha/enviar-codigo', { email: '   ' }],
      ['/recuperar-senha/enviar-codigo', { email: 123 }],
      ['/2fa/validar-codigo', {}],
      ['/2fa/validar-codigo', { email: EMAIL }],
      ['/2fa/validar-codigo', { codigo: '123456' }],
      ['/recuperar-senha/validar-codigo', {}],
      ['/recuperar-senha/validar-codigo', { email: EMAIL }],
      ['/recuperar-senha/validar-codigo', { codigo: '123456' }],
      ['/recuperar-senha/redefinir', {}],
      ['/recuperar-senha/redefinir', { email: EMAIL, codigo: '123456' }],
      ['/recuperar-senha/redefinir', { email: EMAIL, novaSenha: NEW_PASSWORD }],
    ])('%s com %j responde 400', async (path, body) => {
      const res = await post(path, body);

      expect(res.status).toBe(400);
      expect(res.body.message).toEqual(expect.any(String));
    });

    test.each([
      ['/2fa/validar-codigo', { email: '   ', codigo: '123456' }],
      ['/2fa/validar-codigo', { email: 123, codigo: '123456' }],
      ['/recuperar-senha/validar-codigo', { email: '   ', codigo: '123456' }],
      ['/recuperar-senha/validar-codigo', { email: 123, codigo: '123456' }],
      ['/recuperar-senha/redefinir', { email: '   ', codigo: '123456', novaSenha: NEW_PASSWORD }],
      ['/recuperar-senha/redefinir', { email: 123, codigo: '123456', novaSenha: NEW_PASSWORD }],
    ])('%s com %j responde 401', async (path, body) => {
      const res = await post(path, body);

      expect(res.status).toBe(401);
    });

    test('codigo incorreto com e-mail equivalente continua 401', async () => {
      await requestVerificationCode();

      const res = await post('/2fa/validar-codigo', { email: 'Usuario1@Exemplo.com', codigo: '000000' });

      expect(res.status).toBe(401);
      expect(user.verificado).toBe(false);
    });

    test('nova senha fora da politica continua 400 e nao altera a senha', async () => {
      const codigo = await requestRecoveryCode();
      await post('/recuperar-senha/validar-codigo', { email: EMAIL, codigo });

      const res = await post('/recuperar-senha/redefinir', {
        email: 'Usuario1@Exemplo.com',
        codigo,
        novaSenha: '123456',
      });

      expect(res.status).toBe(400);
      expect(user.senha).toBe('hash-original');
    });

    test('resposta generica de envio nao muda para conta inexistente', async () => {
      const res = await post('/2fa/enviar-codigo', { email: 'NINGUEM@exemplo.com' });

      expect(res.status).toBe(200);
      expect(res.body.message).toBe('Se o email estiver cadastrado, um codigo sera enviado.');
      expect(sendEmail).not.toHaveBeenCalled();
    });
  });
});
