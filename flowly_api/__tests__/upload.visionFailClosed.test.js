const request = require('supertest');
const mongoose = require('mongoose');

// Fail-closed da moderacao visual: provedor invalido com analise obrigatoria e resposta do Vision sem
// SafeSearch viram 503 sem gravar nada. Vale para anexo de tarefa e foto de perfil.
// Nada sai da maquina: fetch, Google Auth e Cloud Storage sao simulados; arquivos sao sinteticos.

const mockState = { equipes: [], tarefas: [], users: [] };
const mockSave = jest.fn(async () => {});
const mockFile = jest.fn(() => ({ save: mockSave }));
const mockSame = (a, b) => String(a) === String(b);

const mockQuery = (produce) => {
  const query = Promise.resolve().then(produce);
  query.select = () => query;
  return query;
};

jest.mock('@google-cloud/storage', () => ({
  Storage: jest.fn().mockImplementation(() => ({
    bucket: jest.fn().mockReturnValue({ name: 'bucket-de-teste', file: (...args) => mockFile(...args) }),
  })),
}));

jest.mock('google-auth-library', () => ({
  GoogleAuth: jest.fn().mockImplementation(() => ({
    getClient: async () => ({ getAccessToken: async () => ({ token: 'token-de-teste' }) }),
  })),
}));

jest.mock('../utils/activityLogger', () => jest.fn(async () => {}));

jest.mock('../models/Equipe', () => ({
  find: jest.fn(() => mockQuery(() => mockState.equipes.map(({ _id }) => ({ _id })))),
}));

jest.mock('../models/Tarefa', () => ({
  findOne: jest.fn((filter) => mockQuery(() => mockState.tarefas.find((tarefa) => mockSame(tarefa._id, filter._id)) || null)),
}));

jest.mock('../models/User', () => ({
  findById: jest.fn((id) => mockQuery(() => mockState.users.find((user) => mockSame(user._id, id)) || null)),
}));

const { issueAuthToken } = require('../utils/faceAuth');
const app = require('../app');

const VISION = 'https://vision.googleapis.com/v1/images:annotate';
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32, 1)]);
const SEGURO = { adult: 'VERY_UNLIKELY', racy: 'UNLIKELY', violence: 'VERY_UNLIKELY' };
const VAZAMENTO = /provedor|provider|nenhum|SafeSearch|Google|Vision|stack|debug/i;

const id = () => new mongoose.Types.ObjectId();
const fetchOriginal = global.fetch;
const envOriginal = { ...process.env };
const mockFetch = jest.fn();
let annotation;

const chamadasVision = () => mockFetch.mock.calls.filter(([url]) => String(url).startsWith(VISION)).length;

describe('moderacao visual fail-closed', () => {
  let user;
  let tarefa;

  beforeAll(() => {
    global.fetch = mockFetch;
  });

  afterAll(() => {
    global.fetch = fetchOriginal;
    process.env = envOriginal;
  });

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...envOriginal };
    ['UPLOAD_MODERATION_URL', 'UPLOAD_MODERATION_REQUIRED', 'UPLOAD_IMAGE_MODERATION_PROVIDER', 'UPLOAD_IMAGE_MODERATION_REQUIRED']
      .forEach((nome) => delete process.env[nome]);
    annotation = { safeSearchAnnotation: SEGURO };
    mockFetch.mockImplementation(async (url) => {
      if (String(url).startsWith(VISION)) return { ok: true, status: 200, json: async () => ({ responses: [annotation] }) };
      throw new Error(`URL inesperada: ${url}`);
    });
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'log').mockImplementation(() => {});

    user = { _id: id(), nome: 'Ana', email: 'ana@exemplo.com', tipo: 'user', fotoPerfil: 'fotos/antiga.png', save: jest.fn(async () => {}) };
    mockState.users = [user];
    const equipe = { _id: id(), nome: 'Equipe', createdBy: id(), membros: [user._id] };
    mockState.equipes = [equipe];
    tarefa = { _id: id(), equipe: equipe._id, anexos: [], save: jest.fn(async () => {}) };
    mockState.tarefas = [tarefa];
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  const fluxos = {
    'anexo de tarefa': {
      enviar: () => request(app)
        .post(`/api/tarefas/${tarefa._id}/anexos`)
        .set('Authorization', `Bearer ${issueAuthToken(user)}`)
        .attach('file', PNG, { filename: 'foto.png', contentType: 'image/png' }),
      sucesso: 201,
      gravou: () => tarefa.anexos.length === 1 && tarefa.save.mock.calls.length === 1,
      intacto: () => tarefa.anexos.length === 0 && tarefa.save.mock.calls.length === 0,
    },
    'foto de perfil': {
      enviar: () => request(app)
        .put('/api/users/me')
        .set('Authorization', `Bearer ${issueAuthToken(user)}`)
        .attach('fotoPerfil', PNG, { filename: 'eu.png', contentType: 'image/png' }),
      sucesso: 200,
      gravou: () => user.save.mock.calls.length === 1 && user.fotoPerfil !== 'fotos/antiga.png',
      intacto: () => user.save.mock.calls.length === 0 && user.fotoPerfil === 'fotos/antiga.png',
    },
  };

  const recusadoSemGravar = (res, fluxo) => {
    expect(res.status).toBe(503);
    expect(res.headers['retry-after']).toBe('30');
    expect(res.body).toEqual({
      erro: 'Não foi possível verificar a segurança do arquivo agora. Ele não foi enviado; tente novamente em alguns instantes.',
      detalhe: expect.any(String),
      codigo: 'moderation_unavailable',
      categorias: ['visual_moderation_unavailable'],
    });
    expect(JSON.stringify(res.body)).not.toMatch(VAZAMENTO);
    expect(mockFile).not.toHaveBeenCalled();
    expect(mockSave).not.toHaveBeenCalled();
    expect(fluxo.intacto()).toBe(true);
  };

  describe.each(Object.entries(fluxos))('%s', (_nome, fluxo) => {
    test('provedor google_vision e SafeSearch normal: analisa e grava', async () => {
      process.env.UPLOAD_IMAGE_MODERATION_PROVIDER = 'google_vision';
      process.env.UPLOAD_IMAGE_MODERATION_REQUIRED = 'true';

      const res = await fluxo.enviar();

      expect(res.status).toBe(fluxo.sucesso);
      expect(chamadasVision()).toBe(1);
      expect(mockSave).toHaveBeenCalledTimes(1);
      expect(fluxo.gravou()).toBe(true);
    });

    test('provedor com espacos e maiusculas (" Google_Vision ") continua valido', async () => {
      process.env.UPLOAD_IMAGE_MODERATION_PROVIDER = ' Google_Vision ';

      const res = await fluxo.enviar();

      expect(res.status).toBe(fluxo.sucesso);
      expect(chamadasVision()).toBe(1);
    });

    test.each(['nenhum', 'aws_rekognition', 'false'])('provedor invalido "%s" com analise obrigatoria: 503, sem Vision e sem gravar', async (provedor) => {
      process.env.UPLOAD_IMAGE_MODERATION_PROVIDER = provedor;
      process.env.UPLOAD_IMAGE_MODERATION_REQUIRED = 'true';

      const res = await fluxo.enviar();

      recusadoSemGravar(res, fluxo);
      expect(chamadasVision()).toBe(0);
    });

    test('provedor invalido sem REQUIRED definido (padrao obrigatorio): 503', async () => {
      process.env.UPLOAD_IMAGE_MODERATION_PROVIDER = 'nenhum';

      recusadoSemGravar(await fluxo.enviar(), fluxo);
    });

    test('Vision sem safeSearchAnnotation: verificacao incompleta, 503 e nada gravado', async () => {
      annotation = { labelAnnotations: [{ description: 'Dog', score: 0.98 }] };

      recusadoSemGravar(await fluxo.enviar(), fluxo);
      expect(chamadasVision()).toBe(1);
    });

    test.each([
      ['objeto vazio', {}],
      ['safeSearchAnnotation nulo', { safeSearchAnnotation: null }],
      ['safeSearchAnnotation em texto', { safeSearchAnnotation: 'VERY_UNLIKELY' }],
    ])('Vision com %s: 503', async (_caso, resposta) => {
      annotation = resposta;

      recusadoSemGravar(await fluxo.enviar(), fluxo);
    });

    test('SafeSearch normal com adulto alto continua 422 (criterio inalterado)', async () => {
      annotation = { safeSearchAnnotation: { ...SEGURO, adult: 'VERY_LIKELY' } };

      const res = await fluxo.enviar();

      expect(res.status).toBe(422);
      expect(res.body.categorias).toEqual(['explicit_pornography']);
      expect(mockSave).not.toHaveBeenCalled();
      expect(fluxo.intacto()).toBe(true);
    });

    test('REQUIRED=false mantem a opcao explicita: provedor invalido segue com as verificacoes locais', async () => {
      process.env.UPLOAD_IMAGE_MODERATION_PROVIDER = 'nenhum';
      process.env.UPLOAD_IMAGE_MODERATION_REQUIRED = 'false';

      const res = await fluxo.enviar();

      expect(res.status).toBe(fluxo.sucesso);
      expect(chamadasVision()).toBe(0);
    });

    test('REQUIRED=false com resposta sem SafeSearch tambem segue (opcao explicita)', async () => {
      process.env.UPLOAD_IMAGE_MODERATION_REQUIRED = 'false';
      annotation = {};

      const res = await fluxo.enviar();

      expect(res.status).toBe(fluxo.sucesso);
    });
  });
});
