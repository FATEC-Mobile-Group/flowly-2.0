const faceService = require('../services/faceService');
const { normalizeFaceError } = require('./faceErrorMessages');

// Uma chamada ao servico facial por foto. Usado pelo cadastro, pela atualizacao e pela recuperacao.
const extractEmbeddingsFromImages = async (imagesBase64, context) => {
  const embeddings = [];

  for (const imageBase64 of imagesBase64) {
    const embedResult = await faceService.extractEmbedding(imageBase64, context);

    if (!embedResult.face_detected || !embedResult.embedding) {
      return {
        ok: false,
        erro: normalizeFaceError(embedResult.erro, context),
      };
    }

    embeddings.push({
      embedding: embedResult.embedding,
      model: embedResult.model,
    });
  }

  return { ok: true, embeddings };
};

module.exports = { extractEmbeddingsFromImages };
