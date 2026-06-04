const mongoose = require('mongoose');

const tarefaSchema = new mongoose.Schema({
  descricao: { type: String, required: true },
  detalhes: { type: String }, // descrição detalhada
  dataEntrega: { type: Date, required: true },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: false, default: null },
  status: {
    type: String,
    enum: ['pendente', 'em_andamento', 'concluido'],
    default: 'pendente'
  },
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: false,
    default: null,
  },
  equipe: { type: mongoose.Schema.Types.ObjectId, ref: 'Equipe', required: true },
  tempoEstimado: { type: Number }, // tempo em minutos
  tempoGasto: { type: Number, default: 0 }, // tempo em minutos
  cronometroAtivo: { type: Boolean, default: false },
  ultimaAtualizacaoCronometro: { type: Date },
  urgencia: {
    type: String,
    enum: ['alta', 'media', 'baixa'],
    default: 'baixa'
  },
  tempoExcedido: { type: Boolean, default: false },
  tags: [{ type: String }],
  subtarefas: [{
    descricao: { type: String, required: true },
    concluida: { type: Boolean, default: false }
  }],
  anexos: [{
    url: { type: String },
    objectName: { type: String },
    nomeOriginal: { type: String, required: true },
    mimetype: { type: String },
    size: { type: Number },
    signedUrl: { type: String },
    signedUrlExpiresAt: { type: Date }
  }]
}, { timestamps: true });

module.exports = mongoose.model('Tarefa', tarefaSchema);
