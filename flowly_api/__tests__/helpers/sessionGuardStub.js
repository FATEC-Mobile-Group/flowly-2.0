// Para suites de rota que nao modelam o estado de sessao no banco (versao e papel da conta).
// A revogacao real tem testes proprios: sessionRevocation.test.js e faceRecovery.*.test.js.
const { sessionRevokedError, socketSessionRoom } = jest.requireActual('../../utils/sessionGuard');

module.exports = {
  assertActiveSession: jest.fn(async (claims) => ({ tipo: claims.tipo, authVersion: Number(claims.av) || 0 })),
  disconnectUserSockets: jest.fn(),
  revokeUserSessions: jest.fn(async () => ({ matchedCount: 1 })),
  sessionRevokedError,
  socketSessionRoom,
};
