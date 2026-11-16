const casos = require('./fixtures/upload-moderation-cases.json');

// Falsos positivos da moderacao de upload: termos procurados como trecho de outras palavras
// ("sexta", "episodio", "Gorete") e descricoes do Vision concatenadas. Nada sai da maquina:
// fetch e Google Auth sao simulados.

jest.mock('google-auth-library', () => ({
  GoogleAuth: jest.fn().mockImplementation(() => ({
    getClient: async () => ({ getAccessToken: async () => ({ token: 'token-de-teste' }) }),
  })),
}));

const { verifyUploadContent, MODERATION_TERMS } = require('../services/uploadSafetyService');
const moderateUpload = require('../middlewares/moderateUpload');

const VISION = 'https://vision.googleapis.com/v1/images:annotate';
const MODERACAO_EXTERNA = 'https://moderacao.test/api/v1/uploads/moderate';
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32, 1)]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(32, 1)]);
const pdf = (texto = 'ata') =>
  Buffer.from(`%PDF-1.4\n1 0 obj << /Length 44 >> stream\nBT (${texto}) Tj ET\nendstream endobj\n%%EOF`, 'latin1');
const arquivo = (originalname, mimetype, buffer) => ({ originalname, mimetype, buffer, size: buffer.length });

const SEGURO = { adult: 'VERY_UNLIKELY', racy: 'UNLIKELY', violence: 'VERY_UNLIKELY' };

const fetchOriginal = global.fetch;
const envOriginal = { ...process.env };
const mockFetch = jest.fn();
let anotacaoVision;
let respostaExterna;

const chamadas = (url) => mockFetch.mock.calls.filter(([pedido]) => String(pedido).startsWith(url));

const moderarImagem = (anotacao, contexto = 'task_attachment') => {
  anotacaoVision = anotacao;
  return verifyUploadContent({ file: arquivo('foto.png', 'image/png', PNG), context: contexto });
};

beforeAll(() => {
  global.fetch = mockFetch;
});

afterAll(() => {
  global.fetch = fetchOriginal;
  process.env = envOriginal;
});

beforeEach(() => {
  process.env = { ...envOriginal };
  delete process.env.UPLOAD_MODERATION_URL;
  delete process.env.UPLOAD_MODERATION_REQUIRED;
  delete process.env.UPLOAD_IMAGE_MODERATION_PROVIDER;
  delete process.env.UPLOAD_IMAGE_MODERATION_REQUIRED;
  anotacaoVision = { safeSearchAnnotation: SEGURO };
  respostaExterna = async () => ({ ok: true, status: 200, json: async () => ({ allowed: true, categories: [], provider: 'teste' }) });
  mockFetch.mockReset();
  mockFetch.mockImplementation(async (url, opts) => {
    if (String(url).startsWith(VISION)) {
      return { ok: true, status: 200, json: async () => ({ responses: [anotacaoVision] }) };
    }
    if (String(url) === MODERACAO_EXTERNA) return respostaExterna(url, opts);
    throw new Error(`URL inesperada: ${url}`);
  });
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('listas iguais as do assistente (fixture compartilhado)', () => {
  test.each(['filename', 'text'])('termos de %s: exatamente os da tabela compartilhada', (tipo) => {
    expect([...MODERATION_TERMS[tipo]].sort()).toEqual([...casos.terms[tipo]].sort());
  });

  test('compostos de pornografia: mesmas raizes, prefixos e sufixos da tabela compartilhada', () => {
    expect(MODERATION_TERMS.pornCompounds).toEqual(casos.terms.pornCompounds);
  });

  describe('compostos: raiz + afixo das listas fechadas, como palavra inteira', () => {
    const { roots, prefixes, suffixes } = casos.terms.pornCompounds;
    const compostos = roots.flatMap((raiz) => [
      ...prefixes.map((p) => `${p}${raiz}`),
      ...suffixes.map((s) => `${raiz}${s}`),
      ...prefixes.flatMap((p) => suffixes.map((s) => `${p}${raiz}${s}`)),
    ]);

    test.each(compostos)('"%s.pdf" e bloqueado', async (composto) => {
      expect((await verifyUploadContent({ file: arquivo(`${composto}.pdf`, 'application/pdf', pdf()) })).allowed).toBe(false);
    });

    test.each(['foodporn', 'cityporn', 'earthporn', 'pornic', 'pornichet', 'pornox', 'xporn', 'pornvideox', 'myporn'])(
      '"%s" nao e composto da lista: aceito',
      async (palavra) => {
        expect((await verifyUploadContent({ file: arquivo(`${palavra}.pdf`, 'application/pdf', pdf()) })).allowed).toBe(true);
      }
    );
  });

  test.each(casos.terms.filename)('nome com o termo "%s" e bloqueado', async (termo) => {
    const nome = `${termo.replace(/ /g, '-')}.pdf`;

    expect((await verifyUploadContent({ file: arquivo(nome, 'application/pdf', pdf()) })).allowed).toBe(false);
  });

  test.each(casos.terms.text)('texto de PDF com "%s" e bloqueado', async (termo) => {
    expect((await verifyUploadContent({ file: arquivo('doc.pdf', 'application/pdf', pdf(`trecho ${termo} final`)) })).allowed).toBe(false);
  });
});

describe('nome do arquivo (casos compartilhados com o assistente)', () => {
  test.each(casos.filenames.map((c) => [c.name, c.blocked]))('%s -> bloqueado: %s', async (nome, bloqueado) => {
    const resultado = await verifyUploadContent({ file: arquivo(nome, 'application/pdf', pdf()) });

    expect(resultado.allowed).toBe(!bloqueado);
    if (bloqueado) expect(resultado.categories).toEqual(['suspicious_filename']);
  });
});

describe('texto do PDF (casos compartilhados com o assistente)', () => {
  test.each(casos.pdfTexts.map((c) => [c.text, c.blocked]))('"%s" -> bloqueado: %s', async (texto, bloqueado) => {
    const resultado = await verifyUploadContent({ file: arquivo('documento.pdf', 'application/pdf', pdf(texto)) });

    expect(resultado.allowed).toBe(!bloqueado);
    if (bloqueado) expect(resultado.categories).toEqual(['prohibited_text_content']);
  });
});

describe('Google Vision', () => {
  test('continua pedindo as quatro features, com os mesmos limites', async () => {
    await moderarImagem({ safeSearchAnnotation: SEGURO });

    const [, opts] = chamadas(VISION)[0];
    expect(JSON.parse(opts.body).requests[0].features).toEqual([
      { type: 'SAFE_SEARCH_DETECTION' },
      { type: 'LABEL_DETECTION', maxResults: 20 },
      { type: 'WEB_DETECTION', maxResults: 20 },
      { type: 'TEXT_DETECTION', maxResults: 5 },
    ]);
  });

  describe('sinais legitimos nao bloqueiam', () => {
    test.each([
      ['OCR com risada "kkkk"', { fullTextAnnotation: { text: 'kkkk boa reuniao' } }],
      ['OCR com "explicitly"', { fullTextAnnotation: { text: 'set the value explicitly' } }],
      ['rotulo "Blood orange"', { labelAnnotations: [{ description: 'Blood orange' }] }],
      ['rotulo "Blood" (exame, curativo)', { labelAnnotations: [{ description: 'Blood' }] }],
      ['entidade "Al Gore"', { webDetection: { webEntities: [{ description: 'Al Gore' }] } }],
      ['entidade "Nude" (cor de batom)', { labelAnnotations: [{ description: 'Lipstick' }], webDetection: { webEntities: [{ description: 'Nude' }] } }],
      ['entidade "Supremacy" (jogo)', { webDetection: { webEntities: [{ description: 'Supremacy 1914' }] } }],
      ['OCR com "Nazaré" e "Essex"', { fullTextAnnotation: { text: 'Nazaré Paulista, Essex' } }],
      ['entidade "Nazir Ahmed" (nome proprio)', { webDetection: { webEntities: [{ description: 'Nazir Ahmed' }] } }],
      ['entidade "Pornic" (cidade)', { webDetection: { webEntities: [{ description: 'Pornic' }] } }],
      ['entidade "Food porn" nao e "foodporn": so a palavra inteira conta', { webDetection: { webEntities: [{ description: 'Foodporn' }] } }],
      ['entidade "Gore-Tex"', { webDetection: { webEntities: [{ description: 'Gore-Tex' }] } }],
      ['OCR com "#foodporn"', { fullTextAnnotation: { text: '#foodporn do almoco' } }],
      ['entidade "Nazaré"', { webDetection: { webEntities: [{ description: 'Nazaré' }] } }],
      ['OCR historico: "nazismo" e "suástica"', { fullTextAnnotation: { text: 'Aula de história: o nazismo e a suástica' } }],
      [
        'rotulos separados que so formariam termo se concatenados',
        { labelAnnotations: [{ description: 'Hate' }, { description: 'Symbol' }] },
      ],
      [
        'rotulo e OCR que so formariam frase se concatenados',
        { labelAnnotations: [{ description: 'Sieg' }], fullTextAnnotation: { text: 'Heil' } },
      ],
      ['SafeSearch POSSIBLE continua abaixo do limite', { safeSearchAnnotation: { adult: 'POSSIBLE', racy: 'POSSIBLE', violence: 'POSSIBLE' } }],
    ])('%s', async (_label, anotacao) => {
      const resultado = await moderarImagem({ safeSearchAnnotation: SEGURO, ...anotacao });

      expect(resultado).toEqual(expect.objectContaining({ allowed: true, categories: [] }));
    });
  });

  describe('sinais de alto risco continuam bloqueando, com a categoria certa', () => {
    test.each([
      ['SafeSearch adult VERY_LIKELY', { safeSearchAnnotation: { ...SEGURO, adult: 'VERY_LIKELY' } }, ['explicit_pornography']],
      ['SafeSearch adult LIKELY', { safeSearchAnnotation: { ...SEGURO, adult: 'LIKELY' } }, ['explicit_pornography']],
      ['SafeSearch racy LIKELY', { safeSearchAnnotation: { ...SEGURO, racy: 'LIKELY' } }, ['suggestive_content']],
      ['SafeSearch violence VERY_LIKELY', { safeSearchAnnotation: { ...SEGURO, violence: 'VERY_LIKELY' } }, ['violence']],
      ['rotulo "Swastika"', { labelAnnotations: [{ description: 'Swastika' }] }, ['hate_symbols']],
      ['entidade "Ku Klux Klan"', { webDetection: { webEntities: [{ description: 'Ku Klux Klan' }] } }, ['hate_symbols']],
      ['entidade "KKK"', { webDetection: { webEntities: [{ description: 'KKK' }] } }, ['hate_symbols']],
      ['palpite "neo-nazism"', { webDetection: { bestGuessLabels: [{ label: 'neo-nazism' }] } }, ['hate_symbols']],
      ['entidade "Adolf Hitler"', { webDetection: { webEntities: [{ description: 'Adolf Hitler' }] } }, ['hate_symbols']],
      ['entidade "White supremacy"', { webDetection: { webEntities: [{ description: 'White supremacy' }] } }, ['hate_symbols']],
      ['rotulo "Hate symbol"', { labelAnnotations: [{ description: 'Hate symbol' }] }, ['hate_symbols']],
      ['entidade no plural "Nazis"', { webDetection: { webEntities: [{ description: 'Nazis' }] } }, ['hate_symbols']],
      ['entidade em uma palavra "Neonazism"', { webDetection: { webEntities: [{ description: 'Neonazism' }] } }, ['hate_symbols']],
      ['entidade em portugues "Neonazismo"', { webDetection: { webEntities: [{ description: 'Neonazismo' }] } }, ['hate_symbols']],
      ['entidade em portugues "Nazista"', { webDetection: { webEntities: [{ description: 'Nazista' }] } }, ['hate_symbols']],
      ['entidade "Hitlerjugend"', { webDetection: { webEntities: [{ description: 'Hitlerjugend' }] } }, ['hate_symbols']],
      ['entidade "White supremacism"', { webDetection: { webEntities: [{ description: 'White supremacism' }] } }, ['hate_symbols']],
      ['entidade "Porno"', { webDetection: { webEntities: [{ description: 'Porno' }] } }, ['explicit_pornography']],
      ['entidade "Pornstar"', { webDetection: { webEntities: [{ description: 'Pornstar' }] } }, ['explicit_pornography']],
      ['entidade "Pornhub"', { webDetection: { webEntities: [{ description: 'Pornhub' }] } }, ['explicit_pornography']],
      ['entidade composta "PornTube"', { webDetection: { webEntities: [{ description: 'Porntube' }] } }, ['explicit_pornography']],
      ['OCR com composto "freeporn"', { fullTextAnnotation: { text: 'visite freeporn agora' } }, ['explicit_pornography']],
      ['rotulo "Nude photography"', { labelAnnotations: [{ description: 'Nude photography' }] }, ['explicit_pornography']],
      ['entidade no plural "Mutilations"', { webDetection: { webEntities: [{ description: 'Mutilations' }] } }, ['gore']],
      ['entidade no plural "Decapitations"', { webDetection: { webEntities: [{ description: 'Decapitations' }] } }, ['gore']],
      ['entidade "Gore film"', { webDetection: { webEntities: [{ description: 'Gore film' }] } }, ['gore']],
      ['rotulo no plural "Swastikas"', { labelAnnotations: [{ description: 'Swastikas' }] }, ['hate_symbols']],
      ['rotulo "Pornography"', { labelAnnotations: [{ description: 'Pornography' }] }, ['explicit_pornography']],
      ['rotulo "Nudity"', { labelAnnotations: [{ description: 'Nudity' }] }, ['explicit_pornography']],
      ['rotulo "Corpse"', { labelAnnotations: [{ description: 'Corpse' }] }, ['gore']],
      ['entidade "Decapitation"', { webDetection: { webEntities: [{ description: 'Decapitation' }] } }, ['gore']],
      ['OCR "Heil Hitler"', { fullTextAnnotation: { text: 'HEIL\nHITLER' } }, ['hate_symbols']],
      ['OCR "sexo explícito"', { fullTextAnnotation: { text: 'Vídeo de sexo explícito' } }, ['explicit_pornography']],
      ['OCR "porn"', { fullTextAnnotation: { text: 'free PORN here' } }, ['explicit_pornography']],
      [
        'SafeSearch e rotulo juntos',
        { safeSearchAnnotation: { ...SEGURO, violence: 'LIKELY' }, labelAnnotations: [{ description: 'Swastika' }] },
        ['hate_symbols', 'violence'],
      ],
    ])('%s', async (_label, anotacao, categorias) => {
      const resultado = await moderarImagem({ safeSearchAnnotation: SEGURO, ...anotacao });

      expect(resultado.allowed).toBe(false);
      expect(resultado.categories).toEqual(categorias);
      expect(resultado.provider).toBe('google_vision');
    });

    test('a imagem bloqueada volta para o cliente como 422, sem chegar ao controller', async () => {
      anotacaoVision = { safeSearchAnnotation: SEGURO, labelAnnotations: [{ description: 'Swastika' }] };
      const req = { file: arquivo('foto.png', 'image/png', PNG) };
      const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
      const next = jest.fn();

      await moderateUpload('profile_image')(req, res, next);

      expect(res.status).toHaveBeenCalledWith(422);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ categorias: ['hate_symbols'], provider: 'google_vision' }));
      expect(next).not.toHaveBeenCalled();
    });
  });

  describe('Vision indisponivel', () => {
    test('obrigatorio (padrao): bloqueia', async () => {
      mockFetch.mockImplementation(async () => ({ ok: false, status: 503, text: async () => 'indisponivel' }));

      const resultado = await moderarImagem({});

      expect(resultado).toEqual(expect.objectContaining({ allowed: false, categories: ['visual_moderation_unavailable'] }));
    });

    test('UPLOAD_IMAGE_MODERATION_REQUIRED=false: segue so com as verificacoes locais', async () => {
      process.env.UPLOAD_IMAGE_MODERATION_REQUIRED = 'false';
      mockFetch.mockImplementation(async () => { throw new Error('ECONNREFUSED'); });

      const resultado = await moderarImagem({});

      expect(resultado).toEqual(expect.objectContaining({ allowed: true, provider: 'local_pre_upload_checks' }));
    });
  });
});

describe('moderacao externa (assistente)', () => {
  beforeEach(() => {
    process.env.UPLOAD_MODERATION_URL = MODERACAO_EXTERNA;
  });

  const enviarPdf = (nome = 'ata.pdf', texto = 'ata') => verifyUploadContent({ file: arquivo(nome, 'application/pdf', pdf(texto)) });

  test('aceita quando o assistente aceita', async () => {
    const resultado = await enviarPdf();

    expect(resultado).toEqual(expect.objectContaining({ allowed: true, provider: 'teste' }));
    expect(chamadas(MODERACAO_EXTERNA)).toHaveLength(1);
  });

  test('bloqueia quando o assistente recusa', async () => {
    respostaExterna = async () => ({ ok: true, status: 200, json: async () => ({ allowed: false, categories: ['offensive_content'], reason: 'x', provider: 'flowly_assistant_upload_moderation' }) });

    const resultado = await enviarPdf();

    expect(resultado).toEqual(expect.objectContaining({ allowed: false, categories: ['offensive_content'] }));
  });

  test('categoria de alto risco bloqueia mesmo com allowed=true', async () => {
    respostaExterna = async () => ({ ok: true, status: 200, json: async () => ({ allowed: true, categories: ['hate_symbols'] }) });

    expect((await enviarPdf()).allowed).toBe(false);
  });

  test('arquivo recusado localmente nem chega ao assistente', async () => {
    const resultado = await enviarPdf('video-porno.pdf');

    expect(resultado.allowed).toBe(false);
    expect(chamadas(MODERACAO_EXTERNA)).toHaveLength(0);
  });

  test('UPLOAD_MODERATION_REQUIRED=true e assistente fora: bloqueia', async () => {
    process.env.UPLOAD_MODERATION_REQUIRED = 'true';
    respostaExterna = async () => { throw new Error('ECONNREFUSED'); };

    const resultado = await enviarPdf();

    expect(resultado).toEqual(expect.objectContaining({ allowed: false, categories: ['moderation_unavailable'] }));
  });

  test('UPLOAD_MODERATION_REQUIRED=true e resposta de erro: bloqueia', async () => {
    process.env.UPLOAD_MODERATION_REQUIRED = 'true';
    respostaExterna = async () => ({ ok: false, status: 503, json: async () => ({}) });

    expect((await enviarPdf()).allowed).toBe(false);
  });
});

describe('tipo, extensao e assinatura continuam valendo', () => {
  test.each([
    ['PNG com bytes de PDF', arquivo('foto.png', 'image/png', pdf()), 'spoofed_file_type'],
    ['PDF com bytes de PNG', arquivo('doc.pdf', 'application/pdf', PNG), 'spoofed_file_type'],
    ['imagem com extensao .gif', arquivo('foto.gif', 'image/png', PNG), 'invalid_extension'],
    ['PDF com extensao .txt', arquivo('doc.txt', 'application/pdf', pdf()), 'invalid_extension'],
    ['tipo nao permitido', arquivo('nota.txt', 'text/plain', Buffer.from('texto')), 'unsupported_file_type'],
  ])('%s: bloqueia sem chamar servicos externos', async (_label, file, categoria) => {
    process.env.UPLOAD_MODERATION_URL = MODERACAO_EXTERNA;

    const resultado = await verifyUploadContent({ file });

    expect(resultado).toEqual(expect.objectContaining({ allowed: false, categories: [categoria] }));
    expect(mockFetch).not.toHaveBeenCalled();
  });

  describe('Multer: tipo e extensao por tipo, antes da moderacao', () => {
    const express = require('express');
    const request = require('supertest');
    const upload = require('../middlewares/upload');
    const errorHandler = require('../middlewares/errorHandler');

    const app = express();
    app.post('/upload', upload.single('file'), (req, res) => res.json({ recebido: req.file.originalname }));
    app.use(errorHandler);

    const enviar = (nome, tipo, buffer) => request(app).post('/upload').attach('file', buffer, { filename: nome, contentType: tipo });

    test.each([
      ['JPEG com extensao .png', 'foto.png', 'image/jpeg', JPEG],
      ['PNG com extensao .pdf', 'foto.pdf', 'image/png', PNG],
      ['tipo nao permitido', 'nota.txt', 'text/plain', Buffer.from('texto')],
      ['SVG', 'desenho.svg', 'image/svg+xml', Buffer.from('<svg/>')],
    ])('%s: 400', async (_label, nome, tipo, buffer) => {
      const res = await enviar(nome, tipo, buffer);

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/Tipo de arquivo nao permitido/);
    });

    test.each([
      ['PNG', 'Relatório Sexta.png', 'image/png', PNG],
      ['JPEG .jpeg', 'foto.jpeg', 'image/jpeg', JPEG],
      ['PDF', 'episodio-3.pdf', 'application/pdf', pdf()],
    ])('%s legitimo passa', async (_label, nome, tipo, buffer) => {
      const res = await enviar(nome, tipo, buffer);

      expect(res.status).toBe(200);
    });
  });

  test('foto de perfil continua aceitando so imagem', async () => {
    const resultado = await verifyUploadContent({ file: arquivo('doc.pdf', 'application/pdf', pdf()), context: 'profile_image' });

    expect(resultado).toEqual(expect.objectContaining({ allowed: false, categories: ['invalid_profile_image_type'] }));
  });

  test('imagem legitima com nome em pt-BR chega ao Vision e e aceita', async () => {
    anotacaoVision = { safeSearchAnnotation: SEGURO };

    const resultado = await verifyUploadContent({ file: arquivo('Relatório Sexta-Feira.JPG', 'image/jpeg', JPEG) });

    expect(resultado.allowed).toBe(true);
    expect(chamadas(VISION)).toHaveLength(1);
  });
});
