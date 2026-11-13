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

async function assertUniqueFaceEnrollment(userId, probeEmbeddingOrList, options = {}) {
  const { existingProfile = null } = options;
  const probeEmbeddings = normalizeEmbeddingList(probeEmbeddingOrList);

  if (isSamePersonFaceUpdate(existingProfile, probeEmbeddings)) {
    return;
  }

  for (const probeEmbedding of probeEmbeddings) {
    const duplicate = await findDuplicateFace(probeEmbedding, userId);

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
  isSamePersonFaceUpdate,
  minDistanceToOwnReferences,
  DUPLICATE_FACE_USER_MESSAGE,
};
