const jwt = require('jsonwebtoken');
const config = require('../config/config');
const { getSignedUrl } = require('../services/storage');

const buildUserPayload = async (user) => ({
  id: user._id,
  nome: user.nome,
  tipo: user.tipo,
  fotoPerfil: await getSignedUrl(user.fotoPerfil),
});

const issueAuthToken = (user) =>
  jwt.sign({ id: user._id, tipo: user.tipo, tokenType: 'access' }, config.jwt.secret, {
    expiresIn: config.jwt.expiresIn || '1d',
    issuer: config.jwt.issuer,
    audience: config.jwt.accessAudience,
  });

const issueFaceSessionToken = (userId, purpose) => {
  const expiresIn =
    purpose === 'face_enroll'
      ? config.face.enrollSessionExpiresIn
      : config.face.sessionExpiresIn;

  return jwt.sign(
    { id: userId, purpose, tokenType: 'face-session' },
    config.jwt.faceSecret,
    {
      expiresIn,
      issuer: config.jwt.issuer,
      audience: config.jwt.faceAudience,
    }
  );
};

const invalidFaceSessionError = () => {
  const error = new Error('Sessão de verificação facial inválida ou expirada. Faça login novamente.');
  error.statusCode = 401;
  return error;
};

const verifyFaceSessionToken = (token, expectedPurpose) => {
  let decoded;

  try {
    decoded = jwt.verify(token, config.jwt.faceSecret, {
      issuer: config.jwt.issuer,
      audience: config.jwt.faceAudience,
    });
  } catch (err) {
    // Detalhes da biblioteca JWT nao chegam ao cliente; outro erro segue como falha interna.
    if (err instanceof jwt.JsonWebTokenError) {
      throw invalidFaceSessionError();
    }
    throw err;
  }

  if (
    !decoded?.id ||
    decoded.tokenType !== 'face-session' ||
    decoded.purpose !== expectedPurpose
  ) {
    throw invalidFaceSessionError();
  }

  return decoded;
};

const verifyAuthToken = (token) => {
  const decoded = jwt.verify(token, config.jwt.secret, {
    issuer: config.jwt.issuer,
    audience: config.jwt.accessAudience,
  });

  if (
    !decoded?.id ||
    decoded.tokenType !== 'access' ||
    !['admin', 'user'].includes(decoded.tipo)
  ) {
    const error = new Error('Token de acesso inválido.');
    error.statusCode = 401;
    throw error;
  }

  return decoded;
};

module.exports = {
  buildUserPayload,
  issueAuthToken,
  issueFaceSessionToken,
  verifyFaceSessionToken,
  verifyAuthToken,
};
