const multer = require('multer');
const upload = require('../middlewares/upload');
const Equipe = require('../models/Equipe');
const Message = require('../models/Message');
const User = require('../models/User');
const bucket = require('../services/storage');
const { moderateText, MAX_TEXT_LENGTH } = require('../services/nlpModerationService');
const { montarContentDisposition } = require('../utils/contentDisposition');
const chat = require('../services/chatAttachmentService');

// Anexos no chat da equipe. Ordem da rota (routes/equipesRoutes.js):
//   auth (JWT + sessao) -> uploadLimiter -> verificarAcessoChat (antes do Multer: sem acesso, o arquivo nao e
//   lido) -> Multer (10 MB, tipo e extensao) -> prepararEnvio (id do envio, legenda moderada, repeticao) ->
//   moderateUpload (assinatura, nome, conteudo, Google Vision) -> enviarAnexo (Storage, MongoDB, Socket.IO).
// Nada e publicado antes da mensagem gravada. Sem acesso e equipe inexistente recebem o mesmo 404.

const OBJECT_ID_PATTERN = /^[a-f\d]{24}$/i;
const EQUIPE_NAO_ENCONTRADA = { erro: 'Equipe não encontrada' };
const ANEXO_NAO_ENCONTRADO = { erro: 'Anexo não encontrado' };
const STORAGE_INDISPONIVEL = 'Não foi possível acessar o armazenamento agora. Tente novamente em instantes.';

const CAPTION_MESSAGES = {
  insult: 'A legenda não foi aceita porque parece conter um insulto. Revise o texto e tente novamente.',
  threat: 'A legenda não foi aceita porque parece conter uma ameaça. Revise o texto e tente novamente.',
  profanity: 'A legenda não foi aceita porque contém palavrões. Revise o texto e tente novamente.',
  hate: 'A legenda não foi aceita porque parece conter discurso de ódio ou discriminação. Revise o texto e tente novamente.',
};
const CAPTION_DEFAULT_MESSAGE = 'A legenda não foi aceita pelas regras do chat. Revise o texto e tente novamente.';

// Participacao: membro ou criador, a mesma regra do envio de texto pelo socket.
const findTeamOfUser = (equipeId, userId) => Equipe.findOne({
  _id: equipeId,
  $or: [{ membros: userId }, { createdBy: userId }],
});

exports.verificarAcessoChat = async (req, res, next) => {
  try {
    if (!OBJECT_ID_PATTERN.test(req.params.id)) return res.status(404).json(EQUIPE_NAO_ENCONTRADA);
    const equipe = await findTeamOfUser(req.params.id, req.user.id).select('_id nome membros createdBy');
    if (!equipe) return res.status(404).json(EQUIPE_NAO_ENCONTRADA);
    req.chatEquipe = equipe;
    return next();
  } catch (err) {
    console.error('Erro ao verificar acesso ao chat:', err.name);
    return res.status(500).json({ erro: 'Erro ao enviar arquivo' });
  }
};

// Corpo multipart que o busboy nao conseguiu ler (cabecalho de parte malformado, corpo truncado, sem boundary):
// erro do cliente. So estas mensagens viram 400; MulterError (tamanho etc.) e qualquer outro erro seguem para o
// tratador de sempre. Nada da mensagem interna e repassado.
const MALFORMED_MULTIPART = [
  /^Malformed part header$/,
  /^Unexpected end of (form|file)$/,
  /^Multipart: Boundary not found$/,
  /^Malformed content type$/,
];
const isMalformedMultipart = (err) =>
  !(err instanceof multer.MulterError) && typeof err?.message === 'string'
  && MALFORMED_MULTIPART.some((pattern) => pattern.test(err.message));

// Multer so desta rota: os uploads de tarefas e de foto continuam com o tratamento atual.
exports.receberArquivo = (req, res, next) => upload.single('file')(req, res, (err) => {
  if (!err) return next();
  if (isMalformedMultipart(err)) {
    return res.status(400).json({
      erro: 'Não foi possível ler o arquivo enviado. Selecione o arquivo novamente e tente outra vez.',
      codigo: 'invalid_multipart',
    });
  }
  return next(err);
});

// Repeticao identica: mesmo autor, mesma equipe, mesmo arquivo e mesma legenda. Qualquer diferenca e conflito.
const sameRequestAs = (existing, req, digest, legenda) =>
  existing && existing.tipo === 'anexo' && existing.anexo?.sha256 === digest && (existing.texto || '') === legenda
  && String(existing.user) === String(req.user.id) && String(existing.equipe) === String(req.params.id);

// Mensagem ja gravada para este envio: devolve a mesma, sem novo arquivo, evento ou notificacao.
const replyExisting = async (res, existing, sender) => res.status(200).json({
  ok: true,
  duplicate: true,
  message: await chat.buildPayload(existing, sender),
});

const replyConflict = (res) => res.status(409).json({
  erro: 'Este identificador de envio já foi usado com outro arquivo ou outra legenda. Gere um novo clientMessageId.',
  codigo: 'client_message_id_conflict',
});

// Depois do Multer e antes da moderacao do arquivo: valida o envio, modera a legenda e reconhece repeticoes
// (assim uma nova tentativa do mesmo envio nao roda a moderacao visual de novo).
exports.prepararEnvio = async (req, res, next) => {
  try {
    if (!req.file?.buffer?.length) return res.status(400).json({ erro: 'Nenhum arquivo enviado.' });

    const clientMessageId = chat.normalizeClientMessageId(req.body?.clientMessageId);
    if (!clientMessageId) {
      return res.status(400).json({
        erro: 'Envio sem identificador válido. Gere um clientMessageId (UUID) para cada arquivo.',
        codigo: 'invalid_client_message_id',
      });
    }

    const rawCaption = req.body?.legenda;
    if (rawCaption !== undefined && typeof rawCaption !== 'string') {
      return res.status(400).json({ erro: 'Legenda inválida.' });
    }
    const legenda = (rawCaption || '').trim();
    if (legenda.length > MAX_TEXT_LENGTH) {
      return res.status(400).json({ erro: `A legenda deve ter no máximo ${MAX_TEXT_LENGTH} caracteres.` });
    }
    if (legenda) {
      const moderation = moderateText(legenda);
      if (!moderation.allowed) {
        return res.status(422).json({
          erro: CAPTION_MESSAGES[moderation.category] || CAPTION_DEFAULT_MESSAGE,
          codigo: 'caption_blocked',
        });
      }
    }

    const digest = chat.sha256(req.file.buffer);
    const messageId = chat.deriveMessageId(req.user.id, req.params.id, clientMessageId);
    const existing = await Message.findById(messageId);
    if (existing) {
      if (!sameRequestAs(existing, req, digest, legenda)) return replyConflict(res);
      return replyExisting(res, existing, await User.findById(req.user.id).select('nome fotoPerfil'));
    }

    req.chatUpload = { clientMessageId, legenda, digest, messageId };
    return next();
  } catch (err) {
    console.error('Erro ao preparar anexo do chat:', err.name);
    return res.status(500).json({ erro: 'Erro ao enviar arquivo' });
  }
};

// Armazena, grava a mensagem e so entao difunde. Storage e MongoDB nao tem transacao comum: se a gravacao
// falhar, o objeto desta tentativa e removido (com nova tentativa); se nem isso der, fica registrado no log.
exports.enviarAnexo = async (req, res) => {
  const { clientMessageId, legenda, digest, messageId } = req.chatUpload;
  const equipe = req.chatEquipe;
  const nomeOriginal = chat.sanitizeOriginalName(req.file.originalname);
  const objectPath = chat.objectPathFor(String(equipe._id), nomeOriginal);

  let sender;
  try {
    sender = await User.findById(req.user.id).select('nome fotoPerfil');
    if (!sender) return res.status(401).json({ erro: 'Sessão inválida.' });
  } catch (err) {
    console.error('Erro ao carregar o remetente do anexo:', err.name);
    return res.status(500).json({ erro: 'Erro ao enviar arquivo' });
  }

  try {
    await chat.storeFile(objectPath, req.file);
  } catch (err) {
    console.error('Erro ao armazenar anexo do chat:', err.name);
    // Um save que falhou pode ter deixado o objeto: remove por garantia.
    await chat.removeFile(objectPath, 'falha no armazenamento');
    return res.status(503).json({
      erro: 'Não foi possível armazenar o arquivo agora. Nada foi enviado; tente novamente.',
      codigo: 'storage_unavailable',
    });
  }

  let message;
  try {
    [message] = await Message.create([{
      _id: messageId,
      tipo: 'anexo',
      texto: legenda,
      user: req.user.id,
      equipe: equipe._id,
      clientMessageId,
      anexo: {
        objectPath,
        nomeOriginal,
        mimetype: req.file.mimetype,
        size: req.file.size || req.file.buffer.length,
        sha256: digest,
        enviadoEm: new Date(),
      },
    }]);
  } catch (err) {
    // Esta tentativa nao virou mensagem: o objeto dela sai (o da tentativa que venceu fica intacto).
    await chat.removeFile(objectPath, err.code === 11000 ? 'envio repetido' : 'falha ao gravar a mensagem');
    if (err.code === 11000) {
      const existing = await Message.findById(messageId).catch(() => null);
      if (sameRequestAs(existing, req, digest, legenda)) return replyExisting(res, existing, sender);
      return replyConflict(res);
    }
    console.error('Erro ao gravar mensagem com anexo:', err.name);
    return res.status(503).json({
      erro: 'Não foi possível enviar o arquivo agora. Nada foi publicado; tente novamente.',
      codigo: 'persistence_failed',
    });
  }

  // Gravada: a partir daqui nenhuma falha desfaz a mensagem.
  const payload = await chat.buildPayload(message, sender);
  chat.broadcast(String(equipe._id), payload);
  res.status(201).json({ ok: true, duplicate: false, message: payload });
  await chat.notifyTeam({ equipe, sender, message });
  return undefined;
};

// Download privado: membro da equipe, mensagem da equipe, arquivo da pasta da equipe. Nunca por caminho do cliente.
exports.baixarAnexo = async (req, res) => {
  try {
    const { id, messageId } = req.params;
    if (!OBJECT_ID_PATTERN.test(id)) return res.status(404).json(EQUIPE_NAO_ENCONTRADA);
    if (!OBJECT_ID_PATTERN.test(messageId)) return res.status(404).json(ANEXO_NAO_ENCONTRADO);

    const equipe = await findTeamOfUser(id, req.user.id).select('_id');
    if (!equipe) return res.status(404).json(EQUIPE_NAO_ENCONTRADA);

    const message = await Message.findOne({ _id: messageId, equipe: id, tipo: 'anexo' });
    const anexo = message?.anexo;
    if (!anexo || !chat.belongsToTeam(anexo.objectPath, id)) return res.status(404).json(ANEXO_NAO_ENCONTRADO);

    const file = bucket.file(anexo.objectPath);
    let metadata;
    try {
      const [exists] = await file.exists();
      if (!exists) return res.status(404).json({ erro: 'Arquivo do anexo não encontrado no armazenamento' });
      [metadata] = await file.getMetadata();
    } catch (storageError) {
      console.error('Erro ao consultar anexo do chat no Cloud Storage:', storageError.name);
      return res.status(503).json({ erro: STORAGE_INDISPONIVEL });
    }

    // inline so para imagens e so quando pedido (pre-visualizacao); o resto sempre baixa.
    const inline = req.query.disposition === 'inline' && chat.INLINE_TYPES.has(anexo.mimetype);
    res.setHeader('Content-Type', anexo.mimetype);
    if (metadata?.size) res.setHeader('Content-Length', metadata.size);
    res.setHeader('Content-Disposition', montarContentDisposition(anexo.nomeOriginal, { inline }));
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');

    file.createReadStream()
      .on('error', (streamError) => {
        console.error('Erro ao ler anexo do chat:', streamError.name);
        if (!res.headersSent) {
          res.status(503).json({ erro: STORAGE_INDISPONIVEL });
        } else {
          res.destroy(streamError);
        }
      })
      .pipe(res);
    return undefined;
  } catch (err) {
    console.error('Erro ao baixar anexo do chat:', err.name);
    if (!res.headersSent) return res.status(500).json({ erro: 'Erro ao baixar anexo' });
    return undefined;
  }
};
