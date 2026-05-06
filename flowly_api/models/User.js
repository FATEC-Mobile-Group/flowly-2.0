const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  nome: { type: String, required: true },
  email: { type: String, required: true, unique: true },
  senha: { type: String, required: true },
  tipo: { type: String, enum: ['admin', 'user'], default: 'user' },
  verificado: { type: Boolean, default: false },
  fotoPerfil: { type: String, default: '' }
}, { timestamps: true });

module.exports = mongoose.model('User', userSchema);