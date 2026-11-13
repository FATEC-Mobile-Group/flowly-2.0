const request = require('supertest');
const mongoose = require('mongoose');

const mockState = { users: [], equipes: [], tarefas: [], comments: [] };
const mockHooks = { tarefaSave: null, commentSave: null };

// Consulta do Mongoose: pode ser aguardada direto ou encadeada com populate, select e sort.
const mockQuery = (value) => {
  const query = Promise.resolve(value);
  ['populate', 'select', 'sort'].forEach((method) => {
    query[method] = () => query;
  });
  return query;
};
const mockFailing = (err) => {
  const query = Promise.reject(err);
  query.catch(() => {});
  ['populate', 'select', 'sort'].forEach((method) => {
    query[method] = () => query;
  });
  return query;
};
const mockSame = (a, b) => String(a) === String(b);

jest.mock('@google-cloud/storage', () => ({
  Storage: jest.fn().mockImplementation(() => ({
    bucket: jest.fn().mockReturnValue({ file: jest.fn() }),
  })),
}));

jest.mock('../services/storage', () => {
  const bucket = { file: jest.fn() };
  bucket.getSignedUrl = jest.fn(async (value) => value || '');
  bucket.getObjectPath = jest.fn();
  bucket.verifyFileAccessToken = jest.fn();
  return bucket;
});

jest.mock('../utils/sendEmail', () => jest.fn().mockResolvedValue(true));
jest.mock('../utils/activityLogger', () => jest.fn(async () => {}));
jest.mock('../utils/notificationService', () => ({
  ...jest.requireActual('../utils/notificationService'),
  notifyUsers: jest.fn(async () => {}),
}));

jest.mock('../models/User', () => ({
  find: jest.fn((filter) =>
    mockQuery(
      mockState.users.filter(
        (user) => filter._id.$in.some((id) => mockSame(id, user._id)) && user.tipo === filter.tipo
      )
    )
  ),
  findById: jest.fn((id) => mockQuery(mockState.users.find((user) => mockSame(user._id, id)) || null)),
  findOne: jest.fn((filter) => mockQuery(mockState.users.find((user) => user.email === filter.email) || null)),
}));

jest.mock('../models/Equipe', () => {
  const { ObjectId } = jest.requireActual('mongoose').Types;
  function Equipe(data) {
    Object.assign(this, { _id: new ObjectId(), membros: [], ...data });
  }
  Equipe.prototype.save = jest.fn(async function save() {
    mockState.equipes.push(this);
    return this;
  });
  const byId = (id) => mockState.equipes.find((equipe) => mockSame(equipe._id, id)) || null;
  Equipe.updateMany = jest.fn(async () => ({}));
  Equipe.find = jest.fn(() => mockQuery(mockState.equipes));
  Equipe.findById = jest.fn((id) => mockQuery(byId(id)));
  Equipe.findOne = jest.fn((filter) => mockQuery(byId(filter._id)));
  Equipe.findByIdAndUpdate = jest.fn((id, update) => {
    const equipe = byId(id);
    if (equipe) Object.assign(equipe, update);
    return mockQuery(equipe);
  });
  Equipe.findOneAndDelete = jest.fn(async () => null);
  return Equipe;
});

jest.mock('../models/Tarefa', () => {
  const { ObjectId } = jest.requireActual('mongoose').Types;
  function Tarefa(data) {
    Object.assign(this, {
      _id: new ObjectId(),
      subtarefas: [],
      anexos: [],
      status: 'pendente',
      tempoGasto: 0,
      cronometroAtivo: false,
      ...data,
    });
  }
  Tarefa.prototype.save = jest.fn(async function save() {
    if (mockHooks.tarefaSave) return mockHooks.tarefaSave(this);
    if (!mockState.tarefas.includes(this)) mockState.tarefas.push(this);
    return this;
  });
  const match = (filter) =>
    mockState.tarefas.find(
      (tarefa) =>
        mockSame(tarefa._id, filter._id) && (typeof filter.user !== 'string' || mockSame(tarefa.user, filter.user))
    ) || null;
  Tarefa.findOne = jest.fn((filter) => mockQuery(match(filter)));
  Tarefa.findById = jest.fn((id) => mockQuery(match({ _id: id })));
  Tarefa.find = jest.fn(() => mockQuery(mockState.tarefas));
  Tarefa.findOneAndUpdate = jest.fn(async (filter, update) => {
    const tarefa = match(filter);
    if (tarefa) {
      Object.entries(update).forEach(([key, value]) => {
        if (value !== undefined) tarefa[key] = value;
      });
    }
    return tarefa;
  });
  return Tarefa;
});

jest.mock('../models/Comment', () => {
  const { ObjectId } = jest.requireActual('mongoose').Types;
  function Comment(data) {
    Object.assign(this, { _id: new ObjectId(), ...data });
  }
  Comment.prototype.save = jest.fn(async function save() {
    if (mockHooks.commentSave) return mockHooks.commentSave(this);
    mockState.comments.push(this);
    return this;
  });
  Comment.findById = jest.fn((id) => mockQuery(mockState.comments.find((item) => mockSame(item._id, id)) || null));
  Comment.find = jest.fn(() => mockQuery([]));
  return Comment;
});

jest.mock('../models/ActivityLog', () => ({ find: jest.fn(() => mockQuery([])) }));
jest.mock('../models/Message', () => ({ find: jest.fn(() => mockQuery([])) }));

const sendEmail = require('../utils/sendEmail');
const logActivity = require('../utils/activityLogger');
const User = require('../models/User');
const Equipe = require('../models/Equipe');
const Tarefa = require('../models/Tarefa');
const Comment = require('../models/Comment');
const { issueAuthToken } = require('../utils/faceAuth');
const emailController = require('../controllers/emailController');
const app = require('../app');

const INTERNAL = 'connect ECONNREFUSED 10.0.0.5:27017 /app/segredo/main.js';
const LEAK_PATTERN = /Cannot (destructure|read)|TypeError|is not a function|ECONNREFUSED|10\.0\.0\.5|27017|\/app\/|segredo|validation failed|Cast to|Unexpected (token|end)|not valid JSON|\bat .+:\d+/;
const INVALID_JSON = { success: false, error: 'JSON inválido.' };
const NOT_TEXT = [
  ['objeto com operador', { $ne: null }],
  ['lista', ['a']],
  ['numero', 123],
  ['booleano', true],
];

describe('D62: entradas invalidas e erros internos em equipes, tarefas e perfil', () => {
  let admin;
  let colaborador;
  let equipe;
  let tarefa;
  let errorSpy;

  beforeEach(() => {
    jest.clearAllMocks();
    mockHooks.tarefaSave = null;
    mockHooks.commentSave = null;
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'log').mockImplementation(() => {});

    const id = () => new mongoose.Types.ObjectId();
    admin = { _id: id(), nome: 'Admin', email: 'admin@exemplo.com', tipo: 'admin', fotoPerfil: '' };
    colaborador = {
      _id: id(),
      nome: 'Colaborador',
      email: 'colaborador@exemplo.com',
      tipo: 'user',
      fotoPerfil: 'fotos/original.png',
      save: jest.fn(async () => true),
    };
    mockState.users = [admin, colaborador];
    equipe = { _id: id(), nome: 'Equipe Original', membros: [admin._id, colaborador._id], createdBy: admin._id };
    mockState.equipes = [equipe];
    tarefa = new Tarefa({
      descricao: 'Tarefa original',
      dataEntrega: new Date('2026-12-01'),
      equipe: equipe._id,
      user: colaborador._id,
      createdBy: null,
    });
    mockState.tarefas = [tarefa];
    mockState.comments = [];
    Tarefa.prototype.save.mockClear();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  const adminToken = () => `Bearer ${issueAuthToken(admin)}`;
  const userToken = () => `Bearer ${issueAuthToken(colaborador)}`;
  const as = (token, method, url) => request(app)[method](url).set('Authorization', token());

  const snapshot = () => JSON.stringify({ equipe, tarefa: { ...tarefa }, colaborador: { ...colaborador, save: undefined } });

  const expectNoLeak = (res) => {
    expect(JSON.stringify(res.body)).not.toMatch(LEAK_PATTERN);
    expect(res.body.detalhe).toBeUndefined();
    expect(res.body.stack).toBeUndefined();
  };

  const expectNoWrite = () => {
    expect(Equipe.prototype.save).not.toHaveBeenCalled();
    expect(Equipe.updateMany).not.toHaveBeenCalled();
    expect(Equipe.findByIdAndUpdate).not.toHaveBeenCalled();
    expect(Tarefa.prototype.save).not.toHaveBeenCalled();
    expect(Tarefa.findOneAndUpdate).not.toHaveBeenCalled();
    expect(Comment.prototype.save).not.toHaveBeenCalled();
    expect(logActivity).not.toHaveBeenCalled();
  };

  const loggedCauses = () => JSON.stringify(errorSpy.mock.calls.map((args) => args.map((arg) => arg?.message ?? arg)));

  const ROUTES = [
    ['POST /api/equipes', () => as(adminToken, 'post', '/api/equipes'), 400, { erro: 'O nome da equipe é obrigatório' }],
    ['PUT /api/equipes/:id', () => as(adminToken, 'put', `/api/equipes/${equipe._id}`), 400, { erro: 'O nome da equipe é obrigatório' }],
    ['POST /api/tarefas', () => as(adminToken, 'post', '/api/tarefas'), 400, { erro: 'Equipe é obrigatória' }],
    ['PUT /api/tarefas/:id', () => as(adminToken, 'put', `/api/tarefas/${tarefa._id}`), 400, { erro: 'Nenhum dado para atualizar.' }],
    ['POST /api/tarefas/:id/comentarios', () => as(userToken, 'post', `/api/tarefas/${tarefa._id}/comentarios`), 400, { erro: 'Texto do comentário vazio' }],
    ['POST /api/tarefas/:id/subtarefas', () => as(userToken, 'post', `/api/tarefas/${tarefa._id}/subtarefas`), 400, { erro: 'Obrigatório fornecer descrição' }],
    ['PUT /api/tarefas/:id/status', () => as(userToken, 'put', `/api/tarefas/${tarefa._id}/status`), 400, { erro: 'Status inválido' }],
    ['PUT /api/tarefas/:id/cronometro', () => as(userToken, 'put', `/api/tarefas/${tarefa._id}/cronometro`), 400, { erro: 'Ação inválida.' }],
  ];

  describe.each(ROUTES)('corpo invalido em %s', (_name, call, status, required) => {
    test.each([
      ['sem corpo', (r) => r],
      ['texto puro', (r) => r.set('Content-Type', 'text/plain').send('abc')],
      ['formato desconhecido', (r) => r.set('Content-Type', 'application/xml').send('<a/>')],
      ['lista vazia', (r) => r.send([])],
      ['lista com itens', (r) => r.send(['a', 'b'])],
      ['objeto vazio', (r) => r.send({})],
    ])('%s responde com a mensagem do campo, sem gravar nada', async (_label, build) => {
      const before = snapshot();

      const res = await build(call());

      expect(res.status).toBe(status);
      expect(res.body).toEqual(required);
      expectNoWrite();
      expect(snapshot()).toBe(before);
    });

    test.each([
      ['null', 'null'],
      ['texto', '"abc"'],
      ['numero', '123'],
      ['quebrado', '{"nome":'],
    ])('JSON %s continua 400 generico', async (_label, raw) => {
      const res = await call().set('Content-Type', 'application/json').send(raw);

      expect(res.status).toBe(400);
      expect(res.body).toEqual(INVALID_JSON);
      expectNoWrite();
    });
  });

  describe('PUT /api/users/me sem corpo se comporta como hoje com {}', () => {
    test.each([
      ['sem corpo', (r) => r],
      ['texto puro', (r) => r.set('Content-Type', 'text/plain').send('abc')],
      ['objeto vazio', (r) => r.send({})],
    ])('%s: 200 sem mudar nome nem foto', async (_label, build) => {
      const res = await build(as(userToken, 'put', '/api/users/me'));

      expect(res.status).toBe(200);
      expect(colaborador.nome).toBe('Colaborador');
      expect(colaborador.fotoPerfil).toBe('fotos/original.png');
      expectNoLeak(res);
    });

    test.each(NOT_TEXT)('nome %s continua ignorado', async (_label, nome) => {
      const res = await as(userToken, 'put', '/api/users/me').send({ nome });

      expect(res.status).toBe(200);
      expect(colaborador.nome).toBe('Colaborador');
    });
  });

  describe('campos com tipo errado nao chegam ao banco', () => {
    test.each(NOT_TEXT)('criar equipe com nome %s: 400', async (_label, nome) => {
      const res = await as(adminToken, 'post', '/api/equipes').send({ nome, membros: [] });

      expect(res.status).toBe(400);
      expect(res.body).toEqual({ erro: 'O nome da equipe é obrigatório' });
      expect(User.find).not.toHaveBeenCalled();
      expectNoWrite();
    });

    test.each([...NOT_TEXT, ['vazio', ''], ['so espacos', '   ']])('editar equipe com nome %s: 400, nome e membros intactos', async (_label, nome) => {
      const res = await as(adminToken, 'put', `/api/equipes/${equipe._id}`).send({ nome, membros: [] });

      expect(res.status).toBe(400);
      expect(res.body).toEqual({ erro: 'O nome da equipe é obrigatório' });
      expect(equipe.nome).toBe('Equipe Original');
      expect(equipe.membros).toHaveLength(2);
      expectNoWrite();
    });

    test.each(NOT_TEXT)('criar tarefa com equipe %s: 400 sem consultar a equipe', async (_label, value) => {
      const res = await as(adminToken, 'post', '/api/tarefas').send({ descricao: 'x', dataEntrega: '2026-12-01', equipe: value });

      expect(res.status).toBe(400);
      expect(res.body).toEqual({ erro: 'Equipe inválida' });
      expect(Equipe.findOne).not.toHaveBeenCalled();
      expectNoWrite();
    });

    test.each(NOT_TEXT)('criar tarefa com responsavel %s: 400 sem consultar o usuario', async (_label, value) => {
      const res = await as(adminToken, 'post', '/api/tarefas').send({
        descricao: 'x',
        dataEntrega: '2026-12-01',
        equipe: String(equipe._id),
        user: value,
      });

      expect(res.status).toBe(400);
      expect(res.body).toEqual({ erro: 'User inválido' });
      expect(User.findById).not.toHaveBeenCalled();
      expectNoWrite();
    });

    test.each([
      ['equipe', 'Equipe inválida'],
      ['user', 'User inválido'],
    ])('editar tarefa com %s de tipo errado: 400 sem consultar o banco', async (field, message) => {
      for (const [, value] of NOT_TEXT) {
        const res = await as(adminToken, 'put', `/api/tarefas/${tarefa._id}`).send({ descricao: 'nova', [field]: value });

        expect(res.status).toBe(400);
        expect(res.body).toEqual({ erro: message });
      }
      expect(Tarefa.findOne).not.toHaveBeenCalled();
      expect(Equipe.findOne).not.toHaveBeenCalled();
      expectNoWrite();
      expect(tarefa.descricao).toBe('Tarefa original');
    });

    test.each(NOT_TEXT)('comentario com texto %s: 400', async (_label, texto) => {
      const res = await as(userToken, 'post', `/api/tarefas/${tarefa._id}/comentarios`).send({ texto });

      expect(res.status).toBe(400);
      expect(res.body).toEqual({ erro: 'Texto do comentário vazio' });
      expectNoWrite();
    });

    test.each(NOT_TEXT)('subtarefa com descricao %s: 400', async (_label, descricao) => {
      const res = await as(userToken, 'post', `/api/tarefas/${tarefa._id}/subtarefas`).send({ descricao });

      expect(res.status).toBe(400);
      expect(res.body).toEqual({ erro: 'Obrigatório fornecer descrição' });
      expect(tarefa.subtarefas).toHaveLength(0);
      expectNoWrite();
    });

    test.each(NOT_TEXT)('status %s: 400 sem buscar a tarefa', async (_label, status) => {
      const res = await as(userToken, 'put', `/api/tarefas/${tarefa._id}/status`).send({ status });

      expect(res.status).toBe(400);
      expect(Tarefa.findOne).not.toHaveBeenCalled();
      expect(tarefa.status).toBe('pendente');
    });

    test.each([...NOT_TEXT, ['acao desconhecida', 'parar'], ['vazia', '']])('cronometro com acao %s: 400 sem iniciar nem salvar', async (_label, acao) => {
      const res = await as(userToken, 'put', `/api/tarefas/${tarefa._id}/cronometro`).send({ acao });

      expect(res.status).toBe(400);
      expect(res.body).toEqual({ erro: 'Ação inválida.' });
      expect(Tarefa.findOne).not.toHaveBeenCalled();
      expect(tarefa.cronometroAtivo).toBe(false);
      expectNoWrite();
    });
  });

  describe('erro interno inesperado', () => {
    const fail = (fn) => fn.mockImplementationOnce(() => mockFailing(new Error(INTERNAL)));

    test.each([
      ['POST /api/equipes', () => fail(User.find), () => as(adminToken, 'post', '/api/equipes').send({ nome: 'Nova', membros: [String(colaborador._id)] }), 'Erro ao criar equipe'],
      ['PUT /api/equipes/:id', () => fail(Equipe.findOne), () => as(adminToken, 'put', `/api/equipes/${equipe._id}`).send({ nome: 'Nova', membros: [] }), 'Erro ao editar equipe'],
      ['POST /api/tarefas', () => fail(Equipe.findOne), () => as(adminToken, 'post', '/api/tarefas').send({ descricao: 'x', dataEntrega: '2026-12-01', equipe: String(equipe._id) }), 'Erro ao criar tarefa'],
      ['PUT /api/tarefas/:id', () => fail(Tarefa.findOne), () => as(adminToken, 'put', `/api/tarefas/${tarefa._id}`).send({ descricao: 'nova' }), 'Erro ao editar tarefa'],
      ['GET /api/tarefas/:id/detalhes', () => fail(Tarefa.findOne), () => as(userToken, 'get', `/api/tarefas/${tarefa._id}/detalhes`), 'Erro ao buscar detalhes da tarefa'],
      ['POST /api/tarefas/:id/comentarios', () => { mockHooks.commentSave = async () => { throw new Error(INTERNAL); }; }, () => as(userToken, 'post', `/api/tarefas/${tarefa._id}/comentarios`).send({ texto: 'oi' }), 'Erro ao adicionar comentário'],
      ['GET /api/tarefas/backlog', () => fail(Equipe.find), () => as(userToken, 'get', '/api/tarefas/backlog'), 'Erro ao buscar backlog'],
      ['PUT /api/tarefas/:id/atribuir-para-mim', () => fail(Tarefa.findOne), () => as(userToken, 'put', `/api/tarefas/${tarefa._id}/atribuir-para-mim`), 'Erro ao atribuir tarefa'],
      ['PUT /api/tarefas/:id/status', () => fail(Tarefa.findOne), () => as(userToken, 'put', `/api/tarefas/${tarefa._id}/status`).send({ status: 'concluido' }), 'Erro ao atualizar status'],
      ['POST /api/tarefas/:id/anexos', () => fail(Tarefa.findOne), () => as(userToken, 'post', `/api/tarefas/${tarefa._id}/anexos`), 'Erro ao fazer upload de anexo'],
      ['PUT /api/users/me', () => fail(User.findById), () => as(userToken, 'put', '/api/users/me').send({ nome: 'Novo' }), 'Erro ao atualizar perfil'],
    ])('%s: 500 generico, causa so no log', async (_route, prepare, send, message) => {
      prepare();

      const res = await send();

      expect(res.status).toBe(500);
      expect(res.body).toEqual({ erro: message });
      expectNoLeak(res);
      expect(loggedCauses()).toContain('ECONNREFUSED');
    });

    test('criar tarefa com dado recusado pelo modelo: 400, sem o texto do Mongoose', async () => {
      mockHooks.tarefaSave = async () => {
        const err = new mongoose.Error.ValidationError();
        err.message = 'Tarefa validation failed: dataEntrega: Cast to date failed for value "amanha"';
        throw err;
      };

      const res = await as(adminToken, 'post', '/api/tarefas').send({ descricao: 'x', dataEntrega: 'amanha', equipe: String(equipe._id) });

      expect(res.status).toBe(400);
      expect(res.body).toEqual({ erro: 'Dados da tarefa inválidos.' });
      expectNoLeak(res);
    });

    test('convite de equipe: falha interna responde 500 generico (funcao sem rota hoje)', async () => {
      User.findById.mockImplementationOnce(() => mockFailing(new Error(INTERNAL)));
      const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };

      await emailController.convidarMembro({ user: { id: String(admin._id) }, params: { equipeId: String(equipe._id) }, body: { email: 'x@exemplo.com' } }, res);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith({ message: 'Erro ao enviar convite.' });
      expect(loggedCauses()).toContain('ECONNREFUSED');
    });

    test('convite de equipe: corpo ausente nao devolve o TypeError', async () => {
      const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };

      await emailController.convidarMembro({ user: { id: String(admin._id) }, params: { equipeId: String(equipe._id) } }, res);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith({ message: 'Erro ao enviar convite.' });
      expect(sendEmail).not.toHaveBeenCalled();
    });
  });

  describe('o que nao muda', () => {
    test('sem JWT continua 401, mesmo sem corpo', async () => {
      for (const [method, url] of [['post', '/api/equipes'], ['post', '/api/tarefas'], ['put', `/api/tarefas/${tarefa._id}/cronometro`], ['put', '/api/users/me']]) {
        const res = await request(app)[method](url);
        expect(res.status).toBe(401);
      }
    });

    test('colaborador continua 403 nas rotas de admin, mesmo sem corpo', async () => {
      expect((await as(userToken, 'post', '/api/equipes')).status).toBe(403);
      expect((await as(userToken, 'put', `/api/equipes/${equipe._id}`)).status).toBe(403);
      expect((await as(userToken, 'post', '/api/tarefas')).status).toBe(403);
      expect((await as(userToken, 'put', `/api/tarefas/${tarefa._id}`)).status).toBe(403);
      expectNoWrite();
    });

    test('admin continua 403 em status e cronometro', async () => {
      expect((await as(adminToken, 'put', `/api/tarefas/${tarefa._id}/status`).send({ status: 'concluido' })).status).toBe(403);
      expect((await as(adminToken, 'put', `/api/tarefas/${tarefa._id}/cronometro`).send({ acao: 'iniciar' })).status).toBe(403);
    });

    test('criar equipe valida: 201 com o nome formatado', async () => {
      const res = await as(adminToken, 'post', '/api/equipes').send({ nome: '  equipe  de vendas ', membros: [String(colaborador._id)] });

      expect(res.status).toBe(201);
      expect(mockState.equipes[1].nome).toBe('Equipe de Vendas');
    });

    test('criar equipe com membro invalido continua 400', async () => {
      const res = await as(adminToken, 'post', '/api/equipes').send({ nome: 'Nova', membros: ['nao-e-id'] });

      expect(res.status).toBe(400);
      expect(res.body).toEqual({ erro: 'Existem membros com identificadores inválidos' });
    });

    test('editar equipe valida: 200', async () => {
      const res = await as(adminToken, 'put', `/api/equipes/${equipe._id}`).send({ nome: 'renomeada', membros: [String(colaborador._id)] });

      expect(res.status).toBe(200);
      expect(equipe.nome).toBe('Renomeada');
    });

    test('criar tarefa valida: 201, com e sem responsavel', async () => {
      const semResponsavel = await as(adminToken, 'post', '/api/tarefas').send({ descricao: 'Nova', dataEntrega: '2026-12-01', equipe: String(equipe._id) });
      const comResponsavel = await as(adminToken, 'post', '/api/tarefas').send({ descricao: 'Nova', dataEntrega: '2026-12-01', equipe: String(equipe._id), user: String(colaborador._id) });

      expect(semResponsavel.status).toBe(201);
      expect(comResponsavel.status).toBe(201);
    });

    test('criar tarefa com responsavel vazio ou nulo continua indo para o backlog', async () => {
      for (const user of ['', null]) {
        const res = await as(adminToken, 'post', '/api/tarefas').send({ descricao: 'Nova', dataEntrega: '2026-12-01', equipe: String(equipe._id), user });
        expect(res.status).toBe(201);
      }
    });

    test('editar tarefa valida: 200', async () => {
      const res = await as(adminToken, 'put', `/api/tarefas/${tarefa._id}`).send({ descricao: 'Atualizada' });

      expect(res.status).toBe(200);
      expect(tarefa.descricao).toBe('Atualizada');
    });

    test('editar tarefa tirando o responsavel continua permitido', async () => {
      const res = await as(adminToken, 'put', `/api/tarefas/${tarefa._id}`).send({ user: null });

      expect(res.status).toBe(200);
    });

    test('comentario, subtarefa, status e cronometro validos continuam funcionando', async () => {
      expect((await as(userToken, 'post', `/api/tarefas/${tarefa._id}/comentarios`).send({ texto: 'Ola' })).status).toBe(201);
      expect((await as(userToken, 'post', `/api/tarefas/${tarefa._id}/subtarefas`).send({ descricao: 'Passo' })).status).toBe(201);
      expect((await as(userToken, 'put', `/api/tarefas/${tarefa._id}/status`).send({ status: 'em_andamento' })).status).toBe(200);
      expect((await as(userToken, 'put', `/api/tarefas/${tarefa._id}/cronometro`).send({ acao: 'iniciar' })).status).toBe(200);
      expect(tarefa.cronometroAtivo).toBe(true);
      expect((await as(userToken, 'put', `/api/tarefas/${tarefa._id}/cronometro`).send({ acao: 'pausar' })).status).toBe(200);
      expect(tarefa.cronometroAtivo).toBe(false);
    });

    test('cronometro ja ativo continua 400 com a mensagem atual', async () => {
      tarefa.cronometroAtivo = true;

      const res = await as(userToken, 'put', `/api/tarefas/${tarefa._id}/cronometro`).send({ acao: 'iniciar' });

      expect(res.status).toBe(400);
      expect(res.body).toEqual({ erro: 'Cronômetro já está ativo' });
    });

    test('tarefa de outro colaborador continua 403 em status e cronometro', async () => {
      tarefa.user = admin._id;

      expect((await as(userToken, 'put', `/api/tarefas/${tarefa._id}/status`).send({ status: 'concluido' })).status).toBe(403);
      expect((await as(userToken, 'put', `/api/tarefas/${tarefa._id}/cronometro`).send({ acao: 'iniciar' })).status).toBe(403);
    });

    test('perfil com nome valido continua atualizando', async () => {
      const res = await as(userToken, 'put', '/api/users/me').send({ nome: '  Novo Nome ' });

      expect(res.status).toBe(200);
      expect(colaborador.nome).toBe('Novo Nome');
    });
  });
});
