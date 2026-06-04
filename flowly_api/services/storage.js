const { Storage } = require('@google-cloud/storage');

const storage = new Storage();
const bucket = storage.bucket(process.env.GCP_BUCKET_NAME);

const signedUrlExpiresMinutes = Number(process.env.GCS_SIGNED_URL_EXPIRES_MINUTES || 15);

const uploadPrivateFile = async (objectName, buffer, { contentType } = {}) => {
  const file = bucket.file(objectName);

  await file.save(buffer, {
    resumable: false,
    metadata: {
      contentType,
      cacheControl: 'private, no-store',
    },
    timeout: 60000,
  });

  return {
    objectName: file.name,
    bucketName: bucket.name,
  };
};

const getSignedReadUrl = async (objectName, { contentType } = {}) => {
  if (!objectName) {
    throw new Error('Nome do objeto GCS nao informado');
  }

  // Fallback caso signedUrlExpiresMinutes não esteja definido globalmente
  const minutes = typeof signedUrlExpiresMinutes !== 'undefined' ? signedUrlExpiresMinutes : DEFAULT_EXPIRES_MINUTES;
  const expiresAt = Date.now() + minutes * 60 * 1000;

  const signedUrlOptions = {
    version: 'v4',
    action: 'read',
    expires: expiresAt,
    //clientEmail: process.env.GCP_CLIENT_EMAIL
  };

  if (contentType) {
    signedUrlOptions.responseType = contentType;
  }

  // O bucket precisa estar inicializado anteriormente no seu arquivo:
  // const { Storage } = require('@google-cloud/storage');
  // const storage = new Storage();
  // const bucket = storage.bucket('nome-do-seu-bucket');
  const [url] = await bucket.file(objectName).getSignedUrl(signedUrlOptions);

  return {
    url,
    expiresAt: new Date(expiresAt).toISOString(),
  };
};

bucket.uploadPrivateFile = uploadPrivateFile;
bucket.getSignedReadUrl = getSignedReadUrl;

module.exports = bucket;
