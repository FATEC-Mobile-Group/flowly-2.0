const User = require('../models/User');
const { getIo } = require('./socketInstance');

// Um token de acesso so vale se a conta ainda existe, com a mesma versao de sessao e o mesmo papel.
// Tokens emitidos antes do campo av existir valem como versao 0.

const sessionRevokedError = () => {
  const error = new Error('Sessao encerrada. Faca login novamente.');
  error.statusCode = 401;
  return error;
};

const socketSessionRoom = (userId) => `auth_user_${userId}`;

const assertActiveSession = async (claims) => {
  let user;
  try {
    user = await User.findById(claims.id, 'tipo authVersion');
  } catch (err) {
    if (err?.name === 'CastError') {
      throw sessionRevokedError();
    }
    throw err;
  }

  if (!user) {
    throw sessionRevokedError();
  }

  const currentVersion = Number(user.authVersion) || 0;
  const tokenVersion = Number(claims.av) || 0;

  if (tokenVersion !== currentVersion || user.tipo !== claims.tipo) {
    throw sessionRevokedError();
  }

  return { tipo: user.tipo, authVersion: currentVersion };
};

// Use dentro da mesma transacao da mudanca sensivel, passando a session do MongoDB.
const revokeUserSessions = (userId, { session } = {}) =>
  User.updateOne({ _id: userId }, { $inc: { authVersion: 1 } }, session ? { session } : undefined);

// Sockets de outras instancias caem no proximo evento (revalidateSocketSession em socket_handler.js).
const disconnectUserSockets = (userId) => {
  const io = getIo();
  if (io) {
    io.in(socketSessionRoom(userId)).disconnectSockets(true);
  }
};

module.exports = {
  assertActiveSession,
  disconnectUserSockets,
  revokeUserSessions,
  sessionRevokedError,
  socketSessionRoom,
};
