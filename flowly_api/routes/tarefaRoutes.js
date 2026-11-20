const express = require('express');
const router = express.Router();
const auth = require('../middlewares/auth');
const upload = require('../middlewares/upload');
const moderateUpload = require('../middlewares/moderateUpload');
const { isAdmin, isUser } = require('../middlewares/roles');
const ensureObjectBody = require('../middlewares/ensureObjectBody');
const { comIdempotenciaOpcional } = require('../middlewares/idempotencyOptIn');
const { uploadLimiter } = require('../middlewares/rateLimiters');
const tarefaController = require('../controllers/tarefaController');

// Todas as rotas requerem autenticação
router.use(auth);

// ADMIN: criar tarefa. Com Idempotency-Key: criacao protegida (transacao com chave e log). Sem o cabecalho:
// fluxo atual, inalterado.
router.post(
  '/',
  isAdmin,
  ensureObjectBody,
  comIdempotenciaOpcional(tarefaController.criarTarefaIdempotente),
  tarefaController.criarTarefa
);

// ADMIN: listar todas as tarefas ou por user
router.get('/', isAdmin, tarefaController.listarTarefas);

// ADMIN: editar qualquer tarefa
router.put('/:id', isAdmin, ensureObjectBody, tarefaController.editarTarefa);

// ADMIN: excluir tarefa
router.delete('/:id', isAdmin, tarefaController.excluirTarefa);

// USER: visualizar suas tarefas
router.get('/minhas', isUser, tarefaController.minhasTarefas);

// USER: backlog (tarefas sem responsável)
router.get('/backlog', isUser, tarefaController.listarBacklog);

// USER: autoatribuir tarefa do backlog
// Com Idempotency-Key: atribuicao protegida (condicional, na transacao com chave, log e notificacao; emissao so
// apos o commit). Sem o cabecalho: fluxo atual, inalterado.
router.put(
  '/:id/atribuir-para-mim',
  isUser,
  comIdempotenciaOpcional(tarefaController.atribuirParaMimIdempotente),
  tarefaController.atribuirParaMim
);

// ALL: detalhes da tarefa (comentários, logs etc)
router.get('/:id/detalhes', tarefaController.detalhesTarefa);

// ALL: adicionar comentário
// Com Idempotency-Key: comentario protegido (transacao com chave e log). Sem o cabecalho: fluxo atual, inalterado.
router.post(
  '/:id/comentarios',
  ensureObjectBody,
  comIdempotenciaOpcional(tarefaController.adicionarComentarioIdempotente),
  tarefaController.adicionarComentario
);

// ALL: adicionar e alterar subtarefa
// Com Idempotency-Key: inclusao protegida ($push atomico na transacao, com chave e log). Sem o cabecalho: fluxo
// atual, inalterado.
router.post(
  '/:id/subtarefas',
  ensureObjectBody,
  comIdempotenciaOpcional(tarefaController.adicionarSubtarefaIdempotente),
  tarefaController.adicionarSubtarefa
);
router.put('/:id/subtarefas/:subId', tarefaController.toggleSubtarefa);

// ALL: Upload de anexo (suporta multipart/form-data)
// Limite e acesso vem antes do Multer: sem eles o arquivo nao e lido, moderado nem gravado.
router.post(
  '/:id/anexos',
  uploadLimiter,
  tarefaController.verificarAcessoAnexo,
  upload.single('file'),
  moderateUpload('task_attachment'),
  tarefaController.adicionarAnexo
);

// USER: atualizar status da tarefa
router.put('/:id/status', isUser, ensureObjectBody, tarefaController.atualizarStatusUser);

// USER: controlar cronômetro
router.put('/:id/cronometro', isUser, ensureObjectBody, tarefaController.controlarCronometro);

module.exports = router;
