/**
 * PR-01 — Fluxo de verificação de e-mail (link e código).
 *
 * Usa o issueAuthToken/verifyAuthToken reais e o middleware de autenticação real,
 * simulando apenas o banco (User/TwoFactorToken), o envio de e-mail e o storage.
 */

jest.mock('../models/Equipe', () => ({}));

jest.mock('../models/User', () => ({
  findOne: jest.fn(),
  findById: jest.fn(),
}));

jest.mock('../models/TwoFactorToken', () => {
  const Token = jest.fn().mockImplementation((data) => ({
    ...data,
    save: jest.fn().mockResolvedValue(data),
  }));
  Token.deleteMany = jest.fn().mockResolvedValue({});
  Token.findOne = jest.fn();
  Token.updateOne = jest.fn().mockResolvedValue({});
  Token.deleteOne = jest.fn().mockResolvedValue({});
  return Token;
});

jest.mock('../utils/sendEmail', () => jest.fn().mockResolvedValue(true));

jest.mock('../services/storage', () => ({
  getSignedUrl: jest.fn().mockResolvedValue(''),
}));

const crypto = require('crypto');
const User = require('../models/User');
const TwoFactorToken = require('../models/TwoFactorToken');
const sendEmail = require('../utils/sendEmail');
const emailController = require('../controllers/emailController');
const authMiddleware = require('../middlewares/auth');
const { verifyAuthToken } = require('../utils/faceAuth');

const USER_ID = '64b7f0c2a1b2c3d4e5f60718';
const sha256 = (value) => crypto.createHash('sha256').update(String(value)).digest('hex');

const createResponse = () => {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
};

const createUser = () => ({
  _id: USER_ID,
  nome: 'Usuario Teste',
  email: 'usuario@teste.com',
  tipo: 'user',
  verificado: false,
  fotoPerfil: '',
  save: jest.fn().mockResolvedValue(true),
});

// Simula a coleção: o findOne só encontra o registro se o filtro bater com o que foi salvo.
const mockTokenCollection = (storedRecords) => {
  TwoFactorToken.findOne.mockImplementation(async (filter) => (
    storedRecords.find((record) => (
      (filter.token === undefined || record.token === filter.token) &&
      (filter.codigo === undefined || record.codigo === filter.codigo) &&
      (filter.userId === undefined || String(record.userId) === String(filter.userId)) &&
      record.validado === filter.validado
    )) || null
  ));
};

const toStoredRecord = (data) => ({
  ...data,
  validado: false,
  tentativas: 0,
  save: jest.fn().mockResolvedValue(true),
});

// Gera token/código pelo fluxo real de envio e devolve o que foi salvo e o que foi enviado por e-mail.
const issueVerification = async (user) => {
  User.findOne.mockResolvedValueOnce(user);
  await emailController.enviarCodigoVerificacaoEmail(user.email);

  const savedData = TwoFactorToken.mock.calls[0][0];
  const html = sendEmail.mock.calls[0][3];
  const linkToken = html.match(/verificar-2fa\?token=([a-f0-9]+)/)[1];
  const emailCode = html.match(/<div class="code">(\d{6})<\/div>/)[1];

  return { savedData, linkToken, emailCode };
};

const authenticateWith = (token) => {
  const req = { headers: { authorization: `Bearer ${token}` } };
  const res = createResponse();
  const next = jest.fn();
  authMiddleware(req, res, next);
  return { req, res, next };
};

describe('PR-01 — verificacao de e-mail', () => {
  beforeEach(() => jest.clearAllMocks());

  describe('A — link de verificacao', () => {
    test('banco guarda apenas o hash e o e-mail leva o token puro', async () => {
      const { savedData, linkToken } = await issueVerification(createUser());

      expect(savedData.token).toBe(sha256(linkToken));
      expect(savedData.token).not.toBe(linkToken);
      expect(savedData.purpose).toBe('email_verification');
    });

    test('link valido localiza o registro pelo hash e confirma o usuario', async () => {
      const user = createUser();
      const { savedData, linkToken } = await issueVerification(user);
      const record = toStoredRecord(savedData);
      mockTokenCollection([record]);
      User.findById.mockResolvedValueOnce(user);

      const res = createResponse();
      await emailController.validarTokenVerificacao({ query: { token: linkToken } }, res);

      expect(TwoFactorToken.findOne).toHaveBeenCalledWith({
        token: sha256(linkToken),
        purpose: { $in: ['email_verification', null] },
        validado: false,
      });
      expect(res.status).toHaveBeenCalledWith(200);
      expect(record.validado).toBe(true);
      expect(record.save).toHaveBeenCalled();
      expect(user.verificado).toBe(true);
      expect(user.save).toHaveBeenCalled();
    });

    test('token invalido e rejeitado', async () => {
      const { savedData } = await issueVerification(createUser());
      mockTokenCollection([toStoredRecord(savedData)]);

      const res = createResponse();
      await emailController.validarTokenVerificacao(
        { query: { token: crypto.randomBytes(32).toString('hex') } },
        res
      );

      expect(res.status).toHaveBeenCalledWith(401);
      expect(User.findById).not.toHaveBeenCalled();
    });

    test('o proprio hash armazenado nao funciona como token do link', async () => {
      const { savedData } = await issueVerification(createUser());
      mockTokenCollection([toStoredRecord(savedData)]);

      const res = createResponse();
      await emailController.validarTokenVerificacao({ query: { token: savedData.token } }, res);

      expect(res.status).toHaveBeenCalledWith(401);
    });

    test('link ja utilizado nao pode ser reutilizado', async () => {
      const { savedData, linkToken } = await issueVerification(createUser());
      mockTokenCollection([{ ...toStoredRecord(savedData), validado: true }]);

      const res = createResponse();
      await emailController.validarTokenVerificacao({ query: { token: linkToken } }, res);

      expect(res.status).toHaveBeenCalledWith(401);
    });

    test('token expirado (removido pelo TTL) e rejeitado', async () => {
      const { linkToken } = await issueVerification(createUser());
      mockTokenCollection([]);

      const res = createResponse();
      await emailController.validarTokenVerificacao({ query: { token: linkToken } }, res);

      expect(res.status).toHaveBeenCalledWith(401);
    });

    test('o modelo real expira o token em 15 minutos via TTL', () => {
      const RealTwoFactorToken = jest.requireActual('../models/TwoFactorToken');
      expect(RealTwoFactorToken.schema.path('criadoEm').options.expires).toBe(900);
    });
  });

  describe('B — codigo de verificacao', () => {
    test('retorna um JWT real e nao o hash do JWT', async () => {
      const user = createUser();
      const { savedData, emailCode } = await issueVerification(user);
      mockTokenCollection([toStoredRecord(savedData)]);
      User.findById.mockResolvedValueOnce(user);

      const res = createResponse();
      await emailController.validarCodigoVerificacao(
        { body: { userId: USER_ID, codigo: emailCode } },
        res
      );

      expect(res.status).toHaveBeenCalledWith(200);
      const { token } = res.json.mock.calls[0][0];

      expect(token.split('.')).toHaveLength(3);
      expect(token).not.toMatch(/^[a-f0-9]{64}$/);

      const decoded = verifyAuthToken(token);
      expect(String(decoded.id)).toBe(USER_ID);
      expect(decoded.tipo).toBe('user');
      expect(decoded.tokenType).toBe('access');
      expect(user.verificado).toBe(true);
    });

    test('codigo incorreto e rejeitado', async () => {
      const { savedData, emailCode } = await issueVerification(createUser());
      mockTokenCollection([toStoredRecord(savedData)]);
      const wrongCode = emailCode === '123456' ? '654321' : '123456';

      const res = createResponse();
      await emailController.validarCodigoVerificacao(
        { body: { userId: USER_ID, codigo: wrongCode } },
        res
      );

      expect(res.status).toHaveBeenCalledWith(401);
    });
  });

  describe('C — autenticacao com o token devolvido', () => {
    test('JWT devolvido pelo codigo passa no middleware de autenticacao', async () => {
      const user = createUser();
      const { savedData, emailCode } = await issueVerification(user);
      mockTokenCollection([toStoredRecord(savedData)]);
      User.findById.mockResolvedValueOnce(user);

      const res = createResponse();
      await emailController.validarCodigoVerificacao(
        { body: { userId: USER_ID, codigo: emailCode } },
        res
      );

      const { req, res: authRes, next } = authenticateWith(res.json.mock.calls[0][0].token);
      expect(next).toHaveBeenCalled();
      expect(authRes.status).not.toHaveBeenCalled();
      expect(String(req.user.id)).toBe(USER_ID);
    });

    test('JWT devolvido pelo link passa no middleware de autenticacao', async () => {
      const user = createUser();
      const { savedData, linkToken } = await issueVerification(user);
      mockTokenCollection([toStoredRecord(savedData)]);
      User.findById.mockResolvedValueOnce(user);

      const res = createResponse();
      await emailController.validarTokenVerificacao({ query: { token: linkToken } }, res);

      const { req, res: authRes, next } = authenticateWith(res.json.mock.calls[0][0].token);
      expect(next).toHaveBeenCalled();
      expect(authRes.status).not.toHaveBeenCalled();
      expect(String(req.user.id)).toBe(USER_ID);
    });
  });
});
