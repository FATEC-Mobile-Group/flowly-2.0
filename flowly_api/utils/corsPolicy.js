const WILDCARD = '*';
const PRODUCTION = 'production';

// CORS_ORIGIN aceita varias origens separadas por virgula.
const parseAllowedOrigins = (corsOrigin) =>
  String(corsOrigin || '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);

// Producao exige ao menos uma origem e nenhum curinga.
const isCorsOriginExplicit = (corsOrigin) => {
  const entries = parseAllowedOrigins(corsOrigin);
  return entries.length > 0 && !entries.includes(WILDCARD);
};

// Politica unica de origem, usada pelo Express e pelo Socket.IO.
// Sem Origin (mobile, servidor a servidor) passa; o curinga so vale fora de producao.
const isOriginAllowed = (origin, corsOrigin, nodeEnv) => {
  if (!origin) return true;

  const entries = parseAllowedOrigins(corsOrigin);
  const explicitOrigins = entries.filter((entry) => entry !== WILDCARD);
  if (explicitOrigins.includes(origin)) return true;

  return entries.includes(WILDCARD) && nodeEnv !== PRODUCTION;
};

module.exports = {
  parseAllowedOrigins,
  isCorsOriginExplicit,
  isOriginAllowed,
};
