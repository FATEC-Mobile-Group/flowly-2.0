const { findDuplicateFace } = require('./faceDuplicateCheck');
const {
  getStoredEmbeddings,
  minDistanceToReferences,
  normalizeEmbeddingList,
} = require('./faceEmbeddings');
const config = require('../config/config');
const {
  DUPLICATE_FACE_USER_MESSAGE,
  notifyFaceDuplicateAttempt,
} = require('./faceDuplicateNotification');

function minDistanceToOwnReferences(existingProfile, probeEmbeddingOrList) {
  const ownReferences = getStoredEmbeddings(existingProfile);

  if (!ownReferences.length) {
    return 1;
  }

  const probeEmbeddings = normalizeEmbeddingList(probeEmbeddingOrList);

  if (!probeEmbeddings.length) {
    return 1;
  }

  return Math.min(
    ...probeEmbeddings.map((probeEmbedding) =>
      minDistanceToReferences(ownReferences, probeEmbedding)
    )
  );
}

function isSamePersonFaceUpdate(
  existingProfile,
  probeEmbeddingOrList,
  threshold = config.face.updateSamePersonThreshold
) {
  if (!existingProfile) {
    return false;
  }

  const probeEmbeddings = normalizeEmbeddingList(probeEmbeddingOrList);

  if (!probeEmbeddings.length) {
    return false;
  }

  // Cada captura vira uma referencia aceita no proximo login: todas precisam ser do dono.
  return probeEmbeddings.every(
    (probeEmbedding) => minDistanceToOwnReferences(existingProfile, probeEmbedding) <= threshold
  );
}

// Um rosto aceito por outra conta no login nao pode ser cadastrado aqui: o piso e o limiar de login.
// So endurece: se o limiar de duplicidade configurado for maior, ele continua valendo.
function crossAccountThreshold() {
  return Math.max(config.face.duplicateThreshold, config.face.verifyThreshold);
}

// A checagem contra as outras contas roda sempre, inclusive quando o rosto bate com o proprio perfil.
async function assertUniqueFaceEnrollment(userId, probeEmbeddingOrList) {
  const probeEmbeddings = normalizeEmbeddingList(probeEmbeddingOrList);

  for (const probeEmbedding of probeEmbeddings) {
    const duplicate = await findDuplicateFace(probeEmbedding, userId, crossAccountThreshold());

    if (!duplicate) {
      continue;
    }

    notifyFaceDuplicateAttempt({
      ownerUserId: duplicate.profile.userId,
      requesterUserId: userId,
    }).catch((emailError) => {
      console.warn('Aviso: e-mail de rosto duplicado não enviado:', emailError.message);
    });

    const error = new Error(DUPLICATE_FACE_USER_MESSAGE);
    error.statusCode = 409;
    error.code = 'FACE_DUPLICATE';
    throw error;
  }
}

module.exports = {
  assertUniqueFaceEnrollment,
  crossAccountThreshold,
  isSamePersonFaceUpdate,
  minDistanceToOwnReferences,
  DUPLICATE_FACE_USER_MESSAGE,
};
