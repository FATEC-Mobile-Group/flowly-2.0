const mongoose = require('mongoose');
const AssistantConversationModel = require('../models/AssistantConversation');
const { hasSensitive, isPlainObject } = require('./assistantOperationService');

const { CONVERSATION_ID_PATTERN } = AssistantConversationModel;

// Contexto compartilhado das conversas do assistente (perguntas pendentes, coleta de parametros, selecao de
// tarefas). Substitui o arquivo local do assistente: varias instancias leem e gravam o mesmo contexto.
//
// - Isolamento: todo filtro leva ownerId (identidade autenticada) + conversationId.
// - Concorrencia (otimista): cada gravacao/limpeza diz qual version leu (expectedVersion; 0 = "nao havia contexto
//   vivo") e o filtro repete esse version. Quem leu um estado antigo nao sobrescreve o novo: recebe um conflito com o
//   version atual e decide (o assistente pede para repetir a resposta). Nada depende de ler antes e gravar depois.
// - Prazo: expiresAt = agora + TTL a cada gravacao (relogio do servidor). Vencido = inexistente para leitura e para
//   expectedVersion; o indice TTL remove depois.
// - Conteudo: so as duas formas que o assistente usa, com limites; nada que pareca credencial ou chave. O contexto
//   nunca autoriza escrita (as confirmacoes ficam em AssistantOperation).
// - Fail-closed: sem conexao ou sem os indices obrigatorios, recusa (503). Nunca cria indices.

const DEFAULT_TTL_SECONDS = 900;
const STATE_MAX_BYTES = 32 * 1024;
const MAX_VERSION = 1e9;
const OBJECT_ID_PATTERN = /^[a-f0-9]{24}$/;
const KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,39}$/;
const COMMAND_KEY_PATTERN = /^[a-z][a-z_]{0,39}$/;
// Identificadores do fluxo de confirmacao (operationId, idempotencyKey, claimToken) nunca entram no contexto.
const UUID_PATTERN = /[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i;
const TEXT_MAX = 2000;
const MAX_PARAMS = 40;
const MAX_MISSING = 20;
const MAX_TASKS = 10;

const clampInt = (raw, fallback, min, max) => {
  const value = Number.parseInt(String(raw ?? ''), 10);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(Math.max(value, min), max);
};
const configFromEnv = (env = process.env) => ({
  ttlMs: clampInt(env.ASSISTANT_CONVERSATION_TTL_SECONDS, DEFAULT_TTL_SECONDS, 60, 3600) * 1000,
});

class AssistantConversationInputError extends Error {
  constructor(code) {
    super(code);
    this.name = 'AssistantConversationInputError';
    this.code = code;
  }
}
class AssistantConversationUnavailableError extends Error {
  constructor(code, details = {}) {
    super(code);
    this.name = 'AssistantConversationUnavailableError';
    this.code = code;
    this.missing = details.missing || [];
  }
}

// Indices obrigatorios, conferidos pelas propriedades (nao so pelo nome).
const sameKeys = (actual, expected) => {
  if (!actual || typeof actual !== 'object') return false;
  const entries = Object.entries(actual);
  return entries.length === expected.length
    && entries.every(([name, direction], index) => name === expected[index][0] && Number(direction) === expected[index][1]);
};
const semCollation = (index) => !index.collation || index.collation.locale === 'simple';
const REQUIRED_INDEXES = Object.freeze([
  {
    name: 'owner_conversation_unique',
    // Unico em todos os documentos: sem ele, duas instancias criariam dois contextos para a mesma conversa.
    matches: (index) => sameKeys(index.key, [['ownerId', 1], ['conversationId', 1]]) && index.unique === true
      && !index.partialFilterExpression && index.sparse !== true && index.expireAfterSeconds === undefined
      && semCollation(index),
  },
  {
    name: 'conversation_expires_ttl',
    matches: (index) => sameKeys(index.key, [['expiresAt', 1]]) && index.expireAfterSeconds === 0
      && !index.partialFilterExpression,
  },
]);
const missingIndexes = (indexes) =>
  REQUIRED_INDEXES.filter((required) => !(indexes || []).some((index) => required.matches(index))).map((r) => r.name);

// ---------- validacao ----------
const invalid = (code = 'state_invalid') => new AssistantConversationInputError(code);
const onlyKeys = (value, allowed) => Object.keys(value).every((key) => allowed.includes(key));
const text = (value, max = TEXT_MAX) => typeof value === 'string' && value.length <= max;
const textOrNull = (value, max) => value === null || value === undefined || text(value, max);
const objectIdOrEmpty = (value) => value === '' || (typeof value === 'string' && OBJECT_ID_PATTERN.test(value));

// Referencia compacta (equipe/responsavel): nulo, texto (ID nao populado) ou { nome }.
const compactRef = (value) => {
  if (value === null || value === undefined) return true;
  if (typeof value === 'string') return text(value, 200);
  return isPlainObject(value) && onlyKeys(value, ['nome']) && textOrNull(value.nome, 200);
};
// Tarefa compacta da selecao: _id obrigatorio; os demais campos sao opcionais, mas sempre do tipo esperado.
const compactTask = (task) => isPlainObject(task)
  && onlyKeys(task, ['_id', 'descricao', 'status', 'urgencia', 'dataEntrega', 'equipe', 'user'])
  && objectIdOrEmpty(task._id) && textOrNull(task.descricao) && textOrNull(task.status, 40)
  && textOrNull(task.urgencia, 20) && textOrNull(task.dataEntrega, 40) && compactRef(task.equipe) && compactRef(task.user);

const collectingParams = (state) => onlyKeys(state, ['command_key', 'params', 'missing'])
  && typeof state.command_key === 'string' && COMMAND_KEY_PATTERN.test(state.command_key)
  && isPlainObject(state.params) && Object.keys(state.params).length <= MAX_PARAMS
  && Object.entries(state.params).every(([key, value]) => KEY_PATTERN.test(key) && text(value))
  && Array.isArray(state.missing) && state.missing.length <= MAX_MISSING
  && state.missing.every((name) => typeof name === 'string' && KEY_PATTERN.test(name));

// Memoria curta da conversa (fatos ditos pela pessoa, ex.: "minha prioridade de hoje e X"): documento proprio, na
// chave reservada "<conversationId>:memoria", separado do estado de comandos pendentes. So texto informativo com
// rotulos fixos; nunca participa de comando, confirmacao ou escrita.
const MEMORY_SUFFIX = ':memoria';
const MEMORY_LABELS = Object.freeze(['prioridade', 'foco', 'objetivo', 'meta']);
const MEMORY_MAX_FACTS = 5;
const MEMORY_TEXT_MAX = 300;
const isMemoryConversation = (conversationId) => typeof conversationId === 'string' && conversationId.endsWith(MEMORY_SUFFIX);
const conversationMemory = (state) => onlyKeys(state, ['mode', 'facts'])
  && state.mode === 'conversation_memory'
  && Array.isArray(state.facts) && state.facts.length <= MEMORY_MAX_FACTS
  && state.facts.every((fact) => isPlainObject(fact) && onlyKeys(fact, ['label', 'text'])
    && MEMORY_LABELS.includes(fact.label) && typeof fact.text === 'string' && fact.text.trim().length > 0
    && fact.text.length <= MEMORY_TEXT_MAX)
  && new Set(state.facts.map((fact) => fact.label)).size === state.facts.length;

const taskSelection = (state) => onlyKeys(state, ['mode', 'tasks', 'selected_task_id'])
  && state.mode === 'task_selection'
  && Array.isArray(state.tasks) && state.tasks.length <= MAX_TASKS && state.tasks.every(compactTask)
  && (state.selected_task_id === undefined || state.selected_task_id === null || objectIdOrEmpty(state.selected_task_id));

const strings = (value, out = []) => {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) value.forEach((item) => strings(item, out));
  else if (value && typeof value === 'object') Object.entries(value).forEach(([key, item]) => { out.push(key); strings(item, out); });
  return out;
};

// So as duas formas do assistente: coleta de parametros (sem mode) e selecao de tarefas (mode task_selection).
// Qualquer outra (inclusive a antiga confirmacao local 'write_confirmation') e recusada. Na chave de memoria
// (memory: true) so a forma conversation_memory, e ela nunca fora dessa chave.
const normalizeState = (state, { memory = false } = {}) => {
  if (!isPlainObject(state)) throw invalid();
  let serialized;
  try {
    serialized = JSON.stringify(state);
  } catch (_err) {
    throw invalid();
  }
  if (Buffer.byteLength(serialized, 'utf8') > STATE_MAX_BYTES) throw invalid('state_too_large');
  const plain = JSON.parse(serialized); // so dados JSON (nada de Date, ObjectId, funcoes ou prototipos)
  let shapeOk;
  if (memory) shapeOk = conversationMemory(plain);
  else shapeOk = Object.prototype.hasOwnProperty.call(plain, 'mode') ? taskSelection(plain) : collectingParams(plain);
  if (!shapeOk) throw invalid();
  if (strings(plain).some((item) => hasSensitive(item) || UUID_PATTERN.test(item))) throw invalid('state_sensitive');
  return plain;
};
const normalizeOwner = (ownerId) => {
  const value = ownerId instanceof mongoose.Types.ObjectId ? ownerId.toHexString() : ownerId;
  if (typeof value !== 'string' || !OBJECT_ID_PATTERN.test(value.toLowerCase())) throw invalid('owner_invalid');
  return value.toLowerCase();
};
const normalizeConversation = (conversationId) => {
  if (typeof conversationId !== 'string' || !CONVERSATION_ID_PATTERN.test(conversationId)) {
    throw invalid('conversation_invalid');
  }
  return conversationId;
};
const normalizeVersion = (version, { optional = false } = {}) => {
  if (optional && version === undefined) return undefined;
  if (!Number.isInteger(version) || version < 0 || version > MAX_VERSION) throw invalid('version_invalid');
  return version;
};

const iso = (value) => (value instanceof Date ? value.toISOString() : value ?? null);
const contextView = (doc, { withState = true } = {}) => {
  const view = {
    conversationId: doc.conversationId,
    version: doc.version,
    expiresAt: iso(doc.expiresAt),
    updatedAt: iso(doc.updatedAt),
  };
  if (withState) view.state = doc.state;
  return view;
};
const isDuplicateKeyError = (err) =>
  Boolean(err) && (err.code === 11000 || err.code === 11001
    || (Array.isArray(err.writeErrors) && err.writeErrors.some((item) => item?.code === 11000)));

const createAssistantConversationService = ({
  Model = AssistantConversationModel,
  now = () => new Date(),
  config = configFromEnv(),
  isConnected = () => (Model.db ? Model.db.readyState : mongoose.connection.readyState) === 1,
  logger = console,
} = {}) => {
  const { ttlMs } = config;

  let indexesVerified = false;
  const ensureReady = async () => {
    if (indexesVerified) return;
    let connected = false;
    try {
      connected = Boolean(isConnected());
    } catch (_err) {
      connected = false;
    }
    if (!connected) throw new AssistantConversationUnavailableError('database_unavailable');
    let indexes;
    try {
      indexes = await Model.listIndexes();
    } catch (err) {
      logger.error('[assistant-conversations] falha ao consultar indices', err?.name);
      throw new AssistantConversationUnavailableError('context_indexes_unavailable');
    }
    const missing = missingIndexes(indexes);
    if (missing.length) {
      logger.error('[assistant-conversations] indices obrigatorios ausentes ou incorretos', missing.join(','));
      throw new AssistantConversationUnavailableError('context_indexes_missing', { missing });
    }
    indexesVerified = true;
  };

  const scope = (ownerId, conversationId) => ({
    ownerId: normalizeOwner(ownerId),
    conversationId: normalizeConversation(conversationId),
  });
  const findLive = (filterBase, t) => Model.findOne({ ...filterBase, expiresAt: { $gt: t } }).lean();
  const conflict = async (filterBase, t) => {
    const live = await findLive(filterBase, t);
    return { ok: false, reason: 'version_conflict', version: live ? live.version : 0 };
  };

  const getCurrent = async ({ ownerId, conversationId }) => {
    const filterBase = scope(ownerId, conversationId);
    await ensureReady();
    const doc = await findLive(filterBase, now());
    return doc ? contextView(doc) : null;
  };

  // Grava o estado inteiro se o version vivo ainda for o lido (0 = nenhum vivo).
  const save = async ({ ownerId, conversationId, expectedVersion, state }) => {
    const filterBase = scope(ownerId, conversationId);
    const expected = normalizeVersion(expectedVersion);
    const clean = normalizeState(state, { memory: isMemoryConversation(filterBase.conversationId) });
    await ensureReady();
    const t = now();
    const changes = { $set: { state: clean, expiresAt: new Date(t.getTime() + ttlMs) }, $inc: { version: 1 } };
    const options = { new: true, runValidators: true };
    if (expected > 0) {
      const doc = await Model.findOneAndUpdate({ ...filterBase, version: expected, expiresAt: { $gt: t } }, changes, options).lean();
      return doc ? { ok: true, context: contextView(doc, { withState: false }) } : conflict(filterBase, t);
    }
    // Nenhum contexto vivo lido: reaproveita o documento vencido (se houver) ou cria. O indice unico impede dois.
    const reused = await Model.findOneAndUpdate({ ...filterBase, expiresAt: { $lte: t } }, changes, options).lean();
    if (reused) return { ok: true, context: contextView(reused, { withState: false }) };
    try {
      const created = await Model.create({ ...filterBase, version: 1, state: clean, expiresAt: changes.$set.expiresAt });
      const plain = typeof created?.toObject === 'function' ? created.toObject() : created;
      return { ok: true, context: contextView(plain, { withState: false }) };
    } catch (err) {
      if (isDuplicateKeyError(err)) return conflict(filterBase, t);
      throw err;
    }
  };

  // Limpa o contexto. Com expectedVersion: so se o vivo ainda for o lido (cancelamento do fluxo certo); 0 = "nao
  // havia nada" (conflito se surgiu um vivo). Sem expectedVersion: incondicional (standby: a pessoa saiu da conversa).
  const clear = async ({ ownerId, conversationId, expectedVersion }) => {
    const filterBase = scope(ownerId, conversationId);
    const expected = normalizeVersion(expectedVersion, { optional: true });
    await ensureReady();
    const t = now();
    if (expected === undefined) {
      const outcome = await Model.deleteOne(filterBase);
      return { ok: true, cleared: Boolean(outcome && outcome.deletedCount) };
    }
    if (expected === 0) {
      if (await findLive(filterBase, t)) return conflict(filterBase, t);
      const outcome = await Model.deleteOne({ ...filterBase, expiresAt: { $lte: t } });
      return { ok: true, cleared: Boolean(outcome && outcome.deletedCount) };
    }
    const outcome = await Model.deleteOne({ ...filterBase, version: expected });
    if (outcome && outcome.deletedCount) return { ok: true, cleared: true };
    if (await findLive(filterBase, t)) return conflict(filterBase, t);
    return { ok: true, cleared: false };
  };

  return { ensureReady, getCurrent, save, clear };
};

module.exports = {
  createAssistantConversationService,
  configFromEnv,
  missingIndexes,
  normalizeState,
  MEMORY_SUFFIX,
  MEMORY_LABELS,
  REQUIRED_INDEXES,
  AssistantConversationInputError,
  AssistantConversationUnavailableError,
  DEFAULT_TTL_SECONDS,
  STATE_MAX_BYTES,
};
