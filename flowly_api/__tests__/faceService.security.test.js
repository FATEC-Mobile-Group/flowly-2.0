const config = require('../config/config');
const faceService = require('../services/faceService');

describe('autenticacao do microservico facial', () => {
  const originalSecret = config.face.serviceSecret;
  const originalFetch = global.fetch;

  afterEach(() => {
    config.face.serviceSecret = originalSecret;
    global.fetch = originalFetch;
    jest.clearAllMocks();
  });

  test('recusa chamada quando o segredo interno nao esta configurado', async () => {
    config.face.serviceSecret = '';
    await expect(faceService.extractEmbedding('imagem')).rejects.toMatchObject({
      statusCode: 503,
    });
  });

  test('envia o segredo interno no cabecalho da chamada', async () => {
    config.face.serviceSecret = 'segredo-de-teste';
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: jest.fn().mockResolvedValue({ face_detected: true, embedding: [1] }),
    });

    await faceService.extractEmbedding('imagem');

    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining('/embed'),
      expect.objectContaining({
        headers: expect.objectContaining({
          'X-Flowly-Service-Secret': 'segredo-de-teste',
        }),
      })
    );
  });
});
