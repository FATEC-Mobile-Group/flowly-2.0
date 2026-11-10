const request = require('supertest');
const jwt = require('jsonwebtoken');

// D10: so contas tipo 'user' podem ser responsaveis de tarefa. A API continua sendo a ultima barreira,
// e a lista de membros da equipe informa o tipo para os clientes nao oferecerem administradores.

const mockState = { users: [], equipes: [], tarefas: [] };
const mockSame = (a, b) => String(a) === String(b);
const mockQuery = (value, onPopulate) => {
  let current = value;
  const query = {
    populate: jest.fn((path, fields) => {
      if (onPopulate) current = onPopulate(current, path, fields);
      return query;
    }),
    select: jest.fn(() => query),
    sort: jest.fn(() => query),
    then: (resolve, reject) => Promise.resolve(current).then(resolve, reject),
  };
  return query;
};

jest.mock('@google-cloud/storage', () => ({
  Storage: jest.fn().mockImplementation(() => ({ bucket: jest.fn().mockReturnValue({ file: jest.fn() }) })),
}));
jest.mock('../services/storage', () => {
  const bucket = { file: jest.fn() };
  bucket.getSignedUrl = jest.fn(async (value) => value || '');
  return bucket;
});
jest.mock('../utils/activityLogger', () => jest.fn(async () => {}));
jest.mock('../utils/notificationService', () => ({
  ...jest.requireActual('../utils/notificationService'),
  notifyUsers: jest.fn(async () => {}),
}));

jest.mock('../models/User', () => ({
  findById: jest.fn((id) => mockQuery(mockState.users.find((user) => mockSame(user._id, id)) || null)),
  find: jest.fn(() => mockQuery([])),
  findOne: jest.fn(() => mockQuery(null)),
}));

jest.mock('../models/Equipe', () => {
  const byId = (id) => mockState.equipes.find((equipe) => mockSame(equipe._id, id)) || null;
  const pick = (doc, fields) => Object.fromEntries(['_id', ...fields.split(/\s+/)].map((key) => [key, doc[key]]));
  // populate('membros', campos) projeta os usuarios como o Mongoose faria.
  const populateMembros = (equipe, path, fields) => {
    if (!equipe || path !== 'membros') return equipe;
    const membros = equipe.membros
      .map((id) => mockState.users.find((user) => mockSame(user._id, id)))
      .filter(Boolean)
      .map((user) => pick(user, fields));
    return { ...equipe, membros };
  };
  return {
    updateMany: jest.fn(async () => ({})),
    find: jest.fn(() => mockQuery(mockState.equipes)),
    findOne: jest.fn((filter) => mockQuery(byId(filter._id), populateMembros)),
  };
});

jest.mock('../models/Tarefa', () => {
  const { ObjectId } = jest.requireActual('mongoose').Types;
  function Tarefa(data) {
    Object.assign(this, { _id: new ObjectId(), anexos: [], subtarefas: [], ...data });
  }
  Tarefa.prototype.save = jest.fn(async function save() {
    mockState.tarefas.push(this);
    return this;
  });
  const match = (filter) => mockState.tarefas.find((tarefa) => mockSame(tarefa._id, filter._id)) || null;
  Tarefa.findOne = jest.fn((filter) => mockQuery(match(filter)));
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

jest.mock('../models/Comment', () => ({ find: jest.fn(() => mockQuery([])) }));
jest.mock('../models/ActivityLog', () => ({ find: jest.fn(() => mockQuery([])) }));
jest.mock('../models/Message', () => ({ find: jest.fn(() => mockQuery([])) }));

const { ObjectId } = require('mongoose').Types;
const config = require('../config/config');
const Tarefa = require('../models/Tarefa');
const app = require('../app');

const ADMIN_ID = String(new ObjectId());
const OUTRO_ADMIN_ID = String(new ObjectId());
const ANA_ID = String(new ObjectId());
const BRUNO_ID = String(new ObjectId());
const FORA_ID = String(new ObjectId());
const INEXISTENTE_ID = String(new ObjectId());
const EQUIPE_ID = String(new ObjectId());

const token = (id, tipo) =>
  jwt.sign({ id, tipo, tokenType: 'access' }, config.jwt.secret, {
    issuer: config.jwt.issuer,
    audience: config.jwt.accessAudience,
  });
const adminToken = () => token(ADMIN_ID, 'admin');

const novaTarefa = (extra = {}) => ({
  descricao: 'Revisar entrega',
  dataEntrega: '2099-12-31',
  equipe: EQUIPE_ID,
  ...extra,
});

let tarefaExistente;

beforeEach(() => {
  jest.clearAllMocks();
  mockState.users = [
    { _id: ADMIN_ID, nome: 'Admin Criador', email: 'admin@flowly.test', tipo: 'admin', fotoPerfil: '', senha: 'hash' },
    { _id: OUTRO_ADMIN_ID, nome: 'Outro Admin', email: 'outro@flowly.test', tipo: 'admin', fotoPerfil: '', senha: 'hash' },
    { _id: ANA_ID, nome: 'Ana', email: 'ana@flowly.test', tipo: 'user', fotoPerfil: 'fotos/ana.png', senha: 'hash' },
    { _id: BRUNO_ID, nome: 'Bruno', email: 'bruno@flowly.test', tipo: 'user', fotoPerfil: '', senha: 'hash' },
    { _id: FORA_ID, nome: 'Fora', email: 'fora@flowly.test', tipo: 'user', fotoPerfil: '', senha: 'hash' },
  ];
  // Dado legado: OUTRO_ADMIN_ID e membro apenas para testar a barreira da API.
  mockState.equipes = [
    { _id: EQUIPE_ID, nome: 'Equipe Alfa', createdBy: ADMIN_ID, membros: [ANA_ID, BRUNO_ID, OUTRO_ADMIN_ID, ADMIN_ID] },
  ];
  tarefaExistente = new Tarefa({ descricao: 'Existente', equipe: EQUIPE_ID, user: ANA_ID, createdBy: ADMIN_ID });
  mockState.tarefas = [tarefaExistente];
});

describe('D10 - criar tarefa: responsavel precisa ser conta user', () => {
  test('user membro da equipe: 201 e tarefa atribuida', async () => {
    const res = await request(app).post('/api/tarefas').set('Authorization', `Bearer ${adminToken()}`).send(novaTarefa({ user: ANA_ID }));

    expect(res.status).toBe(201);
    expect(String(res.body.user)).toBe(ANA_ID);
    expect(Tarefa.prototype.save).toHaveBeenCalledTimes(1);
  });

  test.each([
    ['o proprio admin criador', () => ADMIN_ID],
    ['outro admin membro da equipe', () => OUTRO_ADMIN_ID],
  ])('admin como responsavel (%s): 400 e nada salvo', async (_label, id) => {
    const res = await request(app).post('/api/tarefas').set('Authorization', `Bearer ${adminToken()}`).send(novaTarefa({ user: id() }));

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ erro: 'User inválido' });
    expect(Tarefa.prototype.save).not.toHaveBeenCalled();
  });

  test('usuario inexistente: 400 e nada salvo', async () => {
    const res = await request(app).post('/api/tarefas').set('Authorization', `Bearer ${adminToken()}`).send(novaTarefa({ user: INEXISTENTE_ID }));

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ erro: 'User inválido' });
    expect(Tarefa.prototype.save).not.toHaveBeenCalled();
  });

  test('user fora da equipe: 400 e nada salvo', async () => {
    const res = await request(app).post('/api/tarefas').set('Authorization', `Bearer ${adminToken()}`).send(novaTarefa({ user: FORA_ID }));

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ erro: 'Usuário não pertence à equipe selecionada' });
    expect(Tarefa.prototype.save).not.toHaveBeenCalled();
  });

  test.each([
    ['ausente', {}],
    ['texto vazio', { user: '' }],
    ['null', { user: null }],
  ])('sem responsavel (%s): 201 e tarefa vai para o backlog', async (_label, extra) => {
    const res = await request(app).post('/api/tarefas').set('Authorization', `Bearer ${adminToken()}`).send(novaTarefa(extra));

    expect(res.status).toBe(201);
    expect(res.body.user).toBeNull();
    expect(Tarefa.prototype.save).toHaveBeenCalledTimes(1);
  });
});

describe('D10 - editar tarefa: responsavel precisa ser conta user', () => {
  const editar = (body) =>
    request(app).put(`/api/tarefas/${tarefaExistente._id}`).set('Authorization', `Bearer ${adminToken()}`).send(body);

  test('troca para outro user da equipe: 200', async () => {
    const res = await editar({ user: BRUNO_ID });

    expect(res.status).toBe(200);
    expect(String(tarefaExistente.user)).toBe(BRUNO_ID);
  });

  test.each([
    ['o proprio admin criador', () => ADMIN_ID],
    ['outro admin membro da equipe', () => OUTRO_ADMIN_ID],
  ])('admin como responsavel (%s): 400 e responsavel intacto', async (_label, id) => {
    const res = await editar({ descricao: 'Nova', user: id() });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ erro: 'User inválido' });
    expect(Tarefa.findOneAndUpdate).not.toHaveBeenCalled();
    expect(String(tarefaExistente.user)).toBe(ANA_ID);
    expect(tarefaExistente.descricao).toBe('Existente');
  });

  test.each([
    ['texto vazio', ''],
    ['null', null],
  ])('remover responsavel (%s): 200 e tarefa volta ao backlog', async (_label, user) => {
    const res = await editar({ user });

    expect(res.status).toBe(200);
    expect(Tarefa.findOneAndUpdate.mock.calls[0][1]).toHaveProperty('user', null);
  });

  test('sem enviar user: responsavel atual preservado, inclusive legado admin', async () => {
    tarefaExistente.user = OUTRO_ADMIN_ID;

    const res = await editar({ descricao: 'So o nome' });

    expect(res.status).toBe(200);
    expect(Tarefa.findOneAndUpdate.mock.calls[0][1]).not.toHaveProperty('user');
    expect(tarefaExistente.descricao).toBe('So o nome');
    expect(tarefaExistente.user).toBe(OUTRO_ADMIN_ID);
  });
});

describe('D10 - membros da equipe informam o tipo para os clientes', () => {
  test('GET /api/equipes/:id/membros devolve tipo de cada membro, sem campos sensiveis', async () => {
    const res = await request(app).get(`/api/equipes/${EQUIPE_ID}/membros`).set('Authorization', `Bearer ${adminToken()}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual([
      { _id: ANA_ID, nome: 'Ana', fotoPerfil: 'fotos/ana.png', tipo: 'user' },
      { _id: BRUNO_ID, nome: 'Bruno', fotoPerfil: '', tipo: 'user' },
      { _id: OUTRO_ADMIN_ID, nome: 'Outro Admin', fotoPerfil: '', tipo: 'admin' },
      { _id: ADMIN_ID, nome: 'Admin Criador', fotoPerfil: '', tipo: 'admin' },
    ]);
    expect(JSON.stringify(res.body)).not.toMatch(/hash|email/);
  });

  test('somente membros elegiveis tem tipo user', async () => {
    const res = await request(app).get(`/api/equipes/${EQUIPE_ID}/membros`).set('Authorization', `Bearer ${adminToken()}`);

    expect(res.body.filter((membro) => membro.tipo === 'user').map((membro) => membro.nome)).toEqual(['Ana', 'Bruno']);
  });
});
