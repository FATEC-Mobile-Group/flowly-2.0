const argon2 = require('argon2');
const User = require('../models/User');
const FaceProfile = require('../models/FaceProfile');
const faceService = require('../services/faceService');
const {
  buildUserPayload,
  invalidFaceSessionError,
  issueAuthToken,
  verifyFaceSessionToken,
} = require('../utils/faceAuth');
const { normalizeFaceError } = require('../utils/faceErrorMessages');
const {
  assertUniqueFaceEnrollment,
  isSamePersonFaceUpdate,
} = require('../utils/faceEnrollmentGuard');
const { toPlainEmbeddings, getStoredEmbeddings } = require('../utils/faceEmbeddings');
const { encryptEmbeddings } = require('../utils/faceEmbeddingCrypto');

const completeLoginResponse = async (user) => ({
  token: issueAuthToken(user),
  user: await buildUserPayload(user),
});

const saveFaceProfile = async (userId, embeddingsInput, model = 'VGG-Face', filter = { userId }) => {
  const embeddings = Array.isArray(embeddingsInput[0])
    ? embeddingsInput
    : [embeddingsInput];

  const profile = await FaceProfile.findOneAndUpdate(
    filter,
    {
      $set: {
        userId,
        encryptedEmbeddings: encryptEmbeddings(embeddings),
        model,
        enrolled: true,
        enrolledAt: new Date(),
      },
      $unset: { embedding: '', embeddings: '' },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

  return profile;
};

// Primeiro cadastro nunca substitui: com perfil ativo, o indice unico de userId recusa o upsert.
const saveFirstFaceProfile = async (userId, embeddings, model) => {
  try {
    return await saveFaceProfile(userId, embeddings, model, { userId, enrolled: { $ne: true } });
  } catch (err) {
    if (err.code === 11000) {
      throw invalidFaceSessionError();
    }
    throw err;
  }
};

// A oferta de primeiro cadastro termina uma unica vez: cadastrando ou pulando.
const assertFaceOfferPending = async (user) => {
  const pending =
    user.faceEnrollmentOffered === true &&
    user.faceEnrollmentSkipped !== true &&
    user.faceEnrollmentOfferConcluded !== true &&
    !(await FaceProfile.findOne({ userId: user._id, enrolled: true }));

  if (!pending) {
    throw invalidFaceSessionError();
  }
};

// Update condicional: entre chamadas simultaneas, so uma conclui a oferta.
const concludeFaceOffer = async (userId, changes = {}) => {
  const concluded = await User.findOneAndUpdate(
    { _id: userId, faceEnrollmentOfferConcluded: { $ne: true } },
    { $set: { faceEnrollmentOfferConcluded: true, ...changes } }
  );

  if (!concluded) {
    throw invalidFaceSessionError();
  }
};

const extractEmbeddingsFromImages = async (imagesBase64, context) => {
  const embeddings = [];

  for (const imageBase64 of imagesBase64) {
    const embedResult = await faceService.extractEmbedding(imageBase64, context);

    if (!embedResult.face_detected || !embedResult.embedding) {
      return {
        ok: false,
        erro: normalizeFaceError(embedResult.erro, context),
      };
    }

    embeddings.push({
      embedding: embedResult.embedding,
      model: embedResult.model,
    });
  }

  return { ok: true, embeddings };
};

const isImage = (value) => typeof value === 'string' && value.length > 0;

const resolveEnrollmentImages = (body) => {
  if (Array.isArray(body.imagesBase64) && body.imagesBase64.length > 0) {
    return body.imagesBase64.every(isImage) ? body.imagesBase64 : [];
  }

  return isImage(body.imageBase64) ? [body.imageBase64] : [];
};

const FACE_SERVICE_FAILURES = {
  503: 'Serviço facial indisponível.',
  504: 'Serviço facial não respondeu a tempo.',
};

// 4xx sao respostas previstas. Erro de servidor nao repassa mensagem nem detalhe: a causa fica no log.
const buildFaceErrorBody = (err, context, fallback) => {
  if (err.statusCode < 500) {
    return { erro: normalizeFaceError(err.message, context), detalhe: err.details };
  }

  console.error(`Erro em rota facial (${context}):`, err);
  return { erro: FACE_SERVICE_FAILURES[err.statusCode] || fallback };
};

const buildEnrollErrorResponse = (err, context) => {
  if (err.code === 'FACE_DUPLICATE') {
    return {
      status: err.statusCode || 409,
      body: {
        erro: err.message,
        codigo: 'FACE_DUPLICATE',
      },
    };
  }

  return {
    status: err.statusCode || 500,
    body: buildFaceErrorBody(err, context, 'Erro ao cadastrar rosto.'),
  };
};

// Sem corpo JSON req.body fica indefinido: campo ausente responde 400, nao TypeError.
exports.ensureObjectBody = (req, _res, next) => {
  if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
    req.body = {};
  }

  next();
};

exports.getStatus = async (req, res) => {
  try {
    const user = await User.findById(req.user.id).select(
      'faceEnrollmentOffered faceEnrollmentSkipped'
    );
    const profile = await FaceProfile.findOne({ userId: req.user.id, enrolled: true });

    if (!user) {
      return res.status(404).json({ erro: 'Usuário não encontrado.' });
    }

    res.json({
      enrolled: Boolean(profile),
      skipped: Boolean(user.faceEnrollmentSkipped),
      offered: Boolean(user.faceEnrollmentOffered),
    });
  } catch (err) {
    console.error('Erro em rota facial (status):', err);
    res.status(500).json({ erro: 'Erro ao consultar status facial.' });
  }
};

exports.enrollWithSession = async (req, res) => {
  try {
    const { faceSessionToken } = req.body;
    const imagesBase64 = resolveEnrollmentImages(req.body);

    if (!faceSessionToken || imagesBase64.length === 0) {
      return res.status(400).json({
        erro: 'faceSessionToken e ao menos uma imagem (imageBase64 ou imagesBase64) são obrigatórios.',
      });
    }

    const decoded = verifyFaceSessionToken(faceSessionToken, 'face_enroll');
    const user = await User.findById(decoded.id);

    if (!user) {
      return res.status(404).json({ erro: 'Usuário não encontrado.' });
    }

    await assertFaceOfferPending(user);

    const extracted = await extractEmbeddingsFromImages(imagesBase64, 'enroll');
    if (!extracted.ok) {
      return res.status(400).json({ erro: extracted.erro });
    }

    const embeddingList = extracted.embeddings.map((item) => item.embedding);
    await assertUniqueFaceEnrollment(user._id, embeddingList);
    // Depois das validacoes: foto ruim ou rosto duplicado nao gastam a oferta.
    await concludeFaceOffer(user._id);
    await saveFirstFaceProfile(user._id, embeddingList, extracted.embeddings[0].model);

    res.json({
      msg: 'Verificação facial cadastrada com sucesso.',
      ...(await completeLoginResponse(user)),
    });
  } catch (err) {
    const { status, body } = buildEnrollErrorResponse(err, 'enroll');
    res.status(status).json(body);
  }
};

exports.enrollFromProfile = async (req, res) => {
  try {
    const imagesBase64 = resolveEnrollmentImages(req.body);

    if (imagesBase64.length === 0) {
      return res.status(400).json({
        erro: 'imageBase64 ou imagesBase64 é obrigatório.',
      });
    }

    const { senhaAtual } = req.body;

    if (typeof senhaAtual !== 'string' || !senhaAtual) {
      return res.status(400).json({ erro: 'Senha atual é obrigatória.' });
    }

    const user = await User.findById(req.user.id);

    if (!user) {
      return res.status(404).json({ erro: 'Usuário não encontrado.' });
    }

    // O JWT sozinho nao autoriza vincular um rosto. 400 para nao encerrar a sessao no cliente.
    const senhaValida = await argon2.verify(user.senha, senhaAtual);

    if (!senhaValida) {
      return res.status(400).json({ erro: 'Senha atual incorreta.' });
    }

    const existingProfile = await FaceProfile.findOne({ userId: user._id, enrolled: true });

    const extracted = await extractEmbeddingsFromImages(imagesBase64, 'profile');
    if (!extracted.ok) {
      return res.status(400).json({ erro: extracted.erro });
    }

    const embeddingList = extracted.embeddings.map((item) => item.embedding);
    if (existingProfile && !isSamePersonFaceUpdate(existingProfile, embeddingList)) {
      const error = new Error('A nova captura nao corresponde ao perfil facial atual.');
      error.statusCode = 403;
      error.code = 'FACE_UPDATE_MISMATCH';
      throw error;
    }
    await assertUniqueFaceEnrollment(user._id, embeddingList, { existingProfile });
    await saveFaceProfile(user._id, embeddingList, extracted.embeddings[0].model);

    res.json({
      msg: 'Verificação facial cadastrada com sucesso.',
      enrolled: true,
    });
  } catch (err) {
    const { status, body } = buildEnrollErrorResponse(err, 'profile');
    res.status(status).json(body);
  }
};

const sendVerifyError = (res, err) => {
  const status = err.statusCode || 500;
  res.status(status).json(buildFaceErrorBody(err, 'verify', 'Erro na verificação facial.'));
};

// Roda antes do limiter: pedido incompleto responde 400 e sessao invalida 401, nunca 429.
exports.requireFaceVerifySession = (req, res, next) => {
  try {
    const { faceSessionToken, imageBase64 } = req.body;

    if (!faceSessionToken || !isImage(imageBase64)) {
      return res.status(400).json({ erro: 'faceSessionToken e imageBase64 são obrigatórios.' });
    }

    req.faceSession = verifyFaceSessionToken(faceSessionToken, 'face_verify');
  } catch (err) {
    return sendVerifyError(res, err);
  }

  return next();
};

exports.verifyWithSession = async (req, res) => {
  try {
    const { imageBase64 } = req.body;
    const decoded = req.faceSession;
    const user = await User.findById(decoded.id);
    const profile = await FaceProfile.findOne({ userId: decoded.id, enrolled: true });

    if (!user || !profile) {
      return res.status(404).json({ erro: 'Perfil facial não encontrado.' });
    }

    const references = toPlainEmbeddings(getStoredEmbeddings(profile));

    if (references.length === 0) {
      return res.status(404).json({ erro: 'Perfil facial não encontrado.' });
    }

    const verifyResult =
      references.length === 1
        ? await faceService.verifyFace(references[0], imageBase64)
        : await faceService.verifyFaceMulti(references, imageBase64);

    if (!verifyResult.face_detected) {
      return res.status(400).json({
        erro: normalizeFaceError(verifyResult.erro, 'verify'),
      });
    }

    if (!verifyResult.match) {
      return res.status(401).json({
        erro: 'Rosto não reconhecido. Tente capturar outra foto com o rosto bem visível.',
      });
    }

    res.json({
      msg: 'Verificação facial concluída.',
      ...(await completeLoginResponse(user)),
    });
  } catch (err) {
    sendVerifyError(res, err);
  }
};

exports.skipEnrollment = async (req, res) => {
  try {
    const { faceSessionToken } = req.body;

    if (!faceSessionToken) {
      return res.status(400).json({ erro: 'faceSessionToken é obrigatório.' });
    }

    const decoded = verifyFaceSessionToken(faceSessionToken, 'face_enroll');
    const user = await User.findById(decoded.id);

    if (!user) {
      return res.status(404).json({ erro: 'Usuário não encontrado.' });
    }

    await assertFaceOfferPending(user);
    await concludeFaceOffer(user._id, { faceEnrollmentSkipped: true });

    res.json({
      msg: 'Cadastro facial ignorado. Você pode cadastrar depois no perfil.',
      ...(await completeLoginResponse(user)),
    });
  } catch (err) {
    const status = err.statusCode || 500;
    res.status(status).json(buildFaceErrorBody(err, 'enroll', 'Erro ao ignorar cadastro facial.'));
  }
};

exports.health = async (_req, res) => {
  try {
    const faceHealth = await faceService.checkHealth();

    // Rota publica: modelo, detector e limiares ficam so no servico interno.
    if (faceHealth?.status === 'ok') {
      return res.json({ api: 'ok', faceService: { status: 'ok' } });
    }

    console.warn('Servico facial respondeu ao health sem status ok.');
  } catch (err) {
    console.warn('Health do servico facial falhou:', err.cause?.message || err.message);
  }

  return res.status(503).json({
    api: 'ok',
    faceService: { status: 'unavailable' },
    erro: 'Serviço facial indisponível.',
  });
};
