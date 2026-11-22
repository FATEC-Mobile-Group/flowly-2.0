// POST /api/tarefas/:id/subtarefas com Idempotency-Key (opt-in): rotas reais, auth e sessionGuard reais, banco e
// transacao em memoria. Tarefa usa documentos Mongoose REAIS: o save() legado aplica o delta que o proprio
// Mongoose gera ($push/$set/$inc, com o filtro de _id e __v), e o updateOne protegido e aplicado no commit como
// operacao sobre o documento ATUAL (como o servidor faz com $push). Assim inclusoes concorrentes e o controle
// de versao do legado sao exercitados de verdade. Nenhuma conexao real, nenhum indice criado.
const request = require('supertest');
const mongoose = require('mongoose');

jest.setTimeout(30000);

const mockFresh = () => ({
  users: [], equipes: [], tarefas: [], logs: [], keys: [],
  updateCalls: [], legacySaves: [], logSaves: [], equipeFindSessions: [], equipeFinds: 0,
  pausedUpdates: 0, pausedLegacySaves: 0, commits: 0, sessions: 0,
});
const mockDb = mockFresh();
const mockTx = {
  supported: true, indexes: null, failUpdate: null, failLogSave: null, pauseUpdate: null, pauseLegacySave: null, commitPlan: [],
};
const mockSame = (a, b) => a != null && b != null && String(a) === String(b);
const mockPlain = (value) => JSON.parse(JSON.stringify(value));
const mockQuery = (value, onSession) => {
  const promise = Promise.resolve(value);
  promise.select = () => promise;
  promise.sort = () => promise;
  promise.populate = () => promise;
  promise.session = (session) => {
    if (onSession) onSession(session);
    return promise;
  };
  return promise;
};
// Mini aplicador de update do MongoDB ($set com caminho pontuado/posicional, $push com $each, $inc).
const mockGetPath = (obj, path) => path.split('.').reduce((current, part) => (current == null ? current : current[part]), obj);
const mockSetPath = (obj, path, value) => {
  const parts = path.split('.');
  const last = parts.pop();
  parts.reduce((current, part) => current[part], obj)[last] = value;
};
const mockApplyUpdate = (row, update) => {
  Object.entries(update.$set || {}).forEach(([path, value]) => mockSetPath(row, path, mockPlain(value)));
  Object.entries(update.$push || {}).forEach(([path, value]) => {
    const items = value && value.$each ? value.$each : [value];
    mockGetPath(row, path).push(...items.map(mockPlain));
  });
  Object.entries(update.$inc || {}).forEach(([path, amount]) => mockSetPath(row, path, (Number(mockGetPath(row, path)) || 0) + amount));
};
const mockMatchesTarefa = (row, filter) =>
  mockSame(row._id, filter._id) &&
  (!filter.equipe || (filter.equipe.$in ? filter.equipe.$in.some((id) => mockSame(id, row.equipe)) : mockSame(row.equipe, filter.equipe))) &&
  (filter.__v === undefined || row.__v === filter.__v);

jest.mock('@google-cloud/storage', () => ({
  Storage: jest.fn().mockImplementation(() => ({ bucket: jest.fn().mockReturnValue({ file: jest.fn() }) })),
}));
// URL assinada nova a cada chamada: prova que a resposta e montada na hora e nunca guardada.
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

jest.mock('../models/User', () => ({
  findById: jest.fn((id) => mockQuery(mockDb.users.find((user) => mockSame(user._id, id)) || null)),
  find: jest.fn(() => mockQuery([])),
  findOne: jest.fn(() => mockQuery(null)),
}));

jest.mock('../models/Equipe', () => ({
  find: jest.fn((filter) => {
    mockDb.equipeFinds += 1;
    const conditions = filter.$or || [{ membros: filter.membros }];
    const found = mockDb.equipes.filter((equipe) =>
      conditions.some(
        (condition) =>
          (condition.membros && equipe.membros.some((id) => mockSame(id, condition.membros))) ||
          (condition.createdBy && mockSame(equipe.createdBy, condition.createdBy))
      )
    );
    return mockQuery(found.map((equipe) => ({ _id: equipe._id })), (session) => {
      mockDb.equipeFindSessions.push(Boolean(session));
    });
  }),
  findOne: jest.fn(() => mockQuery(null)),
  updateMany: jest.fn(async () => ({})),
}));

jest.mock('../models/Tarefa', () => {
  const Real = jest.requireActual('../models/Tarefa');
  // new Tarefa(...) continua sendo o documento real (usado para validar a subtarefa pelo schema).
  function Model(data) {
    return new Real(data);
  }
  // Documento carregado: o save() aplica o delta real do Mongoose, com o filtro de _id/__v (VersionError).
  const hydrateRow = (row) => {
    const doc = Real.hydrate(mockPlain(row));
    doc.save = async (options = {}) => {
      mockDb.legacySaves.push(Boolean(options.session));
      if (mockTx.pauseLegacySave) {
        mockDb.pausedLegacySaves += 1;
        await mockTx.pauseLegacySave();
      }
      const delta = doc.$__delta();
      if (!delta) return doc;
      const [where, update] = delta;
      const current = mockDb.tarefas.find((item) => mockMatchesTarefa(item, where));
      if (!current) {
        throw Object.assign(new Error('No matching document found (versao divergente)'), { name: 'VersionError' });
      }
      mockApplyUpdate(current, update);
      return doc;
    };
    return doc;
  };
  Model.findOne = jest.fn((filter) => {
    const row = mockDb.tarefas.find((item) => mockMatchesTarefa(item, filter));
    return mockQuery(row ? hydrateRow(row) : null);
  });
  Model.find = jest.fn(() => mockQuery([]));
  // Caminho protegido: casa o filtro na hora (matchedCount) e, na transacao, aplica a operacao no commit.
  Model.updateOne = jest.fn(async (filter, update, options = {}) => {
    mockDb.updateCalls.push({ withSession: Boolean(options.session), runValidators: options.runValidators === true, update: mockPlain(update) });
    if (mockTx.pauseUpdate) {
      mockDb.pausedUpdates += 1;
      await mockTx.pauseUpdate();
    }
    if (mockTx.failUpdate) throw mockTx.failUpdate;
    const row = mockDb.tarefas.find((item) => mockMatchesTarefa(item, filter));
    if (!row) return { matchedCount: 0, modifiedCount: 0 };
    if (options.session) options.session.tarefaOps.push({ id: row._id, update: mockPlain(update) });
    else mockApplyUpdate(row, update);
    return { matchedCount: 1, modifiedCount: 1 };
  });
  Model.Real = Real;
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
  Model.find = jest.fn(() => mockQuery([]));
  return Model;
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
  const labeled = (message, label) => Object.assign(new Error(message), { errorLabels: [label] });
  const rollback = (session) => {
    session.keys.clear();
    session.tarefaOps = [];
    session.logs = [];
  };
  const commit = (session) => {
    session.keys.forEach((copy, row) => {
      Object.keys(row).forEach((name) => delete row[name]);
      Object.assign(row, copy);
    });
    // Como o servidor: a operacao ($push/$inc) e aplicada ao documento como ele esta no commit.
    session.tarefaOps.forEach(({ id: tarefaId, update }) => {
      const row = mockDb.tarefas.find((item) => mockSame(item._id, tarefaId));
      if (row) mockApplyUpdate(row, update);
    });
    mockDb.logs.push(...session.logs);
    mockDb.commits += 1;
    rollback(session);
  };
  return {
    supportsTransactions: jest.fn(async () => mockTx.supported),
    resetTransactionSupportCache: jest.fn(),
    runInTransaction: jest.fn(async (work) => {
      for (let attempt = 1; attempt <= 5; attempt += 1) {
        mockDb.sessions += 1;
        const session = { id: mockDb.sessions, keys: new Map(), tarefaOps: [], logs: [] };
        let result;
        try {
          result = await work(session);
        } catch (err) {
          rollback(session);
          if (attempt < 5 && err?.errorLabels?.includes('TransientTransactionError')) continue;
          throw err;
        }
        const plan = mockTx.commitPlan.shift() || null;
        if (plan === 'transient') {
          rollback(session);
          continue;
        }
        if (plan === 'unknown_not_applied') {
          rollback(session);
          throw labeled('commit sem resposta', 'UnknownTransactionCommitResult');
        }
        if (plan === 'unknown_applied') {
          commit(session);
          throw labeled('commit sem resposta', 'UnknownTransactionCommitResult');
        }
        commit(session);
        return result;
      }
      throw labeled('tentativas esgotadas', 'TransientTransactionError');
    }),
  };
});

const { issueAuthToken } = require('../utils/faceAuth');
const RealTarefa = jest.requireActual('../models/Tarefa');

const KEY = '3f1c2b6e-8a4d-4c1b-9e2f-7a6b5c4d3e2f';
const KEY_2 = '9d8c7b6a-5f4e-4d3c-8b2a-1f0e9d8c7b6a';
const KEY_3 = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
const SEM_EQUIPES_404 = { erro: 'Tarefa nÃ£o encontrada' }; // texto (e codificacao) do legado sem equipes
const TAREFA_404 = { erro: 'Tarefa não encontrada' }; // texto do legado quando a tarefa nao e encontrada
const id = () => new mongoose.Types.ObjectId().toString();
const keysOf = (value) => Object.keys(value).sort();
const nomes = (row) => row.subtarefas.map((sub) => sub.descricao);

const loadApp = () => {
  let app;
  jest.isolateModules(() => {
    app = require('../app');
  });
  return app;
};

// Libera sempre as requisicoes pausadas e espera elas terminarem, mesmo se uma verificacao falhar.
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

describe('POST /api/tarefas/:id/subtarefas com Idempotency-Key', () => {
  let app;
  let admin;
  let colaborador;
  let colaboradorFora;
  let equipe;
  let tarefa;
  let outraTarefa;
  let tokenUser;

  const post = (descricao, { key, token = tokenUser, tarefaId = tarefa._id, extra = {} } = {}) => {
    const req = request(app).post(`/api/tarefas/${tarefaId}/subtarefas`).set('Authorization', `Bearer ${token}`);
    if (key !== undefined) req.set('Idempotency-Key', key);
    return req.send(descricao === undefined ? extra : { descricao, ...extra });
  };
  const novaTarefaRow = (extra = {}) => ({
    ...mockPlain(new RealTarefa({
      descricao: 'Relatório', dataEntrega: new Date('2026-12-15T00:00:00.000Z'), equipe: equipe._id, user: colaborador._id,
      subtarefas: [{ descricao: 'Existente' }], ...extra,
    }).toObject()),
    __v: 0,
  });

  beforeEach(() => {
    Object.keys(mockDb).forEach((name) => {
      const value = mockFresh()[name];
      if (Array.isArray(value)) mockDb[name].splice(0, mockDb[name].length);
      else mockDb[name] = value;
    });
    Object.assign(mockTx, {
      supported: true, indexes: null, failUpdate: null, failLogSave: null, pauseUpdate: null, pauseLegacySave: null, commitPlan: [],
    });
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'log').mockImplementation(() => {});

    admin = { _id: id(), nome: 'Admin Ficticio', tipo: 'admin', authVersion: 0 };
    colaborador = { _id: id(), nome: 'Pessoa Ficticia', tipo: 'user', authVersion: 0 };
    colaboradorFora = { _id: id(), nome: 'Pessoa de Fora', tipo: 'user', authVersion: 0 };
    mockDb.users.push(admin, colaborador, colaboradorFora);
    equipe = { _id: id(), createdBy: admin._id, membros: [colaborador._id] };
    mockDb.equipes.push(equipe);
    tarefa = novaTarefaRow();
    outraTarefa = novaTarefaRow();
    mockDb.tarefas.push(tarefa, outraTarefa);
    tokenUser = issueAuthToken(colaborador);
    app = loadApp();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('1. sem o cabecalho: fluxo legado inalterado (findOne + save com $push, sem transacao, sem chave)', async () => {
    const response = await post('Primeira');
    expect(response.status).toBe(201);
    expect(response.headers['idempotency-replayed']).toBeUndefined();
    expect(mockDb.legacySaves).toEqual([false]);
    expect(mockDb.updateCalls).toEqual([]);
    expect(mockDb.logSaves).toEqual([{ withSession: false }]);
    expect(mockDb.equipeFindSessions).toEqual([]);
    expect(mockDb.keys).toHaveLength(0);
    expect(mockDb.sessions).toBe(0);
    expect((await post('Primeira')).status).toBe(201); // sem cabecalho, repetir inclui de novo (como hoje)
    expect(nomes(tarefa)).toEqual(['Existente', 'Primeira', 'Primeira']);
    expect(mockDb.logs).toHaveLength(2);
  });

  test('2. chave valida: $push atomico com acesso, log e chave na mesma transacao', async () => {
    const response = await post('Revisar números', { key: KEY });
    expect(response.status).toBe(201);
    expect(mockDb.equipeFinds).toBe(2); // conferencia na transacao + revalidacao depois do commit
    expect(mockDb.equipeFindSessions).toEqual([true]);
    expect(mockDb.legacySaves).toEqual([]); // nada de carregar e salvar o documento inteiro
    expect(mockDb.updateCalls).toHaveLength(1);
    const [call] = mockDb.updateCalls;
    expect(call).toMatchObject({ withSession: true, runValidators: true });
    expect(Object.keys(call.update).sort()).toEqual(['$inc', '$push']);
    expect(call.update.$inc).toEqual({ __v: 1 });
    expect(call.update.$push.subtarefas).toMatchObject({ descricao: 'Revisar números', concluida: false });
    expect(mockDb.logSaves).toEqual([{ withSession: true }]);
    expect(mockDb.commits).toBe(1);

    expect(nomes(tarefa)).toEqual(['Existente', 'Revisar números']);
    const nova = tarefa.subtarefas[1];
    expect(nova.concluida).toBe(false); // default do schema
    expect(nova._id).toMatch(/^[a-f0-9]{24}$/);
    expect(tarefa.__v).toBe(1);
    expect(mockDb.logs[0]).toMatchObject({ tipoAcao: 'nova_subtarefa', detalhes: "Subtarefa 'Revisar números' adicionada" });
    expect(String(mockDb.logs[0].user)).toBe(colaborador._id);
    expect(String(mockDb.logs[0].tarefa)).toBe(tarefa._id);
    expect(mockDb.keys[0]).toMatchObject({
      userId: colaborador._id, key: KEY, method: 'POST', route: '/api/tarefas/:id/subtarefas', status: 'completed',
      result: { statusCode: 201, resourceType: 'subtarefa', resourceId: nova._id },
    });
    expect(response.body._id).toBe(tarefa._id);
    expect(response.body.subtarefas.map((sub) => sub.descricao)).toEqual(['Existente', 'Revisar números']);
  });

  test('3 e 4. repeticao: mesma tarefa, 201, sem nova subtarefa e sem novo log', async () => {
    const first = await post('Revisar números', { key: KEY });
    for (let i = 0; i < 3; i += 1) {
      const again = await post('Revisar números', { key: KEY.toUpperCase() });
      expect(again.status).toBe(201);
      expect(again.headers['idempotency-replayed']).toBe('true');
      expect(again.body.subtarefas).toEqual(first.body.subtarefas);
    }
    expect(nomes(tarefa)).toEqual(['Existente', 'Revisar números']);
    expect(mockDb.updateCalls).toHaveLength(1);
    expect(mockDb.logs).toHaveLength(1);
    expect(mockDb.logSaves).toHaveLength(1);
  });

  test('5. mesma chave com descricao ou tarefa diferente: 422 sem incluir', async () => {
    await post('Revisar números', { key: KEY });
    for (const options of [
      { descricao: 'Revisar números!' }, { descricao: 'revisar números' }, { descricao: 'Revisar números', tarefaId: outraTarefa._id },
    ]) {
      const response = await post(options.descricao, { key: KEY, tarefaId: options.tarefaId });
      expect(response.status).toBe(422);
      expect(response.body).toEqual({ erro: 'Esta chave de idempotência já foi usada com outro pedido.', code: 'idempotency_key_reused' });
    }
    expect(nomes(tarefa)).toEqual(['Existente', 'Revisar números']);
    expect(nomes(outraTarefa)).toEqual(['Existente']);
    expect(mockDb.logs).toHaveLength(1);
  });

  test('6. mesma chave ao mesmo tempo: uma inclui; a outra recebe 409; nada aparece antes do commit', async () => {
    let first;
    await withGate('pauseUpdate', async ({ pending, release }) => {
      const firstRun = post('Revisar números', { key: KEY }).then((response) => response);
      pending.push(firstRun);
      await waitFor(() => mockDb.pausedUpdates === 1, 'primeira inclusao pausada');
      expect(nomes(tarefa)).toEqual(['Existente']);
      mockTx.pauseUpdate = null;
      const second = await post('Revisar números', { key: KEY });
      expect(second.status).toBe(409);
      expect(second.body.code).toBe('idempotency_in_progress');
      expect(second.headers['retry-after']).toBe('2');
      release();
      first = await firstRun;
    });
    expect(first.status).toBe(201);
    expect(nomes(tarefa)).toEqual(['Existente', 'Revisar números']);
    expect(mockDb.logs).toHaveLength(1);
  });

  test('7. chaves diferentes ao mesmo tempo: as duas inclusoes ficam (uma nao sobrescreve a outra)', async () => {
    const responses = await withGate('pauseUpdate', async ({ pending, release }) => {
      const a = post('Subtarefa A', { key: KEY }).then((response) => response);
      const b = post('Subtarefa B', { key: KEY_2 }).then((response) => response);
      pending.push(a, b);
      await waitFor(() => mockDb.pausedUpdates === 2, 'as duas inclusoes pausadas dentro da transacao');
      expect(nomes(tarefa)).toEqual(['Existente']);
      release();
      return Promise.all([a, b]);
    });
    expect(responses.map((response) => response.status)).toEqual([201, 201]);
    expect(nomes(tarefa).sort()).toEqual(['Existente', 'Subtarefa A', 'Subtarefa B']);
    expect(tarefa.__v).toBe(2);
    expect(mockDb.logs).toHaveLength(2);
  });

  test('7b. inclusao legada enquanto a protegida esta aberta: as duas ficam', async () => {
    const protegida = await withGate('pauseUpdate', async ({ pending, release }) => {
      const run = post('Protegida', { key: KEY }).then((response) => response);
      pending.push(run);
      await waitFor(() => mockDb.pausedUpdates === 1, 'inclusao protegida pausada');
      mockTx.pauseUpdate = null;
      expect((await post('Legada')).status).toBe(201); // fluxo legado, sem cabecalho
      release();
      return run;
    });
    expect(protegida.status).toBe(201);
    expect(nomes(tarefa)).toEqual(['Existente', 'Legada', 'Protegida']);
    expect(tarefa.__v).toBe(2);
  });

  test('8 e 10. falha na atualizacao da tarefa: rollback completo; a mesma chave inclui uma unica vez depois', async () => {
    mockTx.failUpdate = new Error('falha interna /tmp/segredo');
    const failed = await post('Revisar', { key: KEY });
    expect(failed.status).toBe(500);
    expect(failed.body).toEqual({ erro: 'Erro ao adicionar subtarefa' });
    expect(JSON.stringify(failed.body)).not.toContain('segredo');
    expect(nomes(tarefa)).toEqual(['Existente']);
    expect(mockDb.logs).toHaveLength(0);
    expect(mockDb.keys[0]).toMatchObject({ status: 'failed', failure: { retryable: true } });

    mockTx.failUpdate = null;
    expect((await post('Revisar', { key: KEY })).status).toBe(201);
    expect(nomes(tarefa)).toEqual(['Existente', 'Revisar']);
    expect(mockDb.logs).toHaveLength(1);
  });

  test('9 e 10. falha no registro de atividade: a subtarefa e a chave tambem voltam', async () => {
    mockTx.failLogSave = new Error('log fora do ar');
    const failed = await post('Revisar', { key: KEY });
    expect(failed.status).toBe(500);
    expect(mockDb.updateCalls).toHaveLength(1); // a inclusao chegou a ser feita na sessao...
    expect(nomes(tarefa)).toEqual(['Existente']); // ...e foi desfeita junto com o log
    expect(tarefa.__v).toBe(0);
    expect(mockDb.logs).toHaveLength(0);
    expect(mockDb.keys[0].status).not.toBe('completed');
    expect(mockDb.keys[0].result).toBeUndefined();

    mockTx.failLogSave = null;
    expect((await post('Revisar', { key: KEY })).status).toBe(201);
    expect(nomes(tarefa)).toEqual(['Existente', 'Revisar']);
    expect(mockDb.logs).toHaveLength(1);
  });

  test('10b. conflito transitorio: o withTransaction repete e fica uma subtarefa e um log', async () => {
    mockTx.commitPlan = ['transient', 'transient'];
    expect((await post('Revisar', { key: KEY })).status).toBe(201);
    expect(mockDb.updateCalls).toHaveLength(3);
    expect(nomes(tarefa)).toEqual(['Existente', 'Revisar']);
    expect(mockDb.logs).toHaveLength(1);
  });

  test('11. commit com resultado desconhecido: sem confirmacao nao inclui de novo; se entrou, responde 201', async () => {
    mockTx.commitPlan = ['unknown_not_applied'];
    const unknown = await post('Revisar', { key: KEY });
    expect(unknown.status).toBe(409);
    expect(unknown.body.code).toBe('idempotency_outcome_unknown');
    expect(unknown.body.erro).toContain('subtarefa');
    expect((await post('Revisar', { key: KEY })).status).toBe(409);
    expect(nomes(tarefa)).toEqual(['Existente']);

    mockTx.commitPlan = ['unknown_applied'];
    expect((await post('Revisar', { key: KEY_2 })).status).toBe(201);
    expect((await post('Revisar', { key: KEY_2 })).headers['idempotency-replayed']).toBe('true');
    expect(nomes(tarefa)).toEqual(['Existente', 'Revisar']);
    expect(mockDb.logs).toHaveLength(1);
  });

  test('12. permissoes: fora da equipe 404 (guardado); admin criador pode; token invalido ou revogado 401', async () => {
    const fora = await post('Oi', { key: KEY, token: issueAuthToken(colaboradorFora) });
    expect(fora.status).toBe(404);
    expect(fora.body).toEqual(SEM_EQUIPES_404); // sem nenhuma equipe acessivel: mesmo texto do legado
    const consultas = mockDb.equipeFinds;
    const repetida = await post('Oi', { key: KEY, token: issueAuthToken(colaboradorFora) });
    expect(repetida.status).toBe(404);
    expect(repetida.headers['idempotency-replayed']).toBe('true');
    expect(mockDb.equipeFinds).toBe(consultas); // repeticao nao consulta de novo

    // Com equipes, mas sem acesso a esta tarefa: 404 com o outro texto do legado.
    const outraEquipe = { _id: id(), createdBy: admin._id, membros: [colaboradorFora._id] };
    mockDb.equipes.push(outraEquipe);
    const semTarefa = await post('Oi', { key: KEY_2, token: issueAuthToken(colaboradorFora) });
    expect(semTarefa.status).toBe(404);
    expect(semTarefa.body).toEqual(TAREFA_404);
    expect(nomes(tarefa)).toEqual(['Existente']);
    expect(mockDb.logs).toHaveLength(0); // nenhum log de uma inclusao que nao aconteceu
    const chaveSemTarefa = mockDb.keys.find((row) => row.key === KEY_2);
    expect(chaveSemTarefa).toMatchObject({
      status: 'failed', failure: { statusCode: 404, code: 'tarefa_nao_encontrada' },
    });
    expect(chaveSemTarefa.status).not.toBe('completed');

    expect((await post('Do admin', { key: KEY_3, token: issueAuthToken(admin) })).status).toBe(201);
    expect((await post('Oi', { key: KEY, token: 'nao-e-um-jwt' })).status).toBe(401);
    const revoked = tokenUser;
    colaborador.authVersion = 1;
    expect((await post('Oi', { key: KEY, token: revoked })).status).toBe(401);
    expect(nomes(tarefa)).toEqual(['Existente', 'Do admin']);
  });

  test('13. estado da tarefa muda: inclusao protegida nao desfaz alteracoes de outras rotas; repeticao mostra o atual', async () => {
    // Status e toggle de subtarefa legados entre a inclusao e a repeticao.
    expect((await post('Nova', { key: KEY })).status).toBe(201);
    const statusRes = await request(app).put(`/api/tarefas/${tarefa._id}/status`)
      .set('Authorization', `Bearer ${tokenUser}`).send({ status: 'em_andamento' });
    expect(statusRes.status).toBe(200);
    expect(tarefa.status).toBe('em_andamento');
    const existenteId = tarefa.subtarefas[0]._id;
    expect((await request(app).put(`/api/tarefas/${tarefa._id}/subtarefas/${existenteId}`)
      .set('Authorization', `Bearer ${tokenUser}`)).status).toBe(200);
    const replay = await post('Nova', { key: KEY });
    expect(replay.status).toBe(201);
    expect(replay.body.subtarefas.map((sub) => [sub.descricao, sub.concluida])).toEqual([['Existente', true], ['Nova', false]]);
    expect(nomes(tarefa)).toEqual(['Existente', 'Nova']);

    // Inclusao protegida depois de outra mudanca: a mudanca permanece (nada e regravado por cima).
    tarefa.detalhes = 'alterado por outra rota';
    expect((await post('Outra', { key: KEY_2 })).status).toBe(201);
    expect(tarefa.detalhes).toBe('alterado por outra rota');
    expect(tarefa.subtarefas[0].concluida).toBe(true);
  });

  test('13b. toggle legado carregado antes da inclusao: falha por versao (como ja falha hoje), sem perder dados', async () => {
    const existenteId = tarefa.subtarefas[0]._id;
    const toggle = await withGate('pauseLegacySave', async ({ pending, release }) => {
      const run = request(app).put(`/api/tarefas/${tarefa._id}/subtarefas/${existenteId}`)
        .set('Authorization', `Bearer ${tokenUser}`).then((response) => response);
      pending.push(run);
      await waitFor(() => mockDb.pausedLegacySaves === 1, 'toggle legado pausado depois de carregar a tarefa');
      mockTx.pauseLegacySave = null;
      expect((await post('Nova', { key: KEY })).status).toBe(201); // incrementa __v, como o push legado
      release();
      return run;
    });
    expect(toggle.status).toBe(500); // VersionError: comportamento atual do legado quando o array muda
    expect(tarefa.subtarefas.map((sub) => [sub.descricao, sub.concluida])).toEqual([['Existente', false], ['Nova', false]]);
  });

  test('13c. revalidacao na repeticao: saiu da equipe, tarefa excluida, sessao revogada', async () => {
    expect((await post('Nova', { key: KEY })).status).toBe(201);
    equipe.membros = [];
    const semAcesso = await post('Nova', { key: KEY });
    expect(semAcesso.status).toBe(404);
    expect(semAcesso.body).toEqual(SEM_EQUIPES_404);
    expect(JSON.stringify(semAcesso.body)).not.toContain('Nova');
    equipe.membros = [colaborador._id];

    mockDb.tarefas.splice(mockDb.tarefas.indexOf(tarefa), 1);
    const excluida = await post('Nova', { key: KEY });
    expect(excluida.status).toBe(404);
    expect(excluida.body).toEqual(TAREFA_404);
    mockDb.tarefas.push(tarefa);

    colaborador.authVersion = 1;
    expect((await post('Nova', { key: KEY })).status).toBe(401);
    expect(nomes(tarefa)).toEqual(['Existente', 'Nova']);
    expect(mockDb.updateCalls).toHaveLength(1);
  });

  test('subtarefa removida antes da repeticao: 404 sem incluir de novo nem registrar outro log', async () => {
    expect((await post('Nova', { key: KEY })).status).toBe(201);
    tarefa.subtarefas = tarefa.subtarefas.filter((sub) => sub.descricao !== 'Nova'); // removida do banco simulado
    const replay = await post('Nova', { key: KEY });
    expect(replay.status).toBe(404);
    expect(replay.body).toEqual({ erro: 'Subtarefa não encontrada' });
    expect(nomes(tarefa)).toEqual(['Existente']);
    expect(mockDb.updateCalls).toHaveLength(1);
    expect(mockDb.logs).toHaveLength(1);
  });

  test('14. validacoes: descricao invalida e ID malformado antes da chave, com as mensagens do legado', async () => {
    for (const extra of [{}, { descricao: '' }, { descricao: 123 }, { descricao: ['a'] }, { descricao: { $ne: null } }]) {
      const protegido = await post(undefined, { key: KEY, extra });
      const legado = await post(undefined, { extra });
      expect(protegido.status).toBe(400);
      expect(protegido.body).toEqual({ erro: 'Obrigatório fornecer descrição' });
      expect(legado.body).toEqual(protegido.body);
    }
    const malformado = await post('Oi', { key: KEY, tarefaId: 'nao-e-id' });
    expect(malformado.status).toBe(404);
    expect(malformado.body).toEqual(TAREFA_404);
    expect(mockDb.keys).toHaveLength(0);
    expect(mockDb.sessions).toBe(0);
    expect(nomes(tarefa)).toEqual(['Existente']);
  });

  test('15. resposta igual ao legado (tarefa com anexos assinados na hora); nada sensivel na chave', async () => {
    tarefa.anexos.push({ _id: id(), url: 'tarefas/anexo.pdf', nomeOriginal: 'anexo.pdf' });
    const legado = await post('Legada');
    const protegido = await post('Protegida', { key: KEY });
    expect(keysOf(protegido.body)).toEqual(keysOf(legado.body));
    // A resposta protegida ja traz tambem a subtarefa incluida antes pelo legado: compara o formato de cada item.
    expect(protegido.body.subtarefas.map((sub) => sub.descricao)).toEqual(['Existente', 'Legada', 'Protegida']);
    const formatos = (lista) => [...new Set(lista.map((sub) => keysOf(sub).join(',')))];
    expect(formatos(protegido.body.subtarefas)).toEqual(formatos(legado.body.subtarefas));
    expect(protegido.body.anexos.map(keysOf)).toEqual(legado.body.anexos.map(keysOf));
    expect(protegido.body.anexos[0].url).toMatch(/^https:\/\/storage\.test\/tarefas\/anexo\.pdf\?X-Goog-Signature=sig\d+$/);
    const replay = await post('Protegida', { key: KEY });
    expect(replay.body.anexos[0].url).not.toBe(protegido.body.anexos[0].url); // assinada de novo
    const stored = JSON.stringify(mockDb.keys);
    for (const text of ['Protegida', 'storage.test', 'X-Goog-Signature', 'anexo.pdf', 'Relatório', 'Bearer']) {
      expect(stored).not.toContain(text);
    }
  });

  test('16. sem transacoes ou sem o indice unico: 503 sem incluir; o fluxo sem cabecalho segue funcionando', async () => {
    mockTx.supported = false;
    const semTx = await post('Revisar', { key: KEY });
    expect(semTx.status).toBe(503);
    expect(semTx.body).toEqual({ erro: 'Serviço temporariamente indisponível.', code: 'transactions_unavailable' });
    expect(semTx.headers['retry-after']).toBe('2');
    expect((await post('Legada')).status).toBe(201);
    mockTx.supported = true;

    for (const indexes of [[{ key: { _id: 1 }, name: '_id_' }], new Error('ns not found')]) {
      mockTx.indexes = indexes;
      app = loadApp();
      const response = await post('Revisar', { key: KEY });
      expect(response.status).toBe(503);
      expect(response.body.code).toBe('idempotency_unavailable');
    }
    expect(nomes(tarefa)).toEqual(['Existente', 'Legada']);
    expect(mockDb.keys).toHaveLength(0);
  });

  test('identidade so do JWT e chave invalida: 400 sem cair no legado', async () => {
    expect((await post('Oi', { key: KEY, extra: { user: admin._id, autor: admin._id } })).status).toBe(201);
    expect(mockDb.keys[0].userId).toBe(colaborador._id);
    expect(String(mockDb.logs[0].user)).toBe(colaborador._id);
    for (const key of ['', 'abc', `${KEY}, ${KEY_2}`]) {
      const response = await post('Oi', { key });
      expect(response.status).toBe(400);
      expect(response.body).toEqual({ erro: 'Chave de idempotência inválida.', code: 'idempotency_key_invalid' });
    }
    expect(nomes(tarefa)).toEqual(['Existente', 'Oi']);
  });
});
