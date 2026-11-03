const crypto = require('crypto');
const config = require('../config/config');

const getKey = () => {
  const configured = config.face.embeddingKey.trim();
  const key = /^[a-f0-9]{64}$/i.test(configured)
    ? Buffer.from(configured, 'hex')
    : Buffer.from(configured, 'base64');

  if (key.length !== 32) {
    const error = new Error('FACE_EMBEDDING_KEY deve conter exatamente 32 bytes em base64 ou hexadecimal.');
    error.statusCode = 503;
    throw error;
  }

  return key;
};

const encryptEmbeddings = (embeddings) => {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', getKey(), iv);
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(embeddings), 'utf8'),
    cipher.final(),
  ]);

  return {
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    ciphertext: ciphertext.toString('base64'),
  };
};

const decryptEmbeddings = (encrypted) => {
  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    getKey(),
    Buffer.from(encrypted.iv, 'base64')
  );
  decipher.setAuthTag(Buffer.from(encrypted.tag, 'base64'));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(encrypted.ciphertext, 'base64')),
    decipher.final(),
  ]).toString('utf8');

  return JSON.parse(plaintext);
};

module.exports = { encryptEmbeddings, decryptEmbeddings };
