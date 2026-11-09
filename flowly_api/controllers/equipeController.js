const Equipe = require('../models/Equipe');
const User = require('../models/User');
const Message = require('../models/Message'); 
const mongoose = require('mongoose');
const { getSignedUrl } = require('../services/storage');

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

exports.listarEquipes = async (req, res) => {
  try {
    await garantirCriadorComoMembro(req.user.id);
    const equipes = await Equipe.find({ membros: req.user.id }).populate('membros', 'nome email fotoPerfil');
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

    await garantirCriadorComoMembro(req.user.id);

    const membrosArray = Array.isArray(membros) ? membros : [];
    const membrosUnicos = [...new Set(membrosArray.map((id) => String(id).trim()))].filter(Boolean);

    const membrosInvalidos = membrosUnicos.filter((id) => !mongoose.isValidObjectId(id));
    if (membrosInvalidos.length > 0) {
      return res.status(400).json({ erro: 'Existem membros com identificadores inválidos' });
    }

    const equipeAtual = await Equipe.findOne({ _id: req.params.id, membros: req.user.id }).select('createdBy');
    if (!equipeAtual) {
      return res.status(404).json({ erro: 'Equipe não encontrada' });
    }

    const membrosSemCriador = membrosUnicos.filter((id) => String(id) !== String(equipeAtual.createdBy || req.user.id));
    const usuarios = await User.find({ _id: { $in: membrosSemCriador }, tipo: 'user' }).select('_id');
    if (usuarios.length !== membrosSemCriador.length) {
      return res.status(400).json({ erro: 'Alguns membros não são usuarios válidos' });
    }

    const membrosComCriador = [...new Set([...membrosSemCriador, String(equipeAtual.createdBy || req.user.id)])];

    const equipeAtualizada = await Equipe.findByIdAndUpdate(
      req.params.id,
      { nome: formatarNomeEquipe(nome), membros: membrosComCriador },
      { new: true }
    ).populate('membros', 'nome email fotoPerfil');

    if (!equipeAtualizada) {
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
    const equipe = await Equipe.findOne({ _id: req.params.id, membros: req.user.id }).populate("membros", "nome fotoPerfil");
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

    const messages = await Message.find({ equipe: req.params.id })
      .populate('user', 'nome fotoPerfil')
      .sort({ createdAt: 1 });
      
    res.json(await Promise.all(messages.map(assinarFotoUsuarioMensagem)));
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



