/**
 * Teste de Integração HTTP (Supertest) — Endpoints de Autenticação
 * 
 * Testa os endpoints da API Flowly sem banco de dados real.
 * Usa mocks do Mongoose e argon2 para isolar o teste da infraestrutura.
 */

const request = require('supertest');

// ==========================================
// MOCKS — Simula banco de dados, hashing e serviços externos
// ==========================================

// Mock do Google Cloud Storage (necessário porque tarefaController importa services/storage.js)
jest.mock('@google-cloud/storage', () => ({
  Storage: jest.fn().mockImplementation(() => ({
    bucket: jest.fn().mockReturnValue({
      file: jest.fn().mockReturnValue({
        save: jest.fn(),
        createWriteStream: jest.fn(),
      }),
    }),
  })),
}));

// Mock do modelo User (Mongoose)
jest.mock('../models/User', () => {
  const mockUser = {
    findOne: jest.fn(),
    find: jest.fn(),
  };

  // Construtor para `new User(...)` / `User.save()`
  const UserConstructor = jest.fn().mockImplementation((data) => ({
    ...data,
    save: jest.fn().mockResolvedValue(data),
  }));

  // Copia os métodos estáticos para o construtor
  Object.assign(UserConstructor, mockUser);

  return UserConstructor;
});

// Mock do perfil facial: o login consulta o perfil de qualquer tipo de conta (conta sem rosto aqui)
jest.mock('../models/FaceProfile', () => ({
  findOne: jest.fn().mockResolvedValue(null),
}));

// Mock do argon2 (hashing de senha)
jest.mock('argon2', () => ({
  hash: jest.fn().mockResolvedValue('$argon2_hash_simulado'),
  verify: jest.fn().mockResolvedValue(false),
}));

// Mock do envio de email (evita enviar emails reais)
jest.mock('../controllers/emailController', () => ({
  enviarCodigoVerificacao: jest.fn(),
  enviarCodigoVerificacaoEmail: jest.fn().mockResolvedValue(true),
  validarCodigoVerificacao: jest.fn(),
  validarTokenVerificacao: jest.fn(),
  enviarCodigoRecuperacaoSenha: jest.fn(),
  validarCodigoRecuperacaoSenha: jest.fn(),
  redefinirSenhaComCodigo: jest.fn(),
}));

// Importa app APÓS os mocks
const app = require('../app');
const User = require('../models/User');
const argon2 = require('argon2');
const jwt = require('jsonwebtoken');
const config = require('../config/config');
const { ERROR_MESSAGES } = require('../config/constants');

// ==========================================
// TESTES
// ==========================================

describe('API Auth — Testes de Integração com Supertest', () => {

  // Limpa os mocks antes de cada teste
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // ------------------------------------------
  // POST /api/auth/login
  // ------------------------------------------

  describe('POST /api/auth/login', () => {

    it('deve rejeitar login sem senha de forma controlada', async () => {
      const response = await request(app)
        .post('/api/auth/login')
        .send({ email: 'teste@flowly.com' })
        .expect('Content-Type', /json/)
        .expect(400);

      expect(response.body).toEqual({ erro: 'E-mail e senha sao obrigatorios.' });
      expect(User.findOne).not.toHaveBeenCalled();
      expect(argon2.verify).not.toHaveBeenCalled();
    });

    it('deve retornar a mesma resposta para usuário inexistente e senha incorreta', async () => {
      const existingUser = {
        _id: 'fake_id_123',
        nome: 'Teste User',
        email: 'teste@flowly.com',
        senha: '$argon2_hash_real',
        tipo: 'user',
        verificado: true,
      };
      User.findOne
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(existingUser);
      argon2.verify.mockResolvedValueOnce(false);

      const unknownUserResponse = await request(app)
        .post('/api/auth/login')
        .send({ email: 'naoexiste@teste.com', senha: 'Qualquer@123' })
        .expect('Content-Type', /json/)
        .expect(401);

      const wrongPasswordResponse = await request(app)
        .post('/api/auth/login')
        .send({ email: 'teste@flowly.com', senha: 'SenhaErrada@123' })
        .expect('Content-Type', /json/)
        .expect(401);

      expect(unknownUserResponse.body).toEqual({ erro: 'Credenciais inválidas' });
      expect(wrongPasswordResponse.body).toEqual(unknownUserResponse.body);
      expect(argon2.verify).toHaveBeenCalledTimes(2);
      expect(argon2.verify).toHaveBeenNthCalledWith(
        2,
        existingUser.senha,
        'SenhaErrada@123'
      );
    });

    it('deve preservar o login quando as credenciais são válidas', async () => {
      const adminUser = {
        _id: 'admin_id_123',
        nome: 'Admin Teste',
        email: 'admin@flowly.com',
        senha: '$argon2_hash_real',
        tipo: 'admin',
        verificado: true,
        fotoPerfil: '',
      };
      User.findOne.mockResolvedValue(adminUser);
      argon2.verify.mockResolvedValueOnce(true);

      const response = await request(app)
        .post('/api/auth/login')
        .send({ email: adminUser.email, senha: 'SenhaCorreta@123' })
        .expect('Content-Type', /json/)
        .expect(200);

      expect(response.body).toEqual({
        token: expect.any(String),
        user: {
          id: adminUser._id,
          nome: adminUser.nome,
          tipo: adminUser.tipo,
          fotoPerfil: '',
        },
      });
      expect(jwt.verify(response.body.token, config.jwt.secret)).toEqual(
        expect.objectContaining({
          id: adminUser._id,
          tipo: adminUser.tipo,
          tokenType: 'access',
        })
      );
    });

  });

  // ------------------------------------------
  // GET /api/auth/users
  // ------------------------------------------

  describe('GET /api/auth/users', () => {

    it('deve retornar 401 quando o token não foi informado', async () => {
      const response = await request(app)
        .get('/api/auth/users')
        .expect('Content-Type', /json/)
        .expect(401);

      expect(response.body).toEqual({
        success: false,
        error: ERROR_MESSAGES.TOKEN_NOT_PROVIDED,
      });
      expect(User.find).not.toHaveBeenCalled();
    });

    it('deve rejeitar usuário comum sem consultar usuários (D09)', async () => {
      const token = jwt.sign(
        { id: 'authenticated_user', tipo: 'user', email: 'auth@flowly.com', tokenType: 'access' },
        config.jwt.secret,
        { issuer: config.jwt.issuer, audience: config.jwt.accessAudience }
      );

      const response = await request(app)
        .get('/api/auth/users')
        .set('Authorization', `Bearer ${token}`)
        .expect('Content-Type', /json/)
        .expect(403);

      expect(response.body).toEqual({ success: false, error: ERROR_MESSAGES.ADMIN_ONLY });
      expect(User.find).not.toHaveBeenCalled();
    });

    it('deve listar usuários para um administrador', async () => {
      const users = [
        { _id: 'user_1', nome: 'Usuário Um', email: 'um@flowly.com' },
        { _id: 'user_2', nome: 'Usuário Dois', email: 'dois@flowly.com' },
      ];
      const select = jest.fn().mockResolvedValue(users);
      User.find.mockReturnValue({ select });
      const token = jwt.sign(
        {
          id: 'authenticated_user',
          tipo: 'admin',
          email: 'auth@flowly.com',
          tokenType: 'access',
        },
        config.jwt.secret,
        { issuer: config.jwt.issuer, audience: config.jwt.accessAudience }
      );

      const response = await request(app)
        .get('/api/auth/users')
        .set('Authorization', `Bearer ${token}`)
        .expect('Content-Type', /json/)
        .expect(200);

      expect(response.body).toEqual(users);
      expect(User.find).toHaveBeenCalledWith({ tipo: 'user' });
      expect(select).toHaveBeenCalledWith('nome email');
    });

    it('deve rejeitar token temporario de sessao facial como token de acesso', async () => {
      const token = jwt.sign(
        { id: 'authenticated_user', purpose: 'face_verify', tokenType: 'face-session' },
        config.jwt.faceSecret,
        { issuer: config.jwt.issuer, audience: config.jwt.faceAudience }
      );

      const response = await request(app)
        .get('/api/auth/users')
        .set('Authorization', `Bearer ${token}`)
        .expect('Content-Type', /json/)
        .expect(401);

      expect(response.body).toEqual({
        success: false,
        error: ERROR_MESSAGES.INVALID_TOKEN,
      });
      expect(User.find).not.toHaveBeenCalled();
    });

  });

  // ------------------------------------------
  // GET /api/users
  // ------------------------------------------

  describe('GET /api/users', () => {

    it('deve continuar retornando 401 quando o token não foi informado', async () => {
      const response = await request(app)
        .get('/api/users')
        .expect('Content-Type', /json/)
        .expect(401);

      expect(response.body).toEqual({
        success: false,
        error: ERROR_MESSAGES.TOKEN_NOT_PROVIDED,
      });
      expect(User.find).not.toHaveBeenCalled();
    });

  });

  // ------------------------------------------
  // POST /api/auth/registrar
  // ------------------------------------------

  describe('POST /api/auth/registrar', () => {

    it('deve retornar erro 400 quando a senha não foi informada', async () => {
      const response = await request(app)
        .post('/api/auth/registrar')
        .send({
          nome: 'Usuário Teste',
          email: `teste${Date.now()}@flowly.com`,
          tipo: 'user',
          termsAccepted: true,
        })
        .expect('Content-Type', /json/)
        .expect(400);

      expect(response.body).toEqual({
        erro: 'A senha é obrigatória e deve ser informada como texto.',
      });
      expect(argon2.hash).not.toHaveBeenCalled();
    });

    it('deve retornar erro 400 quando a senha é fraca (sem caractere especial)', async () => {
      const response = await request(app)
        .post('/api/auth/registrar')
        .send({
          nome: 'Usuário Teste',
          email: `teste${Date.now()}@flowly.com`,
          senha: 'SenhaFraca123',  // Sem caractere especial
          tipo: 'user',
        })
        .expect('Content-Type', /json/)
        .expect(400);

      expect(response.body).toHaveProperty('erro');
      expect(response.body.erro).toContain('caracteres especiais');
    });

    it('deve retornar erro 400 quando a senha é muito curta', async () => {
      const response = await request(app)
        .post('/api/auth/registrar')
        .send({
          nome: 'Usuário Teste',
          email: `teste${Date.now()}@flowly.com`,
          senha: 'Ab1!',  // Muito curta
          tipo: 'user',
        })
        .expect('Content-Type', /json/)
        .expect(400);

      expect(response.body).toHaveProperty('erro');
      expect(response.body.erro).toContain('8 caracteres');
    });

    it('deve retornar erro 400 quando os termos nao foram aceitos', async () => {
      const response = await request(app)
        .post('/api/auth/registrar')
        .send({
          nome: 'Usuario Teste',
          email: `teste${Date.now()}@flowly.com`,
          senha: 'SenhaForte@123',
          tipo: 'user',
          termsAccepted: false,
        })
        .expect('Content-Type', /json/)
        .expect(400);

      expect(response.body).toHaveProperty('erro');
      expect(response.body.erro).toContain('Termos de Uso');
    });

    it('deve registrar usuario quando os termos foram aceitos', async () => {
      const response = await request(app)
        .post('/api/auth/registrar')
        .send({
          nome: 'Usuario Teste',
          email: `teste${Date.now()}@flowly.com`,
          senha: 'SenhaForte@123',
          tipo: 'user',
          termsAccepted: true,
          termsVersion: '2026-06-08',
        })
        .expect('Content-Type', /json/)
        .expect(201);

      expect(response.body).toHaveProperty('msg');
      expect(User).toHaveBeenCalledWith(
        expect.objectContaining({
          termsAccepted: true,
          termsVersion: '2026-06-08',
          termsAcceptedAt: expect.any(Date),
        })
      );
    });

    it('deve ignorar tentativa de criar administrador pela rota publica', async () => {
      const email = `malicioso${Date.now()}@flowly.com`;
      const response = await request(app)
        .post('/api/auth/registrar')
        .send({
          nome: 'Usuario Malicioso',
          email,
          senha: 'SenhaForte@123',
          tipo: 'admin',
          termsAccepted: true,
          termsVersion: '2026-06-08',
        })
        .expect('Content-Type', /json/)
        .expect(201);

      expect(response.body).toHaveProperty('msg');
      expect(User).toHaveBeenCalledWith(
        expect.objectContaining({
          email,
          tipo: 'user',
        })
      );
    });

  });

  // ------------------------------------------
  // Rota inexistente — 404 Handler
  // ------------------------------------------

  describe('Rota inexistente', () => {

    it('deve retornar 404 para uma rota que não existe', async () => {
      const response = await request(app)
        .get('/api/rota-que-nao-existe')
        .expect('Content-Type', /json/)
        .expect(404);

      expect(response.body).toHaveProperty('success', false);
      expect(response.body).toHaveProperty('error', 'Rota não encontrada');
    });

  });

});
