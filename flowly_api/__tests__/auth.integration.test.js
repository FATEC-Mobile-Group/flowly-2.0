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
        getSignedUrl: jest.fn().mockResolvedValue(['https://signed.example/test']),
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
}));

// Importa app APÓS os mocks
const app = require('../app');
const User = require('../models/User');
const argon2 = require('argon2');

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

    it('deve retornar 404 quando o usuário não existe', async () => {
      // Simula que o User.findOne não encontra ninguém
      User.findOne.mockResolvedValue(null);

      const response = await request(app)
        .post('/api/auth/login')
        .send({ email: 'naoexiste@teste.com', senha: 'Qualquer@123' })
        .expect('Content-Type', /json/)
        .expect(404);

      expect(response.body).toHaveProperty('erro', 'Usuário não encontrado');
    });

    it('deve retornar 401 quando a senha está incorreta', async () => {
      // Simula usuário encontrado mas senha inválida
      User.findOne.mockResolvedValue({
        _id: 'fake_id_123',
        nome: 'Teste User',
        email: 'teste@flowly.com',
        senha: '$argon2_hash_real',
        tipo: 'user',
        verificado: true,
      });
      argon2.verify.mockResolvedValue(false);

      const response = await request(app)
        .post('/api/auth/login')
        .send({ email: 'teste@flowly.com', senha: 'SenhaErrada@123' })
        .expect('Content-Type', /json/)
        .expect(401);

      expect(response.body).toHaveProperty('erro', 'Senha inválida');
    });

  });

  // ------------------------------------------
  // POST /api/auth/registrar
  // ------------------------------------------

  describe('POST /api/auth/registrar', () => {

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
