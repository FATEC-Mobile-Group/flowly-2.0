const SecurityAuditEvent = require('../models/SecurityAuditEvent');

// So estes campos chegam ao log e ao banco: nada de foto, embedding, senha, token, codigo ou e-mail.
const ALLOWED_FIELDS = ['event', 'outcome', 'reason', 'actor', 'operator', 'userId', 'authorizationId'];

const pickAllowed = (fields) =>
  ALLOWED_FIELDS.reduce((entry, key) => {
    if (fields[key] !== undefined && fields[key] !== null) {
      entry[key] = key === 'userId' || key === 'authorizationId' ? String(fields[key]) : fields[key];
    }
    return entry;
  }, {});

// Nunca lanca: a falha da auditoria e registrada, mas nao muda o resultado da operacao.
const recordSecurityEvent = async (fields) => {
  const entry = pickAllowed(fields);
  console.info(`security_event ${Object.entries(entry).map(([key, value]) => `${key}=${value}`).join(' ')}`);

  try {
    await SecurityAuditEvent.create(entry);
  } catch (err) {
    console.error('Falha ao gravar evento de seguranca:', err.name);
  }
};

module.exports = { recordSecurityEvent };
