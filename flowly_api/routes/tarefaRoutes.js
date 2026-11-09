const express = require('express');
const router = express.Router();
const auth = require('../middlewares/auth');
const upload = require('../middlewares/upload');
const moderateUpload = require('../middlewares/moderateUpload');
const { isAdmin, isUser } = require('../middlewares/roles');
const ensureObjectBody = require('../middlewares/ensureObjectBody');
const tarefaController = require('../controllers/tarefaController');

// Todas as rotas requerem autenticação
router.use(auth);

// ADMIN: criar tarefa
router.post('/', isAdmin, ensureObjectBody, tarefaController.criarTarefa);

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
router.put('/:id/atribuir-para-mim', isUser, tarefaController.atribuirParaMim);

// ALL: detalhes da tarefa (comentários, logs etc)
router.get('/:id/detalhes', tarefaController.detalhesTarefa);

// ALL: adicionar comentário
router.post('/:id/comentarios', ensureObjectBody, tarefaController.adicionarComentario);

// ALL: adicionar e alterar subtarefa
router.post('/:id/subtarefas', ensureObjectBody, tarefaController.adicionarSubtarefa);
router.put('/:id/subtarefas/:subId', tarefaController.toggleSubtarefa);

// ALL: Upload de anexo (suporta multipart/form-data)
router.post('/:id/anexos', upload.single('file'), moderateUpload('task_attachment'), tarefaController.adicionarAnexo);

// USER: atualizar status da tarefa
router.put('/:id/status', isUser, ensureObjectBody, tarefaController.atualizarStatusUser);

// USER: controlar cronômetro
router.put('/:id/cronometro', isUser, ensureObjectBody, tarefaController.controlarCronometro);

module.exports = router;
