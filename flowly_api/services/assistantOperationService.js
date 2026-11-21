const crypto = require('crypto');
const mongoose = require('mongoose');
const AssistantOperationModel = require('../models/AssistantOperation');
const { retentionMsFromEnv } = require('./idempotencyService');

const {
  ACTIVE_STATUSES,
  TERMINAL_STATUSES,
  ASSISTANT_WRITE_COMMANDS,
  UUID_V4_PATTERN,
  CONVERSATION_ID_PATTERN,
  CODE_PATTERN,
  RESOURCE_TYPE_PATTERN,
  OBJECT_ID_PATTERN,
  SUMMARY_MAX_LENGTH,
  PARAM_LIMITS,
} = AssistantOperationModel;

// Confirmacoes compartilhadas do assistente (ainda sem rotas). A API e a dona do registro; quem executa a escrita
// da tarefa/equipe e o assistente, pelas rotas publicas, com a idempotencyKey desta operacao. A garantia de execucao
// unica vem do nucleo de idempotencia da API (mesma chave = no maximo uma execucao); o claim aqui organiza quem
// tenta e quando, e o estado mostrado ao usuario.
//
// Toda mudanca de estado e UM findOneAndUpdate condicional (atomico no documento) que repete no filtro o dono, a
// conversa, a operacao, o estado esperado e, quando se aplica, prazos e claimToken. Nada depende de ler antes e
// gravar depois. Leituras so servem para explicar uma recusa.
//
// Prazos (todos do relogio do servidor, nunca do cliente):
//  - expiresAt (padrao 120 s): ultimo instante para o PRIMEIRO claim de uma pending. Nao afeta execucao ja
//    reivindicada.
//  - leaseUntil (padrao 180 s por claim): o detentor so conclui antes disso; depois, outro claim pode assumir
//    (recuperacao, MESMA idempotencyKey). 180 s cobre o pior caso previsto de uma tentativa: /users/me e a escrita
//    no assistente (timeout padrao de 20 s cada) mais o withTransaction da API, que o driver repete por ate 120 s.
//  - recoverUntil (expiresAt + 10 min): nenhum claim depois disso; o que estiver ativo vira unknown.
//  - retainUntil (24 h, nunca mais que a retencao da chave de idempotencia da API): remocao pelo TTL.
//  - no maximo 3 claims (a primeira execucao e duas recuperacoes).
// unknown e terminal: nunca dispara escrita de novo. Nada roda em segundo plano: os prazos vencidos sao
// assentados quando alguem consulta ou tenta usar a conversa/operacao.

const DEFAULT_CONFIRM_SECONDS = 120;
const DEFAULT_RECOVERY_MINUTES = 10;
const DEFAULT_LEASE_SECONDS = 180;
const DEFAULT_RETENTION_HOURS = 24;
const MAX_CLAIMS = 3;

const clampInt = (raw, fallback, min, max) => {
  const value = Number.parseInt(String(raw ?? ''), 10);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(Math.max(value, min), max);
};

const configFromEnv = (env = process.env) => {
  const confirmMs = clampInt(env.ASSISTANT_OPERATION_CONFIRM_SECONDS, DEFAULT_CONFIRM_SECONDS, 30, 600) * 1000;
  const recoveryMs = clampInt(env.ASSISTANT_OPERATION_RECOVERY_MINUTES, DEFAULT_RECOVERY_MINUTES, 1, 30) * 60 * 1000;
  const leaseMs = clampInt(env.ASSISTANT_OPERATION_LEASE_SECONDS, DEFAULT_LEASE_SECONDS, 60, 600) * 1000;
  // Nunca alem da retencao da chave de idempotencia da API: enquanto este registro existir, uma recuperacao com a
  // mesma chave ainda encontra o registro da API (e nao executa de novo).
  const retentionMs = Math.min(
    clampInt(env.ASSISTANT_OPERATION_RETENTION_HOURS, DEFAULT_RETENTION_HOURS, 1, DEFAULT_RETENTION_HOURS) * 3600 * 1000,
    retentionMsFromEnv(env)
  );
  return { confirmMs, recoveryMs, leaseMs, retentionMs, maxClaims: MAX_CLAIMS };
};

class AssistantOperationInputError extends Error {
  constructor(code) {
    super(code);
    this.name = 'AssistantOperationInputError';
    this.code = code;
  }
}

// O servico recusa operar (fail-closed) sem conexao ou sem os indices obrigatorios: sem eles, duas operacoes ativas
// na mesma conversa (ou operationId repetido) passariam, e o banco nao removeria registros vencidos.
class AssistantOperationUnavailableError extends Error {
  constructor(code, details = {}) {
    super(code);
    this.name = 'AssistantOperationUnavailableError';
    this.code = code;
    this.missing = details.missing || [];
  }
}

// Requisitos dos indices, conferidos pelas propriedades (nunca so pelo nome; um indice renomeado mas correto vale).
const sameKeys = (actual, expected) => {
  if (!actual || typeof actual !== 'object') return false;
  const entries = Object.entries(actual);
  return entries.length === expected.length
    && entries.every(([name, direction], index) => name === expected[index][0] && Number(direction) === expected[index][1]);
};
const semCollation = (index) => !index.collation || index.collation.locale === 'simple';
const isActiveSlotPartial = (expression) => {
  if (!expression || typeof expression !== 'object' || Array.isArray(expression)) return false;
  const keys = Object.keys(expression);
  if (keys.length !== 1 || keys[0] !== 'activeSlot') return false;
  const value = expression.activeSlot;
  return value === true
    || (value && typeof value === 'object' && Object.keys(value).length === 1 && value.$eq === true);
};
const REQUIRED_INDEXES = Object.freeze([
  {
    name: 'operation_id_unique',
    // Unico global: nem parcial nem esparso (senao a unicidade valeria so para parte dos documentos).
    matches: (index) => sameKeys(index.key, [['operationId', 1]]) && index.unique === true
      && !index.partialFilterExpression && index.sparse !== true && semCollation(index),
  },
  {
    name: 'active_operation_per_conversation',
    matches: (index) => sameKeys(index.key, [['ownerId', 1], ['conversationId', 1]]) && index.unique === true
      && isActiveSlotPartial(index.partialFilterExpression) && index.sparse !== true
      && index.expireAfterSeconds === undefined && semCollation(index),
  },
  {
    name: 'retain_until_ttl',
    // retainUntil ja e o instante absoluto de remocao: expireAfterSeconds precisa ser 0, sem filtro parcial.
    matches: (index) => sameKeys(index.key, [['retainUntil', 1]]) && index.expireAfterSeconds === 0
      && !index.partialFilterExpression,
  },
]);
const missingIndexes = (indexes) =>
  REQUIRED_INDEXES.filter((required) => !(indexes || []).some((index) => required.matches(index))).map((r) => r.name);

// Parametros aceitos por comando (os mesmos que o assistente executa). Rotulos internos (_task_label...) e
// qualquer outra chave sao recusados: o resumo ja vem pronto em summary.
const COMMAND_PARAMS = Object.freeze({
  create_team: { required: ['nome'], optional: [] },
  create_task: { required: ['nome', 'dataEntrega', 'urgencia', 'equipe'], optional: ['descricao', 'user'] },
  add_comment: { required: ['task_id', 'texto'], optional: [] },
  add_subtask: { required: ['task_id', 'descricao'], optional: [] },
  assign_to_me: { required: ['task_id'], optional: ['team_id'] },
  update_status: { required: ['task_id', 'status'], optional: [] },
  timer: { required: ['task_id', 'acao'], optional: [] },
});
const PARAM_RULES = Object.freeze({
  task_id: (v) => OBJECT_ID_PATTERN.test(v),
  team_id: (v) => OBJECT_ID_PATTERN.test(v),
  equipe: (v) => OBJECT_ID_PATTERN.test(v),
  user: (v) => v === '__none__' || OBJECT_ID_PATTERN.test(v),
  status: (v) => ['pendente', 'em_andamento', 'concluido'].includes(v),
  acao: (v) => ['iniciar', 'pausar'].includes(v),
  urgencia: (v) => ['alta', 'media', 'baixa'].includes(v),
  nome: (v) => v.trim().length > 0 && v.length <= PARAM_LIMITS.nome,
  descricao: (v) => v.trim().length > 0 && v.length <= PARAM_LIMITS.descricao,
  texto: (v) => v.trim().length > 0 && v.length <= PARAM_LIMITS.texto,
  dataEntrega: (v) => /^\d{4}-\d{2}-\d{2}(?:T[0-9:.+\-Z]{0,19})?$/.test(v) && v.length <= PARAM_LIMITS.dataEntrega,
});
// Conteudo que nunca deve ser guardado (token colado num comentario, URL assinada): recusa a operacao inteira.
const SENSITIVE_PATTERNS = [
  /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/, // JWT
  /\bbearer\s+[A-Za-z0-9._~+/=-]{16,}/i,
  /[?&](?:X-Goog-Signature|X-Goog-Credential|X-Amz-Signature|X-Amz-Credential|Signature|sig)=/i, // URL assinada
];
const hasSensitive = (text) => SENSITIVE_PATTERNS.some((pattern) => pattern.test(text));

const isPlainObject = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
  && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);

const normalizeOwner = (ownerId) => {
  const value = ownerId instanceof mongoose.Types.ObjectId ? ownerId.toHexString() : ownerId;
  if (typeof value !== 'string' || !OBJECT_ID_PATTERN.test(value.toLowerCase())) {
    throw new AssistantOperationInputError('owner_invalid');
  }
  return value.toLowerCase();
};
const normalizeConversation = (conversationId) => {
  if (typeof conversationId !== 'string' || !CONVERSATION_ID_PATTERN.test(conversationId)) {
    throw new AssistantOperationInputError('conversation_invalid');
  }
  return conversationId;
};
const normalizeUuid = (value, code) => {
  if (typeof value !== 'string' || !UUID_V4_PATTERN.test(value)) {
    throw new AssistantOperationInputError(code);
  }
  return value;
};
const normalizeCommand = (commandKey) => {
  if (typeof commandKey !== 'string' || !ASSISTANT_WRITE_COMMANDS.includes(commandKey)) {
    throw new AssistantOperationInputError('command_invalid');
  }
  return commandKey;
};
const normalizeParams = (commandKey, params) => {
  if (!isPlainObject(params)) throw new AssistantOperationInputError('params_invalid');
  const { required, optional } = COMMAND_PARAMS[commandKey];
  const allowed = new Set([...required, ...optional]);
  const clean = {};
  Object.keys(params).forEach((name) => {
    const value = params[name];
    if (!allowed.has(name) || typeof value !== 'string' || !PARAM_RULES[name](value)) {
      throw new AssistantOperationInputError('params_invalid');
    }
    if (hasSensitive(value)) throw new AssistantOperationInputError('params_sensitive');
    clean[name] = value;
  });
  if (required.some((name) => clean[name] === undefined)) throw new AssistantOperationInputError('params_invalid');
  return clean;
};
const normalizeSummary = (summary) => {
  if (typeof summary !== 'string' || !summary.trim() || summary.length > SUMMARY_MAX_LENGTH) {
    throw new AssistantOperationInputError('summary_invalid');
  }
  if (hasSensitive(summary)) throw new AssistantOperationInputError('summary_sensitive');
  return summary;
};
// Resumo tecnico do desfecho: so status HTTP, codigo, tipo/ID do recurso e se foi repeticao.
const normalizeResult = (result) => {
  if (result === undefined || result === null) return undefined;
  if (!isPlainObject(result)) throw new AssistantOperationInputError('result_invalid');
  const clean = {};
  Object.keys(result).forEach((name) => {
    const value = result[name];
    if (value === undefined || value === null) return;
    const ok = {
      httpStatus: () => Number.isInteger(value) && value >= 100 && value <= 599,
      code: () => typeof value === 'string' && CODE_PATTERN.test(value),
      resourceType: () => typeof value === 'string' && RESOURCE_TYPE_PATTERN.test(value),
      resourceId: () => typeof value === 'string' && OBJECT_ID_PATTERN.test(value.toLowerCase()),
      replayed: () => typeof value === 'boolean',
    }[name];
    if (!ok || !ok()) throw new AssistantOperationInputError('result_invalid');
    clean[name] = name === 'resourceId' ? value.toLowerCase() : value;
  });
  return Object.keys(clean).length ? clean : undefined;
};

// Defesa extra: nenhuma atualizacao deste servico toca campos imutaveis (o Mongoose so ignora $set no caminho
// inteiro de um subdocumento imutavel, nao em 'params.x').
const IMMUTABLE_PATHS = ['operationId', 'ownerId', 'conversationId', 'commandKey', 'params', 'summary',
  'idempotencyKey', 'expiresAt', 'recoverUntil', 'retainUntil'];
const assertMutable = (update) => {
  ['$set', '$unset', '$inc'].forEach((op) => {
    Object.keys(update[op] || {}).forEach((path) => {
      if (IMMUTABLE_PATHS.some((name) => path === name || path.startsWith(`${name}.`))) {
        throw new Error(`atualizacao de campo imutavel recusada: ${path}`);
      }
    });
  });
  return update;
};

const iso = (value) => (value instanceof Date ? value.toISOString() : value ?? null);

// Impressao digital dos parametros executaveis GRAVADOS (derivada, nada novo no modelo). Permite ao assistente
// conferir, depois de perder a resposta do create, se a operacao encontrada tem exatamente os parametros que ele
// enviou, sem que a consulta de estado devolva os parametros. Serializacao canonica, igual a do Python
// (operations_client.params_fingerprint): JSON compacto de {commandKey, params} com as chaves de params em ordem,
// so valores string (ausentes/nulos ficam fora), prefixado pelo dominio e com SHA-256 em hex.
// Valores de baixa entropia (ex.: status) sao adivinhaveis pelo hash: ele so circula no contrato interno.
const PARAMS_FINGERPRINT_DOMAIN = 'flowly-assistant-operation-params:v1\n';
const paramsFingerprint = (commandKey, params) => {
  if (typeof commandKey !== 'string' || !isPlainObject(params)) return null;
  const sorted = {};
  const names = Object.keys(params).filter((name) => params[name] !== undefined && params[name] !== null).sort();
  for (const name of names) {
    if (typeof params[name] !== 'string') return null; // formato inesperado: sem impressao, sem reutilizacao
    sorted[name] = params[name];
  }
  const canonical = JSON.stringify({ commandKey, params: sorted });
  return crypto.createHash('sha256').update(PARAMS_FINGERPRINT_DOMAIN + canonical, 'utf8').digest('hex');
};

// Visao de estado (contrato interno): sem dono, parametros, chave de idempotencia, claimToken ou lease. Leva so a
// impressao digital dos parametros; o assistente nunca a repassa ao navegador.
const publicView = (doc) => ({
  operationId: doc.operationId,
  conversationId: doc.conversationId,
  commandKey: doc.commandKey,
  summary: doc.summary,
  status: doc.status,
  attempts: doc.attempts,
  expiresAt: iso(doc.expiresAt),
  recoverUntil: iso(doc.recoverUntil),
  result: doc.result ? { ...doc.result } : null,
  createdAt: iso(doc.createdAt),
  updatedAt: iso(doc.updatedAt),
  paramsFingerprint: paramsFingerprint(doc.commandKey, doc.params),
});
// Visao do claim (so para o fluxo interno que vai executar a escrita).
const claimView = (doc) => ({
  ...publicView(doc),
  params: { ...doc.params },
  idempotencyKey: doc.idempotencyKey,
  claimToken: doc.claimToken,
  leaseUntil: iso(doc.leaseUntil),
  recovery: doc.attempts > 1,
});

const isDuplicateKeyError = (err) =>
  Boolean(err) && (err.code === 11000 || err.code === 11001
    || (Array.isArray(err.writeErrors) && err.writeErrors.some((item) => item?.code === 11000)));
const isActiveSlotConflict = (err) =>
  Boolean(err?.keyPattern && 'conversationId' in err.keyPattern)
  || /active_operation_per_conversation/.test(String(err?.message || err?.errmsg || ''));

const createAssistantOperationService = ({
  Model = AssistantOperationModel,
  now = () => new Date(),
  newUuid = () => crypto.randomUUID(),
  config = configFromEnv(),
  // Mongoose: readyState 1 = conectado. Sem conexao, nem consulta os indices (o Mongoose enfileiraria a chamada).
  isConnected = () => (Model.db ? Model.db.readyState : mongoose.connection.readyState) === 1,
  logger = console,
} = {}) => {
  const { confirmMs, recoveryMs, leaseMs, retentionMs, maxClaims } = config;
  if (!(retentionMs > confirmMs + recoveryMs + leaseMs)) {
    throw new Error('configuracao invalida: a retencao precisa cobrir confirmacao, recuperacao e lease');
  }

  // Prontidao (fail-closed), no mesmo padrao do nucleo de idempotencia: so le os indices (nunca cria); guarda em
  // cache apenas o sucesso, entao uma falha e conferida de novo na proxima chamada.
  let indexesVerified = false;
  const ensureReady = async () => {
    if (indexesVerified) return;
    let connected = false;
    try {
      connected = Boolean(isConnected());
    } catch (_err) {
      connected = false;
    }
    if (!connected) throw new AssistantOperationUnavailableError('database_unavailable');
    let indexes;
    try {
      indexes = await Model.listIndexes();
    } catch (err) {
      logger.error('[assistant-operations] falha ao consultar indices', err?.name);
      throw new AssistantOperationUnavailableError('operation_indexes_unavailable');
    }
    const missing = missingIndexes(indexes);
    if (missing.length) {
      logger.error('[assistant-operations] indices obrigatorios ausentes ou incorretos', missing.join(','));
      throw new AssistantOperationUnavailableError('operation_indexes_missing', { missing });
    }
    indexesVerified = true;
  };

  const scope = (ownerId, conversationId, operationId) => {
    const filter = { ownerId: normalizeOwner(ownerId), conversationId: normalizeConversation(conversationId) };
    if (operationId !== undefined) filter.operationId = normalizeUuid(operationId, 'operation_invalid');
    return filter;
  };
  const newToken = () => {
    const token = newUuid();
    if (!UUID_V4_PATTERN.test(token)) throw new Error('gerador de UUID invalido');
    return token;
  };
  const update = (filter, changes, { privado = false } = {}) => {
    const query = Model.findOneAndUpdate(filter, assertMutable(changes), { new: true, runValidators: true });
    return (privado ? query.select('+idempotencyKey +claimToken') : query).lean();
  };
  const terminalChanges = (status, result) => {
    const changes = { $set: { status }, $unset: { activeSlot: '', leaseUntil: '', claimToken: '' } };
    if (result) changes.$set.result = result;
    return changes;
  };

  // Assenta prazos vencidos de uma conversa (sem segundo plano): pending vencida -> expired; ativa sem claim
  // possivel (recuperacao encerrada ou tentativas esgotadas, e sem lease valido) -> unknown.
  const settleConversation = async (filterBase, t) => {
    await update({ ...filterBase, status: 'pending', expiresAt: { $lte: t } }, terminalChanges('expired'));
    const semLease = { $or: [{ status: 'retry_pending' }, { status: 'executing', leaseUntil: { $lte: t } }] };
    await update({ ...filterBase, ...semLease, recoverUntil: { $lte: t } },
      terminalChanges('unknown', { code: 'recovery_window_elapsed' }));
    await update({ ...filterBase, ...semLease, attempts: { $gte: maxClaims } },
      terminalChanges('unknown', { code: 'attempts_exhausted' }));
  };
  const findScoped = (filter) => Model.findOne(filter).lean();

  // Explica por que um claim/conclusao/cancelamento nao casou, assentando o prazo vencido quando for o caso.
  const explain = async (filter, t) => {
    await settleConversation({ ownerId: filter.ownerId, conversationId: filter.conversationId }, t);
    const doc = await findScoped(filter);
    if (!doc) return { ok: false, reason: 'not_found' };
    const operation = publicView(doc);
    if (TERMINAL_STATUSES.includes(doc.status)) {
      return { ok: false, reason: doc.status === 'expired' ? 'expired' : 'terminal', operation };
    }
    if (doc.status === 'executing' && doc.leaseUntil && new Date(doc.leaseUntil) > t) {
      return { ok: false, reason: 'in_progress', operation };
    }
    return { ok: false, reason: 'state_changed', operation };
  };

  const create = async ({ ownerId, conversationId, commandKey, params, summary }) => {
    const filterBase = scope(ownerId, conversationId);
    const command = normalizeCommand(commandKey);
    const doc = {
      ...filterBase,
      commandKey: command,
      params: normalizeParams(command, params),
      summary: normalizeSummary(summary),
    };
    await ensureReady();
    const t = now();
    await settleConversation(filterBase, t);
    Object.assign(doc, {
      operationId: newToken(),
      idempotencyKey: newToken(),
      status: 'pending',
      activeSlot: true,
      attempts: 0,
      expiresAt: new Date(t.getTime() + confirmMs),
      recoverUntil: new Date(t.getTime() + confirmMs + recoveryMs),
      retainUntil: new Date(t.getTime() + retentionMs),
    });
    if (doc.operationId === doc.idempotencyKey) throw new Error('operationId e idempotencyKey precisam ser distintos');
    try {
      const created = await Model.create(doc);
      const plain = typeof created?.toObject === 'function' ? created.toObject() : created;
      return { ok: true, operation: publicView({ ...doc, ...plain }) };
    } catch (err) {
      // A vaga da conversa e garantida pelo indice unico parcial, nao pela leitura de antes.
      if (isDuplicateKeyError(err) && isActiveSlotConflict(err)) {
        const current = await findScoped({ ...filterBase, activeSlot: true });
        return { ok: false, reason: 'conversation_busy', operation: current ? publicView(current) : null };
      }
      throw err;
    }
  };

  // Operacao mais recente da conversa (a ativa, se houver: so existe uma e ela e sempre a mais nova).
  const getCurrent = async ({ ownerId, conversationId }) => {
    const filterBase = scope(ownerId, conversationId);
    await ensureReady();
    await settleConversation(filterBase, now());
    const doc = await Model.findOne(filterBase).sort({ createdAt: -1, _id: -1 }).lean();
    return doc ? publicView(doc) : null;
  };

  const claim = async ({ ownerId, conversationId, operationId }) => {
    const filter = scope(ownerId, conversationId, operationId);
    await ensureReady();
    const t = now();
    const disponivel = {
      ...filter,
      attempts: { $lt: maxClaims },
      $or: [
        { status: 'pending', expiresAt: { $gt: t } },
        { status: 'executing', leaseUntil: { $lte: t }, recoverUntil: { $gt: t } }, // lease vencido: recuperacao
        { status: 'retry_pending', recoverUntil: { $gt: t } },
      ],
    };
    const claimed = await update(
      disponivel,
      // activeSlot explicito: se outra operacao ativa existisse na conversa (invariante quebrada), o indice unico
      // parcial recusaria esta escrita em vez de deixar duas ativas.
      {
        $set: { status: 'executing', activeSlot: true, claimToken: newToken(), leaseUntil: new Date(t.getTime() + leaseMs) },
        $inc: { attempts: 1 },
      },
      { privado: true }
    );
    if (claimed) return { ok: true, operation: claimView(claimed) };
    return explain(filter, t);
  };

  // Conclusao pelo detentor do claim atual, com lease valido: completed, failed ou unknown (terminais).
  const complete = async ({ ownerId, conversationId, operationId, claimToken, outcome, result }) => {
    const filter = scope(ownerId, conversationId, operationId);
    if (!['completed', 'failed', 'unknown'].includes(outcome)) throw new AssistantOperationInputError('outcome_invalid');
    const token = normalizeUuid(claimToken, 'claim_token_invalid');
    const clean = normalizeResult(result);
    await ensureReady();
    const t = now();
    const done = await update(
      { ...filter, status: 'executing', claimToken: token, leaseUntil: { $gt: t } },
      terminalChanges(outcome, clean)
    );
    if (done) return { ok: true, operation: publicView(done) };
    const explained = await explain(filter, t);
    return explained.reason === 'not_found' ? explained : { ...explained, reason: 'claim_lost' };
  };

  // Desfecho inconclusivo (timeout, rede, 503/500 retentavel): libera para recuperacao com a MESMA chave, se ainda
  // houver claim e prazo; senao, unknown (terminal, sem nova escrita).
  const recordRetry = async ({ ownerId, conversationId, operationId, claimToken, result }) => {
    const filter = scope(ownerId, conversationId, operationId);
    const token = normalizeUuid(claimToken, 'claim_token_invalid');
    const clean = normalizeResult(result);
    await ensureReady();
    const t = now();
    const holder = { ...filter, status: 'executing', claimToken: token, leaseUntil: { $gt: t } };
    const retry = { $set: { status: 'retry_pending', activeSlot: true }, $unset: { leaseUntil: '', claimToken: '' } };
    if (clean) retry.$set.result = clean;
    const released = await update({ ...holder, attempts: { $lt: maxClaims }, recoverUntil: { $gt: t } }, retry);
    if (released) return { ok: true, operation: publicView(released) };
    const exhausted = await update({ ...holder, attempts: { $gte: maxClaims } },
      terminalChanges('unknown', { ...(clean || {}), code: 'attempts_exhausted' }));
    if (exhausted) return { ok: true, operation: publicView(exhausted) };
    const elapsed = await update({ ...holder, recoverUntil: { $lte: t } },
      terminalChanges('unknown', { ...(clean || {}), code: 'recovery_window_elapsed' }));
    if (elapsed) return { ok: true, operation: publicView(elapsed) };
    const explained = await explain(filter, t);
    return explained.reason === 'not_found' ? explained : { ...explained, reason: 'claim_lost' };
  };

  // So pending dentro do prazo. Execucao ja reivindicada (ou em recuperacao) nunca e cancelada: a escrita pode ter
  // acontecido.
  const cancel = async ({ ownerId, conversationId, operationId }) => {
    const filter = scope(ownerId, conversationId, operationId);
    await ensureReady();
    const t = now();
    const cancelled = await update({ ...filter, status: 'pending', expiresAt: { $gt: t } }, terminalChanges('cancelled'));
    if (cancelled) return { ok: true, operation: publicView(cancelled) };
    const explained = await explain(filter, t);
    if (explained.operation && ACTIVE_STATUSES.includes(explained.operation.status)) {
      return { ...explained, reason: 'in_progress' };
    }
    return explained;
  };

  const expire = async ({ ownerId, conversationId, operationId }) => {
    const filter = scope(ownerId, conversationId, operationId);
    await ensureReady();
    const expired = await update({ ...filter, status: 'pending', expiresAt: { $lte: now() } }, terminalChanges('expired'));
    if (expired) return { ok: true, operation: publicView(expired) };
    const doc = await findScoped(filter);
    return doc ? { ok: false, reason: 'not_pending_or_not_due', operation: publicView(doc) } : { ok: false, reason: 'not_found' };
  };

  const getResult = async ({ ownerId, conversationId, operationId }) => {
    const filter = scope(ownerId, conversationId, operationId);
    await ensureReady();
    await settleConversation({ ownerId: filter.ownerId, conversationId: filter.conversationId }, now());
    const doc = await findScoped(filter);
    if (!doc) return { ok: false, reason: 'not_found' };
    if (!TERMINAL_STATUSES.includes(doc.status)) return { ok: false, reason: 'not_terminal', operation: publicView(doc) };
    return { ok: true, operation: publicView(doc) };
  };

  return { create, getCurrent, claim, complete, recordRetry, cancel, expire, getResult };
};

module.exports = {
  createAssistantOperationService,
  paramsFingerprint,
  configFromEnv,
  missingIndexes,
  REQUIRED_INDEXES,
  AssistantOperationInputError,
  AssistantOperationUnavailableError,
  COMMAND_PARAMS,
  MAX_CLAIMS,
  DEFAULT_CONFIRM_SECONDS,
  DEFAULT_RECOVERY_MINUTES,
  DEFAULT_LEASE_SECONDS,
  DEFAULT_RETENTION_HOURS,
};
