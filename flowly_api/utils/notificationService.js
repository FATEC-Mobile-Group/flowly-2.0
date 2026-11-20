const Notification = require('../models/Notification');
const { getIo } = require('./socketInstance');

const serializeNotification = (notificationDoc) => ({
  _id: notificationDoc._id,
  texto: notificationDoc.texto,
  user: notificationDoc.user,
  tipo: notificationDoc.tipo,
  origemId: notificationDoc.origemId,
  metadata: notificationDoc.metadata || {},
  lida: notificationDoc.lida,
  createdAt: notificationDoc.createdAt,
  updatedAt: notificationDoc.updatedAt,
});

const notifyUsers = async ({ userIds = [], texto, tipo = 'system', origemId = null, metadata = {} }) => {
  const uniqueUserIds = [...new Set(userIds.map((id) => String(id).trim()).filter(Boolean))];

  if (uniqueUserIds.length === 0 || !texto) {
    return [];
  }

  const notifications = await Notification.insertMany(
    uniqueUserIds.map((userId) => ({
      texto,
      user: userId,
      tipo,
      origemId,
      metadata,
      lida: false,
    }))
  );

  const io = getIo();
  if (io) {
    notifications.forEach((notificationDoc) => {
      io.to(`user_${notificationDoc.user.toString()}`).emit('notification_created', serializeNotification(notificationDoc));
    });
  }

  return notifications;
};

// Caminho transacional (idempotente): o notifyUsers acima grava e emite na hora, o que nao pode acontecer dentro de
// uma transacao (o withTransaction pode repetir o callback, e o aviso sairia antes do commit). Aqui a gravacao e
// separada da emissao: persistNotifications grava com a session e propaga erro (aborta tudo junto);
// emitNotifications e chamada so depois do commit. O notifyUsers e as demais rotas nao mudam.
const persistNotifications = async ({ userIds = [], texto, tipo = 'system', origemId = null, metadata = {} }, { session } = {}) => {
  if (!session) {
    throw new Error('persistNotifications exige a session da transacao');
  }
  const uniqueUserIds = [...new Set(userIds.map((id) => String(id).trim()).filter(Boolean))];
  if (uniqueUserIds.length === 0 || !texto) {
    return [];
  }
  return Notification.insertMany(
    uniqueUserIds.map((userId) => ({ texto, user: userId, tipo, origemId, metadata, lida: false })),
    { session }
  );
};

// Melhor esforco: o Socket.IO nao confirma entrega. A notificacao ja esta gravada e aparece na proxima consulta.
const emitNotifications = (notifications = []) => {
  const io = getIo();
  if (!io) {
    return;
  }
  notifications.forEach((notificationDoc) => {
    io.to(`user_${notificationDoc.user.toString()}`).emit('notification_created', serializeNotification(notificationDoc));
  });
};

module.exports = {
  notifyUsers,
  serializeNotification,
  persistNotifications,
  emitNotifications,
};