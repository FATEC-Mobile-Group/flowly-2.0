const {
  createAssistantConversationService,
  AssistantConversationInputError,
  AssistantConversationUnavailableError,
} = require('../services/assistantConversationService');

// Rotas internas do contexto de conversa do assistente. O controller so traduz HTTP <-> servico.
//
// Identidade: o dono e SEMPRE req.user.id (JWT + sessao validados pelo middleware auth). ownerId/userId no corpo ou
// na query e recusado como campo desconhecido. Respostas so com os campos do contexto (conversationId, version,
// state na leitura, expiresAt, updatedAt): nada de dono, documento do MongoDB, JWT ou segredo.

const BODY_FIELDS = {
  save: { required: ['conversationId', 'expectedVersion', 'state'], optional: [] },
  clear: { required: ['conversationId'], optional: ['expectedVersion'] },
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
  if (source.conversationId !== undefined && typeof source.conversationId !== 'string') throw new RequestShapeError();
  if (source.expectedVersion !== undefined && typeof source.expectedVersion !== 'number') throw new RequestShapeError();
  return source;
};

const send = (res, status, body, retryAfter) => {
  if (retryAfter) res.set('Retry-After', String(retryAfter));
  return res.status(status).json(body);
};
const sendConflict = (res, outcome) =>
  // Outro pedido gravou depois da leitura: nada foi sobrescrito. version = o vivo agora (0 = nenhum).
  send(res, 409, { ok: false, code: 'context_version_conflict', version: outcome.version });
const sendError = (res, err, label) => {
  if (err instanceof RequestShapeError) return send(res, 400, { ok: false, code: err.code });
  if (err instanceof AssistantConversationInputError) return send(res, 400, { ok: false, code: err.code });
  if (err instanceof AssistantConversationUnavailableError) {
    const temporario = err.code === 'database_unavailable' || err.code === 'context_indexes_unavailable';
    return send(res, 503, { ok: false, code: err.code }, temporario ? 5 : undefined);
  }
  // Sem detalhes: so o nome do erro no log (nunca JWT, segredo ou conteudo do contexto).
  console.error(`[assistant-conversations] falha em ${label}:`, err && err.name);
  return send(res, 500, { ok: false, code: 'internal_error' });
};

const createAssistantConversationController = ({ getService } = {}) => {
  let service;
  const svc = () => {
    if (getService) return getService();
    if (!service) service = createAssistantConversationService();
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
    current: handle('current', async (req, res) => {
      const query = checkShape(req.query, QUERY_FIELDS);
      const context = await svc().getCurrent({ ownerId: owner(req), conversationId: query.conversationId });
      return send(res, 200, { ok: true, context });
    }),

    save: handle('save', async (req, res) => {
      const body = checkShape(req.body, BODY_FIELDS.save);
      const outcome = await svc().save({
        ownerId: owner(req),
        conversationId: body.conversationId,
        expectedVersion: body.expectedVersion,
        state: body.state,
      });
      if (!outcome.ok) return sendConflict(res, outcome);
      return send(res, 200, { ok: true, context: outcome.context });
    }),

    clear: handle('clear', async (req, res) => {
      const body = checkShape(req.body, BODY_FIELDS.clear);
      const outcome = await svc().clear({
        ownerId: owner(req),
        conversationId: body.conversationId,
        expectedVersion: body.expectedVersion,
      });
      if (!outcome.ok) return sendConflict(res, outcome);
      return send(res, 200, { ok: true, cleared: outcome.cleared });
    }),
  };
};

module.exports = { createAssistantConversationController };
