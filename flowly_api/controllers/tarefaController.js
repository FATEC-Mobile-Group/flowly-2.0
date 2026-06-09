const Tarefa = require('../models/Tarefa');
const User = require('../models/User');
const Equipe = require('../models/Equipe');
const Comment = require('../models/Comment');
const ActivityLog = require('../models/ActivityLog');
const logActivity = require('../utils/activityLogger');
const { notifyUsers } = require('../utils/notificationService');
const bucket = require('../services/storage');
const { getSignedUrl } = require('../services/storage');

const assinarAnexosTarefa = async (tarefa) => {
  const tarefaObject = typeof tarefa.toObject === 'function' ? tarefa.toObject() : tarefa;

  return {
    ...tarefaObject,
    anexos: await Promise.all((tarefaObject.anexos || []).map(async (anexo) => {
      const anexoObject = typeof anexo.toObject === 'function' ? anexo.toObject() : anexo;

      return {
        ...anexoObject,
        url: await getSignedUrl(anexoObject.url),
      };
    })),
  };
};

const assinarAnexosTarefas = (tarefas) => Promise.all(tarefas.map(assinarAnexosTarefa));

const pausarCronometroAtivo = async (tarefa, userId, motivo = 'cronometro_pausado') => {
  if (!tarefa.cronometroAtivo) {
    return 0;
  }

  const ultimaAtualizacao = tarefa.ultimaAtualizacaoCronometro || new Date();
  const tempoDecorrido = Math.floor((new Date() - ultimaAtualizacao) / 60000);

  tarefa.tempoGasto = (tarefa.tempoGasto || 0) + Math.max(tempoDecorrido, 0);
  tarefa.cronometroAtivo = false;
  tarefa.ultimaAtualizacaoCronometro = undefined;

  if (tarefa.tempoEstimado && tarefa.tempoGasto > tarefa.tempoEstimado) {
    tarefa.tempoExcedido = true;
  }

  await logActivity(motivo, `Cronômetro pausado. +${Math.max(tempoDecorrido, 0)} mins`, userId, tarefa._id);
  return Math.max(tempoDecorrido, 0);
};

const getEquipeIdsAcessiveis = async (req) => {
  const filtroEquipes = req.user.tipo === 'admin'
    ? { $or: [{ membros: req.user.id }, { createdBy: req.user.id }] }
    : { membros: req.user.id };

  const equipes = await Equipe.find(filtroEquipes).select('_id');
  return equipes.map((equipe) => equipe._id);
};

const montarFiltroTarefasAcessiveis = async (req, filtroBase = {}) => {
  const equipeIds = await getEquipeIdsAcessiveis(req);
  if (equipeIds.length === 0) {
    return null;
  }

  const filtro = { ...filtroBase };
  if (filtro.equipe) {
    const equipePermitida = equipeIds.some((id) => String(id) === String(filtro.equipe));
    return equipePermitida ? filtro : null;
  }

  filtro.equipe = { $in: equipeIds };
  return filtro;
};


// ADMIN creates task for user
exports.criarTarefa = async (req, res) => {
  try {
    const { descricao, detalhes, dataEntrega, user, equipe, tempoEstimado, urgencia, tags, subtarefas } = req.body;
    if (!equipe) return res.status(400).json({ erro: 'Equipe é obrigatória' });

    const equipeDoc = await Equipe.findOne({
      _id: equipe,
      $or: [{ membros: req.user.id }, { createdBy: req.user.id }],
    }).select('membros nome');
    if (!equipeDoc) {
      return res.status(400).json({ erro: 'Equipe inválida' });
    }

    let usuario = null;
    let userId = null;
    if (user && String(user).trim()) {
      userId = String(user).trim();
    }

    if (userId) {
      usuario = await User.findById(userId);
      if (!usuario || usuario.tipo !== 'user') {
        return res.status(400).json({ erro: 'User inválido' });
      }
      const pertenceEquipe = equipeDoc.membros.some(
        (membroId) => String(membroId) === String(usuario._id),
      );
      if (!pertenceEquipe) {
        return res.status(400).json({ erro: 'Usuário não pertence à equipe selecionada' });
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
      ? `Tarefa criada e atribuída a ${usuario.nome}`
      : 'Tarefa criada sem responsável e enviada ao backlog';
    await logActivity('criacao', descricaoCriacao, req.user.id, tarefa._id);

    res.status(201).json(await assinarAnexosTarefa(tarefa));
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao criar tarefa', detalhe: err.message });
  }
};

// ADMIN: list tasks (or filter by user/team)
exports.listarTarefas = async (req, res) => {
  try {
    const { user, equipe } = req.query;
    const filtroBase = {};
    if (user) filtroBase.user = user;
    if (equipe) filtroBase.equipe = equipe;

    const filtro = await montarFiltroTarefasAcessiveis(req, filtroBase);
    if (!filtro) {
      return res.json([]);
    }

    const tarefas = await Tarefa.find(filtro)
      .populate('user', 'nome')
      .populate('equipe', 'nome')
      .sort({ urgencia: -1, dataEntrega: 1 });
    res.json(await assinarAnexosTarefas(tarefas));
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao listar tarefas' });
  }
};

// ADMIN: editar tarefa
exports.editarTarefa = async (req, res) => {
  try {
    const { descricao, detalhes, dataEntrega, user, equipe, tempoEstimado, urgencia, tags } = req.body;

    const filtroTarefaAtual = await montarFiltroTarefasAcessiveis(req, { _id: req.params.id });
    if (!filtroTarefaAtual) {
      return res.status(404).json({ erro: 'Tarefa nÃ£o encontrada' });
    }

    const tarefaAtual = await Tarefa.findOne(filtroTarefaAtual);
    if (!tarefaAtual) {
      return res.status(404).json({ erro: 'Tarefa não encontrada' });
    }

    const equipeAlvo = equipe || tarefaAtual.equipe;
    const equipeDoc = await Equipe.findOne({
      _id: equipeAlvo,
      $or: [{ membros: req.user.id }, { createdBy: req.user.id }],
    }).select('membros');
    if (!equipeDoc) {
      return res.status(400).json({ erro: 'Equipe inválida' });
    }

    let userAlvo = user;
    if (userAlvo === '' || userAlvo === null) {
      userAlvo = null;
    }

    if (userAlvo) {
      const usuario = await User.findById(userAlvo);
      if (!usuario || usuario.tipo !== 'user') {
        return res.status(400).json({ erro: 'User inválido' });
      }
      const pertenceEquipe = equipeDoc.membros.some(
        (membroId) => String(membroId) === String(usuario._id),
      );
      if (!pertenceEquipe) {
        return res.status(400).json({ erro: 'Usuário não pertence à equipe selecionada' });
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

    const tarefaAtualizada = await Tarefa.findOneAndUpdate(
      filtroTarefaAtual,
      dadosAtualizacao,
      { new: true }
    );

    await logActivity('atualizacao_geral', 'Detalhes da tarefa foram atualizados', req.user.id, tarefaAtualizada._id);
    res.json(await assinarAnexosTarefa(tarefaAtualizada));
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao editar tarefa' });
  }
};

// ADMIN: excluir
exports.excluirTarefa = async (req, res) => {
  try {
    const filtro = await montarFiltroTarefasAcessiveis(req, { _id: req.params.id });
    if (!filtro) return res.status(404).json({ erro: 'Tarefa nÃ£o encontrada' });

    const tarefa = await Tarefa.findOneAndDelete(filtro);
    if (!tarefa) return res.status(404).json({ erro: 'Tarefa nÃ£o encontrada' });
    res.json({ msg: 'Tarefa excluída' });
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao excluir tarefa' });
  }
};

// ALL: get task details with comments and logs
exports.detalhesTarefa = async (req, res) => {
  try {
    const filtro = await montarFiltroTarefasAcessiveis(req, { _id: req.params.id });
    if (!filtro) return res.status(404).json({ erro: 'Tarefa nÃ£o encontrada' });

    const tarefa = await Tarefa.findOne(filtro)
      .populate('user', 'nome')
      .populate('equipe', 'nome');

    if (!tarefa) return res.status(404).json({ erro: 'Tarefa não encontrada' });

    const comentarios = await Comment.find({ tarefa: req.params.id }).populate('user', 'nome').sort({ createdAt: 1 });
    const logs = await ActivityLog.find({ tarefa: req.params.id }).populate('user', 'nome').sort({ createdAt: -1 });

    res.json({ tarefa: await assinarAnexosTarefa(tarefa), comentarios, logs });
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao buscar detalhes da tarefa', detalhe: err.message });
  }
};

// ALL: add comment
exports.adicionarComentario = async (req, res) => {
  try {
    const { texto } = req.body;
    if (!texto) return res.status(400).json({ erro: 'Texto do comentário vazio' });

    const filtro = await montarFiltroTarefasAcessiveis(req, { _id: req.params.id });
    if (!filtro) return res.status(404).json({ erro: 'Tarefa nÃ£o encontrada' });
    const tarefa = await Tarefa.findOne(filtro).select('_id');
    if (!tarefa) return res.status(404).json({ erro: 'Tarefa nÃ£o encontrada' });

    const comentario = new Comment({ texto, user: req.user.id, tarefa: req.params.id });
    await comentario.save();

    await logActivity('comentario', 'Comentário adicionado', req.user.id, req.params.id);

    const populateComentario = await Comment.findById(comentario._id).populate('user', 'nome');
    res.status(201).json(populateComentario);
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao adicionar comentário', detalhe: err.message });
  }
};

// ALL: add subtask
exports.adicionarSubtarefa = async (req, res) => {
  try {
    const { descricao } = req.body;
    if (!descricao) return res.status(400).json({ erro: 'Obrigatório fornecer descrição' });

    const filtro = await montarFiltroTarefasAcessiveis(req, { _id: req.params.id });
    if (!filtro) return res.status(404).json({ erro: 'Tarefa nÃ£o encontrada' });

    const tarefa = await Tarefa.findOne(filtro);
    if (!tarefa) return res.status(404).json({ erro: 'Tarefa não encontrada' });

    tarefa.subtarefas.push({ descricao, concluida: false });
    await tarefa.save();

    await logActivity('nova_subtarefa', `Subtarefa '${descricao}' adicionada`, req.user.id, req.params.id);
    res.status(201).json(await assinarAnexosTarefa(tarefa));
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao adicionar subtarefa' });
  }
};

// ALL: toggle subtask
exports.toggleSubtarefa = async (req, res) => {
  try {
    const { subId } = req.params;
    const filtro = await montarFiltroTarefasAcessiveis(req, { _id: req.params.id });
    if (!filtro) return res.status(404).json({ erro: 'Tarefa nÃ£o encontrada' });

    const tarefa = await Tarefa.findOne(filtro);
    if (!tarefa) return res.status(404).json({ erro: 'Tarefa não encontrada' });

    const sub = tarefa.subtarefas.id(subId);
    if (!sub) return res.status(404).json({ erro: 'Subtarefa não encontrada' });

    sub.concluida = !sub.concluida;
    await tarefa.save();

    res.json(await assinarAnexosTarefa(tarefa));
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao alterar subtarefa' });
  }
};

// USER: view their own tasks
exports.minhasTarefas = async (req, res) => {
  try {
    const filtro = await montarFiltroTarefasAcessiveis(req);
    if (!filtro) {
      return res.json([]);
    }

    const tarefas = await Tarefa.find(filtro)
      .populate('user', 'nome')
      .populate('equipe', 'nome')
      .sort({ urgencia: -1, dataEntrega: 1 });
    res.json(await assinarAnexosTarefas(tarefas));
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao buscar suas tarefas' });
  }
};

// USER: backlog de tarefas sem responsável (apenas equipes do usuário)
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

    res.json(await assinarAnexosTarefas(tarefas));
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao buscar backlog', detalhe: err.message });
  }
};

// USER: atribuir tarefa do backlog para si mesmo
exports.atribuirParaMim = async (req, res) => {
  try {
    const filtro = await montarFiltroTarefasAcessiveis(req, { _id: req.params.id });
    if (!filtro) return res.status(404).json({ erro: 'Tarefa nÃ£o encontrada' });

    const tarefa = await Tarefa.findOne(filtro);
    if (!tarefa) {
      return res.status(404).json({ erro: 'Tarefa não encontrada' });
    }

    if (tarefa.user) {
      return res.status(409).json({ erro: 'Esta tarefa já possui responsável' });
    }

    const equipe = await Equipe.findById(tarefa.equipe).select('membros createdBy nome');
    if (!equipe) {
      return res.status(400).json({ erro: 'Equipe da tarefa não encontrada' });
    }

    const pertenceEquipe = equipe.membros.some(
      (membroId) => String(membroId) === String(req.user.id),
    );

    if (!pertenceEquipe) {
      return res.status(403).json({ erro: 'Você não pertence à equipe desta tarefa' });
    }

    tarefa.user = req.user.id;
    await tarefa.save();

    await logActivity(
      'atualizacao_geral',
      'Tarefa atribuída automaticamente para o colaborador',
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

    res.json({ msg: 'Tarefa atribuída com sucesso', tarefa: await assinarAnexosTarefa(tarefaAtualizada) });
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao atribuir tarefa', detalhe: err.message });
  }
};

// USER: update task status
exports.atualizarStatusUser = async (req, res) => {
  try {
    const { status } = req.body;

    if (!status || !["pendente", "em_andamento", "concluido"].includes(status)) {
      return res.status(400).json({ erro: "Status inválido" });
    }

    const tarefa = await Tarefa.findOne({ _id: req.params.id, user: req.user.id }).populate('equipe', 'createdBy nome');

    if (!tarefa) {
      return res.status(403).json({ erro: 'Você não pode editar essa tarefa' });
    }

    if (tarefa.cronometroAtivo && status !== 'em_andamento') {
      await pausarCronometroAtivo(tarefa, req.user.id, 'cronometro_pausado_por_status');
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
          ? 'concluída'
          : status;

      await notifyUsers({
        userIds: [notificarAdmin],
        texto: `${usuario?.nome || 'Um colaborador'} marcou a tarefa "${tarefa.descricao}" como ${statusLegivel}`,
        tipo: 'task',
        origemId: tarefa._id,
        metadata: { tarefaId: tarefa._id, status },
      });
    }

    res.json({ msg: 'Status atualizado com sucesso', tarefa: await assinarAnexosTarefa(tarefa) });
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao atualizar status', detalhe: err.message });
  }
};

// USER: controlar cronômetro
exports.controlarCronometro = async (req, res) => {
  try {
    const { acao } = req.body; // 'iniciar' ou 'pausar'
    const tarefa = await Tarefa.findOne({ _id: req.params.id, user: req.user.id });

    if (!tarefa) return res.status(403).json({ erro: 'Acesso negado à tarefa' });

    if (acao === 'iniciar') {
      if (tarefa.cronometroAtivo) {
        return res.status(400).json({ erro: 'Cronômetro já está ativo' });
      }
      tarefa.cronometroAtivo = true;
      tarefa.ultimaAtualizacaoCronometro = new Date();
      await logActivity('cronometro_iniciado', `Cronômetro iniciado`, req.user.id, tarefa._id);
    } else if (acao === 'pausar') {
      if (!tarefa.cronometroAtivo) {
        return res.status(400).json({ erro: 'Cronômetro já está pausado' });
      }
      const tempoDecorrido = Math.floor((new Date() - tarefa.ultimaAtualizacaoCronometro) / 60000); // converte para minutos
      tarefa.tempoGasto += tempoDecorrido;
      tarefa.cronometroAtivo = false;

      // Verifica se o tempo estimado foi excedido
      if (tarefa.tempoEstimado && tarefa.tempoGasto > tarefa.tempoEstimado) {
        tarefa.tempoExcedido = true;
      }
      await logActivity('cronometro_pausado', `Cronômetro pausado. +${tempoDecorrido} mins`, req.user.id, tarefa._id);
    }

    await tarefa.save();
    res.json({
      msg: `Cronômetro ${acao}do com sucesso`,
      tarefa: await assinarAnexosTarefa(tarefa),
      tempoExcedido: tarefa.tempoExcedido
    });
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao controlar cronômetro' });
  }
};

// ALL: Upload de anexos
exports.adicionarAnexo = async (req, res) => {
  try {
    const filtro = await montarFiltroTarefasAcessiveis(req, { _id: req.params.id });
    if (!filtro) return res.status(404).json({ erro: 'Tarefa nÃ£o encontrada' });

    const tarefa = await Tarefa.findOne(filtro);
    if (!tarefa) return res.status(404).json({ erro: 'Tarefa não encontrada' });

    if (!req.file) {
      return res.status(400).json({ erro: 'Nenhum arquivo enviado' });
    }

    // Arquivo foi validado pela middleware, agora fazer upload
    const filePath = await uploadAnexoParaGCS(tarefa._id, req.file);

    const novoAnexo = {
      url: filePath,
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
      anexo: {
        ...novoAnexo,
        url: await getSignedUrl(novoAnexo.url),
      }
    });
  } catch (err) {
    console.error('Erro ao fazer upload de anexo para Google Cloud Storage:', err);
    if (err.message.includes('timeout')) {
      return res.status(504).json({ erro: 'Timeout ao conectar com Cloud Storage' });
    }
    res.status(500).json({ erro: 'Erro ao fazer upload de anexo', detalhe: err.message });
  }
};

/**
 * Função auxiliar para upload de anexo usando bucket.file().save()
 * Armazena em: arquivos/{tarefaId}/{timestamp}-{random}.{ext}
 * @param {string} tarefaId - ID da tarefa
 * @param {Object} file - Objeto do arquivo (req.file)
 * @returns {Promise<string>} URL pública do arquivo
 */
const uploadAnexoParaGCS = async (tarefaId, file) => {
  try {
    const path = require('path');
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
    const extension = path.extname(file.originalname);
    // Organizar em pasta: arquivos/{tarefaId}/{arquivo}
    const filename = `arquivos/${tarefaId}/${uniqueSuffix}${extension}`;

    const blob = bucket.file(filename);

    // Usar save() em vez de createWriteStream() para evitar race conditions
    await blob.save(file.buffer, {
      metadata: {
        contentType: file.mimetype,
        cacheControl: 'public, max-age=31536000'
      },
      timeout: 60000 // 60 segundos de timeout
    });

    console.log('✅ Upload de anexo concluído em:', filename);
    return filename;
  } catch (error) {
    console.error('❌ Erro ao fazer upload de anexo:', error.message);
    throw error;
  }
};
