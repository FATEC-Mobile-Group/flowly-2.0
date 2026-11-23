const mongoose = require('mongoose');

// Mensagem do chat da equipe.
//   tipo 'texto' (padrao; inclui todas as mensagens antigas, gravadas sem o campo): `texto` obrigatorio.
//   tipo 'anexo': arquivo em `anexo` e `texto` = legenda opcional ('' sem legenda).
// O arquivo e referenciado pelo caminho privado no bucket (anexo.objectPath), nunca por URL assinada.
// Mensagens com anexo tem _id derivado de (usuario, equipe, clientMessageId): repetir o envio colide no indice
// de _id, que sempre existe, e nao cria uma segunda mensagem (services/chatAttachmentService.js).
const anexoSchema = new mongoose.Schema({
  objectPath: { type: String, required: true },
  nomeOriginal: { type: String, required: true, maxlength: 255 },
  mimetype: { type: String, required: true },
  size: { type: Number, required: true, min: 1 },
  sha256: { type: String, required: true, match: /^[a-f0-9]{64}$/ },
  enviadoEm: { type: Date, required: true },
}, { _id: false });

const messageSchema = new mongoose.Schema({
  tipo: { type: String, enum: ['texto', 'anexo'], default: 'texto' },
  texto: {
    type: String,
    // Legenda pode ser vazia; texto de mensagem comum continua obrigatorio, como antes.
    required: function textoObrigatorio() { return this.tipo !== 'anexo'; },
    default: function textoPadrao() { return this.tipo === 'anexo' ? '' : undefined; },
  },
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  equipe: { type: mongoose.Schema.Types.ObjectId, ref: 'Equipe', required: true },
  anexo: {
    type: anexoSchema,
    default: undefined,
    required: function anexoObrigatorio() { return this.tipo === 'anexo'; },
  },
  // Gerado pelo cliente (UUID) para reconhecer repeticoes do mesmo envio.
  clientMessageId: { type: String },
}, { timestamps: true });

module.exports = mongoose.model('Message', messageSchema);
