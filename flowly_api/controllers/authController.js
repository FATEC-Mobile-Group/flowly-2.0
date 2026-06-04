const User = require('../models/User');
const argon2 = require('argon2');
const jwt = require('jsonwebtoken');
const config = require('../config/config');
const validatePassword = require('../utils/validatePassword.js');
const { enviarCodigoVerificacaoEmail } = require('./emailController');

exports.registrar = async (req, res) => {
  try {
    const { nome, email, senha, tipo } = req.body;

    const passwordValidationResult = validatePassword(senha);

    if (passwordValidationResult !== true) {
      return res.status(400).json({ erro: passwordValidationResult });
    }

    const hash = await argon2.hash(senha);
    
    const novoUsuario = new User({ nome, email, senha: hash, tipo });
    await novoUsuario.save();

    // Enviar código de verificação por email após registro bem-sucedido
    try {
      await enviarCodigoVerificacaoEmail(email);
    } catch (emailErr) {
      console.warn('Aviso: código de verificação não foi enviado:', emailErr.message);
      // Não falha o registro se o email não for enviado, apenas registra o aviso
    }

    res.status(201).json({ 
      msg: 'Usuário registrado com sucesso! Verifique o e-mail para receber o código de verificação.',
      redirectTo: `/verificar-2fa?email=${encodeURIComponent(email)}`
    });
  } catch (err) {
    res.status(400).json({ erro: 'Erro ao registrar', detalhe: err.message });
  }
};

exports.login = async (req, res) => {
  try {
    const { email, senha } = req.body;
    const user = await User.findOne({ email });

    if (!user) return res.status(404).json({ erro: 'Usuário não encontrado' });

    const senhaValida = await argon2.verify(user.senha, senha);
    if (!senhaValida) return res.status(401).json({ erro: 'Senha inválida' });

    if (user.verificado === false) {
      return res.status(403).json({ 
        erro: 'Usuário não verificado',
        redirectTo: `/verificar-2fa?email=${encodeURIComponent(email)}`
      });
    }

    const token = jwt.sign({ id: user._id, tipo: user.tipo }, config.jwt.secret, { expiresIn: '1d' });

    res.json({
      token,
      user: {
        id: user._id,
        nome: user.nome,
        tipo: user.tipo,
        hasFotoPerfil: Boolean(user.fotoPerfilObjectName || user.fotoPerfil),
      },
    });
    
  } catch (err) {
    res.status(500).json({ erro: 'Erro no login', detalhe: err.message });
  }
};

// NOVO: Listar apenas usuários do tipo 'user'
exports.listarUsers = async (req, res) => {
  try {
    const users = await User.find({ tipo: 'user' }).select('nome email');
    res.json(users);
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao listar usuarios', detalhe: err.message });
  }
};
