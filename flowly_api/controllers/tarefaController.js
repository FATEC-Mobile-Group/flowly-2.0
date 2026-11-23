const Tarefa = require('../models/Tarefa');
const User = require('../models/User');
const Equipe = require('../models/Equipe');
const Comment = require('../models/Comment');
const ActivityLog = require('../models/ActivityLog');
const logActivity = require('../utils/activityLogger');
const { notifyUsers, persistNotifications, emitNotifications } = require('../utils/notificationService');
const bucket = require('../services/storage');
const { getSignedUrl, getObjectPath } = require('../services/storage');
const { montarContentDisposition } = require('../utils/contentDisposition');
const { createIdempotencyService, IdempotentRequestError } = require('../services/idempotencyService');
const {
  executarTransicao,
  calcularTransicaoStatus,
  calcularTransicaoCronometro,
  montarCondicao,
  montarUpdate,
  TaskTransitionConflictError,
  TaskTimerInconsistentError,
} = require('../services/taskStateTransition');

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

const MSG_CONFLITO_TAREFA = 'A tarefa foi alterada por outra operação ao mesmo tempo. Tente novamente.';

const MSG_CRONOMETRO_INCONSISTENTE = 'O cronômetro desta tarefa está inconsistente: o horário de início está ausente, '
  + 'inválido ou no futuro. Nenhum tempo foi contabilizado e a tarefa não foi alterada.';

// Recusas controladas da transicao de status/cronometro (nada foi gravado, nenhum log ou notificacao): 409.
// Qualquer outro erro segue para o 500 de cada rota.
const responderRecusaTransicao = (err, res) => {
  if (err instanceof TaskTransitionConflictError) {
    res.status(409).json({ erro: MSG_CONFLITO_TAREFA });
    return true;
  }
  if (err instanceof TaskTimerInconsistentError) {
    // Diagnostico so com o motivo e o id da tarefa.
    console.warn('Cronômetro inconsistente; operação recusada:', err.motivo, String(err.tarefaId));
    res.status(409).json({ erro: MSG_CRONOMETRO_INCONSISTENTE });
    return true;
  }
  return false;
};

// session: so no caminho transacional idempotente (consulta dentro da transacao). Sem ela, consulta de sempre.
const getEquipeIdsAcessiveis = async (req, session) => {
  const filtroEquipes = req.user.tipo === 'admin'
    ? { $or: [{ membros: req.user.id }, { createdBy: req.user.id }] }
    : { membros: req.user.id };

  const consulta = Equipe.find(filtroEquipes).select('_id');
  const equipes = await (session ? consulta.session(session) : consulta);
  return equipes.map((equipe) => equipe._id);
};

const CAMPOS_EDITAVEIS = ['descricao', 'detalhes', 'dataEntrega', 'user', 'equipe', 'tempoEstimado', 'urgencia', 'tags'];

const OBJECT_ID_PATTERN = /^[a-f\d]{24}$/i;

// Identificador informado que nao e texto viraria filtro ou valor invalido nas consultas.
const identificadorInvalido = (value) =>
  value !== undefined && value !== null && value !== '' && typeof value !== 'string';

const montarFiltroTarefasAcessiveis = async (req, filtroBase = {}, session) => {
  const equipeIds = await getEquipeIdsAcessiveis(req, session);
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
    if (typeof equipe !== 'string') return res.status(400).json({ erro: 'Equipe inválida' });
    if (identificadorInvalido(user)) return res.status(400).json({ erro: 'User inválido' });

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
    // Campo obrigatorio ausente ou valor que o modelo nao aceita e erro do cliente.
    if (err.name === 'ValidationError') {
      return res.status(400).json({ erro: 'Dados da tarefa inválidos.' });
    }
    console.error('Erro ao criar tarefa:', err);
    res.status(500).json({ erro: 'Erro ao criar tarefa' });
  }
};

// ---------------------------------------------------------------------------------------------------------
// Criacao protegida por Idempotency-Key (so com o cabecalho; ver middlewares/idempotencyOptIn.js).
// Mesmas regras e mensagens do criarTarefa acima. Na MESMA transacao: conclusao da chave, tarefa e log de
// criacao; se qualquer um falhar, nada fica gravado. O registro da chave guarda so status, tipo e ID; a resposta
// e montada de novo depois do commit (URLs assinadas novas, acesso conferido de novo).

const ROTA_CRIAR_TAREFA = '/api/tarefas';
const MENSAGENS_CRIAR_TAREFA = {
  equipe_obrigatoria: 'Equipe é obrigatória',
  equipe_invalida: 'Equipe inválida',
  user_invalido: 'User inválido',
  usuario_fora_da_equipe: 'Usuário não pertence à equipe selecionada',
  dados_invalidos: 'Dados da tarefa inválidos.',
};
const RESPOSTAS_IDEMPOTENCIA_TAREFA = {
  invalid: { status: 400, erro: 'Chave de idempotência inválida.' },
  conflict: { status: 422, erro: 'Esta chave de idempotência já foi usada com outro pedido.' },
  in_progress: { status: 409, erro: 'Esta criação ainda está em andamento. Tente novamente em instantes.' },
  unknown: {
    status: 409,
    erro: 'Não foi possível confirmar se a tarefa foi criada. Verifique a lista de tarefas antes de tentar de novo.',
  },
  unavailable: { status: 503, erro: 'Serviço temporariamente indisponível.' },
};

let servicoIdempotenciaTarefa;
const obterServicoIdempotenciaTarefa = () => {
  if (!servicoIdempotenciaTarefa) {
    servicoIdempotenciaTarefa = createIdempotencyService();
  }
  return servicoIdempotenciaTarefa;
};

const novaTarefaDoPedido = (corpo, criadorId, userId) => {
  const { descricao, detalhes, dataEntrega, equipe, tempoEstimado, urgencia, tags, subtarefas } = corpo;
  return new Tarefa({
    descricao,
    detalhes,
    dataEntrega,
    createdBy: criadorId,
    user: userId,
    equipe,
    tempoEstimado,
    urgencia,
    tags: tags || [],
    subtarefas: subtarefas || [],
  });
};

// Validacao sem banco (mesmas regras do criarTarefa). Roda antes de reivindicar a chave: um pedido malformado
// responde 400 sem consumir a chave. IDs fora do formato viram 400 aqui (no legado, viram erro de conversao).
const validarFormatoNovaTarefa = async (corpo, criadorId) => {
  const { user, equipe } = corpo;
  if (!equipe) return { codigo: 'equipe_obrigatoria' };
  if (typeof equipe !== 'string' || !OBJECT_ID_PATTERN.test(equipe)) return { codigo: 'equipe_invalida' };
  if (identificadorInvalido(user)) return { codigo: 'user_invalido' };
  const userId = user && String(user).trim() ? String(user).trim() : null;
  if (userId && !OBJECT_ID_PATTERN.test(userId)) return { codigo: 'user_invalido' };
  try {
    await novaTarefaDoPedido(corpo, criadorId, userId).validate();
  } catch (err) {
    if (err.name === 'ValidationError') return { codigo: 'dados_invalidos' };
    throw err;
  }
  return { userId };
};

const responderCriacaoSemTarefa = (res, resposta) => {
  if (resposta.outcome === 'failed') {
    if (resposta.replayed) res.set('Idempotency-Replayed', 'true');
    const mensagem = MENSAGENS_CRIAR_TAREFA[resposta.code];
    if (mensagem) {
      return res.status(resposta.statusCode).json({ erro: mensagem });
    }
    return res.status(500).json({ erro: 'Erro ao criar tarefa' });
  }
  const conhecida = RESPOSTAS_IDEMPOTENCIA_TAREFA[resposta.outcome];
  if (!conhecida) {
    return res.status(500).json({ erro: 'Erro ao criar tarefa' });
  }
  if (resposta.outcome === 'in_progress' || resposta.outcome === 'unavailable') {
    res.set('Retry-After', '2');
  }
  return res.status(conhecida.status).json({ erro: conhecida.erro, code: resposta.code });
};

exports.criarTarefaIdempotente = async (req, res) => {
  try {
    const criadorId = String(req.user.id); // so do JWT verificado; nunca do corpo
    const formato = await validarFormatoNovaTarefa(req.body, criadorId);
    if (formato.codigo) {
      return res.status(400).json({ erro: MENSAGENS_CRIAR_TAREFA[formato.codigo] });
    }
    const { descricao, detalhes, dataEntrega, user, equipe, tempoEstimado, urgencia, tags, subtarefas } = req.body;

    const resposta = await obterServicoIdempotenciaTarefa().execute(
      {
        userId: criadorId,
        key: req.get('Idempotency-Key'),
        method: 'POST',
        route: ROTA_CRIAR_TAREFA,
        body: { descricao, detalhes, dataEntrega, user, equipe, tempoEstimado, urgencia, tags, subtarefas },
      },
      // Pode rodar mais de uma vez (withTransaction repete em erro transitorio): toda leitura e gravacao usa a
      // session; nenhum efeito fora da transacao (sem notificacao, socket ou URL assinada aqui dentro).
      async (session) => {
        const equipeDoc = await Equipe.findOne({
          _id: equipe,
          $or: [{ membros: criadorId }, { createdBy: criadorId }],
        })
          .select('membros nome')
          .session(session);
        if (!equipeDoc) {
          throw new IdempotentRequestError(400, 'equipe_invalida');
        }

        let usuario = null;
        if (formato.userId) {
          usuario = await User.findById(formato.userId).select('tipo nome').session(session);
          if (!usuario || usuario.tipo !== 'user') {
            throw new IdempotentRequestError(400, 'user_invalido');
          }
          const pertenceEquipe = equipeDoc.membros.some((membroId) => String(membroId) === String(usuario._id));
          if (!pertenceEquipe) {
            throw new IdempotentRequestError(400, 'usuario_fora_da_equipe');
          }
        }

        const tarefa = novaTarefaDoPedido(req.body, criadorId, formato.userId);
        try {
          await tarefa.save({ session });
        } catch (err) {
          if (err.name === 'ValidationError') {
            throw new IdempotentRequestError(400, 'dados_invalidos');
          }
          throw err;
        }

        const descricaoCriacao = usuario
          ? `Tarefa criada e atribuída a ${usuario.nome}`
          : 'Tarefa criada sem responsável e enviada ao backlog';
        // Com session o log nao engole erro: se falhar, a transacao aborta e a tarefa nao fica sem log.
        await logActivity('criacao', descricaoCriacao, criadorId, tarefa._id, { session });

        return { statusCode: 201, resourceType: 'tarefa', resourceId: tarefa._id };
      }
    );

    if (resposta.outcome !== 'executed' && resposta.outcome !== 'replayed') {
      return responderCriacaoSemTarefa(res, resposta);
    }

    // Revalida o acesso antes de devolver dados: numa repeticao a equipe ou a tarefa podem ter mudado.
    // Sessao e papel de admin ja foram conferidos pelo auth/isAdmin nesta mesma requisicao.
    const filtro = await montarFiltroTarefasAcessiveis(req, { _id: resposta.result.resourceId });
    const tarefa = filtro ? await Tarefa.findOne(filtro) : null;
    if (!tarefa) {
      return res.status(404).json({ erro: 'Tarefa não encontrada' });
    }
    if (resposta.outcome === 'replayed') {
      res.set('Idempotency-Replayed', 'true');
    }
    return res.status(resposta.statusCode).json(await assinarAnexosTarefa(tarefa));
  } catch (err) {
    console.error('Erro ao criar tarefa (idempotente):', err?.name);
    return res.status(500).json({ erro: 'Erro ao criar tarefa' });
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

    if (!CAMPOS_EDITAVEIS.some((campo) => req.body[campo] !== undefined)) {
      return res.status(400).json({ erro: 'Nenhum dado para atualizar.' });
    }
    if (identificadorInvalido(equipe)) return res.status(400).json({ erro: 'Equipe inválida' });
    if (identificadorInvalido(user)) return res.status(400).json({ erro: 'User inválido' });

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
    console.error('Erro ao editar tarefa:', err);
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
      .populate('equipe', 'nome')
      .populate('anexos.uploadedBy', 'nome');

    if (!tarefa) return res.status(404).json({ erro: 'Tarefa não encontrada' });

    const comentarios = await Comment.find({ tarefa: req.params.id }).populate('user', 'nome').sort({ createdAt: 1 });
    const logs = await ActivityLog.find({ tarefa: req.params.id }).populate('user', 'nome').sort({ createdAt: -1 });

    res.json({ tarefa: await assinarAnexosTarefa(tarefa), comentarios, logs });
  } catch (err) {
    console.error('Erro ao buscar detalhes da tarefa:', err);
    res.status(500).json({ erro: 'Erro ao buscar detalhes da tarefa' });
  }
};

// ALL: add comment
exports.adicionarComentario = async (req, res) => {
  try {
    const { texto } = req.body;
    if (typeof texto !== 'string' || !texto) return res.status(400).json({ erro: 'Texto do comentário vazio' });

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
    console.error('Erro ao adicionar comentário:', err);
    res.status(500).json({ erro: 'Erro ao adicionar comentário' });
  }
};

// ---------------------------------------------------------------------------------------------------------
// Comentario protegido por Idempotency-Key (so com o cabecalho; ver middlewares/idempotencyOptIn.js).
// Mesmas regras e mensagens do adicionarComentario acima. Na MESMA transacao: conferencia de acesso, comentario,
// log e conclusao da chave. A resposta e montada de novo depois do commit, com o acesso conferido outra vez.

const ROTA_COMENTARIO = '/api/tarefas/:id/comentarios';
// Mensagens identicas as do fluxo legado (inclusive o texto do 404, que hoje sai com a codificacao quebrada em
// todas as rotas de tarefa: corrigir em separado, para todas juntas).
const MENSAGENS_COMENTARIO = {
  texto_vazio: { status: 400, erro: 'Texto do comentário vazio' },
  tarefa_nao_encontrada: { status: 404, erro: 'Tarefa nÃ£o encontrada' },
};
const RESPOSTAS_IDEMPOTENCIA_COMENTARIO = {
  invalid: { status: 400, erro: 'Chave de idempotência inválida.' },
  conflict: { status: 422, erro: 'Esta chave de idempotência já foi usada com outro pedido.' },
  in_progress: { status: 409, erro: 'Este comentário ainda está sendo enviado. Tente novamente em instantes.' },
  unknown: {
    status: 409,
    erro: 'Não foi possível confirmar se o comentário foi publicado. Verifique a tarefa antes de tentar de novo.',
  },
  unavailable: { status: 503, erro: 'Serviço temporariamente indisponível.' },
};

const responderComentarioSemRecurso = (res, resposta) => {
  if (resposta.outcome === 'failed') {
    if (resposta.replayed) res.set('Idempotency-Replayed', 'true');
    const conhecida = MENSAGENS_COMENTARIO[resposta.code];
    if (conhecida && conhecida.status === resposta.statusCode) {
      return res.status(conhecida.status).json({ erro: conhecida.erro });
    }
    return res.status(500).json({ erro: 'Erro ao adicionar comentário' });
  }
  const conhecida = RESPOSTAS_IDEMPOTENCIA_COMENTARIO[resposta.outcome];
  if (!conhecida) {
    return res.status(500).json({ erro: 'Erro ao adicionar comentário' });
  }
  if (resposta.outcome === 'in_progress' || resposta.outcome === 'unavailable') {
    res.set('Retry-After', '2');
  }
  return res.status(conhecida.status).json({ erro: conhecida.erro, code: resposta.code });
};

exports.adicionarComentarioIdempotente = async (req, res) => {
  try {
    const { texto } = req.body;
    // Sem banco, antes de reivindicar a chave: pedido malformado nao consome a chave.
    if (typeof texto !== 'string' || !texto) {
      return res.status(400).json({ erro: MENSAGENS_COMENTARIO.texto_vazio.erro });
    }
    const tarefaId = req.params.id;
    if (typeof tarefaId !== 'string' || !OBJECT_ID_PATTERN.test(tarefaId)) {
      // ID fora do formato: 404 (no legado, vira erro de conversao e 500).
      return res.status(404).json({ erro: MENSAGENS_COMENTARIO.tarefa_nao_encontrada.erro });
    }
    const autorId = String(req.user.id); // so do JWT verificado; nunca do corpo

    const resposta = await obterServicoIdempotenciaTarefa().execute(
      {
        userId: autorId,
        key: req.get('Idempotency-Key'),
        method: 'POST',
        route: ROTA_COMENTARIO,
        params: { id: tarefaId },
        body: { texto },
      },
      // Pode rodar mais de uma vez (withTransaction repete em erro transitorio): toda leitura e gravacao usa a
      // session; nenhum efeito fora da transacao.
      async (session) => {
        const filtro = await montarFiltroTarefasAcessiveis(req, { _id: tarefaId }, session);
        const tarefa = filtro ? await Tarefa.findOne(filtro).select('_id').session(session) : null;
        if (!tarefa) {
          throw new IdempotentRequestError(404, 'tarefa_nao_encontrada');
        }
        const comentario = new Comment({ texto, user: autorId, tarefa: tarefaId });
        await comentario.save({ session });
        // Com session o log nao engole erro: se falhar, comentario e chave voltam juntos.
        await logActivity('comentario', 'Comentário adicionado', autorId, tarefaId, { session });
        return { statusCode: 201, resourceType: 'comentario', resourceId: comentario._id };
      }
    );

    if (resposta.outcome !== 'executed' && resposta.outcome !== 'replayed') {
      return responderComentarioSemRecurso(res, resposta);
    }

    // Revalida o acesso a tarefa antes de devolver dados (numa repeticao a pessoa pode ter saido da equipe).
    const filtro = await montarFiltroTarefasAcessiveis(req, { _id: tarefaId });
    const tarefa = filtro ? await Tarefa.findOne(filtro).select('_id') : null;
    if (!tarefa) {
      return res.status(404).json({ erro: MENSAGENS_COMENTARIO.tarefa_nao_encontrada.erro });
    }
    const comentario = await Comment.findOne({ _id: resposta.result.resourceId, tarefa: tarefaId }).populate('user', 'nome');
    if (!comentario) {
      return res.status(404).json({ erro: 'Comentário não encontrado' });
    }
    if (resposta.outcome === 'replayed') {
      res.set('Idempotency-Replayed', 'true');
    }
    return res.status(resposta.statusCode).json(comentario);
  } catch (err) {
    console.error('Erro ao adicionar comentário (idempotente):', err?.name);
    return res.status(500).json({ erro: 'Erro ao adicionar comentário' });
  }
};

// ALL: add subtask
exports.adicionarSubtarefa = async (req, res) => {
  try {
    const { descricao } = req.body;
    if (typeof descricao !== 'string' || !descricao) return res.status(400).json({ erro: 'Obrigatório fornecer descrição' });

    const filtro = await montarFiltroTarefasAcessiveis(req, { _id: req.params.id });
    if (!filtro) return res.status(404).json({ erro: 'Tarefa nÃ£o encontrada' });

    const tarefa = await Tarefa.findOne(filtro);
    if (!tarefa) return res.status(404).json({ erro: 'Tarefa não encontrada' });

    tarefa.subtarefas.push({ descricao, concluida: false });
    await tarefa.save();

    await logActivity('nova_subtarefa', `Subtarefa '${descricao}' adicionada`, req.user.id, req.params.id);
    res.status(201).json(await assinarAnexosTarefa(tarefa));
  } catch (err) {
    console.error('Erro ao adicionar subtarefa:', err);
    res.status(500).json({ erro: 'Erro ao adicionar subtarefa' });
  }
};

// ---------------------------------------------------------------------------------------------------------
// Subtarefa protegida por Idempotency-Key (so com o cabecalho; ver middlewares/idempotencyOptIn.js).
// Mesmas regras e mensagens do adicionarSubtarefa acima. Na MESMA transacao: conferencia de acesso, inclusao,
// log e conclusao da chave.
//
// Concorrencia: em vez de carregar a tarefa, mexer no array e salvar, faz uma atualizacao atomica com o
// filtro de acesso: { $push: subtarefa, $inc: { __v: 1 } } - exatamente o que o save() legado envia para um
// push. Nada e regravado, entao inclusoes simultaneas (com chaves diferentes ou pelo fluxo legado) nao se
// sobrescrevem; o $inc de __v mantem a mesma regra de versao que o legado usa no toggle de subtarefa (que
// falha com VersionError, sem perder dados, se o array mudou depois de ele carregar a tarefa).

const ROTA_SUBTAREFA = '/api/tarefas/:id/subtarefas';
// Mensagens identicas as do fluxo legado, inclusive as duas versoes do 404 (a de codificacao quebrada quando a
// pessoa nao tem nenhuma equipe acessivel; a correta quando a tarefa nao e encontrada).
const MENSAGENS_SUBTAREFA = {
  descricao_obrigatoria: { status: 400, erro: 'Obrigatório fornecer descrição' },
  tarefa_sem_equipes: { status: 404, erro: 'Tarefa nÃ£o encontrada' },
  tarefa_nao_encontrada: { status: 404, erro: 'Tarefa não encontrada' },
};
const RESPOSTAS_IDEMPOTENCIA_SUBTAREFA = {
  invalid: { status: 400, erro: 'Chave de idempotência inválida.' },
  conflict: { status: 422, erro: 'Esta chave de idempotência já foi usada com outro pedido.' },
  in_progress: { status: 409, erro: 'Esta subtarefa ainda está sendo adicionada. Tente novamente em instantes.' },
  unknown: {
    status: 409,
    erro: 'Não foi possível confirmar se a subtarefa foi adicionada. Verifique a tarefa antes de tentar de novo.',
  },
  unavailable: { status: 503, erro: 'Serviço temporariamente indisponível.' },
};

// Subtarefa criada e validada pelo schema real (defaults e _id), por meio de um documento pai temporario.
const novaSubtarefaValidada = (descricao) => {
  const pai = new Tarefa({ subtarefas: [{ descricao, concluida: false }] });
  const erro = pai.validateSync(['subtarefas']);
  if (erro) {
    return null;
  }
  return pai.subtarefas[0].toObject();
};

const responderSubtarefaSemRecurso = (res, resposta) => {
  if (resposta.outcome === 'failed') {
    if (resposta.replayed) res.set('Idempotency-Replayed', 'true');
    const conhecida = MENSAGENS_SUBTAREFA[resposta.code];
    if (conhecida && conhecida.status === resposta.statusCode) {
      return res.status(conhecida.status).json({ erro: conhecida.erro });
    }
    return res.status(500).json({ erro: 'Erro ao adicionar subtarefa' });
  }
  const conhecida = RESPOSTAS_IDEMPOTENCIA_SUBTAREFA[resposta.outcome];
  if (!conhecida) {
    return res.status(500).json({ erro: 'Erro ao adicionar subtarefa' });
  }
  if (resposta.outcome === 'in_progress' || resposta.outcome === 'unavailable') {
    res.set('Retry-After', '2');
  }
  return res.status(conhecida.status).json({ erro: conhecida.erro, code: resposta.code });
};

exports.adicionarSubtarefaIdempotente = async (req, res) => {
  try {
    const { descricao } = req.body;
    // Sem banco, antes de reivindicar a chave: pedido malformado nao consome a chave.
    if (typeof descricao !== 'string' || !descricao || !novaSubtarefaValidada(descricao)) {
      return res.status(400).json({ erro: MENSAGENS_SUBTAREFA.descricao_obrigatoria.erro });
    }
    const tarefaId = req.params.id;
    if (typeof tarefaId !== 'string' || !OBJECT_ID_PATTERN.test(tarefaId)) {
      // ID fora do formato: 404 (no legado, vira erro de conversao e 500).
      return res.status(404).json({ erro: MENSAGENS_SUBTAREFA.tarefa_nao_encontrada.erro });
    }
    const autorId = String(req.user.id); // so do JWT verificado; nunca do corpo

    const resposta = await obterServicoIdempotenciaTarefa().execute(
      {
        userId: autorId,
        key: req.get('Idempotency-Key'),
        method: 'POST',
        route: ROTA_SUBTAREFA,
        params: { id: tarefaId },
        body: { descricao },
      },
      // Pode rodar mais de uma vez (withTransaction repete em erro transitorio, inclusive WriteConflict com outra
      // inclusao na mesma tarefa): toda leitura e gravacao usa a session; nenhum efeito fora da transacao.
      async (session) => {
        const filtro = await montarFiltroTarefasAcessiveis(req, { _id: tarefaId }, session);
        if (!filtro) {
          throw new IdempotentRequestError(404, 'tarefa_sem_equipes');
        }
        const subtarefa = novaSubtarefaValidada(descricao);
        // Acesso e existencia conferidos na propria atualizacao (o filtro restringe as equipes acessiveis).
        const resultado = await Tarefa.updateOne(
          filtro,
          { $push: { subtarefas: subtarefa }, $inc: { __v: 1 } },
          { session, runValidators: true }
        );
        if (!resultado || resultado.matchedCount !== 1) {
          throw new IdempotentRequestError(404, 'tarefa_nao_encontrada');
        }
        // Com session o log nao engole erro: se falhar, a subtarefa e a chave voltam juntas.
        await logActivity('nova_subtarefa', `Subtarefa '${descricao}' adicionada`, autorId, tarefaId, { session });
        return { statusCode: 201, resourceType: 'subtarefa', resourceId: subtarefa._id };
      }
    );

    if (resposta.outcome !== 'executed' && resposta.outcome !== 'replayed') {
      return responderSubtarefaSemRecurso(res, resposta);
    }

    // Revalida o acesso antes de devolver dados (numa repeticao a pessoa pode ter saido da equipe) e monta a
    // resposta de agora: a tarefa atualizada, com URLs de anexos assinadas na hora.
    const filtro = await montarFiltroTarefasAcessiveis(req, { _id: tarefaId });
    if (!filtro) {
      return res.status(404).json({ erro: MENSAGENS_SUBTAREFA.tarefa_sem_equipes.erro });
    }
    const tarefa = await Tarefa.findOne(filtro);
    if (!tarefa) {
      return res.status(404).json({ erro: MENSAGENS_SUBTAREFA.tarefa_nao_encontrada.erro });
    }
    if (!tarefa.subtarefas.id(resposta.result.resourceId)) {
      return res.status(404).json({ erro: 'Subtarefa não encontrada' });
    }
    if (resposta.outcome === 'replayed') {
      res.set('Idempotency-Replayed', 'true');
    }
    return res.status(resposta.statusCode).json(await assinarAnexosTarefa(tarefa));
  } catch (err) {
    console.error('Erro ao adicionar subtarefa (idempotente):', err?.name);
    return res.status(500).json({ erro: 'Erro ao adicionar subtarefa' });
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
    const filtro = await montarFiltroTarefasAcessiveis(req, { user: req.user.id });
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
    console.error('Erro ao buscar backlog:', err);
    res.status(500).json({ erro: 'Erro ao buscar backlog' });
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

    // Atribuicao condicional: so grava se a tarefa ainda estiver sem responsavel no momento da gravacao. Antes,
    // um save() sem condicao deixava duas requisicoes simultaneas "assumirem" a mesma tarefa (a ultima vencia).
    // Quem perde a corrida recebe o mesmo 409 de "ja tem responsavel", sem log nem notificacao.
    const atribuicao = await Tarefa.updateOne(
      { _id: tarefa._id, equipe: tarefa.equipe, user: null },
      { $set: { user: req.user.id } }
    );
    if (!atribuicao || atribuicao.matchedCount !== 1) {
      return res.status(409).json({ erro: 'Esta tarefa já possui responsável' });
    }

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
    console.error('Erro ao atribuir tarefa:', err);
    res.status(500).json({ erro: 'Erro ao atribuir tarefa' });
  }
};

// ---------------------------------------------------------------------------------------------------------
// Atribuicao protegida por Idempotency-Key (so com o cabecalho; ver middlewares/idempotencyOptIn.js).
// Mesmas regras e mensagens do atribuirParaMim acima. Na MESMA transacao: conferencias, atribuicao condicional,
// log, notificacao ao admin e conclusao da chave. A emissao por Socket.IO sai so depois do commit (afterCommit),
// uma unica vez; repeticoes da chave nao gravam nem emitem de novo.
//
// Concorrencia: a atribuicao e condicional - updateOne({ _id, equipe, user: null }, { $set: { user } }) - entao
// so quem encontra a tarefa ainda sem responsavel a assume; quem perde recebe 409. O fluxo legado usa a mesma
// condicao (sem transacao), entao nenhum dos dois caminhos sobrescreve o responsavel definido pelo outro.

const ROTA_ATRIBUIR = '/api/tarefas/:id/atribuir-para-mim';
// Mensagens identicas as do fluxo legado (inclusive as duas versoes do 404).
const MENSAGENS_ATRIBUIR = {
  tarefa_sem_equipes: { status: 404, erro: 'Tarefa nÃ£o encontrada' },
  tarefa_nao_encontrada: { status: 404, erro: 'Tarefa não encontrada' },
  tarefa_ja_atribuida: { status: 409, erro: 'Esta tarefa já possui responsável' },
  equipe_nao_encontrada: { status: 400, erro: 'Equipe da tarefa não encontrada' },
  fora_da_equipe: { status: 403, erro: 'Você não pertence à equipe desta tarefa' },
};
const RESPOSTAS_IDEMPOTENCIA_ATRIBUIR = {
  invalid: { status: 400, erro: 'Chave de idempotência inválida.' },
  conflict: { status: 422, erro: 'Esta chave de idempotência já foi usada com outro pedido.' },
  in_progress: { status: 409, erro: 'Esta atribuição ainda está em andamento. Tente novamente em instantes.' },
  unknown: {
    status: 409,
    erro: 'Não foi possível confirmar se a tarefa foi atribuída. Verifique a tarefa antes de tentar de novo.',
  },
  unavailable: { status: 503, erro: 'Serviço temporariamente indisponível.' },
};

const responderAtribuicaoSemRecurso = (res, resposta) => {
  if (resposta.outcome === 'failed') {
    if (resposta.replayed) res.set('Idempotency-Replayed', 'true');
    const conhecida = MENSAGENS_ATRIBUIR[resposta.code];
    if (conhecida && conhecida.status === resposta.statusCode) {
      return res.status(conhecida.status).json({ erro: conhecida.erro });
    }
    return res.status(500).json({ erro: 'Erro ao atribuir tarefa' });
  }
  const conhecida = RESPOSTAS_IDEMPOTENCIA_ATRIBUIR[resposta.outcome];
  if (!conhecida) {
    return res.status(500).json({ erro: 'Erro ao atribuir tarefa' });
  }
  if (resposta.outcome === 'in_progress' || resposta.outcome === 'unavailable') {
    res.set('Retry-After', '2');
  }
  return res.status(conhecida.status).json({ erro: conhecida.erro, code: resposta.code });
};

exports.atribuirParaMimIdempotente = async (req, res) => {
  try {
    const tarefaId = req.params.id;
    // Sem banco, antes de reivindicar a chave: ID fora do formato responde 404 (no legado, erro de conversao e 500).
    if (typeof tarefaId !== 'string' || !OBJECT_ID_PATTERN.test(tarefaId)) {
      return res.status(404).json({ erro: MENSAGENS_ATRIBUIR.tarefa_nao_encontrada.erro });
    }
    const usuarioId = String(req.user.id); // so do JWT verificado; nunca do corpo

    const resposta = await obterServicoIdempotenciaTarefa().execute(
      {
        userId: usuarioId,
        key: req.get('Idempotency-Key'),
        method: 'PUT',
        route: ROTA_ATRIBUIR,
        params: { id: tarefaId },
        body: {},
      },
      // Pode rodar mais de uma vez (withTransaction repete em erro transitorio, inclusive WriteConflict com outra
      // atribuicao da mesma tarefa): toda leitura e gravacao usa a session; nada e emitido aqui dentro.
      async (session) => {
        const filtro = await montarFiltroTarefasAcessiveis(req, { _id: tarefaId }, session);
        if (!filtro) {
          throw new IdempotentRequestError(404, 'tarefa_sem_equipes');
        }
        const tarefa = await Tarefa.findOne(filtro).select('equipe createdBy descricao user').session(session);
        if (!tarefa) {
          throw new IdempotentRequestError(404, 'tarefa_nao_encontrada');
        }
        if (tarefa.user) {
          throw new IdempotentRequestError(409, 'tarefa_ja_atribuida');
        }
        const equipe = await Equipe.findById(tarefa.equipe).select('membros createdBy nome').session(session);
        if (!equipe) {
          throw new IdempotentRequestError(400, 'equipe_nao_encontrada');
        }
        if (!equipe.membros.some((membroId) => String(membroId) === usuarioId)) {
          throw new IdempotentRequestError(403, 'fora_da_equipe');
        }

        // Atribuicao condicional: so se a tarefa ainda estiver sem responsavel no momento da gravacao.
        const atribuicao = await Tarefa.updateOne(
          { _id: tarefa._id, equipe: tarefa.equipe, user: null },
          { $set: { user: usuarioId } },
          { session }
        );
        if (!atribuicao || atribuicao.matchedCount !== 1) {
          throw new IdempotentRequestError(409, 'tarefa_ja_atribuida');
        }

        // Com session o log nao engole erro: se falhar, a atribuicao volta junto.
        await logActivity(
          'atualizacao_geral',
          'Tarefa atribuída automaticamente para o colaborador',
          usuarioId,
          tarefa._id,
          { session }
        );

        let notificacoes = [];
        const notificarAdmin = tarefa.createdBy || equipe.createdBy;
        if (notificarAdmin && String(notificarAdmin) !== usuarioId) {
          const usuario = await User.findById(usuarioId).select('nome').session(session);
          notificacoes = await persistNotifications(
            {
              userIds: [notificarAdmin],
              texto: `${usuario?.nome || 'Um colaborador'} pegou a tarefa "${tarefa.descricao}" do backlog`,
              tipo: 'task',
              origemId: tarefa._id,
              metadata: { tarefaId: tarefa._id, acao: 'atribuir_para_mim' },
            },
            { session }
          );
        }

        return {
          statusCode: 200,
          resourceType: 'tarefa',
          resourceId: tarefa._id,
          // So depois do commit e so a desta tentativa (a que entrou); repeticoes da chave nao emitem.
          afterCommit: () => emitNotifications(notificacoes),
        };
      }
    );

    if (resposta.outcome !== 'executed' && resposta.outcome !== 'replayed') {
      return responderAtribuicaoSemRecurso(res, resposta);
    }

    // Revalida o acesso antes de devolver dados e confere que a tarefa continua com quem a assumiu.
    const filtro = await montarFiltroTarefasAcessiveis(req, { _id: tarefaId });
    if (!filtro) {
      return res.status(404).json({ erro: MENSAGENS_ATRIBUIR.tarefa_sem_equipes.erro });
    }
    const tarefaAtualizada = await Tarefa.findOne(filtro).populate('user', 'nome').populate('equipe', 'nome');
    if (!tarefaAtualizada) {
      return res.status(404).json({ erro: MENSAGENS_ATRIBUIR.tarefa_nao_encontrada.erro });
    }
    const responsavelAtual = tarefaAtualizada.user?._id || tarefaAtualizada.user;
    if (String(responsavelAtual || '') !== usuarioId) {
      // A tarefa mudou de responsavel depois (ex.: reatribuida pelo admin): nao confirma uma atribuicao que nao vale mais.
      return res.status(409).json({ erro: MENSAGENS_ATRIBUIR.tarefa_ja_atribuida.erro });
    }
    if (resposta.outcome === 'replayed') {
      res.set('Idempotency-Replayed', 'true');
    }
    return res
      .status(resposta.statusCode)
      .json({ msg: 'Tarefa atribuída com sucesso', tarefa: await assinarAnexosTarefa(tarefaAtualizada) });
  } catch (err) {
    console.error('Erro ao atribuir tarefa (idempotente):', err?.name);
    return res.status(500).json({ erro: 'Erro ao atribuir tarefa' });
  }
};

// Status aceitos, textos dos logs e da notificacao: os mesmos no legado e no caminho com Idempotency-Key.
const STATUS_TAREFA = ['pendente', 'em_andamento', 'concluido'];
const MSG_STATUS_SEM_ACESSO = 'Você não pode editar essa tarefa';
const textoPausaPorStatus = (status, minutos) =>
  `Cronômetro pausado automaticamente pela alteração de status para ${status}. +${minutos} mins`;
const textoLogStatus = (status) => `Status alterado para ${status}`;
const statusLegivel = (status) => {
  if (status === 'em_andamento') return 'em andamento';
  if (status === 'concluido') return 'concluída';
  return status;
};
// Criador da tarefa (ou da equipe), se nao for quem mudou o status.
const destinatarioNotificacaoStatus = (tarefa, usuarioId) => {
  const notificarAdmin = tarefa.createdBy || tarefa.equipe?.createdBy;
  return notificarAdmin && String(notificarAdmin) !== String(usuarioId) ? notificarAdmin : null;
};
const notificacaoStatus = ({ notificarAdmin, nome, tarefa, status }) => ({
  userIds: [notificarAdmin],
  texto: `${nome || 'Um colaborador'} marcou a tarefa "${tarefa.descricao}" como ${statusLegivel(status)}`,
  tipo: 'task',
  origemId: tarefa._id,
  metadata: { tarefaId: tarefa._id, status },
});

// USER: update task status
exports.atualizarStatusUser = async (req, res) => {
  try {
    const { status } = req.body;

    if (!status || !STATUS_TAREFA.includes(status)) {
      return res.status(400).json({ erro: "Status inválido" });
    }

    // Gravacao condicional ao estado lido (responsavel, status e cronometro): se outra escrita mudou a tarefa no
    // meio do caminho, rele, revalida o responsavel e recalcula a pausa. Mudar para outro status que nao
    // em_andamento pausa o cronometro ativo; em_andamento nao inicia.
    const resultado = await executarTransicao({
      userId: req.user.id,
      ler: () => Tarefa.findOne({ _id: req.params.id, user: req.user.id }).populate('equipe', 'createdBy nome'),
      calcular: (tarefaLida, agora) => calcularTransicaoStatus(tarefaLida, status, agora),
    });

    if (resultado.tipo === 'sem_acesso') {
      return res.status(403).json({ erro: MSG_STATUS_SEM_ACESSO });
    }

    // Logs e notificacao so depois da gravacao confirmada, uma vez, com os dados da tentativa que valeu.
    const { tarefa, transicao } = resultado;
    if (transicao.pausa) {
      // Tipo de atividade valido no ActivityLog (o antigo 'cronometro_pausado_por_status' nao existe no enum e o log
      // era descartado em silencio); o texto registra que a pausa foi automatica, pela mudanca de status.
      await logActivity('cronometro_pausado', textoPausaPorStatus(status, transicao.pausa.minutos), req.user.id, tarefa._id);
    }

    await logActivity('atualizacao_status', textoLogStatus(status), req.user.id, tarefa._id);

    const notificarAdmin = destinatarioNotificacaoStatus(tarefa, req.user.id);
    if (notificarAdmin) {
      const usuario = await User.findById(req.user.id).select('nome');
      await notifyUsers(notificacaoStatus({ notificarAdmin, nome: usuario?.nome, tarefa, status }));
    }

    res.json({ msg: 'Status atualizado com sucesso', tarefa: await assinarAnexosTarefa(tarefa) });
  } catch (err) {
    if (responderRecusaTransicao(err, res)) return undefined;
    console.error('Erro ao atualizar status:', err);
    res.status(500).json({ erro: 'Erro ao atualizar status' });
  }
};

// ---------------------------------------------------------------------------------------------------------
// Status protegido por Idempotency-Key (so com o cabecalho; ver middlewares/idempotencyOptIn.js).
// Mesmas regras, textos e mensagens do atualizarStatusUser acima. Na MESMA transacao: leitura da tarefa pelo
// responsavel, gravacao condicional do status (e da pausa automatica), logs, notificacao ao admin e conclusao da
// chave. Socket.IO so depois do commit (afterCommit), uma vez; repeticoes da chave nao gravam nem emitem.
//
// Concorrencia: dentro da transacao nao ha laco proprio de tentativas. Escrita concorrente na tarefa depois do
// inicio da transacao vira WriteConflict (TransientTransactionError) e o withTransaction repete o callback inteiro:
// nova leitura, novo instante, minutos recalculados. matchedCount != 1 (condicao nao casou com o que esta
// transacao leu) nunca vira sucesso: recusa 409, sem nada gravado.

const ROTA_STATUS = '/api/tarefas/:id/status';
const MENSAGENS_STATUS = {
  tarefa_inacessivel: { status: 403, erro: MSG_STATUS_SEM_ACESSO },
  cronometro_inconsistente: { status: 409, erro: MSG_CRONOMETRO_INCONSISTENTE },
  tarefa_alterada: { status: 409, erro: MSG_CONFLITO_TAREFA },
};
const RESPOSTAS_IDEMPOTENCIA_STATUS = {
  invalid: { status: 400, erro: 'Chave de idempotência inválida.' },
  conflict: { status: 422, erro: 'Esta chave de idempotência já foi usada com outro pedido.' },
  in_progress: { status: 409, erro: 'Esta atualização de status ainda está em andamento. Tente novamente em instantes.' },
  unknown: {
    status: 409,
    erro: 'Não foi possível confirmar se o status foi atualizado. Verifique a tarefa antes de tentar de novo.',
  },
  unavailable: { status: 503, erro: 'Serviço temporariamente indisponível.' },
};

// Resposta dos desfechos sem recurso do nucleo (status e cronometro): falha de negocio guardada -> mensagem da rota;
// desfechos da propria idempotencia -> mensagem com o code; qualquer outra coisa -> 500 da rota.
const criarResponderSemRecurso = ({ mensagens, respostas, erroGenerico }) => (res, resposta) => {
  if (resposta.outcome === 'failed') {
    if (resposta.replayed) res.set('Idempotency-Replayed', 'true');
    const conhecida = mensagens[resposta.code];
    if (conhecida && conhecida.status === resposta.statusCode) {
      return res.status(conhecida.status).json({ erro: conhecida.erro });
    }
    return res.status(500).json({ erro: erroGenerico });
  }
  const conhecida = respostas[resposta.outcome];
  if (!conhecida) {
    return res.status(500).json({ erro: erroGenerico });
  }
  if (resposta.outcome === 'in_progress' || resposta.outcome === 'unavailable') {
    res.set('Retry-After', '2');
  }
  return res.status(conhecida.status).json({ erro: conhecida.erro, code: resposta.code });
};

const responderStatusSemRecurso = criarResponderSemRecurso({
  mensagens: MENSAGENS_STATUS,
  respostas: RESPOSTAS_IDEMPOTENCIA_STATUS,
  erroGenerico: 'Erro ao atualizar status',
});

exports.atualizarStatusUserIdempotente = async (req, res) => {
  try {
    // Antes de reivindicar a chave (sem banco): status e ID no formato esperado.
    const { status } = req.body;
    if (!status || !STATUS_TAREFA.includes(status)) {
      return res.status(400).json({ erro: 'Status inválido' });
    }
    const tarefaId = req.params.id;
    if (typeof tarefaId !== 'string' || !OBJECT_ID_PATTERN.test(tarefaId)) {
      return res.status(403).json({ erro: MSG_STATUS_SEM_ACESSO });
    }
    const usuarioId = String(req.user.id); // so do JWT verificado; nunca do corpo

    const resposta = await obterServicoIdempotenciaTarefa().execute(
      {
        userId: usuarioId,
        key: req.get('Idempotency-Key'),
        method: 'PUT',
        route: ROTA_STATUS,
        params: { id: tarefaId },
        body: { status },
      },
      // Pode rodar mais de uma vez (o withTransaction repete em erro transitorio): toda leitura e gravacao usa a
      // session, o instante e tomado a cada execucao e nada e emitido aqui dentro.
      async (session) => {
        const tarefa = await Tarefa.findOne({ _id: tarefaId, user: usuarioId })
          .populate('equipe', 'createdBy nome')
          .session(session);
        if (!tarefa) {
          throw new IdempotentRequestError(403, 'tarefa_inacessivel');
        }
        // Instante desta execucao, tomado DEPOIS da leitura (como no legado): uma consulta demorada nao deixa
        // minutos de fora. Cada repeticao do callback rele e recalcula; nada passa de uma execucao abortada a outra.
        const agora = new Date();

        let transicao;
        try {
          transicao = calcularTransicaoStatus(tarefa, status, agora);
        } catch (err) {
          if (err instanceof TaskTimerInconsistentError) {
            console.warn('Cronômetro inconsistente; operação recusada:', err.motivo, String(err.tarefaId));
            throw new IdempotentRequestError(409, 'cronometro_inconsistente');
          }
          throw err;
        }

        const gravacao = await Tarefa.updateOne(montarCondicao(tarefa, usuarioId), montarUpdate(tarefa, transicao, agora), {
          session,
          timestamps: false,
          runValidators: true,
        });
        if (!gravacao || typeof gravacao.matchedCount !== 'number') {
          throw new Error('Gravacao da tarefa sem confirmacao do banco');
        }
        if (gravacao.matchedCount !== 1) {
          throw new IdempotentRequestError(409, 'tarefa_alterada');
        }

        // Com session os logs nao engolem erro: se algum falhar, a transacao inteira volta.
        if (transicao.pausa) {
          await logActivity('cronometro_pausado', textoPausaPorStatus(status, transicao.pausa.minutos), usuarioId, tarefa._id, {
            session,
          });
        }
        await logActivity('atualizacao_status', textoLogStatus(status), usuarioId, tarefa._id, { session });

        let notificacoes = [];
        const notificarAdmin = destinatarioNotificacaoStatus(tarefa, usuarioId);
        if (notificarAdmin) {
          const usuario = await User.findById(usuarioId).select('nome').session(session);
          notificacoes = await persistNotifications(notificacaoStatus({ notificarAdmin, nome: usuario?.nome, tarefa, status }), {
            session,
          });
        }

        return {
          statusCode: 200,
          resourceType: 'tarefa',
          resourceId: tarefa._id,
          // So depois do commit e so a desta execucao (a que entrou); repeticoes da chave nao emitem.
          afterCommit: () => emitNotifications(notificacoes),
        };
      }
    );

    if (resposta.outcome !== 'executed' && resposta.outcome !== 'replayed') {
      return responderStatusSemRecurso(res, resposta);
    }

    // Resposta com o estado ATUAL, relida agora (a repeticao nunca desfaz mudancas posteriores) e so para quem
    // continua responsavel: reatribuida depois, nao devolve dados da tarefa.
    const tarefaAtual = await Tarefa.findOne({ _id: tarefaId, user: usuarioId }).populate('equipe', 'createdBy nome');
    if (!tarefaAtual) {
      return res.status(403).json({ erro: MSG_STATUS_SEM_ACESSO });
    }
    if (resposta.outcome === 'replayed') {
      res.set('Idempotency-Replayed', 'true');
    }
    return res
      .status(resposta.statusCode)
      .json({ msg: 'Status atualizado com sucesso', tarefa: await assinarAnexosTarefa(tarefaAtual) });
  } catch (err) {
    console.error('Erro ao atualizar status (idempotente):', err?.name);
    return res.status(500).json({ erro: 'Erro ao atualizar status' });
  }
};

// Acoes, mensagens, logs e resposta do cronometro: os mesmos no legado e no caminho com Idempotency-Key.
const ACOES_CRONOMETRO = ['iniciar', 'pausar'];
const MSG_CRONOMETRO_SEM_ACESSO = 'Acesso negado à tarefa';
const MSG_RECUSA_CRONOMETRO = {
  cronometro_ja_ativo: 'Cronômetro já está ativo',
  cronometro_ja_pausado: 'Cronômetro já está pausado',
};
const tipoLogCronometro = (acao) => (acao === 'iniciar' ? 'cronometro_iniciado' : 'cronometro_pausado');
const textoLogCronometro = (acao, transicao) =>
  (acao === 'iniciar' ? 'Cronômetro iniciado' : `Cronômetro pausado. +${transicao.pausa.minutos} mins`);
// Mensagem de sucesso legada ("iniciardo"/"pausardo") mantida de proposito: e o contrato atual.
const respostaCronometro = async (acao, tarefa) => ({
  msg: `Cronômetro ${acao}do com sucesso`,
  tarefa: await assinarAnexosTarefa(tarefa),
  tempoExcedido: tarefa.tempoExcedido,
});

// USER: controlar cronômetro
exports.controlarCronometro = async (req, res) => {
  try {
    const { acao } = req.body; // 'iniciar' ou 'pausar'
    if (!ACOES_CRONOMETRO.includes(acao)) {
      return res.status(400).json({ erro: 'Ação inválida.' });
    }

    // Gravacao condicional ao estado lido: dois inicios (ou duas pausas) sobre o mesmo estado nao passam juntos; o
    // segundo rele, ve o estado novo e recebe o 400 de sempre. O cronometro continua sem exigir status em_andamento.
    const resultado = await executarTransicao({
      userId: req.user.id,
      ler: () => Tarefa.findOne({ _id: req.params.id, user: req.user.id }),
      calcular: (tarefaLida, agora) => {
        const transicao = calcularTransicaoCronometro(tarefaLida, acao, agora);
        return transicao.recusa ? { erro: MSG_RECUSA_CRONOMETRO[transicao.recusa] } : transicao;
      },
    });

    if (resultado.tipo === 'sem_acesso') return res.status(403).json({ erro: MSG_CRONOMETRO_SEM_ACESSO });
    if (resultado.tipo === 'recusada') return res.status(400).json({ erro: resultado.erro });

    // Log so depois da gravacao confirmada, uma vez, com os minutos da tentativa que valeu.
    const { tarefa, transicao } = resultado;
    await logActivity(tipoLogCronometro(acao), textoLogCronometro(acao, transicao), req.user.id, tarefa._id);

    res.json(await respostaCronometro(acao, tarefa));
  } catch (err) {
    if (responderRecusaTransicao(err, res)) return undefined;
    console.error('Erro ao controlar cronômetro:', err);
    res.status(500).json({ erro: 'Erro ao controlar cronômetro' });
  }
};

// ---------------------------------------------------------------------------------------------------------
// Cronometro protegido por Idempotency-Key (so com o cabecalho; ver middlewares/idempotencyOptIn.js).
// Mesmas regras, textos e mensagens do controlarCronometro acima. Na MESMA transacao: leitura da tarefa pelo
// responsavel, gravacao condicional, ActivityLog e conclusao da chave. A rota nao gera notificacao nem Socket.IO.
// Sem laco proprio de tentativas: WriteConflict faz o withTransaction repetir o callback (nova leitura, novo
// instante, minutos recalculados); matchedCount != 1 nunca vira sucesso (409, nada gravado).

const ROTA_CRONOMETRO = '/api/tarefas/:id/cronometro';
const MENSAGENS_CRONOMETRO = {
  cronometro_ja_ativo: { status: 400, erro: MSG_RECUSA_CRONOMETRO.cronometro_ja_ativo },
  cronometro_ja_pausado: { status: 400, erro: MSG_RECUSA_CRONOMETRO.cronometro_ja_pausado },
  tarefa_inacessivel: { status: 403, erro: MSG_CRONOMETRO_SEM_ACESSO },
  cronometro_inconsistente: { status: 409, erro: MSG_CRONOMETRO_INCONSISTENTE },
  tarefa_alterada: { status: 409, erro: MSG_CONFLITO_TAREFA },
};
const responderCronometroSemRecurso = criarResponderSemRecurso({
  mensagens: MENSAGENS_CRONOMETRO,
  respostas: {
    ...RESPOSTAS_IDEMPOTENCIA_STATUS,
    in_progress: { status: 409, erro: 'Esta operação do cronômetro ainda está em andamento. Tente novamente em instantes.' },
    unknown: {
      status: 409,
      erro: 'Não foi possível confirmar se o cronômetro foi atualizado. Verifique a tarefa antes de tentar de novo.',
    },
  },
  erroGenerico: 'Erro ao controlar cronômetro',
});

exports.controlarCronometroIdempotente = async (req, res) => {
  try {
    // Antes de reivindicar a chave (sem banco): acao e ID no formato esperado.
    const { acao } = req.body;
    if (!ACOES_CRONOMETRO.includes(acao)) {
      return res.status(400).json({ erro: 'Ação inválida.' });
    }
    const tarefaId = req.params.id;
    if (typeof tarefaId !== 'string' || !OBJECT_ID_PATTERN.test(tarefaId)) {
      return res.status(403).json({ erro: MSG_CRONOMETRO_SEM_ACESSO });
    }
    const usuarioId = String(req.user.id); // so do JWT verificado; nunca do corpo

    const resposta = await obterServicoIdempotenciaTarefa().execute(
      {
        userId: usuarioId,
        key: req.get('Idempotency-Key'),
        method: 'PUT',
        route: ROTA_CRONOMETRO,
        params: { id: tarefaId },
        body: { acao },
      },
      // Pode rodar mais de uma vez (o withTransaction repete em erro transitorio): toda leitura e gravacao usa a
      // session, o instante e tomado depois da leitura de cada execucao e nada passa de uma execucao a outra.
      async (session) => {
        const tarefa = await Tarefa.findOne({ _id: tarefaId, user: usuarioId }).session(session);
        if (!tarefa) {
          throw new IdempotentRequestError(403, 'tarefa_inacessivel');
        }
        const agora = new Date();

        let transicao;
        try {
          transicao = calcularTransicaoCronometro(tarefa, acao, agora);
        } catch (err) {
          if (err instanceof TaskTimerInconsistentError) {
            console.warn('Cronômetro inconsistente; operação recusada:', err.motivo, String(err.tarefaId));
            throw new IdempotentRequestError(409, 'cronometro_inconsistente');
          }
          throw err;
        }
        if (transicao.recusa) {
          throw new IdempotentRequestError(400, transicao.recusa);
        }

        const gravacao = await Tarefa.updateOne(montarCondicao(tarefa, usuarioId), montarUpdate(tarefa, transicao, agora), {
          session,
          timestamps: false,
          runValidators: true,
        });
        if (!gravacao || typeof gravacao.matchedCount !== 'number') {
          throw new Error('Gravacao da tarefa sem confirmacao do banco');
        }
        if (gravacao.matchedCount !== 1) {
          throw new IdempotentRequestError(409, 'tarefa_alterada');
        }

        // Com session o log nao engole erro: se falhar, a gravacao volta junto.
        await logActivity(tipoLogCronometro(acao), textoLogCronometro(acao, transicao), usuarioId, tarefa._id, { session });

        return { statusCode: 200, resourceType: 'tarefa', resourceId: tarefa._id };
      }
    );

    if (resposta.outcome !== 'executed' && resposta.outcome !== 'replayed') {
      return responderCronometroSemRecurso(res, resposta);
    }

    // Resposta com o estado ATUAL, relida agora (a repeticao nunca refaz nem desfaz nada) e so para quem continua
    // responsavel: reatribuida depois, nao devolve dados da tarefa.
    const tarefaAtual = await Tarefa.findOne({ _id: tarefaId, user: usuarioId });
    if (!tarefaAtual) {
      return res.status(403).json({ erro: MSG_CRONOMETRO_SEM_ACESSO });
    }
    if (resposta.outcome === 'replayed') {
      res.set('Idempotency-Replayed', 'true');
    }
    return res.status(resposta.statusCode).json(await respostaCronometro(acao, tarefaAtual));
  } catch (err) {
    console.error('Erro ao controlar cronômetro (idempotente):', err?.name);
    return res.status(500).json({ erro: 'Erro ao controlar cronômetro' });
  }
};

// ALL: Upload de anexos
// Rota de anexo: confere o acesso antes do Multer, da moderacao e do Storage. Sem acesso e tarefa
// inexistente recebem o mesmo 404. O adicionarAnexo confere de novo antes de gravar.
exports.verificarAcessoAnexo = async (req, res, next) => {
  try {
    // ID malformado viraria CastError (500) no Mongoose: responde como tarefa inexistente.
    const filtro = OBJECT_ID_PATTERN.test(req.params.id)
      ? await montarFiltroTarefasAcessiveis(req, { _id: req.params.id })
      : null;
    const tarefa = filtro ? await Tarefa.findOne(filtro).select('_id') : null;
    if (!tarefa) return res.status(404).json({ erro: 'Tarefa não encontrada' });
    return next();
  } catch (err) {
    console.error('Erro ao verificar acesso ao anexo:', err);
    return res.status(500).json({ erro: 'Erro ao fazer upload de anexo' });
  }
};

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

    // A autoria vem do JWT validado, nunca do corpo da requisicao.
    const novoAnexo = {
      url: filePath,
      nomeOriginal: req.file.originalname,
      mimetype: req.file.mimetype,
      size: req.file.size,
      uploadedBy: req.user.id,
      uploadedAt: new Date(),
    };

    tarefa.anexos.push(novoAnexo);
    await tarefa.save();
    const anexoSalvo = tarefa.anexos[tarefa.anexos.length - 1];

    await logActivity(
      'anexo_adicionado',
      `Arquivo anexado: ${req.file.originalname}`,
      req.user.id,
      tarefa._id
    );

    const anexoObject = typeof anexoSalvo?.toObject === 'function' ? anexoSalvo.toObject() : novoAnexo;
    res.status(201).json({
      msg: 'Anexo adicionado com sucesso',
      anexo: {
        ...anexoObject,
        url: await getSignedUrl(novoAnexo.url),
      }
    });
  } catch (err) {
    console.error('Erro ao fazer upload de anexo para Google Cloud Storage:', err);
    if (err.message.includes('timeout')) {
      return res.status(504).json({ erro: 'Timeout ao conectar com Cloud Storage' });
    }
    res.status(500).json({ erro: 'Erro ao fazer upload de anexo' });
  }
};

const TAREFA_NAO_ENCONTRADA = { erro: 'Tarefa não encontrada' };
const ANEXO_NAO_ENCONTRADO = { erro: 'Anexo não encontrado' };

// Carrega o anexo pela tarefa acessivel a quem pede (sessao ja validada pelo auth). Sem acesso e tarefa
// inexistente recebem o mesmo 404, como no upload.
const carregarAnexoAcessivel = async (req) => {
  const { id, anexoId } = req.params;
  if (!OBJECT_ID_PATTERN.test(id)) return { status: 404, body: TAREFA_NAO_ENCONTRADA };
  if (!OBJECT_ID_PATTERN.test(anexoId)) return { status: 404, body: ANEXO_NAO_ENCONTRADO };

  const filtro = await montarFiltroTarefasAcessiveis(req, { _id: id });
  if (!filtro) return { status: 404, body: TAREFA_NAO_ENCONTRADA };

  const tarefa = await Tarefa.findOne(filtro).select('_id equipe anexos');
  if (!tarefa) return { status: 404, body: TAREFA_NAO_ENCONTRADA };

  const anexo = (tarefa.anexos || []).find((item) => String(item._id) === String(anexoId));
  if (!anexo) return { status: 404, body: ANEXO_NAO_ENCONTRADO };

  return { tarefa, filtro, anexo };
};

// ALL: baixar anexo da tarefa, com o nome original.
exports.baixarAnexo = async (req, res) => {
  try {
    const carregado = await carregarAnexoAcessivel(req);
    if (carregado.status) return res.status(carregado.status).json(carregado.body);
    const { anexo } = carregado;

    // So objetos do bucket gravados no anexo. URL externa ou arquivo local legado nao sao servidos aqui.
    const objectPath = getObjectPath(anexo.url);
    if (!objectPath || objectPath.startsWith('http') || objectPath.startsWith('uploads/')) {
      return res.status(404).json({ erro: 'Arquivo do anexo indisponível para download' });
    }

    const file = bucket.file(objectPath);
    let metadata;
    try {
      const [exists] = await file.exists();
      if (!exists) return res.status(404).json({ erro: 'Arquivo do anexo não encontrado no armazenamento' });
      [metadata] = await file.getMetadata();
    } catch (storageError) {
      console.error('Erro ao consultar anexo no Cloud Storage:', storageError.message);
      return res.status(503).json({ erro: 'Não foi possível acessar o armazenamento agora. Tente novamente em instantes.' });
    }

    res.setHeader('Content-Type', anexo.mimetype || metadata?.contentType || 'application/octet-stream');
    if (metadata?.size) res.setHeader('Content-Length', metadata.size);
    res.setHeader('Content-Disposition', montarContentDisposition(anexo.nomeOriginal));
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');

    file.createReadStream()
      .on('error', (streamError) => {
        console.error('Erro ao ler anexo do Cloud Storage:', streamError.message);
        if (!res.headersSent) {
          res.status(503).json({ erro: 'Não foi possível acessar o armazenamento agora. Tente novamente em instantes.' });
        } else {
          res.destroy(streamError);
        }
      })
      .pipe(res);
  } catch (err) {
    console.error('Erro ao baixar anexo:', err.message);
    if (!res.headersSent) res.status(500).json({ erro: 'Erro ao baixar anexo' });
  }
};

// ALL: remover anexo. Ordem: conferir acesso e autoria -> apagar o objeto (se exclusivo desta tarefa)
// -> retirar o registro com condicao atomica. Se o Storage falhar, nada muda e a pessoa pode repetir;
// se o registro ja tiver sido retirado por outra requisicao, responde 404.
exports.excluirAnexo = async (req, res) => {
  try {
    const carregado = await carregarAnexoAcessivel(req);
    if (carregado.status) return res.status(carregado.status).json(carregado.body);
    const { tarefa, filtro, anexo } = carregado;

    if (!anexo.uploadedBy) {
      return res.status(403).json({
        erro: 'Este anexo foi enviado antes do registro de autoria e não pode ser removido por aqui.',
        codigo: 'anexo_sem_autoria',
      });
    }
    if (String(anexo.uploadedBy) !== String(req.user.id)) {
      return res.status(403).json({
        erro: 'Somente quem enviou o anexo pode removê-lo.',
        codigo: 'anexo_de_outro_usuario',
      });
    }

    // O objeto so e apagado se estiver na pasta desta tarefa e nenhum outro anexo apontar para ele.
    const objectPath = getObjectPath(anexo.url);
    const pastaDaTarefa = `arquivos/${tarefa._id}/`;
    const referencias = await Tarefa.find({ 'anexos.url': anexo.url }).select('anexos._id anexos.url').lean();
    const outrasReferencias = referencias
      .flatMap((item) => item.anexos || [])
      .filter((item) => item.url === anexo.url && String(item._id) !== String(anexo._id)).length;
    const apagarObjeto = Boolean(objectPath)
      && objectPath.startsWith(pastaDaTarefa)
      && !objectPath.includes('..')
      && outrasReferencias === 0;

    if (apagarObjeto) {
      try {
        await bucket.file(objectPath).delete({ ignoreNotFound: true });
      } catch (storageError) {
        console.error('Erro ao remover anexo do Cloud Storage:', storageError.message);
        return res.status(503).json({
          erro: 'Não foi possível remover o arquivo agora. O anexo foi mantido; tente novamente.',
          codigo: 'storage_indisponivel',
        });
      }
    } else {
      console.warn('Anexo removido sem apagar o objeto (fora da pasta da tarefa ou compartilhado):', String(anexo._id));
    }

    // Nao ha transacao entre Storage e MongoDB. Se o registro nao sair depois do objeto apagado, o anexo
    // continua na tarefa (com autoria) e a mesma remocao pode ser repetida: o delete usa ignoreNotFound.
    let resultado;
    try {
      resultado = await Tarefa.updateOne(
        { ...filtro, anexos: { $elemMatch: { _id: anexo._id, uploadedBy: req.user.id } } },
        { $pull: { anexos: { _id: anexo._id, uploadedBy: req.user.id } } }
      );
    } catch (dbError) {
      console.error('Remocao de anexo incompleta (registro mantido):', String(anexo._id), dbError.message);
      return res.status(500).json(apagarObjeto
        ? {
          erro: 'O arquivo foi apagado do armazenamento, mas o anexo não foi retirado da tarefa. Tente remover novamente.',
          codigo: 'remocao_incompleta',
        }
        : { erro: 'Erro ao remover anexo' });
    }
    if (!resultado.modifiedCount) {
      return res.status(404).json(ANEXO_NAO_ENCONTRADO);
    }

    await logActivity('anexo_removido', `Arquivo removido: ${anexo.nomeOriginal}`, req.user.id, tarefa._id);

    return res.json({ msg: 'Anexo removido', anexoId: String(anexo._id), arquivoRemovido: apagarObjeto });
  } catch (err) {
    console.error('Erro ao remover anexo:', err.message);
    return res.status(500).json({ erro: 'Erro ao remover anexo' });
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
