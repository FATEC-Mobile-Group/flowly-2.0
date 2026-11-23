const crypto = require('crypto');
const path = require('path');
const mongoose = require('mongoose');
const bucket = require('./storage');
const { getSignedUrl } = require('./storage');
const Message = require('../models/Message');
const User = require('../models/User');
const { IDEMPOTENCY_KEY_PATTERN } = require('../models/IdempotencyKey');
const { getIo } = require('../utils/socketInstance');
const { notifyUsers } = require('../utils/notificationService');

// Anexos do chat da equipe: identificacao do envio, armazenamento privado, limpeza, representacao publica,
// difusao pelo Socket.IO e notificacao. O controller (controllers/chatAttachmentController.js) decide a ordem.

const CHAT_PREFIX = 'chat';
const MAX_NAME_LENGTH = 255;
// Tipos com visualizacao no navegador (inline). Os demais so baixam (attachment).
const INLINE_TYPES = new Set(['image/png', 'image/jpeg']);
const STORAGE_TIMEOUT_MS = 60000;
const CLEANUP_ATTEMPTS = 2;

// Mesmo formato das chaves de idempotencia do projeto: UUID canonico, em minusculas.
const normalizeClientMessageId = (value) => {
  const id = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return IDEMPOTENCY_KEY_PATTERN.test(id) ? id : null;
};

// _id deterministico por (usuario, equipe, clientMessageId): a repeticao do mesmo envio colide no indice de _id,
// que sempre existe (nenhum indice novo ou migracao). Outro usuario ou outra equipe geram outro _id.
const deriveMessageId = (userId, equipeId, clientMessageId) => new mongoose.Types.ObjectId(
  crypto.createHash('sha256').update(`chat-attachment:${userId}:${equipeId}:${clientMessageId}`).digest('hex').slice(0, 24)
);

const sha256 = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex');

// O Multer decodifica o nome do arquivo como latin1; navegadores mandam UTF-8. Recupera o UTF-8 so quando a
// conversao e exata (nome so ASCII fica igual; texto que nao era UTF-8 valido fica como veio).
const recoverUtf8 = (name) => {
  const asUtf8 = Buffer.from(name, 'latin1').toString('utf8');
  return !asUtf8.includes('\uFFFD') && Buffer.from(asUtf8, 'utf8').toString('latin1') === name ? asUtf8 : name;
};

// Nome exibido e usado no download: sem caminho, sem caracteres de controle, ate 255 caracteres (mantendo a
// extensao). A extensao ja foi validada contra o MIME e a assinatura pela moderacao de upload.
const sanitizeOriginalName = (rawName) => {
  const decoded = recoverUtf8(String(rawName || ''));
  const base = decoded.split(/[\\/]/).pop();
  const cleaned = base.replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim();
  // ".pdf" sozinho: o Node trata como arquivo oculto sem extensao; aqui e so a extensao, sem nome.
  const ext = (path.extname(cleaned) || (/^\.[^.]+$/.test(cleaned) ? cleaned : '')).toLowerCase().slice(0, 10);
  if (!cleaned || cleaned === ext) return `arquivo${ext}`;
  if (cleaned.length <= MAX_NAME_LENGTH) return cleaned;
  return `${cleaned.slice(0, MAX_NAME_LENGTH - ext.length)}${ext}`;
};

// Caminho privado novo a cada tentativa: duas tentativas concorrentes nunca escrevem no mesmo objeto.
const objectPathFor = (equipeId, originalName) =>
  `${CHAT_PREFIX}/${equipeId}/${crypto.randomUUID()}${path.extname(originalName).toLowerCase().slice(0, 10)}`;

const belongsToTeam = (objectPath, equipeId) =>
  typeof objectPath === 'string' && objectPath.startsWith(`${CHAT_PREFIX}/${equipeId}/`) && !objectPath.includes('..');

const storeFile = (objectPath, file) => bucket.file(objectPath).save(file.buffer, {
  resumable: false,
  timeout: STORAGE_TIMEOUT_MS,
  metadata: { contentType: file.mimetype, cacheControl: 'private, max-age=0, no-store' },
});

// Remove o objeto de uma tentativa que nao virou mensagem. Devolve true se o objeto nao existe mais.
// Falhou nas tentativas: registra no log so o caminho (sem dados do usuario) para a limpeza posterior.
const removeFile = async (objectPath, reason) => {
  for (let attempt = 1; attempt <= CLEANUP_ATTEMPTS; attempt += 1) {
    try {
      await bucket.file(objectPath).delete({ ignoreNotFound: true });
      return true;
    } catch (err) {
      if (attempt === CLEANUP_ATTEMPTS) {
        console.error(`[chat-anexo] objeto orfao para limpeza posterior: ${objectPath} (${reason}; ${err.name})`);
      }
    }
  }
  return false;
};

const downloadUrlFor = (equipeId, messageId) => `/api/equipes/${equipeId}/mensagens/${messageId}/anexo`;

// Representacao publica: sem caminho do bucket, sem hash e sem URL assinada. O arquivo sai so pela rota
// autenticada de download (JWT + equipe), inclusive a futura pre-visualizacao de imagens (?disposition=inline).
const publicAttachment = (anexo, equipeId, messageId) => ({
  nomeOriginal: anexo.nomeOriginal,
  mimetype: anexo.mimetype,
  size: anexo.size,
  enviadoEm: anexo.enviadoEm,
  downloadUrl: downloadUrlFor(equipeId, messageId),
  ...(INLINE_TYPES.has(anexo.mimetype) ? { previewUrl: `${downloadUrlFor(equipeId, messageId)}?disposition=inline` } : {}),
});

// Mensagem ja serializada (usuario populado, foto assinada): texto fica igual; anexo ganha a visao publica.
const toPublicMessage = (messageObject) => {
  if (messageObject?.tipo !== 'anexo' || !messageObject.anexo) {
    return messageObject;
  }
  const equipeId = String(messageObject.equipe?._id || messageObject.equipe);
  return {
    ...messageObject,
    texto: messageObject.texto || '',
    anexo: publicAttachment(messageObject.anexo, equipeId, String(messageObject._id)),
  };
};

const signUserPhoto = async (messageObject) => (messageObject.user && typeof messageObject.user === 'object'
  ? { ...messageObject, user: { ...messageObject.user, fotoPerfil: await getSignedUrl(messageObject.user.fotoPerfil) } }
  : messageObject);

// Payload igual ao do historico. Se a leitura enriquecida falhar, usa os dados do remetente ja carregados:
// a mensagem esta gravada e nao pode deixar de aparecer para quem esta no chat.
const buildPayload = async (message, sender) => {
  try {
    const populated = await Message.findById(message._id).populate('user', 'nome fotoPerfil');
    return toPublicMessage(await signUserPhoto(populated.toObject()));
  } catch (err) {
    console.error('[chat-anexo] falha ao montar a mensagem para difusao:', err.name);
    const base = typeof message.toObject === 'function' ? message.toObject() : { ...message };
    return toPublicMessage({ ...base, user: { _id: sender._id, nome: sender.nome, fotoPerfil: null } });
  }
};

// Mesmo evento e sala do chat de texto (socket_handler.js). So depois da gravacao; falha nao apaga a mensagem:
// quem perdeu o evento recupera pelo historico.
const broadcast = (equipeId, payload) => {
  try {
    const io = getIo();
    if (io) io.to(`equipe_${equipeId}`).emit('receive_message', payload);
    return Boolean(io);
  } catch (err) {
    console.error('[chat-anexo] falha ao difundir a mensagem:', err.name);
    return false;
  }
};

// Mesmos destinatarios do chat de texto: membros menos o remetente, mais o criador se for admin.
const notifyTeam = async ({ equipe, sender, message }) => {
  try {
    const senderId = String(sender._id);
    const recipientIds = new Set((equipe.membros || []).map(String).filter((id) => id !== senderId));
    if (equipe.createdBy && String(equipe.createdBy) !== senderId) {
      const creator = await User.findById(equipe.createdBy).select('tipo');
      if (creator && creator.tipo === 'admin') recipientIds.add(String(equipe.createdBy));
    }
    const nome = message.anexo.nomeOriginal;
    await notifyUsers({
      userIds: [...recipientIds],
      texto: `${sender.nome || 'Um usuário'} enviou um arquivo no chat da equipe ${equipe.nome}`,
      tipo: 'chat',
      origemId: message._id,
      metadata: {
        equipeId: String(equipe._id),
        messageId: message._id,
        equipeNome: equipe.nome,
        senderId,
        senderName: sender.nome || 'Usuario',
        senderPhoto: await getSignedUrl(sender.fotoPerfil),
        messageText: message.texto || `Arquivo: ${nome}`,
        attachment: { nomeOriginal: nome, mimetype: message.anexo.mimetype },
      },
    });
  } catch (err) {
    console.error('[chat-anexo] falha ao notificar a equipe:', err.name);
  }
};

module.exports = {
  CHAT_PREFIX,
  INLINE_TYPES,
  belongsToTeam,
  broadcast,
  buildPayload,
  deriveMessageId,
  normalizeClientMessageId,
  notifyTeam,
  objectPathFor,
  removeFile,
  sanitizeOriginalName,
  sha256,
  signUserPhoto,
  storeFile,
  toPublicMessage,
};
