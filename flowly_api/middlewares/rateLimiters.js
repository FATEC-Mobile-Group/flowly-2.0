const buckets = new Map();

const normalizeEmail = (value) =>
  typeof value === 'string' ? value.trim().toLowerCase() : '';

const createRateLimiter = ({ max, windowMs, keyByEmail = false }) => (req, res, next) => {
  const now = Date.now();
  const identity = keyByEmail
    ? `${req.ip}:${normalizeEmail(req.body?.email)}`
    : req.ip;
  const key = `${req.baseUrl}${req.path}:${identity}`;
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
};
