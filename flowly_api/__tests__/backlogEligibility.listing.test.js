// PR #63: elegibilidade do backlog na listagem (GET /api/tarefas/backlog), consulta resumida do Painel Geral
// (GET /api/tarefas?resumo=1) e o campo aditivo `tipo` dos participantes em GET /api/equipes.
// Rotas, auth e permissoes reais; banco simulado em memoria com a semantica de filtro do MongoDB que importa aqui
// ({ campo: null } casa com nulo ou ausente, $or, $in, $exists). Nenhuma conexao real.
const request = require('supertest');
const jwt = require('jsonwebtoken');

jest.mock('../utils/sessionGuard', () => require('./helpers/sessionGuardStub'));
jest.mock('@google-cloud/storage', () => ({
  Storage: jest.fn().mockImplementation(() => ({ bucket: jest.fn().mockReturnValue({ file: jest.fn() }) })),
}));
jest.mock('../services/storage', () => {
  const bucket = { file: jest.fn() };
  bucket.getSignedUrl = jest.fn(async (path) => (path ? `https://storage.test/${path}?X-Goog-Signature=assinada` : ''));
  bucket.getObjectPath = jest.fn();
  return bucket;
});

const mockDb = { equipes: [], tarefas: [], users: [] };
const mockSame = (a, b) => a != null && b != null && String(a) === String(b);
const mockOperador = (valor) => valor && typeof valor === 'object' && !Array.isArray(valor)
  && Object.keys(valor).some((chave) => chave.startsWith('$'));
const mockMatches = (row, filter) => Object.entries(filter).every(([campo, condicao]) => {
  if (campo === '$or') return condicao.some((alternativa) => mockMatches(row, alternativa));
  const valor = row[campo];
  if (condicao === null) return valor == null; // como no MongoDB: nulo ou campo ausente
  if (mockOperador(condicao)) {
    return Object.entries(condicao).every(([operador, argumento]) => {
      if (operador === '$in') return argumento.some((item) => mockSame(item, valor));
      if (operador === '$exists') return (valor !== undefined) === argumento;
      if (operador === '$ne') return !mockSame(valor, argumento);
      throw new Error(`operador nao suportado no teste: ${operador}`);
    });
  }
  if (Array.isArray(valor)) return valor.some((item) => mockSame(item, condicao));
  return mockSame(valor, condicao);
});
const mockClone = (valor) => JSON.parse(JSON.stringify(valor));

// Consulta encadeavel: registra select/populate/sort e aplica projecao e populate ao resolver.
const mockConsulta = (produzir) => {
  const estado = { select: null, populates: [] };
  const consulta = {
    select: jest.fn((campos) => { estado.select = campos; return consulta; }),
    populate: jest.fn((caminho, campos) => { estado.populates.push([caminho, campos]); return consulta; }),
    sort: jest.fn(() => consulta),
    then: (resolve, reject) => Promise.resolve().then(() => produzir(estado)).then(resolve, reject),
  };
  return consulta;
};
const mockProjetar = (row, select) => {
  if (!select) return mockClone(row);
  const campos = select.split(/\s+/).filter(Boolean);
  return Object.fromEntries(Object.entries(mockClone(row)).filter(([campo]) => campo === '_id' || campos.includes(campo)));
};
const mockPopular = (doc, populates) => {
  populates.forEach(([caminho, campos]) => {
    const lista = String(campos || '').split(/\s+/).filter(Boolean);
    const escolher = (origem) => (origem
      ? { _id: origem._id, ...Object.fromEntries(lista.filter((c) => c in origem).map((c) => [c, origem[c]])) }
      : null);
    if (caminho === 'user' && doc.user) doc.user = escolher(mockDb.users.find((u) => mockSame(u._id, doc.user)));
    if (caminho === 'equipe' && doc.equipe) doc.equipe = escolher(mockDb.equipes.find((e) => mockSame(e._id, doc.equipe)));
    if (caminho === 'membros') doc.membros = (doc.membros || []).map((id) => escolher(mockDb.users.find((u) => mockSame(u._id, id))));
  });
  return doc;
};

jest.mock('../models/Equipe', () => ({
  find: jest.fn((filter) => mockConsulta((estado) => mockDb.equipes
    .filter((equipe) => mockMatches(equipe, filter))
    .map((equipe) => mockPopular(mockProjetar(equipe, estado.select), estado.populates)))),
  updateMany: jest.fn(async () => ({ matchedCount: 0 })),
}));
jest.mock('../models/Tarefa', () => ({
  find: jest.fn((filter) => mockConsulta((estado) => mockDb.tarefas
    .filter((tarefa) => mockMatches(tarefa, filter))
    .map((tarefa) => mockPopular(mockProjetar(tarefa, estado.select), estado.populates)))),
}));

const config = require('../config/config');
const Tarefa = require('../models/Tarefa');
const Equipe = require('../models/Equipe');
const { getSignedUrl } = require('../services/storage');
const app = require('../app');

const hex = (n) => n.toString(16).padStart(24, '0');
const token = (id, tipo) => jwt.sign({ id, tipo, tokenType: 'access' }, config.jwt.secret, {
  issuer: config.jwt.issuer,
  audience: config.jwt.accessAudience,
});

const ADMIN = hex(1);
const ANA = hex(2);
const BRUNO = hex(3);
const FORA = hex(4);
const EQ_ALFA = hex(11);
const EQ_BETA = hex(12);
const EQ_ALHEIA = hex(13);

const tarefa = (n, campos) => ({
  _id: hex(100 + n),
  descricao: `Tarefa ${n}`,
  detalhes: `Detalhes internos ${n}`,
  status: 'pendente',
  urgencia: 'media',
  dataEntrega: '2026-12-01T00:00:00.000Z',
  createdAt: '2026-11-20T10:00:00.000Z',
  tempoGasto: 10,
  user: null,
  equipe: EQ_ALFA,
  anexos: [{ _id: hex(900 + n), nome: 'arquivo.pdf', url: `tarefas/${n}/arquivo.pdf` }],
  subtarefas: [{ descricao: 'sub', concluida: false }],
  tags: ['interna'],
  ...campos,
});

const ids = (body) => body.map((item) => item._id).sort();

beforeEach(() => {
  jest.clearAllMocks();
  mockDb.users = [
    { _id: ADMIN, nome: 'Admin Teste', email: 'admin@exemplo.com', tipo: 'admin', fotoPerfil: '' },
    { _id: ANA, nome: 'Ana', email: 'ana@exemplo.com', tipo: 'user', fotoPerfil: '' },
    { _id: BRUNO, nome: 'Bruno', email: 'bruno@exemplo.com', tipo: 'user', fotoPerfil: '' },
    { _id: FORA, nome: 'Fora', email: 'fora@exemplo.com', tipo: 'user', fotoPerfil: '' },
  ];
  mockDb.equipes = [
    { _id: EQ_ALFA, nome: 'Alfa', createdBy: ADMIN, membros: [ADMIN, ANA, BRUNO] },
    { _id: EQ_BETA, nome: 'Beta', createdBy: ADMIN, membros: [ADMIN, BRUNO] },
    { _id: EQ_ALHEIA, nome: 'Alheia', createdBy: hex(99), membros: [FORA] },
  ];
  mockDb.tarefas = [
    tarefa(1), // pendente, sem responsavel: backlog
    tarefa(2, { status: 'concluido' }),
    tarefa(3, { status: 'em_andamento' }),
    tarefa(4, { user: BRUNO }), // pendente, atribuida
    tarefa(5, { equipe: EQ_ALHEIA }), // pendente sem responsavel, mas de equipe alheia a Ana
    tarefa(6, { equipe: EQ_BETA }), // pendente sem responsavel, equipe da qual Ana nao e membro
  ];
  const legada = tarefa(7); // documento antigo: sem os campos user e status
  delete legada.user;
  delete legada.status;
  mockDb.tarefas.push(legada);
});

describe('GET /api/tarefas/backlog: so pendentes e sem responsavel, das equipes do colaborador', () => {
  const backlog = (id = ANA) => request(app).get('/api/tarefas/backlog').set('Authorization', `Bearer ${token(id, 'user')}`);

  test('retorna a pendente sem responsavel e a legada sem user/status; fora as concluidas, em andamento e atribuidas', async () => {
    const res = await backlog();
    expect(res.status).toBe(200);
    expect(ids(res.body)).toEqual([hex(101), hex(107)]);
  });

  test('isolamento por equipe: Bruno ve o backlog de Alfa e Beta; quem nao e membro nao ve nada alheio', async () => {
    expect(ids((await backlog(BRUNO)).body)).toEqual([hex(101), hex(106), hex(107)]);
    expect(ids((await backlog(FORA)).body)).toEqual([hex(105)]);
  });

  test('a consulta aplica a regra oficial (user nulo/ausente e status pendente ou ausente), sem mudar status', async () => {
    await backlog();
    const filtro = Tarefa.find.mock.calls[0][0];
    expect(filtro).toEqual({
      equipe: { $in: [EQ_ALFA] },
      user: null,
      $or: [{ status: 'pendente' }, { status: { $exists: false } }],
    });
    expect(mockDb.tarefas.find((t) => t._id === hex(102)).status).toBe('concluido');
  });

  test('status null explicito nao entra no backlog; o campo ausente continua entrando', async () => {
    mockDb.tarefas.push(tarefa(8, { status: null }));
    const res = await backlog();
    expect(ids(res.body)).toEqual([hex(101), hex(107)]);
  });

  // Base da consistencia com o painel e o filtro administrativo (que leem status === 'pendente' no JSON): o modelo
  // real aplica o padrao 'pendente' ao campo ausente e mantem o null explicito, inclusive com a projecao do resumo.
  test('modelo real: status ausente vira "pendente" ao carregar, null explicito continua null', () => {
    const TarefaReal = jest.requireActual('../models/Tarefa');
    const base = { _id: hex(201), descricao: 'Antiga', equipe: EQ_ALFA, dataEntrega: new Date('2026-12-01T00:00:00Z') };
    expect(TarefaReal.hydrate({ ...base }).toObject().status).toBe('pendente');
    expect(TarefaReal.hydrate({ ...base }, { status: 1, user: 1 }).toObject().status).toBe('pendente');
    expect(TarefaReal.hydrate({ ...base, status: null }).toObject().status).toBeNull();
  });

  test('admin continua sem acesso ao backlog de colaborador (403)', async () => {
    const res = await request(app).get('/api/tarefas/backlog').set('Authorization', `Bearer ${token(ADMIN, 'admin')}`);
    expect(res.status).toBe(403);
  });
});

describe('GET /api/tarefas: contrato completo preservado e modo resumido', () => {
  const listar = (consulta = '') => request(app).get(`/api/tarefas${consulta}`).set('Authorization', `Bearer ${token(ADMIN, 'admin')}`);

  test('sem o parametro: resposta completa de sempre, com anexos assinados, detalhes, subtarefas e tags', async () => {
    const res = await listar();
    expect(res.status).toBe(200);
    expect(ids(res.body)).toEqual([hex(101), hex(102), hex(103), hex(104), hex(106), hex(107)]);
    const primeira = res.body.find((t) => t._id === hex(101));
    expect(primeira).toMatchObject({ detalhes: 'Detalhes internos 1', tags: ['interna'], subtarefas: [{ descricao: 'sub' }] });
    expect(primeira.anexos[0].url).toBe('https://storage.test/tarefas/1/arquivo.pdf?X-Goog-Signature=assinada');
    expect(primeira.equipe).toEqual({ _id: EQ_ALFA, nome: 'Alfa' });
    expect(getSignedUrl).toHaveBeenCalled();
    expect(Tarefa.find.mock.results.at(-1).value.select).not.toHaveBeenCalled();
  });

  test('resumo=1: so os campos dos indicadores, sem anexos nem URL assinada, com o mesmo escopo', async () => {
    const res = await listar('?resumo=1');
    expect(res.status).toBe(200);
    expect(ids(res.body)).toEqual([hex(101), hex(102), hex(103), hex(104), hex(106), hex(107)]);
    const primeira = res.body.find((t) => t._id === hex(101));
    expect(Object.keys(primeira).sort()).toEqual(
      ['_id', 'createdAt', 'dataEntrega', 'descricao', 'equipe', 'status', 'tempoGasto', 'urgencia', 'user'],
    );
    expect(primeira.equipe).toEqual({ _id: EQ_ALFA, nome: 'Alfa' });
    expect(res.body.find((t) => t._id === hex(104)).user).toEqual({ _id: BRUNO, nome: 'Bruno' });
    const texto = JSON.stringify(res.body);
    expect(texto).not.toMatch(/anexos|X-Goog-Signature|Detalhes internos|subtarefas|interna/);
    expect(getSignedUrl).not.toHaveBeenCalled();
  });

  test('resumo respeita os filtros existentes (equipe, user) e a autorizacao por equipe', async () => {
    expect(ids((await listar(`?resumo=1&equipe=${EQ_BETA}`)).body)).toEqual([hex(106)]);
    expect(ids((await listar(`?resumo=1&user=${BRUNO}`)).body)).toEqual([hex(104)]);
    // Equipe fora do escopo do admin: lista vazia, como no modo completo.
    expect((await listar(`?resumo=1&equipe=${EQ_ALHEIA}`)).body).toEqual([]);
    expect((await listar(`?equipe=${EQ_ALHEIA}`)).body).toEqual([]);
  });

  test.each([['resumo=true'], ['resumo=0'], ['resumo='], ['resumo=1&resumo=1'], ['resumo[$ne]=1']])(
    'valor invalido (%s): ignorado com seguranca, devolve a lista completa',
    async (consulta) => {
      const res = await listar(`?${consulta}`);
      expect(res.status).toBe(200);
      expect(res.body.find((t) => t._id === hex(101)).anexos).toHaveLength(1);
    },
  );

  test('colaborador nao usa a listagem administrativa, com ou sem resumo (403)', async () => {
    const res = await request(app).get('/api/tarefas?resumo=1').set('Authorization', `Bearer ${token(ANA, 'user')}`);
    expect(res.status).toBe(403);
    expect(Tarefa.find).not.toHaveBeenCalled();
  });
});

describe('GET /api/equipes: tipo dos participantes (aditivo)', () => {
  test('cada participante traz tipo, alem de nome, email e foto; demais campos inalterados', async () => {
    const res = await request(app).get('/api/equipes').set('Authorization', `Bearer ${token(ADMIN, 'admin')}`);
    expect(res.status).toBe(200);
    const alfa = res.body.find((e) => e._id === EQ_ALFA);
    expect(alfa.membros).toEqual([
      { _id: ADMIN, nome: 'Admin Teste', email: 'admin@exemplo.com', fotoPerfil: '', tipo: 'admin' },
      { _id: ANA, nome: 'Ana', email: 'ana@exemplo.com', fotoPerfil: '', tipo: 'user' },
      { _id: BRUNO, nome: 'Bruno', email: 'bruno@exemplo.com', fotoPerfil: '', tipo: 'user' },
    ]);
    expect(Equipe.find.mock.results.at(-1).value.populate).toHaveBeenCalledWith('membros', 'nome email fotoPerfil tipo');
    // So as equipes de que o admin e membro, como antes.
    expect(res.body.map((e) => e._id).sort()).toEqual([EQ_ALFA, EQ_BETA]);
  });
});
