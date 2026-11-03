const jwt = require('jsonwebtoken');

jest.mock('@google-cloud/storage', () => ({
  Storage: jest.fn().mockImplementation(() => ({
    bucket: jest.fn().mockReturnValue({ file: jest.fn(), name: 'test-bucket' }),
  })),
}));

const config = require('../config/config');
const { getSignedUrl, verifyFileAccessToken } = require('../services/storage');

describe('acesso assinado a arquivos', () => {
  test('arquivo local legado nao recebe mais URL publica', async () => {
    const url = await getSignedUrl('uploads/avatar.png');
    expect(url).toMatch(/^\/api\/storage\/files\//);
    expect(url).toContain('?token=');
  });

  test('token de acesso nao funciona como token de arquivo', () => {
    const encodedPath = Buffer.from('uploads/avatar.png').toString('base64url');
    const accessToken = jwt.sign(
      { filePath: 'uploads/avatar.png', tokenType: 'storage-file' },
      config.jwt.secret,
      { issuer: config.jwt.issuer, audience: config.jwt.accessAudience }
    );

    expect(() => verifyFileAccessToken(accessToken, encodedPath)).toThrow();
  });
});
