const argon2 = require('argon2');
const User = require('../models/User');
const FaceProfile = require('../models/FaceProfile');
const faceService = require('../services/faceService');
const {
  buildUserPayload,
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

const saveFaceProfile = async (userId, embeddingsInput, model = 'VGG-Face') => {
  const embeddings = Array.isArray(embeddingsInput[0])
    ? embeddingsInput
    : [embeddingsInput];

  const profile = await FaceProfile.findOneAndUpdate(
    { userId },
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

const resolveEnrollmentImages = (body) => {
  if (Array.isArray(body.imagesBase64) && body.imagesBase64.length > 0) {
    return body.imagesBase64;
  }

  if (body.imageBase64) {
    return [body.imageBase64];
  }

  return [];
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
    body: {
      erro: normalizeFaceError(err.message, context) || 'Erro ao cadastrar rosto.',
      detalhe: err.details,
    },
  };
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
    res.status(500).json({ erro: 'Erro ao consultar status facial.', detalhe: err.message });
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

    const extracted = await extractEmbeddingsFromImages(imagesBase64, 'enroll');
    if (!extracted.ok) {
      return res.status(400).json({ erro: extracted.erro });
    }

    const embeddingList = extracted.embeddings.map((item) => item.embedding);
    await assertUniqueFaceEnrollment(user._id, embeddingList);
    await saveFaceProfile(user._id, embeddingList, extracted.embeddings[0].model);

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

exports.verifyWithSession = async (req, res) => {
  try {
    const { faceSessionToken, imageBase64 } = req.body;

    if (!faceSessionToken || !imageBase64) {
      return res.status(400).json({ erro: 'faceSessionToken e imageBase64 são obrigatórios.' });
    }

    const decoded = verifyFaceSessionToken(faceSessionToken, 'face_verify');
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
        distance: verifyResult.distance,
      });
    }

    res.json({
      msg: 'Verificação facial concluída.',
      ...(await completeLoginResponse(user)),
    });
  } catch (err) {
    const status = err.statusCode || 500;
    res.status(status).json({
      erro: normalizeFaceError(err.message, 'verify') || 'Erro na verificação facial.',
      detalhe: err.details,
    });
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

    user.faceEnrollmentSkipped = true;
    user.faceEnrollmentOffered = true;
    await user.save();

    res.json({
      msg: 'Cadastro facial ignorado. Você pode cadastrar depois no perfil.',
      ...(await completeLoginResponse(user)),
    });
  } catch (err) {
    const status = err.statusCode || 500;
    res.status(status).json({ erro: err.message || 'Erro ao ignorar cadastro facial.' });
  }
};

exports.health = async (_req, res) => {
  try {
    const faceHealth = await faceService.checkHealth();
    res.json({ api: 'ok', faceService: faceHealth });
  } catch (err) {
    res.status(503).json({
      api: 'ok',
      faceService: null,
      erro: 'Serviço facial indisponível.',
      detalhe: err.message,
    });
  }
};
