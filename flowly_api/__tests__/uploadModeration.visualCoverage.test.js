// Cobertura real da moderacao visual: o que o Flowly bloqueia a partir da RESPOSTA do Google Vision.
// Testes de caracterizacao: descrevem o comportamento atual, inclusive lacunas e falsos positivos.
// Nenhuma imagem real e enviada: o Vision e simulado e os arquivos sao bytes sinteticos com nome neutro,
// para que o bloqueio venha do conteudo (resposta do Vision), nunca do nome do arquivo.
// O que estes testes NAO provam: se o modelo do Google devolve esses sinais para imagens reais.

jest.mock('google-auth-library', () => ({
  GoogleAuth: jest.fn().mockImplementation(() => ({
    getClient: async () => ({ getAccessToken: async () => ({ token: 'token-de-teste' }) }),
  })),
}));

const { verifyUploadContent } = require('../services/uploadSafetyService');

const VISION = 'https://vision.googleapis.com/v1/images:annotate';
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32, 1)]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(32, 1)]);
const PDF = Buffer.from('%PDF-1.4\n1 0 obj << /Subtype /Image >> stream\n\xff\xd8\xff\xe0 imagem embutida\nendstream endobj\n%%EOF', 'latin1');

const fetchOriginal = global.fetch;
const envOriginal = { ...process.env };
const mockFetch = jest.fn();
let anotacao;

const SEGURO = { adult: 'VERY_UNLIKELY', racy: 'VERY_UNLIKELY', violence: 'VERY_UNLIKELY', medical: 'UNLIKELY', spoof: 'UNLIKELY' };
const comSafeSearch = (sinais) => ({ safeSearchAnnotation: { ...SEGURO, ...sinais } });
const comRotulos = (rotulos, extra = {}) => ({ ...comSafeSearch({}), labelAnnotations: rotulos.map((description) => ({ description, score: 0.9 })), ...extra });
const comWeb = (entidades) => ({ ...comSafeSearch({}), webDetection: { webEntities: entidades } });
const comTexto = (text) => ({ ...comSafeSearch({}), fullTextAnnotation: { text } });

const moderar = (resposta, { contexto = 'task_attachment', nome = 'imagem.png', mime = 'image/png', buffer = PNG } = {}) => {
  anotacao = resposta;
  return verifyUploadContent({ file: { originalname: nome, mimetype: mime, buffer, size: buffer.length }, context: contexto });
};
const chamadasVision = () => mockFetch.mock.calls.filter(([url]) => String(url).startsWith(VISION)).length;

beforeAll(() => {
  global.fetch = mockFetch;
});

afterAll(() => {
  global.fetch = fetchOriginal;
  process.env = envOriginal;
});

beforeEach(() => {
  process.env = { ...envOriginal };
  ['UPLOAD_MODERATION_URL', 'UPLOAD_MODERATION_REQUIRED', 'UPLOAD_IMAGE_MODERATION_PROVIDER', 'UPLOAD_IMAGE_MODERATION_REQUIRED']
    .forEach((nome) => delete process.env[nome]);
  anotacao = comSafeSearch({});
  mockFetch.mockReset();
  mockFetch.mockImplementation(async (url) => {
    if (String(url).startsWith(VISION)) return { ok: true, status: 200, json: async () => ({ responses: [anotacao] }) };
    throw new Error(`URL inesperada: ${url}`);
  });
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('1. SafeSearch: adult, racy e violence bloqueiam a partir de LIKELY', () => {
  test.each([
    ['adult', 'LIKELY', 'explicit_pornography'],
    ['adult', 'VERY_LIKELY', 'explicit_pornography'],
    ['racy', 'LIKELY', 'suggestive_content'],
    ['racy', 'VERY_LIKELY', 'suggestive_content'],
    ['violence', 'LIKELY', 'violence'],
    ['violence', 'VERY_LIKELY', 'violence'],
  ])('%s=%s bloqueia como %s', async (campo, nivel, categoria) => {
    const resultado = await moderar(comSafeSearch({ [campo]: nivel }));

    expect(resultado).toEqual(expect.objectContaining({ allowed: false, categories: [categoria], provider: 'google_vision' }));
  });

  test.each(['adult', 'racy', 'violence'])('%s=POSSIBLE NAO bloqueia (limiar e LIKELY)', async (campo) => {
    expect((await moderar(comSafeSearch({ [campo]: 'POSSIBLE' }))).allowed).toBe(true);
  });

  test.each([
    ['medical', 'VERY_LIKELY'],
    ['spoof', 'VERY_LIKELY'],
  ])('%s=%s e ignorado (nao bloqueia)', async (campo, nivel) => {
    expect((await moderar(comSafeSearch({ [campo]: nivel }))).allowed).toBe(true);
  });

  test('UNKNOWN em tudo nao bloqueia', async () => {
    expect((await moderar(comSafeSearch({ adult: 'UNKNOWN', racy: 'UNKNOWN', violence: 'UNKNOWN' }))).allowed).toBe(true);
  });

  test('o mesmo criterio vale para JPEG e para foto de perfil', async () => {
    const jpeg = await moderar(comSafeSearch({ adult: 'VERY_LIKELY' }), { nome: 'foto.jpg', mime: 'image/jpeg', buffer: JPEG });
    const perfil = await moderar(comSafeSearch({ adult: 'VERY_LIKELY' }), { contexto: 'profile_image' });

    expect(jpeg.categories).toEqual(['explicit_pornography']);
    expect(perfil.categories).toEqual(['explicit_pornography']);
  });
});

describe('2. Imagens inofensivas passam (sinais neutros do Vision)', () => {
  test.each([
    ['pet', comRotulos(['Dog', 'Pet', 'Grass'])],
    ['praia/roupa de banho sem racy alto', comRotulos(['Beach', 'Swimwear', 'Summer'])],
    ['documento escaneado', comTexto('Ata da reuniao de planejamento - sprint 12')],
    ['historia da 2a guerra sem termos da lista', comWeb([{ description: 'World War II', score: 0.8 }, { description: 'History', score: 0.6 }])],
    ['sangue em contexto medico', comRotulos(['Blood', 'Hospital', 'Surgery'])],
    ['risada "kkkk" no OCR', comTexto('kkkkk muito bom')],
  ])('%s', async (_caso, resposta) => {
    expect((await moderar(resposta)).allowed).toBe(true);
  });
});

describe('3. Simbolos extremistas: rotulos, entidades da web e OCR', () => {
  test.each([
    ['rotulo Swastika', comRotulos(['Swastika', 'Symbol'])],
    ['entidade web Nazism', comWeb([{ description: 'Nazism', score: 0.7 }])],
    ['entidade web Flag of Nazi Germany', comWeb([{ description: 'Flag of Nazi Germany', score: 0.9 }])],
    ['palpite do Vision "nazi flag"', { ...comSafeSearch({}), webDetection: { bestGuessLabels: [{ label: 'nazi flag' }] } }],
    ['rotulo Reichskriegsflagge', comRotulos(['Reichskriegsflagge'])],
    ['entidade web Neo-Nazism', comWeb([{ description: 'Neo-Nazism', score: 0.6 }])],
    ['entidade web Ku Klux Klan', comWeb([{ description: 'Ku Klux Klan', score: 0.8 }])],
    ['entidade web Adolf Hitler', comWeb([{ description: 'Adolf Hitler', score: 0.9 }])],
    ['OCR "SIEG HEIL"', comTexto('SIEG HEIL')],
    ['OCR "heil hitler"', comTexto('heil hitler 88')],
    ['OCR "white supremacy"', comTexto('White Supremacy now')],
  ])('%s: bloqueia como hate_symbols', async (_caso, resposta) => {
    expect(await moderar(resposta)).toEqual(expect.objectContaining({ allowed: false, categories: ['hate_symbols'] }));
  });

  test.each([
    ['rotulo em alemao Hakenkreuz', comRotulos(['Hakenkreuz'])],
    ['entidade Schutzstaffel (SS)', comWeb([{ description: 'Schutzstaffel', score: 0.9 }])],
    ['entidade Totenkopf', comWeb([{ description: 'Totenkopf', score: 0.9 }])],
    ['entidade Black Sun (Sonnenrad)', comWeb([{ description: 'Black Sun (symbol)', score: 0.9 }])],
    ['entidade Islamic State', comWeb([{ description: 'Islamic State', score: 0.9 }])],
    ['entidade Confederate flag', comWeb([{ description: 'Flag of the Confederate States of America', score: 0.9 }])],
    ['OCR so com "NAZI"', comTexto('NAZI')],
    ['OCR com codigo numerico 1488', comTexto('1488')],
    ['bandeira descrita so como "Flag", "Red", "Symbol"', comRotulos(['Flag', 'Red', 'Symbol', 'Circle'])],
  ])('LACUNA: %s nao bloqueia (termo fora da lista)', async (_caso, resposta) => {
    expect((await moderar(resposta)).allowed).toBe(true);
  });

  test('SafeSearch nao tem categoria de odio: simbolo sem rotulo/entidade/OCR da lista passa', async () => {
    expect((await moderar(comSafeSearch({ violence: 'POSSIBLE' }))).allowed).toBe(true);
  });
});

describe('4. Violencia explicita (gore) por rotulo', () => {
  test.each(['Corpse', 'Mutilation', 'Decapitation', 'Gore film'])('rotulo %s bloqueia como gore', async (rotulo) => {
    expect((await moderar(comRotulos([rotulo]))).categories).toEqual(['gore']);
  });

  test.each(['Blood', 'Injury', 'Wound', 'Weapon', 'Gun', 'Knife'])('rotulo %s sozinho nao bloqueia', async (rotulo) => {
    expect((await moderar(comRotulos([rotulo]))).allowed).toBe(true);
  });
});

describe('5. Pornografia por rotulo, entidade e OCR', () => {
  test.each([
    ['rotulo Nudity', comRotulos(['Nudity'])],
    ['entidade Pornography', comWeb([{ description: 'Pornography', score: 0.5 }])],
    ['OCR "FREEPORN"', comTexto('www.FREEPORN.example')],
  ])('%s bloqueia como explicit_pornography', async (_caso, resposta) => {
    expect((await moderar(resposta)).categories).toEqual(['explicit_pornography']);
  });

  test.each([
    ['rotulo Nude (fora da lista)', comRotulos(['Nude'])],
    ['rotulo Erotica (fora da lista)', comRotulos(['Erotica'])],
  ])('LACUNA: %s nao bloqueia sem SafeSearch alto', async (_caso, resposta) => {
    expect((await moderar(resposta)).allowed).toBe(true);
  });
});

describe('6. Falsos positivos que as regras atuais produzem (se o Vision devolver estes sinais)', () => {
  test('FALSO POSITIVO: entidade web de baixa confianca bloqueia (score ignorado)', async () => {
    const resposta = comWeb([{ description: 'Nazi Germany', score: 0.12 }, { description: 'History', score: 0.9 }]);

    expect((await moderar(resposta)).categories).toEqual(['hate_symbols']);
  });

  test('FALSO POSITIVO: material de historia com "Adolf Hitler" (livro, aula sobre a 2a guerra)', async () => {
    const resposta = comWeb([{ description: 'Adolf Hitler', score: 0.6 }, { description: 'Textbook', score: 0.5 }]);

    expect((await moderar(resposta)).allowed).toBe(false);
  });

  test('FALSO POSITIVO: suastica religiosa (hinduismo/budismo) rotulada como Swastika', async () => {
    const resposta = comRotulos(['Swastika', 'Temple', 'Hindu temple']);

    expect((await moderar(resposta)).categories).toEqual(['hate_symbols']);
  });

  test('FALSO POSITIVO: slide educativo com a palavra "pornografia" no OCR', async () => {
    const resposta = comTexto('Combate a pornografia infantil: como denunciar');

    expect((await moderar(resposta)).categories).toEqual(['explicit_pornography']);
  });

  test('FALSO POSITIVO possivel: racy=LIKELY (roupa de banho, academia) bloqueia como sugestivo', async () => {
    const resposta = { ...comRotulos(['Swimwear', 'Beach']), safeSearchAnnotation: { ...SEGURO, racy: 'LIKELY' } };

    expect((await moderar(resposta)).categories).toEqual(['suggestive_content']);
  });

  test('regras sao por palavra inteira: "Nazareth" e "Kkkk" passam; "KKK" sozinho bloqueia', async () => {
    expect((await moderar(comWeb([{ description: 'Nazareth', score: 0.9 }]))).allowed).toBe(true);
    expect((await moderar(comRotulos(['Kkkk meme']))).allowed).toBe(true);
    expect((await moderar(comRotulos(['KKK rally']))).categories).toEqual(['hate_symbols']);
  });
});

describe('7. Ordem e falha segura', () => {
  test('o Vision recebe o conteudo da imagem (base64) e as quatro features', async () => {
    await moderar(comSafeSearch({}));

    const corpo = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(corpo.requests[0].image.content).toBe(PNG.toString('base64'));
    expect(corpo.requests[0].features.map(({ type }) => type)).toEqual([
      'SAFE_SEARCH_DETECTION', 'LABEL_DETECTION', 'WEB_DETECTION', 'TEXT_DETECTION',
    ]);
  });

  test('Vision indisponivel (padrao obrigatorio): recusa como indisponivel', async () => {
    mockFetch.mockImplementation(async () => ({ ok: false, status: 503, text: async () => '' }));

    expect(await moderar(comSafeSearch({}))).toEqual(expect.objectContaining({
      allowed: false, unavailable: true, categories: ['visual_moderation_unavailable'],
    }));
  });

  test('UPLOAD_IMAGE_MODERATION_REQUIRED=false: Vision fora deixa a imagem passar (opcao explicita)', async () => {
    process.env.UPLOAD_IMAGE_MODERATION_REQUIRED = 'false';
    mockFetch.mockImplementation(async () => { throw new Error('ECONNREFUSED'); });

    expect((await moderar(comSafeSearch({}))).allowed).toBe(true);
  });

  test('CORRIGIDO: provedor diferente de google_vision com REQUIRED=true recusa como indisponivel (antes aceitava)', async () => {
    process.env.UPLOAD_IMAGE_MODERATION_PROVIDER = 'nenhum';
    process.env.UPLOAD_IMAGE_MODERATION_REQUIRED = 'true';

    const resultado = await moderar(comSafeSearch({ adult: 'VERY_LIKELY' }));

    expect(chamadasVision()).toBe(0);
    expect(resultado).toEqual(expect.objectContaining({
      allowed: false, unavailable: true, categories: ['visual_moderation_unavailable'],
    }));
  });

  test('CORRIGIDO: resposta sem safeSearchAnnotation e verificacao incompleta (antes aceitava)', async () => {
    expect((await moderar({}))).toEqual(expect.objectContaining({
      allowed: false, unavailable: true, categories: ['visual_moderation_unavailable'],
    }));
  });

  test('nome neutro nao influencia: o bloqueio vem so da resposta do Vision', async () => {
    const resultado = await moderar(comSafeSearch({ adult: 'VERY_LIKELY' }), { nome: 'paisagem-ferias.png' });

    expect(resultado.categories).toEqual(['explicit_pornography']);
  });
});

describe('8. Anexo de tarefa x foto de perfil', () => {
  test('foto de perfil aceita so imagem: PDF recusado antes do Vision', async () => {
    const resultado = await moderar(comSafeSearch({}), { contexto: 'profile_image', nome: 'doc.pdf', mime: 'application/pdf', buffer: PDF });

    expect(resultado.categories).toEqual(['invalid_profile_image_type']);
    expect(chamadasVision()).toBe(0);
  });

  test('LACUNA: anexo PDF nao passa pelo Vision (imagem embutida no PDF nao e analisada)', async () => {
    const resultado = await moderar(comSafeSearch({ adult: 'VERY_LIKELY' }), { nome: 'relatorio.pdf', mime: 'application/pdf', buffer: PDF });

    expect(chamadasVision()).toBe(0);
    expect(resultado.allowed).toBe(true);
  });

  test('imagens: anexo e perfil usam exatamente a mesma analise visual', async () => {
    const resposta = comRotulos(['Swastika']);
    const anexo = await moderar(resposta);
    const perfil = await moderar(resposta, { contexto: 'profile_image' });

    expect(anexo.categories).toEqual(perfil.categories);
    expect(chamadasVision()).toBe(2);
  });
});
