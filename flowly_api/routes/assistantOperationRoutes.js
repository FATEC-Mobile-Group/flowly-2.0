const express = require('express');
const auth = require('../middlewares/auth');
const ensureObjectBody = require('../middlewares/ensureObjectBody');
const { requireAssistantOperationsSecret } = require('../middlewares/assistantOperationsAuth');
const { createAssistantOperationController } = require('../controllers/assistantOperationController');

// /api/assistant/operations: confirmacoes compartilhadas do assistente (uso interno, nunca pelo navegador).
// Ordem: sem cache -> segredo interno (sem banco) -> JWT + sessao atual (auth) -> rota. Qualquer papel (admin ou
// user) pode ter confirmacoes; a permissao de cada escrita e revalidada depois pela rota publica que a executa.
const createAssistantOperationRouter = (options = {}) => {
  const router = express.Router();
  const controller = createAssistantOperationController(options);

  router.use((req, res, next) => {
    res.set('Cache-Control', 'no-store'); // a resposta do claim traz dados privados
    next();
  });
  router.use(requireAssistantOperationsSecret);
  router.use(auth);
  router.use(ensureObjectBody);

  router.post('/', controller.create);
  router.get('/current', controller.current);
  router.get('/:id/result', controller.result);
  router.post('/:id/claim', controller.claim);
  router.post('/:id/complete', controller.complete);
  router.post('/:id/retry', controller.retry);
  router.post('/:id/cancel', controller.cancel);

  return router;
};

module.exports = createAssistantOperationRouter();
module.exports.createAssistantOperationRouter = createAssistantOperationRouter;
