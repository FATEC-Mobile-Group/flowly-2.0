// PUT /api/tarefas/:id/atribuir-para-mim com Idempotency-Key (opt-in): rotas reais, auth e sessionGuard reais,
// banco, transacao e Socket.IO simulados. O falso modela o que importa aqui:
// - trava de documento: escrita na transacao trava a tarefa; outra transacao recebe WriteConflict (transitorio,
//   repetido pelo withTransaction depois da trava sair); escrita fora de transacao ESPERA a trava, como no MongoDB;
// - o save() legado aplica o delta real do Mongoose (um $set sem condicao);
// - notificacoes com o insertMany real do model, isoladas por sessao ate o commit;
// - o Socket.IO registra cada emissao com o numero de commits e de transacoes abertas naquele instante.
// Nenhuma conexao real, nenhum indice criado.
const request = require('supertest');
const mongoose = require('mongoose');

jest.setTimeout(30000);

const mockFresh = () => ({
  users: [], equipes: [], tarefas: [], logs: [], notifications: [], keys: [], emits: [],
  updateCalls: [], legacySaves: [], logSaves: [], notificationInserts: [], equipeFindSessions: [], tarefaFindSessions: [],
  locks: new Map(), pausedUpdates: 0, pausedAfterLock: 0, pausedLegacySaves: 0, commits: 0, sessions: 0, openSessions: 0,
  conflicts: 0,
});
const mockDb = mockFresh();
const mockTx = {
  supported: true, indexes: null, failUpdate: null, failLogSave: null, failNotification: null,
  pauseUpdate: null, pauseAfterLock: null, pauseLegacySave: null, commitPlan: [],
};
const mockSame = (a, b) => a != null && b != null && String(a) === String(b);
const mockPlain = (value) => JSON.parse(JSON.stringify(value));
const mockLabeled = (message, label) => Object.assign(new Error(message), { errorLabels: [label] });
// Consulta encadeavel do Mongoose (select/session/populate) que so resolve quando aguardada.
const mockThenable = (produce, onSession) => {
  const state = { populates: [] };
  const query = {
    select: () => query,
    sort: () => query,
    populate: (path) => {
      state.populates.push(path);
      return query;
    },
    session: (session) => {
      if (onSession) onSession(session);
      return query;
    },
    then: (resolve, reject) => Promise.resolve().then(() => produce(state)).then(resolve, reject),
  };
  return query;
};
const mockMatches = (row, filter) =>
  Object.entries(filter).every(([field, condition]) => {
    if (field === '$or') return condition.some((alternativa) => mockMatches(row, alternativa));
    if (field === 'equipe' && condition && condition.$in) return condition.$in.some((value) => mockSame(value, row.equipe));
    if (condition === null) return row[field] == null; // { user: null } casa com null ou campo ausente
    if (condition && typeof condition === 'object' && '$exists' in condition) {
      return (row[field] !== undefined) === condition.$exists;
    }
    return mockSame(row[field], condition);
  });
const mockWaitUnlocked = async (row) => {
  while (row && mockDb.locks.has(row)) {
    await mockDb.locks.get(row).promise;
  }
};

jest.mock('@google-cloud/storage', () => ({
  Storage: jest.fn().mockImplementation(() => ({ bucket: jest.fn().mockReturnValue({ file: jest.fn() }) })),
}));
jest.mock('../services/storage', () => {
  let counter = 0;
  const bucket = { file: jest.fn() };
  bucket.getSignedUrl = jest.fn(async (path) => {
    counter += 1;
    return path ? `https://storage.test/${path}?X-Goog-Signature=sig${counter}` : '';
  });
  bucket.getObjectPath = jest.fn();
  bucket.verifyFileAccessToken = jest.fn();
  return bucket;
});
jest.mock('../utils/sendEmail', () => jest.fn().mockResolvedValue(true));
jest.mock('../utils/socketInstance', () => {
  const io = {
    to: (room) => ({
      emit: (event, payload) => {
        mockDb.emits.push({ room, event, payload: mockPlain(payload), commitsAtEmit: mockDb.commits, openSessions: mockDb.openSessions });
      },
    }),
  };
  return { setIo: jest.fn(), getIo: () => io };
});

jest.mock('../models/User', () => ({
  findById: jest.fn((id) => mockThenable(() => mockDb.users.find((user) => mockSame(user._id, id)) || null)),
  find: jest.fn(() => mockThenable(() => [])),
  findOne: jest.fn(() => mockThenable(() => null)),
}));

jest.mock('../models/Equipe', () => ({
  find: jest.fn((filter) => {
    const conditions = filter.$or || [{ membros: filter.membros }];
    return mockThenable(
      () => mockDb.equipes
        .filter((equipe) => conditions.some(
          (condition) =>
            (condition.membros && equipe.membros.some((id) => mockSame(id, condition.membros))) ||
            (condition.createdBy && mockSame(equipe.createdBy, condition.createdBy))
        ))
        .map((equipe) => ({ _id: equipe._id })),
      (session) => mockDb.equipeFindSessions.push(Boolean(session))
    );
  }),
  findById: jest.fn((id) => mockThenable(() => {
    const equipe = mockDb.equipes.find((item) => mockSame(item._id, id));
    return equipe ? mockPlain(equipe) : null;
  })),
  findOne: jest.fn(() => mockThenable(() => null)),
  updateMany: jest.fn(async () => ({})),
}));

jest.mock('../models/Tarefa', () => {
  const Real = jest.requireActual('../models/Tarefa');
  function Model(data) {
    return new Real(data);
  }
  const populated = (row, paths) => {
    const plain = mockPlain(row);
    if (paths.includes('user') && plain.user) {
      const user = mockDb.users.find((item) => mockSame(item._id, plain.user));
      plain.user = user ? { _id: user._id, nome: user.nome } : null;
    }
    if (paths.includes('equipe') && plain.equipe) {
      const equipe = mockDb.equipes.find((item) => mockSame(item._id, plain.equipe));
      plain.equipe = equipe ? { _id: equipe._id, nome: equipe.nome } : null;
    }
    return plain;
  };
  // Documento carregado pelo legado: save() aplica o delta real ($set sem condicao), esperando a trava de transacao.
  const hydrateRow = (row) => {
    const doc = Real.hydrate(mockPlain(row));
    doc.save = async () => {
      mockDb.legacySaves.push(true);
      if (mockTx.pauseLegacySave) {
        mockDb.pausedLegacySaves += 1;
        await mockTx.pauseLegacySave();
      }
      const delta = doc.$__delta();
      if (!delta) return doc;
      const [where, update] = delta;
      const current = mockDb.tarefas.find((item) => mockMatches(item, where));
      await mockWaitUnlocked(current);
      Object.entries(update.$set || {}).forEach(([path, value]) => {
        current[path] = mockPlain(value);
      });
      return doc;
    };
    return doc;
  };
  const query = (filter) => mockThenable(
    (state) => {
      const row = mockDb.tarefas.find((item) => mockMatches(item, filter));
      if (!row) return null;
      return state.populates.length ? populated(row, state.populates) : hydrateRow(row);
    },
    (session) => mockDb.tarefaFindSessions.push(Boolean(session))
  );
  Model.findOne = jest.fn((filter) => query(filter));
  Model.findById = jest.fn((id) => query({ _id: id }));
  Model.find = jest.fn(() => mockThenable(() => []));
  Model.updateOne = jest.fn(async (filter, update, options = {}) => {
    const { session } = options;
    mockDb.updateCalls.push({ withSession: Boolean(session), filter: mockPlain(filter), update: mockPlain(update) });
    if (mockTx.pauseUpdate) {
      mockDb.pausedUpdates += 1;
      await mockTx.pauseUpdate();
    }
    if (mockTx.failUpdate) throw mockTx.failUpdate;
    const row = mockDb.tarefas.find((item) => mockSame(item._id, filter._id));
    if (session && row) {
      const lock = mockDb.locks.get(row);
      if (lock && lock.session !== session) {
        mockDb.conflicts += 1;
        const conflict = mockLabeled('WriteConflict', 'TransientTransactionError');
        conflict.waitFor = lock.promise;
        throw conflict;
      }
    }
    if (!session) {
      // Fora de transacao (fluxo legado): como no MongoDB, espera a trava da transacao e SO ENTAO avalia o filtro
      // contra o estado confirmado; avaliacao e gravacao sao uma unica operacao atomica (sem await no meio).
      await mockWaitUnlocked(row);
      // A retomada depois do await e outra rodada: uma transacao pode ter travado a tarefa nesse intervalo.
      // Como no MongoDB, a escrita so avalia o filtro quando nao ha trava aberta.
      while (row && mockDb.locks.has(row)) await mockWaitUnlocked(row);
      if (!row || !mockMatches(row, filter)) return { matchedCount: 0, modifiedCount: 0 };
      Object.assign(row, mockPlain(update.$set || {}));
      return { matchedCount: 1, modifiedCount: 1 };
    }
    if (!row || !mockMatches(row, filter)) return { matchedCount: 0, modifiedCount: 0 };
    if (!mockDb.locks.has(row)) {
      let release;
      const promise = new Promise((resolve) => {
        release = resolve;
      });
      mockDb.locks.set(row, { session, promise, release });
      session.locked.push(row);
    }
    session.tarefaOps.push({ row, update: mockPlain(update) });
    if (mockTx.pauseAfterLock) {
      mockDb.pausedAfterLock += 1;
      await mockTx.pauseAfterLock(); // transacao aberta segurando a trava da tarefa
    }
    return { matchedCount: 1, modifiedCount: 1 };
  });
  return Model;
});

jest.mock('../models/ActivityLog', () => {
  const Real = jest.requireActual('../models/ActivityLog');
  function Model(data) {
    const doc = new Real(data);
    doc.save = async (options = {}) => {
      mockDb.logSaves.push({ withSession: Boolean(options.session) });
      await doc.validate();
      if (mockTx.failLogSave) throw mockTx.failLogSave;
      if (options.session) options.session.logs.push(doc.toObject());
      else mockDb.logs.push(doc.toObject());
      return doc;
    };
    return doc;
  }
  Model.find = jest.fn(() => mockThenable(() => []));
  return Model;
});

jest.mock('../models/Notification', () => {
  const Real = jest.requireActual('../models/Notification');
  return {
    insertMany: jest.fn(async (docs, options = {}) => {
      mockDb.notificationInserts.push({ withSession: Boolean(options.session) });
      if (mockTx.failNotification) throw mockTx.failNotification;
      const created = [];
      for (const data of docs) {
        const doc = new Real(data);
        await doc.validate();
        created.push(doc.toObject());
      }
      if (options.session) options.session.notifications.push(...created);
      else mockDb.notifications.push(...created);
      return created;
    }),
    find: jest.fn(() => mockThenable(() => [])),
  };
});

jest.mock('../models/IdempotencyKey', () => {
  const actual = jest.requireActual('../models/IdempotencyKey');
  const { matches } = require('./helpers/memoryModel');
  const clone = (value) => structuredClone(value);
  const viewOf = (row, session) => (session && session.keys.has(row) ? session.keys.get(row) : row);
  const applyUpdate = (doc, update) => {
    Object.assign(doc, clone(update.$set || {}));
    Object.keys(update.$unset || {}).forEach((name) => delete doc[name]);
    Object.entries(update.$inc || {}).forEach(([name, amount]) => {
      doc[name] = (Number(doc[name]) || 0) + amount;
    });
  };
  const fake = {
    create: jest.fn(async (data) => {
      if (mockDb.keys.some((row) => mockSame(row.userId, data.userId) && row.key === data.key)) {
        throw Object.assign(new Error('E11000 duplicate key error'), { code: 11000 });
      }
      const row = { _id: new (jest.requireActual('mongoose').Types.ObjectId)().toString(), ...clone(data) };
      mockDb.keys.push(row);
      return clone(row);
    }),
    findOne: jest.fn((filter) => ({ lean: async () => clone(mockDb.keys.find((row) => matches(row, filter)) || null) })),
    findOneAndUpdate: jest.fn((filter, update) => ({
      lean: async () => {
        const row = mockDb.keys.find((item) => matches(item, filter));
        if (row) applyUpdate(row, update);
        return row ? clone(row) : null;
      },
    })),
    updateOne: jest.fn(async (filter, update, options = {}) => {
      const { session } = options;
      const row = mockDb.keys.find((item) => matches(viewOf(item, session), filter));
      if (row) {
        if (session) {
          const copy = clone(viewOf(row, session));
          applyUpdate(copy, update);
          session.keys.set(row, copy);
        } else {
          applyUpdate(row, update);
        }
      }
      return { matchedCount: row ? 1 : 0, modifiedCount: row ? 1 : 0 };
    }),
    listIndexes: jest.fn(async () => {
      if (mockTx.indexes instanceof Error) throw mockTx.indexes;
      return clone(
        mockTx.indexes || [
          { key: { _id: 1 }, name: '_id_' },
          { key: { userId: 1, key: 1 }, name: 'user_key_unique', unique: true },
          { key: { expiresAt: 1 }, name: 'expires_at_ttl', expireAfterSeconds: 0 },
        ]
      );
    }),
  };
  Object.keys(actual)
    .filter((name) => /^[A-Z_]+$/.test(name))
    .forEach((name) => {
      fake[name] = actual[name];
    });
  return fake;
});

jest.mock('../utils/mongoTransactions', () => {
  const releaseLocks = (session) => {
    session.locked.forEach((row) => {
      const lock = mockDb.locks.get(row);
      if (lock && lock.session === session) {
        mockDb.locks.delete(row);
        lock.release();
      }
    });
    session.locked = [];
  };
  const rollback = (session) => {
    session.keys.clear();
    session.tarefaOps = [];
    session.logs = [];
    session.notifications = [];
    releaseLocks(session);
  };
  const commit = (session) => {
    session.keys.forEach((copy, row) => {
      Object.keys(row).forEach((name) => delete row[name]);
      Object.assign(row, copy);
    });
    session.tarefaOps.forEach(({ row, update }) => Object.assign(row, update.$set || {}));
    mockDb.logs.push(...session.logs);
    mockDb.notifications.push(...session.notifications);
    mockDb.commits += 1;
    rollback(session);
  };
  return {
    supportsTransactions: jest.fn(async () => mockTx.supported),
    resetTransactionSupportCache: jest.fn(),
    runInTransaction: jest.fn(async (work) => {
      for (let attempt = 1; attempt <= 5; attempt += 1) {
        mockDb.sessions += 1;
        mockDb.openSessions += 1;
        const session = { id: mockDb.sessions, keys: new Map(), tarefaOps: [], logs: [], notifications: [], locked: [] };
        try {
          let result;
          try {
            result = await work(session);
          } catch (err) {
            rollback(session);
            if (attempt < 5 && err?.errorLabels?.includes('TransientTransactionError')) {
              if (err.waitFor) await err.waitFor;
              continue;
            }
            throw err;
          }
          const plan = mockTx.commitPlan.shift() || null;
          if (plan === 'transient') {
            rollback(session);
            continue;
          }
          if (plan === 'unknown_not_applied') {
            rollback(session);
            throw mockLabeled('commit sem resposta', 'UnknownTransactionCommitResult');
          }
          if (plan === 'unknown_applied') {
            commit(session);
            throw mockLabeled('commit sem resposta', 'UnknownTransactionCommitResult');
          }
          commit(session);
          return result;
        } finally {
          mockDb.openSessions -= 1;
        }
      }
      throw mockLabeled('tentativas esgotadas', 'TransientTransactionError');
    }),
  };
});

const { issueAuthToken } = require('../utils/faceAuth');
const RealTarefa = jest.requireActual('../models/Tarefa');

const KEY = '3f1c2b6e-8a4d-4c1b-9e2f-7a6b5c4d3e2f';
const KEY_2 = '9d8c7b6a-5f4e-4d3c-8b2a-1f0e9d8c7b6a';
const SEM_EQUIPES_404 = { erro: 'Tarefa nÃ£o encontrada' };
const TAREFA_404 = { erro: 'Tarefa não encontrada' };
const JA_ATRIBUIDA_409 = { erro: 'Esta tarefa já possui responsável' };
// Condicao da gravacao: sem responsavel (nulo ou ausente) e pendente (ou status ausente, lido como pendente).
const BACKLOG_DISPONIVEL = { user: null, $or: [{ status: 'pendente' }, { status: { $exists: false } }] };
const FORA_DO_BACKLOG_409 = { erro: 'Esta tarefa não está disponível no backlog: apenas tarefas pendentes e sem responsável podem ser assumidas.' };
const id = () => new mongoose.Types.ObjectId().toString();
const keysOf = (value) => Object.keys(value).sort();

const loadApp = () => {
  let app;
  jest.isolateModules(() => {
    app = require('../app');
  });
  return app;
};

const withGate = async (pauseKey, run) => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  mockTx[pauseKey] = () => gate;
  const pending = [];
  try {
    return await run({ pending, release: () => release() });
  } finally {
    mockTx[pauseKey] = null;
    release();
    await Promise.all(pending.map((promise) => promise.catch(() => {})));
  }
};
const waitFor = async (predicate, label) => {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`tempo esgotado esperando: ${label}`);
    await new Promise((resolve) => setImmediate(resolve));
  }
};

describe('PUT /api/tarefas/:id/atribuir-para-mim com Idempotency-Key', () => {
  let app;
  let admin;
  let pessoaA;
  let pessoaB;
  let pessoaFora;
  let equipe;
  let tarefa;
  let tokenA;
  let tokenB;

  const put = ({ key, token = tokenA, tarefaId = tarefa._id } = {}) => {
    const req = request(app).put(`/api/tarefas/${tarefaId}/atribuir-para-mim`).set('Authorization', `Bearer ${token}`);
    if (key !== undefined) req.set('Idempotency-Key', key);
    return req.send();
  };

  beforeEach(() => {
    Object.keys(mockDb).forEach((name) => {
      const value = mockFresh()[name];
      if (Array.isArray(value)) mockDb[name].splice(0, mockDb[name].length);
      else if (value instanceof Map) mockDb[name].clear();
      else mockDb[name] = value;
    });
    Object.assign(mockTx, {
      supported: true, indexes: null, failUpdate: null, failLogSave: null, failNotification: null,
      pauseUpdate: null, pauseAfterLock: null, pauseLegacySave: null, commitPlan: [],
    });
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'log').mockImplementation(() => {});

    admin = { _id: id(), nome: 'Admin Ficticio', tipo: 'admin', authVersion: 0 };
    pessoaA = { _id: id(), nome: 'Pessoa A', tipo: 'user', authVersion: 0 };
    pessoaB = { _id: id(), nome: 'Pessoa B', tipo: 'user', authVersion: 0 };
    pessoaFora = { _id: id(), nome: 'Pessoa de Fora', tipo: 'user', authVersion: 0 };
    mockDb.users.push(admin, pessoaA, pessoaB, pessoaFora);
    equipe = { _id: id(), nome: 'Equipe Alfa', createdBy: admin._id, membros: [pessoaA._id, pessoaB._id] };
    mockDb.equipes.push(equipe);
    tarefa = {
      ...mockPlain(new RealTarefa({
        descricao: 'Relatório', dataEntrega: new Date('2026-12-15T00:00:00.000Z'), equipe: equipe._id, createdBy: admin._id,
      }).toObject()),
      __v: 0,
    };
    mockDb.tarefas.push(tarefa);
    tokenA = issueAuthToken(pessoaA);
    tokenB = issueAuthToken(pessoaB);
    app = loadApp();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('1. sem o cabecalho: atribuicao condicional sem transacao; log e notificacao do legado (emissao imediata)', async () => {
    const response = await put();
    expect(response.status).toBe(200);
    expect(response.body.msg).toBe('Tarefa atribuída com sucesso');
    expect(response.body.tarefa.user).toEqual({ _id: pessoaA._id, nome: 'Pessoa A' });
    expect(response.headers['idempotency-replayed']).toBeUndefined();
    expect(tarefa.user).toBe(pessoaA._id);
    expect(mockDb.legacySaves).toEqual([]); // nada de save() sem condicao
    expect(mockDb.updateCalls).toEqual([{
      withSession: false,
      filter: { _id: tarefa._id, equipe: equipe._id, ...BACKLOG_DISPONIVEL },
      update: { $set: { user: pessoaA._id } },
    }]);
    expect(mockDb.logSaves).toEqual([{ withSession: false }]);
    expect(mockDb.notificationInserts).toEqual([{ withSession: false }]);
    expect(mockDb.emits).toHaveLength(1);
    expect(mockDb.keys).toHaveLength(0);
    expect(mockDb.sessions).toBe(0);
    expect((await put()).status).toBe(409); // ja atribuida: mesma resposta de hoje
  });

  test('chave valida: atribuicao condicional, log e notificacao na transacao; emissao so depois do commit', async () => {
    const response = await put({ key: KEY });
    expect(response.status).toBe(200);
    expect(response.body.msg).toBe('Tarefa atribuída com sucesso');
    expect(response.body.tarefa.user).toEqual({ _id: pessoaA._id, nome: 'Pessoa A' });
    expect(response.body.tarefa.equipe).toEqual({ _id: equipe._id, nome: 'Equipe Alfa' });
    expect(tarefa.user).toBe(pessoaA._id);

    expect(mockDb.legacySaves).toEqual([]);
    expect(mockDb.updateCalls).toHaveLength(1);
    expect(mockDb.updateCalls[0]).toEqual({
      withSession: true,
      filter: { _id: tarefa._id, equipe: equipe._id, ...BACKLOG_DISPONIVEL },
      update: { $set: { user: pessoaA._id } },
    });
    expect(mockDb.equipeFindSessions).toEqual([true]);
    expect(mockDb.tarefaFindSessions).toEqual([true]);
    expect(mockDb.logSaves).toEqual([{ withSession: true }]);
    expect(mockDb.notificationInserts).toEqual([{ withSession: true }]);
    expect(mockDb.logs).toHaveLength(1);
    expect(mockDb.notifications).toHaveLength(1);
    expect(String(mockDb.notifications[0].user)).toBe(admin._id);
    expect(mockDb.notifications[0].texto).toBe('Pessoa A pegou a tarefa "Relatório" do backlog');

    expect(mockDb.emits).toHaveLength(1);
    expect(mockDb.emits[0]).toMatchObject({ room: `user_${admin._id}`, event: 'notification_created', commitsAtEmit: 1, openSessions: 0 });
    expect(mockDb.emits[0].payload._id).toBe(String(mockDb.notifications[0]._id));
    expect(mockDb.keys[0]).toMatchObject({
      userId: pessoaA._id, key: KEY, method: 'PUT', route: '/api/tarefas/:id/atribuir-para-mim', status: 'completed',
      result: { statusCode: 200, resourceType: 'tarefa', resourceId: tarefa._id },
    });
  });

  test('repeticao da mesma chave: mesma resposta, sem nova gravacao, log, notificacao ou emissao', async () => {
    const first = await put({ key: KEY });
    for (let i = 0; i < 3; i += 1) {
      const again = await put({ key: KEY.toUpperCase() });
      expect(again.status).toBe(200);
      expect(again.headers['idempotency-replayed']).toBe('true');
      expect(again.body).toEqual(first.body);
    }
    expect(mockDb.updateCalls).toHaveLength(1);
    expect(mockDb.logs).toHaveLength(1);
    expect(mockDb.notifications).toHaveLength(1);
    expect(mockDb.emits).toHaveLength(1);
  });

  test('duas pessoas ao mesmo tempo: so uma assume; a outra recebe 409 e nada dela fica gravado', async () => {
    const responses = await withGate('pauseUpdate', async ({ pending, release }) => {
      const a = put({ key: KEY, token: tokenA }).then((response) => response);
      const b = put({ key: KEY_2, token: tokenB }).then((response) => response);
      pending.push(a, b);
      // As duas ja leram a tarefa sem responsavel e estao na gravacao.
      await waitFor(() => mockDb.pausedUpdates === 2, 'as duas atribuicoes pausadas na gravacao');
      mockTx.pauseUpdate = null;
      release();
      return Promise.all([a, b]);
    });
    const statuses = responses.map((response) => response.status).sort();
    expect(statuses).toEqual([200, 409]);
    const vencedora = responses.find((response) => response.status === 200);
    const perdedora = responses.find((response) => response.status === 409);
    expect(perdedora.body).toEqual(JA_ATRIBUIDA_409);
    expect(tarefa.user).toBe(vencedora.body.tarefa.user._id); // ninguem sobrescreveu
    expect(mockDb.conflicts).toBeGreaterThan(0); // a segunda bateu na trava e repetiu
    expect(mockDb.logs).toHaveLength(1);
    expect(mockDb.notifications).toHaveLength(1);
    expect(mockDb.emits).toHaveLength(1);
  });

  test('tarefa ja atribuida (a outra pessoa ou a si mesma): 409 guardado, repetido sem consultar de novo', async () => {
    tarefa.user = pessoaB._id;
    const first = await put({ key: KEY });
    expect(first.status).toBe(409);
    expect(first.body).toEqual(JA_ATRIBUIDA_409);
    const consultas = mockDb.tarefaFindSessions.length;
    const again = await put({ key: KEY });
    expect(again.status).toBe(409);
    expect(again.headers['idempotency-replayed']).toBe('true');
    expect(mockDb.tarefaFindSessions).toHaveLength(consultas);
    expect(tarefa.user).toBe(pessoaB._id);
    expect(mockDb.keys[0]).toMatchObject({ status: 'failed', failure: { statusCode: 409, code: 'tarefa_ja_atribuida' } });

    tarefa.user = pessoaA._id; // ja e de quem pede: mesma resposta do legado (409)
    expect((await put({ key: KEY_2 })).body).toEqual(JA_ATRIBUIDA_409);
    expect(mockDb.logs).toHaveLength(0);
    expect(mockDb.emits).toHaveLength(0);
  });

  test('3. legado primeiro, protegido depois: o protegido recebe 409 e nao sobrescreve nem deixa rastro', async () => {
    expect((await put({ token: tokenB })).status).toBe(200); // legado, sem cabecalho
    const protegido = await put({ key: KEY, token: tokenA });
    expect(protegido.status).toBe(409);
    expect(protegido.body).toEqual(JA_ATRIBUIDA_409);
    esperarSoAVencedora(pessoaB);
  });

  // A requisicao perdedora nao pode deixar rastro: nem responsavel, nem log, nem notificacao, nem emissao.
  const esperarSoAVencedora = (vencedor) => {
    expect(tarefa.user).toBe(vencedor._id);
    expect(mockDb.logs).toHaveLength(1);
    expect(String(mockDb.logs[0].user)).toBe(vencedor._id);
    expect(mockDb.notifications).toHaveLength(1);
    expect(mockDb.notifications[0].texto).toBe(`${vencedor.nome} pegou a tarefa "Relatório" do backlog`);
    expect(mockDb.emits).toHaveLength(1);
  };

  test('2. duas requisicoes legadas simultaneas: so uma assume; a outra recebe 409 sem log nem notificacao', async () => {
    const responses = await withGate('pauseUpdate', async ({ pending, release }) => {
      const a = put({ token: tokenA }).then((response) => response);
      const b = put({ token: tokenB }).then((response) => response);
      pending.push(a, b);
      // As duas ja leram a tarefa sem responsavel e passaram nas conferencias: estao na gravacao.
      await waitFor(() => mockDb.pausedUpdates === 2, 'as duas legadas pausadas na gravacao');
      mockTx.pauseUpdate = null;
      release();
      return Promise.all([a, b]);
    });
    expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
    const perdedora = responses.find((response) => response.status === 409);
    expect(perdedora.body).toEqual(JA_ATRIBUIDA_409);
    const vencedora = responses.find((response) => response.status === 200);
    esperarSoAVencedora(vencedora.body.tarefa.user._id === pessoaA._id ? pessoaA : pessoaB);
    expect(mockDb.legacySaves).toEqual([]);
  });

  test('4. protegido primeiro, legado depois: o legado recebe 409 e nao sobrescreve', async () => {
    expect((await put({ key: KEY, token: tokenA })).status).toBe(200);
    const legado = await put({ token: tokenB });
    expect(legado.status).toBe(409);
    expect(legado.body).toEqual(JA_ATRIBUIDA_409);
    esperarSoAVencedora(pessoaA);
  });

  test('5. legado que leu antes do commit protegido e grava depois: 409, sem sobrescrever nem deixar rastro', async () => {
    const legado = await withGate('pauseUpdate', async ({ pending, release }) => {
      const run = put({ token: tokenB }).then((response) => response);
      pending.push(run);
      // O legado ja leu a tarefa sem responsavel e parou na hora de gravar.
      await waitFor(() => mockDb.pausedUpdates === 1, 'legado pausado depois de ler a tarefa');
      mockTx.pauseUpdate = null;
      const protegido = await put({ key: KEY, token: tokenA });
      expect(protegido.status).toBe(200);
      expect(tarefa.user).toBe(pessoaA._id);
      release();
      return run;
    });
    expect(legado.status).toBe(409);
    expect(legado.body).toEqual(JA_ATRIBUIDA_409);
    esperarSoAVencedora(pessoaA);
    const replay = await put({ key: KEY, token: tokenA }); // a atribuicao protegida continua valendo
    expect(replay.status).toBe(200);
    expect(replay.headers['idempotency-replayed']).toBe('true');
  });

  test('5b. legado grava enquanto a transacao protegida segura a tarefa: espera o commit e recebe 409', async () => {
    const legado = await withGate('pauseAfterLock', async ({ pending, release }) => {
      const protegido = put({ key: KEY, token: tokenA }).then((response) => response);
      pending.push(protegido);
      await waitFor(() => mockDb.pausedAfterLock === 1, 'transacao protegida segurando a trava');
      const run = put({ token: tokenB }).then((response) => response);
      pending.push(run);
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(tarefa.user).toBeNull(); // o legado esta esperando a trava, nao gravou nada
      release();
      expect((await protegido).status).toBe(200);
      return run;
    });
    expect(legado.status).toBe(409);
    esperarSoAVencedora(pessoaA);
  });

  test('5c. protegido le, legado grava antes dele, protegido grava depois: 409 sem sobrescrever', async () => {
    const protegido = await withGate('pauseUpdate', async ({ pending, release }) => {
      const run = put({ key: KEY, token: tokenA }).then((response) => response);
      pending.push(run);
      // O protegido ja leu a tarefa sem responsavel (dentro da transacao) e parou antes de gravar.
      await waitFor(() => mockDb.pausedUpdates === 1, 'protegido pausado entre a leitura e a gravacao');
      mockTx.pauseUpdate = null;
      expect((await put({ token: tokenB })).status).toBe(200); // legado grava primeiro
      release();
      return run;
    });
    expect(protegido.status).toBe(409);
    expect(protegido.body).toEqual(JA_ATRIBUIDA_409);
    esperarSoAVencedora(pessoaB); // responsavel, log, notificacao e emissao so da vencedora (legado)
  });

  test('9. erro real do banco na gravacao legada: 500, nunca confundido com tarefa ja atribuida', async () => {
    mockTx.failUpdate = new Error('conexao perdida /tmp/segredo');
    const response = await put();
    expect(response.status).toBe(500);
    expect(response.body).toEqual({ erro: 'Erro ao atribuir tarefa' });
    expect(JSON.stringify(response.body)).not.toContain('segredo');
    expect(tarefa.user).toBeNull();
    expect(mockDb.logs).toHaveLength(0);
    expect(mockDb.notifications).toHaveLength(0);
    expect(mockDb.emits).toHaveLength(0);
    mockTx.failUpdate = null;
    expect((await put()).status).toBe(200); // depois do erro, a atribuicao segue normal
  });

  test('8. legado preserva autorizacao e participacao: sem acesso 404, admin 403, token invalido/revogado 401', async () => {
    const tokenFora = issueAuthToken(pessoaFora);
    expect((await put({ token: tokenFora })).body).toEqual(SEM_EQUIPES_404);
    mockDb.equipes.push({ _id: id(), nome: 'Outra', createdBy: admin._id, membros: [pessoaFora._id] });
    expect((await put({ token: tokenFora })).body).toEqual(TAREFA_404);
    expect((await put({ token: issueAuthToken(admin) })).status).toBe(403);
    expect((await put({ token: 'nao-e-um-jwt' })).status).toBe(401);
    const revoked = tokenA;
    pessoaA.authVersion = 1;
    expect((await put({ token: revoked })).status).toBe(401);
    expect(mockDb.updateCalls).toEqual([]); // nada chegou a gravar
    expect(tarefa.user).toBeNull();
  });

  test('usuario sem acesso: sem equipes 404, com equipes mas fora desta 404; admin 403; token invalido/revogado 401', async () => {
    const tokenFora = issueAuthToken(pessoaFora);
    expect((await put({ key: KEY, token: tokenFora })).body).toEqual(SEM_EQUIPES_404);
    mockDb.equipes.push({ _id: id(), nome: 'Outra', createdBy: admin._id, membros: [pessoaFora._id] });
    const semTarefa = await put({ key: KEY_2, token: tokenFora });
    expect(semTarefa.status).toBe(404);
    expect(semTarefa.body).toEqual(TAREFA_404);
    expect((await put({ key: KEY, token: issueAuthToken(admin) })).status).toBe(403); // isUser
    expect((await put({ key: KEY, token: 'nao-e-um-jwt' })).status).toBe(401);
    const revoked = tokenA;
    pessoaA.authVersion = 1;
    expect((await put({ key: KEY, token: revoked })).status).toBe(401);
    expect(tarefa.user).toBeNull();
    expect(mockDb.logs).toHaveLength(0);
    expect(mockDb.notifications).toHaveLength(0);
    expect(mockDb.emits).toHaveLength(0);
  });

  test('falha ao gravar a atribuicao: rollback completo, sem emissao; a mesma chave atribui uma vez depois', async () => {
    mockTx.failUpdate = new Error('falha interna /tmp/segredo');
    const failed = await put({ key: KEY });
    expect(failed.status).toBe(500);
    expect(failed.body).toEqual({ erro: 'Erro ao atribuir tarefa' });
    expect(JSON.stringify(failed.body)).not.toContain('segredo');
    expect(tarefa.user).toBeNull();
    expect(mockDb.logs).toHaveLength(0);
    expect(mockDb.notifications).toHaveLength(0);
    expect(mockDb.emits).toHaveLength(0);
    expect(mockDb.keys[0]).toMatchObject({ status: 'failed', failure: { retryable: true } });

    mockTx.failUpdate = null;
    expect((await put({ key: KEY })).status).toBe(200);
    expect(tarefa.user).toBe(pessoaA._id);
    expect(mockDb.notifications).toHaveLength(1);
    expect(mockDb.emits).toHaveLength(1);
  });

  test('falha ao registrar a atividade: a atribuicao volta; nenhuma notificacao gravada ou emitida', async () => {
    mockTx.failLogSave = new Error('log fora do ar');
    expect((await put({ key: KEY })).status).toBe(500);
    expect(mockDb.updateCalls).toHaveLength(1); // a atribuicao chegou a ser feita na sessao...
    expect(tarefa.user).toBeNull(); // ...e foi desfeita
    expect(mockDb.logs).toHaveLength(0);
    expect(mockDb.notifications).toHaveLength(0);
    expect(mockDb.emits).toHaveLength(0);
    expect(mockDb.keys[0].status).not.toBe('completed');
  });

  test('falha ao gravar a notificacao: atribuicao e log voltam; nada e emitido', async () => {
    mockTx.failNotification = new Error('notificacao fora do ar');
    expect((await put({ key: KEY })).status).toBe(500);
    expect(mockDb.notificationInserts).toEqual([{ withSession: true }]);
    expect(tarefa.user).toBeNull();
    expect(mockDb.logs).toHaveLength(0);
    expect(mockDb.notifications).toHaveLength(0);
    expect(mockDb.emits).toHaveLength(0);

    mockTx.failNotification = null;
    expect((await put({ key: KEY })).status).toBe(200);
    expect(tarefa.user).toBe(pessoaA._id);
    expect(mockDb.logs).toHaveLength(1);
    expect(mockDb.notifications).toHaveLength(1);
    expect(mockDb.emits).toHaveLength(1);
  });

  test('conflito transitorio: o callback roda de novo, mas grava e emite uma unica vez', async () => {
    mockTx.commitPlan = ['transient', 'transient'];
    expect((await put({ key: KEY })).status).toBe(200);
    expect(mockDb.updateCalls).toHaveLength(3);
    expect(mockDb.notificationInserts).toHaveLength(3); // tentativas abortadas tambem gravaram na sessao...
    expect(mockDb.notifications).toHaveLength(1); // ...mas so a que entrou ficou
    expect(mockDb.logs).toHaveLength(1);
    expect(mockDb.emits).toHaveLength(1);
    expect(mockDb.emits[0]).toMatchObject({ commitsAtEmit: 1, openSessions: 0 });
    expect(mockDb.emits[0].payload._id).toBe(String(mockDb.notifications[0]._id)); // emite a que foi gravada
  });

  test('resultado desconhecido do commit: sem confirmacao nada e emitido nem repetido; se entrou, emite uma vez', async () => {
    mockTx.commitPlan = ['unknown_not_applied'];
    const unknown = await put({ key: KEY });
    expect(unknown.status).toBe(409);
    expect(unknown.body.code).toBe('idempotency_outcome_unknown');
    expect((await put({ key: KEY })).status).toBe(409);
    expect(tarefa.user).toBeNull();
    expect(mockDb.emits).toHaveLength(0);

    mockTx.commitPlan = ['unknown_applied'];
    expect((await put({ key: KEY_2 })).status).toBe(200);
    expect((await put({ key: KEY_2 })).headers['idempotency-replayed']).toBe('true');
    expect(tarefa.user).toBe(pessoaA._id);
    expect(mockDb.notifications).toHaveLength(1);
    expect(mockDb.emits).toHaveLength(1);
  });

  test('sem transacoes ou sem o indice unico: 503 sem atribuir; o fluxo sem cabecalho segue funcionando', async () => {
    mockTx.supported = false;
    const semTx = await put({ key: KEY });
    expect(semTx.status).toBe(503);
    expect(semTx.body).toEqual({ erro: 'Serviço temporariamente indisponível.', code: 'transactions_unavailable' });
    expect(semTx.headers['retry-after']).toBe('2');
    expect(tarefa.user).toBeNull();
    mockTx.supported = true;

    for (const indexes of [[{ key: { _id: 1 }, name: '_id_' }], new Error('ns not found')]) {
      mockTx.indexes = indexes;
      app = loadApp();
      const response = await put({ key: KEY });
      expect(response.status).toBe(503);
      expect(response.body.code).toBe('idempotency_unavailable');
    }
    expect(tarefa.user).toBeNull();
    expect(mockDb.keys).toHaveLength(0);
    expect((await put()).status).toBe(200);
  });

  test('permissoes alteradas antes da repeticao: saiu da equipe, sessao revogada, papel mudou, reatribuida', async () => {
    expect((await put({ key: KEY })).status).toBe(200);

    equipe.membros = [pessoaB._id]; // saiu da equipe
    const semAcesso = await put({ key: KEY });
    expect(semAcesso.status).toBe(404);
    expect(JSON.stringify(semAcesso.body)).not.toContain('Relatório');
    equipe.membros = [pessoaA._id, pessoaB._id];

    pessoaA.tipo = 'admin'; // papel mudou: token antigo cai na sessao (401); token novo cai no isUser (403)
    expect((await put({ key: KEY })).status).toBe(401);
    expect((await put({ key: KEY, token: issueAuthToken(pessoaA) })).status).toBe(403);
    pessoaA.tipo = 'user';

    tarefa.user = pessoaB._id; // reatribuida a outra pessoa depois
    const reatribuida = await put({ key: KEY });
    expect(reatribuida.status).toBe(409);
    expect(reatribuida.body).toEqual(JA_ATRIBUIDA_409);
    expect(tarefa.user).toBe(pessoaB._id);

    expect(mockDb.updateCalls).toHaveLength(1);
    expect(mockDb.logs).toHaveLength(1);
    expect(mockDb.emits).toHaveLength(1);
  });

  test('sem admin para notificar: atribui sem notificacao nem emissao', async () => {
    tarefa.createdBy = null;
    equipe.createdBy = null;
    expect((await put({ key: KEY })).status).toBe(200);
    expect(mockDb.notificationInserts).toEqual([]);
    expect(mockDb.emits).toEqual([]);
    expect(mockDb.logs).toHaveLength(1);
  });

  test('resposta igual ao legado; nada da tarefa ou da notificacao no registro da chave', async () => {
    const outra = { ...mockPlain(tarefa), _id: id(), user: null };
    mockDb.tarefas.push(outra);
    const legado = await put({ tarefaId: outra._id, token: tokenB });
    const protegido = await put({ key: KEY });
    expect(keysOf(protegido.body)).toEqual(keysOf(legado.body));
    expect(keysOf(protegido.body.tarefa)).toEqual(keysOf(legado.body.tarefa));
    expect(keysOf(protegido.body.tarefa.user)).toEqual(keysOf(legado.body.tarefa.user));
    expect(keysOf(protegido.body.tarefa.equipe)).toEqual(keysOf(legado.body.tarefa.equipe));
    const stored = JSON.stringify(mockDb.keys);
    for (const text of ['Relatório', 'Pessoa A', 'pegou a tarefa', 'Equipe Alfa', 'Bearer']) {
      expect(stored).not.toContain(text);
    }
  });

  test('ID malformado e chave invalida: respostas antes da chave, sem cair no legado', async () => {
    const malformado = await put({ key: KEY, tarefaId: 'nao-e-id' });
    expect(malformado.status).toBe(404);
    expect(malformado.body).toEqual(TAREFA_404);
    for (const key of ['', 'abc', `${KEY}, ${KEY_2}`]) {
      const response = await put({ key });
      expect(response.status).toBe(400);
      expect(response.body).toEqual({ erro: 'Chave de idempotência inválida.', code: 'idempotency_key_invalid' });
    }
    expect(mockDb.keys).toHaveLength(0);
    expect(mockDb.legacySaves).toHaveLength(0);
    expect(tarefa.user).toBeNull();
  });

  // Elegibilidade do backlog (PR #63): so tarefa sem responsavel E pendente pode ser assumida, nos dois caminhos.
  describe('elegibilidade: so tarefa pendente e sem responsavel', () => {
    const semRastro = () => {
      expect(tarefa.user).toBeNull();
      expect(mockDb.logs).toHaveLength(0);
      expect(mockDb.notifications).toHaveLength(0);
      expect(mockDb.notificationInserts).toHaveLength(0);
      expect(mockDb.emits).toHaveLength(0);
    };

    test.each([['concluido'], ['em_andamento']])('tarefa %s sem responsavel: 409 nos dois caminhos, status intacto', async (status) => {
      tarefa.status = status;
      const legado = await put();
      expect(legado.status).toBe(409);
      expect(legado.body).toEqual(FORA_DO_BACKLOG_409);
      const protegido = await put({ key: KEY });
      expect(protegido.status).toBe(409);
      expect(protegido.body).toEqual(FORA_DO_BACKLOG_409);
      expect(mockDb.keys[0]).toMatchObject({ status: 'failed', failure: { statusCode: 409, code: 'tarefa_fora_do_backlog' } });
      // Repeticao da chave: mesma resposta guardada, sem consultar nem gravar de novo.
      const repetido = await put({ key: KEY });
      expect(repetido.status).toBe(409);
      expect(repetido.body).toEqual(FORA_DO_BACKLOG_409);
      expect(repetido.headers['idempotency-replayed']).toBe('true');
      expect(mockDb.updateCalls).toEqual([]); // recusada antes de qualquer gravacao
      expect(tarefa.status).toBe(status);
      semRastro();
    });

    test('tarefa legada sem os campos user e status: continua podendo ser assumida (status nao e alterado)', async () => {
      delete tarefa.user;
      delete tarefa.status;
      const response = await put({ key: KEY });
      expect(response.status).toBe(200);
      expect(tarefa.user).toBe(pessoaA._id);
      expect(tarefa).not.toHaveProperty('status');
      expect(mockDb.logs).toHaveLength(1);
      expect(mockDb.emits).toHaveLength(1);
    });

    test.each([['sem cabecalho', undefined], ['com Idempotency-Key', KEY]])(
      'status muda entre a leitura e a gravacao (%s): 409 de fora do backlog, sem atribuir nem deixar rastro',
      async (_caso, key) => {
        const response = await withGate('pauseUpdate', async ({ pending, release }) => {
          const pedido = put({ key }).then((r) => r);
          pending.push(pedido);
          // Ja passou nas conferencias com a tarefa pendente e esta na gravacao condicional.
          await waitFor(() => mockDb.pausedUpdates === 1, 'atribuicao pausada na gravacao');
          tarefa.status = 'em_andamento'; // o admin ou outro fluxo mudou o status nesse meio-tempo
          mockTx.pauseUpdate = null;
          release();
          return pedido;
        });
        expect(response.status).toBe(409);
        expect(response.body).toEqual(FORA_DO_BACKLOG_409);
        expect(tarefa.status).toBe('em_andamento');
        semRastro();
      }
    );

    test('atribuicao concorrente com a gravacao condicional nova: perdedora continua recebendo "ja possui responsavel"', async () => {
      const responses = await withGate('pauseUpdate', async ({ pending, release }) => {
        const a = put({ token: tokenA }).then((r) => r);
        const b = put({ key: KEY_2, token: tokenB }).then((r) => r);
        pending.push(a, b);
        await waitFor(() => mockDb.pausedUpdates === 2, 'as duas pausadas na gravacao');
        mockTx.pauseUpdate = null;
        release();
        return Promise.all([a, b]);
      });
      expect(responses.map((r) => r.status).sort()).toEqual([200, 409]);
      expect(responses.find((r) => r.status === 409).body).toEqual(JA_ATRIBUIDA_409);
      expect(mockDb.logs).toHaveLength(1);
      expect(mockDb.notifications).toHaveLength(1);
    });

    test('status null explicito: nao elegivel nos dois caminhos (so o campo ausente conta como pendente)', async () => {
      tarefa.status = null;
      for (const key of [undefined, KEY]) {
        const response = await put({ key });
        expect(response.status).toBe(409);
        expect(response.body).toEqual(FORA_DO_BACKLOG_409);
      }
      expect(mockDb.updateCalls).toEqual([]);
      expect(tarefa.status).toBeNull();
      semRastro();
    });

    // Releitura depois da gravacao recusada: so dentro do escopo autorizado e da mesma equipe; fora dele, conflito
    // generico, sem dizer se a tarefa existe, quem a assumiu ou em que estado ficou.
    const CONFLITO_GENERICO_409 = { erro: 'A tarefa foi alterada por outra operação ao mesmo tempo. Tente novamente.' };
    test.each([
      ['excluida', () => { mockDb.tarefas.splice(mockDb.tarefas.indexOf(tarefa), 1); }],
      ['movida para outra equipe (e assumida la)', () => {
        const outra = { _id: id(), nome: 'Equipe Beta', createdBy: admin._id, membros: [pessoaA._id, pessoaB._id] };
        mockDb.equipes.push(outra);
        tarefa.equipe = outra._id;
        tarefa.user = pessoaB._id;
      }],
      ['quem pede saiu da equipe', () => { equipe.membros = [pessoaB._id]; tarefa.user = pessoaB._id; }],
    ])('tarefa %s durante a gravacao: 409 generico nos dois caminhos, sem revelar o motivo', async (_caso, alterar) => {
      for (const key of [undefined, KEY]) {
        const response = await withGate('pauseUpdate', async ({ pending, release }) => {
          const pedido = put({ key }).then((r) => r);
          pending.push(pedido);
          await waitFor(() => mockDb.pausedUpdates >= 1, 'atribuicao pausada na gravacao');
          alterar();
          mockTx.pauseUpdate = null;
          release();
          return pedido;
        });
        expect(response.status).toBe(409);
        expect(response.body).toEqual(CONFLITO_GENERICO_409);
        expect(JSON.stringify(response.body)).not.toMatch(/responsável|backlog|Pessoa|Beta/);
        // Reinicia o cenario para o segundo caminho.
        mockDb.pausedUpdates = 0;
        if (!mockDb.tarefas.includes(tarefa)) mockDb.tarefas.push(tarefa);
        tarefa.equipe = equipe._id;
        tarefa.user = null;
        equipe.membros = [pessoaA._id, pessoaB._id];
      }
      expect(mockDb.keys[0]).toMatchObject({ status: 'failed', failure: { statusCode: 409, code: 'tarefa_alterada' } });
      expect(mockDb.logs).toHaveLength(0);
      expect(mockDb.notifications).toHaveLength(0);
      expect(mockDb.emits).toHaveLength(0);
    });
  });
});
