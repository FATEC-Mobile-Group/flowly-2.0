const { cosineDistance } = require('./faceDistance');
const { decryptEmbeddings } = require('./faceEmbeddingCrypto');

function toPlainEmbedding(embedding) {
  if (!Array.isArray(embedding)) {
    return [];
  }

  return embedding.map((value) => Number(value));
}

function toPlainEmbeddings(embeddings) {
  return normalizeEmbeddingList(embeddings).map(toPlainEmbedding);
}

function getStoredEmbeddings(profile) {
  if (!profile) {
    return [];
  }

  if (profile.encryptedEmbeddings?.ciphertext) {
    return decryptEmbeddings(profile.encryptedEmbeddings);
  }

  if (Array.isArray(profile.embeddings) && profile.embeddings.length > 0) {
    return profile.embeddings.filter((item) => Array.isArray(item) && item.length > 0);
  }

  if (Array.isArray(profile.embedding) && profile.embedding.length > 0) {
    return [profile.embedding];
  }

  return [];
}

function normalizeEmbeddingList(input) {
  if (!input?.length) {
    return [];
  }

  if (typeof input[0] === 'number') {
    return [input];
  }

  return input.filter((item) => Array.isArray(item) && item.length > 0);
}

function minDistanceToReferences(references, probeEmbedding) {
  const refs = normalizeEmbeddingList(references);

  if (!refs.length || !probeEmbedding?.length) {
    return 1;
  }

  return refs.reduce((bestDistance, reference) => {
    const distance = cosineDistance(reference, probeEmbedding);
    return distance < bestDistance ? distance : bestDistance;
  }, 1);
}

function matchesReferences(references, probeEmbedding, threshold) {
  return minDistanceToReferences(references, probeEmbedding) <= threshold;
}

module.exports = {
  getStoredEmbeddings,
  toPlainEmbedding,
  toPlainEmbeddings,
  normalizeEmbeddingList,
  minDistanceToReferences,
  matchesReferences,
};
