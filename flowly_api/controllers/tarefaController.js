const Tarefa = require('../models/Tarefa');
const User = require('../models/User');
const Equipe = require('../models/Equipe');
const Comment = require('../models/Comment');
const ActivityLog = require('../models/ActivityLog');
const logActivity = require('../utils/activityLogger');
const { notifyUsers } = require('../utils/notificationService');
const bucket = require('../services/storage');
const path = require('path');


// ADMIN creates task for user
exports.criarTarefa = async (req, res) => {
  try {
    const { descricao, detalhes, dataEntrega, user, equipe, tempoEstimado, urgencia, tags, subtarefas } = req.body;
    if (!equipe) return res.status(400).json({ erro: 'Equipe Ã© obrigatÃ³ria' });

    const equipeDoc = await Equipe.findById(equipe).select('membros nome');
    if (!equipeDoc) {
      return res.status(400).json({ erro: 'Equipe invÃ¡lida' });
    }

    let usuario = null;
    let userId = null;
    if (user && String(user).trim()) {
      userId = String(user).trim();
    }

    if (userId) {
      usuario = await User.findById(userId);
      if (!usuario || usuario.tipo !== 'user') {
        return res.status(400).json({ erro: 'User invÃ¡lido' });
      }
      const pertenceEquipe = equipeDoc.membros.some(
        (membroId) => String(membroId) === String(usuario._id),
      );
      if (!pertenceEquipe) {
        return res.status(400).json({ erro: 'UsuÃ¡rio nÃ£o pertence Ã  equipe selecionada' });
      }
    }

    const tarefa = new Tarefa({
      descricao,
      detalhes,
      dataEntrega,
      createdBy: req.user.id,
      user: userId,
      equipe,
      tempoEstimado,
      urgencia,
      tags: tags || [],
      subtarefas: subtarefas || []
    });
    await tarefa.save();

    const descricaoCriacao = usuario
      ? `Tarefa criada e atribuÃ­da a ${usuario.nome}`
      : 'Tarefa criada sem responsÃ¡vel e enviada ao backlog';
    await logActivity('criacao', descricaoCriacao, req.user.id, tarefa._id);

    res.status(201).json(tarefa);
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao criar tarefa', detalhe: err.message });
  }
};

// ADMIN: list tasks (or filter by user/team)
exports.listarTarefas = async (req, res) => {
  try {
    const { user, equipe } = req.query;
    const filtro = {};
    if (user) filtro.user = user;
    if (equipe) filtro.equipe = equipe;

    const tarefas = await Tarefa.find(filtro)
      .populate('user', 'nome')
      .populate('equipe', 'nome')
      .sort({ urgencia: -1, dataEntrega: 1 });
    res.json(tarefas);
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao listar tarefas' });
  }
};

// ADMIN: editar tarefa
exports.editarTarefa = async (req, res) => {
  try {
    const { descricao, detalhes, dataEntrega, user, equipe, tempoEstimado, urgencia, tags } = req.body;

    const tarefaAtual = await Tarefa.findById(req.params.id);
    if (!tarefaAtual) {
      return res.status(404).json({ erro: 'Tarefa nÃ£o encontrada' });
    }

    const equipeAlvo = equipe || tarefaAtual.equipe;
    const equipeDoc = await Equipe.findById(equipeAlvo).select('membros');
    if (!equipeDoc) {
      return res.status(400).json({ erro: 'Equipe invÃ¡lida' });
    }

    let userAlvo = user;
    if (userAlvo === '' || userAlvo === null) {
      userAlvo = null;
    }

    if (userAlvo) {
      const usuario = await User.findById(userAlvo);
      if (!usuario || usuario.tipo !== 'user') {
        return res.status(400).json({ erro: 'User invÃ¡lido' });
      }
      const pertenceEquipe = equipeDoc.membros.some(
        (membroId) => String(membroId) === String(usuario._id),
      );
      if (!pertenceEquipe) {
        return res.status(400).json({ erro: 'UsuÃ¡rio nÃ£o pertence Ã  equipe selecionada' });
      }
    }

    const dadosAtualizacao = {
      descricao,
      detalhes,
      dataEntrega,
      equipe,
      tempoEstimado,
      urgencia,
      tags,
    };
    if (user !== undefined) {
      dadosAtualizacao.user = userAlvo;
    }

    const tarefaAtualizada = await Tarefa.findByIdAndUpdate(
      req.params.id,
      dadosAtualizacao,
      { new: true }
    );

    await logActivity('atualizacao_geral', 'Detalhes da tarefa foram atualizados', req.user.id, tarefaAtualizada._id);
    res.json(tarefaAtualizada);
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao editar tarefa' });
  }
};

// ADMIN: excluir
exports.excluirTarefa = async (req, res) => {
  try {
    await Tarefa.findByIdAndDelete(req.params.id);
    res.json({ msg: 'Tarefa excluÃ­da' });
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao excluir tarefa' });
  }
};

// ALL: get task details with comments and logs
exports.detalhesTarefa = async (req, res) => {
  try {
    const tarefa = await Tarefa.findById(req.params.id)
      .populate('user', 'nome')
      .populate('equipe', 'nome');

    if (!tarefa) return res.status(404).json({ erro: 'Tarefa nÃ£o encontrada' });

    const comentarios = await Comment.find({ tarefa: req.params.id }).populate('user', 'nome').sort({ createdAt: 1 });
    const logs = await ActivityLog.find({ tarefa: req.params.id }).populate('user', 'nome').sort({ createdAt: -1 });

    res.json({ tarefa, comentarios, logs });
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao buscar detalhes da tarefa', detalhe: err.message });
  }
};

// ALL: add comment
exports.adicionarComentario = async (req, res) => {
  try {
    const { texto } = req.body;
    if (!texto) return res.status(400).json({ erro: 'Texto do comentÃ¡rio vazio' });

    const comentario = new Comment({ texto, user: req.user.id, tarefa: req.params.id });
    await comentario.save();

    await logActivity('comentario', 'ComentÃ¡rio adicionado', req.user.id, req.params.id);

    const populateComentario = await Comment.findById(comentario._id).populate('user', 'nome');
    res.status(201).json(populateComentario);
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao adicionar comentÃ¡rio', detalhe: err.message });
  }
};

// ALL: add subtask
exports.adicionarSubtarefa = async (req, res) => {
  try {
    const { descricao } = req.body;
    if (!descricao) return res.status(400).json({ erro: 'ObrigatÃ³rio fornecer descriÃ§Ã£o' });

    const tarefa = await Tarefa.findById(req.params.id);
    if (!tarefa) return res.status(404).json({ erro: 'Tarefa nÃ£o encontrada' });

    tarefa.subtarefas.push({ descricao, concluida: false });
    await tarefa.save();

    await logActivity('nova_subtarefa', `Subtarefa '${descricao}' adicionada`, req.user.id, req.params.id);
    res.status(201).json(tarefa);
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao adicionar subtarefa' });
  }
};

// ALL: toggle subtask
exports.toggleSubtarefa = async (req, res) => {
  try {
    const { subId } = req.params;
    const tarefa = await Tarefa.findById(req.params.id);
    if (!tarefa) return res.status(404).json({ erro: 'Tarefa nÃ£o encontrada' });

    const sub = tarefa.subtarefas.id(subId);
    if (!sub) return res.status(404).json({ erro: 'Subtarefa nÃ£o encontrada' });

    sub.concluida = !sub.concluida;
    await tarefa.save();

    res.json(tarefa);
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao alterar subtarefa' });
  }
};

// USER: view their own tasks
exports.minhasTarefas = async (req, res) => {
  try {
    const tarefas = await Tarefa.find({ user: req.user.id })
      .populate('equipe', 'nome');
    res.json(tarefas);
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao buscar suas tarefas' });
  }
};

// USER: backlog de tarefas sem responsÃ¡vel (apenas equipes do usuÃ¡rio)
exports.listarBacklog = async (req, res) => {
  try {
    const minhasEquipes = await Equipe.find({ membros: req.user.id }).select('_id');
    const equipeIds = minhasEquipes.map((equipe) => equipe._id);

    if (equipeIds.length === 0) {
      return res.json([]);
    }

    const tarefas = await Tarefa.find({
      equipe: { $in: equipeIds },
      $or: [{ user: null }, { user: { $exists: false } }],
    })
      .populate('equipe', 'nome')
      .sort({ urgencia: -1, dataEntrega: 1 });

    res.json(tarefas);
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao buscar backlog', detalhe: err.message });
  }
};

// USER: atribuir tarefa do backlog para si mesmo
exports.atribuirParaMim = async (req, res) => {
  try {
    const tarefa = await Tarefa.findById(req.params.id);
    if (!tarefa) {
      return res.status(404).json({ erro: 'Tarefa nÃ£o encontrada' });
    }

    if (tarefa.user) {
      return res.status(409).json({ erro: 'Esta tarefa jÃ¡ possui responsÃ¡vel' });
    }

    const equipe = await Equipe.findById(tarefa.equipe).select('membros createdBy nome');
    if (!equipe) {
      return res.status(400).json({ erro: 'Equipe da tarefa nÃ£o encontrada' });
    }

    const pertenceEquipe = equipe.membros.some(
      (membroId) => String(membroId) === String(req.user.id),
    );

    if (!pertenceEquipe) {
      return res.status(403).json({ erro: 'VocÃª nÃ£o pertence Ã  equipe desta tarefa' });
    }

    tarefa.user = req.user.id;
    await tarefa.save();

    await logActivity(
      'atualizacao_geral',
      'Tarefa atribuÃ­da automaticamente para o colaborador',
      req.user.id,
      tarefa._id,
    );

    const notificarAdmin = tarefa.createdBy || equipe.createdBy;
    if (notificarAdmin && String(notificarAdmin) !== String(req.user.id)) {
      const usuario = await User.findById(req.user.id).select('nome');
      await notifyUsers({
        userIds: [notificarAdmin],
        texto: `${usuario?.nome || 'Um colaborador'} pegou a tarefa "${tarefa.descricao}" do backlog`,
        tipo: 'task',
        origemId: tarefa._id,
        metadata: { tarefaId: tarefa._id, acao: 'atribuir_para_mim' },
      });
    }

    const tarefaAtualizada = await Tarefa.findById(tarefa._id)
      .populate('user', 'nome')
      .populate('equipe', 'nome');

    res.json({ msg: 'Tarefa atribuÃ­da com sucesso', tarefa: tarefaAtualizada });
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao atribuir tarefa', detalhe: err.message });
  }
};

// USER: update task status
exports.atualizarStatusUser = async (req, res) => {
  try {
    const { status } = req.body;

    if (!status || !["pendente", "em_andamento", "concluido"].includes(status)) {
      return res.status(400).json({ erro: "Status invÃ¡lido" });
    }

    const tarefa = await Tarefa.findOne({ _id: req.params.id, user: req.user.id }).populate('equipe', 'createdBy nome');

    if (!tarefa) {
      return res.status(403).json({ erro: 'VocÃª nÃ£o pode editar essa tarefa' });
    }

    tarefa.status = status;
    await tarefa.save();

    await logActivity('atualizacao_status', `Status alterado para ${status}`, req.user.id, tarefa._id);

    const notificarAdmin = tarefa.createdBy || tarefa.equipe?.createdBy;
    if (notificarAdmin && String(notificarAdmin) !== String(req.user.id)) {
      const usuario = await User.findById(req.user.id).select('nome');
      const statusLegivel = status === 'em_andamento'
        ? 'em andamento'
        : status === 'concluido'
          ? 'concluÃ­da'
          : status;

      await notifyUsers({
        userIds: [notificarAdmin],
        texto: `${usuario?.nome || 'Um colaborador'} marcou a tarefa "${tarefa.descricao}" como ${statusLegivel}`,
        tipo: 'task',
        origemId: tarefa._id,
        metadata: { tarefaId: tarefa._id, status },
      });
    }

    res.json({ msg: 'Status atualizado com sucesso', tarefa });
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao atualizar status', detalhe: err.message });
  }
};

// USER: controlar cronÃ´metro
exports.controlarCronometro = async (req, res) => {
  try {
    const { acao } = req.body; // 'iniciar' ou 'pausar'
    const tarefa = await Tarefa.findOne({ _id: req.params.id, user: req.user.id });

    if (!tarefa) return res.status(403).json({ erro: 'Acesso negado Ã  tarefa' });

    if (acao === 'iniciar') {
      if (tarefa.cronometroAtivo) {
        return res.status(400).json({ erro: 'CronÃ´metro jÃ¡ estÃ¡ ativo' });
      }
      tarefa.cronometroAtivo = true;
      tarefa.ultimaAtualizacaoCronometro = new Date();
      await logActivity('cronometro_iniciado', `CronÃ´metro iniciado`, req.user.id, tarefa._id);
    } else if (acao === 'pausar') {
      if (!tarefa.cronometroAtivo) {
        return res.status(400).json({ erro: 'CronÃ´metro jÃ¡ estÃ¡ pausado' });
      }
      const tempoDecorrido = Math.floor((new Date() - tarefa.ultimaAtualizacaoCronometro) / 60000); // converte para minutos
      tarefa.tempoGasto += tempoDecorrido;
      tarefa.cronometroAtivo = false;

      // Verifica se o tempo estimado foi excedido
      if (tarefa.tempoEstimado && tarefa.tempoGasto > tarefa.tempoEstimado) {
        tarefa.tempoExcedido = true;
      }
      await logActivity('cronometro_pausado', `CronÃ´metro pausado. +${tempoDecorrido} mins`, req.user.id, tarefa._id);
    }

    await tarefa.save();
    res.json({
      msg: `CronÃ´metro ${acao}do com sucesso`,
      tarefa,
      tempoExcedido: tarefa.tempoExcedido
    });
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao controlar cronÃ´metro' });
  }
};

// ALL: Upload de anexos
exports.adicionarAnexo = async (req, res) => {
  try {
    const tarefa = await Tarefa.findById(req.params.id);
    if (!tarefa) return res.status(404).json({ erro: 'Tarefa nÃ£o encontrada' });

    if (!req.file) {
      return res.status(400).json({ erro: 'Nenhum arquivo enviado' });
    }

    // Arquivo foi validado pela middleware, agora fazer upload privado
    const uploadedFile = await uploadAnexoParaGCS(tarefa._id, req.file);

    const novoAnexo = {
      objectName: uploadedFile.objectName,
      nomeOriginal: req.file.originalname,
      mimetype: req.file.mimetype,
      size: req.file.size
    };

    tarefa.anexos.push(novoAnexo);
    await tarefa.save();

    await logActivity(
      'novo_anexo',
      `Arquivo anexado: ${req.file.originalname}`,
      req.user.id,
      tarefa._id
    );

    res.status(201).json({
      msg: 'Anexo adicionado com sucesso',
      anexo: novoAnexo
    });
  } catch (err) {
    console.error('Erro ao fazer upload de anexo para Google Cloud Storage:', err);
    if (err.message.includes('timeout')) {
      return res.status(504).json({ erro: 'Timeout ao conectar com Cloud Storage' });
    }
    res.status(500).json({ erro: 'Erro ao fazer upload de anexo', detalhe: err.message });
  }
};

exports.obterUrlAssinadaAnexo = async (req, res) => {
  try {
    const tarefa = await Tarefa.findById(req.params.id);
    if (!tarefa) return res.status(404).json({ erro: 'Tarefa nao encontrada' });

    const anexo = tarefa.anexos.id(req.params.anexoId);
    if (!anexo) return res.status(404).json({ erro: 'Anexo nao encontrado' });

    const objectName = anexo.objectName || getObjectNameFromPublicUrl(anexo.url);
    if (!objectName) {
      return res.status(400).json({ erro: 'Anexo sem referencia valida no Cloud Storage' });
    }

    const signed = await bucket.getSignedReadUrl(objectName, {
      contentType: anexo.mimetype,
    });

    res.json({
      url: signed.url,
      expiresAt: signed.expiresAt,
      nomeOriginal: anexo.nomeOriginal,
      mimetype: anexo.mimetype,
      size: anexo.size,
    });
  } catch (err) {
    console.error('Erro ao gerar URL assinada do anexo:', err);
    res.status(500).json({ erro: 'Erro ao gerar URL assinada do anexo', detalhe: err.message });
  }
};

/**
 * FunÃ§Ã£o auxiliar para upload de anexo usando bucket.file().save()
 * Armazena em: arquivos/{tarefaId}/{timestamp}-{random}.{ext}
 * @param {string} tarefaId - ID da tarefa
 * @param {Object} file - Objeto do arquivo (req.file)
 * @returns {Promise<string>} URL pÃºblica do arquivo
 */
const uploadAnexoParaGCS = async (tarefaId, file) => {
  try {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
    const extension = path.extname(file.originalname);
    // Organizar em pasta: arquivos/{tarefaId}/{arquivo}
    const filename = `arquivos/${tarefaId}/${uniqueSuffix}${extension}`;

    const uploadedFile = await bucket.uploadPrivateFile(filename, file.buffer, {
      contentType: file.mimetype,
    });

    console.log('Upload de anexo privado concluido em:', filename);
    return uploadedFile;
  } catch (error) {
    console.error('âŒ Erro ao fazer upload de anexo:', error.message);
    throw error;
  }
};

const getObjectNameFromPublicUrl = (url = '') => {
  if (!url) return '';

  try {
    const parsedUrl = new URL(url);
    const publicHostPath = `/${bucket.name}/`;

    if (
      parsedUrl.hostname === 'storage.googleapis.com' &&
      parsedUrl.pathname.startsWith(publicHostPath)
    ) {
      return decodeURIComponent(parsedUrl.pathname.slice(publicHostPath.length));
    }
  } catch (error) {
    if (url.startsWith('arquivos/')) {
      return url;
    }
  }

  return '';
};
