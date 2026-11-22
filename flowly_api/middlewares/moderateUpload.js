const { verifyUploadContent } = require('../services/uploadSafetyService');

// Respostas para o cliente: textos fixos por categoria. Nunca repassa excecao, detalhe tecnico
// nem o "reason" de servicos externos.
//   422: o arquivo foi recusado (problema no arquivo ou conteudo proibido). Reenviar igual nao adianta.
//   503: a verificacao obrigatoria nao foi concluida (temporario). O arquivo tambem nao e gravado.
const FILE_PROBLEM_MESSAGES = {
  invalid_file: 'Arquivo vazio ou inválido.',
  invalid_profile_image_type: 'A foto de perfil deve ser uma imagem PNG ou JPG.',
  unsupported_file_type: 'Tipo de arquivo não permitido. Envie PNG, JPG ou PDF.',
  invalid_extension: 'A extensão do arquivo não corresponde ao tipo. Envie PNG, JPG ou PDF.',
  spoofed_file_type: 'O conteúdo do arquivo não corresponde ao tipo informado.',
  unreadable_image: 'Não foi possível ler a imagem. Verifique se o arquivo não está corrompido.',
  file_too_large_for_moderation: 'O arquivo é grande demais para a verificação de segurança. Envie um arquivo menor.',
};
const BLOCKED_CONTENT_MESSAGE = 'O arquivo foi bloqueado porque parece conter conteúdo não permitido na plataforma.';
const UNAVAILABLE_MESSAGE = 'Não foi possível verificar a segurança do arquivo agora. Ele não foi enviado; tente novamente em alguns instantes.';
const RETRY_AFTER_SECONDS = '30';

const sendUnavailable = (res, categories) => {
  if (typeof res.set === 'function') {
    res.set('Retry-After', RETRY_AFTER_SECONDS);
  }
  return res.status(503).json({
    erro: UNAVAILABLE_MESSAGE,
    detalhe: UNAVAILABLE_MESSAGE,
    codigo: 'moderation_unavailable',
    categorias: categories,
  });
};

const moderateUpload = (context) => async (req, res, next) => {
  if (!req.file) {
    return next();
  }

  let result;
  try {
    result = await verifyUploadContent({ file: req.file, context });
  } catch (error) {
    // Falha inesperada: a verificacao nao terminou, entao o upload nao segue.
    console.error('[upload-moderation] Falha inesperada na verificacao:', error?.message);
    return sendUnavailable(res, ['moderation_error']);
  }

  if (result?.allowed === true) {
    req.fileModeration = result;
    return next();
  }

  const categories = Array.isArray(result?.categories) ? result.categories : [];
  if (!result || result.unavailable) {
    return sendUnavailable(res, categories.length ? categories : ['moderation_error']);
  }

  const fileProblem = categories.find((category) => FILE_PROBLEM_MESSAGES[category]);
  const message = fileProblem ? FILE_PROBLEM_MESSAGES[fileProblem] : BLOCKED_CONTENT_MESSAGE;
  return res.status(422).json({
    erro: message,
    detalhe: message,
    codigo: fileProblem ? 'invalid_file' : 'upload_blocked',
    categorias: categories,
    ...(result.provider ? { provider: result.provider } : {}),
  });
};

module.exports = moderateUpload;
