const request = require('supertest');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');

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

// Interpreta operadores e arrays como o MongoDB, para reproduzir o risco sem depender de um banco no CI.
const mockMatches = (actual, expected) => {
  if (Array.isArray(expected)) {
    return expected.some((item) => String(item) === String(actual));
  }
  if (expected && typeof expected === 'object' && !(expected instanceof mongoose.Types.ObjectId)) {
    return Object.entries(expected).every(([operator, value]) => {
      if (operator === '$in') return value.some((item) => (item === null ? actual == null : String(item) === String(actual)));
      if (operator === '$nin') return !value.some((item) => String(item) === String(actual));
      if (operator === '$ne') return value === null ? actual != null : String(value) !== String(actual);
      if (operator === '$gt') return String(actual) > String(value);
      if (operator === '$exists') return value ? actual !== undefined : actual === undefined;
      return false;
    });
  }
  return String(actual) === String(expected);
};

const mockFilter = (record, filter) =>
  Object.entries(filter).every(([key, expected]) => mockMatches(record[key], expected));

jest.mock('../models/User', () => ({
  findOne: jest.fn(async (filter) => mockDb.users.find((user) => mockFilter(user, filter)) || null),
  findById: jest.fn(async (id) => mockDb.users.find((user) => mockFilter(user, { _id: id })) || null),
}));

jest.mock('../models/TwoFactorToken', () => {
  function Token(data) {
    Object.assign(this, { _id: `token-${mockDb.tokens.length}`, validado: false, tentativas: 0, ...data });
  }
  Token.prototype.save = async function save() {
    if (!mockDb.tokens.includes(this)) mockDb.tokens.push(this);
    return this;
  };
  Token.findOne = jest.fn(async (filter) => mockDb.tokens.find((record) => mockFilter(record, filter)) || null);
  Token.deleteMany = jest.fn(async (filter) => {
    mockDb.tokens = mockDb.tokens.filter((record) => !mockFilter(record, filter));
  });
  Token.updateOne = jest.fn(async (filter, update) => {
    const record = mockDb.tokens.find((item) => mockFilter(item, filter));
    if (record && update.$inc) record.tentativas += update.$inc.tentativas;
    return {};
  });
  Token.deleteOne = jest.fn(async ({ _id }) => {
    mockDb.tokens = mockDb.tokens.filter((record) => record._id !== _id);
  });
  return Token;
});

const sendEmail = require('../utils/sendEmail');
const User = require('../models/User');
const TwoFactorToken = require('../models/TwoFactorToken');
const app = require('../app');

const EMAIL_A = 'conta.a@exemplo.com';
const EMAIL_B = 'conta.b@exemplo.com';
const EMAIL_ADMIN = 'admin@exemplo.com';
const GENERIC_MESSAGE = 'Codigo de verificacao invalido ou expirado.';

const buildUser = (email, tipo = 'user') => ({
  _id: new mongoose.Types.ObjectId(),
  nome: `Nome ${email}`,
  email,
  tipo,
  senha: 'hash',
  verificado: false,
  fotoPerfil: '',
  save: jest.fn().mockResolvedValue(true),
});

const validate = (body) => request(app).post('/api/auth/2fa/validar-codigo').send(body);

const lastCode = () => sendEmail.mock.calls.at(-1)[3].match(/class="code">(\d{6})</)[1];

const requestCode = async (email = EMAIL_A) => {
  const res = await request(app).post('/api/auth/2fa/enviar-codigo').send({ email });
  expect(res.status).toBe(200);
  return lastCode();
};

const requestRecoveryCode = async (email = EMAIL_A) => {
  const res = await request(app).post('/api/auth/recuperar-senha/enviar-codigo').send({ email });
  expect(res.status).toBe(200);
  return lastCode();
};

const tokenOwner = (res) => String(jwt.decode(res.body.token).id);

describe('POST /api/auth/2fa/validar-codigo: identidade vinculada ao codigo', () => {
  let contaA;
  let contaB;
  let admin;
  let idA;
  let idB;
  let idAdmin;

  const expectRejectedWithoutJwt = (res) => {
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ message: GENERIC_MESSAGE });
    expect(res.body.token).toBeUndefined();
    expect(contaB.verificado).toBe(false);
    expect(admin.verificado).toBe(false);
  };

  const expectNoQueryReachedMongo = () => {
    expect(TwoFactorToken.findOne).not.toHaveBeenCalled();
    expect(TwoFactorToken.updateOne).not.toHaveBeenCalled();
    expect(User.findOne).not.toHaveBeenCalled();
    expect(User.findById).not.toHaveBeenCalled();
  };

  // Admin e B vem primeiro: como no banco, sao devolvidos antes por uma consulta com varios candidatos.
  beforeEach(() => {
    jest.clearAllMocks();
    admin = buildUser(EMAIL_ADMIN, 'admin');
    contaB = buildUser(EMAIL_B);
    contaA = buildUser(EMAIL_A);
    idA = String(contaA._id);
    idB = String(contaB._id);
    idAdmin = String(admin._id);
    mockDb.users = [admin, contaB, contaA];
    mockDb.tokens = [];
  });

  describe('A: fluxo legitimo', () => {
    test('codigo de A informado por e-mail gera JWT de A', async () => {
      const codigo = await requestCode();

      const res = await validate({ email: EMAIL_A, codigo });

      expect(res.status).toBe(200);
      expect(tokenOwner(res)).toBe(idA);
      expect(jwt.decode(res.body.token).tipo).toBe('user');
      expect(res.body.userId).toBe(idA);
      expect(res.body.user.id).toBe(idA);
      expect(res.body.redirect).toBe('/dashboard');
      expect(contaA.verificado).toBe(true);
      expect(mockDb.tokens[0].validado).toBe(true);
    });

    test('codigo de A informado por userId em texto gera JWT de A', async () => {
      const codigo = await requestCode();

      const res = await validate({ userId: idA, codigo });

      expect(res.status).toBe(200);
      expect(tokenOwner(res)).toBe(idA);
    });

    test('userId vazio com e-mail, como envia a tela web, continua funcionando', async () => {
      const codigo = await requestCode();

      const res = await validate({ userId: '', email: EMAIL_A, codigo });

      expect(res.status).toBe(200);
      expect(tokenOwner(res)).toBe(idA);
    });
  });

  describe('B: tentativa de trocar a identidade', () => {
    test('codigo de A com userId de B e recusado', async () => {
      const codigo = await requestCode();

      const res = await validate({ userId: idB, codigo });

      expectRejectedWithoutJwt(res);
      expect(mockDb.tokens[0].validado).toBe(false);
    });

    test('codigo de A com e-mail de B e recusado', async () => {
      const codigo = await requestCode();

      const res = await validate({ email: EMAIL_B, codigo });

      expectRejectedWithoutJwt(res);
    });

    test('codigo de A com userId de B e e-mail de A e recusado', async () => {
      const codigo = await requestCode();

      const res = await validate({ userId: idB, email: EMAIL_A, codigo });

      expectRejectedWithoutJwt(res);
    });
  });

  describe('C: entrada nao textual e recusada antes de qualquer consulta', () => {
    const NON_TEXT_USER_IDS = [
      ['$ne nulo', () => ({ $ne: null })],
      ['$in com a conta e o alvo', () => ({ $in: [idA, idB] })],
      ['$in com a conta e o admin', () => ({ $in: [idA, idAdmin] })],
      ['$gt', () => ({ $gt: '' })],
      ['$exists', () => ({ $exists: true })],
      ['$nin', () => ({ $nin: [] })],
      ['array com o proprio id', () => [idA]],
      ['array com a conta e o admin', () => [idA, idAdmin]],
      ['numero', () => 123],
      ['booleano', () => true],
      ['objeto vazio', () => ({})],
    ];

    test.each(NON_TEXT_USER_IDS)('userId %s', async (_label, buildUserId) => {
      const codigo = await requestCode();
      jest.clearAllMocks();

      const res = await validate({ userId: buildUserId(), codigo });

      expectRejectedWithoutJwt(res);
      expectNoQueryReachedMongo();
      expect(mockDb.tokens[0].validado).toBe(false);
      expect(mockDb.tokens[0].tentativas).toBe(0);
    });

    test.each([
      ['$ne nulo', () => ({ $ne: null })],
      ['$in com a conta e o admin', () => ({ $in: [EMAIL_A, EMAIL_ADMIN] })],
      ['array', () => [EMAIL_A]],
      ['numero', () => 123],
    ])('email %s', async (_label, buildEmail) => {
      const codigo = await requestCode();
      jest.clearAllMocks();

      const res = await validate({ email: buildEmail(), codigo });

      expectRejectedWithoutJwt(res);
      expectNoQueryReachedMongo();
    });

    test('email nao textual e recusado mesmo com userId valido', async () => {
      const codigo = await requestCode();
      jest.clearAllMocks();

      const res = await validate({ userId: idA, email: { $ne: null }, codigo });

      expectRejectedWithoutJwt(res);
      expectNoQueryReachedMongo();
    });

    test.each([
      ['numero igual ao codigo', (codigo) => Number(codigo)],
      ['array com o codigo', (codigo) => [codigo]],
      ['objeto', () => ({ $ne: null })],
    ])('codigo %s', async (_label, buildCode) => {
      const codigo = await requestCode();
      jest.clearAllMocks();

      const res = await validate({ email: EMAIL_A, codigo: buildCode(codigo) });

      expectRejectedWithoutJwt(res);
      expectNoQueryReachedMongo();
      expect(mockDb.tokens[0].validado).toBe(false);
    });

    test('operador enviado como formulario tambem e recusado', async () => {
      const codigo = await requestCode();
      jest.clearAllMocks();

      const res = await request(app)
        .post('/api/auth/2fa/validar-codigo')
        .type('form')
        .send(`userId[$ne]=x&codigo=${codigo}`);

      expectRejectedWithoutJwt(res);
      expectNoQueryReachedMongo();
    });
  });

  describe('D: ObjectId invalido tem resposta controlada', () => {
    test.each([
      ['texto comum', 'nao-e-um-id'],
      ['12 caracteres', '123456789012'],
      ['23 hexadecimais', 'a'.repeat(23)],
      ['25 hexadecimais', 'a'.repeat(25)],
      ['24 caracteres nao hexadecimais', 'z'.repeat(24)],
      ['com espacos', ' '.repeat(3)],
      ['com quebra de linha no fim', `${'a'.repeat(24)}\n`],
    ])('userId %s responde 401, nao 500', async (_label, userId) => {
      const res = await validate({ userId, codigo: '123456' });

      expectRejectedWithoutJwt(res);
      expectNoQueryReachedMongo();
    });
  });

  describe('E: codigo incorreto preserva o comportamento', () => {
    test('responde 401 e registra a tentativa', async () => {
      await requestCode();

      const res = await validate({ email: EMAIL_A, codigo: '000000' });

      expectRejectedWithoutJwt(res);
      expect(mockDb.tokens[0].tentativas).toBe(1);
      expect(contaA.verificado).toBe(false);
    });

    test('apos o limite de tentativas o codigo correto responde 429', async () => {
      const codigo = await requestCode();
      mockDb.tokens[0].tentativas = 5;

      const res = await validate({ email: EMAIL_A, codigo });

      expect(res.status).toBe(429);
      expect(res.body.token).toBeUndefined();
      expect(mockDb.tokens).toHaveLength(0);
    });

    test.each([
      [{}],
      [{ email: EMAIL_A }],
      [{ userId: 'a'.repeat(24) }],
      [{ codigo: '123456' }],
      [{ userId: '', email: '', codigo: '123456' }],
    ])('corpo incompleto %j continua 400', async (body) => {
      const res = await validate(body);

      expect(res.status).toBe(400);
    });
  });

  describe('F: e-mail equivalente do D08 continua funcionando', () => {
    test.each([
      ['maiusculas', 'Conta.A@Exemplo.COM'],
      ['espacos', '  conta.a@exemplo.com  '],
    ])('%s', async (_label, email) => {
      const codigo = await requestCode();

      const res = await validate({ email, codigo });

      expect(res.status).toBe(200);
      expect(tokenOwner(res)).toBe(idA);
    });
  });

  describe('G: cada codigo autentica apenas a propria conta', () => {
    test('com dois codigos ativos, cada um autentica so o seu dono', async () => {
      const codigoA = await requestCode(EMAIL_A);
      const codigoB = await requestCode(EMAIL_B);

      const cruzado = await validate({ email: EMAIL_B, codigo: codigoA });
      expect(cruzado.status).toBe(401);

      const resB = await validate({ email: EMAIL_B, codigo: codigoB });
      const resA = await validate({ email: EMAIL_A, codigo: codigoA });

      expect(tokenOwner(resB)).toBe(idB);
      expect(tokenOwner(resA)).toBe(idA);
    });
  });

  describe('H: codigo de usuario comum nunca gera JWT de admin', () => {
    test.each([
      ['userId de admin em texto', () => ({ userId: idAdmin })],
      ['e-mail de admin', () => ({ email: EMAIL_ADMIN })],
      ['operador com a conta e o admin', () => ({ userId: { $in: [idA, idAdmin] } })],
      ['array com a conta e o admin', () => ({ userId: [idA, idAdmin] })],
      ['operador generico', () => ({ userId: { $ne: null } })],
      ['operador por faixa', () => ({ userId: { $gt: '' } })],
      ['operador em e-mail', () => ({ email: { $in: [EMAIL_A, EMAIL_ADMIN] } })],
    ])('%s', async (_label, buildIdentity) => {
      const codigo = await requestCode();

      const res = await validate({ ...buildIdentity(), codigo });

      expectRejectedWithoutJwt(res);
    });

    test('o codigo do proprio admin continua gerando JWT de admin', async () => {
      const codigo = await requestCode(EMAIL_ADMIN);

      const res = await validate({ email: EMAIL_ADMIN, codigo });

      expect(res.status).toBe(200);
      expect(tokenOwner(res)).toBe(idAdmin);
      expect(res.body.redirect).toBe('/admin');
    });
  });

  describe('vinculo do token', () => {
    test.each([
      ['e-mail', (id, email) => ({ email })],
      ['userId', (id) => ({ userId: id })],
    ])('informado por %s, o usuario vem do valor gravado no token', async (_label, buildIdentity) => {
      const codigo = await requestCode();
      const storedOwner = mockDb.tokens[0].userId;

      const res = await validate({ ...buildIdentity(idA, EMAIL_A), codigo });

      expect(res.status).toBe(200);
      expect(User.findById.mock.calls.at(-1)[0]).toBe(storedOwner);
      expect(tokenOwner(res)).toBe(String(storedOwner));
    });

    test('codigo ja utilizado nao pode ser reutilizado', async () => {
      const codigo = await requestCode();
      await validate({ email: EMAIL_A, codigo });

      const res = await validate({ email: EMAIL_A, codigo });

      expect(res.status).toBe(401);
      expect(res.body.token).toBeUndefined();
    });

    test('codigo de recuperacao de senha nao autentica', async () => {
      const codigo = await requestRecoveryCode();

      const res = await validate({ email: EMAIL_A, codigo });

      expect(res.status).toBe(401);
      expect(res.body.token).toBeUndefined();
      expect(mockDb.tokens[0].validado).toBe(false);
    });

    test('codigo cuja conta nao existe mais responde 401, sem JWT e sem 500', async () => {
      const codigo = await requestCode();
      mockDb.users = mockDb.users.filter((user) => user !== contaA);

      const res = await validate({ userId: idA, codigo });

      expectRejectedWithoutJwt(res);
    });
  });
});
