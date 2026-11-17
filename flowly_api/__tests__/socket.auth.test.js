const jwt = require('jsonwebtoken');

// Esta suite nao modela o estado de sessao no banco: ver __tests__/helpers/sessionGuardStub.js.
jest.mock('../utils/sessionGuard', () => require('./helpers/sessionGuardStub'));

jest.mock('@google-cloud/storage', () => ({
  Storage: jest.fn().mockImplementation(() => ({
    bucket: jest.fn().mockReturnValue({ file: jest.fn() }),
  })),
}));

const config = require('../config/config');
const setupSocketInteractions = require('../socket_handler');

const makeSocket = (token) => ({
  handshake: { auth: token ? { token } : {}, headers: {} },
});

describe('autenticacao do Socket.IO', () => {
  test('rejeita conexao sem token', async () => {
    const next = jest.fn();
    await setupSocketInteractions.authenticateSocket(makeSocket(), next);

    expect(next).toHaveBeenCalledWith(expect.any(Error));
  });

  test('rejeita token de sessao facial', async () => {
    const faceToken = jwt.sign(
      { id: 'user-1', purpose: 'face_verify', tokenType: 'face-session' },
      config.jwt.faceSecret,
      { issuer: config.jwt.issuer, audience: config.jwt.faceAudience }
    );
    const next = jest.fn();
    await setupSocketInteractions.authenticateSocket(makeSocket(faceToken), next);

    expect(next).toHaveBeenCalledWith(expect.any(Error));
  });

  test('aceita token de acesso e vincula a identidade ao socket', async () => {
    const accessToken = jwt.sign(
      { id: 'user-1', tipo: 'user', tokenType: 'access' },
      config.jwt.secret,
      { issuer: config.jwt.issuer, audience: config.jwt.accessAudience }
    );
    const socket = makeSocket(accessToken);
    const next = jest.fn();
    await setupSocketInteractions.authenticateSocket(socket, next);

    expect(next).toHaveBeenCalledWith();
    expect(socket.user).toEqual(expect.objectContaining({ id: 'user-1', tipo: 'user' }));
  });
});
