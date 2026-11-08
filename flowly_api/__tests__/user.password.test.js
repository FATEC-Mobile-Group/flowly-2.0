const request = require('supertest');
const jwt = require('jsonwebtoken');
const argon2 = require('argon2');

jest.mock('@google-cloud/storage', () => ({
  Storage: jest.fn().mockImplementation(() => ({
    bucket: jest.fn().mockReturnValue({ file: jest.fn() }),
  })),
}));

jest.mock('../models/User', () => ({
  findById: jest.fn(),
}));

const config = require('../config/config');
const User = require('../models/User');
const { issueFaceSessionToken } = require('../utils/faceAuth');
const app = require('../app');

const ROUTE = '/api/users/me/password';
const USER_ID = '507f1f77bcf86cd799439011';
const SENHA_ATUAL = 'SenhaAtual@123';
const NOVA_SENHA = 'NovaSenha@456';

const signAccessToken = (options = {}) =>
  jwt.sign({ id: USER_ID, tipo: 'user', tokenType: 'access' }, config.jwt.secret, {
    issuer: config.jwt.issuer,
    audience: config.jwt.accessAudience,
    ...options,
  });

const changePassword = (token, body) => {
  const req = request(app).put(ROUTE);
  if (token) req.set('Authorization', `Bearer ${token}`);
  return req.send(body);
};

describe('PUT /api/users/me/password', () => {
  let storedHash;
  let user;

  beforeAll(async () => {
    storedHash = await argon2.hash(SENHA_ATUAL);
  });

  beforeEach(() => {
    jest.clearAllMocks();
    user = { senha: storedHash, save: jest.fn().mockResolvedValue() };
    User.findById.mockResolvedValue(user);
  });

  describe('sessao invalida continua sendo 401', () => {
    test('A: sem JWT', async () => {
      const res = await changePassword(null, { senhaAtual: SENHA_ATUAL, novaSenha: NOVA_SENHA });

      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
      expect(User.findById).not.toHaveBeenCalled();
    });

    test('B: JWT malformado', async () => {
      const res = await changePassword('jwt-invalido', {
        senhaAtual: SENHA_ATUAL,
        novaSenha: NOVA_SENHA,
      });

      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
      expect(User.findById).not.toHaveBeenCalled();
    });

    test('B: JWT expirado', async () => {
      const res = await changePassword(signAccessToken({ expiresIn: -10 }), {
        senhaAtual: SENHA_ATUAL,
        novaSenha: NOVA_SENHA,
      });

      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
      expect(User.findById).not.toHaveBeenCalled();
    });

    test('B: JWT assinado com outro segredo', async () => {
      const token = jwt.sign({ id: USER_ID, tipo: 'user', tokenType: 'access' }, 'outro-segredo', {
        issuer: config.jwt.issuer,
        audience: config.jwt.accessAudience,
      });

      const res = await changePassword(token, { senhaAtual: SENHA_ATUAL, novaSenha: NOVA_SENHA });

      expect(res.status).toBe(401);
      expect(User.findById).not.toHaveBeenCalled();
    });

    test('B: token temporario de sessao facial nao vale como JWT principal', async () => {
      const res = await changePassword(issueFaceSessionToken(USER_ID, 'face_verify'), {
        senhaAtual: SENHA_ATUAL,
        novaSenha: NOVA_SENHA,
      });

      expect(res.status).toBe(401);
      expect(User.findById).not.toHaveBeenCalled();
    });
  });

  describe('senha atual incorreta com sessao valida', () => {
    test('C: responde 400, nao 401, e nao altera a senha', async () => {
      const res = await changePassword(signAccessToken(), {
        senhaAtual: 'SenhaErrada@999',
        novaSenha: NOVA_SENHA,
      });

      expect(res.status).toBe(400);
      expect(res.body).toEqual({ erro: 'Senha atual invalida' });
      expect(user.save).not.toHaveBeenCalled();
      expect(user.senha).toBe(storedHash);
    });
  });

  describe('senha atual correta', () => {
    test('D: responde 200 e grava o novo hash', async () => {
      const res = await changePassword(signAccessToken(), {
        senhaAtual: SENHA_ATUAL,
        novaSenha: NOVA_SENHA,
      });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ msg: 'Senha atualizada com sucesso' });
      expect(user.save).toHaveBeenCalledTimes(1);
      expect(await argon2.verify(user.senha, NOVA_SENHA)).toBe(true);
      expect(await argon2.verify(user.senha, SENHA_ATUAL)).toBe(false);
    });
  });

  describe('regras existentes preservadas', () => {
    test('E: nova senha fora da politica responde 400 e nao consulta o usuario', async () => {
      const res = await changePassword(signAccessToken(), {
        senhaAtual: SENHA_ATUAL,
        novaSenha: '123456',
      });

      expect(res.status).toBe(400);
      expect(res.body.erro).toContain('8 caracteres');
      expect(User.findById).not.toHaveBeenCalled();
      expect(user.save).not.toHaveBeenCalled();
    });

    test('E: nova senha sem complexidade responde 400', async () => {
      const res = await changePassword(signAccessToken(), {
        senhaAtual: SENHA_ATUAL,
        novaSenha: 'semcomplexidade',
      });

      expect(res.status).toBe(400);
      expect(res.body.erro).toContain('maiúsculas');
      expect(user.save).not.toHaveBeenCalled();
    });

    test('E: campos ausentes respondem 400', async () => {
      const res = await changePassword(signAccessToken(), { novaSenha: NOVA_SENHA });

      expect(res.status).toBe(400);
      expect(res.body).toEqual({ erro: 'Senha atual e nova senha sao obrigatorias' });
    });

    test('usuario inexistente continua respondendo 404', async () => {
      User.findById.mockResolvedValue(null);

      const res = await changePassword(signAccessToken(), {
        senhaAtual: SENHA_ATUAL,
        novaSenha: NOVA_SENHA,
      });

      expect(res.status).toBe(404);
      expect(res.body).toEqual({ erro: 'Usuario nao encontrado' });
    });
  });
});
