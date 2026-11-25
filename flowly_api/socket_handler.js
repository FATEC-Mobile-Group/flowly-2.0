const mongoose = require('mongoose');
const { Server } = require('socket.io');
const Message = require('./models/Message');
const Equipe = require('./models/Equipe');
const User = require('./models/User');
const { notifyUsers } = require('./utils/notificationService');
const { setIo, getIo } = require('./utils/socketInstance');
const { getSignedUrl } = require('./services/storage');
const { moderateText, MAX_TEXT_LENGTH } = require('./services/nlpModerationService');
const { saveChatInsight, saveBlockedChatInsight } = require('./services/assistantInsightService');
const config = require('./config/config');
const { verifyAuthToken } = require('./utils/faceAuth');
const { assertActiveSession, socketSessionRoom } = require('./utils/sessionGuard');
const { isOriginAllowed } = require('./utils/corsPolicy');

const isSocketOriginAllowed = (origin) => isOriginAllowed(origin, config.corsOrigin, config.env);

const extractSocketToken = (socket) => {
  const authToken = socket.handshake?.auth?.token;
  if (authToken) return authToken;

  const authorization = socket.handshake?.headers?.authorization || '';
  const [scheme, token] = authorization.split(' ');
  return scheme?.toLowerCase() === 'bearer' ? token : null;
};

const authenticateSocket = async (socket, next) => {
  try {
    const token = extractSocketToken(socket);
    if (!token) throw new Error('Token não informado.');
    const claims = verifyAuthToken(token);
    await assertActiveSession(claims);
    socket.user = claims;
    next();
  } catch (_error) {
    next(new Error('Não autorizado.'));
  }
};

// Sem adaptador compartilhado, a revogacao so alcanca os sockets desta instancia. A varredura cobre
// os das outras instancias, inclusive os que so recebem mensagens e nunca emitem eventos.
const SOCKET_SESSION_SWEEP_MS = 60 * 1000;

const sweepRevokedSockets = async (io) => {
  const sockets = Array.from(io.of('/').sockets.values());
  await Promise.all(
    sockets.map(async (socket) => {
      try {
        await assertActiveSession(socket.user);
      } catch (error) {
        // Falha do banco nao derruba ninguem: a proxima varredura tenta de novo.
        if (error.statusCode === 401) {
          socket.disconnect(true);
        }
      }
    })
  );
};

// Cada evento confere de novo a sessao: revogacao ou troca de papel derrubam o socket ja conectado.
const revalidateSocketSession = async (socket, next) => {
  try {
    await assertActiveSession(socket.user);
  } catch (_error) {
    socket.disconnect(true);
    return;
  }
  next();
};

const MODERATION_MESSAGES = {
  insult: 'Sua mensagem não foi enviada porque parece conter um insulto. Revise o texto e tente novamente.',
  threat: 'Sua mensagem não foi enviada porque parece conter uma ameaça. Revise o texto e tente novamente.',
  profanity: 'Sua mensagem não foi enviada porque contém palavrões. Revise o texto e tente novamente.',
  hate: 'Sua mensagem não foi enviada porque parece conter discurso de ódio ou discriminação. Discussões e pesquisas sobre o tema são permitidas; revise o texto e tente novamente.',
};
const DEFAULT_MODERATION_MESSAGE = 'Sua mensagem não foi enviada porque viola as regras do chat. Revise o texto e tente novamente.';
const SEND_FAILED_MESSAGE = 'Não foi possível enviar a mensagem agora. Seu texto foi mantido; tente novamente.';

const buildRecipientIds = async (equipe, userId) => {
  const recipientIds = new Set();
  (equipe.membros || []).forEach((membro) => {
    if (String(membro._id) !== String(userId)) {
      recipientIds.add(String(membro._id));
    }
  });
  if (equipe.createdBy && String(equipe.createdBy) !== String(userId)) {
    const adminCreator = await User.findById(equipe.createdBy).select('tipo');
    if (adminCreator && adminCreator.tipo === 'admin') {
      recipientIds.add(String(equipe.createdBy));
    }
  }
  return [...recipientIds];
};

// Monta a mensagem difundida para a sala. Se a leitura enriquecida falhar, usa os dados ja carregados:
// a mensagem esta gravada e confirmada, entao nao pode sumir da tela de quem esta no chat.
const buildMessageToEmit = async (message, sender) => {
  try {
    const populatedMessage = await Message.findById(message._id).populate('user', 'nome fotoPerfil');
    const messageToEmit = populatedMessage.toObject();
    if (messageToEmit.user) {
      messageToEmit.user.fotoPerfil = await getSignedUrl(messageToEmit.user.fotoPerfil);
    }
    return messageToEmit;
  } catch (error) {
    console.error('Erro ao montar a mensagem do chat para difusao:', error.message);
    const fallback = typeof message.toObject === 'function' ? message.toObject() : { ...message };
    return { ...fallback, user: { _id: sender._id, nome: sender.nome, fotoPerfil: null } };
  }
};

// Ordem: validar -> moderar -> gravar -> ACK -> difundir -> notificar. O ACK de sucesso sai logo apos a
// gravacao; falhas de difusao ou de notificacao sao registradas no log e nao viram erro para o cliente.
// O ACK e respondido no maximo uma vez. Sem ACK (clientes antigos), recusas seguem por message_blocked.
const handleSendMessage = async ({ io, socket, data, ack }) => {
  let answered = false;
  const reply = (response) => {
    if (answered || typeof ack !== 'function') return;
    answered = true;
    try {
      ack(response);
    } catch (error) {
      console.error('Erro ao responder o ACK de send_message:', error.message);
    }
  };
  const refuse = ({ reason, message, blocked = false, score }) => {
    if (typeof ack === 'function') {
      reply({ ok: false, reason, blocked, message });
      return;
    }
    socket.emit('message_blocked', score === undefined ? { reason, message } : { reason, score, message });
  };

  let saved = null;
  let context = null;
  try {
    const { equipeId, texto } = data && typeof data === 'object' ? data : {};
    const userId = socket.user.id;
    const cleanText = typeof texto === 'string' ? texto.trim() : '';

    if (!cleanText || cleanText.length > MAX_TEXT_LENGTH) {
      refuse({ reason: 'invalid_content', message: `A mensagem deve conter entre 1 e ${MAX_TEXT_LENGTH} caracteres.` });
      return;
    }

    if (!mongoose.isValidObjectId(equipeId)) {
      refuse({ reason: 'team_access_denied', message: 'Você não tem permissão para enviar mensagens nesta equipe.' });
      return;
    }

    const equipe = await Equipe.findOne({
      _id: equipeId,
      $or: [{ membros: userId }, { createdBy: userId }],
    }).populate('membros', 'nome email');
    if (!equipe) {
      refuse({ reason: 'team_access_denied', message: 'Você não tem permissão para enviar mensagens nesta equipe.' });
      return;
    }

    const sender = await User.findById(userId).select('nome tipo fotoPerfil');
    if (!sender) {
      refuse({ reason: 'invalid_user', message: 'Usuário inválido para envio da mensagem.' });
      return;
    }

    const moderation = moderateText(cleanText);
    if (!moderation.allowed) {
      // So motivo e categoria: o texto bloqueado nao vai para o insight.
      saveBlockedChatInsight({
        equipe,
        userId,
        reason: moderation.reason,
        category: moderation.category,
      }).catch((error) => {
        console.error('Erro ao registrar insight de mensagem bloqueada:', error.message);
      });

      refuse({
        reason: moderation.reason,
        blocked: true,
        score: moderation.score,
        message: MODERATION_MESSAGES[moderation.category] || DEFAULT_MODERATION_MESSAGE,
      });
      return;
    }

    const message = new Message({
      texto: cleanText,
      user: userId,
      equipe: equipeId,
    });
    await message.save();
    saved = message;
    context = { equipe, equipeId, sender, userId, cleanText };
  } catch (error) {
    console.error('Erro ao gravar mensagem do chat (Socket):', error.message);
    reply({ ok: false, reason: 'send_failed', blocked: false, message: SEND_FAILED_MESSAGE });
    return;
  }

  reply({ ok: true, messageId: String(saved._id) });

  const { equipe, equipeId, sender, userId, cleanText } = context;

  saveChatInsight({ message: saved, equipe, userId }).catch((error) => {
    console.error('Erro ao minerar insight do chat:', error.message);
  });

  try {
    const messageToEmit = await buildMessageToEmit(saved, sender);
    // Emite a mensagem APENAS para quem estiver na sala dessa equipe
    io.to(`equipe_${equipeId}`).emit('receive_message', messageToEmit);
  } catch (error) {
    console.error('Erro ao difundir mensagem do chat:', error.message);
  }

  try {
    const recipientIds = await buildRecipientIds(equipe, userId);
    const senderPhoto = await getSignedUrl(sender?.fotoPerfil);
    await notifyUsers({
      userIds: recipientIds,
      texto: `${sender?.nome || 'Um usuário'} enviou uma mensagem no chat da equipe ${equipe.nome}`,
      tipo: 'chat',
      origemId: saved._id,
      metadata: {
        equipeId,
        messageId: saved._id,
        equipeNome: equipe.nome,
        senderId: userId,
        senderName: sender?.nome || 'Usuario',
        senderPhoto,
        messageText: cleanText,
      },
    });
  } catch (error) {
    console.error('Erro ao notificar mensagem do chat:', error.message);
  }
};

const setupSocketInteractions = (server) => {
  const io = new Server(server, {
    cors: {
      origin: (origin, callback) => callback(null, isSocketOriginAllowed(origin)),
      methods: ['GET', 'POST']
    },
    // cors so define os cabecalhos da resposta; quem recusa o handshake e o allowRequest.
    allowRequest: (req, callback) => callback(null, isSocketOriginAllowed(req.headers.origin)),
  });

  setIo(io);

  const sweepTimer = setInterval(() => {
    sweepRevokedSockets(io).catch(() => {});
  }, SOCKET_SESSION_SWEEP_MS);
  sweepTimer.unref?.();
  server.on?.('close', () => clearInterval(sweepTimer));

  io.use(authenticateSocket);

  io.on('connection', (socket) => {
    console.log('Novo cliente WebSocket conectado:', socket.id);
    socket.join(socketSessionRoom(socket.user.id));
    socket.use((_packet, next) => revalidateSocketSession(socket, next));

    socket.on('join_user', () => {
      const userId = String(socket.user.id);
      socket.join(`user_${userId}`);
      console.log(`Socket ${socket.id} entrou na sala user_${userId}`);
    });

    // Quando o usuário abrir o chat da equipe, el entra na 'sala' da equipe
    socket.on('join_equipe', async (equipeId) => {
      try {
        const userId = socket.user.id;
        const equipe = await Equipe.findOne({
          _id: equipeId,
          $or: [{ membros: userId }, { createdBy: userId }],
        }).select('_id');

        if (!equipe) {
          socket.emit('team_access_denied', { equipeId });
          return;
        }

        socket.join(`equipe_${equipeId}`);
        console.log(`Socket ${socket.id} entrou na sala equipe_${equipeId}`);
      } catch (_error) {
        socket.emit('team_access_denied', { equipeId });
      }
    });

    // Ouvir mensagens enviadas. O ACK e opcional: clientes antigos continuam recebendo message_blocked.
    socket.on('send_message', (data, ack) => {
      const callback = typeof ack === 'function' ? ack : typeof data === 'function' ? data : null;
      const payload = typeof data === 'function' ? undefined : data;
      return handleSendMessage({ io, socket, data: payload, ack: callback });
    });

    socket.on('disconnect', () => {
      console.log('Cliente WebSocket desconectado:', socket.id);
    });
  });

  return io;
};

setupSocketInteractions.getIo = () => getIo();
setupSocketInteractions.authenticateSocket = authenticateSocket;
setupSocketInteractions.revalidateSocketSession = revalidateSocketSession;
setupSocketInteractions.sweepRevokedSockets = sweepRevokedSockets;
setupSocketInteractions.handleSendMessage = handleSendMessage;

module.exports = setupSocketInteractions;
