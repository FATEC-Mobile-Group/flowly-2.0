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

  // D04: o CORS e a unica coisa errada, entao a recusa so pode vir dele.
  describe('CORS_ORIGIN', () => {
    const SAFE = {
      JWT_SECRET: 'a'.repeat(32),
      FACE_SERVICE_SECRET: 'segredo-interno',
      FACE_EMBEDDING_KEY: Buffer.alloc(32, 1).toString('base64'),
    };

    const loadConfig = (nodeEnv, corsOrigin) => {
      const next = { ...originalEnv, ...SAFE, NODE_ENV: nodeEnv, CORS_ORIGIN: corsOrigin };
      if (corsOrigin === undefined) delete next.CORS_ORIGIN;
      process.env = next;
      jest.resetModules();
      // Um .env local nao pode devolver o CORS_ORIGIN removido.
      jest.doMock('dotenv', () => ({ config: jest.fn() }));
      return require('../config/config');
    };

    afterEach(() => {
      jest.dontMock('dotenv');
    });

    test.each([
      ['curinga', '*'],
      ['curinga com espacos', ' * '],
      ['curinga ao lado de origem explicita', 'https://flowly.example,*'],
      ['ausente', undefined],
      ['vazio', ''],
      ['so espacos', '   '],
      ['so separadores', ' , '],
    ])('producao recusa CORS_ORIGIN %s apontando o CORS', (_label, corsOrigin) => {
      const config = loadConfig('production', corsOrigin);

      expect(() => config.validateRuntime()).toThrow(/^Configuracao insegura: CORS_ORIGIN [^.]*\.$/);
    });

    test('producao sem CORS_ORIGIN nao libera origem externa', () => {
      const config = loadConfig('production', undefined);
      const { isOriginAllowed } = require('../utils/corsPolicy');

      expect(isOriginAllowed('https://evil.example', config.corsOrigin, config.env)).toBe(false);
    });

    test.each([
      ['uma origem', 'https://flowly.example'],
      ['varias origens com espacos', ' https://flowly.example , https://green-cliff-033f5810f.3.azurestaticapps.net '],
    ])('producao aceita %s', (_label, corsOrigin) => {
      expect(loadConfig('production', corsOrigin).validateRuntime()).toEqual([]);
    });

    test.each([
      ['curinga', '*'],
      ['ausente', undefined],
    ])('desenvolvimento continua iniciando com CORS_ORIGIN %s', (_label, corsOrigin) => {
      const config = loadConfig('development', corsOrigin);
      const { isOriginAllowed } = require('../utils/corsPolicy');

      expect(() => config.validateRuntime()).not.toThrow();
      expect(isOriginAllowed('http://localhost:5173', config.corsOrigin, config.env)).toBe(true);
    });
  });
});
