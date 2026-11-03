const { Storage } = require('@google-cloud/storage');
const jwt = require('jsonwebtoken');
const config = require('../config/config');

const storage = new Storage();
const bucket = storage.bucket(process.env.GCP_BUCKET_NAME);

const FILE_ACCESS_TOKEN_EXPIRATION = '5m';

const getObjectPath = (filePath = '') => {
  if (!filePath) return '';

  if (!filePath.startsWith('http')) {
    return filePath.replace(/^\/+/, '');
  }

  try {
    const url = new URL(filePath);
    const pathname = decodeURIComponent(url.pathname.replace(/^\/+/, ''));

    if (url.hostname === 'storage.googleapis.com') {
      const bucketPrefix = `${bucket.name}/`;
      return pathname.startsWith(bucketPrefix)
        ? pathname.slice(bucketPrefix.length)
        : pathname;
    }

    if (url.hostname.endsWith('.storage.googleapis.com')) {
      return pathname;
    }
  } catch (error) {
    console.warn('Nao foi possivel normalizar caminho do arquivo:', error.message);
  }

  return filePath;
};

const getSignedUrl = async (filePath = '') => {
  const objectPath = getObjectPath(filePath);
  if (!objectPath) return '';

  if (objectPath.startsWith('http')) {
    return objectPath;
  }

  const encodedPath = Buffer.from(objectPath, 'utf8').toString('base64url');
  const accessToken = jwt.sign(
    { filePath: objectPath, tokenType: 'storage-file' },
    config.jwt.fileSecret,
    {
      expiresIn: FILE_ACCESS_TOKEN_EXPIRATION,
      issuer: config.jwt.issuer,
      audience: config.jwt.fileAudience,
    },
  );

  return `/api/storage/files/${encodedPath}?token=${accessToken}`;
};

const verifyFileAccessToken = (token = '', encodedPath = '') => {
  const payload = jwt.verify(token, config.jwt.fileSecret, {
    issuer: config.jwt.issuer,
    audience: config.jwt.fileAudience,
  });
  const objectPath = Buffer.from(encodedPath, 'base64url').toString('utf8');

  if (payload.tokenType !== 'storage-file' || payload.filePath !== objectPath) {
    throw new Error('Token de arquivo invalido');
  }

  return objectPath;
};

module.exports = bucket;
module.exports.getObjectPath = getObjectPath;
module.exports.getSignedUrl = getSignedUrl;
module.exports.verifyFileAccessToken = verifyFileAccessToken;
