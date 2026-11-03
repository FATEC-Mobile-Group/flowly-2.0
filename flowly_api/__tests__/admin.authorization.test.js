const request = require('supertest');
const jwt = require('jsonwebtoken');

jest.mock('@google-cloud/storage', () => ({
  Storage: jest.fn().mockImplementation(() => ({
    bucket: jest.fn().mockReturnValue({ file: jest.fn() }),
  })),
}));

jest.mock('../models/User', () => ({
  countDocuments: jest.fn().mockResolvedValue(4),
  find: jest.fn(),
}));
jest.mock('../models/Equipe', () => ({
  countDocuments: jest.fn().mockResolvedValue(2),
}));
jest.mock('../models/Tarefa', () => ({
  countDocuments: jest.fn().mockResolvedValue(7),
  aggregate: jest.fn().mockResolvedValue([]),
}));

const config = require('../config/config');
const User = require('../models/User');
const app = require('../app');

const accessToken = (tipo) =>
  jwt.sign(
    { id: `${tipo}-id`, tipo, tokenType: 'access' },
    config.jwt.secret,
    { issuer: config.jwt.issuer, audience: config.jwt.accessAudience }
  );

describe('autorizacao das metricas administrativas', () => {
  test('usuario autenticado sem role admin recebe 403', async () => {
    await request(app)
      .get('/api/admin/metricas')
      .set('Authorization', `Bearer ${accessToken('user')}`)
      .expect(403);

    expect(User.countDocuments).not.toHaveBeenCalled();
  });

  test('administrador autenticado continua acessando as metricas', async () => {
    const response = await request(app)
      .get('/api/admin/metricas')
      .set('Authorization', `Bearer ${accessToken('admin')}`)
      .expect(200);

    expect(response.body).toEqual(
      expect.objectContaining({ totalEquipes: 2, totalUsers: 4, totalTarefas: 7 })
    );
  });

  test('listagem administrativa de usuarios rejeita usuario comum', async () => {
    await request(app)
      .get('/api/users')
      .set('Authorization', `Bearer ${accessToken('user')}`)
      .expect(403);

    expect(User.find).not.toHaveBeenCalled();
  });
});
