const request = require('supertest');
const argon2 = require('argon2');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');

const mockDb = { users: [], faces: [] };

jest.mock('@google-cloud/storage', () => ({
  Storage: jest.fn().mockImplementation(() => ({
    bucket: jest.fn().mockReturnValue({ file: jest.fn() }),
  })),
}));

jest.mock('../utils/sendEmail', () => jest.fn().mockResolvedValue(true));

jest.mock('../models/User', () => {
  const mockQuery = (value) => {
    const query = Promise.resolve(value);
    query.select = () => query;
    return query;
  };
  return {
    findOne: jest.fn(async ({ email }) => mockDb.users.find((user) => user.email === email) || null),
    findById: jest.fn((id) => mockQuery(mockDb.users.find((user) => String(user._id) === String(id)) || null)),
    findOneAndUpdate: jest.fn(async ({ _id }, update) => {
      const user = mockDb.users.find((item) => String(item._id) === String(_id));
      return user && !user.faceEnrollmentOfferConcluded ? Object.assign(user, update.$set) : null;
    }),
  };
});

jest.mock('../models/FaceProfile', () => ({
  findOne: jest.fn(async ({ userId, enrolled }) =>
    mockDb.faces.find((face) => String(face.userId) === String(userId) && face.enrolled === enrolled) || null
  ),
  find: jest.fn(() => ({ select: async () => [] })),
  findOneAndUpdate: jest.fn(async ({ userId }, update) => {
    let face = mockDb.faces.find((item) => String(item.userId) === String(userId));
    if (!face) {
      face = {};
      mockDb.faces.push(face);
    }
    Object.assign(face, update.$set);
    return face;
  }),
}));

const config = require('../config/config');
const User = require('../models/User');
const FaceProfile = require('../models/FaceProfile');
const { issueAuthToken, issueFaceSessionToken } = require('../utils/faceAuth');
const app = require('../app');

const PASSWORD = 'SenhaOriginal@1';
const IMAGE = 'data:image/jpeg;base64,AAAA';
const INTERNAL = 'connect ECONNREFUSED 10.0.0.5:27017 /app/segredo/main.js';
const LEAK_PATTERN = /10\.0\.0\.5|27017|5001|ECONNREFUSED|\/app\/|segredo|host-interno|flowly_iot_face|FACE_SERVICE_SECRET|FACE_EMBEDDING_KEY|Cannot (destructure|read)|TypeError|fetch failed|\bat .+:\d+/;
const SESSION_REJECTED = { erro: 'Sessão de verificação facial inválida ou expirada. Faça login novamente.' };
const ENROLL_REQUIRED = 'faceSessionToken e ao menos uma imagem (imageBase64 ou imagesBase64) são obrigatórios.';
const VERIFY_REQUIRED = 'faceSessionToken e imageBase64 são obrigatórios.';
const SKIP_REQUIRED = 'faceSessionToken é obrigatório.';
const PROFILE_REQUIRED = 'imageBase64 ou imagesBase64 é obrigatório.';
const WRONG_FACE = 'Rosto não reconhecido. Tente capturar outra foto com o rosto bem visível.';
const NOT_TEXT = [
  ['objeto', { a: 1 }],
  ['lista', ['a']],
  ['numero', 123],
  ['booleano', true],
];

describe('D34: entradas malformadas e erros inesperados nas rotas faciais', () => {
  const originalFetch = global.fetch;
  const originalServiceSecret = config.face.serviceSecret;
  const originalEmbeddingKey = config.face.embeddingKey;
  let passwordHash;
  let verifySpy;
  let jwtSpy;
  let errorSpy;
  let account;
  let serviceMatch;

  beforeAll(async () => {
    passwordHash = await argon2.hash(PASSWORD, { memoryCost: 1024, timeCost: 2, parallelism: 1 });
  });

  afterAll(() => {
    config.face.serviceSecret = originalServiceSecret;
    config.face.embeddingKey = originalEmbeddingKey;
    global.fetch = originalFetch;
  });

  const respondWith = (status, body) => {
    global.fetch = jest.fn(async () => ({
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    }));
  };

  // Corpos no formato de flowly_iot_face/main.py.
  const healthyService = () => {
    global.fetch = jest.fn(async (url) => ({
      ok: true,
      status: 200,
      json: async () =>
        url.endsWith('/embed')
          ? { face_detected: true, embedding: [1, 0, 0, 0], model: 'VGG-Face' }
          : { match: serviceMatch, distance: 0.9, threshold: 0.5, face_detected: true, model: 'VGG-Face' },
    }));
  };

  beforeEach(() => {
    mockDb.users = [];
    mockDb.faces = [];
    serviceMatch = false;
    config.face.serviceSecret = 'segredo-de-teste';
    config.face.embeddingKey = Buffer.alloc(32, 1).toString('base64');
    healthyService();
    verifySpy = jest.spyOn(argon2, 'verify');
    jwtSpy = jest.spyOn(jwt, 'verify');
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    User.findById.mockClear();
    FaceProfile.findOneAndUpdate.mockClear();
    // Conta nova a cada teste: o contador real dos limiters vale por conta e por sessao.
    account = {
      _id: new mongoose.Types.ObjectId(),
      nome: 'Conta',
      email: `conta${mockDb.users.length}@exemplo.com`,
      senha: passwordHash,
      tipo: 'user',
      verificado: true,
      fotoPerfil: '',
      faceEnrollmentOffered: true,
      faceEnrollmentSkipped: false,
      save: jest.fn().mockResolvedValue(true),
    };
    mockDb.users.push(account);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  const withFace = () => mockDb.faces.push({ userId: account._id, enrolled: true, embeddings: [[1, 0, 0, 0]] });
  const verifyToken = () => issueFaceSessionToken(account._id, 'face_verify');
  const offerToken = () => issueFaceSessionToken(account._id, 'face_enroll');
  const bearer = () => `Bearer ${issueAuthToken(account)}`;

  const postVerify = (body) => request(app).post('/api/face/verify').send(body);
  const postEnroll = (body) => request(app).post('/api/face/enroll').send(body);
  const postSkip = (body) => request(app).post('/api/face/skip-enrollment').send(body);
  const postProfile = (body) => request(app).post('/api/face/enroll-profile').set('Authorization', bearer()).send(body);

  const ROUTES = [
    ['POST /api/face/enroll', () => request(app).post('/api/face/enroll'), ENROLL_REQUIRED],
    ['POST /api/face/verify', () => request(app).post('/api/face/verify'), VERIFY_REQUIRED],
    ['POST /api/face/skip-enrollment', () => request(app).post('/api/face/skip-enrollment'), SKIP_REQUIRED],
    ['POST /api/face/enroll-profile', () => request(app).post('/api/face/enroll-profile').set('Authorization', bearer()), PROFILE_REQUIRED],
  ];

  const expectNothingExpensive = () => {
    expect(global.fetch).not.toHaveBeenCalled();
    expect(verifySpy).not.toHaveBeenCalled();
    expect(FaceProfile.findOneAndUpdate).not.toHaveBeenCalled();
  };

  const expectNoLeak = (res) => {
    expect(JSON.stringify(res.body)).not.toMatch(LEAK_PATTERN);
    expect(res.body.stack).toBeUndefined();
    expect(res.body.detalhe).toBeUndefined();
    expect(res.body.token).toBeUndefined();
  };

  describe.each(ROUTES)('corpo invalido em %s', (_name, call, required) => {
    test.each([
      ['sem corpo', (r) => r],
      ['texto puro', (r) => r.set('Content-Type', 'text/plain').send('abc')],
      ['formato desconhecido', (r) => r.set('Content-Type', 'application/xml').send('<a/>')],
      ['formulario vazio', (r) => r.set('Content-Type', 'application/x-www-form-urlencoded').send('')],
      ['lista vazia', (r) => r.send([])],
      ['lista com itens', (r) => r.send(['a', 'b'])],
      ['objeto vazio', (r) => r.send({})],
    ])('%s responde 400 com a mensagem do campo obrigatorio', async (_label, build) => {
      const res = await build(call());

      expect(res.status).toBe(400);
      expect(res.body).toEqual({ erro: required });
      expectNothingExpensive();
    });

    test.each([
      ['JSON null', 'null'],
      ['JSON string', '"abc"'],
      ['JSON numero', '123'],
      ['JSON quebrado', '{abc'],
    ])('%s responde 400 sem detalhe interno', async (_label, raw) => {
      const res = await call().set('Content-Type', 'application/json').send(raw);

      expect(res.status).toBe(400);
      expectNoLeak(res);
      expectNothingExpensive();
    });
  });

  describe('campo com tipo invalido', () => {
    describe('imageBase64 em /face/verify', () => {
      test.each([...NOT_TEXT, ['nulo', null], ['vazio', '']])('%s responde 400 sem chamar o servico', async (_label, imageBase64) => {
        withFace();

        const res = await postVerify({ faceSessionToken: verifyToken(), imageBase64 });

        expect(res.status).toBe(400);
        expect(res.body).toEqual({ erro: VERIFY_REQUIRED });
        expectNothingExpensive();
        expect(User.findById).not.toHaveBeenCalled();
      });

      test('formulario com imagem em formato de objeto responde 400', async () => {
        withFace();

        const res = await request(app)
          .post('/api/face/verify')
          .type('form')
          .send(`faceSessionToken=${verifyToken()}&imageBase64[a]=1`);

        expect(res.status).toBe(400);
        expectNothingExpensive();
      });
    });

    describe.each([
      ['/face/verify', (faceSessionToken) => postVerify({ faceSessionToken, imageBase64: IMAGE }), VERIFY_REQUIRED],
      ['/face/enroll', (faceSessionToken) => postEnroll({ faceSessionToken, imagesBase64: [IMAGE] }), ENROLL_REQUIRED],
      ['/face/skip-enrollment', (faceSessionToken) => postSkip({ faceSessionToken }), SKIP_REQUIRED],
    ])('faceSessionToken em %s', (_route, send, required) => {
      test.each(NOT_TEXT)('%s responde 401 sem chegar ao verificador de JWT', async (_label, token) => {
        const res = await send(token);

        expect(res.status).toBe(401);
        expect(res.body).toEqual(SESSION_REJECTED);
        expect(jwtSpy).not.toHaveBeenCalled();
        expect(global.fetch).not.toHaveBeenCalled();
        expect(User.findById).not.toHaveBeenCalled();
      });

      test.each([
        ['nulo', null],
        ['vazio', ''],
        ['zero', 0],
        ['falso', false],
      ])('%s conta como ausente: 400', async (_label, token) => {
        const res = await send(token);

        expect(res.status).toBe(400);
        expect(res.body).toEqual({ erro: required });
        expect(jwtSpy).not.toHaveBeenCalled();
      });
    });

    describe('imagens em /face/enroll', () => {
      test.each([
        ['[objeto]', { imagesBase64: [{}] }],
        ['[numero]', { imagesBase64: [123] }],
        ['[nulo]', { imagesBase64: [null] }],
        ['[vazio]', { imagesBase64: [''] }],
        ['[lista]', { imagesBase64: [['a']] }],
        ['uma valida e uma invalida', { imagesBase64: [IMAGE, {}] }],
        ['lista invalida com imageBase64 valida', { imagesBase64: [123], imageBase64: IMAGE }],
        ['imagesBase64 como texto', { imagesBase64: IMAGE }],
        ['imagesBase64 como objeto', { imagesBase64: { 0: IMAGE } }],
        ['imageBase64 como objeto', { imageBase64: { a: 1 } }],
        ['imageBase64 como lista', { imageBase64: [IMAGE] }],
        ['imageBase64 como numero', { imageBase64: 123 }],
        ['imageBase64 como booleano', { imageBase64: true }],
      ])('%s responde 400, nao chama o servico e nao gasta a oferta', async (_label, images) => {
        const token = offerToken();

        const res = await postEnroll({ faceSessionToken: token, ...images });

        expect(res.status).toBe(400);
        expect(res.body).toEqual({ erro: ENROLL_REQUIRED });
        expectNothingExpensive();
        expect(account.faceEnrollmentOfferConcluded).toBeUndefined();

        const retry = await postEnroll({ faceSessionToken: token, imagesBase64: [IMAGE] });
        expect(retry.status).toBe(200);
      });
    });

    describe('imagens em /face/enroll-profile', () => {
      test.each([
        ['[objeto]', { imagesBase64: [{}] }],
        ['[numero]', { imagesBase64: [123] }],
        ['uma valida e uma invalida', { imagesBase64: [IMAGE, null] }],
        ['imageBase64 como objeto', { imageBase64: { a: 1 } }],
        ['imageBase64 como booleano', { imageBase64: true }],
      ])('%s responde 400 sem verificar a senha nem chamar o servico', async (_label, images) => {
        const res = await postProfile({ senhaAtual: PASSWORD, ...images });

        expect(res.status).toBe(400);
        expect(res.body).toEqual({ erro: PROFILE_REQUIRED });
        expectNothingExpensive();
      });
    });

    describe('senhaAtual em /face/enroll-profile', () => {
      test.each([...NOT_TEXT, ['nulo', null], ['vazio', '']])('%s responde 400 sem verificar a senha', async (_label, senhaAtual) => {
        const res = await postProfile({ imagesBase64: [IMAGE], senhaAtual });

        expect(res.status).toBe(400);
        expect(res.body).toEqual({ erro: 'Senha atual é obrigatória.' });
        expectNothingExpensive();
      });
    });
  });

  describe('erro interno inesperado', () => {
    const UNEXPECTED = [
      ['/face/enroll', () => postEnroll({ faceSessionToken: offerToken(), imagesBase64: [IMAGE] }), 'Erro ao cadastrar rosto.'],
      ['/face/verify', () => postVerify({ faceSessionToken: verifyToken(), imageBase64: IMAGE }), 'Erro na verificação facial.'],
      ['/face/skip-enrollment', () => postSkip({ faceSessionToken: offerToken() }), 'Erro ao ignorar cadastro facial.'],
      ['/face/enroll-profile', () => postProfile({ imagesBase64: [IMAGE], senhaAtual: PASSWORD }), 'Erro ao cadastrar rosto.'],
      ['/face/status', () => request(app).get('/api/face/status').set('Authorization', bearer()), 'Erro ao consultar status facial.'],
    ];

    test.each(UNEXPECTED)('%s: falha do banco responde 500 generico', async (_route, send, message) => {
      User.findById.mockImplementationOnce(() => {
        const query = Promise.reject(new Error(INTERNAL));
        query.select = () => query;
        return query;
      });

      const res = await send();

      expect(res.status).toBe(500);
      expect(res.body).toEqual({ erro: message });
      expectNoLeak(res);
    });

    test.each(UNEXPECTED)('%s: a causa fica so no log do servidor', async (_route, send) => {
      User.findById.mockImplementationOnce(() => {
        const query = Promise.reject(new Error(INTERNAL));
        query.select = () => query;
        return query;
      });

      const res = await send();

      expect(JSON.stringify(errorSpy.mock.calls.map(([, err, ...rest]) => [err?.message, ...rest]))).toContain('ECONNREFUSED');
      expect(JSON.stringify(res.body)).not.toContain('ECONNREFUSED');
    });

    test.each(['/face/verify', '/face/enroll', '/face/skip-enrollment'])('%s: falha inesperada na validacao do JWT nao vira 401', async (route) => {
      jwtSpy.mockImplementationOnce(() => {
        throw new Error(INTERNAL);
      });
      const send = UNEXPECTED.find(([name]) => name === route)[1];

      const res = await send();

      expect(res.status).toBe(500);
      expectNoLeak(res);
    });

    test('falha ao verificar a senha responde 500 generico', async () => {
      verifySpy.mockRejectedValueOnce(new Error(INTERNAL));

      const res = await postProfile({ imagesBase64: [IMAGE], senhaAtual: PASSWORD });

      expect(res.status).toBe(500);
      expect(res.body).toEqual({ erro: 'Erro ao cadastrar rosto.' });
    });

    test('chave de criptografia invalida continua 503 e nao revela a configuracao', async () => {
      config.face.embeddingKey = '';

      const res = await postProfile({ imagesBase64: [IMAGE], senhaAtual: PASSWORD });

      expect(res.status).toBe(503);
      expect(res.body).toEqual({ erro: 'Serviço facial indisponível.' });
      expectNoLeak(res);
    });

    test('falha ao buscar o perfil em /face/verify responde 500 generico', async () => {
      withFace();
      FaceProfile.findOne.mockRejectedValueOnce(new Error(INTERNAL));

      const res = await postVerify({ faceSessionToken: verifyToken(), imageBase64: IMAGE });

      expect(res.status).toBe(500);
      expect(res.body).toEqual({ erro: 'Erro na verificação facial.' });
    });
  });

  describe('falha do servico facial mantem o status e nao vaza', () => {
    const SERVICE_ROUTES = [
      ['/face/verify', () => { withFace(); return postVerify({ faceSessionToken: verifyToken(), imageBase64: IMAGE }); }, 'Erro na verificação facial.'],
      ['/face/enroll', () => postEnroll({ faceSessionToken: offerToken(), imagesBase64: [IMAGE] }), 'Erro ao cadastrar rosto.'],
      ['/face/enroll-profile', () => postProfile({ imagesBase64: [IMAGE], senhaAtual: PASSWORD }), 'Erro ao cadastrar rosto.'],
    ];

    describe.each(SERVICE_ROUTES)('%s', (_route, send, fallback) => {
      test('servico fora do ar: 503', async () => {
        global.fetch = jest.fn().mockRejectedValue(new TypeError('fetch failed', { cause: new Error(INTERNAL) }));

        const res = await send();

        expect(res.status).toBe(503);
        expect(res.body).toEqual({ erro: 'Serviço facial indisponível.' });
        expectNoLeak(res);
      });

      test('segredo interno nao configurado: 503 sem citar a variavel', async () => {
        config.face.serviceSecret = '';

        const res = await send();

        expect(res.status).toBe(503);
        expect(res.body).toEqual({ erro: 'Serviço facial indisponível.' });
        expectNoLeak(res);
      });

      test('servico sem resposta: 504', async () => {
        global.fetch = jest.fn().mockRejectedValue(Object.assign(new Error('aborted'), { name: 'AbortError' }));

        const res = await send();

        expect(res.status).toBe(504);
        expect(res.body).toEqual({ erro: 'Serviço facial não respondeu a tempo.' });
      });

      test('servico responde 500: sem mensagem nem corpo do servico', async () => {
        respondWith(500, { erro: 'trace /app/main.py', interno: 'host-interno:5001' });

        const res = await send();

        expect(res.status).toBe(500);
        expect(res.body).toEqual({ erro: fallback });
        expectNoLeak(res);
      });

      test('servico responde 503 com corpo proprio: sem o corpo do servico', async () => {
        respondWith(503, { erro: 'Servico facial indisponivel.', interno: 'host-interno:5001' });

        const res = await send();

        expect(res.status).toBe(503);
        expect(res.body).toEqual({ erro: 'Serviço facial indisponível.' });
      });
    });
  });

  describe('respostas previstas nao mudam', () => {
    test.each([
      ['/face/verify', (faceSessionToken) => postVerify({ faceSessionToken, imageBase64: IMAGE })],
      ['/face/enroll', (faceSessionToken) => postEnroll({ faceSessionToken, imagesBase64: [IMAGE] })],
      ['/face/skip-enrollment', (faceSessionToken) => postSkip({ faceSessionToken })],
    ])('%s: token malformado continua 401 generico', async (_route, send) => {
      const res = await send('token-invalido');

      expect(res.status).toBe(401);
      expect(res.body).toEqual(SESSION_REJECTED);
    });

    test('finalidade errada continua 401', async () => {
      expect((await postVerify({ faceSessionToken: offerToken(), imageBase64: IMAGE })).status).toBe(401);
      expect((await postEnroll({ faceSessionToken: verifyToken(), imagesBase64: [IMAGE] })).status).toBe(401);
      expect((await postSkip({ faceSessionToken: verifyToken() })).status).toBe(401);
    });

    test('JWT principal no lugar do token facial continua 401', async () => {
      const res = await postVerify({ faceSessionToken: issueAuthToken(account), imageBase64: IMAGE });

      expect(res.status).toBe(401);
      expect(res.body).toEqual(SESSION_REJECTED);
    });

    test('/face/enroll-profile sem JWT continua 401, mesmo sem corpo', async () => {
      const res = await request(app).post('/api/face/enroll-profile');

      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
    });

    test('rosto errado continua 401, sem dados da comparacao', async () => {
      withFace();

      const res = await postVerify({ faceSessionToken: verifyToken(), imageBase64: IMAGE });

      expect(res.status).toBe(401);
      expect(res.body).toEqual({ erro: WRONG_FACE });
    });

    test('foto sem rosto continua 400 com a mensagem do servico normalizada', async () => {
      withFace();
      respondWith(400, { match: false, face_detected: false, erro: 'Face could not be detected' });

      const res = await postVerify({ faceSessionToken: verifyToken(), imageBase64: IMAGE });

      expect(res.status).toBe(400);
      expect(res.body.erro).toContain('Não identificamos seu rosto');
      expect(res.body.token).toBeUndefined();
    });

    test('conta inexistente continua 404', async () => {
      mockDb.users = [];

      expect((await postVerify({ faceSessionToken: verifyToken(), imageBase64: IMAGE })).status).toBe(404);
      expect((await postEnroll({ faceSessionToken: offerToken(), imagesBase64: [IMAGE] })).status).toBe(404);
      expect((await postSkip({ faceSessionToken: offerToken() })).status).toBe(404);
    });

    test('senha errada continua 400, sem encerrar a sessao', async () => {
      const res = await postProfile({ imagesBase64: [IMAGE], senhaAtual: 'SenhaErrada@1' });

      expect(res.status).toBe(400);
      expect(res.body).toEqual({ erro: 'Senha atual incorreta.' });
    });

    test('troca de pessoa continua 403', async () => {
      mockDb.faces.push({ userId: account._id, enrolled: true, embeddings: [[0, 1, 0, 0]] });

      const res = await postProfile({ imagesBase64: [IMAGE], senhaAtual: PASSWORD });

      expect(res.status).toBe(403);
      expect(res.body.erro).toContain('nao corresponde');
    });

    test('fluxos legitimos seguem funcionando', async () => {
      const skipped = await postSkip({ faceSessionToken: offerToken() });
      expect(skipped.status).toBe(200);
      expect(skipped.body.token).toEqual(expect.any(String));

      account.faceEnrollmentOfferConcluded = false;
      account.faceEnrollmentSkipped = false;
      const enrolled = await postEnroll({ faceSessionToken: offerToken(), imageBase64: IMAGE });
      expect(enrolled.status).toBe(200);
      expect(enrolled.body.token).toEqual(expect.any(String));

      serviceMatch = true;
      const verified = await postVerify({ faceSessionToken: verifyToken(), imageBase64: IMAGE });
      expect(verified.status).toBe(200);
      expect(verified.body.token).toEqual(expect.any(String));

      const updated = await postProfile({ imagesBase64: [IMAGE, IMAGE], senhaAtual: PASSWORD });
      expect(updated.status).toBe(200);
      expect(updated.body.enrolled).toBe(true);
    });
  });

  describe('o limite do D52 continua igual', () => {
    test('entrada invalida nao gasta tentativa: as 5 tentativas continuam disponiveis', async () => {
      withFace();
      const faceSessionToken = verifyToken();

      for (const imageBase64 of [{ a: 1 }, ['a'], 123, true, null, '', { b: 2 }]) {
        expect((await postVerify({ faceSessionToken, imageBase64 })).status).toBe(400);
      }
      expect((await request(app).post('/api/face/verify')).status).toBe(400);

      for (let i = 0; i < 5; i += 1) {
        const res = await postVerify({ faceSessionToken, imageBase64: IMAGE });
        expect(res.status).toBe(401);
        expect(res.body).toEqual({ erro: WRONG_FACE });
      }

      expect((await postVerify({ faceSessionToken, imageBase64: IMAGE })).status).toBe(429);
    });
  });
});
