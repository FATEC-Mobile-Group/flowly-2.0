// POST /api/tarefas com Idempotency-Key (opt-in): rotas reais, auth e sessionGuard reais, banco e transacao em
// memoria. Tarefa e ActivityLog usam documentos Mongoose REAIS (schema, defaults, validacao, toObject); so a
// gravacao vai para o banco em memoria, isolada por sessao ate o commit. Nenhuma conexao real, nenhum indice criado.
const request = require('supertest');
const mongoose = require('mongoose');

jest.setTimeout(30000);

const mockFresh = () => ({
  users: [], equipes: [], tarefas: [], logs: [], keys: [],
  tarefaSaves: [], logSaves: [], equipeFindSessions: [], userFindSessions: [], pausedSaves: 0, commits: 0, sessions: 0,
});
const mockDb = mockFresh();
const mockTx = { supported: true, indexes: null, failTarefaSave: null, failLogSave: null, pauseSave: null, commitPlan: [] };
const mockSame = (a, b) => a != null && b != null && String(a) === String(b);
const mockQuery = (value, onSession) => {
  const promise = Promise.resolve(value);
  promise.select = () => promise;
  promise.populate = () => promise;
  promise.sort = () => promise;
  promise.session = (session) => {
    if (onSession) onSession(session);
    return promise;
  };
  return promise;
};

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
  // sessionGuard (real) faz await User.findById(id, 'tipo authVersion'); o caminho protegido encadeia select/session.
  findById: jest.fn((id) =>
    mockQuery(mockDb.users.find((user) => mockSame(user._id, id)) || null, (session) => {
      mockDb.userFindSessions.push(Boolean(session));
    })
  ),
  find: jest.fn(() => mockQuery([])),
  findOne: jest.fn(() => mockQuery(null)),
}));

jest.mock('../models/Equipe', () => {
  const visible = (filter) =>
    mockDb.equipes.filter((equipe) => {
      if (filter._id && !mockSame(equipe._id, filter._id)) return false;
      const conditions = filter.$or || (filter.membros ? [{ membros: filter.membros }] : []);
      if (conditions.length === 0) return true;
      return conditions.some(
        (condition) =>
          (condition.membros && equipe.membros.some((id) => mockSame(id, condition.membros))) ||
          (condition.createdBy && mockSame(equipe.createdBy, condition.createdBy))
      );
    });
  return {
    findOne: jest.fn((filter) =>
      mockQuery(visible(filter)[0] || null, (session) => {
        mockDb.equipeFindSessions.push(Boolean(session));
      })
    ),
    find: jest.fn((filter) => mockQuery(visible(filter))),
    updateMany: jest.fn(async () => ({})),
  };
});

// Documento Mongoose real; save desviado para o banco em memoria (na sessao, so aparece no commit).
const mockRealModel = (path, table, saves, failKey) => {
  const Real = jest.requireActual(path);
  function Model(data) {
    const doc = new Real(data);
    doc.save = async (options = {}) => {
      saves.push({ withSession: Boolean(options.session) });
      if (table === 'tarefas' && mockTx.pauseSave) {
        mockDb.pausedSaves += 1;
        await mockTx.pauseSave();
      }
      await doc.validate();
      if (mockTx[failKey]) throw mockTx[failKey];
      const row = doc.toObject();
      if (options.session) options.session[table].push(row);
      else mockDb[table].push(row);
      return doc;
    };
    return doc;
  }
  Model.Real = Real;
  return Model;
};

jest.mock('../models/Tarefa', () => {
  const Model = mockRealModel('../models/Tarefa', 'tarefas', mockDb.tarefaSaves, 'failTarefaSave');
  const matchesFilter = (row, filter) =>
    (!filter._id || mockSame(row._id, filter._id)) &&
    (!filter.equipe || (filter.equipe.$in ? filter.equipe.$in.some((id) => mockSame(id, row.equipe)) : mockSame(row.equipe, filter.equipe)));
  Model.findOne = jest.fn((filter) => {
    const row = mockDb.tarefas.find((item) => matchesFilter(item, filter));
    // Ida e volta como no banco: JSON (ObjectId e Date viram texto) e hydrate converte de volta pelo schema.
    // structuredClone nao serve: transforma ObjectId em objeto comum e os IDs somem da resposta.
    return mockQuery(row ? Model.Real.hydrate(JSON.parse(JSON.stringify(row))) : null);
  });
  Model.find = jest.fn(() => mockQuery([]));
  return Model;
});

jest.mock('../models/ActivityLog', () => {
  const Model = mockRealModel('../models/ActivityLog', 'logs', mockDb.logSaves, 'failLogSave');
  Model.find = jest.fn(() => mockQuery([]));
  return Model;
});

// Model de idempotencia em memoria: indice unico userId+key e escritas com session isoladas ate o commit.
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
    session.tarefas = [];
    session.logs = [];
  };
  const commit = (session) => {
    session.keys.forEach((copy, row) => {
      Object.keys(row).forEach((name) => delete row[name]);
      Object.assign(row, copy);
    });
    mockDb.tarefas.push(...session.tarefas);
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
        const session = { id: mockDb.sessions, keys: new Map(), tarefas: [], logs: [] };
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

const KEY = '3f1c2b6e-8a4d-4c1b-9e2f-7a6b5c4d3e2f';
const KEY_2 = '9d8c7b6a-5f4e-4d3c-8b2a-1f0e9d8c7b6a';
const id = () => new mongoose.Types.ObjectId().toString();
const keysOf = (value) => Object.keys(value).sort();

// App carregado de novo a cada teste: servico de idempotencia novo (sem cache da verificacao do indice).
const loadApp = () => {
  let app;
  jest.isolateModules(() => {
    app = require('../app');
  });
  return app;
};

describe('POST /api/tarefas com Idempotency-Key', () => {
  let app;
  let admin;
  let admin2;
  let colaborador;
  let colaboradorFora;
  let equipe;
  let equipeOutra;
  let tokenAdmin;

  const post = (body, { key, token = tokenAdmin } = {}) => {
    const req = request(app).post('/api/tarefas').set('Authorization', `Bearer ${token}`);
    if (key !== undefined) req.set('Idempotency-Key', key);
    return req.send(body);
  };
  const body = (extra = {}) => ({
    descricao: 'Relatório semanal',
    detalhes: 'Consolidar entregas',
    dataEntrega: '2026-12-15T00:00:00.000Z',
    equipe: equipe._id,
    user: colaborador._id,
    tempoEstimado: 90,
    urgencia: 'alta',
    tags: ['financeiro', 'semanal'],
    subtarefas: [{ descricao: 'Coletar números' }, { descricao: 'Revisar', concluida: true }],
    ...extra,
  });

  beforeEach(() => {
    Object.keys(mockDb).forEach((name) => {
      const value = mockFresh()[name];
      if (Array.isArray(value)) mockDb[name].splice(0, mockDb[name].length);
      else mockDb[name] = value;
    });
    Object.assign(mockTx, { supported: true, indexes: null, failTarefaSave: null, failLogSave: null, pauseSave: null, commitPlan: [] });
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'log').mockImplementation(() => {});

    admin = { _id: id(), nome: 'Admin Ficticio', tipo: 'admin', authVersion: 0 };
    admin2 = { _id: id(), nome: 'Admin Dois', tipo: 'admin', authVersion: 0 };
    colaborador = { _id: id(), nome: 'Pessoa Ficticia', tipo: 'user', authVersion: 0 };
    colaboradorFora = { _id: id(), nome: 'Pessoa de Fora', tipo: 'user', authVersion: 0 };
    mockDb.users.push(admin, admin2, colaborador, colaboradorFora);
    equipe = { _id: id(), nome: 'Equipe Alfa', createdBy: admin._id, membros: [admin._id, colaborador._id] };
    equipeOutra = { _id: id(), nome: 'Equipe Beta', createdBy: admin2._id, membros: [admin2._id, colaboradorFora._id] };
    mockDb.equipes.push(equipe, equipeOutra);
    tokenAdmin = issueAuthToken(admin);
    app = loadApp();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('1. sem o cabecalho: fluxo legado inalterado (sem transacao, sem chave, log pelo caminho antigo)', async () => {
    const response = await post(body());
    expect(response.status).toBe(201);
    expect(response.headers['idempotency-replayed']).toBeUndefined();
    expect(mockDb.tarefaSaves).toEqual([{ withSession: false }]);
    expect(mockDb.logSaves).toEqual([{ withSession: false }]);
    expect(mockDb.keys).toHaveLength(0);
    expect(mockDb.sessions).toBe(0);
    expect((await post(body())).status).toBe(201); // sem cabecalho, repetir cria de novo (como hoje)
    expect(mockDb.tarefas).toHaveLength(2);
    expect(mockDb.logs).toHaveLength(2);
  });

  test('1b. legado: falha no log continua sendo so registrada no console (a tarefa fica criada, como hoje)', async () => {
    mockTx.failLogSave = new Error('log fora do ar');
    const response = await post(body());
    expect(response.status).toBe(201);
    expect(mockDb.tarefas).toHaveLength(1);
    expect(mockDb.logs).toHaveLength(0);
    expect(console.error).toHaveBeenCalledWith('Erro ao registrar log de atividade:', mockTx.failLogSave);
  });

  test('2. chave valida: tarefa e log na mesma transacao, com todos os campos, e a chave concluida junto', async () => {
    const response = await post(body(), { key: KEY });
    expect(response.status).toBe(201);
    expect(mockDb.tarefaSaves).toEqual([{ withSession: true }]);
    expect(mockDb.logSaves).toEqual([{ withSession: true }]);
    expect(mockDb.equipeFindSessions).toEqual([true]);
    expect(mockDb.userFindSessions).toEqual([true]);
    expect(mockDb.commits).toBe(1);
    expect(mockDb.tarefas).toHaveLength(1);
    expect(mockDb.logs).toHaveLength(1);

    const [tarefa] = mockDb.tarefas;
    expect(tarefa).toMatchObject({
      descricao: 'Relatório semanal', detalhes: 'Consolidar entregas', tempoEstimado: 90, urgencia: 'alta',
      tags: ['financeiro', 'semanal'], status: 'pendente',
    });
    expect(tarefa.dataEntrega.toISOString()).toBe('2026-12-15T00:00:00.000Z');
    expect(String(tarefa.createdBy)).toBe(admin._id);
    expect(String(tarefa.user)).toBe(colaborador._id);
    expect(String(tarefa.equipe)).toBe(equipe._id);
    expect(tarefa.subtarefas.map((s) => [s.descricao, s.concluida])).toEqual([['Coletar números', false], ['Revisar', true]]);

    expect(mockDb.logs[0]).toMatchObject({ tipoAcao: 'criacao', detalhes: 'Tarefa criada e atribuída a Pessoa Ficticia' });
    expect(String(mockDb.logs[0].tarefa)).toBe(String(tarefa._id));
    expect(String(mockDb.logs[0].user)).toBe(admin._id);
    expect(mockDb.keys[0]).toMatchObject({
      userId: admin._id, key: KEY, method: 'POST', route: '/api/tarefas', status: 'completed',
      result: { statusCode: 201, resourceType: 'tarefa', resourceId: String(tarefa._id) },
    });
    expect(response.body._id).toBe(String(tarefa._id));
  });

  test('2b. sem responsavel: log de backlog, tambem na transacao', async () => {
    const response = await post(body({ user: '' }), { key: KEY });
    expect(response.status).toBe(201);
    expect(response.body.user).toBeNull();
    expect(mockDb.logs[0].detalhes).toBe('Tarefa criada sem responsável e enviada ao backlog');
    expect(mockDb.userFindSessions).toEqual([]);
  });

  test('3 e 4. repeticao: mesma tarefa, 201, sem nova tarefa e sem novo log', async () => {
    const first = await post(body(), { key: KEY });
    for (let i = 0; i < 3; i += 1) {
      const again = await post(body(), { key: KEY.toUpperCase() });
      expect(again.status).toBe(201);
      expect(again.headers['idempotency-replayed']).toBe('true');
      expect(again.body._id).toBe(first.body._id);
      expect(again.body).toEqual(first.body); // mesma tarefa, mesmo conteudo
    }
    expect(mockDb.tarefas).toHaveLength(1);
    expect(mockDb.logs).toHaveLength(1);
    expect(mockDb.tarefaSaves).toHaveLength(1);
    expect(mockDb.logSaves).toHaveLength(1);
  });

  test('5. mesma chave com dados diferentes: 422 sem criar', async () => {
    await post(body(), { key: KEY });
    for (const changed of [
      body({ descricao: 'Outra' }), body({ urgencia: 'baixa' }), body({ dataEntrega: '2026-12-16T00:00:00.000Z' }),
      body({ user: '' }), body({ tags: ['financeiro'] }), body({ subtarefas: [] }), body({ tempoEstimado: 60 }),
      body({ detalhes: 'x' }),
    ]) {
      const response = await post(changed, { key: KEY });
      expect(response.status).toBe(422);
      expect(response.body).toEqual({ erro: 'Esta chave de idempotência já foi usada com outro pedido.', code: 'idempotency_key_reused' });
    }
    expect(mockDb.tarefas).toHaveLength(1);
    expect(mockDb.logs).toHaveLength(1);
  });

  test('6. requisicoes simultaneas: uma cria; a outra recebe 409; nada aparece antes do commit', async () => {
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    mockTx.pauseSave = () => gate;
    const firstRun = post(body(), { key: KEY }).then((response) => response);
    let first;
    try {
      const deadline = Date.now() + 5000;
      while (mockDb.pausedSaves === 0) {
        if (Date.now() > deadline) throw new Error('a primeira criacao nao chegou ao ponto de pausa');
        await new Promise((resolve) => setImmediate(resolve));
      }
      expect(mockDb.tarefas).toHaveLength(0);
      expect(mockDb.logs).toHaveLength(0);

      mockTx.pauseSave = null;
      const second = await post(body(), { key: KEY });
      expect(second.status).toBe(409);
      expect(second.body.code).toBe('idempotency_in_progress');
      expect(second.headers['retry-after']).toBe('2');
    } finally {
      // Sempre libera a requisicao pausada (sem isso, uma falha acima deixaria o Jest sem encerrar).
      mockTx.pauseSave = null;
      release();
      first = await firstRun.catch((err) => ({ status: undefined, requestError: err }));
    }
    expect(first.status).toBe(201);
    const third = await post(body(), { key: KEY });
    expect(third.status).toBe(201);
    expect(third.body._id).toBe(first.body._id);
    expect(mockDb.tarefas).toHaveLength(1);
    expect(mockDb.logs).toHaveLength(1);
  });

  test('7. usuario sem permissao de administrador: 403 antes de qualquer registro', async () => {
    const response = await post(body(), { key: KEY, token: issueAuthToken(colaborador) });
    expect(response.status).toBe(403);
    expect(mockDb.keys).toHaveLength(0);
    expect(mockDb.tarefas).toHaveLength(0);
    expect(mockDb.sessions).toBe(0);
  });

  test('8. token invalido ou revogado: 401 sem registro nem criacao', async () => {
    expect((await post(body(), { key: KEY, token: 'nao-e-um-jwt' })).status).toBe(401);
    const revoked = tokenAdmin;
    admin.authVersion = 1;
    expect((await post(body(), { key: KEY, token: revoked })).status).toBe(401);
    expect(mockDb.keys).toHaveLength(0);
    expect(mockDb.tarefas).toHaveLength(0);
  });

  test('9. equipe ausente, malformada, inexistente ou inacessivel', async () => {
    // Sem banco: 400 antes da chave, mesmas mensagens do legado.
    for (const [changed, mensagem] of [
      [{ equipe: undefined }, 'Equipe é obrigatória'],
      [{ equipe: '' }, 'Equipe é obrigatória'],
      [{ equipe: 123 }, 'Equipe inválida'],
      [{ equipe: { $ne: null } }, 'Equipe inválida'],
      [{ equipe: 'nao-e-id' }, 'Equipe inválida'],
    ]) {
      const response = await post(body(changed), { key: KEY });
      expect(response.status).toBe(400);
      expect(response.body).toEqual({ erro: mensagem });
    }
    expect(mockDb.keys).toHaveLength(0);

    // Equipe de outro admin (sem acesso) e equipe inexistente: decidido na transacao e guardado como final.
    const semAcesso = await post(body({ equipe: equipeOutra._id, user: '' }), { key: KEY });
    expect(semAcesso.status).toBe(400);
    expect(semAcesso.body).toEqual({ erro: 'Equipe inválida' });
    const consultas = mockDb.equipeFindSessions.length;
    const repetida = await post(body({ equipe: equipeOutra._id, user: '' }), { key: KEY });
    expect(repetida.status).toBe(400);
    expect(repetida.headers['idempotency-replayed']).toBe('true');
    expect(mockDb.equipeFindSessions).toHaveLength(consultas); // repeticao nao consulta de novo
    expect((await post(body({ equipe: id(), user: '' }), { key: KEY_2 })).body).toEqual({ erro: 'Equipe inválida' });
    expect(mockDb.tarefas).toHaveLength(0);
    expect(mockDb.logs).toHaveLength(0);
  });

  test('10. responsavel invalido, admin, inexistente ou fora da equipe', async () => {
    for (const [user, mensagem] of [[123, 'User inválido'], [{ $ne: null }, 'User inválido'], ['nao-e-id', 'User inválido']]) {
      const response = await post(body({ user }), { key: KEY });
      expect(response.status).toBe(400);
      expect(response.body).toEqual({ erro: mensagem });
    }
    expect(mockDb.keys).toHaveLength(0);

    const casos = [
      [admin2._id, 'User inválido'],
      [id(), 'User inválido'],
      [colaboradorFora._id, 'Usuário não pertence à equipe selecionada'],
    ];
    for (const [index, [user, mensagem]] of casos.entries()) {
      const key = `3f1c2b6e-8a4d-4c1b-9e2f-7a6b5c4d3e3${index}`;
      const response = await post(body({ user }), { key });
      expect(response.status).toBe(400);
      expect(response.body).toEqual({ erro: mensagem });
    }
    expect(mockDb.tarefas).toHaveLength(0);
    expect(mockDb.logs).toHaveLength(0);
  });

  test('10b. dados fora do schema (prazo invalido, urgencia desconhecida): 400 sem consumir a chave', async () => {
    for (const changed of [{ dataEntrega: 'amanha' }, { urgencia: 'urgentissima' }, { descricao: '' }, { subtarefas: [{}] }]) {
      const protegido = await post(body(changed), { key: KEY });
      const legado = await post(body(changed));
      expect(protegido.status).toBe(400);
      expect(protegido.body).toEqual({ erro: 'Dados da tarefa inválidos.' });
      expect(legado.body).toEqual(protegido.body); // paridade com o legado
    }
    expect(mockDb.keys).toHaveLength(0);
    expect(mockDb.tarefas).toHaveLength(0);
  });

  test('11 e 13. erro ao salvar a tarefa: rollback completo; a mesma chave cria uma unica vez depois', async () => {
    mockTx.failTarefaSave = new Error('falha interna /tmp/segredo');
    const failed = await post(body(), { key: KEY });
    expect(failed.status).toBe(500);
    expect(failed.body).toEqual({ erro: 'Erro ao criar tarefa' });
    expect(JSON.stringify(failed.body)).not.toContain('segredo');
    expect(mockDb.tarefas).toHaveLength(0);
    expect(mockDb.logs).toHaveLength(0);
    expect(mockDb.keys[0]).toMatchObject({ status: 'failed', failure: { retryable: true } });

    mockTx.failTarefaSave = null;
    expect((await post(body(), { key: KEY })).status).toBe(201);
    expect(mockDb.tarefas).toHaveLength(1);
    expect(mockDb.logs).toHaveLength(1);
  });

  test('12 e 13. erro ao salvar o log: tarefa e chave tambem voltam; nada fica pela metade', async () => {
    mockTx.failLogSave = new Error('log fora do ar');
    const failed = await post(body(), { key: KEY });
    expect(failed.status).toBe(500);
    expect(failed.body).toEqual({ erro: 'Erro ao criar tarefa' });
    expect(mockDb.tarefaSaves).toEqual([{ withSession: true }]); // a tarefa chegou a ser gravada na sessao...
    expect(mockDb.tarefas).toHaveLength(0); // ...e foi desfeita junto com o log
    expect(mockDb.logs).toHaveLength(0);
    expect(mockDb.keys[0].status).not.toBe('completed');
    expect(mockDb.keys[0].result).toBeUndefined();

    mockTx.failLogSave = null;
    const retry = await post(body(), { key: KEY });
    expect(retry.status).toBe(201);
    expect(mockDb.tarefas).toHaveLength(1);
    expect(mockDb.logs).toHaveLength(1);
    expect(String(mockDb.logs[0].tarefa)).toBe(retry.body._id);
  });

  test('13b. conflito transitorio: o withTransaction repete e fica uma tarefa e um log', async () => {
    mockTx.commitPlan = ['transient', 'transient'];
    expect((await post(body(), { key: KEY })).status).toBe(201);
    expect(mockDb.tarefaSaves).toHaveLength(3);
    expect(mockDb.logSaves).toHaveLength(3);
    expect(mockDb.tarefas).toHaveLength(1);
    expect(mockDb.logs).toHaveLength(1);
  });

  test('14. commit com resultado desconhecido: sem confirmacao nao cria de novo; se entrou, responde 201', async () => {
    mockTx.commitPlan = ['unknown_not_applied'];
    const unknown = await post(body(), { key: KEY });
    expect(unknown.status).toBe(409);
    expect(unknown.body.code).toBe('idempotency_outcome_unknown');
    expect(unknown.body.erro).toContain('tarefa');
    expect((await post(body(), { key: KEY })).status).toBe(409);
    expect(mockDb.tarefas).toHaveLength(0);
    expect(mockDb.logs).toHaveLength(0);

    mockTx.commitPlan = ['unknown_applied'];
    const applied = await post(body(), { key: KEY_2 });
    expect(applied.status).toBe(201);
    expect((await post(body(), { key: KEY_2 })).headers['idempotency-replayed']).toBe('true');
    expect(mockDb.tarefas).toHaveLength(1);
    expect(mockDb.logs).toHaveLength(1);
  });

  test('15. banco sem transacoes: 503 sem criar; o fluxo sem cabecalho continua funcionando', async () => {
    mockTx.supported = false;
    const response = await post(body(), { key: KEY });
    expect(response.status).toBe(503);
    expect(response.body).toEqual({ erro: 'Serviço temporariamente indisponível.', code: 'transactions_unavailable' });
    expect(response.headers['retry-after']).toBe('2');
    expect(mockDb.tarefas).toHaveLength(0);
    expect(mockDb.keys).toHaveLength(0);
    expect((await post(body())).status).toBe(201);
  });

  test('16. sem o indice unico (ou colecao inexistente): 503 sem criar', async () => {
    for (const indexes of [[{ key: { _id: 1 }, name: '_id_' }], new Error('ns not found')]) {
      mockTx.indexes = indexes;
      app = loadApp();
      const response = await post(body(), { key: KEY });
      expect(response.status).toBe(503);
      expect(response.body.code).toBe('idempotency_unavailable');
    }
    expect(mockDb.tarefas).toHaveLength(0);
    expect(mockDb.keys).toHaveLength(0);
  });

  test('17. permissao alterada antes da repeticao: nada e devolvido sem o acesso atual', async () => {
    const created = await post(body(), { key: KEY });
    expect(created.status).toBe(201);

    admin.tipo = 'user'; // rebaixado: token antigo cai na sessao; token novo cai no isAdmin
    const old = await post(body(), { key: KEY });
    expect(old.status).toBe(401);
    expect(JSON.stringify(old.body)).not.toContain('Relatório');
    const asUser = await post(body(), { key: KEY, token: issueAuthToken(admin) });
    expect(asUser.status).toBe(403);
    expect(JSON.stringify(asUser.body)).not.toContain('Relatório');
    admin.tipo = 'admin';

    // Ainda admin, mas sem acesso a equipe da tarefa (saiu da equipe e nao e mais o criador dela).
    equipe.createdBy = admin2._id;
    equipe.membros = [admin2._id, colaborador._id];
    const semAcesso = await post(body(), { key: KEY });
    expect(semAcesso.status).toBe(404);
    expect(semAcesso.body).toEqual({ erro: 'Tarefa não encontrada' });
    equipe.createdBy = admin._id;

    // Tarefa excluida: 404, e a repeticao nao cria outra.
    mockDb.tarefas.length = 0;
    expect((await post(body(), { key: KEY })).status).toBe(404);
    expect(mockDb.tarefas).toHaveLength(0);
    expect(mockDb.tarefaSaves).toHaveLength(1);
    expect(mockDb.logs).toHaveLength(1);
  });

  test('18. formato da resposta igual ao legado; anexos assinados na hora e nunca guardados na chave', async () => {
    const legado = await post(body());
    const protegido = await post(body(), { key: KEY });
    expect(keysOf(protegido.body)).toEqual(keysOf(legado.body));
    expect(protegido.body.subtarefas.map(keysOf)).toEqual(legado.body.subtarefas.map(keysOf));
    for (const campo of ['descricao', 'detalhes', 'dataEntrega', 'tempoEstimado', 'urgencia', 'tags', 'status', 'user', 'equipe',
      'createdBy', 'tempoGasto', 'cronometroAtivo', 'tempoExcedido', 'anexos']) {
      expect(protegido.body[campo]).toEqual(legado.body[campo]);
    }

    // Anexo incluido depois: na repeticao, a URL e assinada de novo e nao entra no registro da chave.
    const tarefa = mockDb.tarefas.find((row) => String(row._id) === protegido.body._id);
    tarefa.anexos.push({ _id: new mongoose.Types.ObjectId(), url: 'tarefas/anexo.pdf', nomeOriginal: 'anexo.pdf' });
    const r1 = await post(body(), { key: KEY });
    const r2 = await post(body(), { key: KEY });
    expect(r1.body.anexos[0].url).toMatch(/^https:\/\/storage\.test\/tarefas\/anexo\.pdf\?X-Goog-Signature=sig\d+$/);
    expect(r2.body.anexos[0].url).not.toBe(r1.body.anexos[0].url);
    const stored = JSON.stringify(mockDb.keys);
    for (const text of ['storage.test', 'X-Goog-Signature', 'anexo.pdf', 'Relatório', 'Consolidar', 'financeiro', 'Bearer']) {
      expect(stored).not.toContain(text);
    }
  });

  test('identidade so do JWT: createdBy no corpo e ignorado; outra conta tem escopo proprio de chave', async () => {
    const spoof = await post({ ...body(), createdBy: admin2._id, userId: admin2._id }, { key: KEY });
    expect(spoof.status).toBe(201);
    expect(mockDb.keys[0].userId).toBe(admin._id);
    expect(String(mockDb.tarefas[0].createdBy)).toBe(admin._id);
    expect(String(mockDb.logs[0].user)).toBe(admin._id);

    const other = await post(body({ equipe: equipeOutra._id, user: colaboradorFora._id }), { key: KEY, token: issueAuthToken(admin2) });
    expect(other.status).toBe(201);
    expect(other.headers['idempotency-replayed']).toBeUndefined();
    expect(mockDb.tarefas).toHaveLength(2);
  });

  test('chave invalida (inclusive vazia): 400, sem cair no fluxo legado', async () => {
    for (const key of ['', 'abc', `${KEY}, ${KEY_2}`, 'x'.repeat(300)]) {
      const response = await post(body(), { key });
      expect(response.status).toBe(400);
      expect(response.body).toEqual({ erro: 'Chave de idempotência inválida.', code: 'idempotency_key_invalid' });
    }
    expect(mockDb.tarefas).toHaveLength(0);
    expect(mockDb.tarefaSaves).toHaveLength(0);
    expect(mockDb.keys).toHaveLength(0);
  });
});

describe('activityLogger', () => {
  const logActivity = jest.requireActual('../utils/activityLogger');

  beforeEach(() => {
    mockDb.logs.splice(0, mockDb.logs.length);
    mockDb.logSaves.splice(0, mockDb.logSaves.length);
    mockTx.failLogSave = null;
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('sem session (todos os usos atuais): grava fora de transacao e falha nao sobe', async () => {
    await logActivity('criacao', 'ok', id(), id());
    expect(mockDb.logSaves).toEqual([{ withSession: false }]);
    mockTx.failLogSave = new Error('fora do ar');
    await expect(logActivity('criacao', 'x', id(), id())).resolves.toBeUndefined();
    expect(console.error).toHaveBeenCalledWith('Erro ao registrar log de atividade:', mockTx.failLogSave);
  });

  test('com session: grava na transacao e a falha SOBE (inclusive de validacao)', async () => {
    const session = { tarefas: [], logs: [], keys: new Map() };
    await logActivity('criacao', 'ok', id(), id(), { session });
    expect(mockDb.logSaves).toEqual([{ withSession: true }]);
    expect(session.logs).toHaveLength(1);
    expect(mockDb.logs).toHaveLength(0);

    mockTx.failLogSave = new Error('fora do ar');
    await expect(logActivity('criacao', 'x', id(), id(), { session })).rejects.toThrow('fora do ar');
    mockTx.failLogSave = null;
    await expect(logActivity('tipo_inexistente', 'x', id(), id(), { session })).rejects.toThrow();
    expect(console.error).not.toHaveBeenCalled();
  });
});
