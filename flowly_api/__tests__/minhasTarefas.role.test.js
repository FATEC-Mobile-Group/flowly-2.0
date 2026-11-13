const request = require('supertest');
const jwt = require('jsonwebtoken');

// D13: GET /api/tarefas/minhas e so de conta user (auth + isUser). O 403 para admin e o contrato,
// coerente com o D10 (admin nunca e responsavel de tarefa); o frontend nao deve pedir isso para admin.

const mockQuery = (value) => {
  const query = Promise.resolve(value);
  ['populate', 'select', 'sort'].forEach((method) => {
    query[method] = jest.fn(() => query);
  });
  return query;
};

jest.mock('@google-cloud/storage', () => ({
  Storage: jest.fn().mockImplementation(() => ({ bucket: jest.fn().mockReturnValue({ file: jest.fn() }) })),
}));
jest.mock('../services/storage', () => {
  const bucket = { file: jest.fn() };
  bucket.getSignedUrl = jest.fn(async (value) => value || '');
  return bucket;
});
jest.mock('../models/Equipe', () => ({ find: jest.fn(() => mockQuery([{ _id: 'equipe-1' }])) }));
jest.mock('../models/Tarefa', () => ({
  find: jest.fn(() => mockQuery([{ _id: 'tarefa-1', descricao: 'Minha tarefa', user: 'user-1', anexos: [] }])),
}));

const config = require('../config/config');
const { ERROR_MESSAGES } = require('../config/constants');
const Equipe = require('../models/Equipe');
const Tarefa = require('../models/Tarefa');
const app = require('../app');

const token = (id, tipo) =>
  jwt.sign({ id, tipo, tokenType: 'access' }, config.jwt.secret, {
    issuer: config.jwt.issuer,
    audience: config.jwt.accessAudience,
  });

beforeEach(() => {
  jest.clearAllMocks();
});

describe('D13 - GET /api/tarefas/minhas', () => {
  test('sem JWT: 401 sem consultar o banco', async () => {
    const res = await request(app).get('/api/tarefas/minhas');

    expect(res.status).toBe(401);
    expect(Tarefa.find).not.toHaveBeenCalled();
    expect(Equipe.find).not.toHaveBeenCalled();
  });

  test('admin: 403 antes do controller, sem consultar o banco', async () => {
    const res = await request(app).get('/api/tarefas/minhas').set('Authorization', `Bearer ${token('admin-1', 'admin')}`);

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ success: false, error: ERROR_MESSAGES.USER_ONLY });
    expect(Tarefa.find).not.toHaveBeenCalled();
    expect(Equipe.find).not.toHaveBeenCalled();
  });

  test('user: 200 com as tarefas atribuidas a ele', async () => {
    const res = await request(app).get('/api/tarefas/minhas').set('Authorization', `Bearer ${token('user-1', 'user')}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual([expect.objectContaining({ _id: 'tarefa-1', descricao: 'Minha tarefa' })]);
    expect(Tarefa.find).toHaveBeenCalledWith(expect.objectContaining({ user: 'user-1' }));
  });
});
