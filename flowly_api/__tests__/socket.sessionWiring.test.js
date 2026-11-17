// Servidor Socket.IO real (HTTP long-polling): a sessao e conferida no proprio evento, sem depender da varredura.
const http = require('http');
const request = require('supertest');

jest.mock('@google-cloud/storage', () => ({
  Storage: jest.fn().mockImplementation(() => ({ bucket: jest.fn().mockReturnValue({ file: jest.fn() }) })),
}));
jest.mock('dotenv', () => ({ config: jest.fn() }));

const mockDb = { users: [] };
jest.mock('../models/User', () => require('./helpers/memoryModel').createMemoryModel(mockDb, 'users'));
const mockEquipeFindOne = jest.fn(() => ({ select: async () => null }));
jest.mock('../models/Equipe', () => ({ findOne: (...args) => mockEquipeFindOne(...args) }));

const POLLING = '/socket.io/?EIO=4&transport=polling';
const ORIGIN = 'http://localhost:3000';
const USER_ID = '507f1f77bcf86cd799439011';
const TEAM_ID = '507f1f77bcf86cd799439099';

jest.setTimeout(30000);

describe('Socket.IO: revogacao vale no proprio evento', () => {
  const originalEnv = process.env;
  let server;
  let io;
  let issueAuthToken;
  let sessionGuard;
  let setupSocketInteractions;
  let user;

  const sidOf = (res) => JSON.parse(res.text.slice(1)).sid;
  const waitFor = async (condition) => {
    const deadline = Date.now() + 3000;
    while (!condition()) {
      if (Date.now() > deadline) throw new Error('condicao nao atingida em 3s');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };

  const connect = async () => {
    const handshake = await request(server).get(POLLING).set('Origin', ORIGIN);
    const url = `${POLLING}&sid=${sidOf(handshake)}`;
    await request(server).post(url).set('Origin', ORIGIN).type('text/plain').send(`40${JSON.stringify({ token: issueAuthToken(user) })}`);
    const reply = await request(server).get(url).set('Origin', ORIGIN);
    expect(reply.text).toMatch(/^40\{"sid":/);
    return url;
  };

  const emit = (url, event, ...args) =>
    request(server).post(url).set('Origin', ORIGIN).type('text/plain').send(`42${JSON.stringify([event, ...args])}`);

  beforeAll(async () => {
    process.env = { ...originalEnv, JWT_SECRET: 'b'.repeat(32), NODE_ENV: 'development' };
    delete process.env.CORS_ORIGIN;
    jest.resetModules();
    const app = require('../app');
    setupSocketInteractions = require('../socket_handler');
    ({ issueAuthToken } = require('../utils/faceAuth'));
    sessionGuard = require('../utils/sessionGuard');
    server = http.createServer(app);
    io = setupSocketInteractions(server);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  });

  afterAll(async () => {
    await new Promise((resolve) => io.close(resolve));
    process.env = originalEnv;
    jest.resetModules();
  });

  beforeEach(() => {
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
    mockEquipeFindOne.mockClear();
    user = { _id: USER_ID, tipo: 'user', authVersion: 0 };
    mockDb.users = [user];
  });

  afterEach(async () => {
    Object.values(io.engine.clients).forEach((client) => client.close(true));
    await waitFor(() => io.engine.clientsCount === 0 && io.of('/').sockets.size === 0);
    console.log.mockRestore();
    console.error.mockRestore();
  });

  test('conexao vigente entra sozinha na sala de sessao da conta', async () => {
    await connect();

    await waitFor(() => io.of('/').adapter.rooms.has(sessionGuard.socketSessionRoom(USER_ID)));
  });

  test('evento depois da revogacao nao executa o handler e derruba o socket', async () => {
    const url = await connect();
    await emit(url, 'join_equipe', TEAM_ID);
    await waitFor(() => mockEquipeFindOne.mock.calls.length === 1);

    user.authVersion = 1;
    await emit(url, 'join_equipe', TEAM_ID);

    await waitFor(() => io.of('/').sockets.size === 0);
    expect(mockEquipeFindOne).toHaveBeenCalledTimes(1);
  });

  test('evento depois da troca de papel no banco derruba o socket', async () => {
    const url = await connect();

    user.tipo = 'admin';
    await emit(url, 'send_message', { equipeId: TEAM_ID, texto: 'oi' });

    await waitFor(() => io.of('/').sockets.size === 0);
  });

  test('varredura derruba o socket ocioso revogado no servidor real', async () => {
    await connect();
    expect(io.of('/').sockets.size).toBe(1);

    user.authVersion = 1;
    await setupSocketInteractions.sweepRevokedSockets(io);

    await waitFor(() => io.of('/').sockets.size === 0);
  });

  test('disconnectUserSockets alcanca o socket conectado desta instancia', async () => {
    await connect();

    sessionGuard.disconnectUserSockets(USER_ID);

    await waitFor(() => io.of('/').sockets.size === 0);
  });
});
