const mongoose = require('mongoose');

// Trilha das mudancas de perfil (user <-> admin). Gravada na MESMA transacao da mudanca: sem registro,
// nao ha mudanca. Guarda so identificadores, perfis, motivo e data; nunca e-mail, senha ou token.
const roleChangeEventSchema = new mongoose.Schema(
  {
    action: { type: String, enum: ['bootstrap', 'promote', 'demote'], required: true },
    targetUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    fromRole: { type: String, enum: ['admin', 'user'], required: true },
    toRole: { type: String, enum: ['admin', 'user'], required: true },
    actorKind: { type: String, enum: ['operator', 'admin'], required: true },
    actorUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    actorOperator: { type: String, maxlength: 200 },
    reason: { type: String, required: true, minlength: 10, maxlength: 500 },
    faceProfileEnrolled: { type: Boolean, default: false },
    transferredTeamIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Equipe' }],
    transferredTo: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

module.exports = mongoose.model('RoleChangeEvent', roleChangeEventSchema);
