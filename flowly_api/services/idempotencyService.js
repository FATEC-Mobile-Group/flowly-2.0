const crypto = require('crypto');
const mongoose = require('mongoose');
const IdempotencyKeyModel = require('../models/IdempotencyKey');
const mongoTransactions = require('../utils/mongoTransactions');

const {
  CODE_PATTERN,
  IDEMPOTENCY_KEY_LENGTH,
  IDEMPOTENCY_KEY_PATTERN,
  IDEMPOTENCY_METHODS,
  OBJECT_ID_PATTERN,
  RESOURCE_TYPE_PATTERN,
  ROUTE_PATTERN,
} = IdempotencyKeyModel;

// Nucleo de idempotencia para escritas (ainda nao ligado a nenhuma rota).
//
// Fluxo de execute(request, work):
//  1. valida chave, usuario, metodo e rota e calcula o hash canonico do pedido;
//  2. sem transacao ou sem o indice unico, recusa (503) antes de gravar qualquer coisa;
//  3. reivindica a chave FORA da transacao (insert com indice unico userId+key), com uma ficha (claimToken) e
//     um prazo de reserva (lockedUntil). Chave ja existente: mesmo pedido -> repete o resultado guardado,
//     espera (em andamento) ou assume (reserva vencida / falha sem efeito); pedido diferente -> 422;
//  4. DENTRO da transacao, a primeira escrita e a cerca: in_progress+ficha -> completed. Depois o trabalho
//     (tudo com { session }) e o resumo do resultado. Efeito e registro entram ou saem juntos;
//  5. o withTransaction pode repetir o callback (TransientTransactionError) e o commit
//     (UnknownTransactionCommitResult): o trabalho nao pode ter efeito fora da sessao; avisos (socket etc.)
//     vao em afterCommit, chamado uma unica vez depois do commit;
//  6. erro no commit: o proprio registro diz se a transacao entrou (completed com a nossa ficha). Sem essa
//     prova, o registro vira "unknown" e a chave nao executa de novo sozinha.
//
// Prazo de reserva x transacao lenta: a cerca e a PRIMEIRA escrita da transacao, entao o registro fica travado
// por ela ate o commit/abort. No MongoDB, a escrita de quem tenta assumir (fora da transacao) espera essa trava;
// se a transacao entrar, o registro ja esta "completed" e ninguem assume. Se quem assumiu chegou antes da cerca,
// a cerca nao encontra a ficha antiga e a transacao antiga aborta sem efeito.
//
// Retencao: a garantia vale enquanto o registro existir. Depois da exclusao pelo TTL (expiresAt; padrao 7 dias,
// minimo 24 h), a mesma chave seria tratada como nova. Ver models/IdempotencyKey.js.

const DEFAULT_RETENTION_HOURS = 168; // 7 dias
const MIN_RETENTION_HOURS = 24;
const MAX_RETENTION_HOURS = 720;
const DEFAULT_LEASE_SECONDS = 30;
const MIN_LEASE_SECONDS = 5;
const MAX_LEASE_SECONDS = 300;
const MAX_CANONICAL_DEPTH = 20;

const clampNumber = (raw, fallback, min, max) => {
  const value = Number.parseInt(String(raw ?? ''), 10);
  if (!Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(Math.max(value, min), max);
};

const retentionMsFromEnv = (env = process.env) =>
  clampNumber(env.IDEMPOTENCY_RETENTION_HOURS, DEFAULT_RETENTION_HOURS, MIN_RETENTION_HOURS, MAX_RETENTION_HOURS) *
  3600 * 1000;

const leaseMsFromEnv = (env = process.env) =>
  clampNumber(env.IDEMPOTENCY_LEASE_SECONDS, DEFAULT_LEASE_SECONDS, MIN_LEASE_SECONDS, MAX_LEASE_SECONDS) * 1000;

class IdempotencyInputError extends Error {
  constructor(code) {
    super(code);
    this.name = 'IdempotencyInputError';
    this.code = code;
  }
}

// Falha de negocio deterministica lancada pelo trabalho (ex.: 403, 404, 409, 400): nada foi gravado e repetir o
// mesmo pedido daria o mesmo resultado. Fica guardada e e devolvida nas repeticoes, sem executar de novo.
class IdempotentRequestError extends Error {
  constructor(statusCode, code) {
    super(code);
    this.name = 'IdempotentRequestError';
    if (!Number.isInteger(statusCode) || statusCode < 400 || statusCode > 499) {
      throw new TypeError('IdempotentRequestError exige status 4xx');
    }
    if (!CODE_PATTERN.test(String(code))) {
      throw new TypeError('IdempotentRequestError exige codigo em snake_case');
    }
    this.statusCode = statusCode;
    this.code = code;
  }
}

class IdempotencyFenceError extends Error {
  constructor() {
    super('idempotency_claim_lost');
    this.name = 'IdempotencyFenceError';
  }
}

const hasErrorLabel = (err, label) =>
  Boolean(err) &&
  ((typeof err.hasErrorLabel === 'function' && err.hasErrorLabel(label)) ||
    (Array.isArray(err.errorLabels) && err.errorLabels.includes(label)));

const isDuplicateKeyError = (err) =>
  Boolean(err) &&
  (err.code === 11000 ||
    err.code === 11001 ||
    (Array.isArray(err.writeErrors) && err.writeErrors.some((item) => item?.code === 11000)));

const normalizeKey = (key) => {
  if (typeof key !== 'string' || key.length !== IDEMPOTENCY_KEY_LENGTH) {
    throw new IdempotencyInputError('idempotency_key_invalid');
  }
  const normalized = key.toLowerCase();
  if (!IDEMPOTENCY_KEY_PATTERN.test(normalized)) {
    throw new IdempotencyInputError('idempotency_key_invalid');
  }
  return normalized;
};

const normalizeUserId = (userId) => {
  const value = userId instanceof mongoose.Types.ObjectId ? userId.toHexString() : userId;
  if (typeof value !== 'string' || !OBJECT_ID_PATTERN.test(value.toLowerCase())) {
    throw new IdempotencyInputError('idempotency_user_invalid');
  }
  return value.toLowerCase();
};

const normalizeMethod = (method) => {
  const value = typeof method === 'string' ? method.toUpperCase() : '';
  if (!IDEMPOTENCY_METHODS.includes(value)) {
    throw new IdempotencyInputError('idempotency_method_invalid');
  }
  return value;
};

const normalizeRoute = (route) => {
  if (typeof route !== 'string' || !ROUTE_PATTERN.test(route)) {
    throw new IdempotencyInputError('idempotency_route_invalid');
  }
  return route;
};

// Propriedade propria e enumeravel, mesmo com nome especial: atribuir output.__proto__ = x trocaria o prototipo
// (e a chave sumiria do JSON); defineProperty grava a chave como dado comum.
const defineOwn = (target, name, value) =>
  Object.defineProperty(target, name, { value, enumerable: true, writable: true, configurable: true });

// JSON canonico: chaves em ordem, undefined descartado em objetos (null em listas, como no JSON). Equivalentes
// viram a mesma forma: Date -> string ISO, ObjectId -> hexadecimal (o corpo JSON ja traz esses valores como
// texto). Chaves especiais (__proto__, constructor, prototype, toJSON...) entram como qualquer outra; a saida nao
// tem prototipo. Valores que o JSON nao representa sem ambiguidade sao recusados.
const canonicalize = (value, depth = 0) => {
  if (depth > MAX_CANONICAL_DEPTH) {
    throw new IdempotencyInputError('idempotency_request_too_deep');
  }
  if (value === null) {
    return null;
  }
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      throw new IdempotencyInputError('idempotency_request_invalid');
    }
    return value.toISOString();
  }
  if (value instanceof mongoose.Types.ObjectId) {
    return value.toHexString();
  }
  if (Array.isArray(value)) {
    // Array.from tambem percorre buracos (lista esparsa): viram null, como no JSON.
    return Array.from(value, (item) => (item === undefined ? null : canonicalize(item, depth + 1)));
  }
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return value;
    case 'number':
      if (!Number.isFinite(value)) {
        throw new IdempotencyInputError('idempotency_request_invalid');
      }
      return value;
    case 'object': {
      const prototype = Object.getPrototypeOf(value);
      if (prototype !== Object.prototype && prototype !== null) {
        throw new IdempotencyInputError('idempotency_request_invalid');
      }
      const output = Object.create(null);
      Object.keys(value)
        .sort()
        .forEach((name) => {
          // Pelo descritor: le a propriedade propria (inclusive "__proto__") sem executar getters.
          const descriptor = Object.getOwnPropertyDescriptor(value, name);
          if (!('value' in descriptor)) {
            throw new IdempotencyInputError('idempotency_request_invalid');
          }
          if (descriptor.value !== undefined) {
            defineOwn(output, name, canonicalize(descriptor.value, depth + 1));
          }
        });
      return output;
    }
    default:
      throw new IdempotencyInputError('idempotency_request_invalid');
  }
};

// Hash do pedido: metodo, rota (modelo, ex.: /api/tarefas/:id/status), parametros da rota e corpo relevante.
// Nunca inclui cabecalhos nem o token.
const hashRequest = ({ method, route, params, body }) =>
  crypto
    .createHash('sha256')
    .update(
      JSON.stringify(
        canonicalize({
          v: 1,
          method: normalizeMethod(method),
          route: normalizeRoute(route),
          params: params === undefined ? {} : params,
          body: body === undefined ? null : body,
        })
      )
    )
    .digest('hex');

// So o resumo do resultado e guardado: status 2xx, tipo e ID do recurso. Corpo, URLs e textos ficam de fora.
const sanitizeResult = (outcome) => {
  if (!outcome || typeof outcome !== 'object') {
    throw new IdempotentRequestError(422, 'idempotency_invalid_result');
  }
  const { statusCode, resourceType, resourceId } = outcome;
  if (!Number.isInteger(statusCode) || statusCode < 200 || statusCode > 299) {
    throw new IdempotentRequestError(422, 'idempotency_invalid_result');
  }
  const result = { statusCode };
  if (resourceType !== undefined && resourceType !== null) {
    if (typeof resourceType !== 'string' || !RESOURCE_TYPE_PATTERN.test(resourceType)) {
      throw new IdempotentRequestError(422, 'idempotency_invalid_result');
    }
    result.resourceType = resourceType;
  }
  if (resourceId !== undefined && resourceId !== null) {
    const id = resourceId instanceof mongoose.Types.ObjectId ? resourceId.toHexString() : String(resourceId).toLowerCase();
    if (!OBJECT_ID_PATTERN.test(id)) {
      throw new IdempotentRequestError(422, 'idempotency_invalid_result');
    }
    result.resourceId = id;
  }
  return result;
};

const publicResult = (result) => {
  if (!result) {
    return null;
  }
  const output = {};
  if (result.resourceType) output.resourceType = result.resourceType;
  if (result.resourceId) output.resourceId = String(result.resourceId);
  return output;
};

const responses = {
  executed: (result) => ({ outcome: 'executed', statusCode: result.statusCode, result: publicResult(result) }),
  replayed: (result) => ({ outcome: 'replayed', statusCode: result.statusCode, result: publicResult(result) }),
  failed: (failure, replayed) => ({
    outcome: 'failed',
    statusCode: failure.statusCode,
    code: failure.code,
    retryable: Boolean(failure.retryable),
    replayed: Boolean(replayed),
  }),
  inProgress: () => ({ outcome: 'in_progress', statusCode: 409, code: 'idempotency_in_progress', retryable: true }),
  conflict: () => ({ outcome: 'conflict', statusCode: 422, code: 'idempotency_key_reused', retryable: false }),
  unknown: () => ({ outcome: 'unknown', statusCode: 409, code: 'idempotency_outcome_unknown', retryable: false }),
  invalid: (code) => ({ outcome: 'invalid', statusCode: 400, code, retryable: false }),
  unavailable: (code) => ({ outcome: 'unavailable', statusCode: 503, code, retryable: true }),
};

const sameIndexKeys = (actual, expected) =>
  Boolean(actual) &&
  Object.keys(actual).length === Object.keys(expected).length &&
  Object.entries(expected).every(([name, direction]) => actual[name] === direction);

const createIdempotencyService = ({
  Model = IdempotencyKeyModel,
  supportsTransactions = mongoTransactions.supportsTransactions,
  runInTransaction = mongoTransactions.runInTransaction,
  now = () => new Date(),
  newToken = () => crypto.randomUUID(),
  retentionMs = retentionMsFromEnv(),
  leaseMs = leaseMsFromEnv(),
  logger = console,
} = {}) => {
  let uniqueIndexVerified = false;

  // So le os indices existentes; nunca cria. Sem o indice unico, duas reivindicacoes simultaneas poderiam
  // executar a mesma chave duas vezes: melhor recusar.
  const uniqueIndexReady = async () => {
    if (uniqueIndexVerified) {
      return true;
    }
    try {
      const indexes = await Model.listIndexes();
      uniqueIndexVerified = (indexes || []).some(
        (index) => index.unique === true && sameIndexKeys(index.key, { userId: 1, key: 1 })
      );
    } catch (_err) {
      return false;
    }
    return uniqueIndexVerified;
  };

  const markUnlessCompleted = async (id, token, update) => {
    try {
      await Model.updateOne({ _id: id, claimToken: token, status: 'in_progress' }, update);
    } catch (err) {
      // Sem a marcacao, a reserva vence e outra tentativa pode assumir: o registro so fica "completed" se a
      // transacao entrou, entao nada e executado duas vezes.
      logger.error('[idempotency] falha ao registrar desfecho', err?.name);
    }
  };

  const claim = async ({ userId, key, method, route, requestHash }) => {
    const startedAt = now();
    const token = newToken();
    const lockedUntil = new Date(startedAt.getTime() + leaseMs);
    const expiresAt = new Date(startedAt.getTime() + retentionMs);

    try {
      const created = await Model.create({
        userId,
        key,
        method,
        route,
        requestHash,
        status: 'in_progress',
        claimToken: token,
        lockedUntil,
        attempts: 1,
        expiresAt,
      });
      return { execute: true, id: created._id, token };
    } catch (err) {
      if (!isDuplicateKeyError(err)) {
        throw err;
      }
    }

    // A chave ja existe para este usuario (outra tentativa, uma repeticao ou um pedido concorrente).
    const existing = await Model.findOne({ userId, key }).lean();
    if (!existing) {
      // Removida entre o insert e a leitura (so pela retencao): nao arrisca executar; o cliente repete.
      return { response: responses.inProgress() };
    }
    if (existing.requestHash !== requestHash || existing.method !== method || existing.route !== route) {
      return { response: responses.conflict() };
    }

    switch (existing.status) {
      case 'completed':
        // Conclusao e resumo entram na mesma transacao; sem resumo, algo esta inconsistente: nao inventa sucesso.
        return { response: existing.result ? responses.replayed(existing.result) : responses.unknown() };
      case 'unknown':
        return { response: responses.unknown() };
      case 'failed':
        if (!existing.failure?.retryable) {
          return { response: responses.failed(existing.failure, true) };
        }
        break;
      case 'in_progress':
        if (new Date(existing.lockedUntil).getTime() > startedAt.getTime()) {
          return { response: responses.inProgress() };
        }
        break;
      default:
        return { response: responses.unknown() };
    }

    // Reserva vencida (tentativa anterior caiu antes de concluir) ou falha sem efeito: assume com nova ficha.
    // A condicao inclui a ficha anterior: so uma tentativa assume. Quem tinha a ficha antiga sera barrado pela
    // cerca dentro da transacao.
    const takeoverFilter = { _id: existing._id, status: existing.status, claimToken: existing.claimToken };
    if (existing.status === 'in_progress') {
      takeoverFilter.lockedUntil = { $lt: startedAt };
    }
    const taken = await Model.findOneAndUpdate(
      takeoverFilter,
      {
        $set: {
          status: 'in_progress',
          claimToken: token,
          lockedUntil,
          // A retencao conta a partir da ultima tentativa e nunca encurta.
          expiresAt: new Date(Math.max(new Date(existing.expiresAt).getTime(), expiresAt.getTime())),
        },
        $unset: { failure: 1 },
        $inc: { attempts: 1 },
      },
      { new: true }
    ).lean();
    if (!taken) {
      return { response: responses.inProgress() };
    }
    return { execute: true, id: existing._id, token };
  };

  const runAfterCommit = async (afterCommit) => {
    if (typeof afterCommit !== 'function') {
      return;
    }
    try {
      await afterCommit();
    } catch (err) {
      // O efeito ja foi gravado: falha de aviso (socket etc.) nao desfaz nem repete a operacao.
      logger.error('[idempotency] falha no afterCommit', err?.name);
    }
  };

  // Commit com erro: a transacao pode ter entrado. O registro faz parte dela: se esta "completed" com a nossa
  // ficha, entrou. Senao, marca "unknown" (condicional) e nao repete sozinho.
  const reconcileCommit = async (id, token, attempt) => {
    try {
      const record = await Model.findOne({ _id: id }).lean();
      if (record && record.status === 'completed' && record.claimToken === token && record.result) {
        await runAfterCommit(attempt?.afterCommit);
        return responses.executed(record.result);
      }
    } catch (err) {
      logger.error('[idempotency] falha ao conferir commit', err?.name);
      return responses.unknown();
    }
    await markUnlessCompleted(id, token, {
      $set: {
        status: 'unknown',
        failure: { statusCode: 409, code: 'commit_outcome_unknown', retryable: false },
      },
    });
    // A marcacao e condicional: se o commit tiver entrado enquanto isso, o registro continua "completed".
    try {
      const record = await Model.findOne({ _id: id }).lean();
      if (record && record.status === 'completed' && record.claimToken === token && record.result) {
        await runAfterCommit(attempt?.afterCommit);
        return responses.executed(record.result);
      }
    } catch (_err) {
      // mantem "unknown"
    }
    return responses.unknown();
  };

  const execute = async (request, work) => {
    if (typeof work !== 'function') {
      throw new TypeError('work deve ser uma funcao(session)');
    }

    let normalized;
    try {
      const userId = normalizeUserId(request?.userId);
      const key = normalizeKey(request?.key);
      const method = normalizeMethod(request?.method);
      const route = normalizeRoute(request?.route);
      const requestHash = hashRequest({ method, route, params: request?.params, body: request?.body });
      normalized = { userId, key, method, route, requestHash };
    } catch (err) {
      if (err instanceof IdempotencyInputError) {
        return responses.invalid(err.code);
      }
      throw err;
    }

    try {
      if (!(await supportsTransactions())) {
        return responses.unavailable('transactions_unavailable');
      }
    } catch (_err) {
      return responses.unavailable('transactions_unavailable');
    }
    if (!(await uniqueIndexReady())) {
      return responses.unavailable('idempotency_unavailable');
    }

    let claimed;
    try {
      claimed = await claim(normalized);
    } catch (err) {
      logger.error('[idempotency] falha ao reivindicar chave', err?.name);
      return responses.unavailable('idempotency_unavailable');
    }
    if (claimed.response) {
      return claimed.response;
    }

    const { id, token } = claimed;
    let phase = 'before';
    let attempt = null;
    try {
      await runInTransaction(async (session) => {
        // Cada tentativa do withTransaction comeca do zero (a anterior foi abortada).
        phase = 'work';
        attempt = null;
        const fenced = await Model.updateOne(
          { _id: id, status: 'in_progress', claimToken: token },
          { $set: { status: 'completed', completedAt: now() } },
          { session }
        );
        if (!fenced || fenced.matchedCount !== 1) {
          throw new IdempotencyFenceError();
        }
        const outcome = await work(session);
        const result = sanitizeResult(outcome);
        await Model.updateOne({ _id: id, claimToken: token }, { $set: { result } }, { session });
        attempt = { result, afterCommit: outcome.afterCommit };
        phase = 'commit';
      });
    } catch (err) {
      if (err instanceof IdempotencyFenceError) {
        // Outra tentativa assumiu a chave depois do nosso prazo: ela decide o desfecho.
        return responses.inProgress();
      }
      if (phase === 'commit' || hasErrorLabel(err, 'UnknownTransactionCommitResult')) {
        return reconcileCommit(id, token, attempt);
      }
      if (phase === 'before') {
        // A transacao nem comecou (ex.: falha ao abrir a sessao): nada gravado, a chave pode tentar de novo.
        await markUnlessCompleted(id, token, {
          $set: { status: 'failed', failure: { statusCode: 503, code: 'transaction_not_started', retryable: true } },
        });
        return responses.unavailable('transaction_not_started');
      }
      // Erro no trabalho: o withTransaction abortou, nada foi gravado.
      if (err instanceof IdempotentRequestError) {
        const failure = { statusCode: err.statusCode, code: err.code, retryable: false };
        await markUnlessCompleted(id, token, { $set: { status: 'failed', failure } });
        return responses.failed(failure, false);
      }
      logger.error('[idempotency] falha na execucao', err?.name);
      const failure = { statusCode: 500, code: 'execution_failed', retryable: true };
      await markUnlessCompleted(id, token, { $set: { status: 'failed', failure } });
      return responses.failed(failure, false);
    }

    await runAfterCommit(attempt.afterCommit);
    return responses.executed(attempt.result);
  };

  return { execute };
};

module.exports = {
  createIdempotencyService,
  hashRequest,
  canonicalize,
  normalizeKey,
  retentionMsFromEnv,
  leaseMsFromEnv,
  IdempotentRequestError,
  IdempotencyInputError,
  DEFAULT_RETENTION_HOURS,
  MIN_RETENTION_HOURS,
  DEFAULT_LEASE_SECONDS,
};
