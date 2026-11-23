const express = require('express');
const router = express.Router();
const auth = require('../middlewares/auth');
const { isAdmin } = require('../middlewares/roles');
const ensureObjectBody = require('../middlewares/ensureObjectBody');
const { comIdempotenciaOpcional } = require('../middlewares/idempotencyOptIn');
const equipeController = require('../controllers/equipeController');
const chatAttachmentController = require('../controllers/chatAttachmentController');
const moderateUpload = require('../middlewares/moderateUpload');
const { uploadLimiter } = require('../middlewares/rateLimiters');

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

// Anexos no chat: limite e acesso a equipe vem antes do Multer (sem acesso, o arquivo nao e lido); a legenda e
// moderada e a repeticao do envio e reconhecida antes da moderacao do arquivo; nada e gravado antes dela.
router.post(
  '/:id/mensagens/anexos',
  uploadLimiter,
  chatAttachmentController.verificarAcessoChat,
  // Multer desta rota: corpo multipart malformado vira 400 (controllers/chatAttachmentController.js).
  chatAttachmentController.receberArquivo,
  chatAttachmentController.prepararEnvio,
  moderateUpload('chat_attachment'),
  chatAttachmentController.enviarAnexo
);
router.get('/:id/mensagens/:messageId/anexo', chatAttachmentController.baixarAnexo);

module.exports = router;
