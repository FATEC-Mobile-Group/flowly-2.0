const express = require('express');
const jwt = require('jsonwebtoken');
const request = require('supertest');

jest.mock('@google-cloud/storage', () => ({
  Storage: jest.fn().mockImplementation(() => ({
    bucket: jest.fn().mockReturnValue({ file: jest.fn() }),
  })),
}));

// Banco simulado: findById devolve uma consulta que pode ser aguardada direto ou com select.
const mockDb = { users: new Map(), failWith: null };
jest.mock('../models/User', () => {
  const query = (value) => {
    const promise = Promise.resolve(value);
    promise.select = () => promise;
    promise.lean = () => promise;
    return promise;
  };
  return {
    findById: jest.fn((id) => {
      if (mockDb.failWith) {
        return Promise.reject(mockDb.failWith);
      }
      if (!/^[a-f\d]{24}$/i.test(String(id))) {
        const castError = new Error('Cast to ObjectId failed');
        castError.name = 'CastError';
        return Promise.reject(castError);
      }
      return query(mockDb.users.get(String(id)) || null);
    }),
    updateOne: jest.fn(async ({ _id }, update) => {
      const user = mockDb.users.get(String(_id));
      if (user && update.$inc?.authVersion) {
        user.authVersion = (user.authVersion || 0) + update.$inc.authVersion;
      }
      return { matchedCount: user ? 1 : 0 };
    }),
  };
});

const mockIo = { rooms: [], in: jest.fn((room) => ({ disconnectSockets: jest.fn(() => mockIo.rooms.push(room)) })) };
jest.mock('../utils/socketInstance', () => ({ setIo: jest.fn(), getIo: () => mockIo }));

const config = require('../config/config');
const auth = require('../middlewares/auth');
const { isAdmin } = require('../middlewares/roles');
const { issueAuthToken } = require('../utils/faceAuth');
const sessionGuard = require('../utils/sessionGuard');
const setupSocketInteractions = require('../socket_handler');

const USER_ID = '507f1f77bcf86cd799439011';
const ADMIN_ID = '507f1f77bcf86cd799439022';

const app = express();
app.get('/privado', auth, (req, res) => res.json({ id: req.user.id, tipo: req.user.tipo }));
app.get('/admin', auth, isAdmin, (_req, res) => res.json({ ok: true }));

const legacyToken = (id, tipo) =>
  jwt.sign({ id, tipo, tokenType: 'access' }, config.jwt.secret, {
    issuer: config.jwt.issuer,
    audience: config.jwt.accessAudience,
  });

const seed = (id, tipo, authVersion) => {
  const user = { _id: id, tipo, ...(authVersion === undefined ? {} : { authVersion }) };
  mockDb.users.set(id, user);
  return user;
};

const get = (path, token) => request(app).get(path).set('Authorization', `Bearer ${token}`);

beforeEach(() => {
  mockDb.users.clear();
  mockDb.failWith = null;
  mockIo.rooms = [];
  jest.clearAllMocks();
});

describe('token de acesso carrega a versao da sessao', () => {
  test('issueAuthToken grava av com a versao atual da conta', () => {
    const decoded = jwt.decode(issueAuthToken({ _id: USER_ID, tipo: 'user', authVersion: 3 }));

    expect(decoded.av).toBe(3);
  });

  test('conta sem versao gravada emite av 0', () => {
    expect(jwt.decode(issueAuthToken({ _id: USER_ID, tipo: 'user' })).av).toBe(0);
  });
});

describe('middleware de autenticacao confere a sessao no banco', () => {
  test('sessao vigente passa e o papel vem do banco', async () => {
    const user = seed(USER_ID, 'user', 2);

    const res = await get('/privado', issueAuthToken(user));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: USER_ID, tipo: 'user' });
  });

  test('token anterior ao deploy (sem av) continua valendo enquanto a conta nao for revogada', async () => {
    seed(USER_ID, 'user');

    expect((await get('/privado', legacyToken(USER_ID, 'user'))).status).toBe(200);
  });

  test('depois da revogacao o token antigo deixa de valer', async () => {
    const user = seed(USER_ID, 'user', 0);
    const oldToken = issueAuthToken(user);

    await sessionGuard.revokeUserSessions(USER_ID);

    expect(user.authVersion).toBe(1);
    expect((await get('/privado', oldToken)).status).toBe(401);
    expect((await get('/privado', legacyToken(USER_ID, 'user'))).status).toBe(401);
    expect((await get('/privado', issueAuthToken(user))).status).toBe(200);
  });

  test('token de admin deixa de valer quando o papel no banco muda', async () => {
    const user = seed(ADMIN_ID, 'admin', 0);
    const adminToken = issueAuthToken(user);
    expect((await get('/admin', adminToken)).status).toBe(200);

    user.tipo = 'user';

    expect((await get('/admin', adminToken)).status).toBe(401);
    expect((await get('/privado', adminToken)).status).toBe(401);
  });

  test('token de usuario nao vira admin quando o papel no banco muda', async () => {
    const user = seed(USER_ID, 'user', 0);
    const userToken = issueAuthToken(user);

    user.tipo = 'admin';

    expect((await get('/admin', userToken)).status).toBe(401);
  });

  test('conta excluida perde o acesso', async () => {
    const token = issueAuthToken(seed(USER_ID, 'user', 0));
    mockDb.users.delete(USER_ID);

    expect((await get('/privado', token)).status).toBe(401);
  });

  test('id que nao e ObjectId responde 401', async () => {
    expect((await get('/privado', legacyToken('user-1', 'user'))).status).toBe(401);
  });

  test('falha do banco responde 503 sem liberar a rota e sem detalhe interno', async () => {
    const token = issueAuthToken(seed(USER_ID, 'user', 0));
    mockDb.failWith = new Error('connection refused 10.0.0.5:27017');

    const res = await get('/privado', token);

    expect(res.status).toBe(503);
    expect(JSON.stringify(res.body)).not.toMatch(/10\.0\.0\.5|27017|refused/);
  });
});

describe('Socket.IO', () => {
  const socketWith = (token) => ({ handshake: { auth: { token }, headers: {} } });

  test('handshake com sessao vigente vincula a identidade', async () => {
    const user = seed(USER_ID, 'user', 1);
    const socket = socketWith(issueAuthToken(user));
    const next = jest.fn();

    await setupSocketInteractions.authenticateSocket(socket, next);

    expect(next).toHaveBeenCalledWith();
    expect(socket.user).toEqual(expect.objectContaining({ id: USER_ID, tipo: 'user' }));
  });

  test('handshake com sessao revogada ou papel alterado e recusado', async () => {
    const user = seed(USER_ID, 'user', 0);
    const token = issueAuthToken(user);
    await sessionGuard.revokeUserSessions(USER_ID);
    const next = jest.fn();

    await setupSocketInteractions.authenticateSocket(socketWith(token), next);

    expect(next).toHaveBeenCalledWith(expect.any(Error));

    const admin = seed(ADMIN_ID, 'admin', 0);
    const adminToken = issueAuthToken(admin);
    admin.tipo = 'user';
    const nextAdmin = jest.fn();
    await setupSocketInteractions.authenticateSocket(socketWith(adminToken), nextAdmin);
    expect(nextAdmin).toHaveBeenCalledWith(expect.any(Error));
  });

  test('evento de socket ja conectado e barrado e o socket cai depois da revogacao', async () => {
    const user = seed(USER_ID, 'user', 0);
    const socket = { user: jwt.decode(issueAuthToken(user)), disconnect: jest.fn() };
    const next = jest.fn();

    await setupSocketInteractions.revalidateSocketSession(socket, next);
    expect(next).toHaveBeenCalledTimes(1);

    await sessionGuard.revokeUserSessions(USER_ID);
    const nextAfter = jest.fn();
    await setupSocketInteractions.revalidateSocketSession(socket, nextAfter);

    expect(nextAfter).not.toHaveBeenCalled();
    expect(socket.disconnect).toHaveBeenCalledWith(true);
  });

  test('varredura periodica derruba so os sockets revogados, inclusive os que so recebem mensagens', async () => {
    const revoked = seed(USER_ID, 'user', 0);
    const active = seed(ADMIN_ID, 'admin', 0);
    const socketOf = (user) => ({ user: jwt.decode(issueAuthToken(user)), disconnect: jest.fn() });
    const quiet = socketOf(revoked);
    const fine = socketOf(active);
    const io = { of: () => ({ sockets: new Map([['a', quiet], ['b', fine]]) }) };
    await sessionGuard.revokeUserSessions(USER_ID);

    await setupSocketInteractions.sweepRevokedSockets(io);

    expect(quiet.disconnect).toHaveBeenCalledWith(true);
    expect(fine.disconnect).not.toHaveBeenCalled();
  });

  test('falha do banco na varredura nao derruba ninguem', async () => {
    const user = seed(USER_ID, 'user', 0);
    const socket = { user: jwt.decode(issueAuthToken(user)), disconnect: jest.fn() };
    mockDb.failWith = new Error('banco fora');

    await setupSocketInteractions.sweepRevokedSockets({ of: () => ({ sockets: new Map([['a', socket]]) }) });

    expect(socket.disconnect).not.toHaveBeenCalled();
  });

  test('revogacao derruba os sockets da conta na instancia atual', () => {
    sessionGuard.disconnectUserSockets(USER_ID);

    expect(mockIo.in).toHaveBeenCalledWith(sessionGuard.socketSessionRoom(USER_ID));
    expect(mockIo.rooms).toEqual([sessionGuard.socketSessionRoom(USER_ID)]);
  });
});
