const express = require('express');
const router = express.Router();
const auth = require('../middlewares/auth');
const { isAdmin } = require('../middlewares/roles');
const ensureObjectBody = require('../middlewares/ensureObjectBody');
const { comIdempotenciaOpcional } = require('../middlewares/idempotencyOptIn');
const equipeController = require('../controllers/equipeController');

// Middleware: autenticado no mínimo
router.use(auth);

// Com Idempotency-Key: criacao protegida (transacao + chave). Sem o cabecalho: fluxo atual, inalterado.
router.post(
  '/',
  isAdmin,
  ensureObjectBody,
  comIdempotenciaOpcional(equipeController.criarEquipeIdempotente),
  equipeController.criarEquipe
);
router.get('/', isAdmin, equipeController.listarEquipes);
router.get('/minhas', equipeController.listarMinhasEquipes);
router.get('/:id', isAdmin, equipeController.obterEquipe);
router.put('/:id', isAdmin, ensureObjectBody, equipeController.editarEquipe);
router.delete('/:id', isAdmin, equipeController.excluirEquipe);

// Comunicação: Aberto para todos que passaram no `auth`
router.get("/:id/membros", equipeController.getMembrosDaEquipe);
router.get("/:id/messages", equipeController.getMessages);

module.exports = router;
