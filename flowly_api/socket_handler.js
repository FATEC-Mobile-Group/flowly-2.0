const { Server } = require('socket.io');
const Message = require('./models/Message');
const Equipe = require('./models/Equipe');
const User = require('./models/User');
const { notifyUsers } = require('./utils/notificationService');
const { setIo, getIo } = require('./utils/socketInstance');
const { getSignedUrl } = require('./services/storage');
const { moderateText } = require('./services/nlpModerationService');
const { saveChatInsight, saveBlockedChatInsight } = require('./services/assistantInsightService');
const config = require('./config/config');
const { verifyAuthToken } = require('./utils/faceAuth');

const socketOrigins = config.corsOrigin === '*'
  ? '*'
  : config.corsOrigin.split(',').map((origin) => origin.trim()).filter(Boolean);

const extractSocketToken = (socket) => {
  const authToken = socket.handshake?.auth?.token;
  if (authToken) return authToken;

  const authorization = socket.handshake?.headers?.authorization || '';
  const [scheme, token] = authorization.split(' ');
  return scheme?.toLowerCase() === 'bearer' ? token : null;
};

const authenticateSocket = (socket, next) => {
  try {
    const token = extractSocketToken(socket);
    if (!token) throw new Error('Token não informado.');
    socket.user = verifyAuthToken(token);
    next();
  } catch (_error) {
    next(new Error('Não autorizado.'));
  }
};

const setupSocketInteractions = (server) => {
  const io = new Server(server, {
    cors: {
      origin: socketOrigins,
      methods: ['GET', 'POST']
    }
  });

  setIo(io);

  io.use(authenticateSocket);

  io.on('connection', (socket) => {
    console.log('Novo cliente WebSocket conectado:', socket.id);

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

    // Ouvir mensagens enviadas
    socket.on('send_message', async (data) => {
      try {
        const { equipeId, texto } = data || {};
        const userId = socket.user.id;
        const cleanText = String(texto || '').trim();

        if (!cleanText || cleanText.length > 4000) {
          socket.emit('message_blocked', {
            reason: 'invalid_content',
            message: 'A mensagem deve conter entre 1 e 4000 caracteres.',
          });
          return;
        }

        const equipe = await Equipe.findOne({
          _id: equipeId,
          $or: [{ membros: userId }, { createdBy: userId }],
        }).populate('membros', 'nome email');
        if (!equipe) {
          socket.emit('message_blocked', {
            reason: 'team_access_denied',
            message: 'Voce nao tem permissao para enviar mensagens nesta equipe.',
          });
          return;
        }

        const sender = await User.findById(userId).select('nome tipo fotoPerfil');
        if (!sender) {
          socket.emit('message_blocked', {
            reason: 'invalid_user',
            message: 'Usuario invalido para envio da mensagem.',
          });
          return;
        }

        const moderation = moderateText(cleanText);
        if (!moderation.allowed) {
          saveBlockedChatInsight({
            texto: cleanText,
            equipe,
            userId,
            reason: moderation.reason,
          }).catch((error) => {
            console.error('Erro ao registrar insight de mensagem bloqueada:', error.message);
          });

          socket.emit('message_blocked', {
            reason: moderation.reason,
            score: moderation.score,
            message: 'Mensagem bloqueada por seguranca. Revise o texto e tente novamente.',
          });
          return;
        }
        
        // Salva a mensagem no DB
        const message = new Message({
          texto: cleanText,
          user: userId,
          equipe: equipeId
        });
        await message.save();
        
        // Retorna a mensagem com os dados visuais do usuario associado
        const populatedMessage = await Message.findById(message._id).populate('user', 'nome fotoPerfil');
        const messageToEmit = populatedMessage.toObject();
        if (messageToEmit.user) {
          messageToEmit.user.fotoPerfil = await getSignedUrl(messageToEmit.user.fotoPerfil);
        }

        saveChatInsight({ message, equipe, userId }).catch((error) => {
          console.error('Erro ao minerar insight do chat:', error.message);
        });

        if (equipe) {
          const recipientIds = new Set();

          equipe.membros.forEach((membro) => {
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

          const senderPhoto = await getSignedUrl(sender?.fotoPerfil);

          await notifyUsers({
            userIds: [...recipientIds],
            texto: `${sender?.nome || 'Um usuário'} enviou uma mensagem no chat da equipe ${equipe.nome}`,
            tipo: 'chat',
            origemId: message._id,
            metadata: {
              equipeId,
              messageId: message._id,
              equipeNome: equipe.nome,
              senderId: userId,
              senderName: sender?.nome || 'Usuario',
              senderPhoto,
              messageText: cleanText,
            },
          });
        }

        // Emite a mensagem APENAS para quem estiver na sala dessa equipe
        io.to(`equipe_${equipeId}`).emit('receive_message', messageToEmit);
      } catch(err) {
        console.error('Erro na gravação ou disparo da mensagem (Socket):', err);
      }
    });

    socket.on('disconnect', () => {
      console.log('Cliente WebSocket desconectado:', socket.id);
    });
  });

  return io;
};

setupSocketInteractions.getIo = () => getIo();
setupSocketInteractions.authenticateSocket = authenticateSocket;

module.exports = setupSocketInteractions;
