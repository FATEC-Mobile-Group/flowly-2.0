const { HTTP_STATUS, ERROR_MESSAGES } = require('../config/constants');
const { verifyAuthToken } = require('../utils/faceAuth');
const { assertActiveSession } = require('../utils/sessionGuard');

const invalidToken = (res) =>
  res.status(HTTP_STATUS.UNAUTHORIZED).json({
    success: false,
    error: ERROR_MESSAGES.INVALID_TOKEN,
  });

/**
 * Middleware para autenticação via JWT
 * Verifica assinatura e claims e, no banco, se a sessão não foi revogada nem o papel mudou.
 */
const authMiddleware = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  const token = authHeader?.split(' ')[1];

  if (!token) {
    return res.status(HTTP_STATUS.UNAUTHORIZED).json({
      success: false,
      error: ERROR_MESSAGES.TOKEN_NOT_PROVIDED,
    });
  }

  let decoded;
  try {
    decoded = verifyAuthToken(token);
  } catch (err) {
    return invalidToken(res);
  }

  try {
    await assertActiveSession(decoded);
  } catch (err) {
    if (err.statusCode === HTTP_STATUS.UNAUTHORIZED) {
      return invalidToken(res);
    }
    // Banco indisponivel: nao libera a rota e nao encerra a sessao do cliente.
    console.error('Falha ao validar sessao:', err.name);
    return res.status(503).json({ success: false, error: 'Servico temporariamente indisponivel.' });
  }

  req.user = decoded; // { id, tipo, av }
  return next();
};

module.exports = authMiddleware;
