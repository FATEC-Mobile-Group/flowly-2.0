const request = require('supertest');
const mongoose = require('mongoose');

// C1: o acesso a tarefa e conferido antes do Multer, do Google Vision, da moderacao externa e do
// Cloud Storage. C2: uploads (anexo e foto de perfil) dividem um limite por conta.
// Nada sai da maquina: fetch, Google Auth e Cloud Storage sao simulados.

const mockState = { equipes: [], tarefas: [], users: [] };
const mockSave = jest.fn(async () => {});
const mockFile = jest.fn(() => ({ save: mockSave }));
const mockSame = (a, b) => String(a) === String(b);

// Consulta do Mongoose: pode ser aguardada direto ou encadeada com select.
const mockQuery = (produce) => {
  const query = Promise.resolve().then(produce);
  query.select = () => query;
  return query;
};

jest.mock('@google-cloud/storage', () => ({
  Storage: jest.fn().mockImplementation(() => ({
    bucket: jest.fn().mockReturnValue({ name: 'bucket-de-teste', file: mockFile }),
  })),
}));

jest.mock('google-auth-library', () => ({
  GoogleAuth: jest.fn().mockImplementation(() => ({
    getClient: async () => ({ getAccessToken: async () => ({ token: 'token-de-teste' }) }),
  })),
}));

jest.mock('../utils/activityLogger', () => jest.fn(async () => {}));

jest.mock('../models/Equipe', () => {
  const matches = (filter) => (equipe) => {
    if (filter.$or) return filter.$or.some((parte) => matches(parte)(equipe));
    return Object.entries(filter).every(([campo, valor]) =>
      campo === 'membros' ? equipe.membros.some((membro) => mockSame(membro, valor)) : mockSame(equipe[campo], valor)
    );
  };
  return {
    find: jest.fn((filter) => mockQuery(() => mockState.equipes.filter(matches(filter)).map(({ _id }) => ({ _id })))),
  };
});

jest.mock('../models/Tarefa', () => {
  // O filtro passa pela conversao real do Mongoose: _id malformado lanca CastError, como no banco.
  const TarefaReal = jest.requireActual('../models/Tarefa');
  return {
    findOne: jest.fn((filter) =>
      mockQuery(() => {
        TarefaReal.find(filter).cast();
        return (
          mockState.tarefas.find(
            (tarefa) =>
              mockSame(tarefa._id, filter._id) && filter.equipe.$in.some((id) => mockSame(id, tarefa.equipe))
          ) || null
        );
      })
    ),
  };
});

jest.mock('../models/User', () => ({
  findById: jest.fn((id) => mockQuery(() => mockState.users.find((user) => mockSame(user._id, id)) || null)),
}));

const Equipe = require('../models/Equipe');
const Tarefa = require('../models/Tarefa');
const { issueAuthToken } = require('../utils/faceAuth');
const app = require('../app');

const VISION = 'https://vision.googleapis.com/v1/images:annotate';
const MODERACAO_EXTERNA = 'https://moderacao.test/api/v1/uploads/moderate';
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32, 1)]);
const PDF = Buffer.from('%PDF-1.4\n1 0 obj << >> endobj\n%%EOF');
const INTERNAL = 'connect ECONNREFUSED 10.0.0.5:27017 /app/segredo/main.js';
const LEAK_PATTERN = /ECONNREFUSED|10\.0\.0\.5|27017|\/app\/|segredo|TypeError|\bat .+:\d+/;
const LIMITE = 20;
const MSG_429 = { erro: 'Muitas tentativas. Aguarde alguns minutos e tente novamente.' };
const NAO_ENCONTRADA = { erro: 'Tarefa não encontrada' };

const id = () => new mongoose.Types.ObjectId();

const fetchOriginal = global.fetch;
const envOriginal = { ...process.env };
const mockFetch = jest.fn();

const chamadasVision = () => mockFetch.mock.calls.filter(([url]) => String(url).startsWith(VISION)).length;
const chamadasModeracao = () => mockFetch.mock.calls.filter(([url]) => String(url) === MODERACAO_EXTERNA).length;

const esperarNadaProcessado = () => {
  expect(chamadasVision()).toBe(0);
  expect(chamadasModeracao()).toBe(0);
  expect(mockFile).not.toHaveBeenCalled();
  expect(mockSave).not.toHaveBeenCalled();
};

describe('C1/C2: uploads verificam acesso e frequencia antes de processar o arquivo', () => {
  let admin;
  let colaborador;
  let estranho;
  let equipe;
  let tarefa;
  let errorSpy;

  beforeAll(() => {
    process.env.UPLOAD_MODERATION_URL = MODERACAO_EXTERNA;
    process.env.UPLOAD_MODERATION_SECRET = 'segredo-de-teste';
    delete process.env.UPLOAD_MODERATION_REQUIRED;
    delete process.env.UPLOAD_IMAGE_MODERATION_PROVIDER;
    delete process.env.UPLOAD_IMAGE_MODERATION_REQUIRED;
    global.fetch = mockFetch;
  });

  afterAll(() => {
    global.fetch = fetchOriginal;
    process.env = envOriginal;
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockFetch.mockImplementation(async (url) => {
      if (String(url).startsWith(VISION)) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            responses: [{ safeSearchAnnotation: { adult: 'VERY_UNLIKELY', racy: 'UNLIKELY', violence: 'VERY_UNLIKELY' } }],
          }),
        };
      }
      if (String(url) === MODERACAO_EXTERNA) {
        return { ok: true, status: 200, json: async () => ({ allowed: true, categories: [], provider: 'teste' }) };
      }
      throw new Error(`URL inesperada: ${url}`);
    });

    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'log').mockImplementation(() => {});

    // IDs novos a cada teste: o contador do limiter fica na memoria do modulo.
    admin = { _id: id(), nome: 'Admin', email: 'admin@exemplo.com', tipo: 'admin', fotoPerfil: '', save: jest.fn(async () => {}) };
    colaborador = { _id: id(), nome: 'Colaborador', email: 'colab@exemplo.com', tipo: 'user', fotoPerfil: 'fotos/antiga.png', save: jest.fn(async () => {}) };
    estranho = { _id: id(), nome: 'Estranho', email: 'estranho@exemplo.com', tipo: 'user', fotoPerfil: '', save: jest.fn(async () => {}) };
    mockState.users = [admin, colaborador, estranho];

    // O admin criou a equipe sem ser membro: o acesso dele vem de createdBy.
    equipe = { _id: id(), nome: 'Equipe', createdBy: admin._id, membros: [colaborador._id] };
    mockState.equipes = [equipe, { _id: id(), nome: 'Outra', createdBy: id(), membros: [estranho._id] }];

    tarefa = { _id: id(), equipe: equipe._id, anexos: [], save: jest.fn(async () => {}) };
    mockState.tarefas = [tarefa];
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  const bearer = (user) => `Bearer ${issueAuthToken(user)}`;
  const anexar = (user, tarefaId = tarefa._id, arquivo = PNG, nome = 'imagem.png', tipo = 'image/png') => {
    const req = request(app).post(`/api/tarefas/${tarefaId}/anexos`);
    if (user) req.set('Authorization', bearer(user));
    return req.attach('file', arquivo, { filename: nome, contentType: tipo });
  };
  const trocarFoto = (user) => {
    const req = request(app).put('/api/users/me');
    if (user) req.set('Authorization', bearer(user));
    return req.attach('fotoPerfil', PNG, { filename: 'eu.png', contentType: 'image/png' });
  };

  describe('quem tem acesso continua anexando', () => {
    test('1. admin que criou a equipe anexa imagem: 201, passa pela moderacao e grava', async () => {
      const res = await anexar(admin);

      expect(res.status).toBe(201);
      expect(res.body.msg).toBe('Anexo adicionado com sucesso');
      expect(chamadasVision()).toBe(1);
      expect(chamadasModeracao()).toBe(1);
      expect(mockSave).toHaveBeenCalledTimes(1);
      expect(mockFile.mock.calls[0][0]).toMatch(new RegExp(`^arquivos/${tarefa._id}/`));
      expect(tarefa.anexos).toHaveLength(1);
      expect(tarefa.save).toHaveBeenCalledTimes(1);
    });

    test('2. colaborador membro da equipe anexa PDF: 201', async () => {
      const res = await anexar(colaborador, tarefa._id, PDF, 'ata.pdf', 'application/pdf');

      expect(res.status).toBe(201);
      expect(chamadasVision()).toBe(0);
      expect(chamadasModeracao()).toBe(1);
      expect(mockSave).toHaveBeenCalledTimes(1);
      expect(tarefa.anexos[0]).toEqual(expect.objectContaining({ nomeOriginal: 'ata.pdf', mimetype: 'application/pdf' }));
    });
  });

  describe('sem acesso: 404 antes de qualquer processamento', () => {
    test('3. colaborador de outra equipe: 404 sem Vision, moderacao externa nem Storage', async () => {
      const res = await anexar(estranho);

      expect(res.status).toBe(404);
      expect(res.body).toEqual(NAO_ENCONTRADA);
      esperarNadaProcessado();
      expect(tarefa.anexos).toHaveLength(0);
    });

    test('3b. admin que nao criou nem participa da equipe: 404 sem processamento', async () => {
      const outroAdmin = { _id: id(), nome: 'Outro Admin', email: 'outro@exemplo.com', tipo: 'admin' };

      const res = await anexar(outroAdmin);

      expect(res.status).toBe(404);
      expect(res.body).toEqual(NAO_ENCONTRADA);
      esperarNadaProcessado();
    });

    test('4. tarefa inexistente: mesma resposta da tarefa privada, sem processamento', async () => {
      const privada = await anexar(estranho);
      jest.clearAllMocks();
      const inexistente = await anexar(colaborador, id());

      expect(inexistente.status).toBe(404);
      expect(inexistente.body).toEqual(privada.body);
      esperarNadaProcessado();
    });

    test.each([
      ['texto', 'id-invalido'],
      ['curto demais', '123'],
      ['24 caracteres fora de hexadecimal', 'z'.repeat(24)],
      ['hexadecimal com 25 caracteres', '0'.repeat(25)],
      ['ObjectId com sufixo', `${'a'.repeat(24)}x`],
      ['operador codificado', '%7B%22%24ne%22%3Anull%7D'],
    ])('ID malformado (%s): mesmo 404 da tarefa inexistente, sem 500 nem processamento', async (_label, idMalformado) => {
      const inexistente = await anexar(colaborador, id());
      jest.clearAllMocks();

      const res = await anexar(colaborador, idMalformado);

      expect(res.status).toBe(404);
      expect(res.body).toEqual(inexistente.body);
      esperarNadaProcessado();
      expect(errorSpy).not.toHaveBeenCalled();
      expect(tarefa.anexos).toHaveLength(0);
    });

    test('a conversao do mock e a do Mongoose: ID malformado lanca CastError', () => {
      const TarefaReal = jest.requireActual('../models/Tarefa');

      expect(() => TarefaReal.find({ _id: 'id-invalido' }).cast()).toThrow(mongoose.Error.CastError);
      expect(() => TarefaReal.find({ _id: id() }).cast()).not.toThrow();
    });

    test('5. sem JWT: 401 nas duas rotas, sem processamento', async () => {
      const anexo = await anexar(null);
      const foto = await trocarFoto(null);

      expect(anexo.status).toBe(401);
      expect(foto.status).toBe(401);
      esperarNadaProcessado();
    });

    test('perde o acesso durante o upload: o controller confere de novo e nao grava', async () => {
      // A moderacao demora; nesse meio tempo o colaborador sai da equipe.
      const respostaPadrao = mockFetch.getMockImplementation();
      mockFetch.mockImplementation(async (url, opts) => {
        equipe.membros = [];
        return respostaPadrao(url, opts);
      });

      const res = await anexar(colaborador);

      expect(res.status).toBe(404);
      expect(mockSave).not.toHaveBeenCalled();
      expect(tarefa.anexos).toHaveLength(0);
    });
  });

  describe('limite de uploads por conta', () => {
    test(`6. ate ${LIMITE} uploads na janela funcionam normalmente`, async () => {
      for (let i = 0; i < LIMITE; i += 1) {
        const res = await anexar(colaborador);
        expect(res.status).toBe(201);
        expect(res.headers['ratelimit-limit']).toBe(String(LIMITE));
        expect(res.headers['ratelimit-remaining']).toBe(String(LIMITE - 1 - i));
      }
      expect(mockSave).toHaveBeenCalledTimes(LIMITE);
    });

    test(`7. o upload ${LIMITE + 1} recebe 429 sem chegar ao Vision, a moderacao nem ao Storage`, async () => {
      for (let i = 0; i < LIMITE; i += 1) await anexar(colaborador);
      jest.clearAllMocks();

      const res = await anexar(colaborador);

      expect(res.status).toBe(429);
      expect(res.body).toEqual(MSG_429);
      esperarNadaProcessado();
      expect(Equipe.find).not.toHaveBeenCalled();
    });

    test('8. o limite de um usuario nao bloqueia outro', async () => {
      for (let i = 0; i < LIMITE; i += 1) await anexar(colaborador);
      expect((await anexar(colaborador)).status).toBe(429);

      const res = await anexar(admin);

      expect(res.status).toBe(201);
      expect(res.headers['ratelimit-remaining']).toBe(String(LIMITE - 1));
    });

    test('o limite e dividido entre anexos e foto de perfil', async () => {
      for (let i = 0; i < LIMITE / 2; i += 1) {
        expect((await anexar(colaborador)).status).toBe(201);
        expect((await trocarFoto(colaborador)).status).toBe(200);
      }
      jest.clearAllMocks();

      const foto = await trocarFoto(colaborador);
      const anexo = await anexar(colaborador);

      expect(foto.status).toBe(429);
      expect(anexo.status).toBe(429);
      esperarNadaProcessado();
    });

    test('a identidade vem do JWT: id no corpo ou no cabecalho nao muda o contador', async () => {
      for (let i = 0; i < LIMITE; i += 1) await anexar(colaborador);

      const res = await request(app)
        .post(`/api/tarefas/${tarefa._id}/anexos`)
        .set('Authorization', bearer(colaborador))
        .set('X-Forwarded-For', '203.0.113.99')
        .field('userId', String(admin._id))
        .field('id', String(admin._id))
        .attach('file', PNG, { filename: 'imagem.png', contentType: 'image/png' });

      expect(res.status).toBe(429);

      // Em JSON o corpo ja chega lido ao limiter: mesmo assim o id dele nao vale.
      const json = await request(app)
        .put('/api/users/me')
        .set('Authorization', bearer(colaborador))
        .send({ userId: String(admin._id), id: String(admin._id), user: { id: String(admin._id) }, nome: 'Outro' });

      expect(json.status).toBe(429);
      expect(colaborador.nome).toBe('Colaborador');
    });

    test('tentativas sem acesso tambem contam: varrer IDs de tarefa para no limite', async () => {
      for (let i = 0; i < LIMITE; i += 1) {
        expect((await anexar(estranho, id())).status).toBe(404);
      }

      expect((await anexar(estranho, id())).status).toBe(429);
      expect(chamadasVision()).toBe(0);
    });
  });

  describe('foto de perfil', () => {
    test('9. trocar a foto continua funcionando: 200, moderacao, gravacao e caminho novo', async () => {
      const res = await trocarFoto(colaborador);

      expect(res.status).toBe(200);
      expect(res.body.msg).toBe('Perfil atualizado com sucesso');
      expect(chamadasVision()).toBe(1);
      expect(mockSave).toHaveBeenCalledTimes(1);
      expect(colaborador.fotoPerfil).toMatch(new RegExp(`^fotos/${colaborador._id}/`));
      expect(colaborador.save).toHaveBeenCalledTimes(1);
    });

    test('atualizar so o nome continua funcionando, sem moderacao nem Storage', async () => {
      const res = await request(app).put('/api/users/me').set('Authorization', bearer(colaborador)).field('nome', 'Novo Nome');

      expect(res.status).toBe(200);
      expect(colaborador.nome).toBe('Novo Nome');
      esperarNadaProcessado();
    });
  });

  describe('11. falha no banco ao conferir o acesso', () => {
    test.each([
      ['Equipe.find', () => Equipe.find.mockImplementationOnce(() => { const q = Promise.reject(new Error(INTERNAL)); q.catch(() => {}); q.select = () => q; return q; })],
      ['Tarefa.findOne', () => Tarefa.findOne.mockImplementationOnce(() => { const q = Promise.reject(new Error(INTERNAL)); q.catch(() => {}); q.select = () => q; return q; })],
    ])('%s falha: 500 generico, causa so no log, sem processar o arquivo', async (_label, falhar) => {
      falhar();

      const res = await anexar(colaborador);

      expect(res.status).toBe(500);
      expect(res.body).toEqual({ erro: 'Erro ao fazer upload de anexo' });
      expect(JSON.stringify(res.body)).not.toMatch(LEAK_PATTERN);
      esperarNadaProcessado();
      const causas = JSON.stringify(errorSpy.mock.calls.map((args) => args.map((arg) => arg?.message ?? arg)));
      expect(causas).toContain('ECONNREFUSED');
    });
  });
});
