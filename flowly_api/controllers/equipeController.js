const Equipe = require('../models/Equipe');
const User = require('../models/User');
const Message = require('../models/Message'); 
const mongoose = require('mongoose');
const { getSignedUrl } = require('../services/storage');
const { createIdempotencyService, IdempotentRequestError } = require('../services/idempotencyService');
const { toPublicMessage } = require('../services/chatAttachmentService');

const MAX_LIMITE_MENSAGENS = 200;
const DATA_ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

// Paginacao opcional do historico. Valores invalidos respondem 400 em vez de virar consulta inesperada.
const lerPaginacaoMensagens = (query = {}) => {
  const pagina = {};
  if (query.limit !== undefined) {
    const limit = Number(query.limit);
    if (typeof query.limit !== 'string' || !/^\d+$/.test(query.limit) || limit < 1 || limit > MAX_LIMITE_MENSAGENS) {
      return { erro: `limit deve ser um inteiro entre 1 e ${MAX_LIMITE_MENSAGENS}.` };
    }
    pagina.limit = limit;
  }
  for (const campo of ['before', 'after']) {
    if (query[campo] === undefined) continue;
    const data = typeof query[campo] === 'string' && DATA_ISO.test(query[campo]) ? new Date(query[campo]) : null;
    if (!data || Number.isNaN(data.getTime())) {
      return { erro: `${campo} deve ser uma data ISO 8601 em UTC (ex.: 2026-11-23T12:00:00.000Z).` };
    }
    pagina[campo] = data;
  }
  return pagina;
};

const assinarFotoUsuarioMensagem = async (message) => {
  const messageObject = typeof message.toObject === 'function' ? message.toObject() : message;

  if (!messageObject.user) {
    return messageObject;
  }

  return {
    ...messageObject,
    user: {
      ...messageObject.user,
      fotoPerfil: await getSignedUrl(messageObject.user.fotoPerfil),
    },
  };
};

const assinarFotosMembrosEquipe = async (equipe) => {
  const equipeObject = typeof equipe.toObject === 'function' ? equipe.toObject() : equipe;

  return {
    ...equipeObject,
    membros: await Promise.all((equipeObject.membros || []).map(async (membro) => {
      const membroObject = typeof membro.toObject === 'function' ? membro.toObject() : membro;

      if (!membroObject || typeof membroObject !== 'object') {
        return membroObject;
      }

      return {
        ...membroObject,
        fotoPerfil: await getSignedUrl(membroObject.fotoPerfil),
      };
    })),
  };
};

const assinarFotosMembrosEquipes = (equipes) => Promise.all(equipes.map(assinarFotosMembrosEquipe));

const formatarNomeEquipe = (nome) => {
  const palavrasPequenas = new Set(['da', 'de', 'do', 'das', 'dos', 'e']);
  return String(nome || '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase()
    .split(' ')
    .map((palavra, index) => (
      index > 0 && palavrasPequenas.has(palavra)
        ? palavra
        : palavra.charAt(0).toUpperCase() + palavra.slice(1)
    ))
    .join(' ');
};

const nomeEquipeValido = (nome) => typeof nome === 'string' && nome.trim() !== '';

// Cada membro precisa ser um id em texto: objeto, lista ou numero nao viram id por conversao.
const listaDeMembrosValida = (membros) =>
  Array.isArray(membros) &&
  membros.every((id) => typeof id === 'string' && mongoose.isValidObjectId(id.trim()));

const garantirCriadorComoMembro = (userId) => Equipe.updateMany(
  { createdBy: userId, membros: { $ne: userId } },
  { $addToSet: { membros: userId } }
);

exports.criarEquipe = async (req, res) => {
  try {
    const { nome, membros } = req.body;

    // Validação do nome da equipe
    if (!nomeEquipeValido(nome)) {
      return res.status(400).json({ erro: "O nome da equipe é obrigatório" });
    }

    // Normaliza membros para IDs únicos e válidos; isso permite o mesmo colaborador em equipes diferentes.
    const membrosArray = Array.isArray(membros) ? membros : [];
    const membrosUnicos = [...new Set(membrosArray.map((id) => String(id).trim()))].filter(Boolean);

    const membrosInvalidos = membrosUnicos.filter((id) => !mongoose.isValidObjectId(id));
    if (membrosInvalidos.length > 0) {
      return res.status(400).json({ erro: 'Existem membros com identificadores inválidos' });
    }

    // Validar se todos os membros são usuarios
    const usuarios = await User.find({ _id: { $in: membrosUnicos }, tipo: 'user' }).select('_id');
    if (usuarios.length !== membrosUnicos.length) {
      return res.status(400).json({ erro: "Alguns membros não são usuarios válidos" });
    }

    const membrosComCriador = [...new Set([...membrosUnicos, String(req.user.id)])];

    // Criar a equipe
    const novaEquipe = new Equipe({ nome: formatarNomeEquipe(nome), membros: membrosComCriador, createdBy: req.user.id });
    await novaEquipe.save();

    // Retornar a equipe criada com os dados populados
    const equipePopulada = await Equipe.findById(novaEquipe._id).populate('membros', 'nome email fotoPerfil');
    res.status(201).json(await assinarFotosMembrosEquipe(equipePopulada));
  } catch (err) {
    console.error('Erro ao criar equipe:', err);
    res.status(500).json({ erro: "Erro ao criar equipe" });
  }
};

// ---------------------------------------------------------------------------------------------------------
// Criacao protegida por Idempotency-Key (so com o cabecalho; ver middlewares/idempotencyOptIn.js).
// Mesmas regras e mensagens do criarEquipe acima; a equipe e gravada na mesma transacao que conclui a chave.
// O registro da chave guarda so status, tipo e ID; a resposta e montada de novo a cada vez (URLs assinadas novas).

const ROTA_CRIAR_EQUIPE = '/api/equipes';
const MENSAGENS_CRIAR_EQUIPE = {
  nome_obrigatorio: 'O nome da equipe é obrigatório',
  membros_invalidos: 'Existem membros com identificadores inválidos',
  membros_nao_usuarios: 'Alguns membros não são usuarios válidos',
};
const RESPOSTAS_IDEMPOTENCIA = {
  invalid: { status: 400, erro: 'Chave de idempotência inválida.' },
  conflict: { status: 422, erro: 'Esta chave de idempotência já foi usada com outro pedido.' },
  in_progress: { status: 409, erro: 'Esta criação ainda está em andamento. Tente novamente em instantes.' },
  unknown: {
    status: 409,
    erro: 'Não foi possível confirmar se a equipe foi criada. Verifique a lista de equipes antes de tentar de novo.',
  },
  unavailable: { status: 503, erro: 'Serviço temporariamente indisponível.' },
};

let servicoIdempotencia;
const obterServicoIdempotencia = () => {
  if (!servicoIdempotencia) {
    servicoIdempotencia = createIdempotencyService();
  }
  return servicoIdempotencia;
};

// Validacao de formato (sem banco), identica a do criarEquipe. Roda antes de reivindicar a chave: um pedido
// malformado responde 400 sem consumir a chave.
const validarFormatoNovaEquipe = ({ nome, membros }) => {
  if (!nomeEquipeValido(nome)) {
    return { codigo: 'nome_obrigatorio' };
  }
  const membrosArray = Array.isArray(membros) ? membros : [];
  const membrosUnicos = [...new Set(membrosArray.map((id) => String(id).trim()))].filter(Boolean);
  if (membrosUnicos.some((id) => !mongoose.isValidObjectId(id))) {
    return { codigo: 'membros_invalidos' };
  }
  return { membrosUnicos };
};

const responderSemEquipe = (res, resposta) => {
  if (resposta.outcome === 'failed') {
    if (resposta.replayed) res.set('Idempotency-Replayed', 'true');
    const mensagem = MENSAGENS_CRIAR_EQUIPE[resposta.code];
    if (mensagem) {
      return res.status(resposta.statusCode).json({ erro: mensagem });
    }
    return res.status(500).json({ erro: 'Erro ao criar equipe' });
  }
  const conhecida = RESPOSTAS_IDEMPOTENCIA[resposta.outcome];
  if (!conhecida) {
    return res.status(500).json({ erro: 'Erro ao criar equipe' });
  }
  if (resposta.outcome === 'in_progress' || resposta.outcome === 'unavailable') {
    res.set('Retry-After', '2');
  }
  return res.status(conhecida.status).json({ erro: conhecida.erro, code: resposta.code });
};

exports.criarEquipeIdempotente = async (req, res) => {
  try {
    const formato = validarFormatoNovaEquipe(req.body);
    if (formato.codigo) {
      return res.status(400).json({ erro: MENSAGENS_CRIAR_EQUIPE[formato.codigo] });
    }
    const usuarioId = String(req.user.id); // so do JWT verificado; nunca do corpo
    const { nome, membros } = req.body;

    const resposta = await obterServicoIdempotencia().execute(
      { userId: usuarioId, key: req.get('Idempotency-Key'), method: 'POST', route: ROTA_CRIAR_EQUIPE, body: { nome, membros } },
      // Pode rodar mais de uma vez (withTransaction repete em erro transitorio): tudo com a session, sem
      // efeito fora da transacao.
      async (session) => {
        const usuarios = await User.find({ _id: { $in: formato.membrosUnicos }, tipo: 'user' })
          .select('_id')
          .session(session);
        if (usuarios.length !== formato.membrosUnicos.length) {
          throw new IdempotentRequestError(400, 'membros_nao_usuarios');
        }
        const membrosComCriador = [...new Set([...formato.membrosUnicos, usuarioId])];
        const novaEquipe = new Equipe({ nome: formatarNomeEquipe(nome), membros: membrosComCriador, createdBy: usuarioId });
        await novaEquipe.save({ session });
        return { statusCode: 201, resourceType: 'equipe', resourceId: novaEquipe._id };
      }
    );

    if (resposta.outcome !== 'executed' && resposta.outcome !== 'replayed') {
      return responderSemEquipe(res, resposta);
    }

    // Revalida o acesso antes de devolver dados: numa repeticao a equipe pode ter mudado ou sido excluida.
    // O papel de admin e a sessao ja foram conferidos pelo auth/isAdmin nesta mesma requisicao.
    const equipe = await Equipe.findOne({
      _id: resposta.result.resourceId,
      $or: [{ membros: usuarioId }, { createdBy: usuarioId }],
    }).populate('membros', 'nome email fotoPerfil');
    if (!equipe) {
      return res.status(404).json({ erro: 'Equipe não encontrada' });
    }
    if (resposta.outcome === 'replayed') {
      res.set('Idempotency-Replayed', 'true');
    }
    return res.status(resposta.statusCode).json(await assinarFotosMembrosEquipe(equipe));
  } catch (err) {
    console.error('Erro ao criar equipe (idempotente):', err?.name);
    return res.status(500).json({ erro: 'Erro ao criar equipe' });
  }
};

exports.listarEquipes = async (req, res) => {
  try {
    await garantirCriadorComoMembro(req.user.id);
    // tipo (aditivo, o mesmo que GET /equipes/:id/membros ja devolve aos membros): permite ao Painel Geral contar
    // colaboradores sem adivinhar quem e administrador.
    const equipes = await Equipe.find({ membros: req.user.id }).populate('membros', 'nome email fotoPerfil tipo');
    res.json(await assinarFotosMembrosEquipes(equipes));
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao listar equipes' });
  }
};

exports.listarMinhasEquipes = async (req, res) => {
  try {
    await garantirCriadorComoMembro(req.user.id);
    const equipes = await Equipe.find({ membros: req.user.id }).populate('membros', 'nome email fotoPerfil');
    res.json(await assinarFotosMembrosEquipes(equipes));
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao listar equipes do usuario' });
  }
};

exports.obterEquipe = async (req, res) => {
  try {
    await garantirCriadorComoMembro(req.user.id);
    const equipe = await Equipe.findOne({ _id: req.params.id, membros: req.user.id }).populate('membros', 'nome email fotoPerfil');
    if (!equipe) return res.status(404).json({ erro: 'Equipe não encontrada' });
    res.json(await assinarFotosMembrosEquipe(equipe));
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao buscar equipe' });
  }
};

exports.editarEquipe = async (req, res) => {
  try {
    const { nome, membros } = req.body;

    // Sem nome valido, a atualizacao abaixo gravaria nome vazio e removeria os membros.
    if (!nomeEquipeValido(nome)) {
      return res.status(400).json({ erro: 'O nome da equipe é obrigatório' });
    }

    // membros ausente preserva a lista atual; [] explicito deixa so o criador.
    const atualizarMembros = membros !== undefined;
    if (atualizarMembros && !listaDeMembrosValida(membros)) {
      return res.status(400).json({ erro: 'Existem membros com identificadores inválidos' });
    }

    await garantirCriadorComoMembro(req.user.id);

    const equipeAtual = await Equipe.findOne({ _id: req.params.id, membros: req.user.id }).select('createdBy membros');
    if (!equipeAtual) {
      return res.status(404).json({ erro: 'Equipe não encontrada' });
    }

    const dadosAtualizacao = { nome: formatarNomeEquipe(nome) };

    if (atualizarMembros) {
      const criadorId = String(equipeAtual.createdBy || req.user.id);
      const membrosAtuais = new Set((equipeAtual.membros || []).map(String));
      const membrosUnicos = [...new Set(membros.map((id) => id.trim()))];
      const membrosSemCriador = membrosUnicos.filter((id) => String(id) !== criadorId);

      // Integrante novo segue a regra de sempre: so usuario comum. Nenhum admin entra por aqui.
      const novos = membrosSemCriador.filter((id) => !membrosAtuais.has(String(id)));
      // Quem ja era membro continua, mesmo promovido a admin depois (services/adminRoleService.js):
      // basta a conta ainda existir. Assim editar o nome ou a lista nao derruba vinculos legitimos.
      const mantidos = membrosSemCriador.filter((id) => membrosAtuais.has(String(id)));

      const [novosValidos, mantidosValidos] = await Promise.all([
        novos.length ? User.find({ _id: { $in: novos }, tipo: 'user' }).select('_id') : [],
        mantidos.length ? User.find({ _id: { $in: mantidos }, tipo: { $in: ['user', 'admin'] } }).select('_id') : [],
      ]);
      if (novosValidos.length !== novos.length || mantidosValidos.length !== mantidos.length) {
        return res.status(400).json({ erro: 'Alguns membros não são usuarios válidos' });
      }

      dadosAtualizacao.membros = [...new Set([...membrosSemCriador, criadorId])];
    }

    // Com lista de membros: grava so se a lista ainda for exatamente a que foi lida e validada acima.
    // Outra edicao no meio do caminho (ex.: retirou um admin) faz esta falhar com 409, em vez de
    // sobrescrever a outra e reintroduzir quem saiu. So o nome continua sem condicao, como antes.
    const equipeAtualizada = atualizarMembros
      ? await Equipe.findOneAndUpdate(
        { _id: req.params.id, membros: Array.from(equipeAtual.membros || []) },
        dadosAtualizacao,
        { new: true }
      ).populate('membros', 'nome email fotoPerfil')
      : await Equipe.findByIdAndUpdate(
        req.params.id,
        dadosAtualizacao,
        { new: true }
      ).populate('membros', 'nome email fotoPerfil');

    if (!equipeAtualizada) {
      if (atualizarMembros && await Equipe.exists({ _id: req.params.id, membros: req.user.id })) {
        return res.status(409).json({
          erro: 'A lista de membros foi alterada por outra edição. Recarregue a equipe e tente novamente.',
        });
      }
      return res.status(404).json({ erro: 'Equipe não encontrada' });
    }

    res.json(await assinarFotosMembrosEquipe(equipeAtualizada));
  } catch (err) {
    console.error('Erro ao editar equipe:', err);
    res.status(500).json({ erro: 'Erro ao editar equipe' });
  }
};


exports.excluirEquipe = async (req, res) => {
  try {
    await garantirCriadorComoMembro(req.user.id);
    const equipe = await Equipe.findOneAndDelete({ _id: req.params.id, membros: req.user.id });
    if (!equipe) return res.status(404).json({ erro: 'Equipe não encontrada' });
    res.json({ msg: 'Equipe excluída com sucesso' });
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao excluir equipe' });
  }
};

exports.getMembrosDaEquipe = async (req, res) => {
  try {
    await garantirCriadorComoMembro(req.user.id);
    // tipo permite aos clientes nao oferecer admin como responsavel de tarefa, que a API rejeita.
    const equipe = await Equipe.findOne({ _id: req.params.id, membros: req.user.id }).populate("membros", "nome fotoPerfil tipo");
    if (!equipe) return res.status(404).json({ erro: "Equipe não encontrada" });
    const equipeAssinada = await assinarFotosMembrosEquipe(equipe);
    res.json(equipeAssinada.membros);
  } catch (err) {
    res.status(500).json({ erro: "Erro ao buscar membros" });
  }
};

exports.getMessages = async (req, res) => {
  try {
    await garantirCriadorComoMembro(req.user.id);
    const equipe = await Equipe.findOne({ _id: req.params.id, membros: req.user.id }).select('_id');
    if (!equipe) return res.status(404).json({ erro: 'Equipe nÃ£o encontrada' });

    // Paginacao opcional (?limit, ?before, ?after em ISO 8601). Sem parametros: historico completo, como antes.
    const pagina = lerPaginacaoMensagens(req.query);
    if (pagina.erro) return res.status(400).json({ erro: pagina.erro });

    const filtro = { equipe: req.params.id };
    if (pagina.before || pagina.after) {
      filtro.createdAt = {
        ...(pagina.before ? { $lt: pagina.before } : {}),
        ...(pagina.after ? { $gt: pagina.after } : {}),
      };
    }

    // Com limite e sem `after`: as N mais recentes (busca decrescente e devolve em ordem cronologica).
    const maisRecentes = Boolean(pagina.limit) && !pagina.after;
    let consulta = Message.find(filtro)
      .populate('user', 'nome fotoPerfil')
      .sort({ createdAt: maisRecentes ? -1 : 1 });
    if (pagina.limit) consulta = consulta.limit(pagina.limit);
    const messages = await consulta;
    const ordenadas = maisRecentes ? [...messages].reverse() : messages;

    // Texto: igual ao de antes. Anexo: visao publica, sem caminho do bucket nem URL assinada.
    const serializadas = await Promise.all(ordenadas.map(assinarFotoUsuarioMensagem));
    res.json(serializadas.map(toPublicMessage));
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao buscar histórico de mensagens' });
  }
};

exports.addNovoUsuario = async (req, res) => {
  try {
    const { equipeId, userId } = req.body;
    const equipe = await Equipe.findById(equipeId);
    if (!equipe) return res.status(404).json({ erro: 'Equipe não encontrada' });

    const usuario = await User.findById(userId);
    if (!usuario) return res.status(404).json({ erro: 'Usuario não encontrado' });

    if (equipe.membros.includes(userId)) {
      return res.status(400).json({ erro: 'Usuario já é membro da equipe' });
    }

    equipe.membros.push(userId);
    await equipe.save();
    notificarEntradaEquipe(usuario.nome, equipe.nome);

    res.status(201).json(equipe);
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao adicionar usuário à equipe' });
  }
};



