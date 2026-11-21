const Tarefa = require('../models/Tarefa');
const User = require('../models/User');
const Equipe = require('../models/Equipe');
const Comment = require('../models/Comment');
const ActivityLog = require('../models/ActivityLog');
const logActivity = require('../utils/activityLogger');
const { notifyUsers, persistNotifications, emitNotifications } = require('../utils/notificationService');
const bucket = require('../services/storage');
const { getSignedUrl } = require('../services/storage');
const { createIdempotencyService, IdempotentRequestError } = require('../services/idempotencyService');
const {
  executarTransicao,
  calcularPausa,
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
      .populate('equipe', 'nome');

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

// USER: update task status
exports.atualizarStatusUser = async (req, res) => {
  try {
    const { status } = req.body;

    if (!status || !["pendente", "em_andamento", "concluido"].includes(status)) {
      return res.status(400).json({ erro: "Status inválido" });
    }

    // Gravacao condicional ao estado lido (responsavel, status e cronometro): se outra escrita mudou a tarefa no
    // meio do caminho, rele, revalida o responsavel e recalcula a pausa. Mudar para outro status que nao
    // em_andamento pausa o cronometro ativo; em_andamento nao inicia.
    const resultado = await executarTransicao({
      userId: req.user.id,
      ler: () => Tarefa.findOne({ _id: req.params.id, user: req.user.id }).populate('equipe', 'createdBy nome'),
      calcular: (tarefaLida, agora) => {
        if (!tarefaLida.cronometroAtivo || status === 'em_andamento') {
          return { set: { status } };
        }
        const pausa = calcularPausa(tarefaLida, agora);
        return { set: { ...pausa.set, status }, unset: ['ultimaAtualizacaoCronometro'], pausa };
      },
    });

    if (resultado.tipo === 'sem_acesso') {
      return res.status(403).json({ erro: 'Você não pode editar essa tarefa' });
    }

    // Logs e notificacao so depois da gravacao confirmada, uma vez, com os dados da tentativa que valeu.
    const { tarefa, transicao } = resultado;
    if (transicao.pausa) {
      // Tipo de atividade valido no ActivityLog (o antigo 'cronometro_pausado_por_status' nao existe no enum e o log
      // era descartado em silencio); o texto registra que a pausa foi automatica, pela mudanca de status.
      await logActivity(
        'cronometro_pausado',
        `Cronômetro pausado automaticamente pela alteração de status para ${status}. +${transicao.pausa.minutos} mins`,
        req.user.id,
        tarefa._id
      );
    }

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
    if (responderRecusaTransicao(err, res)) return undefined;
    console.error('Erro ao atualizar status:', err);
    res.status(500).json({ erro: 'Erro ao atualizar status' });
  }
};

// USER: controlar cronômetro
exports.controlarCronometro = async (req, res) => {
  try {
    const { acao } = req.body; // 'iniciar' ou 'pausar'
    if (acao !== 'iniciar' && acao !== 'pausar') {
      return res.status(400).json({ erro: 'Ação inválida.' });
    }

    // Gravacao condicional ao estado lido: dois inicios (ou duas pausas) sobre o mesmo estado nao passam juntos; o
    // segundo rele, ve o estado novo e recebe o 400 de sempre. O cronometro continua sem exigir status em_andamento.
    const resultado = await executarTransicao({
      userId: req.user.id,
      ler: () => Tarefa.findOne({ _id: req.params.id, user: req.user.id }),
      calcular: (tarefaLida, agora) => {
        if (acao === 'iniciar') {
          if (tarefaLida.cronometroAtivo) return { erro: 'Cronômetro já está ativo' };
          return { set: { cronometroAtivo: true, ultimaAtualizacaoCronometro: agora } };
        }
        if (!tarefaLida.cronometroAtivo) return { erro: 'Cronômetro já está pausado' };
        // Pausa manual: como antes, mantem ultimaAtualizacaoCronometro gravado (so a pausa por status remove).
        const pausa = calcularPausa(tarefaLida, agora);
        return { set: pausa.set, pausa };
      },
    });

    if (resultado.tipo === 'sem_acesso') return res.status(403).json({ erro: 'Acesso negado à tarefa' });
    if (resultado.tipo === 'recusada') return res.status(400).json({ erro: resultado.erro });

    // Log so depois da gravacao confirmada, uma vez, com os minutos da tentativa que valeu.
    const { tarefa, transicao } = resultado;
    if (acao === 'iniciar') {
      await logActivity('cronometro_iniciado', `Cronômetro iniciado`, req.user.id, tarefa._id);
    } else {
      await logActivity('cronometro_pausado', `Cronômetro pausado. +${transicao.pausa.minutos} mins`, req.user.id, tarefa._id);
    }

    res.json({
      msg: `Cronômetro ${acao}do com sucesso`,
      tarefa: await assinarAnexosTarefa(tarefa),
      tempoExcedido: tarefa.tempoExcedido
    });
  } catch (err) {
    if (responderRecusaTransicao(err, res)) return undefined;
    console.error('Erro ao controlar cronômetro:', err);
    res.status(500).json({ erro: 'Erro ao controlar cronômetro' });
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
    res.status(500).json({ erro: 'Erro ao fazer upload de anexo' });
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
