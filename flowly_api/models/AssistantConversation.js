const mongoose = require('mongoose');
const { CONVERSATION_ID_PATTERN } = require('./AssistantOperation');

// Contexto de conversa do assistente (perguntas pendentes, parametros parcialmente coletados, selecao de tarefas),
// compartilhado entre instancias. A API e a dona do registro; o assistente le e grava pelas rotas internas
// /api/assistant/conversations com o JWT do usuario + o segredo interno.
//
// Um documento por (ownerId, conversationId). O dono e sempre a identidade autenticada (JWT verificado), nunca um
// valor do cliente. O conteudo (state) e validado pelo servico (formas conhecidas, limites de tamanho, nada que
// pareca credencial): nunca JWT, segredo interno, Idempotency-Key ou confirmacoes de escrita (essas ficam em
// AssistantOperation). state NAO autoriza nada: toda escrita continua exigindo uma confirmacao compartilhada.
//
// Concorrencia: version (inteiro >= 1) sobe a cada gravacao; o servico so grava/limpa com o version esperado no
// filtro (atomico no documento). Prazo: expiresAt e renovado a cada gravacao; passado o prazo, o servico trata o
// contexto como inexistente (o indice TTL remove depois, com atraso de ate ~60 s; a seguranca nao depende disso).
//
// autoIndex/autoCreate desligados: carregar o model nao cria colecao nem indices (criados numa etapa de migracao).
// minimize desligado: um objeto vazio dentro do estado (params: {}) e guardado como veio.

const assistantConversationSchema = new mongoose.Schema(
  {
    ownerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, immutable: true },
    conversationId: { type: String, required: true, match: CONVERSATION_ID_PATTERN, immutable: true },
    version: {
      type: Number,
      required: true,
      min: 1,
      validate: { validator: Number.isInteger, message: 'version precisa ser inteiro' },
    },
    state: { type: mongoose.Schema.Types.Mixed, required: true },
    expiresAt: { type: Date, required: true },
  },
  {
    collection: 'assistantconversations',
    timestamps: true,
    strict: 'throw',
    minimize: false,
    autoIndex: false,
    autoCreate: false,
  }
);

// Um contexto por conversa de cada usuario (o mesmo conversationId de dois usuarios sao dois documentos).
assistantConversationSchema.index({ ownerId: 1, conversationId: 1 }, { unique: true, name: 'owner_conversation_unique' });
// Remocao depois do prazo (expiresAt ja e o instante absoluto).
assistantConversationSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0, name: 'conversation_expires_ttl' });

const AssistantConversation =
  mongoose.models.AssistantConversation || mongoose.model('AssistantConversation', assistantConversationSchema);

module.exports = AssistantConversation;
module.exports.CONVERSATION_ID_PATTERN = CONVERSATION_ID_PATTERN;
