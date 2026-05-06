const mongoose = require('mongoose');

const twoFactorTokenSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  codigo: {
    type: String,
    required: true
  },
  token: {
    type: String,
    required: true,
    unique: true
  },
  validado: {
    type: Boolean,
    default: false
  },
  tentativas: {
    type: Number,
    default: 0
  },
  criadoEm: {
    type: Date,
    default: Date.now,
    expires: 900 // Expira em 15 minutos (900 segundos)
  }
}, { timestamps: true });

module.exports = mongoose.model('TwoFactorToken', twoFactorTokenSchema);
