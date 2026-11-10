const request = require('supertest');
const jwt = require('jsonwebtoken');

// D25: a foto vai assinada com token curto; o Sidebar renova chamando /users/me, entao cada chamada
// precisa assinar de novo a partir do caminho salvo no banco.

let mockAssinaturas = 0;

jest.mock('@google-cloud/storage', () => ({
  Storage: jest.fn().mockImplementation(() => ({ bucket: jest.fn().mockReturnValue({ file: jest.fn() }) })),
}));
jest.mock('../services/storage', () => {
  const bucket = { file: jest.fn() };
  bucket.getSignedUrl = jest.fn(async (caminho) => {
    if (!caminho) return '';
    mockAssinaturas += 1;
    return `/api/storage/files/x?token=assinatura-${mockAssinaturas}`;
  });
  return bucket;
});

const mockUsuario = {
  _id: 'user-1',
  nome: 'Ana',
  email: 'ana@flowly.test',
  tipo: 'user',
  fotoPerfil: 'fotos/ana.png',
};
jest.mock('../models/User', () => ({
  findById: jest.fn(() => ({ select: jest.fn(async () => ({ ...mockUsuario })) })),
}));

const config = require('../config/config');
const { getSignedUrl } = require('../services/storage');
const app = require('../app');

const token = jwt.sign({ id: 'user-1', tipo: 'user', tokenType: 'access' }, config.jwt.secret, {
  issuer: config.jwt.issuer,
  audience: config.jwt.accessAudience,
});
const me = () => request(app).get('/api/users/me').set('Authorization', `Bearer ${token}`);

beforeEach(() => {
  jest.clearAllMocks();
  mockAssinaturas = 0;
  mockUsuario.fotoPerfil = 'fotos/ana.png';
});

describe('D25 - GET /api/users/me assina a foto a cada chamada', () => {
  test('duas chamadas geram duas assinaturas a partir do caminho salvo', async () => {
    const primeira = await me();
    const segunda = await me();

    expect(primeira.status).toBe(200);
    expect(segunda.status).toBe(200);
    expect(getSignedUrl).toHaveBeenCalledTimes(2);
    expect(getSignedUrl).toHaveBeenNthCalledWith(1, 'fotos/ana.png');
    expect(getSignedUrl).toHaveBeenNthCalledWith(2, 'fotos/ana.png');
    expect(primeira.body.fotoPerfil).toBe('/api/storage/files/x?token=assinatura-1');
    expect(segunda.body.fotoPerfil).toBe('/api/storage/files/x?token=assinatura-2');
  });

  test('o caminho interno nao sai na resposta', async () => {
    const res = await me();

    expect(res.body.fotoPerfil).not.toContain('fotos/ana.png');
  });

  test('sem foto salva devolve fotoPerfil vazio', async () => {
    mockUsuario.fotoPerfil = '';

    const res = await me();

    expect(res.status).toBe(200);
    expect(res.body.fotoPerfil).toBe('');
  });

  test('sem JWT: 401', async () => {
    const res = await request(app).get('/api/users/me');

    expect(res.status).toBe(401);
    expect(getSignedUrl).not.toHaveBeenCalled();
  });
});
