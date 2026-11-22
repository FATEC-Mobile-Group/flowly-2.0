const mongoose = require('mongoose');

const activityLogSchema = new mongoose.Schema({
  tipoAcao: { 
    type: String, 
    enum: ['criacao', 'atualizacao_status', 'nova_subtarefa', 'nova_tag', 'comentario', 'anexo_adicionado', 'anexo_removido', 'cronometro_iniciado', 'cronometro_pausado', 'atualizacao_geral'],
    required: true 
  },
  detalhes: { type: String, required: true },
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  tarefa: { type: mongoose.Schema.Types.ObjectId, ref: 'Tarefa', required: true }
}, { timestamps: true });

module.exports = mongoose.model('ActivityLog', activityLogSchema);
