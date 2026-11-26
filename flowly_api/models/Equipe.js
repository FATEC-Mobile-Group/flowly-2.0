const mongoose = require('mongoose');
const { LIMITE_DESCRICAO_EQUIPE } = require('../utils/equipeDescricao');

const equipeSchema = new mongoose.Schema({
  nome: { type: String, required: true },
  // Opcional e aditiva: equipes antigas simplesmente nao tem o campo; nada e migrado.
  descricao: { type: String, trim: true, maxlength: LIMITE_DESCRICAO_EQUIPE },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: false, default: null },
  code: {
    type: String,
    required: true,
    unique: true,
    default: () => new mongoose.Types.ObjectId().toString(),
  },
  membros: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }]
}, { timestamps: true });

module.exports = mongoose.model('Equipe', equipeSchema);
