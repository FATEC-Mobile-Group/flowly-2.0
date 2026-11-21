const {
  createAssistantOperationService,
  AssistantOperationInputError,
  AssistantOperationUnavailableError,
} = require('../services/assistantOperationService');

// Rotas internas de confirmacao do assistente. O controller so traduz HTTP <-> servico: a maquina de estados, os
// prazos e as condicoes atomicas ficam em services/assistantOperationService.js.
//
// Identidade: o dono e SEMPRE req.user.id (JWT + sessao validados pelo middleware auth). Nenhum campo do corpo ou da
// query vira identidade; ownerId/userId no corpo e recusado como campo desconhecido.
//
// Respostas: so por listas explicitas de campos.
//  - publica (estado): toPublic, nunca com params, idempotencyKey, claimToken, lease ou dono;
//  - privada (claim): toClaim, so na resposta do claim, para o assistente executar a escrita com a chave.
// Nada de documento do MongoDB, JWT, segredo ou URL assinada.

const PUBLIC_FIELDS = ['operationId', 'conversationId', 'commandKey', 'summary', 'status', 'attempts', 'expiresAt',
  'recoverUntil', 'createdAt', 'updatedAt'];
const RESULT_FIELDS = ['httpStatus', 'code', 'resourceType', 'resourceId', 'replayed'];
const CLAIM_EXTRA_FIELDS = ['leaseUntil', 'recovery', 'idempotencyKey', 'claimToken'];
const PARAM_FIELDS = ['task_id', 'team_id', 'equipe', 'user', 'status', 'acao', 'urgencia', 'nome', 'descricao', 'texto',
  'dataEntrega'];

const scalar = (value) => {
  if (value instanceof Date) return value.toISOString();
  if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) return value;
  return undefined; // nunca repassa objetos/documentos inesperados
};
const pick = (source, fields) => {
  const output = {};
  fields.forEach((field) => {
    if (source && Object.prototype.hasOwnProperty.call(source, field)) {
      const value = scalar(source[field]);
      if (value !== undefined) output[field] = value;
    }
  });
  return output;
};
const toPublic = (operation) => {
  if (!operation) return null;
  const output = pick(operation, PUBLIC_FIELDS);
  output.result = operation.result ? pick(operation.result, RESULT_FIELDS) : null;
  return output;
};
const toClaim = (operation) => ({
  ...toPublic(operation),
  ...pick(operation, CLAIM_EXTRA_FIELDS),
  params: pick(operation.params, PARAM_FIELDS),
});

// Validacao estrita do formato do pedido (o conteudo e validado pelo servico).
const BODY_FIELDS = {
  create: { required: ['conversationId', 'commandKey', 'params', 'summary'], optional: [] },
  claim: { required: ['conversationId'], optional: [] },
  cancel: { required: ['conversationId'], optional: [] },
  complete: { required: ['conversationId', 'claimToken', 'outcome'], optional: ['result'] },
  retry: { required: ['conversationId', 'claimToken'], optional: ['result'] },
};
const QUERY_FIELDS = { required: ['conversationId'], optional: [] };

class RequestShapeError extends Error {
  constructor() {
    super('invalid_request');
    this.code = 'invalid_request';
  }
}
const checkShape = (source, { required, optional }) => {
  if (!source || typeof source !== 'object' || Array.isArray(source)) throw new RequestShapeError();
  const allowed = new Set([...required, ...optional]);
  const keys = Object.keys(source);
  if (keys.some((key) => !allowed.has(key))) throw new RequestShapeError();
  if (required.some((key) => source[key] === undefined)) throw new RequestShapeError();
  // conversationId e claimToken sempre texto (a query do Express pode virar objeto/lista).
  ['conversationId', 'claimToken', 'outcome', 'commandKey', 'summary'].forEach((key) => {
    if (source[key] !== undefined && typeof source[key] !== 'string') throw new RequestShapeError();
  });
  return source;
};

// Desfechos do servico -> HTTP. Codigos estaveis em snake_case; Retry-After so quando esperar resolve.
const TERMINAL_CODES = {
  completed: 'operation_completed',
  failed: 'operation_failed',
  cancelled: 'operation_cancelled',
  expired: 'operation_expired',
  unknown: 'operation_unknown', // terminal: nunca autoriza executar de novo
};
const send = (res, status, body, retryAfter) => {
  if (retryAfter) res.set('Retry-After', String(retryAfter));
  return res.status(status).json(body);
};
const sendRefusal = (res, outcome) => {
  const operation = toPublic(outcome.operation);
  switch (outcome.reason) {
    case 'not_found':
      // Outro dono, outra conversa ou inexistente: sempre a mesma resposta, sem dados.
      return send(res, 404, { ok: false, code: 'operation_not_found' });
    case 'conversation_busy':
      return send(res, 409, { ok: false, code: 'conversation_busy', operation });
    case 'in_progress':
      return send(res, 409, { ok: false, code: 'operation_in_progress', operation }, 5);
    case 'state_changed':
      return send(res, 409, { ok: false, code: 'operation_state_changed', operation }, 1);
    case 'claim_lost':
      return send(res, 409, { ok: false, code: 'claim_lost', operation });
    case 'not_terminal':
      return send(res, 409, { ok: false, code: 'operation_not_terminal', operation }, 2);
    case 'expired':
      return send(res, 410, { ok: false, code: 'operation_expired', operation });
    case 'terminal': {
      const code = TERMINAL_CODES[outcome.operation && outcome.operation.status] || 'operation_terminal';
      return send(res, code === 'operation_expired' ? 410 : 409, { ok: false, code, operation });
    }
    default:
      return send(res, 409, { ok: false, code: 'operation_conflict', operation });
  }
};
const isDuplicateKeyError = (err) => Boolean(err) && (err.code === 11000 || err.code === 11001);
const sendError = (res, err, label) => {
  if (err instanceof RequestShapeError) return send(res, 400, { ok: false, code: err.code });
  if (err instanceof AssistantOperationInputError) return send(res, 400, { ok: false, code: err.code });
  if (err instanceof AssistantOperationUnavailableError) {
    // Banco fora ou indices ainda nao verificaveis: temporario. Indice ausente/incorreto: depende de migracao.
    const temporario = err.code === 'database_unavailable' || err.code === 'operation_indexes_unavailable';
    return send(res, 503, { ok: false, code: err.code }, temporario ? 5 : undefined);
  }
  if (isDuplicateKeyError(err)) {
    // Indice unico recusou a escrita (ex.: invariante quebrada no banco): nunca vira sucesso.
    return send(res, 409, { ok: false, code: 'operation_state_conflict' });
  }
  // Sem detalhes: so o nome do erro no log (nunca JWT, segredo, claimToken ou idempotencyKey).
  console.error(`[assistant-operations] falha em ${label}:`, err && err.name);
  return send(res, 500, { ok: false, code: 'internal_error' });
};

const createAssistantOperationController = ({ getService } = {}) => {
  let service;
  const svc = () => {
    if (getService) return getService();
    if (!service) service = createAssistantOperationService();
    return service;
  };
  const owner = (req) => String(req.user.id);
  const handle = (label, run) => async (req, res) => {
    try {
      return await run(req, res);
    } catch (err) {
      return sendError(res, err, label);
    }
  };

  return {
    create: handle('create', async (req, res) => {
      const body = checkShape(req.body, BODY_FIELDS.create);
      const outcome = await svc().create({
        ownerId: owner(req),
        conversationId: body.conversationId,
        commandKey: body.commandKey,
        params: body.params,
        summary: body.summary,
      });
      if (!outcome.ok) return sendRefusal(res, outcome);
      return send(res, 201, { ok: true, operation: toPublic(outcome.operation) });
    }),

    current: handle('current', async (req, res) => {
      const query = checkShape(req.query, QUERY_FIELDS);
      const operation = await svc().getCurrent({ ownerId: owner(req), conversationId: query.conversationId });
      return send(res, 200, { ok: true, operation: toPublic(operation) });
    }),

    result: handle('result', async (req, res) => {
      const query = checkShape(req.query, QUERY_FIELDS);
      const outcome = await svc().getResult({
        ownerId: owner(req), conversationId: query.conversationId, operationId: req.params.id,
      });
      if (!outcome.ok) return sendRefusal(res, outcome);
      return send(res, 200, { ok: true, operation: toPublic(outcome.operation) });
    }),

    claim: handle('claim', async (req, res) => {
      const body = checkShape(req.body, BODY_FIELDS.claim);
      const outcome = await svc().claim({
        ownerId: owner(req), conversationId: body.conversationId, operationId: req.params.id,
      });
      if (!outcome.ok) return sendRefusal(res, outcome);
      return send(res, 200, { ok: true, claim: toClaim(outcome.operation) });
    }),

    complete: handle('complete', async (req, res) => {
      const body = checkShape(req.body, BODY_FIELDS.complete);
      const outcome = await svc().complete({
        ownerId: owner(req),
        conversationId: body.conversationId,
        operationId: req.params.id,
        claimToken: body.claimToken,
        outcome: body.outcome,
        result: body.result,
      });
      if (!outcome.ok) return sendRefusal(res, outcome);
      return send(res, 200, { ok: true, operation: toPublic(outcome.operation) });
    }),

    retry: handle('retry', async (req, res) => {
      const body = checkShape(req.body, BODY_FIELDS.retry);
      const outcome = await svc().recordRetry({
        ownerId: owner(req),
        conversationId: body.conversationId,
        operationId: req.params.id,
        claimToken: body.claimToken,
        result: body.result,
      });
      if (!outcome.ok) return sendRefusal(res, outcome);
      return send(res, 200, { ok: true, operation: toPublic(outcome.operation) });
    }),

    cancel: handle('cancel', async (req, res) => {
      const body = checkShape(req.body, BODY_FIELDS.cancel);
      const outcome = await svc().cancel({
        ownerId: owner(req), conversationId: body.conversationId, operationId: req.params.id,
      });
      if (!outcome.ok) return sendRefusal(res, outcome);
      return send(res, 200, { ok: true, operation: toPublic(outcome.operation) });
    }),
  };
};

module.exports = { createAssistantOperationController, toPublic, toClaim };
