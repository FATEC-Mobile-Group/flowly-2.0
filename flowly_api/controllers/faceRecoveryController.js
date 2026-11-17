const faceRecoveryService = require('../services/faceRecoveryService');

const GENERIC_SEND_MESSAGE =
  'Se a recuperacao facial estiver autorizada para esta conta, um codigo sera enviado ao e-mail cadastrado.';
const SUCCESS_MESSAGE = 'Verificacao facial recadastrada. Entre novamente com e-mail, senha e o novo rosto.';
const RECOVERY_IMAGES = 2;

const isText = (value) => typeof value === 'string' && value.trim().length > 0;

// A resposta e a mesma para qualquer conta: nao revela se existe, se esta autorizada ou se tem rosto.
exports.sendRecoveryCode = async (req, res) => {
  const { email } = req.body;
  if (!isText(email)) {
    return res.status(400).json({ erro: 'E-mail e obrigatorio.' });
  }

  try {
    await faceRecoveryService.sendRecoveryCode(email);
  } catch (err) {
    console.error('Erro ao pedir codigo de recuperacao facial:', err.name);
  }
  return res.json({ msg: GENERIC_SEND_MESSAGE });
};

exports.reenroll = async (req, res) => {
  const { email, codigo, senha, imagesBase64 } = req.body;

  if (!isText(email) || !isText(codigo) || typeof senha !== 'string' || !senha) {
    return res.status(400).json({ erro: 'E-mail, codigo e senha sao obrigatorios.' });
  }
  if (!Array.isArray(imagesBase64) || imagesBase64.length !== RECOVERY_IMAGES || !imagesBase64.every(isText)) {
    return res.status(400).json({ erro: 'Envie as duas fotos do rosto.' });
  }

  try {
    await faceRecoveryService.reenrollWithRecoveryCode({ email, codigo: codigo.trim(), senha, imagesBase64 });
    // Sem token: o titular entra depois pelo login normal, que exige o rosto recadastrado.
    return res.json({ msg: SUCCESS_MESSAGE });
  } catch (err) {
    if (err.code === 'FACE_DUPLICATE') {
      return res.status(409).json({ erro: err.message, codigo: 'FACE_DUPLICATE' });
    }
    if (err.kind) {
      return res.status(err.statusCode).json({ erro: err.message });
    }
    console.error('Erro na recuperacao facial:', err.name);
    return res.status(500).json({ erro: faceRecoveryService.MESSAGES.persistence });
  }
};
