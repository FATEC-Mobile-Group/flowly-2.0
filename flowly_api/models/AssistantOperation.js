const mongoose = require('mongoose');

// Confirmacao de escrita do assistente, compartilhada entre instancias (a API e a dona do registro).
//
// Um documento por pedido de escrita preparado e mostrado ao usuario ("Confirme a operacao: ..."). Guarda so o
// necessario para executar exatamente o que foi resumido e para reconhecer repeticoes: o comando, os parametros
// ja resolvidos (imutaveis), o resumo e uma chave de idempotencia propria. Nunca o JWT, credenciais, respostas da
// API ou URLs assinadas. strict 'throw' recusa qualquer campo fora do schema.
//
// Estados: pending -> executing -> completed | failed | unknown, com retry_pending (recuperacao com a MESMA
// idempotencyKey) entre execucoes; pending -> cancelled | expired. Os estados ativos (pending, executing,
// retry_pending) ocupam a "vaga" da conversa: activeSlot = true so enquanto ativo, e o indice unico parcial
// (ownerId, conversationId) com { activeSlot: true } impede duas operacoes ativas na mesma conversa, sem depender
// de uma consulta anterior. (Igualdade no filtro parcial funciona em qualquer versao do MongoDB; $in so a partir
// da 6.0.)
//
// autoIndex/autoCreate desligados: carregar o model nao cria colecao nem indices. Os indices sao criados de
// proposito numa etapa de migracao. Retencao: o indice TTL apaga o documento depois de retainUntil (o monitor roda
// a cada ~60 s: a remocao pode atrasar, nunca adiantar); a seguranca nunca depende dessa remocao.

const ASSISTANT_OPERATION_STATUSES = Object.freeze([
  'pending', 'executing', 'retry_pending', 'completed', 'failed', 'cancelled', 'expired', 'unknown',
]);
const ACTIVE_STATUSES = Object.freeze(['pending', 'executing', 'retry_pending']);
const TERMINAL_STATUSES = Object.freeze(['completed', 'failed', 'cancelled', 'expired', 'unknown']);
// So as escritas que o assistente executa (exclusao nunca).
const ASSISTANT_WRITE_COMMANDS = Object.freeze([
  'create_team', 'create_task', 'add_comment', 'add_subtask', 'assign_to_me', 'update_status', 'timer',
]);
// UUID v4 canonico em minusculas (operationId, idempotencyKey e claimToken sao gerados pelo servidor).
const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
// conversationId vem do cliente ("voice-<id>-<timestamp>", "web"...): so caracteres seguros, tamanho limitado.
const CONVERSATION_ID_PATTERN = /^[A-Za-z0-9_.:-]{1,120}$/;
const CODE_PATTERN = /^[a-z][a-z_]{0,63}$/;
const RESOURCE_TYPE_PATTERN = /^[a-z][a-z_]{0,39}$/;
const OBJECT_ID_PATTERN = /^[a-f0-9]{24}$/;
// O resumo do assistente repete valores do pedido (texto inteiro do comentario, nome da tarefa e da equipe), entao
// precisa caber ao menos texto (2000) + rotulos; e guardado como foi mostrado, sem cortes.
const SUMMARY_MAX_LENGTH = 4000;
const PARAM_LIMITS = Object.freeze({ nome: 120, descricao: 2000, texto: 2000, dataEntrega: 30 });

// Parametros resolvidos: cada campo e imutavel tambem individualmente ($set em 'params.x' nao e bloqueado so pelo
// immutable do subdocumento).
const paramText = (maxlength) => ({ type: String, maxlength, immutable: true });
const paramsSchema = new mongoose.Schema(
  {
    task_id: { type: String, match: OBJECT_ID_PATTERN, immutable: true },
    team_id: { type: String, match: OBJECT_ID_PATTERN, immutable: true },
    equipe: { type: String, match: OBJECT_ID_PATTERN, immutable: true },
    user: { type: String, match: /^(?:[a-f0-9]{24}|__none__)$/, immutable: true },
    status: { type: String, enum: ['pendente', 'em_andamento', 'concluido'], immutable: true },
    acao: { type: String, enum: ['iniciar', 'pausar'], immutable: true },
    urgencia: { type: String, enum: ['alta', 'media', 'baixa'], immutable: true },
    nome: paramText(PARAM_LIMITS.nome),
    descricao: paramText(PARAM_LIMITS.descricao),
    texto: paramText(PARAM_LIMITS.texto),
    dataEntrega: paramText(PARAM_LIMITS.dataEntrega),
  },
  { _id: false, strict: 'throw' }
);

// Resumo tecnico do desfecho: nada de corpo da resposta, texto de notificacao ou URL.
const resultSchema = new mongoose.Schema(
  {
    httpStatus: { type: Number, min: 100, max: 599 },
    code: { type: String, match: CODE_PATTERN },
    resourceType: { type: String, match: RESOURCE_TYPE_PATTERN },
    resourceId: { type: String, match: OBJECT_ID_PATTERN },
    replayed: { type: Boolean },
  },
  { _id: false, strict: 'throw' }
);

const assistantOperationSchema = new mongoose.Schema(
  {
    operationId: { type: String, required: true, match: UUID_V4_PATTERN, immutable: true },
    // Sempre a identidade autenticada (JWT verificado pela API), nunca um valor livre do cliente.
    ownerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, immutable: true },
    conversationId: { type: String, required: true, match: CONVERSATION_ID_PATTERN, immutable: true },
    commandKey: { type: String, required: true, enum: ASSISTANT_WRITE_COMMANDS, immutable: true },
    params: { type: paramsSchema, required: true, immutable: true },
    summary: { type: String, required: true, minlength: 1, maxlength: SUMMARY_MAX_LENGTH, immutable: true },
    // Privada ao fluxo interno: fora das consultas por padrao (select: false) e nunca na resposta ao frontend.
    idempotencyKey: { type: String, required: true, match: UUID_V4_PATTERN, immutable: true, select: false },
    status: { type: String, required: true, enum: ASSISTANT_OPERATION_STATUSES },
    // true enquanto o status for ativo; ausente nos terminais (base do indice unico parcial).
    activeSlot: { type: Boolean },
    // Ficha do claim atual: so quem a tem conclui; cada claim gera outra.
    claimToken: { type: String, match: UUID_V4_PATTERN, select: false },
    leaseUntil: { type: Date },
    attempts: { type: Number, required: true, min: 0, max: 3 },
    result: { type: resultSchema, default: undefined },
    expiresAt: { type: Date, required: true, immutable: true }, // prazo para confirmar (claim de pending)
    recoverUntil: { type: Date, required: true, immutable: true }, // ultimo instante para qualquer claim
    retainUntil: { type: Date, required: true, immutable: true }, // remocao pelo TTL
  },
  {
    collection: 'assistantoperations',
    timestamps: true,
    strict: 'throw',
    autoIndex: false,
    autoCreate: false,
  }
);

// Invariantes do documento: vaga ativa so em estado ativo; prazos em ordem. Funcao pura (tambem usada pelos
// testes para conferir cada transicao); no Mongoose roda no validate() (validateSync nao executa este gancho).
const invariantViolations = (doc) => {
  const violations = [];
  const ativo = ACTIVE_STATUSES.includes(doc.status);
  if (ativo !== (doc.activeSlot === true)) {
    violations.push(['activeSlot', 'activeSlot deve existir so nos estados ativos']);
  }
  if (doc.expiresAt && doc.recoverUntil && doc.retainUntil
      && !(doc.expiresAt < doc.recoverUntil && doc.recoverUntil < doc.retainUntil)) {
    violations.push(['recoverUntil', 'prazos fora de ordem: expiresAt < recoverUntil < retainUntil']);
  }
  return violations;
};
assistantOperationSchema.pre('validate', function coerencia(next) {
  invariantViolations(this).forEach(([path, message]) => this.invalidate(path, message));
  next();
});

// Busca e claim por operationId (o servico sempre filtra tambem por ownerId e conversationId).
assistantOperationSchema.index({ operationId: 1 }, { unique: true, name: 'operation_id_unique' });
// No maximo uma operacao ativa por conversa do mesmo usuario (pending, executing ou retry_pending).
assistantOperationSchema.index(
  { ownerId: 1, conversationId: 1 },
  { unique: true, partialFilterExpression: { activeSlot: true }, name: 'active_operation_per_conversation' }
);
// Operacao atual/recente de uma conversa (consulta do estado e do ultimo resultado).
assistantOperationSchema.index({ ownerId: 1, conversationId: 1, createdAt: -1 }, { name: 'owner_conversation_recent' });
// Remocao depois da retencao (nunca antes de recoverUntil; ver o servico).
assistantOperationSchema.index({ retainUntil: 1 }, { expireAfterSeconds: 0, name: 'retain_until_ttl' });

const AssistantOperation =
  mongoose.models.AssistantOperation || mongoose.model('AssistantOperation', assistantOperationSchema);

module.exports = AssistantOperation;
module.exports.ASSISTANT_OPERATION_STATUSES = ASSISTANT_OPERATION_STATUSES;
module.exports.ACTIVE_STATUSES = ACTIVE_STATUSES;
module.exports.TERMINAL_STATUSES = TERMINAL_STATUSES;
module.exports.ASSISTANT_WRITE_COMMANDS = ASSISTANT_WRITE_COMMANDS;
module.exports.UUID_V4_PATTERN = UUID_V4_PATTERN;
module.exports.CONVERSATION_ID_PATTERN = CONVERSATION_ID_PATTERN;
module.exports.CODE_PATTERN = CODE_PATTERN;
module.exports.RESOURCE_TYPE_PATTERN = RESOURCE_TYPE_PATTERN;
module.exports.OBJECT_ID_PATTERN = OBJECT_ID_PATTERN;
module.exports.SUMMARY_MAX_LENGTH = SUMMARY_MAX_LENGTH;
module.exports.PARAM_LIMITS = PARAM_LIMITS;
module.exports.invariantViolations = invariantViolations;
