jest.mock('@google-cloud/storage', () => ({
  Storage: jest.fn().mockImplementation(() => ({
    bucket: jest.fn().mockReturnValue({ file: jest.fn() }),
  })),
}));

jest.mock('argon2', () => ({
  hash: jest.fn(),
  verify: jest.fn(),
}));

jest.mock('../models/User', () => ({
  find: jest.fn(),
  findById: jest.fn(),
}));

const User = require('../models/User');
const argon2 = require('argon2');
const userController = require('../controllers/userController');

const createResponse = () => {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
};

describe('validacoes de seguranca de usuario', () => {
  beforeEach(() => jest.clearAllMocks());

  test('troca de senha reutiliza a politica forte do cadastro', async () => {
    const res = createResponse();
    await userController.atualizarSenha(
      { user: { id: 'user-1' }, body: { senhaAtual: 'Atual@123', novaSenha: '123456' } },
      res
    );

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json.mock.calls[0][0].erro).toContain('8 caracteres');
    expect(User.findById).not.toHaveBeenCalled();
    expect(argon2.hash).not.toHaveBeenCalled();
  });

  test('busca escapa metacaracteres de expressao regular', async () => {
    const limit = jest.fn().mockResolvedValue([]);
    const select = jest.fn().mockReturnValue({ limit });
    User.find.mockReturnValue({ select });

    await userController.searchUsers(
      { query: { q: '.*' } },
      createResponse()
    );

    expect(User.find).toHaveBeenCalledWith(
      expect.objectContaining({
        $or: [
          { nome: { $regex: '\\.\\*', $options: 'i' } },
          { email: { $regex: '\\.\\*', $options: 'i' } },
        ],
      })
    );
  });
});
