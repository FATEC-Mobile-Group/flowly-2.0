const crypto = require('crypto');

const buckets = new Map();

const normalizeEmail = (value) =>
  typeof value === 'string' ? value.trim().toLowerCase() : '';

// O e-mail vem do cliente e pode ter megabytes: na chave fica so um digest de tamanho fixo.
const hashEmail = (value) =>
  crypto.createHash('sha256').update(normalizeEmail(value)).digest('hex');

// O Map segue a ordem de insercao e as janelas tem a mesma duracao, entao as entradas mais
// antigas expiram primeiro. Para na primeira ainda valida, sem percorrer o Map inteiro.
const removeExpiredBuckets = (now) => {
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt > now) {
      break;
    }
    buckets.delete(key);
  }
};

const createRateLimiter = ({ max, windowMs, keyByEmail = false, buildKey }) => (req, res, next) => {
  const now = Date.now();
  removeExpiredBuckets(now);
  const identity = keyByEmail
    ? `${req.ip}:${hashEmail(req.body?.email)}`
    : req.ip;
  const key = buildKey ? buildKey(req) : `${req.baseUrl}${req.path}:${identity}`;
  const current = buckets.get(key);

  if (!current || current.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    res.set('RateLimit-Limit', String(max));
    res.set('RateLimit-Remaining', String(max - 1));
    return next();
  }

  current.count += 1;
  res.set('RateLimit-Limit', String(max));
  res.set('RateLimit-Remaining', String(Math.max(0, max - current.count)));
  res.set('RateLimit-Reset', String(Math.ceil(current.resetAt / 1000)));

  if (current.count > max) {
    return res.status(429).json({
      erro: 'Muitas tentativas. Aguarde alguns minutos e tente novamente.',
    });
  }

  next();
};

const fifteenMinutes = 15 * 60 * 1000;

module.exports = {
  loginLimiter: createRateLimiter({ max: 10, windowMs: fifteenMinutes, keyByEmail: true }),
  registerLimiter: createRateLimiter({ max: 10, windowMs: fifteenMinutes }),
  emailCodeLimiter: createRateLimiter({ max: 5, windowMs: fifteenMinutes, keyByEmail: true }),
  codeValidationLimiter: createRateLimiter({ max: 10, windowMs: fifteenMinutes, keyByEmail: true }),
  // Prova da senha atual com JWT: um contador por conta para todas as rotas. Usar depois do auth.
  sensitivePasswordActionLimiter: createRateLimiter({
    max: 5,
    windowMs: fifteenMinutes,
    buildKey: (req) => `current-password:${req.user.id}`,
  }),
};
