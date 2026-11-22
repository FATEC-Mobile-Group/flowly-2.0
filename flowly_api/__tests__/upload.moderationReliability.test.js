const request = require('supertest');
const mongoose = require('mongoose');

// Etapa 2: conteudo proibido (422) x verificacao indisponivel (503), prazos do Vision e da camada
// externa, respostas sem detalhe interno e nenhum arquivo recusado gravado no Cloud Storage.
// Nada sai da maquina: fetch, Google Auth e Cloud Storage sao simulados; arquivos sao sinteticos.

const mockState = { equipes: [], tarefas: [], users: [] };
const mockSave = jest.fn(async () => {});
const mockFile = jest.fn(() => ({ save: mockSave }));
const mockGetClient = jest.fn();
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
  GoogleAuth: jest.fn().mockImplementation(() => ({ getClient: (...args) => mockGetClient(...args) })),
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
const MODERACAO_EXTERNA = 'https://moderacao.test/api/v1/uploads/moderate';
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32, 1)]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(32, 1)]);
const PDF = Buffer.from('%PDF-1.4\n1 0 obj << >> endobj\n%%EOF');
const SEGURO = { adult: 'VERY_UNLIKELY', racy: 'UNLIKELY', violence: 'VERY_UNLIKELY' };
// Texto "interno" que nenhuma resposta pode repetir.
const INTERNO = 'connect ECONNREFUSED 10.0.0.5:443 token=ya29.segredo /app/services/x.js';
const VAZAMENTO = /ECONNREFUSED|10\.0\.0\.5|ya29|segredo|\/app\/|HTTP \d{3}|Google Vision retornou|sem resposta em|stack|debug/i;

const id = () => new mongoose.Types.ObjectId();
const fetchOriginal = global.fetch;
const envOriginal = { ...process.env };
const mockFetch = jest.fn();

let vision;
let externa;

const chamadas = (url) => mockFetch.mock.calls.filter(([pedido]) => String(pedido).startsWith(url)).length;
const visionResponde = (annotation) => async () => ({ ok: true, status: 200, json: async () => ({ responses: [annotation] }) });
const externaResponde = (body) => async () => ({ ok: true, status: 200, json: async () => body });
// fetch real: nunca responde, mas rejeita quando o signal aborta.
const semResposta = async (_url, opts) => new Promise((_resolve, reject) => {
  opts?.signal?.addEventListener('abort', () => reject(opts.signal.reason || new Error('aborted')));
});

describe('moderacao de upload: confiabilidade e respostas', () => {
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
    delete process.env.UPLOAD_MODERATION_URL;
    delete process.env.UPLOAD_MODERATION_REQUIRED;
    delete process.env.UPLOAD_IMAGE_MODERATION_PROVIDER;
    delete process.env.UPLOAD_IMAGE_MODERATION_REQUIRED;
    delete process.env.UPLOAD_VISION_TIMEOUT_MS;
    delete process.env.UPLOAD_MODERATION_TIMEOUT_MS;

    mockGetClient.mockImplementation(async () => ({ getAccessToken: async () => ({ token: 'token-de-teste' }) }));
    vision = visionResponde({ safeSearchAnnotation: SEGURO });
    externa = externaResponde({ allowed: true, categories: [], provider: 'teste' });
    mockFetch.mockImplementation(async (url, opts) => {
      if (String(url).startsWith(VISION)) return vision(url, opts);
      if (String(url) === MODERACAO_EXTERNA) return externa(url, opts);
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

  const anexar = (arquivo = PNG, nome = 'foto.png', tipo = 'image/png') => request(app)
    .post(`/api/tarefas/${tarefa._id}/anexos`)
    .set('Authorization', `Bearer ${issueAuthToken(user)}`)
    .attach('file', arquivo, { filename: nome, contentType: tipo });
  const trocarFoto = () => request(app)
    .put('/api/users/me')
    .set('Authorization', `Bearer ${issueAuthToken(user)}`)
    .attach('fotoPerfil', PNG, { filename: 'eu.png', contentType: 'image/png' });

  const nadaGravado = () => {
    expect(mockFile).not.toHaveBeenCalled();
    expect(mockSave).not.toHaveBeenCalled();
    expect(tarefa.anexos).toHaveLength(0);
    expect(tarefa.save).not.toHaveBeenCalled();
  };
  const semVazamento = (res) => {
    expect(JSON.stringify(res.body)).not.toMatch(VAZAMENTO);
    expect(res.body).not.toHaveProperty('debug');
    expect(res.body).not.toHaveProperty('stack');
  };
  const indisponivel = (res, categoria) => {
    expect(res.status).toBe(503);
    expect(res.headers['retry-after']).toBe('30');
    expect(res.body).toEqual({
      erro: expect.stringContaining('Não foi possível verificar a segurança do arquivo agora'),
      detalhe: expect.any(String),
      codigo: 'moderation_unavailable',
      categorias: [categoria],
    });
    semVazamento(res);
    nadaGravado();
  };

  describe('imagens legitimas', () => {
    test.each([
      ['PNG', PNG, 'foto.png', 'image/png'],
      ['JPEG', JPEG, 'foto.jpg', 'image/jpeg'],
    ])('%s seguro: 201 e gravado uma vez', async (_tipo, arquivo, nome, mime) => {
      const res = await anexar(arquivo, nome, mime);

      expect(res.status).toBe(201);
      expect(chamadas(VISION)).toBe(1);
      expect(mockSave).toHaveBeenCalledTimes(1);
      expect(tarefa.anexos).toHaveLength(1);
    });

    test('o Vision recebe o signal do prazo', async () => {
      await anexar();

      const [, opcoes] = mockFetch.mock.calls.find(([url]) => String(url).startsWith(VISION));
      expect(opcoes.signal).toBeInstanceOf(AbortSignal);
      expect(opcoes.signal.aborted).toBe(false);
    });

    test('Vision que responde dentro do prazo configurado continua aceito', async () => {
      process.env.UPLOAD_VISION_TIMEOUT_MS = '200';
      const respostaSegura = visionResponde({ safeSearchAnnotation: SEGURO });
      vision = async (...args) => {
        await new Promise((resolve) => setTimeout(resolve, 30));
        return respostaSegura(...args);
      };

      const res = await anexar();

      expect(res.status).toBe(201);
    });
  });

  describe('conteudo proibido: 422 e nada gravado', () => {
    test.each([
      ['adulto', { safeSearchAnnotation: { ...SEGURO, adult: 'VERY_LIKELY' } }, 'explicit_pornography'],
      ['violencia', { safeSearchAnnotation: { ...SEGURO, violence: 'LIKELY' } }, 'violence'],
      ['simbolo de odio', { safeSearchAnnotation: SEGURO, labelAnnotations: [{ description: 'Swastika' }] }, 'hate_symbols'],
    ])('Vision aponta %s', async (_caso, annotation, categoria) => {
      vision = visionResponde(annotation);

      const res = await anexar();

      expect(res.status).toBe(422);
      expect(res.body).toEqual({
        erro: 'O arquivo foi bloqueado porque parece conter conteúdo não permitido na plataforma.',
        detalhe: expect.any(String),
        codigo: 'upload_blocked',
        categorias: [categoria],
        provider: 'google_vision',
      });
      nadaGravado();
    });

    test('foto de perfil proibida: 422 e o perfil nao muda', async () => {
      vision = visionResponde({ safeSearchAnnotation: { ...SEGURO, racy: 'VERY_LIKELY' } });

      const res = await trocarFoto();

      expect(res.status).toBe(422);
      expect(res.body.codigo).toBe('upload_blocked');
      expect(user.save).not.toHaveBeenCalled();
      expect(user.fotoPerfil).toBe('fotos/antiga.png');
      expect(mockSave).not.toHaveBeenCalled();
    });

    test('recusa da camada externa nao repassa o texto dela ao usuario', async () => {
      process.env.UPLOAD_MODERATION_URL = MODERACAO_EXTERNA;
      externa = externaResponde({ allowed: false, categories: ['offensive_content'], reason: INTERNO, provider: 'externo' });

      const res = await anexar(PDF, 'ata.pdf', 'application/pdf');

      expect(res.status).toBe(422);
      expect(res.body.codigo).toBe('upload_blocked');
      semVazamento(res);
      nadaGravado();
    });
  });

  describe('Vision indisponivel (obrigatorio): 503 e nada gravado', () => {
    test('HTTP 500 com detalhe interno no corpo', async () => {
      vision = async () => ({ ok: false, status: 500, text: async () => INTERNO });

      indisponivel(await anexar(), 'visual_moderation_unavailable');
    });

    test('falha de rede', async () => {
      vision = async () => {
        throw new Error(INTERNO);
      };

      indisponivel(await anexar(), 'visual_moderation_unavailable');
    });

    test('Vision sem resposta: estoura o prazo, aborta o fetch e responde 503', async () => {
      process.env.UPLOAD_VISION_TIMEOUT_MS = '50';
      vision = semResposta;

      const inicio = Date.now();
      const res = await anexar();

      indisponivel(res, 'visual_moderation_unavailable');
      expect(Date.now() - inicio).toBeLessThan(5000);
      const [, opcoes] = mockFetch.mock.calls.find(([url]) => String(url).startsWith(VISION));
      expect(opcoes.signal.aborted).toBe(true);
    });

    test('token do Google que nunca chega tambem respeita o prazo', async () => {
      process.env.UPLOAD_VISION_TIMEOUT_MS = '50';
      mockGetClient.mockImplementation(() => new Promise(() => {}));

      indisponivel(await anexar(), 'visual_moderation_unavailable');
      expect(chamadas(VISION)).toBe(0);
    });

    test('depois de um token travado, o proximo upload cria nova autenticacao e funciona', async () => {
      const { GoogleAuth } = require('google-auth-library');
      process.env.UPLOAD_VISION_TIMEOUT_MS = '50';
      mockGetClient.mockImplementationOnce(() => new Promise(() => {}));

      indisponivel(await anexar(), 'visual_moderation_unavailable');
      const instanciasAntes = GoogleAuth.mock.calls.length;

      const res = await anexar();

      expect(res.status).toBe(201);
      expect(GoogleAuth.mock.calls.length).toBe(instanciasAntes + 1);
    });

    test('falha de autenticacao no Google', async () => {
      mockGetClient.mockImplementation(async () => {
        throw new Error(INTERNO);
      });

      indisponivel(await anexar(), 'visual_moderation_unavailable');
    });

    test('200 sem resultado para a imagem nao conta como aprovado', async () => {
      vision = async () => ({ ok: true, status: 200, json: async () => ({ responses: [] }) });

      indisponivel(await anexar(), 'visual_moderation_unavailable');
    });

    test('foto de perfil com Vision fora: 503 e o perfil nao muda', async () => {
      vision = async () => ({ ok: false, status: 503, text: async () => INTERNO });

      const res = await trocarFoto();

      expect(res.status).toBe(503);
      semVazamento(res);
      expect(user.save).not.toHaveBeenCalled();
      expect(user.fotoPerfil).toBe('fotos/antiga.png');
      expect(mockSave).not.toHaveBeenCalled();
    });

    test('UPLOAD_IMAGE_MODERATION_REQUIRED=false mantem o comportamento: segue com as verificacoes locais', async () => {
      process.env.UPLOAD_IMAGE_MODERATION_REQUIRED = 'false';
      process.env.UPLOAD_VISION_TIMEOUT_MS = '50';
      vision = semResposta;

      const res = await anexar();

      expect(res.status).toBe(201);
      expect(mockSave).toHaveBeenCalledTimes(1);
    });
  });

  describe('imagem que o Vision nao consegue ler: 422 (repetir nao resolve)', () => {
    test('erro INVALID_ARGUMENT do Vision vira arquivo invalido, sem a mensagem do Google', async () => {
      vision = visionResponde({ error: { code: 3, message: `Bad image data. ${INTERNO}` } });

      const res = await anexar();

      expect(res.status).toBe(422);
      expect(res.body).toEqual(expect.objectContaining({
        codigo: 'invalid_file',
        categorias: ['unreadable_image'],
        erro: 'Não foi possível ler a imagem. Verifique se o arquivo não está corrompido.',
      }));
      semVazamento(res);
      nadaGravado();
    });

    test('outro erro do Vision para a imagem continua sendo indisponibilidade', async () => {
      vision = visionResponde({ error: { code: 14, message: INTERNO } });

      indisponivel(await anexar(), 'visual_moderation_unavailable');
    });
  });

  describe('camada externa', () => {
    beforeEach(() => {
      process.env.UPLOAD_MODERATION_URL = MODERACAO_EXTERNA;
    });

    const enviarPdf = () => anexar(PDF, 'ata.pdf', 'application/pdf');

    test('obrigatoria e fora do ar: 503', async () => {
      process.env.UPLOAD_MODERATION_REQUIRED = 'true';
      externa = async () => {
        throw new Error(INTERNO);
      };

      indisponivel(await enviarPdf(), 'moderation_unavailable');
    });

    test('obrigatoria e sem resposta: estoura o prazo e responde 503', async () => {
      process.env.UPLOAD_MODERATION_REQUIRED = 'true';
      process.env.UPLOAD_MODERATION_TIMEOUT_MS = '50';
      externa = semResposta;

      indisponivel(await enviarPdf(), 'moderation_unavailable');
    });

    test.each([
      ['corpo sem allowed', externaResponde({ categories: [] })],
      ['corpo que nao e objeto', externaResponde('ok')],
      ['JSON invalido', async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError(INTERNO); } })],
    ])('obrigatoria com %s: 503, nunca aprovacao', async (_caso, resposta) => {
      process.env.UPLOAD_MODERATION_REQUIRED = 'true';
      externa = resposta;

      indisponivel(await enviarPdf(), 'moderation_unavailable');
    });

    test('opcional e fora do ar: segue com as verificacoes locais (comportamento mantido)', async () => {
      externa = semResposta;
      process.env.UPLOAD_MODERATION_TIMEOUT_MS = '50';

      const res = await enviarPdf();

      expect(res.status).toBe(201);
      expect(mockSave).toHaveBeenCalledTimes(1);
    });
  });

  describe('arquivos invalidos: recusados antes do Storage', () => {
    test('PNG declarado com conteudo de PDF: 422 de arquivo invalido, sem Vision', async () => {
      const res = await anexar(PDF, 'foto.png', 'image/png');

      expect(res.status).toBe(422);
      expect(res.body).toEqual(expect.objectContaining({ codigo: 'invalid_file', categorias: ['spoofed_file_type'] }));
      expect(chamadas(VISION)).toBe(0);
      nadaGravado();
    });

    test('nome com termo proibido: 422 de conteudo bloqueado, sem Vision', async () => {
      const res = await anexar(PNG, 'pornografia.png', 'image/png');

      expect(res.status).toBe(422);
      expect(res.body.codigo).toBe('upload_blocked');
      expect(chamadas(VISION)).toBe(0);
      nadaGravado();
    });

    test('tipo nao permitido: 400 do Multer, sem moderacao', async () => {
      const res = await anexar(Buffer.from('GIF89a'), 'anim.gif', 'image/gif');

      expect(res.status).toBe(400);
      expect(chamadas(VISION)).toBe(0);
      nadaGravado();
    });

    test('acima de 10 MB: 413, sem moderacao', async () => {
      const grande = Buffer.concat([PNG, Buffer.alloc(10 * 1024 * 1024, 1)]);

      const res = await anexar(grande, 'grande.png', 'image/png');

      expect(res.status).toBe(413);
      expect(chamadas(VISION)).toBe(0);
      nadaGravado();
    });
  });

  test('sem autorizacao: 401 antes de qualquer verificacao', async () => {
    const res = await request(app)
      .post(`/api/tarefas/${tarefa._id}/anexos`)
      .attach('file', PNG, { filename: 'foto.png', contentType: 'image/png' });

    expect(res.status).toBe(401);
    expect(chamadas(VISION)).toBe(0);
    nadaGravado();
  });
});

describe('moderateUpload: falha inesperada do servico', () => {
  test('excecao vira 503 generico, sem a mensagem interna, e nao chama o proximo passo', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    let moderateUpload;
    jest.isolateModules(() => {
      jest.doMock('../services/uploadSafetyService', () => ({
        verifyUploadContent: jest.fn(async () => {
          throw new TypeError(INTERNO);
        }),
      }));
      moderateUpload = require('../middlewares/moderateUpload');
    });
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn(), set: jest.fn() };
    const next = jest.fn();

    await moderateUpload('task_attachment')({ file: { buffer: PNG } }, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.set).toHaveBeenCalledWith('Retry-After', '30');
    expect(JSON.stringify(res.json.mock.calls[0][0])).not.toMatch(VAZAMENTO);
    expect(res.json.mock.calls[0][0]).toEqual(expect.objectContaining({ codigo: 'moderation_unavailable', categorias: ['moderation_error'] }));
    jest.dontMock('../services/uploadSafetyService');
  });
});
