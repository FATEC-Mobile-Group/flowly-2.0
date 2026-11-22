const express = require('express');
const auth = require('../middlewares/auth');
const ensureObjectBody = require('../middlewares/ensureObjectBody');
const { requireAssistantOperationsSecret } = require('../middlewares/assistantOperationsAuth');
const { createAssistantConversationController } = require('../controllers/assistantConversationController');

// /api/assistant/conversations: contexto das conversas do assistente (uso interno, nunca pelo navegador).
// Mesma credencial interna das confirmacoes compartilhadas e mesma ordem: sem cache -> segredo interno (sem banco)
// -> JWT + sessao atual (auth) -> rota. Sem DELETE: a limpeza e um POST condicional.
const createAssistantConversationRouter = (options = {}) => {
  const router = express.Router();
  const controller = createAssistantConversationController(options);

  router.use((req, res, next) => {
    res.set('Cache-Control', 'no-store'); // o contexto traz dados da conversa
    next();
  });
  router.use(requireAssistantOperationsSecret);
  router.use(auth);
  router.use(ensureObjectBody);

  router.get('/current', controller.current);
  router.put('/current', controller.save);
  router.post('/current/clear', controller.clear);

  return router;
};

module.exports = createAssistantConversationRouter();
module.exports.createAssistantConversationRouter = createAssistantConversationRouter;
