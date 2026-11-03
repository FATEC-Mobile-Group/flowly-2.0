const User = require('../models/User');
const FaceProfile = require('../models/FaceProfile');
const argon2 = require('argon2');
const validatePassword = require('../utils/validatePassword.js');
const { enviarCodigoVerificacaoEmail } = require('./emailController');
const {
  buildUserPayload,
  issueAuthToken,
  issueFaceSessionToken,
} = require('../utils/faceAuth');

const CURRENT_TERMS_VERSION = '2026-06-08';
const INVALID_CREDENTIALS_MESSAGE = 'Credenciais inválidas';
const DUMMY_PASSWORD_HASH =
  '$argon2id$v=19$m=65536,t=3,p=4$2JAO6WHH7k+2wbl9rEUa1A$+XbUA9FrGJtcU3dEFgQOQ4E1fhNs8kr5YMpGzF6oVmc';

exports.registrar = async (req, res) => {
  try {
    const { nome, email, senha, termsAccepted, termsVersion } = req.body;

    if (typeof nome !== 'string' || !nome.trim()) {
      return res.status(400).json({ erro: 'Nome e obrigatorio.' });
    }

    if (typeof email !== 'string' || !email.trim()) {
      return res.status(400).json({ erro: 'E-mail e obrigatorio.' });
    }

    const normalizedEmail = email.trim().toLowerCase();

    const passwordValidationResult = validatePassword(senha);

    if (passwordValidationResult !== true) {
      return res.status(400).json({ erro: passwordValidationResult });
    }

    if (termsAccepted !== true) {
      return res.status(400).json({
        erro: 'Para criar a conta, leia e aceite os Termos de Uso e a Política de Privacidade.',
      });
    }

    const hash = await argon2.hash(senha);
    
    const novoUsuario = new User({
      nome: nome.trim(),
      email: normalizedEmail,
      senha: hash,
      // O tipo de uma conta criada pela rota pública nunca é controlado pelo cliente.
      tipo: 'user',
      termsAccepted: true,
      termsAcceptedAt: new Date(),
      termsVersion: termsVersion || CURRENT_TERMS_VERSION,
      termsAcceptedIp: req.ip || req.headers['x-forwarded-for'] || '',
    });
    await novoUsuario.save();

    // Enviar código de verificação por email após registro bem-sucedido
    try {
      await enviarCodigoVerificacaoEmail(normalizedEmail);
    } catch (emailErr) {
      console.warn('Aviso: código de verificação não foi enviado:', emailErr.message);
      // Não falha o registro se o email não for enviado, apenas registra o aviso
    }

    res.status(201).json({ 
      msg: 'Usuário registrado com sucesso! Verifique o e-mail para receber o código de verificação.',
      redirectTo: `/verificar-2fa?email=${encodeURIComponent(normalizedEmail)}`
    });
  } catch (err) {
    res.status(400).json({ erro: 'Erro ao registrar', detalhe: err.message });
  }
};

exports.login = async (req, res) => {
  try {
    const { email, senha } = req.body;

    if (
      typeof email !== 'string' ||
      !email.trim() ||
      typeof senha !== 'string' ||
      !senha
    ) {
      return res.status(400).json({ erro: 'E-mail e senha sao obrigatorios.' });
    }

    const normalizedEmail = email.trim().toLowerCase();
    const user = await User.findOne({ email: normalizedEmail });

    if (!user) {
      await argon2.verify(DUMMY_PASSWORD_HASH, senha);
      return res.status(401).json({ erro: INVALID_CREDENTIALS_MESSAGE });
    }

    const senhaValida = await argon2.verify(user.senha, senha);
    if (!senhaValida) return res.status(401).json({ erro: INVALID_CREDENTIALS_MESSAGE });

    if (user.verificado === false) {
      return res.status(403).json({ 
        erro: 'Usuário não verificado',
        redirectTo: `/verificar-2fa?email=${encodeURIComponent(normalizedEmail)}`
      });
    }

    if (user.tipo === 'admin') {
      return res.json({
        token: issueAuthToken(user),
        user: await buildUserPayload(user),
      });
    }

    const faceProfile = await FaceProfile.findOne({ userId: user._id, enrolled: true });

    if (faceProfile) {
      const faceSessionToken = issueFaceSessionToken(user._id, 'face_verify');
      return res.json({
        requiresFaceVerification: true,
        faceSessionToken,
        user: await buildUserPayload(user),
      });
    }

    if (!user.faceEnrollmentOffered && !user.faceEnrollmentSkipped) {
      user.faceEnrollmentOffered = true;
      await user.save();

      const faceSessionToken = issueFaceSessionToken(user._id, 'face_enroll');
      return res.json({
        requiresFaceEnrollmentOffer: true,
        faceSessionToken,
        user: await buildUserPayload(user),
      });
    }

    const token = issueAuthToken(user);

    res.json({
      token,
      user: await buildUserPayload(user),
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
