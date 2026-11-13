// Sem corpo JSON req.body fica indefinido: campo ausente responde 400, nao TypeError.
const ensureObjectBody = (req, _res, next) => {
  if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
    req.body = {};
  }

  next();
};

module.exports = ensureObjectBody;
