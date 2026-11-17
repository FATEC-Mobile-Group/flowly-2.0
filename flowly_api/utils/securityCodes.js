const crypto = require('crypto');
const config = require('../config/config');

// Codigos de 6 digitos para fluxos sensiveis. O hash e HMAC com segredo do servidor e amarrado ao
// proposito: um dump do banco nao permite testar os 900 mil codigos offline, nem usar um codigo em outro fluxo.

const generateSecurityCode = () => crypto.randomInt(100000, 1000000).toString();

const hashSecurityCode = (purpose, value) =>
  crypto
    .createHmac('sha256', `${config.jwt.secret}:security-code`)
    .update(`${purpose}:${String(value)}`)
    .digest('hex');

const matchesSecurityCode = (purpose, value, expectedHash) => {
  if (typeof value !== 'string' || typeof expectedHash !== 'string' || !/^[a-f\d]{64}$/i.test(expectedHash)) {
    return false;
  }
  const actual = Buffer.from(hashSecurityCode(purpose, value), 'hex');
  const expected = Buffer.from(expectedHash, 'hex');
  return crypto.timingSafeEqual(actual, expected);
};

module.exports = {
  generateSecurityCode,
  hashSecurityCode,
  matchesSecurityCode,
};
