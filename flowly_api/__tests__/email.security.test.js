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

jest.mock('../utils/faceAuth', () => ({
  buildUserPayload: jest.fn(),
  issueAuthToken: jest.fn(),
}));

const User = require('../models/User');
const TwoFactorToken = require('../models/TwoFactorToken');
const emailController = require('../controllers/emailController');

const createResponse = () => {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
};

describe('seguranca dos fluxos de email', () => {
  beforeEach(() => jest.clearAllMocks());

  test('recuperacao responde da mesma forma para email existente e inexistente', async () => {
    const unknownResponse = createResponse();
    User.findOne.mockResolvedValueOnce(null);
    await emailController.enviarCodigoRecuperacaoSenha(
      { body: { email: 'naoexiste@teste.com' } },
      unknownResponse
    );

    const existingResponse = createResponse();
    User.findOne.mockResolvedValueOnce({ _id: 'user-1', nome: 'User' });
    await emailController.enviarCodigoRecuperacaoSenha(
      { body: { email: 'existe@teste.com' } },
      existingResponse
    );

    expect(unknownResponse.status).toHaveBeenCalledWith(200);
    expect(existingResponse.status).toHaveBeenCalledWith(200);
    expect(existingResponse.json.mock.calls[0][0]).toEqual(
      unknownResponse.json.mock.calls[0][0]
    );
  });

  test('codigo de recuperacao fica armazenado somente como hash', async () => {
    User.findOne.mockResolvedValue({ _id: 'user-1', nome: 'User' });
    await emailController.enviarCodigoRecuperacaoSenha(
      { body: { email: 'existe@teste.com' } },
      createResponse()
    );

    expect(TwoFactorToken).toHaveBeenCalledWith(
      expect.objectContaining({ codigo: expect.stringMatching(/^[a-f0-9]{64}$/) })
    );
  });

  test('validacao nao diferencia usuario inexistente de codigo incorreto', async () => {
    const unknownResponse = createResponse();
    User.findOne.mockResolvedValueOnce(null);
    await emailController.validarCodigoRecuperacaoSenha(
      { body: { email: 'naoexiste@teste.com', codigo: '123456' } },
      unknownResponse
    );

    const wrongCodeResponse = createResponse();
    User.findOne.mockResolvedValueOnce({ _id: 'user-1' });
    TwoFactorToken.findOne.mockResolvedValueOnce(null);
    await emailController.validarCodigoRecuperacaoSenha(
      { body: { email: 'existe@teste.com', codigo: '123456' } },
      wrongCodeResponse
    );

    expect(unknownResponse.status).toHaveBeenCalledWith(401);
    expect(wrongCodeResponse.status).toHaveBeenCalledWith(401);
    expect(wrongCodeResponse.json.mock.calls[0][0]).toEqual(
      unknownResponse.json.mock.calls[0][0]
    );
  });
});
