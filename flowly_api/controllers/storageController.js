const bucket = require('../services/storage');
const { verifyFileAccessToken } = require('../services/storage');
const path = require('path');

const uploadsRoot = path.resolve(__dirname, '..', 'uploads');

const resolveLocalUpload = (filePath) => {
  const relativePath = filePath.slice('uploads/'.length);
  const absolutePath = path.resolve(uploadsRoot, relativePath);

  if (!absolutePath.startsWith(`${uploadsRoot}${path.sep}`)) {
    throw new Error('Caminho de arquivo local invalido');
  }

  return absolutePath;
};

exports.downloadFile = async (req, res) => {
  try {
    const { encodedPath } = req.params;
    const { token } = req.query;

    if (!token) {
      return res.status(401).json({ erro: 'Token do arquivo nao informado' });
    }

    const filePath = verifyFileAccessToken(token, encodedPath);

    if (filePath.startsWith('uploads/')) {
      const absolutePath = resolveLocalUpload(filePath);
      res.setHeader('Cache-Control', 'private, max-age=300');
      return res.sendFile(absolutePath, (error) => {
        if (!error || res.headersSent) return;
        const status = error.code === 'ENOENT' ? 404 : 500;
        res.status(status).json({
          erro: status === 404 ? 'Arquivo nao encontrado' : 'Erro ao ler arquivo',
        });
      });
    }

    const file = bucket.file(filePath);
    const [exists] = await file.exists();

    if (!exists) {
      return res.status(404).json({ erro: 'Arquivo nao encontrado' });
    }

    const [metadata] = await file.getMetadata();
    if (metadata.contentType) {
      res.setHeader('Content-Type', metadata.contentType);
    }
    if (metadata.size) {
      res.setHeader('Content-Length', metadata.size);
    }
    res.setHeader('Cache-Control', 'private, max-age=300');

    file.createReadStream()
      .on('error', (error) => {
        console.error('Erro ao ler arquivo do bucket:', error);
        if (!res.headersSent) {
          res.status(500).json({ erro: 'Erro ao ler arquivo' });
        } else {
          res.destroy(error);
        }
      })
      .pipe(res);
  } catch (error) {
    console.error('Erro ao validar acesso ao arquivo:', error.message);
    res.status(401).json({ erro: 'Acesso ao arquivo invalido ou expirado' });
  }
};
