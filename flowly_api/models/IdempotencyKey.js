const mongoose = require('mongoose');

// Chave de idempotencia de uma escrita (ex.: confirmacao do assistente). Um registro por usuario + chave.
//
// Guarda so o necessario para reconhecer a repeticao: metodo, rota, hash canonico do pedido e um resumo do
// resultado (status HTTP, tipo e ID do recurso). Nunca o corpo do pedido nem da resposta: comentarios, tokens e
// URLs assinadas de anexos nao entram aqui. strict 'throw' recusa qualquer campo fora do schema.
//
// autoIndex/autoCreate desligados: carregar este model nao cria colecao nem indices em nenhum banco. Os indices
// sao criados de proposito numa etapa de migracao; sem o indice unico o servico recusa operar (fail-closed).
//
// Janela de retencao: a idempotencia so vale enquanto o registro existir. O indice TTL apaga o documento depois
// de expiresAt (o monitor de TTL do MongoDB roda a cada ~60 s, entao a remocao pode atrasar, nunca adiantar).
// Depois disso, a mesma chave e tratada como nova e executaria de novo. Por isso:
//  - a retencao tem minimo de 24 h (padrao 7 dias, IDEMPOTENCY_RETENTION_HOURS) e nunca encurta numa nova
//    tentativa, e precisa ser bem maior que a janela em que um cliente pode repetir o pedido;
//  - clientes geram uma chave nova (UUID) por operacao e nunca reaproveitam chaves antigas.

const IDEMPOTENCY_STATUSES = Object.freeze(['in_progress', 'completed', 'failed', 'unknown']);
const IDEMPOTENCY_METHODS = Object.freeze(['POST', 'PUT', 'PATCH', 'DELETE']);
// UUID canonico (8-4-4-4-12), versoes 1 a 8, variante RFC 4122/9562, sempre em minusculas no banco.
const IDEMPOTENCY_KEY_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const IDEMPOTENCY_KEY_LENGTH = 36;
const ROUTE_PATTERN = /^\/[A-Za-z0-9_:/-]{0,199}$/;
const CODE_PATTERN = /^[a-z][a-z_]{0,63}$/;
const RESOURCE_TYPE_PATTERN = /^[a-z][a-z_]{0,39}$/;
const OBJECT_ID_PATTERN = /^[a-f0-9]{24}$/;

const resultSchema = new mongoose.Schema(
  {
    statusCode: { type: Number, required: true, min: 200, max: 299 },
    resourceType: { type: String, match: RESOURCE_TYPE_PATTERN },
    resourceId: { type: String, match: OBJECT_ID_PATTERN },
  },
  { _id: false, strict: 'throw' }
);

const failureSchema = new mongoose.Schema(
  {
    statusCode: { type: Number, required: true, min: 400, max: 599 },
    code: { type: String, required: true, match: CODE_PATTERN },
    // true: nada foi gravado e a mesma chave pode executar de novo; false: o resultado final e esta falha.
    retryable: { type: Boolean, required: true },
  },
  { _id: false, strict: 'throw' }
);

const idempotencyKeySchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    key: {
      type: String,
      required: true,
      minlength: IDEMPOTENCY_KEY_LENGTH,
      maxlength: IDEMPOTENCY_KEY_LENGTH,
      match: IDEMPOTENCY_KEY_PATTERN,
    },
    method: { type: String, required: true, enum: IDEMPOTENCY_METHODS },
    route: { type: String, required: true, match: ROUTE_PATTERN },
    requestHash: { type: String, required: true, match: /^[a-f0-9]{64}$/ },
    status: { type: String, required: true, enum: IDEMPOTENCY_STATUSES },
    // Ficha da tentativa dona do registro: so ela pode concluir (cerca contra quem assumiu depois do prazo).
    claimToken: { type: String, required: true, match: IDEMPOTENCY_KEY_PATTERN },
    lockedUntil: { type: Date, required: true },
    attempts: { type: Number, required: true, min: 1 },
    result: { type: resultSchema, default: undefined },
    failure: { type: failureSchema, default: undefined },
    completedAt: { type: Date },
    // Nunca antes do periodo minimo de retencao: a chave nao pode ser reaproveitada cedo.
    expiresAt: { type: Date, required: true },
  },
  {
    collection: 'idempotencykeys',
    timestamps: true,
    strict: 'throw',
    autoIndex: false,
    autoCreate: false,
  }
);

idempotencyKeySchema.index({ userId: 1, key: 1 }, { unique: true, name: 'user_key_unique' });
idempotencyKeySchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0, name: 'expires_at_ttl' });

const IdempotencyKey = mongoose.models.IdempotencyKey || mongoose.model('IdempotencyKey', idempotencyKeySchema);

module.exports = IdempotencyKey;
module.exports.IDEMPOTENCY_STATUSES = IDEMPOTENCY_STATUSES;
module.exports.IDEMPOTENCY_METHODS = IDEMPOTENCY_METHODS;
module.exports.IDEMPOTENCY_KEY_PATTERN = IDEMPOTENCY_KEY_PATTERN;
module.exports.IDEMPOTENCY_KEY_LENGTH = IDEMPOTENCY_KEY_LENGTH;
module.exports.ROUTE_PATTERN = ROUTE_PATTERN;
module.exports.CODE_PATTERN = CODE_PATTERN;
module.exports.RESOURCE_TYPE_PATTERN = RESOURCE_TYPE_PATTERN;
module.exports.OBJECT_ID_PATTERN = OBJECT_ID_PATTERN;
