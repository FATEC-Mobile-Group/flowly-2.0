const mongoose = require('mongoose');

// Documento-trava das mudancas de perfil. Toda mudanca incrementa `version` dentro da transacao: duas
// mudancas simultaneas escrevem no mesmo documento, o MongoDB acusa conflito e uma delas e refeita
// (withTransaction), ja vendo o resultado da outra. Sem isso, dois rebaixamentos poderiam zerar os admins.
const roleLockSchema = new mongoose.Schema(
  {
    _id: { type: String },
    version: { type: Number, default: 0 },
  },
  { timestamps: true }
);

module.exports = mongoose.model('RoleLock', roleLockSchema);
