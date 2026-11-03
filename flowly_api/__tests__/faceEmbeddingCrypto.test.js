const config = require('../config/config');
const { encryptEmbeddings, decryptEmbeddings } = require('../utils/faceEmbeddingCrypto');

describe('criptografia de embeddings faciais', () => {
  const originalKey = config.face.embeddingKey;

  afterEach(() => {
    config.face.embeddingKey = originalKey;
  });

  test('cifra com AES-256-GCM e recupera os vetores', () => {
    config.face.embeddingKey = Buffer.alloc(32, 7).toString('base64');
    const embeddings = [[0.1, 0.2, 0.3], [0.4, 0.5, 0.6]];

    const encrypted = encryptEmbeddings(embeddings);

    expect(encrypted.ciphertext).not.toContain('0.1');
    expect(decryptEmbeddings(encrypted)).toEqual(embeddings);
  });

  test('falha fechada quando a chave nao tem 32 bytes', () => {
    config.face.embeddingKey = '';
    expect(() => encryptEmbeddings([[1, 2, 3]])).toThrow('FACE_EMBEDDING_KEY');
  });
});
