const mongoose = require('mongoose');

const faceProfileSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      unique: true,
    },
    embedding: {
      type: [Number],
      default: undefined,
    },
    embeddings: {
      type: [[Number]],
      default: undefined,
    },
    encryptedEmbeddings: {
      iv: { type: String },
      tag: { type: String },
      ciphertext: { type: String },
    },
    model: {
      type: String,
      default: 'VGG-Face',
    },
    enrolled: {
      type: Boolean,
      default: true,
    },
    enrolledAt: {
      type: Date,
      default: Date.now,
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model('FaceProfile', faceProfileSchema);
