const { HTTP_STATUS, ERROR_MESSAGES } = require('../config/constants');
const { verifyAuthToken } = require('../utils/faceAuth');

/**
 * Middleware para autenticação via JWT
 * Verifica se o token é válido e decodifica os dados do usuário
 */
const authMiddleware = (req, res, next) => {
  const authHeader = req.headers.authorization;
  const token = authHeader?.split(' ')[1];

  if (!token) {
    return res.status(HTTP_STATUS.UNAUTHORIZED).json({
      success: false,
      error: ERROR_MESSAGES.TOKEN_NOT_PROVIDED,
    });
  }

  try {
    const decoded = verifyAuthToken(token);
    req.user = decoded; // { id, tipo, email, nome }
    next();
  } catch (err) {
    return res.status(HTTP_STATUS.UNAUTHORIZED).json({
      success: false,
      error: ERROR_MESSAGES.INVALID_TOKEN,
    });
  }
};

module.exports = authMiddleware;
