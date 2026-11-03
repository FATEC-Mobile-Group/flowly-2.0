const mongoose = require('mongoose');
const FaceProfile = require('../models/FaceProfile');
const config = require('../config/config');
const { cosineDistance } = require('./faceDistance');
const { getStoredEmbeddings } = require('./faceEmbeddings');

function normalizeUserId(userId) {
  if (!userId) {
    return userId;
  }

  const id = String(userId);
  return mongoose.Types.ObjectId.isValid(id) ? new mongoose.Types.ObjectId(id) : userId;
}

async function findDuplicateFace(
  probeEmbedding,
  excludeUserId,
  threshold = config.face.duplicateThreshold
) {
  const profiles = await FaceProfile.find({
    enrolled: true,
    userId: { $ne: normalizeUserId(excludeUserId) },
  }).select('userId embedding embeddings encryptedEmbeddings model');

  let closestMatch = null;

  for (const profile of profiles) {
    const references = getStoredEmbeddings(profile);

    for (const reference of references) {
      const distance = cosineDistance(reference, probeEmbedding);

      if (distance <= threshold && (!closestMatch || distance < closestMatch.distance)) {
        closestMatch = {
          profile,
          distance,
        };
      }
    }
  }

  return closestMatch;
}

module.exports = {
  cosineDistance,
  findDuplicateFace,
  normalizeUserId,
};
