describe('validacao de configuracao de producao', () => {
  const originalEnv = process.env;

  afterEach(() => {
    process.env = originalEnv;
    jest.resetModules();
  });

  test('recusa segredo padrao e CORS curinga em producao', () => {
    process.env = {
      ...originalEnv,
      NODE_ENV: 'production',
      JWT_SECRET: 'sua_chave_secreta',
      CORS_ORIGIN: '*',
      FACE_SERVICE_SECRET: '',
      FACE_EMBEDDING_KEY: '',
    };
    jest.resetModules();
    const unsafeConfig = require('../config/config');

    expect(() => unsafeConfig.validateRuntime()).toThrow('Configuracao insegura');
  });

  test('aceita configuracao de producao com segredos e origem explicitos', () => {
    process.env = {
      ...originalEnv,
      NODE_ENV: 'production',
      JWT_SECRET: 'a'.repeat(32),
      CORS_ORIGIN: 'https://flowly.example',
      FACE_SERVICE_SECRET: 'segredo-interno',
      FACE_EMBEDDING_KEY: Buffer.alloc(32, 1).toString('base64'),
    };
    jest.resetModules();
    const safeConfig = require('../config/config');

    expect(safeConfig.validateRuntime()).toEqual([]);
  });
});
