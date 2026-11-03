const config = require('../config/config');
const { normalizeFaceError } = require('../utils/faceErrorMessages');

const FACE_SERVICE_TIMEOUT_MS = 120000;

const callFaceService = async (path, body, context = 'default') => {
  if (!config.face.serviceSecret) {
    const error = new Error('FACE_SERVICE_SECRET nao configurado na API.');
    error.statusCode = 503;
    throw error;
  }

  const baseUrl = config.face.serviceUrl.replace(/\/+$/, '');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FACE_SERVICE_TIMEOUT_MS);

  try {
    const response = await fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Flowly-Service-Secret': config.face.serviceSecret,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      const error = new Error(
        normalizeFaceError(data.erro, context) || 'Falha ao comunicar com serviço facial.'
      );
      error.statusCode = response.status >= 400 ? response.status : 502;
      error.details = data;
      throw error;
    }

    return data;
  } catch (err) {
    if (err.name === 'AbortError') {
      const error = new Error('Serviço facial não respondeu a tempo.');
      error.statusCode = 504;
      throw error;
    }

    if (err.statusCode) {
      throw err;
    }

    const error = new Error(
      'Serviço facial indisponível. Verifique se flowly_iot_face está rodando.'
    );
    error.statusCode = 503;
    throw error;
  } finally {
    clearTimeout(timeout);
  }
};

exports.checkHealth = async () => {
  const baseUrl = config.face.serviceUrl.replace(/\/+$/, '');
  const response = await fetch(`${baseUrl}/health`);
  return response.json();
};

exports.extractEmbedding = async (imageBase64, context = 'enroll') => {
  return callFaceService('/embed', { image_base64: imageBase64 }, context);
};

exports.verifyFace = async (referenceEmbedding, imageBase64) => {
  return callFaceService(
    '/verify',
    {
      reference_embedding: referenceEmbedding,
      image_base64: imageBase64,
      threshold: config.face.verifyThreshold,
    },
    'verify'
  );
};

exports.verifyFaceMulti = async (referenceEmbeddings, imageBase64) => {
  return callFaceService(
    '/verify-multi',
    {
      reference_embeddings: referenceEmbeddings,
      image_base64: imageBase64,
      threshold: config.face.verifyThreshold,
    },
    'verify'
  );
};
