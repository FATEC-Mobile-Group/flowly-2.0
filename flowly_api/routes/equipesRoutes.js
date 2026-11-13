const express = require('express');
const router = express.Router();
const auth = require('../middlewares/auth');
const { isAdmin } = require('../middlewares/roles');
const ensureObjectBody = require('../middlewares/ensureObjectBody');
const equipeController = require('../controllers/equipeController');

// Middleware: autenticado no mínimo
router.use(auth);

router.post('/', isAdmin, ensureObjectBody, equipeController.criarEquipe);
router.get('/', isAdmin, equipeController.listarEquipes);
router.get('/minhas', equipeController.listarMinhasEquipes);
router.get('/:id', isAdmin, equipeController.obterEquipe);
router.put('/:id', isAdmin, ensureObjectBody, equipeController.editarEquipe);
router.delete('/:id', isAdmin, equipeController.excluirEquipe);

// Comunicação: Aberto para todos que passaram no `auth`
router.get("/:id/membros", equipeController.getMembrosDaEquipe);
router.get("/:id/messages", equipeController.getMessages);

module.exports = router;
