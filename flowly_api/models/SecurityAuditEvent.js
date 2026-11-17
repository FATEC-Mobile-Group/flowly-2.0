const mongoose = require('mongoose');

// Trilha de eventos de seguranca. Nunca guarda fotos, embeddings, senhas, tokens, codigos nem e-mails.
const securityAuditEventSchema = new mongoose.Schema(
  {
    event: { type: String, required: true, maxlength: 100 },
    outcome: { type: String, enum: ['requested', 'success', 'denied', 'failed'], required: true },
    reason: { type: String, maxlength: 100 },
    actor: { type: String, enum: ['self', 'operator', 'system'], required: true },
    operator: { type: String, maxlength: 200 },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
    authorizationId: { type: mongoose.Schema.Types.ObjectId, ref: 'FaceRecoveryAuthorization' },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

module.exports = mongoose.model('SecurityAuditEvent', securityAuditEventSchema);
