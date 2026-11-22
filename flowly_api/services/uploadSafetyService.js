const path = require('path');
const { GoogleAuth } = require('google-auth-library');

const IMAGE_MIME_TYPES = new Set(['image/jpeg', 'image/png']);
const DOCUMENT_MIME_TYPES = new Set(['application/pdf']);

// Os termos sao comparados como palavras inteiras, nunca como trecho de outra palavra: "sexta",
// "episodio" e "Gorete" nao contem "sex", "odio" e "gore". Cada regra e [categoria, termo], com o
// termo ja sem acento e em minusculas. Isto e correspondencia de texto, nao analise de significado.

// Palavras que, sozinhas, ja nomeiam material pornografico (flexoes e compostos explicitos).
const PORN_WORDS = [
  'porn', 'porno', 'pornos', 'pornografia', 'pornografias', 'pornografico', 'pornograficos', 'pornografica',
  'pornograficas', 'pornography', 'pornographic', 'pornstar', 'pornstars', 'pornhub', 'youporn',
].map((word) => ['explicit_pornography', word]);

// Compostos colados (freeporn, PORNvideo): so raiz + prefixo e/ou sufixo destas listas fechadas, como palavra
// inteira. Nao e busca por trecho: "foodporn", "Pornic" e "earthporn" nao formam composto da lista.
const PORN_COMPOUND_PARTS = {
  roots: ['porn', 'porno'],
  prefixes: ['free', 'hard', 'hardcore', 'softcore', 'xxx', 'hd', 'live', 'amateur'],
  suffixes: [
    'video', 'videos', 'vid', 'vids', 'tube', 'site', 'sites', 'star', 'stars', 'hub', 'pic', 'pics',
    'foto', 'fotos', 'filme', 'filmes', 'film', 'films', 'movie', 'movies', 'clip', 'clips', 'cam', 'cams',
  ],
};
const PORN_COMPOUNDS = (() => {
  const { roots, prefixes, suffixes } = PORN_COMPOUND_PARTS;
  const words = roots.flatMap((root) => [
    ...prefixes.map((prefix) => `${prefix}${root}`),
    ...suffixes.map((suffix) => `${root}${suffix}`),
    ...prefixes.flatMap((prefix) => suffixes.map((suffix) => `${prefix}${root}${suffix}`)),
  ]);
  return [...new Set(words)].map((word) => ['explicit_pornography', word]);
})();

// Expressoes explicitas. Palavras de tema ("sangue", "violencia", "nazismo", "sexo") ficam de fora
// sozinhas: aparecem em exames, relatorios e material didatico.
const PROHIBITED_PHRASES = [
  ['explicit_pornography', 'pornografia explicita'],
  ['explicit_pornography', 'conteudo sexual'],
  ['explicit_pornography', 'sexo explicito'],
  ['explicit_pornography', 'sexually explicit'],
  ['hate_symbols', 'simbolo de odio'],
  ['hate_symbols', 'simbolos de odio'],
  ['hate_symbols', 'hate symbol'],
  ['hate_symbols', 'hate symbols'],
  ['hate_symbols', 'ku klux klan'],
  ['hate_symbols', 'white supremacy'],
  ['hate_symbols', 'white supremacist'],
  ['hate_symbols', 'white supremacists'],
  ['hate_symbols', 'white supremacism'],
  ['hate_symbols', 'supremacia branca'],
  ['hate_symbols', 'heil hitler'],
  ['hate_symbols', 'sieg heil'],
  ['hate_symbols', 'apologia ao nazismo'],
];

const FILENAME_RULES = [...PORN_WORDS, ...PORN_COMPOUNDS, ...PROHIBITED_PHRASES];
const TEXT_RULES = PROHIBITED_PHRASES;

const HIGH_RISK_CATEGORIES = new Set([
  'explicit_pornography',
  'suggestive_content',
  'violence',
  'gore',
  'hate_symbols',
  'offensive_content',
]);

// Rotulos e entidades do Vision nomeiam o que aparece na imagem: ai o nome do simbolo basta.
// Cada descricao e avaliada sozinha, nunca concatenada com as outras.
const VISION_ENTITY_RULES = [
  ...[
    'swastika', 'swastikas', 'suastica', 'suasticas', 'reichskriegsflagge', 'nazi', 'nazis', 'nazism',
    'nazismo', 'nazista', 'nazistas', 'neonazi', 'neonazis', 'neonazism', 'neonazismo', 'neonazista',
    'neonazistas', 'hitler', 'hitlerjugend', 'third reich', 'terceiro reich', 'ku klux klan', 'kkk',
    'white supremacy', 'white supremacist', 'white supremacists', 'white supremacism', 'supremacia branca',
    'hate symbol', 'hate symbols', 'hate group', 'hate groups', 'simbolo de odio', 'simbolos de odio',
  ].map((term) => ['hate_symbols', term]),
  ...PORN_WORDS,
  ...PORN_COMPOUNDS,
  ...['nudity', 'nude photography'].map((term) => ['explicit_pornography', term]),
  ...['corpse', 'corpses', 'mutilation', 'mutilations', 'decapitation', 'decapitations', 'gore film'].map(
    (term) => ['gore', term]
  ),
];

// Texto lido por OCR pode ser qualquer coisa (conversa, documento, risada "kkkk"): so expressoes explicitas.
const VISION_TEXT_RULES = [...PORN_WORDS, ...PORN_COMPOUNDS, ...PROHIBITED_PHRASES];

// " palavra palavra ": sem acento, minusculo; camelCase, troca letra/digito e qualquer separador viram espaco.
const toWords = (value) => ` ${String(value || '')
  .normalize('NFKD')
  .replace(/[̀-ͯ]/g, '')
  .replace(/([a-z])([A-Z])/g, '$1 $2')
  .toLowerCase()
  .replace(/([a-z])(\d)/g, '$1 $2')
  .replace(/(\d)([a-z])/g, '$1 $2')
  .replace(/[^a-z0-9]+/g, ' ')
  .trim()} `;

const matchCategories = (value, rules) => {
  const words = toWords(value);
  return rules.filter(([, term]) => words.includes(` ${term} `)).map(([category]) => category);
};

const BLOCKING_LIKELIHOODS = new Set(['LIKELY', 'VERY_LIKELY']);

// Prazos das verificacoes externas. Cobrem autenticacao, envio, resposta e leitura do corpo.
// O limite de upload e 10 MB: o padrao folgado evita recusar arquivo legitimo em rede lenta.
const DEFAULT_VISION_TIMEOUT_MS = 15000;
const DEFAULT_EXTERNAL_TIMEOUT_MS = 15000;
const MAX_MODERATION_TIMEOUT_MS = 60000;

const readTimeoutMs = (name, fallback) => {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? Math.min(value, MAX_MODERATION_TIMEOUT_MS) : fallback;
};

// Executa a tarefa com prazo: ao estourar, aborta o fetch (signal) e rejeita mesmo que a etapa em
// andamento (ex.: obter o token) nao aceite cancelamento.
const runWithTimeout = async (ms, label, task) => {
  const controller = new AbortController();
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error(`${label}: sem resposta em ${ms} ms`);
      error.code = 'MODERATION_TIMEOUT';
      controller.abort(error);
      reject(error);
    }, ms);
  });
  try {
    return await Promise.race([task(controller.signal), deadline]);
  } finally {
    clearTimeout(timer);
  }
};

// Uma instancia por projeto: o cliente da google-auth-library reaproveita o token entre uploads.
let cachedVisionAuth = null;
const getVisionAuth = (projectId) => {
  if (!cachedVisionAuth || cachedVisionAuth.projectId !== projectId) {
    cachedVisionAuth = {
      projectId,
      auth: new GoogleAuth({
        projectId: projectId || undefined,
        scopes: ['https://www.googleapis.com/auth/cloud-platform'],
      }),
    };
  }
  return cachedVisionAuth.auth;
};

// Falha temporaria da verificacao obrigatoria: o upload e recusado, mas o motivo nao e o conteudo.
const unavailableResult = ({ category, provider }) => ({
  allowed: false,
  unavailable: true,
  reason: 'Nao foi possivel verificar a seguranca do arquivo.',
  categories: [category],
  provider,
});

const getFileSignature = (buffer) => {
  if (!Buffer.isBuffer(buffer) || buffer.length < 4) return 'unknown';
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'jpeg';
  if (
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47
  ) return 'png';
  if (buffer.slice(0, 4).toString('ascii') === '%PDF') return 'pdf';
  return 'unknown';
};

const detectExpectedSignature = (mimetype) => {
  if (mimetype === 'image/jpeg') return 'jpeg';
  if (mimetype === 'image/png') return 'png';
  if (mimetype === 'application/pdf') return 'pdf';
  return 'unknown';
};

const scanFilename = (file) => matchCategories(file?.originalname, FILENAME_RULES).length > 0;

const scanReadableText = (file) => {
  if (file?.mimetype !== 'application/pdf' && file?.mimetype !== 'text/plain') return false;
  const sample = file.buffer.slice(0, 512 * 1024).toString('latin1');
  return matchCategories(sample, TEXT_RULES).length > 0;
};

const callExternalModeration = async ({ file, context }) => {
  const endpoint = (process.env.UPLOAD_MODERATION_URL || '').trim();
  if (!endpoint) return null;

  const required = String(process.env.UPLOAD_MODERATION_REQUIRED || '').trim().toLowerCase() === 'true';
  const maxBytes = Number(process.env.UPLOAD_MODERATION_MAX_BYTES || 10 * 1024 * 1024);
  if (file.size > maxBytes) {
    return required ? {
      allowed: false,
      categories: ['file_too_large_for_moderation'],
      reason: 'Arquivo excede o limite configurado para moderacao de conteudo.',
    } : null;
  }

  const timeoutMs = readTimeoutMs('UPLOAD_MODERATION_TIMEOUT_MS', DEFAULT_EXTERNAL_TIMEOUT_MS);
  try {
    return await runWithTimeout(timeoutMs, 'Moderacao externa', async (signal) => {
      const response = await fetch(endpoint, {
        method: 'POST',
        signal,
        headers: {
          'Content-Type': 'application/json',
          ...(process.env.UPLOAD_MODERATION_SECRET
            ? { Authorization: `Bearer ${process.env.UPLOAD_MODERATION_SECRET}` }
            : {}),
        },
        body: JSON.stringify({
          context,
          filename: file.originalname,
          mimetype: file.mimetype,
          size: file.size,
          contentBase64: file.buffer.toString('base64'),
          blockedCategories: Array.from(HIGH_RISK_CATEGORIES),
        }),
      });
      if (!response.ok) {
        throw new Error(`Servico externo retornou HTTP ${response.status}`);
      }
      const body = await response.json();
      // Resposta sem decisao explicita nao conta como aprovacao.
      if (!body || typeof body !== 'object' || typeof body.allowed !== 'boolean') {
        throw new Error('Servico externo respondeu sem o campo allowed.');
      }
      return body;
    });
  } catch (error) {
    if (!required) {
      console.warn('[upload-moderation] Servico externo indisponivel; usando apenas verificacoes locais.', error.message);
      return null;
    }
    console.error('[upload-moderation] Moderacao externa obrigatoria indisponivel:', error.message);
    return unavailableResult({ category: 'moderation_unavailable', provider: 'external' });
  }
};

const normalizeModerationResult = (result) => {
  if (!result) return null;
  if (result.unavailable) return result;
  const categories = Array.isArray(result.categories)
    ? result.categories.map((category) => String(category))
    : [];
  const blockedByCategory = categories.some((category) => HIGH_RISK_CATEGORIES.has(category));
  return {
    allowed: result.allowed !== false && !blockedByCategory,
    categories,
    reason: result.reason || 'Arquivo reprovado pela verificacao de conteudo.',
    provider: result.provider || 'external',
  };
};

const shouldUseGoogleVision = () => {
  const provider = String(process.env.UPLOAD_IMAGE_MODERATION_PROVIDER || 'google_vision')
    .trim()
    .toLowerCase();
  return provider === 'google_vision';
};

const isVisualModerationRequired = () => (
  String(process.env.UPLOAD_IMAGE_MODERATION_REQUIRED || 'true').trim().toLowerCase() !== 'false'
);

const callGoogleVisionModeration = async (file) => {
  if (!shouldUseGoogleVision()) return null;

  const projectId = (process.env.GCP_PROJECT_ID || process.env.GOOGLE_CLOUD_PROJECT || '').trim();
  const timeoutMs = readTimeoutMs('UPLOAD_VISION_TIMEOUT_MS', DEFAULT_VISION_TIMEOUT_MS);

  const annotation = await runWithTimeout(timeoutMs, 'Google Vision', async (signal) => {
    // Se o prazo estourar, a instancia em cache e descartada (catch abaixo): um token travado na
    // google-auth-library nao pode prender os proximos uploads.
    const client = await getVisionAuth(projectId).getClient();
    const accessToken = await client.getAccessToken();
    const token = typeof accessToken === 'string' ? accessToken : accessToken?.token;

    if (!token) {
      throw new Error('Nao foi possivel autenticar no Google Vision.');
    }

    const response = await fetch('https://vision.googleapis.com/v1/images:annotate', {
      method: 'POST',
      signal,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...(projectId ? { 'x-goog-user-project': projectId } : {}),
      },
      body: JSON.stringify({
        requests: [
          {
            image: { content: file.buffer.toString('base64') },
            features: [
              { type: 'SAFE_SEARCH_DETECTION' },
              { type: 'LABEL_DETECTION', maxResults: 20 },
              { type: 'WEB_DETECTION', maxResults: 20 },
              { type: 'TEXT_DETECTION', maxResults: 5 },
            ],
          },
        ],
      }),
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(`Google Vision retornou HTTP ${response.status}: ${detail.slice(0, 300)}`);
    }

    const payload = await response.json();
    const result = payload?.responses?.[0];
    // 200 sem resultado para a imagem nao prova que ela e segura.
    if (!result || typeof result !== 'object') {
      throw new Error('Google Vision respondeu sem resultado para a imagem.');
    }
    return result;
  }).catch((error) => {
    if (error.code === 'MODERATION_TIMEOUT') {
      cachedVisionAuth = null;
    }
    throw error;
  });

  if (annotation.error) {
    const error = new Error(annotation.error.message || 'Erro na moderacao visual.');
    // INVALID_ARGUMENT (3): o Vision nao conseguiu ler esta imagem. Repetir nao resolve.
    error.unreadableImage = annotation.error.code === 3;
    throw error;
  }

  const categories = [];
  const safeSearch = annotation.safeSearchAnnotation || {};
  if (BLOCKING_LIKELIHOODS.has(safeSearch.adult)) categories.push('explicit_pornography');
  if (BLOCKING_LIKELIHOODS.has(safeSearch.racy)) categories.push('suggestive_content');
  if (BLOCKING_LIKELIHOODS.has(safeSearch.violence)) categories.push('violence');

  const entityDescriptions = [
    ...(annotation.labelAnnotations || []).map((item) => item.description),
    ...(annotation.webDetection?.webEntities || []).map((item) => item.description),
    ...(annotation.webDetection?.bestGuessLabels || []).map((item) => item.label),
  ].filter(Boolean);
  const ocrText = annotation.fullTextAnnotation?.text || '';

  entityDescriptions.forEach((description) => {
    categories.push(...matchCategories(description, VISION_ENTITY_RULES));
  });
  categories.push(...matchCategories(ocrText, VISION_TEXT_RULES));

  const descriptions = [...entityDescriptions, ocrText].filter(Boolean).join(' ');

  return {
    allowed: categories.length === 0,
    categories: sortedUnique(categories),
    reason: categories.length
      ? 'Imagem bloqueada pela moderacao visual antes do upload.'
      : '',
    provider: 'google_vision',
    signals: {
      safeSearch,
      descriptions: descriptions.slice(0, 500),
    },
  };
};

const sortedUnique = (values) => Array.from(new Set(values)).sort();

const verifyUploadContent = async ({ file, context = 'task_attachment' }) => {
  if (!file?.buffer) {
    return { allowed: false, reason: 'Arquivo vazio ou invalido.', categories: ['invalid_file'] };
  }

  const ext = path.extname(file.originalname || '').toLowerCase();
  const isImage = IMAGE_MIME_TYPES.has(file.mimetype);
  const isDocument = DOCUMENT_MIME_TYPES.has(file.mimetype);

  if (context === 'profile_image' && !isImage) {
    return {
      allowed: false,
      reason: 'Foto de perfil deve ser uma imagem PNG ou JPG.',
      categories: ['invalid_profile_image_type'],
    };
  }

  if (!isImage && !isDocument) {
    return {
      allowed: false,
      reason: 'Tipo de arquivo nao permitido para verificacao de conteudo.',
      categories: ['unsupported_file_type'],
    };
  }

  if (isImage && !['.jpg', '.jpeg', '.png'].includes(ext)) {
    return {
      allowed: false,
      reason: 'Extensao de imagem invalida.',
      categories: ['invalid_extension'],
    };
  }

  if (isDocument && ext !== '.pdf') {
    return {
      allowed: false,
      reason: 'Apenas PDF e permitido como documento verificavel.',
      categories: ['invalid_extension'],
    };
  }

  const expectedSignature = detectExpectedSignature(file.mimetype);
  const actualSignature = getFileSignature(file.buffer);
  if (expectedSignature !== actualSignature) {
    return {
      allowed: false,
      reason: 'A assinatura do arquivo nao corresponde ao tipo informado.',
      categories: ['spoofed_file_type'],
    };
  }

  if (scanFilename(file)) {
    return {
      allowed: false,
      reason: 'O nome do arquivo indica conteudo proibido.',
      categories: ['suspicious_filename'],
    };
  }

  if (scanReadableText(file)) {
    return {
      allowed: false,
      reason: 'O arquivo contem termos associados a conteudo proibido.',
      categories: ['prohibited_text_content'],
    };
  }

  if (isImage) {
    try {
      const visionResult = normalizeModerationResult(await callGoogleVisionModeration(file));
      if (visionResult && !visionResult.allowed) {
        return visionResult;
      }
    } catch (error) {
      if (isVisualModerationRequired()) {
        // O detalhe tecnico fica so no log; o resultado nao carrega a mensagem da excecao.
        console.error('[upload-moderation] Moderacao visual nao concluida:', error.code || '', error.message);
        if (error.unreadableImage) {
          return {
            allowed: false,
            reason: 'Nao foi possivel ler a imagem enviada.',
            categories: ['unreadable_image'],
            provider: 'google_vision',
          };
        }
        return unavailableResult({ category: 'visual_moderation_unavailable', provider: 'google_vision' });
      }
      console.warn('[upload-moderation] Google Vision indisponivel; usando apenas verificacoes locais.', error.message);
    }
  }

  const externalResult = normalizeModerationResult(await callExternalModeration({ file, context }));
  if (externalResult && !externalResult.allowed) {
    return externalResult;
  }

  return {
    allowed: true,
    categories: externalResult?.categories || [],
    provider: externalResult?.provider || 'local_pre_upload_checks',
  };
};

module.exports = {
  verifyUploadContent,
  // Listas de nome e de texto: os testes conferem que sao iguais as do assistente Python.
  MODERATION_TERMS: {
    filename: [...PORN_WORDS, ...PROHIBITED_PHRASES].map(([, term]) => term),
    text: TEXT_RULES.map(([, term]) => term),
    pornCompounds: PORN_COMPOUND_PARTS,
  },
};
