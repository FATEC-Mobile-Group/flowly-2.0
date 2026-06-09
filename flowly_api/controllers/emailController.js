const crypto = require("crypto");
const argon2 = require("argon2");
const Equipe = require("../models/Equipe.js");
const User = require("../models/User.js");
const TwoFactorToken = require("../models/TwoFactorToken.js");
const sendEmail = require("../utils/sendEmail.js");
const validatePassword = require("../utils/validatePassword.js");
const { buildUserPayload, issueAuthToken } = require("../utils/faceAuth.js");

exports.convidarMembro = async (req, res) => {
  try {
    const userId = req.user.id;
    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ erro: "Usuário não logado" });
    const { equipeId } = req.params;

    const equipe = await Equipe.findById(equipeId);
    if (!equipe) {
      return res.status(404).json({ message: "Equipe não encontrada." });
    }

    const codigoEquipe = equipe.code;

    const { email } = req.body;
    if (!email) {
      return res.status(400).json({ message: "Email é obrigatório." });
    }
    
    const convidado = await User.findOne({ email: email });
    if (convidado) {
      const jaMembro = equipe.membros.some(
        (m) => String(m.user) === String(convidado._id)
      );

      if (jaMembro) {
        return res.status(400).json({ message: "Usuário já é membro da equipe." });
      }
      
      try{
        const html = `<!DOCTYPE html><html><head><meta charset="utf-8"/>
        <style>
        body{background:linear-gradient(135deg, #9F7AEA 0%, #6B21A8 50%, #1F1F1F 100%);margin:0;font-family:Arial,sans-serif;color:#2D1B3D}
        .wrap{max-width:600px;margin:24px auto;background:#fff;border:1px solid #8B5CF6;border-radius:12px;overflow:hidden}
        .head{background:linear-gradient(135deg, #8B5CF6 0%, #6D28D9 100%);color:#fff;padding:18px 24px;font-size:20px;font-weight:bold}
        .content{padding:24px}
        .code{display:inline-block;background:#F3E8FF;color:#2D1B3D;border:1px dashed #8B5CF6;border-radius:8px;font-size:24px;letter-spacing:2px;padding:12px 16px}
        a.button{display:inline-block;background:#8B5CF6;color:#fff;text-decoration:none;padding:10px 16px;border-radius:8px}
        </style></head><body>
        <div class="wrap">
          <div class="head">Flowly • Convite de equipe</div>
          <div class="content">
            <p>Você foi convidado para participar da equipe!</p>
            <p>Informe o código abaixo no app para entrar na equipe:</p>
            <div class="code">${codigoEquipe}</div>
            <p style="color:#6B4889;font-size:12px">Este código expira em 24 horas.</p>
          </div>
        </div>
        </body></html>`;
        await sendEmail(email, 'Convite para participar de uma equipe', null, html);
    } catch (err) {
      console.error('Erro ao enviar email de convite:', err.message);
    }

    res.status(200).json({ message: "Convite enviado com sucesso!" });
    } else {
      res.status(404).json({ message: "Usuário com esse email não encontrado." });
    }
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

exports.notificarEntradaEquipe = async (equipeId, emailNovoMembro, nomeEquipe) => {
  try {
    const equipe = await Equipe.findById(equipeId);
    if (!equipe) {
      throw new Error("Equipe não encontrada.");
    }
    const codigoEquipe = equipe.code;
    const nomeEq = nomeEquipe || equipe.nome;
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"/>
    <style>
    body{background:linear-gradient(135deg, #9F7AEA 0%, #6B21A8 50%, #1F1F1F 100%);margin:0;font-family:Arial,sans-serif;color:#2D1B3D}
    .wrap{max-width:600px;margin:24px auto;background:#fff;border:1px solid #8B5CF6;border-radius:12px;overflow:hidden}
    .head{background:linear-gradient(135deg, #8B5CF6 0%, #6D28D9 100%);color:#fff;padding:18px 24px;font-size:20px;font-weight:bold}
    .content{padding:24px}
    .code{display:inline-block;background:#F3E8FF;color:#2D1B3D;border:1px dashed #8B5CF6;border-radius:8px;font-size:24px;letter-spacing:2px;padding:12px 16px}
    a.button{display:inline-block;background:#8B5CF6;color:#fff;text-decoration:none;padding:14px 32px;border-radius:6px;font-weight:600;border:1px solid #8B5CF6;font-size:16px;line-height:1.5}
    </style></head><body>
    <div class="wrap">
      <div class="head">Flowly • Adicionado à equipe</div>
      <div class="content">
        <p>Você foi adicionado à equipe <strong>${nomeEq}</strong>!</p>
        <p>Use o código abaixo no app para acessar a equipe:</p>
        <div class="code">${codigoEquipe}</div>
        <p style="color:#6B4889;font-size:12px">Este código expira em 24 horas.</p>

        <p style="color:#6B4889;margin-top:20px">Caso ainda não possua uma conta, clique no botão abaixo para criar uma.</p>
        <center>
          <a href="${process.env.FRONTEND_URL || 'http://localhost:3000'}/registrar" class="button">Criar Conta</a>
        </center>
        <p style="color:#6B4889;font-size:12px">Se você não solicitou isso, entre em contato com o suporte.</p>
      </div>
    </div>
    </body></html>`;
    
    await sendEmail(emailNovoMembro, 'Você foi adicionado a uma equipe', null, html);
    } catch (err) {
    console.error('Erro ao notificar entrada na equipe:', err.message);
  }
};

/**
 * Função interna para enviar código de verificação
 * Reutilizável em múltiplos contextos (rotas, outros controllers, etc)
 */
const _enviarCodigoVerificacaoEmail = async (email) => {
  if (!email) {
    throw new Error("Email é obrigatório.");
  }

  const user = await User.findOne({ email });
  if (!user) {
    throw new Error("Usuário não encontrado.");
  }

  // Gerar código de 6 dígitos
  const codigo = Math.floor(100000 + Math.random() * 900000).toString();
  
  // Gerar token único para link de confirmação
  const token = crypto.randomBytes(32).toString('hex');

  // Remover tokens antigos do mesmo usuário
  await TwoFactorToken.deleteMany({ userId: user._id, purpose: { $in: ['email_verification', null] } });

  // Criar novo token de verificação
  const twoFactorToken = new TwoFactorToken({
    userId: user._id,
    codigo,
    token,
    purpose: 'email_verification'
  });

  await twoFactorToken.save();

  // URL para confirmação por link (ajuste conforme seu ambiente)
  const baseURL = process.env.FRONTEND_URL || 'http://localhost:3000';
  const linkConfirmacao = `${baseURL}/verificar-2fa?token=${token}`;

  // HTML do email com código e botão
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"/>
  <style>
  body{background:linear-gradient(135deg, #9F7AEA 0%, #6B21A8 50%, #1F1F1F 100%);margin:0;font-family:Arial,sans-serif;color:#2D1B3D}
  .wrap{max-width:600px;margin:24px auto;background:#fff;border:1px solid #8B5CF6;border-radius:12px;overflow:hidden}
  .head{background:linear-gradient(135deg, #8B5CF6 0%, #6D28D9 100%);color:#fff;padding:18px 24px;font-size:20px;font-weight:bold}
  .content{padding:24px}
  .code{display:inline-block;background:#F3E8FF;color:#2D1B3D;border:1px dashed #8B5CF6;border-radius:8px;font-size:28px;letter-spacing:4px;padding:12px 20px;font-weight:bold;margin:20px 0}
  .button{display:inline-block;background:#8B5CF6;color:#fff;text-decoration:none;padding:14px 32px;border-radius:6px;margin-top:20px;font-weight:600;border:1px solid #8B5CF6;font-size:16px;line-height:1.5}
  .divider{border-top:1px solid #E5D4FF;margin:20px 0}
  .footer{color:#6B4889;font-size:12px;text-align:center;margin-top:20px}
  </style></head><body>
  <div class="wrap">
    <div class="head">Flowly • Verificação em Dois Fatores</div>
    <div class="content">
      <p>Olá <strong>${user.nome}</strong>,</p>
      <p>Você solicitou um código de verificação para acessar sua conta. Use o código abaixo:</p>
      <div class="code">${codigo}</div>
      <p style="color:#6B4889;margin:5px 0">Este código expira em 15 minutos.</p>
      
      <div class="divider"></div>
      
      <p>Ou clique no botão abaixo para verificar sua conta automaticamente:</p>
      <center>
        <a href="${linkConfirmacao}" class="button">Verificar Conta</a>
      </center>
      
      <div class="footer">
        <p>Se você não solicitou este código, ignore este email. Sua conta está segura.</p>
      </div>
    </div>
  </div>
  </body></html>`;

  await sendEmail(email, 'Código de Verificação - Flowly', null, html);

  return {
    message: "Código de verificação enviado com sucesso!",
    userId: user._id
  };
};

/**
 * Rota HTTP para enviar código de verificação
 */
exports.enviarCodigoVerificacao = async (req, res) => {
  try {
    const { email } = req.body;
    const result = await _enviarCodigoVerificacaoEmail(email);
    res.status(200).json(result);
  } catch (err) {
    console.error('Erro ao enviar código de verificação:', err.message);
    const statusCode = err.message.includes('não encontrado') ? 404 : 400;
    res.status(statusCode).json({ message: err.message });
  }
};

/**
 * Exportar função interna para uso em outros controllers
 */
exports.enviarCodigoVerificacaoEmail = _enviarCodigoVerificacaoEmail;

exports.validarCodigoVerificacao = async (req, res) => {
  try {
    const { userId, email, codigo } = req.body;

    if ((!userId && !email) || !codigo) {
      return res.status(400).json({ message: "Email ou UserId e código são obrigatórios." });
    }

    let resolvedUserId = userId;
    if (!resolvedUserId && email) {
      const user = await User.findOne({ email });
      if (!user) {
        return res.status(404).json({ message: "Usuário não encontrado." });
      }
      resolvedUserId = user._id;
    }

    const twoFactorToken = await TwoFactorToken.findOne({ 
      userId: resolvedUserId, 
      codigo,
      purpose: { $in: ['email_verification', null] },
      validado: false 
    });

    if (!twoFactorToken) {
      // Incrementar tentativas
      await TwoFactorToken.updateOne(
        { userId: resolvedUserId, purpose: { $in: ['email_verification', null] }, validado: false },
        { $inc: { tentativas: 1 } }
      );
      
      return res.status(401).json({ message: "Código de verificação inválido ou expirado." });
    }

    // Checar limite de tentativas
    if (twoFactorToken.tentativas >= 5) {
      await TwoFactorToken.deleteOne({ _id: twoFactorToken._id });
      return res.status(429).json({ message: "Muitas tentativas. Solicite um novo código." });
    }

    // Marcar como validado
    twoFactorToken.validado = true;
    await twoFactorToken.save();

    const user = await User.findById(resolvedUserId);
    if (user && !user.verificado) {
      user.verificado = true;
      await user.save();
    }

    // Gerar JWT ou sessão aqui
    const token = issueAuthToken(user);
    const userPayload = await buildUserPayload(user);

    res.status(200).json({ 
      message: "Verificação bem-sucedida!",
      token,
      user: userPayload,
      redirect: user.tipo === 'admin' ? '/admin' : '/dashboard',
      userId: resolvedUserId
    });

  } catch (err) {
    console.error('Erro ao validar código:', err.message);
    res.status(500).json({ message: err.message });
  }
};

exports.validarTokenVerificacao = async (req, res) => {
  try {
    const { token } = req.query;

    if (!token) {
      return res.status(400).json({ message: "Token é obrigatório." });
    }

    const twoFactorToken = await TwoFactorToken.findOne({ 
      token,
      purpose: { $in: ['email_verification', null] },
      validado: false 
    });

    if (!twoFactorToken) {
      return res.status(401).json({ message: "Token inválido ou expirado." });
    }

    // Marcar como validado
    twoFactorToken.validado = true;
    await twoFactorToken.save();

    // Gerar JWT ou sessão aqui
    const user = await User.findById(twoFactorToken.userId);
    if (user && user.verificado === false) {
      user.verificado = true;
      await user.save();
    }
    const jwtToken = issueAuthToken(user);
    const userPayload = await buildUserPayload(user);

    res.status(200).json({ 
      message: "Verificação bem-sucedida!",
      token: jwtToken,
      user: userPayload,
      userId: user._id,
      redirect: user.tipo === 'admin' ? '/admin' : '/dashboard'
    });

  } catch (err) {
    console.error('Erro ao validar token:', err.message);
    res.status(500).json({ message: err.message });
  }
};

const _enviarCodigoRecuperacaoSenha = async (email) => {
  if (!email) {
    throw new Error("Email e obrigatorio.");
  }

  const user = await User.findOne({ email });
  if (!user) {
    throw new Error("Usuario nao encontrado.");
  }

  const codigo = Math.floor(100000 + Math.random() * 900000).toString();
  const token = crypto.randomBytes(32).toString('hex');

  await TwoFactorToken.deleteMany({ userId: user._id, purpose: 'password_reset' });

  await new TwoFactorToken({
    userId: user._id,
    codigo,
    token,
    purpose: 'password_reset'
  }).save();

  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"/>
  <style>
  body{background:linear-gradient(135deg, #9F7AEA 0%, #6B21A8 50%, #1F1F1F 100%);margin:0;font-family:Arial,sans-serif;color:#2D1B3D}
  .wrap{max-width:600px;margin:24px auto;background:#fff;border:1px solid #8B5CF6;border-radius:12px;overflow:hidden}
  .head{background:linear-gradient(135deg, #8B5CF6 0%, #6D28D9 100%);color:#fff;padding:18px 24px;font-size:20px;font-weight:bold}
  .content{padding:24px}
  .code{display:inline-block;background:#F3E8FF;color:#2D1B3D;border:1px dashed #8B5CF6;border-radius:8px;font-size:28px;letter-spacing:4px;padding:12px 20px;font-weight:bold;margin:20px 0}
  .footer{color:#6B4889;font-size:12px;text-align:center;margin-top:20px}
  </style></head><body>
  <div class="wrap">
    <div class="head">Flowly - Recuperacao de senha</div>
    <div class="content">
      <p>Ola <strong>${user.nome}</strong>,</p>
      <p>Use o codigo abaixo para redefinir sua senha no Flowly:</p>
      <div class="code">${codigo}</div>
      <p style="color:#6B4889;margin:5px 0">Este codigo expira em 15 minutos.</p>
      <div class="footer">
        <p>Se voce nao solicitou a recuperacao de senha, ignore este email.</p>
      </div>
    </div>
  </div>
  </body></html>`;

  await sendEmail(email, 'Recuperacao de senha - Flowly', null, html);

  return {
    message: "Codigo de recuperacao enviado com sucesso!",
    userId: user._id
  };
};

exports.enviarCodigoRecuperacaoSenha = async (req, res) => {
  try {
    const { email } = req.body;
    const result = await _enviarCodigoRecuperacaoSenha(email);
    res.status(200).json(result);
  } catch (err) {
    console.error('Erro ao enviar codigo de recuperacao:', err.message);
    const statusCode = err.message.includes('nao encontrado') ? 404 : 400;
    res.status(statusCode).json({ message: err.message });
  }
};

exports.validarCodigoRecuperacaoSenha = async (req, res) => {
  try {
    const { email, codigo } = req.body;

    if (!email || !codigo) {
      return res.status(400).json({ message: "Email e codigo sao obrigatorios." });
    }

    const user = await User.findOne({ email });
    if (!user) {
      return res.status(404).json({ message: "Usuario nao encontrado." });
    }

    const resetToken = await TwoFactorToken.findOne({
      userId: user._id,
      codigo,
      purpose: 'password_reset',
      validado: false
    });

    if (!resetToken) {
      await TwoFactorToken.updateOne(
        { userId: user._id, purpose: 'password_reset', validado: false },
        { $inc: { tentativas: 1 } }
      );

      return res.status(401).json({ message: "Codigo de recuperacao invalido ou expirado." });
    }

    if (resetToken.tentativas >= 5) {
      await TwoFactorToken.deleteOne({ _id: resetToken._id });
      return res.status(429).json({ message: "Muitas tentativas. Solicite um novo codigo." });
    }

    resetToken.validado = true;
    await resetToken.save();

    res.status(200).json({ message: "Codigo validado com sucesso. Informe sua nova senha." });
  } catch (err) {
    console.error('Erro ao validar codigo de recuperacao:', err.message);
    res.status(500).json({ message: err.message });
  }
};

exports.redefinirSenhaComCodigo = async (req, res) => {
  try {
    const { email, codigo, novaSenha } = req.body;

    if (!email || !codigo || !novaSenha) {
      return res.status(400).json({ message: "Email, codigo e nova senha sao obrigatorios." });
    }

    const passwordValidationResult = validatePassword(novaSenha);
    if (passwordValidationResult !== true) {
      return res.status(400).json({ message: passwordValidationResult });
    }

    const user = await User.findOne({ email });
    if (!user) {
      return res.status(404).json({ message: "Usuario nao encontrado." });
    }

    const resetToken = await TwoFactorToken.findOne({
      userId: user._id,
      codigo,
      purpose: 'password_reset',
      validado: true
    });

    if (!resetToken) {
      return res.status(401).json({ message: "Valide o codigo de recuperacao antes de redefinir a senha." });
    }

    user.senha = await argon2.hash(novaSenha);
    await user.save();
    await TwoFactorToken.deleteMany({ userId: user._id, purpose: 'password_reset' });

    res.status(200).json({ message: "Senha redefinida com sucesso. Faca login com a nova senha." });
  } catch (err) {
    console.error('Erro ao redefinir senha:', err.message);
    res.status(500).json({ message: err.message });
  }
};
