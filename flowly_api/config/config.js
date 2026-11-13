require('dotenv').config();
const { isCorsOriginExplicit } = require('../utils/corsPolicy');

const jwtSecret = process.env.JWT_SECRET || 'sua_chave_secreta';

const config = {
  port: process.env.PORT_ENV || 5000,
  mongodb: {
    uri: process.env.MONGO_URI || 'mongodb://localhost:27017/Flowly',
  },
  jwt: {
    secret: jwtSecret,
    faceSecret: process.env.JWT_FACE_SECRET || `${jwtSecret}:face-session`,
    fileSecret: process.env.JWT_FILE_SECRET || `${jwtSecret}:storage-file`,
    expiresIn: process.env.JWT_EXPIRES_IN || '7d',
    issuer: process.env.JWT_ISSUER || 'flowly-api',
    accessAudience: process.env.JWT_ACCESS_AUDIENCE || 'flowly-clients',
    faceAudience: process.env.JWT_FACE_AUDIENCE || 'flowly-face',
    fileAudience: process.env.JWT_FILE_AUDIENCE || 'flowly-storage',
  },
  env: process.env.NODE_ENV || 'development',
  // Em producao a API fica atras do proxy do Cloud Run, que acrescenta o IP do cliente ao fim do
  // X-Forwarded-For: com 1 salto confiavel o req.ip e esse endereco. Fora dela nao ha proxy.
  trustProxy: process.env.NODE_ENV === 'production' ? 1 : false,
  corsOrigin: process.env.CORS_ORIGIN || '*',
  bodySizeLimit: process.env.BODY_SIZE_LIMIT || '15mb',
  face: {
    serviceUrl: process.env.FACE_SERVICE_URL || 'http://localhost:5001',
    serviceSecret: process.env.FACE_SERVICE_SECRET || '',
    embeddingKey: process.env.FACE_EMBEDDING_KEY || '',
    matchThreshold: parseFloat(process.env.FACE_MATCH_THRESHOLD || '0.46', 10),
    verifyThreshold: parseFloat(
      process.env.FACE_VERIFY_THRESHOLD || process.env.FACE_MATCH_THRESHOLD || '0.5',
      10
    ),
    duplicateThreshold: parseFloat(
      process.env.FACE_DUPLICATE_THRESHOLD || process.env.FACE_MATCH_THRESHOLD || '0.46',
      10
    ),
    updateSamePersonThreshold: parseFloat(
      process.env.FACE_UPDATE_SAME_PERSON_THRESHOLD ||
        process.env.FACE_VERIFY_THRESHOLD ||
        process.env.FACE_MATCH_THRESHOLD ||
        '0.5',
      10
    ),
    sessionExpiresIn: process.env.FACE_SESSION_EXPIRES_IN || '5m',
    enrollSessionExpiresIn: process.env.FACE_ENROLL_SESSION_EXPIRES_IN || '10m',
  },
};

config.validateRuntime = () => {
  const errors = [];
  if (config.jwt.secret === 'sua_chave_secreta' || config.jwt.secret.length < 32) {
    errors.push('JWT_SECRET deve ter pelo menos 32 caracteres e nao pode usar o valor padrao.');
  }
  if (!isCorsOriginExplicit(config.corsOrigin)) {
    errors.push('CORS_ORIGIN deve listar origens explicitas e nao pode ser curinga em producao.');
  }
  if (!config.face.serviceSecret) {
    errors.push('FACE_SERVICE_SECRET e obrigatorio em producao.');
  }
  if (!config.face.embeddingKey) {
    errors.push('FACE_EMBEDDING_KEY e obrigatoria em producao.');
  }

  if (config.env === 'production' && errors.length) {
    throw new Error(`Configuracao insegura: ${errors.join(' ')}`);
  }

  return errors;
};

module.exports = config;
