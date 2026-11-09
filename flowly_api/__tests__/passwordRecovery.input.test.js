const request = require('supertest');
const argon2 = require('argon2');
const mongoose = require('mongoose');

const mockDb = { users: [], tokens: [], sequence: 0 };

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
  };
});

// Reproduz o medido com Mongoose e MongoDB reais: arrays e operadores viram filtro; outro objeto falha no cast.
const mockKnownOperators = ['$in', '$ne', '$gt', '$regex'];

const mockMatches = (actual, expected) => {
  if (Array.isArray(expected)) {
    return expected.some((item) => String(item) === String(actual));
  }
  if (expected && typeof expected === 'object' && !(expected instanceof mongoose.Types.ObjectId)) {
    const operators = Object.keys(expected);
    if (!operators.length || operators.some((operator) => !mockKnownOperators.includes(operator))) {
      throw new Error('Cast to string failed for value');
    }
    return operators.every((operator) => {
      const value = expected[operator];
      if (operator === '$in') return value.some((item) => String(item) === String(actual));
      if (operator === '$ne') return String(value) !== String(actual);
      if (operator === '$gt') return String(actual) > String(value);
      return new RegExp(value).test(String(actual));
    });
  }
  return String(actual) === String(expected);
};

const mockFilter = (record, filter) =>
  Object.entries(filter).every(([key, expected]) => mockMatches(record[key], expected));

jest.mock('../models/User', () => ({
  findOne: jest.fn(async (filter) => mockDb.users.find((user) => mockFilter(user, filter)) || null),
  findById: jest.fn(async (id) => mockDb.users.find((user) => String(user._id) === String(id)) || null),
}));

jest.mock('../models/TwoFactorToken', () => {
  function Token(data) {
    mockDb.sequence += 1;
    Object.assign(this, { _id: `token-${mockDb.sequence}`, validado: false, tentativas: 0, ...data });
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

const EMAIL_ADMIN = 'admin@exemplo.com';
const EMAIL_A = 'conta.a@exemplo.com';
const EMAIL_B = 'conta.b@exemplo.com';
const ORIGINAL_HASH = 'hash-original';
const NEW_PASSWORD = 'NovaSenha@456';
const WRONG_CODE = '000000';
const GENERIC_MESSAGE = 'Codigo de recuperacao invalido ou expirado.';

const NON_TEXT_EMAILS = [
  ['lista com B', { $in: [EMAIL_B] }],
  ['lista com A e B', { $in: [EMAIL_A, EMAIL_B] }],
  ['array com B', [EMAIL_B]],
  ['array aninhado', [[EMAIL_B]]],
  ['array vazio', []],
  ['operador generico', { $ne: 'x@exemplo.com' }],
  ['operador de faixa', { $gt: 'conta.a@exemplo.com' }],
  ['operador de padrao', { $regex: '^conta\\.b@' }],
  ['objeto sem operador', { campo: 'valor' }],
  ['objeto vazio', {}],
  ['operador desconhecido', { $nada: 1 }],
  ['numero', 123],
  ['booleano', true],
];

// Consultas que, sem a validacao, alcancam justamente a conta B.
const EMAILS_THAT_REACH_B = [
  ['lista com B', { $in: [EMAIL_B] }],
  ['array com B', [EMAIL_B]],
  ['operador de faixa', { $gt: 'conta.a@exemplo.com' }],
  ['operador de padrao', { $regex: '^conta\\.b@' }],
];

const NON_TEXT_CODES = [
  ['array', (codigo) => [codigo]],
  ['array aninhado', (codigo) => [[codigo]]],
  ['numero', (codigo) => Number(codigo)],
  ['objeto', (codigo) => ({ valor: codigo })],
  ['operador', () => ({ $ne: null })],
  ['booleano', () => true],
];

const EQUIVALENT_EMAILS = [
  ['maiusculas e minusculas', 'Conta.A@Exemplo.com'],
  ['tudo em maiusculas', 'CONTA.A@EXEMPLO.COM'],
  ['espacos nas pontas', '  conta.a@exemplo.com  '],
  ['espacos e maiusculas', ' \tConta.A@EXEMPLO.com\n '],
];

const DIFFERENT_EMAILS = [
  ['outra conta', EMAIL_B],
  ['alias com +', 'conta.a+alias@exemplo.com'],
  ['outro dominio', 'conta.a@exemplo.com.br'],
  ['inexistente', 'ninguem@exemplo.com'],
  ['texto com forma de operador', '{"$ne":null}'],
];

const buildUser = (email, tipo = 'user') => ({
  _id: new mongoose.Types.ObjectId(),
  nome: `Nome ${email}`,
  email,
  tipo,
  senha: ORIGINAL_HASH,
  verificado: true,
  fotoPerfil: '',
  save: jest.fn().mockResolvedValue(true),
});

const post = (path, body) => request(app).post(`/api/auth/recuperar-senha${path}`).send(body);
const postForm = (path, form) => request(app).post(`/api/auth/recuperar-senha${path}`).type('form').send(form);

const askCode = async (email) => {
  const res = await post('/enviar-codigo', { email });
  expect(res.status).toBe(200);
  return sendEmail.mock.calls.at(-1)[3].match(/class="code">(\d{6})</)[1];
};

describe('recuperacao de senha: tipo das entradas', () => {
  let admin;
  let contaA;
  let contaB;

  const tokenOf = (user) => mockDb.tokens.find((token) => String(token.userId) === String(user._id));

  const askAndValidate = async (email) => {
    const codigo = await askCode(email);
    const res = await post('/validar-codigo', { email, codigo });
    expect(res.status).toBe(200);
    return codigo;
  };

  const forgetSetupCalls = () => {
    User.findOne.mockClear();
    TwoFactorToken.findOne.mockClear();
    TwoFactorToken.updateOne.mockClear();
    TwoFactorToken.deleteOne.mockClear();
    TwoFactorToken.deleteMany.mockClear();
  };

  const expectRejected = (res) => {
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ message: GENERIC_MESSAGE });
  };

  const expectNoQueryReachedMongo = () => {
    expect(User.findOne).not.toHaveBeenCalled();
    expect(TwoFactorToken.findOne).not.toHaveBeenCalled();
    expect(TwoFactorToken.updateOne).not.toHaveBeenCalled();
    expect(TwoFactorToken.deleteOne).not.toHaveBeenCalled();
    expect(TwoFactorToken.deleteMany).not.toHaveBeenCalled();
  };

  const expectTokenUntouched = (user) => {
    const token = tokenOf(user);
    expect(token).toBeDefined();
    expect(token.validado).toBe(false);
    expect(token.tentativas).toBe(0);
  };

  const expectPasswordsUnchanged = () => {
    [admin, contaA, contaB].forEach((user) => {
      expect(user.senha).toBe(ORIGINAL_HASH);
      expect(user.save).not.toHaveBeenCalled();
    });
  };

  // Em ordem alfabetica, como o indice unico de e-mail entrega o primeiro resultado no banco real.
  beforeEach(() => {
    jest.clearAllMocks();
    admin = buildUser(EMAIL_ADMIN, 'admin');
    contaA = buildUser(EMAIL_A);
    contaB = buildUser(EMAIL_B);
    mockDb.users = [admin, contaA, contaB];
    mockDb.tokens = [];
  });

  describe('A: fluxo legitimo', () => {
    test('e-mail em texto e codigo correto validam o token', async () => {
      const codigo = await askCode(EMAIL_A);

      const res = await post('/validar-codigo', { email: EMAIL_A, codigo });

      expect(res.status).toBe(200);
      expect(res.body.token).toBeUndefined();
      expect(tokenOf(contaA).validado).toBe(true);
    });

    test('redefinicao com codigo validado troca a senha e remove o token', async () => {
      const codigo = await askAndValidate(EMAIL_A);

      const res = await post('/redefinir', { email: EMAIL_A, codigo, novaSenha: NEW_PASSWORD });

      expect(res.status).toBe(200);
      expect(await argon2.verify(contaA.senha, NEW_PASSWORD)).toBe(true);
      expect(contaA.save).toHaveBeenCalledTimes(1);
      expect(tokenOf(contaA)).toBeUndefined();
      expect(contaB.senha).toBe(ORIGINAL_HASH);
    });

    test('redefinir sem validar antes continua recusado', async () => {
      const codigo = await askCode(EMAIL_A);

      const res = await post('/redefinir', { email: EMAIL_A, codigo, novaSenha: NEW_PASSWORD });

      expectRejected(res);
      expectPasswordsUnchanged();
    });

    test('codigo nao pode ser reutilizado depois da redefinicao', async () => {
      const codigo = await askAndValidate(EMAIL_A);
      await post('/redefinir', { email: EMAIL_A, codigo, novaSenha: NEW_PASSWORD });

      const res = await post('/redefinir', { email: EMAIL_A, codigo, novaSenha: 'OutraSenha@789' });

      expectRejected(res);
      expect(await argon2.verify(contaA.senha, NEW_PASSWORD)).toBe(true);
    });
  });

  describe('B: e-mail equivalente do D08', () => {
    test.each(EQUIVALENT_EMAILS)('valida o codigo com %s', async (_label, email) => {
      const codigo = await askCode(EMAIL_A);

      const res = await post('/validar-codigo', { email, codigo });

      expect(res.status).toBe(200);
      expect(tokenOf(contaA).validado).toBe(true);
    });

    test.each(EQUIVALENT_EMAILS)('redefine a senha com %s', async (_label, email) => {
      const codigo = await askAndValidate(EMAIL_A);

      const res = await post('/redefinir', { email, codigo, novaSenha: NEW_PASSWORD });

      expect(res.status).toBe(200);
      expect(await argon2.verify(contaA.senha, NEW_PASSWORD)).toBe(true);
    });
  });

  describe('C: e-mail nao textual', () => {
    test.each(NON_TEXT_EMAILS)('validar-codigo recusa %s com codigo errado, sem consultar o banco', async (_label, email) => {
      await askCode(EMAIL_A);
      await askCode(EMAIL_B);
      forgetSetupCalls();

      const res = await post('/validar-codigo', { email, codigo: WRONG_CODE });

      expectRejected(res);
      expectNoQueryReachedMongo();
      expectTokenUntouched(contaA);
      expectTokenUntouched(contaB);
    });

    test.each(NON_TEXT_EMAILS)('validar-codigo recusa %s com o codigo de B, sem validar o token', async (_label, email) => {
      const codigoB = await askCode(EMAIL_B);
      forgetSetupCalls();

      const res = await post('/validar-codigo', { email, codigo: codigoB });

      expectRejected(res);
      expectNoQueryReachedMongo();
      expectTokenUntouched(contaB);
    });

    test.each(NON_TEXT_EMAILS)('redefinir recusa %s sem trocar a senha', async (_label, email) => {
      const codigoB = await askAndValidate(EMAIL_B);
      forgetSetupCalls();

      const res = await post('/redefinir', { email, codigo: codigoB, novaSenha: NEW_PASSWORD });

      expectRejected(res);
      expectNoQueryReachedMongo();
      expectPasswordsUnchanged();
      expect(tokenOf(contaB)).toBeDefined();
    });

    test('corpo de formulario tambem nao vira filtro em validar-codigo', async () => {
      const codigoB = await askCode(EMAIL_B);
      forgetSetupCalls();

      const res = await postForm('/validar-codigo', `email[$in][]=${encodeURIComponent(EMAIL_B)}&codigo=${codigoB}`);

      expectRejected(res);
      expectNoQueryReachedMongo();
      expectTokenUntouched(contaB);
    });

    test('corpo de formulario tambem nao vira filtro em redefinir', async () => {
      const codigoB = await askAndValidate(EMAIL_B);
      forgetSetupCalls();

      const res = await postForm(
        '/redefinir',
        `email[$in][]=${encodeURIComponent(EMAIL_B)}&codigo=${codigoB}&novaSenha=${encodeURIComponent(NEW_PASSWORD)}`
      );

      expectRejected(res);
      expectNoQueryReachedMongo();
      expectPasswordsUnchanged();
    });

    test.each(NON_TEXT_EMAILS)('enviar-codigo continua recusando %s', async (_label, email) => {
      const res = await post('/enviar-codigo', { email });

      expect(res.status).toBe(400);
      expect(sendEmail).not.toHaveBeenCalled();
      expect(User.findOne).not.toHaveBeenCalled();
      expect(mockDb.tokens).toHaveLength(0);
    });
  });

  describe('D: codigo nao textual', () => {
    test.each(NON_TEXT_CODES)('validar-codigo nao converte %s no codigo certo', async (_label, build) => {
      const codigo = await askCode(EMAIL_A);
      forgetSetupCalls();

      const res = await post('/validar-codigo', { email: EMAIL_A, codigo: build(codigo) });

      expectRejected(res);
      expectNoQueryReachedMongo();
      expectTokenUntouched(contaA);
    });

    test.each(NON_TEXT_CODES)('redefinir nao converte %s no codigo certo', async (_label, build) => {
      const codigo = await askAndValidate(EMAIL_A);
      forgetSetupCalls();

      const res = await post('/redefinir', { email: EMAIL_A, codigo: build(codigo), novaSenha: NEW_PASSWORD });

      expectRejected(res);
      expectNoQueryReachedMongo();
      expectPasswordsUnchanged();
      expect(tokenOf(contaA)).toBeDefined();
    });

    test('codigo nao textual nao revela se a conta existe', async () => {
      await askCode(EMAIL_A);

      const existing = await post('/validar-codigo', { email: EMAIL_A, codigo: ['123456'] });
      const unknown = await post('/validar-codigo', { email: 'ninguem@exemplo.com', codigo: ['123456'] });

      expect(existing.status).toBe(unknown.status);
      expect(existing.body).toEqual(unknown.body);
    });

    test('rejeicao por tipo nao atrapalha o fluxo legitimo seguinte', async () => {
      const codigo = await askCode(EMAIL_A);
      await post('/validar-codigo', { email: EMAIL_A, codigo: [codigo] });

      const res = await post('/validar-codigo', { email: EMAIL_A, codigo });

      expect(res.status).toBe(200);
    });
  });

  describe('E: e-mail realmente diferente', () => {
    test.each(DIFFERENT_EMAILS)('validar-codigo recusa %s com o codigo de A', async (_label, email) => {
      const codigoA = await askCode(EMAIL_A);

      const res = await post('/validar-codigo', { email, codigo: codigoA });

      expectRejected(res);
      expect(tokenOf(contaA).validado).toBe(false);
    });

    test.each(DIFFERENT_EMAILS)('redefinir recusa %s com o codigo de A', async (_label, email) => {
      const codigoA = await askAndValidate(EMAIL_A);

      const res = await post('/redefinir', { email, codigo: codigoA, novaSenha: NEW_PASSWORD });

      expectRejected(res);
      expectPasswordsUnchanged();
    });
  });

  describe('F: nova senha e campos ausentes', () => {
    test.each([
      ['curta', 'Ab@1', 'A senha deve ter pelo menos 8 caracteres.'],
      ['sem maiuscula', 'senhafraca@1', 'A senha deve incluir letras maiúsculas, minúsculas, números e caracteres especiais.'],
      ['sem especial', 'SenhaFraca12', 'A senha deve incluir letras maiúsculas, minúsculas, números e caracteres especiais.'],
      ['em array', [NEW_PASSWORD], 'A senha é obrigatória e deve ser informada como texto.'],
      ['em numero', 12345678, 'A senha é obrigatória e deve ser informada como texto.'],
      ['em objeto', { senha: NEW_PASSWORD }, 'A senha é obrigatória e deve ser informada como texto.'],
    ])('senha %s continua 400 com a mensagem da politica', async (_label, novaSenha, message) => {
      const codigo = await askAndValidate(EMAIL_A);

      const res = await post('/redefinir', { email: EMAIL_A, codigo, novaSenha });

      expect(res.status).toBe(400);
      expect(res.body.message).toBe(message);
      expectPasswordsUnchanged();
      expect(tokenOf(contaA).validado).toBe(true);
    });

    test.each([
      ['e-mail', { email: [EMAIL_A], codigo: '123456' }],
      ['codigo', { email: EMAIL_A, codigo: ['123456'] }],
    ])('com %s nao textual, a politica de senha continua respondendo primeiro', async (_label, body) => {
      const res = await post('/redefinir', { ...body, novaSenha: '123456' });

      expect(res.status).toBe(400);
      expect(res.body.message).toBe('A senha deve ter pelo menos 8 caracteres.');
    });

    test.each([
      ['/validar-codigo', 'e-mail ausente', { codigo: '123456' }],
      ['/validar-codigo', 'codigo ausente', { email: EMAIL_A }],
      ['/validar-codigo', 'e-mail nulo', { email: null, codigo: '123456' }],
      ['/validar-codigo', 'e-mail vazio', { email: '', codigo: '123456' }],
      ['/validar-codigo', 'e-mail zero', { email: 0, codigo: '123456' }],
      ['/validar-codigo', 'e-mail falso', { email: false, codigo: '123456' }],
      ['/validar-codigo', 'codigo nulo', { email: EMAIL_A, codigo: null }],
      ['/validar-codigo', 'codigo zero', { email: EMAIL_A, codigo: 0 }],
      ['/redefinir', 'e-mail ausente', { codigo: '123456', novaSenha: NEW_PASSWORD }],
      ['/redefinir', 'codigo ausente', { email: EMAIL_A, novaSenha: NEW_PASSWORD }],
      ['/redefinir', 'senha ausente', { email: EMAIL_A, codigo: '123456' }],
      ['/redefinir', 'senha nula', { email: EMAIL_A, codigo: '123456', novaSenha: null }],
    ])('%s com %s continua 400', async (path, _label, body) => {
      const res = await post(path, body);

      expect(res.status).toBe(400);
      expect(User.findOne).not.toHaveBeenCalled();
    });
  });

  describe('G: token de outra conta', () => {
    test.each(EMAILS_THAT_REACH_B)('%s nao gasta as tentativas de B', async (_label, email) => {
      await askCode(EMAIL_B);

      await post('/validar-codigo', { email, codigo: WRONG_CODE });
      await post('/validar-codigo', { email, codigo: WRONG_CODE });

      expect(tokenOf(contaB).tentativas).toBe(0);
    });

    test.each(EMAILS_THAT_REACH_B)('%s nao consome o token de B que esta no limite', async (_label, email) => {
      const codigoB = await askCode(EMAIL_B);
      tokenOf(contaB).tentativas = 5;

      const res = await post('/validar-codigo', { email, codigo: codigoB });

      expectRejected(res);
      expect(TwoFactorToken.deleteOne).not.toHaveBeenCalled();
      expect(tokenOf(contaB)).toBeDefined();
      expect(tokenOf(contaB).tentativas).toBe(5);
    });

    test.each(EMAILS_THAT_REACH_B)('%s nao interrompe a recuperacao de B', async (_label, email) => {
      const codigoB = await askAndValidate(EMAIL_B);
      await post('/redefinir', { email, codigo: codigoB, novaSenha: 'Invasor@1234' });

      const res = await post('/redefinir', { email: EMAIL_B, codigo: codigoB, novaSenha: NEW_PASSWORD });

      expect(res.status).toBe(200);
      expect(await argon2.verify(contaB.senha, NEW_PASSWORD)).toBe(true);
      expect(contaB.save).toHaveBeenCalledTimes(1);
    });

    test('consulta por padrao nao revela outra conta pela resposta', async () => {
      const onlyA = await askCode(EMAIL_A);
      const first = await post('/validar-codigo', { email: { $regex: '^conta\\.a@' }, codigo: onlyA });
      const withEarlierAccount = await post('/validar-codigo', { email: { $regex: '^admin@|^conta\\.a@' }, codigo: onlyA });

      expectRejected(first);
      expectRejected(withEarlierAccount);
      expect(first.body).toEqual(withEarlierAccount.body);
      expectTokenUntouched(contaA);
    });

    test('o codigo de A nunca redefine a senha de B, nem em texto', async () => {
      const codigoA = await askAndValidate(EMAIL_A);
      await askAndValidate(EMAIL_B);

      const res = await post('/redefinir', { email: EMAIL_B, codigo: codigoA, novaSenha: NEW_PASSWORD });

      expectRejected(res);
      expectPasswordsUnchanged();
    });
  });

  describe('limite de tentativas por conta, com entradas em texto', () => {
    test('codigo errado em texto continua contando para a conta informada', async () => {
      await askCode(EMAIL_A);
      await askCode(EMAIL_B);

      const res = await post('/validar-codigo', { email: EMAIL_B, codigo: WRONG_CODE });

      expectRejected(res);
      expect(tokenOf(contaB).tentativas).toBe(1);
      expect(tokenOf(contaA).tentativas).toBe(0);
    });

    test('depois de cinco erros, o codigo certo responde 429 e remove o token', async () => {
      const codigo = await askCode(EMAIL_A);
      for (let attempt = 0; attempt < 5; attempt += 1) {
        await post('/validar-codigo', { email: EMAIL_A, codigo: WRONG_CODE });
      }

      const res = await post('/validar-codigo', { email: EMAIL_A, codigo });

      expect(res.status).toBe(429);
      expect(tokenOf(contaA)).toBeUndefined();
    });
  });
});
