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
  tempoGasto: { type: Number, default: 0 }, // minutos inteiros acumulados (= floor(tempoGastoSegundos / 60) quando houver)
  // Acumulado preciso em segundos (fonte de verdade da duracao). SEM padrao de proposito: ausente = tarefa anterior a
  // este campo, cujo acumulado e tempoGasto * 60 (nada de historico e zerado); 0 gravado = zero legitimo.
  tempoGastoSegundos: { type: Number, min: 0 },
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
    url: { type: String, required: true },
    nomeOriginal: { type: String, required: true },
    mimetype: { type: String },
    size: { type: Number },
    // Autoria registrada no upload (a partir desta versao). Anexos antigos ficam com null:
    // sem autoria comprovada, podem ser baixados, mas nao removidos pela interface.
    uploadedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    uploadedAt: { type: Date, default: null }
  }]
}, { timestamps: true });

module.exports = mongoose.model('Tarefa', tarefaSchema);
