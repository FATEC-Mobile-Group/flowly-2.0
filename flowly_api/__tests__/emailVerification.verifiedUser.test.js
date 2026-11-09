const crypto = require('crypto');
const request = require('supertest');
const argon2 = require('argon2');

const mockDb = { users: [], tokens: [], faces: [], sequence: 0 };
const mockGoodFace = 'rosto-correto';

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

jest.mock('../services/faceService', () => {
  const verify = async (_reference, image) => ({
    face_detected: true,
    match: image === mockGoodFace,
    distance: 0.1,
  });
  return { verifyFace: jest.fn(verify), verifyFaceMulti: jest.fn(verify) };
});

const mockMatches = (actual, expected) => {
  if (expected && Array.isArray(expected.$in)) {
    return expected.$in.some((item) => (item === null ? actual == null : String(item) === String(actual)));
  }
  return String(actual) === String(expected);
};

const mockFilter = (record, filter) =>
  Object.entries(filter).every(([key, expected]) => mockMatches(record[key], expected));

jest.mock('../models/User', () => {
  const { ObjectId } = jest.requireActual('mongoose').Types;

  function User(data) {
    Object.assign(this, {
      _id: new ObjectId(),
      tipo: 'user',
      verificado: false,
      fotoPerfil: '',
      faceEnrollmentOffered: false,
      faceEnrollmentSkipped: false,
      ...data,
    });
    this.save = jest.fn(async () => {
      if (!mockDb.users.includes(this)) mockDb.users.push(this);
      return this;
    });
  }
  User.findOne = jest.fn(async (filter) => mockDb.users.find((user) => mockFilter(user, filter)) || null);
  User.findById = jest.fn(async (id) => mockDb.users.find((user) => String(user._id) === String(id)) || null);
  // Update condicional que conclui a oferta facial.
  User.findOneAndUpdate = jest.fn(async ({ _id }, update) => {
    const user = mockDb.users.find((item) => String(item._id) === String(_id));
    return user && !user.faceEnrollmentOfferConcluded ? Object.assign(user, update.$set) : null;
  });
  return User;
});

jest.mock('../models/FaceProfile', () => ({
  findOne: jest.fn(async (filter) => mockDb.faces.find((face) => mockFilter(face, filter)) || null),
}));

jest.mock('../models/TwoFactorToken', () => {
  function Token(data) {
    mockDb.sequence += 1;
    Object.assign(this, { _id: `token-${mockDb.sequence}`, validado: false, tentativas: 0, ...data });
  }
  // Como no Mongoose: salvar de novo um registro que ja saiu do banco falha.
  Token.prototype.save = async function save() {
    if (this.persisted && !mockDb.tokens.includes(this)) {
      throw new Error('No document found');
    }
    this.persisted = true;
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
    if (record && update.$set) Object.assign(record, update.$set);
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
const emailController = require('../controllers/emailController');
const { verifyAuthToken } = require('../utils/faceAuth');
const app = require('../app');

const PASSWORD = 'SenhaOriginal@1';
const NEW_PASSWORD = 'NovaSenha@456';
const EMAIL_NEW = 'nova@exemplo.com';
const EMAIL_VERIFIED = 'verificada@exemplo.com';
const EMAIL_FACE = 'rosto@exemplo.com';
const EMAIL_ADMIN = 'admin@exemplo.com';
const EMAIL_ADMIN_FACE = 'admin.rosto@exemplo.com';
const SEEDED_CODE = '123456';
const WRONG_CODE = '000000';
const SEEDED_LINK = 'a'.repeat(64);
const GENERIC_SEND_MESSAGE = 'Se o email estiver cadastrado, um codigo sera enviado.';
const INVALID_CODE_MESSAGE = 'Codigo de verificacao invalido ou expirado.';
const INVALID_LINK_MESSAGE = 'Token inválido ou expirado.';

const sha256 = (value) => crypto.createHash('sha256').update(String(value)).digest('hex');

const post = (path, body) => request(app).post(`/api/auth${path}`).send(body);
const sendCode = (email) => post('/2fa/enviar-codigo', { email });
const validateCode = (body) => post('/2fa/validar-codigo', body);
const validateLink = (token) => request(app).get('/api/auth/2fa/validar-token').query({ token });
const login = (email, senha = PASSWORD) => post('/login', { email, senha });
const verifyFace = (faceSessionToken, imageBase64) =>
  request(app).post('/api/face/verify').send({ faceSessionToken, imageBase64 });
const skipFaceOffer = (faceSessionToken) =>
  request(app).post('/api/face/skip-enrollment').send({ faceSessionToken });
const register = (email) =>
  post('/registrar', { nome: 'Pessoa Nova', email, senha: PASSWORD, termsAccepted: true, termsVersion: '2026-06-08' });

const lastMail = () => sendEmail.mock.calls.at(-1)[3];
const lastCode = () => lastMail().match(/class="code">(\d{6})</)[1];
const lastLink = () => lastMail().match(/verificar-2fa\?token=([a-f0-9]{64})/)[1];

describe('verificacao de e-mail nao funciona como login em conta ja verificada', () => {
  let passwordHash;

  beforeAll(async () => {
    passwordHash = await argon2.hash(PASSWORD);
  });

  const createAccount = (email, data = {}) => {
    const user = new User({ nome: `Nome ${email}`, email, senha: passwordHash, ...data });
    mockDb.users.push(user);
    return user;
  };

  const verifiedAccount = (email = EMAIL_VERIFIED, data = {}) =>
    createAccount(email, {
      verificado: true,
      faceEnrollmentOffered: true,
      faceEnrollmentSkipped: true,
      ...data,
    });

  const accountWithFace = (email = EMAIL_FACE, data = {}) => {
    const user = verifiedAccount(email, { faceEnrollmentSkipped: false, ...data });
    mockDb.faces.push({ userId: user._id, enrolled: true, embeddings: [[1, 0, 0]] });
    return user;
  };

  // Token gravado direto no banco: independe da protecao do envio.
  const seedToken = async (user, data = {}) => {
    const token = new TwoFactorToken({
      userId: user._id,
      codigo: sha256(SEEDED_CODE),
      token: sha256(SEEDED_LINK),
      purpose: 'email_verification',
      ...data,
    });
    await token.save();
    return token;
  };

  // Emite pelo fluxo real enquanto a conta nao esta verificada e so entao muda o estado dela.
  const issueResidual = async (user) => {
    const sent = await sendCode(user.email);
    expect(sent.status).toBe(200);
    const pending = { codigo: lastCode(), link: lastLink() };
    user.verificado = true;
    user.save.mockClear();
    return pending;
  };

  // Como no banco real: a gravacao falha e a proxima consulta ve a conta ainda nao verificada.
  const failNextAccountSave = (user) => {
    user.save.mockImplementationOnce(async () => {
      user.verificado = false;
      throw new Error('falha simulada');
    });
  };

  const expectAccessTokenOf = (res, user) => {
    const decoded = verifyAuthToken(res.body.token);
    expect(String(decoded.id)).toBe(String(user._id));
    expect(decoded.tokenType).toBe('access');
    expect(decoded.tipo).toBe(user.tipo);
  };

  const expectCodeBlocked = (res) => {
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ message: INVALID_CODE_MESSAGE });
  };

  const expectLinkBlocked = (res) => {
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ message: INVALID_LINK_MESSAGE });
  };

  const expectUntouched = (user) => {
    expect(user.verificado).toBe(true);
    expect(user.save).not.toHaveBeenCalled();
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockDb.users = [];
    mockDb.tokens = [];
    mockDb.faces = [];
  });

  describe('A: primeira verificacao por codigo', () => {
    test('conta nao verificada recebe codigo, fica verificada e recebe o proprio JWT', async () => {
      const user = createAccount(EMAIL_NEW);

      const sent = await sendCode(EMAIL_NEW);
      expect(sent.status).toBe(200);
      expect(sendEmail).toHaveBeenCalledTimes(1);

      const res = await validateCode({ email: EMAIL_NEW, codigo: lastCode() });

      expect(res.status).toBe(200);
      expect(user.verificado).toBe(true);
      expect(user.save).toHaveBeenCalledTimes(1);
      expectAccessTokenOf(res, user);
      expect(res.body.redirect).toBe('/dashboard');
      expect(mockDb.tokens[0].validado).toBe(true);
    });

    test('tambem funciona informando userId em texto', async () => {
      const user = createAccount(EMAIL_NEW);
      await sendCode(EMAIL_NEW);

      const res = await validateCode({ userId: String(user._id), codigo: lastCode() });

      expect(res.status).toBe(200);
      expectAccessTokenOf(res, user);
    });

    test('tambem funciona com o e-mail equivalente do D08', async () => {
      const user = createAccount(EMAIL_NEW);
      await sendCode('  NOVA@Exemplo.com ');

      const res = await validateCode({ email: ' Nova@EXEMPLO.COM ', codigo: lastCode() });

      expect(res.status).toBe(200);
      expectAccessTokenOf(res, user);
    });

    test('codigo usado nao emite outro JWT', async () => {
      const user = createAccount(EMAIL_NEW);
      await sendCode(EMAIL_NEW);
      const codigo = lastCode();
      await validateCode({ email: EMAIL_NEW, codigo });

      const res = await validateCode({ email: EMAIL_NEW, codigo });

      expectCodeBlocked(res);
      expect(user.verificado).toBe(true);
    });

    test('falha ao salvar a conta nao emite JWT nem gasta o codigo', async () => {
      const user = createAccount(EMAIL_NEW);
      await sendCode(EMAIL_NEW);
      const codigo = lastCode();
      failNextAccountSave(user);

      const failed = await validateCode({ email: EMAIL_NEW, codigo });

      expect(failed.status).toBe(500);
      expect(failed.body.token).toBeUndefined();
      expect(mockDb.tokens[0].validado).toBe(false);

      const retried = await validateCode({ email: EMAIL_NEW, codigo });
      expect(retried.status).toBe(200);
      expectAccessTokenOf(retried, user);
    });

    test('limite de tentativas continua respondendo 429 para conta nao verificada', async () => {
      const user = createAccount(EMAIL_NEW);
      await sendCode(EMAIL_NEW);
      const codigo = lastCode();
      mockDb.tokens[0].tentativas = 5;

      const res = await validateCode({ email: EMAIL_NEW, codigo });

      expect(res.status).toBe(429);
      expect(res.body.token).toBeUndefined();
      expect(user.verificado).toBe(false);
      expect(mockDb.tokens).toHaveLength(0);
    });
  });

  describe('B: primeira verificacao por link', () => {
    test('conta nao verificada fica verificada e recebe o proprio JWT', async () => {
      const user = createAccount(EMAIL_NEW);
      await sendCode(EMAIL_NEW);

      const res = await validateLink(lastLink());

      expect(res.status).toBe(200);
      expect(user.verificado).toBe(true);
      expect(user.save).toHaveBeenCalledTimes(1);
      expectAccessTokenOf(res, user);
      expect(res.body.redirect).toBe('/dashboard');
      expect(mockDb.tokens[0].validado).toBe(true);
    });

    test('reabrir o mesmo link nao emite outro JWT', async () => {
      createAccount(EMAIL_NEW);
      await sendCode(EMAIL_NEW);
      const link = lastLink();
      await validateLink(link);

      expectLinkBlocked(await validateLink(link));
    });

    test('codigo e link do mesmo e-mail nao emitem dois JWTs', async () => {
      createAccount(EMAIL_NEW);
      await sendCode(EMAIL_NEW);
      const link = lastLink();
      await validateCode({ email: EMAIL_NEW, codigo: lastCode() });

      expectLinkBlocked(await validateLink(link));
    });

    test('falha ao salvar a conta nao emite JWT nem gasta o link', async () => {
      const user = createAccount(EMAIL_NEW);
      await sendCode(EMAIL_NEW);
      const link = lastLink();
      failNextAccountSave(user);

      const failed = await validateLink(link);

      expect(failed.status).toBe(500);
      expect(failed.body.token).toBeUndefined();
      expect(mockDb.tokens[0].validado).toBe(false);

      const retried = await validateLink(link);
      expect(retried.status).toBe(200);
      expectAccessTokenOf(retried, user);
    });
  });

  describe('C: conta ja verificada nao recebe novo codigo util', () => {
    test('responde a mensagem generica, sem e-mail e sem token', async () => {
      verifiedAccount();

      const res = await sendCode(EMAIL_VERIFIED);

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ message: GENERIC_SEND_MESSAGE });
      expect(sendEmail).not.toHaveBeenCalled();
      expect(mockDb.tokens).toHaveLength(0);
    });

    test.each([
      ['maiusculas', 'VERIFICADA@Exemplo.COM'],
      ['espacos', '  verificada@exemplo.com  '],
    ])('e-mail equivalente com %s tambem nao recebe codigo', async (_label, email) => {
      verifiedAccount();

      const res = await sendCode(email);

      expect(res.status).toBe(200);
      expect(sendEmail).not.toHaveBeenCalled();
      expect(mockDb.tokens).toHaveLength(0);
    });

    test('resposta igual para verificada, inexistente e nao verificada', async () => {
      verifiedAccount();
      createAccount(EMAIL_NEW);

      const verified = await sendCode(EMAIL_VERIFIED);
      const unknown = await sendCode('ninguem@exemplo.com');
      const pending = await sendCode(EMAIL_NEW);

      expect(verified.status).toBe(unknown.status);
      expect(verified.status).toBe(pending.status);
      expect(verified.body).toEqual(unknown.body);
      expect(verified.body).toEqual(pending.body);
      expect(sendEmail).toHaveBeenCalledTimes(1);
      expect(sendEmail.mock.calls[0][0]).toBe(EMAIL_NEW);
    });

    test('nao substitui nem renova um token pendente', async () => {
      const user = verifiedAccount();
      const pending = await seedToken(user);

      await sendCode(EMAIL_VERIFIED);

      expect(mockDb.tokens).toEqual([pending]);
      expect(TwoFactorToken.deleteMany).not.toHaveBeenCalled();
    });

    test('a funcao interna reutilizada pelo cadastro aplica a mesma regra', async () => {
      verifiedAccount();

      await emailController.enviarCodigoVerificacaoEmail(EMAIL_VERIFIED);

      expect(sendEmail).not.toHaveBeenCalled();
      expect(mockDb.tokens).toHaveLength(0);
    });
  });

  describe('D: conta ja verificada com codigo correto', () => {
    test('por e-mail responde 401 generico e sem JWT', async () => {
      const user = verifiedAccount();
      await seedToken(user);

      const res = await validateCode({ email: EMAIL_VERIFIED, codigo: SEEDED_CODE });

      expectCodeBlocked(res);
      expectUntouched(user);
    });

    test('por userId responde 401 generico e sem JWT', async () => {
      const user = verifiedAccount();
      await seedToken(user);

      const res = await validateCode({ userId: String(user._id), codigo: SEEDED_CODE });

      expectCodeBlocked(res);
      expectUntouched(user);
    });

    test('por e-mail equivalente do D08 responde 401 generico e sem JWT', async () => {
      const user = verifiedAccount();
      await seedToken(user);

      const res = await validateCode({ email: ' VERIFICADA@Exemplo.COM ', codigo: SEEDED_CODE });

      expectCodeBlocked(res);
      expectUntouched(user);
    });

    test('valor diferente de false nao autoriza a emissao', async () => {
      const user = verifiedAccount(EMAIL_VERIFIED, { verificado: undefined });
      await seedToken(user);

      const res = await validateCode({ email: EMAIL_VERIFIED, codigo: SEEDED_CODE });

      expectCodeBlocked(res);
      expect(user.save).not.toHaveBeenCalled();
    });

    test('valor diferente de false nao recebe codigo novo', async () => {
      verifiedAccount(EMAIL_VERIFIED, { verificado: undefined });

      await sendCode(EMAIL_VERIFIED);

      expect(sendEmail).not.toHaveBeenCalled();
    });
  });

  describe('E: conta ja verificada com link correto', () => {
    test('responde 401 generico e sem JWT', async () => {
      const user = verifiedAccount();
      await seedToken(user);

      const res = await validateLink(SEEDED_LINK);

      expectLinkBlocked(res);
      expectUntouched(user);
    });

    test('valor diferente de false nao autoriza a emissao', async () => {
      const user = verifiedAccount(EMAIL_VERIFIED, { verificado: undefined });
      await seedToken(user);

      const res = await validateLink(SEEDED_LINK);

      expectLinkBlocked(res);
      expect(user.save).not.toHaveBeenCalled();
    });

    test('token cuja conta nao existe mais responde 401 e sem JWT', async () => {
      const removed = verifiedAccount();
      await seedToken(removed);
      mockDb.users = [];

      expectLinkBlocked(await validateLink(SEEDED_LINK));
    });
  });

  describe('F: token residual emitido antes de a conta ficar verificada', () => {
    test('codigo pendente nao gera acesso', async () => {
      const user = createAccount(EMAIL_NEW);
      const { codigo } = await issueResidual(user);

      const res = await validateCode({ email: EMAIL_NEW, codigo });

      expectCodeBlocked(res);
      expectUntouched(user);
    });

    test('link pendente nao gera acesso', async () => {
      const user = createAccount(EMAIL_NEW);
      const { link } = await issueResidual(user);

      const res = await validateLink(link);

      expectLinkBlocked(res);
      expectUntouched(user);
    });

    test('tentativa com codigo marca o registro como usado e tambem encerra o link', async () => {
      const user = createAccount(EMAIL_NEW);
      const { codigo, link } = await issueResidual(user);

      await validateCode({ email: EMAIL_NEW, codigo });

      expect(mockDb.tokens[0].validado).toBe(true);
      expectCodeBlocked(await validateCode({ email: EMAIL_NEW, codigo }));
      expectLinkBlocked(await validateLink(link));
      expectUntouched(user);
    });

    test('tentativa com link marca o registro como usado e tambem encerra o codigo', async () => {
      const user = createAccount(EMAIL_NEW);
      const { codigo, link } = await issueResidual(user);

      await validateLink(link);

      expect(mockDb.tokens[0].validado).toBe(true);
      expectLinkBlocked(await validateLink(link));
      expectCodeBlocked(await validateCode({ email: EMAIL_NEW, codigo }));
      expectUntouched(user);
    });

    test('no limite de tentativas responde 401, sem revelar que o codigo estava certo', async () => {
      const user = createAccount(EMAIL_NEW);
      const { codigo } = await issueResidual(user);
      mockDb.tokens[0].tentativas = 5;

      expectCodeBlocked(await validateCode({ email: EMAIL_NEW, codigo }));
      expectUntouched(user);
    });

    test('codigo errado nao gasta o registro, mas o certo continua sem gerar acesso', async () => {
      const user = createAccount(EMAIL_NEW);
      const { codigo } = await issueResidual(user);

      expectCodeBlocked(await validateCode({ email: EMAIL_NEW, codigo: WRONG_CODE }));
      expect(mockDb.tokens[0].validado).toBe(false);
      expect(mockDb.tokens[0].tentativas).toBe(1);

      expectCodeBlocked(await validateCode({ email: EMAIL_NEW, codigo }));
      expectUntouched(user);
    });

    test('o token de outra conta nao e afetado', async () => {
      const user = createAccount(EMAIL_NEW);
      const other = createAccount('outra@exemplo.com');
      const { codigo } = await issueResidual(user);
      await sendCode(other.email);
      const otherCode = lastCode();

      await validateCode({ email: EMAIL_NEW, codigo });

      const res = await validateCode({ email: other.email, codigo: otherCode });
      expect(res.status).toBe(200);
      expectAccessTokenOf(res, other);
    });
  });

  describe('validacao concorrente da primeira verificacao', () => {
    // Executa a segunda validacao entre salvar a conta e salvar o token da primeira.
    // Nesse instante o banco ainda guarda validado=false, embora a primeira ja o tenha mudado em memoria.
    const runDuringTokenSave = (action) => {
      const originalSave = TwoFactorToken.prototype.save;
      const captured = {};
      TwoFactorToken.prototype.save = async function save() {
        TwoFactorToken.prototype.save = originalSave;
        this.validado = false;
        captured.res = await action();
        this.validado = true;
        return originalSave.call(this);
      };
      return captured;
    };

    test('segunda tentativa por codigo nao derruba a primeira', async () => {
      const user = createAccount(EMAIL_NEW);
      await sendCode(EMAIL_NEW);
      const codigo = lastCode();
      const second = runDuringTokenSave(() => validateCode({ email: EMAIL_NEW, codigo }));

      const first = await validateCode({ email: EMAIL_NEW, codigo });

      expect(first.status).toBe(200);
      expectAccessTokenOf(first, user);
      expectCodeBlocked(second.res);
    });

    test('segunda tentativa por link nao derruba a primeira', async () => {
      const user = createAccount(EMAIL_NEW);
      await sendCode(EMAIL_NEW);
      const link = lastLink();
      const second = runDuringTokenSave(() => validateLink(link));

      const first = await validateLink(link);

      expect(first.status).toBe(200);
      expectAccessTokenOf(first, user);
      expectLinkBlocked(second.res);
    });
  });

  describe('G: conta com rosto', () => {
    test('codigo nao gera JWT nem sessao facial', async () => {
      const user = accountWithFace();
      await seedToken(user);

      const res = await validateCode({ email: EMAIL_FACE, codigo: SEEDED_CODE });

      expectCodeBlocked(res);
      expectUntouched(user);
    });

    test('link nao gera JWT nem sessao facial', async () => {
      const user = accountWithFace();
      await seedToken(user);

      const res = await validateLink(SEEDED_LINK);

      expectLinkBlocked(res);
      expectUntouched(user);
    });

    test('nao recebe novo codigo', async () => {
      accountWithFace();

      await sendCode(EMAIL_FACE);

      expect(sendEmail).not.toHaveBeenCalled();
      expect(mockDb.tokens).toHaveLength(0);
    });

    test('login continua exigindo o rosto antes do JWT', async () => {
      const user = accountWithFace();

      const logged = await login(EMAIL_FACE);

      expect(logged.status).toBe(200);
      expect(logged.body.requiresFaceVerification).toBe(true);
      expect(logged.body.token).toBeUndefined();
      expect(() => verifyAuthToken(logged.body.faceSessionToken)).toThrow();

      const wrongFace = await verifyFace(logged.body.faceSessionToken, 'outro-rosto');
      expect(wrongFace.status).toBe(401);
      expect(wrongFace.body.token).toBeUndefined();

      const rightFace = await verifyFace(logged.body.faceSessionToken, mockGoodFace);
      expect(rightFace.status).toBe(200);
      expectAccessTokenOf(rightFace, user);
    });
  });

  describe('H: admin', () => {
    test.each([
      ['sem rosto', EMAIL_ADMIN, false],
      ['com rosto', EMAIL_ADMIN_FACE, true],
    ])('admin %s nao recebe JWT por codigo nem por link', async (_label, email, withFace) => {
      const user = withFace
        ? accountWithFace(email, { tipo: 'admin' })
        : verifiedAccount(email, { tipo: 'admin' });
      await seedToken(user);

      expectCodeBlocked(await validateCode({ email, codigo: SEEDED_CODE }));

      await seedToken(user);
      expectLinkBlocked(await validateLink(SEEDED_LINK));
      expectUntouched(user);
    });

    test('admin verificado nao recebe novo codigo', async () => {
      verifiedAccount(EMAIL_ADMIN, { tipo: 'admin' });

      await sendCode(EMAIL_ADMIN);

      expect(sendEmail).not.toHaveBeenCalled();
      expect(mockDb.tokens).toHaveLength(0);
    });

    test('login de admin sem rosto preserva o comportamento atual', async () => {
      const user = verifiedAccount(EMAIL_ADMIN, { tipo: 'admin' });

      const res = await login(EMAIL_ADMIN);

      expect(res.status).toBe(200);
      expect(res.body.faceSessionToken).toBeUndefined();
      expectAccessTokenOf(res, user);
    });

    test('login de admin com rosto exige o rosto (D29)', async () => {
      const user = accountWithFace(EMAIL_ADMIN_FACE, { tipo: 'admin' });

      const logged = await login(EMAIL_ADMIN_FACE);

      expect(logged.status).toBe(200);
      expect(logged.body.requiresFaceVerification).toBe(true);
      expect(logged.body.token).toBeUndefined();
      expectAccessTokenOf(await verifyFace(logged.body.faceSessionToken, mockGoodFace), user);
    });
  });

  describe('I: recuperacao de senha nao e afetada', () => {
    const recover = async (email) => {
      const sent = await post('/recuperar-senha/enviar-codigo', { email });
      expect(sent.status).toBe(200);
      const codigo = lastCode();
      const validated = await post('/recuperar-senha/validar-codigo', { email, codigo });
      const reset = await post('/recuperar-senha/redefinir', { email, codigo, novaSenha: NEW_PASSWORD });
      return { sent, validated, reset };
    };

    test('conta verificada recebe codigo e redefine a senha', async () => {
      const user = verifiedAccount();

      const { validated, reset } = await recover(EMAIL_VERIFIED);

      expect(sendEmail).toHaveBeenCalledTimes(1);
      expect(validated.status).toBe(200);
      expect(reset.status).toBe(200);
      expect(await argon2.verify(user.senha, NEW_PASSWORD)).toBe(true);
    });

    test('depois da recuperacao, conta verificada entra pelo login normal', async () => {
      const user = verifiedAccount();
      await recover(EMAIL_VERIFIED);

      const res = await login(EMAIL_VERIFIED, NEW_PASSWORD);

      expect(res.status).toBe(200);
      expectAccessTokenOf(res, user);
    });

    test('depois da recuperacao, conta com rosto continua exigindo o rosto', async () => {
      accountWithFace();
      await recover(EMAIL_FACE);

      const res = await login(EMAIL_FACE, NEW_PASSWORD);

      expect(res.body.requiresFaceVerification).toBe(true);
      expect(res.body.token).toBeUndefined();
    });

    test('conta nao verificada continua podendo recuperar a senha, sem ficar verificada', async () => {
      const user = createAccount(EMAIL_NEW);

      const { reset } = await recover(EMAIL_NEW);

      expect(reset.status).toBe(200);
      expect(user.verificado).toBe(false);
      expect((await login(EMAIL_NEW, NEW_PASSWORD)).status).toBe(403);
    });

    test('codigo de recuperacao de conta verificada nao autentica na verificacao', async () => {
      verifiedAccount();
      await post('/recuperar-senha/enviar-codigo', { email: EMAIL_VERIFIED });
      const codigo = lastCode();

      expectCodeBlocked(await validateCode({ email: EMAIL_VERIFIED, codigo }));
      expect(mockDb.tokens).toHaveLength(1);
      expect(mockDb.tokens[0].purpose).toBe('password_reset');
    });

    test('tentativa bloqueada na verificacao nao gasta o token de recuperacao', async () => {
      const user = verifiedAccount();
      await post('/recuperar-senha/enviar-codigo', { email: EMAIL_VERIFIED });
      const codigo = lastCode();
      await seedToken(user);

      await validateCode({ email: EMAIL_VERIFIED, codigo: SEEDED_CODE });

      const res = await post('/recuperar-senha/validar-codigo', { email: EMAIL_VERIFIED, codigo });
      expect(res.status).toBe(200);
    });
  });

  describe('J: mensagens nao permitem enumeracao', () => {
    test('validar-codigo responde igual para inexistente, verificada e codigo errado', async () => {
      const verified = verifiedAccount();
      createAccount(EMAIL_NEW);
      await sendCode(EMAIL_NEW);
      await seedToken(verified);

      const responses = [
        await validateCode({ email: 'ninguem@exemplo.com', codigo: SEEDED_CODE }),
        await validateCode({ email: EMAIL_VERIFIED, codigo: WRONG_CODE }),
        await validateCode({ email: EMAIL_VERIFIED, codigo: SEEDED_CODE }),
        await validateCode({ email: EMAIL_NEW, codigo: WRONG_CODE }),
      ];

      responses.forEach(expectCodeBlocked);
    });

    test('verificada sem token pendente responde igual a inexistente', async () => {
      verifiedAccount();

      const verified = await validateCode({ email: EMAIL_VERIFIED, codigo: SEEDED_CODE });
      const unknown = await validateCode({ email: 'ninguem@exemplo.com', codigo: SEEDED_CODE });

      expect(verified.status).toBe(unknown.status);
      expect(verified.body).toEqual(unknown.body);
    });

    test('validar-token responde igual para link inexistente, usado e de conta verificada', async () => {
      const verified = verifiedAccount();
      await seedToken(verified);
      createAccount(EMAIL_NEW);
      await sendCode(EMAIL_NEW);
      const used = lastLink();
      await validateLink(used);

      const responses = [
        await validateLink('b'.repeat(64)),
        await validateLink(used),
        await validateLink(SEEDED_LINK),
      ];

      responses.forEach(expectLinkBlocked);
    });
  });

  describe('cadastro completo', () => {
    test('por codigo, seguido de nova sessao pelo fluxo normal', async () => {
      const registered = await register(EMAIL_NEW);
      expect(registered.status).toBe(201);
      expect(registered.body.token).toBeUndefined();
      const user = mockDb.users.find((item) => item.email === EMAIL_NEW);
      expect(user.verificado).toBe(false);
      expect(sendEmail).toHaveBeenCalledTimes(1);

      const validated = await validateCode({ email: EMAIL_NEW, codigo: lastCode() });
      expect(validated.status).toBe(200);
      expect(user.verificado).toBe(true);
      expectAccessTokenOf(validated, user);

      const offer = await login(EMAIL_NEW);
      expect(offer.status).toBe(200);
      expect(offer.body.requiresFaceEnrollmentOffer).toBe(true);
      expect(offer.body.token).toBeUndefined();

      const skipped = await skipFaceOffer(offer.body.faceSessionToken);
      expect(skipped.status).toBe(200);
      expectAccessTokenOf(skipped, user);

      const next = await login(EMAIL_NEW);
      expect(next.status).toBe(200);
      expectAccessTokenOf(next, user);
    });

    test('por link, seguido de nova sessao pelo fluxo normal', async () => {
      await register(EMAIL_NEW);
      const user = mockDb.users.find((item) => item.email === EMAIL_NEW);

      const validated = await validateLink(lastLink());
      expect(validated.status).toBe(200);
      expect(user.verificado).toBe(true);
      expectAccessTokenOf(validated, user);

      const offer = await login(EMAIL_NEW);
      expect(offer.status).toBe(200);
      expect(offer.body.requiresFaceEnrollmentOffer).toBe(true);
      expect(offer.body.token).toBeUndefined();
    });

    test('depois de verificada, a conta recem-criada ja nao recebe outro codigo', async () => {
      await register(EMAIL_NEW);
      await validateCode({ email: EMAIL_NEW, codigo: lastCode() });
      sendEmail.mockClear();

      const res = await sendCode(EMAIL_NEW);

      expect(res.status).toBe(200);
      expect(sendEmail).not.toHaveBeenCalled();
    });
  });

  describe('usuario que fechou a tela antes de verificar', () => {
    test('login leva de volta a verificacao, reenviar e validar funcionam', async () => {
      await register(EMAIL_NEW);
      const user = mockDb.users.find((item) => item.email === EMAIL_NEW);
      const firstToken = mockDb.tokens[0];

      const blocked = await login(EMAIL_NEW);
      expect(blocked.status).toBe(403);
      expect(blocked.body.token).toBeUndefined();
      expect(blocked.body.redirectTo).toContain('/verificar-2fa');

      const resent = await sendCode(EMAIL_NEW);
      expect(resent.status).toBe(200);
      expect(sendEmail).toHaveBeenCalledTimes(2);
      expect(mockDb.tokens).toHaveLength(1);
      expect(mockDb.tokens[0]).not.toBe(firstToken);

      const validated = await validateCode({ email: EMAIL_NEW, codigo: lastCode() });
      expect(validated.status).toBe(200);
      expect(user.verificado).toBe(true);
      expectAccessTokenOf(validated, user);

      const next = await login(EMAIL_NEW);
      expect(next.status).toBe(200);
      expect(next.body.requiresFaceEnrollmentOffer).toBe(true);
    });

    test('link do cadastro ainda serve se a conta continua nao verificada', async () => {
      await register(EMAIL_NEW);
      const user = mockDb.users.find((item) => item.email === EMAIL_NEW);

      expect((await login(EMAIL_NEW)).status).toBe(403);

      const res = await validateLink(lastLink());
      expect(res.status).toBe(200);
      expectAccessTokenOf(res, user);
    });
  });
});
