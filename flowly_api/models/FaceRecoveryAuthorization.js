const mongoose = require('mongoose');

// Autorizacao excepcional para recadastrar o rosto de uma conta (scripts/faceRecovery.js).
// pending: aguardando o codigo de titularidade enviado ao e-mail da conta.
// active: o titular confirmou; vale ate expiresAt e e consumida uma unica vez pelo recadastro.
const faceRecoveryAuthorizationSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    operator: { type: String, required: true, trim: true, maxlength: 200 },
    reason: { type: String, required: true, trim: true, minlength: 10, maxlength: 500 },
    status: {
      type: String,
      enum: ['pending', 'active', 'consumed', 'revoked'],
      default: 'pending',
      index: true,
    },
    ownershipCodeHash: { type: String },
    ownershipAttempts: { type: Number, default: 0 },
    ownershipExpiresAt: { type: Date, required: true },
    activatedAt: { type: Date },
    expiresAt: { type: Date },
    consumedAt: { type: Date },
    revokedAt: { type: Date },
    revokedReason: { type: String, maxlength: 200 },
  },
  { timestamps: true }
);

module.exports = mongoose.model('FaceRecoveryAuthorization', faceRecoveryAuthorizationSchema);
