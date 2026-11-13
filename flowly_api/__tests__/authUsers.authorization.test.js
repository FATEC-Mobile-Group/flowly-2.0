const request = require('supertest');
const jwt = require('jsonwebtoken');

// D09: GET /api/auth/users listava nome e e-mail de todos os usuarios para qualquer conta autenticada.

jest.mock('../services/storage', () => ({
  getSignedUrl: jest.fn(async (path) => (path ? `assinada:${path}` : path)),
}));

// Documentos completos, com campos que nunca podem sair; select projeta como o MongoDB faria.
const mockDocs = [
  { _id: 'user-1', nome: 'Ana', email: 'ana@flowly.test', tipo: 'user', senha: '$argon2-hash-ana', fotoPerfil: 'fotos/ana.png', verificado: true },
  { _id: 'user-2', nome: 'Bruno', email: 'bruno@flowly.test', tipo: 'user', senha: '$argon2-hash-bruno', fotoPerfil: '', verificado: true },
  { _id: 'admin-1', nome: 'Admin', email: 'admin@flowly.test', tipo: 'admin', senha: '$argon2-hash-admin', fotoPerfil: 'fotos/admin.png', verificado: true },
];

jest.mock('../models/User', () => {
  const matches = (doc, filter = {}) => Object.entries(filter).every(([key, value]) => {
    if (value && typeof value === 'object' && Array.isArray(value.$in)) return value.$in.includes(doc[key]);
    if (value && typeof value === 'object') return true; // $or com $regex: a busca nao e o alvo deste teste
    return doc[key] === value;
  });
  const project = (doc, fields) => {
    const names = fields.split(/\s+/).filter(Boolean);
    return Object.fromEntries(['_id', ...names.filter((name) => name !== '_id')].map((name) => [name, doc[name]]));
  };
  const find = jest.fn((filter) => {
    const found = mockDocs.filter((doc) => matches(doc, filter));
    const query = {
      select: jest.fn((fields) => {
        const projected = found.map((doc) => project(doc, fields));
        const result = Promise.resolve(projected);
        result.limit = jest.fn((n) => Promise.resolve(projected.slice(0, n)));
        return result;
      }),
    };
    return query;
  });
  return { find, findById: jest.fn(), findOne: jest.fn() };
});

const config = require('../config/config');
const { ERROR_MESSAGES } = require('../config/constants');
const User = require('../models/User');
const app = require('../app');

const accessToken = (tipo, extra = {}) =>
  jwt.sign(
    { id: `${tipo}-token-id`, tipo, email: `${tipo}@flowly.test`, tokenType: 'access', ...extra },
    config.jwt.secret,
    { issuer: config.jwt.issuer, audience: config.jwt.accessAudience }
  );

const listedUsers = [
  { _id: 'user-1', nome: 'Ana', email: 'ana@flowly.test' },
  { _id: 'user-2', nome: 'Bruno', email: 'bruno@flowly.test' },
];

beforeEach(() => {
  jest.clearAllMocks();
});

describe('D09 - GET /api/auth/users exige administrador', () => {
  test('sem JWT responde 401 sem consultar usuarios', async () => {
    const response = await request(app).get('/api/auth/users').expect(401);

    expect(response.body).toEqual({ success: false, error: ERROR_MESSAGES.TOKEN_NOT_PROVIDED });
    expect(User.find).not.toHaveBeenCalled();
  });

  test.each([
    ['assinatura de outro segredo', () => jwt.sign({ id: 'x', tipo: 'admin', tokenType: 'access' }, 'outro-segredo')],
    ['token expirado', () => accessToken('admin', { exp: Math.floor(Date.now() / 1000) - 60 })],
    ['texto que nao e JWT', () => 'nao-e-um-jwt'],
    ['token de sessao facial', () => jwt.sign(
      { id: 'admin-1', purpose: 'face_verify', tokenType: 'face-session' },
      config.jwt.faceSecret,
      { issuer: config.jwt.issuer, audience: config.jwt.faceAudience }
    )],
  ])('token invalido (%s) responde 401 sem consultar usuarios', async (_label, makeToken) => {
    const response = await request(app)
      .get('/api/auth/users')
      .set('Authorization', `Bearer ${makeToken()}`)
      .expect(401);

    expect(response.body).toEqual({ success: false, error: ERROR_MESSAGES.INVALID_TOKEN });
    expect(User.find).not.toHaveBeenCalled();
  });

  test.each([
    '/api/auth/users',
    '/api/AUTH/USERS',
    '/api/auth/users/',
    '/api/auth/users?tipo=admin',
  ])('usuario comum em %s recebe 403 antes do controller e sem consultar o banco', async (path) => {
    const response = await request(app)
      .get(path)
      .set('Authorization', `Bearer ${accessToken('user')}`)
      .expect(403);

    expect(response.body).toEqual({ success: false, error: ERROR_MESSAGES.ADMIN_ONLY });
    expect(response.body).not.toEqual(expect.arrayContaining([expect.objectContaining({ email: expect.any(String) })]));
    expect(User.find).not.toHaveBeenCalled();
  });

  test('administrador continua recebendo a lista com os mesmos campos', async () => {
    const response = await request(app)
      .get('/api/auth/users')
      .set('Authorization', `Bearer ${accessToken('admin')}`)
      .expect('Content-Type', /json/)
      .expect(200);

    expect(response.body).toEqual(listedUsers);
    expect(User.find).toHaveBeenCalledTimes(1);
    expect(User.find).toHaveBeenCalledWith({ tipo: 'user' });
    expect(User.find.mock.results[0].value.select).toHaveBeenCalledWith('nome email');
    expect(JSON.stringify(response.body)).not.toMatch(/argon2|senha|verificado/);
  });

  test('administrador acessa tambem pela variacao de caixa e barra final', async () => {
    for (const path of ['/api/AUTH/USERS', '/api/auth/users/']) {
      const response = await request(app)
        .get(path)
        .set('Authorization', `Bearer ${accessToken('admin')}`)
        .expect(200);
      expect(response.body).toEqual(listedUsers);
    }
  });
});

describe('D09 - rotas administrativas de usuarios continuam iguais', () => {
  test('GET /api/users: usuario comum 403 sem consulta, admin 200 com os campos de hoje', async () => {
    await request(app).get('/api/users').set('Authorization', `Bearer ${accessToken('user')}`).expect(403);
    expect(User.find).not.toHaveBeenCalled();

    const response = await request(app)
      .get('/api/users')
      .set('Authorization', `Bearer ${accessToken('admin')}`)
      .expect(200);

    expect(response.body).toEqual([
      { _id: 'user-1', nome: 'Ana', email: 'ana@flowly.test', tipo: 'user', fotoPerfil: 'assinada:fotos/ana.png' },
      { _id: 'user-2', nome: 'Bruno', email: 'bruno@flowly.test', tipo: 'user', fotoPerfil: '' },
      { _id: 'admin-1', nome: 'Admin', email: 'admin@flowly.test', tipo: 'admin', fotoPerfil: 'assinada:fotos/admin.png' },
    ]);
  });

  test('GET /api/users/search: usuario comum 403 sem consulta, admin 200', async () => {
    await request(app).get('/api/users/search?q=an').set('Authorization', `Bearer ${accessToken('user')}`).expect(403);
    expect(User.find).not.toHaveBeenCalled();

    const response = await request(app)
      .get('/api/users/search?q=an')
      .set('Authorization', `Bearer ${accessToken('admin')}`)
      .expect(200);

    expect(response.body).toHaveLength(3);
    expect(User.find.mock.results[0].value.select).toHaveBeenCalledWith('_id nome email fotoPerfil tipo');
  });
});
