// PUT /api/tarefas/:id/status com Idempotency-Key (opt-in): rotas reais, auth e sessionGuard reais; banco,
// transacao e Socket.IO simulados. O falso modela o que importa aqui:
// - leitura: documento Mongoose REAL (hydrate: padroes do schema, conversao de tipos) com o populate da equipe;
// - updateOne: filtro e update passam pela conversao real do Mongoose; o filtro e avaliado com a semantica do
//   MongoDB (null/ausente, $in, $ne, $not/$type);
// - transacao: escrita trava a tarefa ate o commit/abort; outra transacao recebe WriteConflict
//   (TransientTransactionError) e o withTransaction repete o callback depois que a trava sai; escrita fora de
//   transacao ESPERA a trava e so entao avalia o filtro. Isolamento por snapshot: se a tarefa recebeu uma escrita
//   confirmada depois do inicio da transacao, a escrita da transacao recebe WriteConflict (como no MongoDB);
// - logs, notificacoes, chave e tarefa ficam na sessao ate o commit; rollback descarta tudo;
// - Socket.IO registra cada emissao com o numero de commits e de transacoes abertas naquele instante.
// Nenhuma conexao real, nenhum indice criado.
const request = require('supertest');
const mongoose = require('mongoose');

jest.setTimeout(30000);

const mockFresh = () => ({
  users: [], equipes: [], tarefas: [], logs: [], notifications: [], keys: [], emits: [],
  reads: [], updateCalls: [], logSaves: [], notificationInserts: [],
  locks: new Map(), rowSeq: new Map(), seq: 0, commits: 0, sessions: 0, openSessions: 0, conflicts: 0,
});
const mockDb = mockFresh();
const mockTxDefaults = () => ({
  supported: true, indexes: null, failUpdate: null, updateResult: null, failLogTipo: null, failNotification: null,
  aposLer: null, antesDeGravar: null, pauseAfterLock: null, commitPlan: [],
});
const mockTx = mockTxDefaults();
const mockSame = (a, b) => a != null && b != null && String(a) === String(b);
const mockPlain = (value) => JSON.parse(JSON.stringify(value));
const mockLabeled = (message, label) => Object.assign(new Error(message), { errorLabels: [label] });
const mockClone = (value) => {
  if (value instanceof Date) return new Date(value.getTime());
  if (Array.isArray(value)) return value.map(mockClone);
  if (value && typeof value === 'object' && value.constructor === Object) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, mockClone(item)]));
  }
  return value;
};
const mockEq = (value, cond) => {
  if (cond === null) return value === null || value === undefined;
  if (cond instanceof Date) return value instanceof Date && value.getTime() === cond.getTime();
  if (value === null || value === undefined) return false;
  if (typeof cond === 'boolean' || typeof cond === 'number') return value === cond;
  return String(value) === String(cond);
};
const mockIsOperator = (cond) =>
  cond !== null && typeof cond === 'object' && cond.constructor === Object && Object.keys(cond).some((key) => key.startsWith('$'));
const mockCond = (value, cond) => {
  if (!mockIsOperator(cond)) return mockEq(value, cond);
  return Object.entries(cond).every(([op, arg]) => {
    if (op === '$in') return arg.some((item) => mockEq(value, item));
    if (op === '$ne') return !mockEq(value, arg);
    if (op === '$not') {
      if (Object.keys(arg).length !== 1 || arg.$type !== 'date') throw new Error('$not nao suportado no teste');
      return !(value instanceof Date);
    }
    throw new Error(`operador nao suportado no teste: ${op}`);
  });
};
const mockMatches = (row, filter) => Object.entries(filter).every(([campo, cond]) => mockCond(row[campo], cond));
const mockApply = (row, update) => {
  Object.entries(update.$set || {}).forEach(([campo, valor]) => { row[campo] = mockClone(valor); });
  Object.keys(update.$unset || {}).forEach((campo) => { delete row[campo]; });
};
const mockWaitUnlocked = async (row) => {
  while (row && mockDb.locks.has(row)) {
    await mockDb.locks.get(row).promise;
  }
};
const mockThenable = (produce, onSession) => {
  const query = {
    select: () => query,
    sort: () => query,
    populate: () => query,
    session: (session) => {
      if (onSession) onSession(session);
      return query;
    },
    then: (resolve, reject) => Promise.resolve().then(produce).then(resolve, reject),
  };
  return query;
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
  find: jest.fn(() => mockThenable(() => [])),
  findById: jest.fn(() => mockThenable(() => null)),
  findOne: jest.fn(() => mockThenable(() => null)),
  updateMany: jest.fn(async () => ({})),
}));

jest.mock('../models/Tarefa', () => {
  const EquipeReal = jest.requireActual('../models/Equipe');
  const Real = jest.requireActual('../models/Tarefa');

  const ler = async (filter, populate, session) => {
    mockDb.reads.push({ withSession: Boolean(session) });
    const row = mockDb.tarefas.find((item) => mockMatches(item, filter));
    let doc = null;
    if (row) {
      doc = Real.hydrate(mockClone(row)); // como o findOne real: valor que nao converte fica undefined
      if (populate) {
        const equipe = mockDb.equipes.find((item) => mockSame(item._id, row.equipe));
        doc.equipe = EquipeReal.hydrate({ _id: equipe._id, createdBy: equipe.createdBy, nome: equipe.nome });
      }
    }
    // Pausa DEPOIS de tirar a foto da leitura: escritas feitas agora deixam esta leitura desatualizada.
    if (mockTx.aposLer) await mockTx.aposLer({ session });
    return doc;
  };

  const conflito = (waitFor) => {
    mockDb.conflicts += 1;
    const err = mockLabeled('WriteConflict', 'TransientTransactionError');
    if (waitFor) err.waitFor = waitFor;
    return err;
  };

  return {
    findOne: jest.fn((filter) => {
      let populate = false;
      let session = null;
      const query = {
        populate: () => {
          populate = true;
          return query;
        },
        session: (value) => {
          session = value;
          return query;
        },
        then: (resolve, reject) => ler(filter, populate, session).then(resolve, reject),
      };
      return query;
    }),
    updateOne: jest.fn(async (filter, update, options = {}) => {
      const { session } = options;
      // Conversao real do Mongoose (tipos do filtro e do update); a query nunca e executada.
      const query = Real.updateOne(filter, update, { timestamps: options.timestamps, runValidators: options.runValidators });
      query.cast(Real);
      query._castUpdate(query._update);
      const chamada = {
        withSession: Boolean(session),
        filtro: query.getFilter(),
        update: mockClone(update),
        timestamps: query._mongooseOptions.timestamps,
        runValidators: query.getOptions().runValidators,
      };
      mockDb.updateCalls.push(chamada);
      if (mockTx.antesDeGravar) await mockTx.antesDeGravar(chamada);
      if (mockTx.failUpdate) throw mockTx.failUpdate;
      if (mockTx.updateResult) return mockTx.updateResult;
      const row = mockDb.tarefas.find((item) => mockSame(item._id, chamada.filtro._id));
      if (!session) {
        // Fluxo legado: espera a trava da transacao e so entao avalia e aplica, sem await no meio (atomico).
        await mockWaitUnlocked(row);
        if (!row || !mockMatches(row, chamada.filtro)) return { acknowledged: true, matchedCount: 0, modifiedCount: 0 };
        mockApply(row, update);
        mockDb.rowSeq.set(row, ++mockDb.seq);
        return { acknowledged: true, matchedCount: 1, modifiedCount: 1 };
      }
      if (row) {
        const lock = mockDb.locks.get(row);
        if (lock && lock.session !== session) throw conflito(lock.promise);
        if ((mockDb.rowSeq.get(row) || 0) > session.snapshot) throw conflito(null); // escrita depois do snapshot
      }
      if (!row || !mockMatches(row, chamada.filtro)) return { acknowledged: true, matchedCount: 0, modifiedCount: 0 };
      if (!mockDb.locks.has(row)) {
        let release;
        const promise = new Promise((resolve) => { release = resolve; });
        mockDb.locks.set(row, { session, promise, release });
        session.locked.push(row);
      }
      session.tarefaOps.push({ row, update: mockClone(update) });
      if (mockTx.pauseAfterLock) await mockTx.pauseAfterLock(); // transacao aberta segurando a trava
      return { acknowledged: true, matchedCount: 1, modifiedCount: 1 };
    }),
    find: jest.fn(() => mockThenable(() => [])),
    findById: jest.fn(() => mockThenable(() => null)),
  };
});

jest.mock('../models/ActivityLog', () => {
  const Real = jest.requireActual('../models/ActivityLog');
  function Model(data) {
    const doc = new Real(data);
    doc.save = async (options = {}) => {
      mockDb.logSaves.push({ withSession: Boolean(options.session), tipoAcao: data.tipoAcao });
      await doc.validate();
      if (mockTx.failLogTipo === data.tipoAcao) throw new Error(`falha ao gravar ${data.tipoAcao}`);
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
    session.tarefaOps.forEach(({ row, update }) => {
      mockApply(row, update);
      mockDb.rowSeq.set(row, ++mockDb.seq);
    });
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
        const session = {
          id: mockDb.sessions, snapshot: mockDb.seq, keys: new Map(), tarefaOps: [], logs: [], notifications: [], locked: [],
        };
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

const KEY = '3f1c2b6e-8a4d-4c1b-9e2f-7a6b5c4d3e2f';
const KEY_2 = '9d8c7b6a-5f4e-4d3c-8b2a-1f0e9d8c7b6a';
const KEY_3 = '1a2b3c4d-5e6f-4a1b-8c2d-3e4f5a6b7c8d';
const SEM_ACESSO_403 = { erro: 'Você não pode editar essa tarefa' };
const ERRO_500 = { erro: 'Erro ao atualizar status' };
const MSG_INCONSISTENTE = 'O cronômetro desta tarefa está inconsistente: o horário de início está ausente, '
  + 'inválido ou no futuro. Nenhum tempo foi contabilizado e a tarefa não foi alterada.';
const MSG_CONFLITO = 'A tarefa foi alterada por outra operação ao mesmo tempo. Tente novamente.';
const CAMPOS_DA_TRANSICAO = ['status', 'tempoGasto', 'cronometroAtivo', 'tempoExcedido', 'ultimaAtualizacaoCronometro', 'updatedAt'];
const NAO_FALSIFICAR_ALEM_DE_DATE = [
  'hrtime', 'nextTick', 'performance', 'queueMicrotask', 'requestAnimationFrame', 'cancelAnimationFrame',
  'requestIdleCallback', 'cancelIdleCallback', 'setImmediate', 'clearImmediate', 'setInterval', 'clearInterval',
  'setTimeout', 'clearTimeout',
];
const id = () => new mongoose.Types.ObjectId().toString();
const keysOf = (value) => Object.keys(value).sort();

const loadApp = () => {
  let app;
  jest.isolateModules(() => {
    app = require('../app');
  });
  return app;
};

// Espera com prazo real de 5 s pelo performance.now() (o teste do minuto congela so o Date; contar voltas de
// setTimeout nao serve de prazo no Windows, onde cada volta leva ~15 ms).
const waitFor = async (predicate, label) => {
  const prazo = performance.now() + 5000;
  while (!predicate()) {
    if (performance.now() > prazo) throw new Error(`tempo esgotado esperando: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
};
// Portao: a pausa e liberada sempre no finally, e as requisicoes pendentes sao aguardadas.
const withGate = async (pauseKey, run) => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
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

describe('PUT /api/tarefas/:id/status com Idempotency-Key', () => {
  let app;
  let admin;
  let colaborador;
  let outro;
  let equipe;
  let tarefa;
  let token;

  const putStatus = (status, { key, tokenUsado = token, tarefaId = tarefa._id, extra = {} } = {}) => {
    const req = request(app).put(`/api/tarefas/${tarefaId}/status`).set('Authorization', `Bearer ${tokenUsado}`);
    if (key !== undefined) req.set('Idempotency-Key', key);
    return req.send({ status, ...extra });
  };
  const iniciar = (promise) => promise.then((response) => response); // supertest so dispara no then
  const ativo = (minutos, extra = {}) => Object.assign(tarefa, {
    cronometroAtivo: true,
    ultimaAtualizacaoCronometro: new Date(Date.now() - (minutos * 60 + 10) * 1000),
    ...extra,
  });
  // Escrita confirmada por outra rota, fora de transacao (entra depois do snapshot das transacoes abertas).
  const escreverFora = (mudar) => {
    mudar(tarefa);
    mockDb.rowSeq.set(tarefa, ++mockDb.seq);
  };
  const tiposLog = () => mockDb.logs.map((log) => log.tipoAcao);
  const detalhesLog = () => mockDb.logs.map((log) => log.detalhes);
  const estado = () => mockClone({ tarefa: { ...tarefa }, logs: mockDb.logs, notifications: mockDb.notifications, emits: mockDb.emits });
  const chave = (key = KEY) => mockDb.keys.find((row) => row.key === key);
  const gravacoesNaSessao = () => mockDb.updateCalls.filter((item) => item.withSession);

  beforeAll(() => {
    app = loadApp();
  });

  beforeEach(() => {
    Object.keys(mockDb).forEach((name) => {
      const value = mockFresh()[name];
      if (Array.isArray(value)) mockDb[name].splice(0, mockDb[name].length);
      else if (value instanceof Map) mockDb[name].clear();
      else mockDb[name] = value;
    });
    Object.assign(mockTx, mockTxDefaults());
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'log').mockImplementation(() => {});
    admin = { _id: id(), nome: 'Admin Ficticio', tipo: 'admin', authVersion: 0 };
    colaborador = { _id: id(), nome: 'Pessoa Ficticia', tipo: 'user', authVersion: 0 };
    outro = { _id: id(), nome: 'Outra Pessoa', tipo: 'user', authVersion: 0 };
    mockDb.users.push(admin, colaborador, outro);
    equipe = { _id: id(), createdBy: admin._id, nome: 'Equipe Alfa', membros: [colaborador._id, outro._id] };
    mockDb.equipes.push(equipe);
    tarefa = {
      _id: id(),
      descricao: 'Relatório',
      detalhes: 'Detalhe original',
      dataEntrega: new Date('2026-12-01T00:00:00.000Z'),
      createdBy: admin._id,
      status: 'pendente',
      user: colaborador._id,
      equipe: equipe._id,
      tempoEstimado: 120,
      tempoGasto: 10,
      cronometroAtivo: false,
      urgencia: 'baixa',
      tempoExcedido: false,
      tags: ['relatorio'],
      subtarefas: [],
      anexos: [{ _id: id(), url: 'tarefas/anexo.pdf', nomeOriginal: 'anexo.pdf', mimetype: 'application/pdf', size: 10 }],
      createdAt: new Date('2026-11-01T00:00:00.000Z'),
      updatedAt: new Date('2026-11-01T00:00:00.000Z'),
    };
    mockDb.tarefas.push(tarefa);
    token = issueAuthToken(colaborador);
  });

  afterEach(() => {
    Object.assign(mockTx, mockTxDefaults());
    jest.useRealTimers();
    jest.restoreAllMocks();
    // Em nenhum teste uma transacao fica aberta, uma trava fica presa ou um numero nao finito e gravado.
    expect(mockDb.openSessions).toBe(0);
    expect(mockDb.locks.size).toBe(0);
    mockDb.updateCalls.forEach(({ update }) => {
      Object.values(update.$set || {}).forEach((valor) => {
        if (typeof valor === 'number') expect(Number.isFinite(valor)).toBe(true);
      });
    });
  });

  test('1. sem a chave: fluxo legado da 5B.1, sem transacao, logs e notificacao imediatos', async () => {
    const response = await putStatus('concluido');
    expect(response.status).toBe(200);
    expect(keysOf(response.body)).toEqual(['msg', 'tarefa']);
    expect(response.body.msg).toBe('Status atualizado com sucesso');
    expect(response.headers['idempotency-replayed']).toBeUndefined();
    expect(tarefa.status).toBe('concluido');
    expect(mockDb.sessions).toBe(0);
    expect(mockDb.keys).toEqual([]);
    expect(mockDb.updateCalls.map((item) => item.withSession)).toEqual([false]);
    expect(mockDb.logSaves).toEqual([{ withSession: false, tipoAcao: 'atualizacao_status' }]);
    expect(mockDb.notificationInserts).toEqual([{ withSession: false }]);
    expect(mockDb.emits).toEqual([expect.objectContaining({ room: `user_${admin._id}`, commitsAtEmit: 0, openSessions: 0 })]);
  });

  test('2. protegida normal: tudo na mesma transacao; chave concluida so com o resumo', async () => {
    const response = await putStatus('concluido', { key: KEY });
    expect(response.status).toBe(200);
    expect(keysOf(response.body)).toEqual(['msg', 'tarefa']);
    expect(response.body.msg).toBe('Status atualizado com sucesso');
    expect(response.body.tarefa).toMatchObject({ _id: tarefa._id, status: 'concluido', equipe: { nome: 'Equipe Alfa' } });
    expect(response.headers['idempotency-replayed']).toBeUndefined();
    expect(tarefa.status).toBe('concluido');
    expect(mockDb.commits).toBe(1);
    expect(gravacoesNaSessao()).toHaveLength(1);
    expect(gravacoesNaSessao()[0]).toMatchObject({ timestamps: false, runValidators: true });
    expect(String(gravacoesNaSessao()[0].filtro.user)).toBe(colaborador._id);
    expect(mockDb.logSaves).toEqual([{ withSession: true, tipoAcao: 'atualizacao_status' }]);
    expect(mockDb.notificationInserts).toEqual([{ withSession: true }]);
    expect(detalhesLog()).toEqual(['Status alterado para concluido']);
    expect(mockDb.notifications.map((item) => item.texto)).toEqual(['Pessoa Ficticia marcou a tarefa "Relatório" como concluída']);
    expect(chave()).toMatchObject({
      userId: colaborador._id, method: 'PUT', route: '/api/tarefas/:id/status', status: 'completed',
      result: { statusCode: 200, resourceType: 'tarefa', resourceId: tarefa._id },
    });
  });

  test('3. repeticao da chave: mesma resposta, sem gravar, logar, notificar nem emitir de novo', async () => {
    expect((await putStatus('concluido', { key: KEY })).status).toBe(200);
    const depois = estado();
    const gravacoes = mockDb.updateCalls.length;
    const repeticao = await putStatus('concluido', { key: KEY, extra: { ignorado: 'campo fora do pedido' } });
    expect(repeticao.status).toBe(200);
    expect(repeticao.headers['idempotency-replayed']).toBe('true');
    expect(repeticao.body).toMatchObject({ msg: 'Status atualizado com sucesso', tarefa: { status: 'concluido' } });
    expect(mockDb.updateCalls).toHaveLength(gravacoes);
    expect(mockDb.sessions).toBe(1);
    expect(estado()).toEqual(depois);
  });

  test('4 e 5. mesma chave com outro status ou outra tarefa: 422, nada executado', async () => {
    expect((await putStatus('concluido', { key: KEY })).status).toBe(200);
    const depois = estado();
    const outroStatus = await putStatus('pendente', { key: KEY });
    expect(outroStatus.status).toBe(422);
    expect(outroStatus.body).toEqual({ erro: 'Esta chave de idempotência já foi usada com outro pedido.', code: 'idempotency_key_reused' });
    const outraTarefa = { ...mockClone(tarefa), _id: id(), status: 'pendente' };
    mockDb.tarefas.push(outraTarefa);
    const outraResposta = await putStatus('concluido', { key: KEY, tarefaId: outraTarefa._id });
    expect(outraResposta.status).toBe(422);
    expect(outraTarefa.status).toBe('pendente');
    expect(mockDb.sessions).toBe(1);
    expect(estado()).toEqual(depois);
  });

  test('6. status invalido antes da chave; chave invalida ou vazia: 400 sem reivindicar nada', async () => {
    for (const status of [undefined, '', 'parado', ['pendente'], { $ne: null }]) {
      const response = await putStatus(status, { key: KEY });
      expect([response.status, response.body]).toEqual([400, { erro: 'Status inválido' }]);
    }
    for (const key of ['nao-e-uuid', '']) {
      const response = await putStatus('concluido', { key });
      expect([response.status, response.body]).toEqual([400, { erro: 'Chave de idempotência inválida.', code: 'idempotency_key_invalid' }]);
    }
    expect(mockDb.keys).toEqual([]);
    expect(mockDb.sessions).toBe(0);
    expect(tarefa.status).toBe('pendente');
  });

  test('7. tarefa de outro responsavel, sem responsavel ou ID invalido: 403; a recusa fica guardada na chave', async () => {
    tarefa.user = outro._id;
    const response = await putStatus('concluido', { key: KEY });
    expect([response.status, response.body]).toEqual([403, SEM_ACESSO_403]);
    expect(chave()).toMatchObject({ status: 'failed', failure: { statusCode: 403, code: 'tarefa_inacessivel', retryable: false } });
    // Atribuida depois a pessoa: a mesma chave continua devolvendo a recusa guardada (use outra chave).
    tarefa.user = colaborador._id;
    const repeticao = await putStatus('concluido', { key: KEY });
    expect([repeticao.status, repeticao.body]).toEqual([403, SEM_ACESSO_403]);
    expect(repeticao.headers['idempotency-replayed']).toBe('true');
    expect(tarefa.status).toBe('pendente');

    tarefa.user = null;
    expect((await putStatus('concluido', { key: KEY_2 })).status).toBe(403);
    const invalido = await putStatus('concluido', { key: KEY_3, tarefaId: 'nao-e-id' });
    expect([invalido.status, invalido.body]).toEqual([403, SEM_ACESSO_403]);
    expect(chave(KEY_3)).toBeUndefined(); // recusado antes de reivindicar
    expect(mockDb.logs).toEqual([]);
    expect(mockDb.notifications).toEqual([]);
  });

  test('8. token invalido ou revogado: 401 antes de qualquer chave; admin barrado pelo isUser', async () => {
    expect((await putStatus('concluido', { key: KEY, tokenUsado: 'nao-e-um-jwt' })).status).toBe(401);
    colaborador.authVersion = 1;
    expect((await putStatus('concluido', { key: KEY })).status).toBe(401);
    expect((await putStatus('concluido', { key: KEY, tokenUsado: issueAuthToken(admin) })).status).toBe(403);
    expect(mockDb.keys).toEqual([]);
    expect(tarefa.status).toBe('pendente');
  });

  test('9. reatribuida antes da repeticao: 403 sem dados da tarefa e sem efeitos', async () => {
    expect((await putStatus('concluido', { key: KEY })).status).toBe(200);
    tarefa.user = outro._id;
    const depois = estado();
    const repeticao = await putStatus('concluido', { key: KEY });
    expect([repeticao.status, repeticao.body]).toEqual([403, SEM_ACESSO_403]);
    expect(estado()).toEqual(depois);
    // Sessao revogada antes da repeticao: 401.
    tarefa.user = colaborador._id;
    colaborador.authVersion = 1;
    expect((await putStatus('concluido', { key: KEY })).status).toBe(401);
  });

  test('10. mesmo status em nova requisicao com outra chave: repete os efeitos do legado', async () => {
    expect((await putStatus('concluido', { key: KEY })).status).toBe(200);
    const updatedAt = tarefa.updatedAt.getTime();
    const segunda = await putStatus('concluido', { key: KEY_2 });
    expect(segunda.status).toBe(200);
    expect(segunda.headers['idempotency-replayed']).toBeUndefined();
    expect(gravacoesNaSessao()[1].update).toEqual({ $set: { status: 'concluido' } }); // nada muda: updatedAt intacto
    expect(tarefa.updatedAt.getTime()).toBe(updatedAt);
    expect(tiposLog()).toEqual(['atualizacao_status', 'atualizacao_status']);
    expect(mockDb.notifications).toHaveLength(2);
    expect(mockDb.emits).toHaveLength(2);
  });

  test('11. cronometro ativo e status em_andamento: nao pausa nem inicia', async () => {
    ativo(30);
    const inicio = tarefa.ultimaAtualizacaoCronometro.getTime();
    expect((await putStatus('em_andamento', { key: KEY })).status).toBe(200);
    expect(tarefa).toMatchObject({ status: 'em_andamento', cronometroAtivo: true, tempoGasto: 10 });
    expect(tarefa.ultimaAtualizacaoCronometro.getTime()).toBe(inicio);
    expect(tiposLog()).toEqual(['atualizacao_status']);
  });

  test('12. pausa automatica: minutos inteiros, tempoExcedido, inicio removido, logs na mesma transacao', async () => {
    ativo(30, { tempoEstimado: 20, status: 'em_andamento' });
    const inicio = tarefa.ultimaAtualizacaoCronometro;
    const response = await putStatus('concluido', { key: KEY });
    expect(response.status).toBe(200);
    expect(tarefa).toMatchObject({ status: 'concluido', cronometroAtivo: false, tempoGasto: 40, tempoExcedido: true });
    expect('ultimaAtualizacaoCronometro' in tarefa).toBe(false);
    const [gravacao] = gravacoesNaSessao();
    expect(gravacao.filtro).toMatchObject({ cronometroAtivo: true, tempoGasto: 10, tempoEstimado: 20, tempoExcedido: { $ne: true } });
    expect(gravacao.filtro.ultimaAtualizacaoCronometro.getTime()).toBe(inicio.getTime());
    expect(mockDb.logSaves).toEqual([
      { withSession: true, tipoAcao: 'cronometro_pausado' },
      { withSession: true, tipoAcao: 'atualizacao_status' },
    ]);
    expect(detalhesLog()).toEqual([
      'Cronômetro pausado automaticamente pela alteração de status para concluido. +30 mins',
      'Status alterado para concluido',
    ]);
    expect(response.body.tarefa).toMatchObject({ tempoGasto: 40, cronometroAtivo: false, tempoExcedido: true });
  });

  test('13. repeticao depois da pausa: nao soma os minutos de novo nem pausa um cronometro reiniciado', async () => {
    ativo(30, { status: 'em_andamento' });
    expect((await putStatus('concluido', { key: KEY })).status).toBe(200);
    expect(tarefa.tempoGasto).toBe(40);
    // A pessoa reinicia o cronometro depois (outra rota).
    escreverFora((t) => Object.assign(t, { cronometroAtivo: true, ultimaAtualizacaoCronometro: new Date(Date.now() - 5 * 60 * 1000) }));
    const logs = mockDb.logs.length;
    const repeticao = await putStatus('concluido', { key: KEY });
    expect(repeticao.status).toBe(200);
    expect(repeticao.headers['idempotency-replayed']).toBe('true');
    expect(tarefa).toMatchObject({ tempoGasto: 40, cronometroAtivo: true }); // nada desfeito nem somado
    expect(repeticao.body.tarefa).toMatchObject({ tempoGasto: 40, cronometroAtivo: true }); // estado atual
    expect(mockDb.logs).toHaveLength(logs);
    expect(mockDb.notifications).toHaveLength(1);
  });

  test('14. duas chaves concorrentes: a segunda espera a trava, rele e nao pausa de novo', async () => {
    ativo(30, { status: 'em_andamento' });
    await withGate('pauseAfterLock', async ({ pending, release }) => {
      const primeira = iniciar(putStatus('concluido', { key: KEY }));
      pending.push(primeira);
      await waitFor(() => mockDb.locks.size === 1, 'primeira transacao com a trava');
      mockTx.pauseAfterLock = null; // so a primeira fica parada
      const segunda = iniciar(putStatus('pendente', { key: KEY_2 }));
      pending.push(segunda);
      await waitFor(() => mockDb.conflicts >= 1, 'segunda em WriteConflict');
      release();
      const [r1, r2] = await Promise.all([primeira, segunda]);
      expect([r1.status, r2.status]).toEqual([200, 200]);
    });
    expect(tarefa).toMatchObject({ status: 'pendente', cronometroAtivo: false, tempoGasto: 40 });
    expect(detalhesLog()).toEqual([
      'Cronômetro pausado automaticamente pela alteração de status para concluido. +30 mins',
      'Status alterado para concluido',
      'Status alterado para pendente',
    ]);
    expect(mockDb.notifications).toHaveLength(2);
    expect(mockDb.emits.every((emit) => emit.openSessions === 0 || emit.commitsAtEmit >= 1)).toBe(true);
  });

  test('15. protegida x legado, nas duas ordens: o tempo entra uma vez so', async () => {
    // a) A protegida segura a trava; o legado le o estado antigo, espera a trava, nao casa, rele e so muda o status.
    ativo(30, { status: 'em_andamento' });
    await withGate('pauseAfterLock', async ({ pending, release }) => {
      const protegida = iniciar(putStatus('concluido', { key: KEY }));
      pending.push(protegida);
      await waitFor(() => mockDb.locks.size === 1, 'protegida com a trava');
      mockTx.pauseAfterLock = null;
      const legado = iniciar(putStatus('pendente'));
      pending.push(legado);
      await waitFor(() => mockDb.updateCalls.some((item) => !item.withSession), 'legado esperando a trava');
      release();
      const [rp, rl] = await Promise.all([protegida, legado]);
      expect([rp.status, rl.status]).toEqual([200, 200]);
    });
    expect(tarefa).toMatchObject({ status: 'pendente', cronometroAtivo: false, tempoGasto: 40 });
    expect(mockDb.updateCalls.filter((item) => !item.withSession)).toHaveLength(2); // nao casou, releu
    expect(detalhesLog()).toEqual([
      'Cronômetro pausado automaticamente pela alteração de status para concluido. +30 mins',
      'Status alterado para concluido',
      'Status alterado para pendente',
    ]);

    // b) O legado grava entre a leitura e a gravacao da protegida: WriteConflict, o callback repete e recalcula.
    mockDb.logs.splice(0, mockDb.logs.length);
    Object.assign(tarefa, { status: 'em_andamento', tempoGasto: 10 });
    ativo(30);
    let pausou = false;
    let liberar;
    const portao = new Promise((resolve) => { liberar = resolve; });
    mockTx.aposLer = async ({ session }) => {
      if (session && !pausou) {
        pausou = true;
        await portao;
      }
    };
    const sessoes = mockDb.sessions;
    const protegida = iniciar(putStatus('concluido', { key: KEY_2 }));
    try {
      await waitFor(() => pausou, 'protegida leu');
      expect((await putStatus('pendente')).status).toBe(200);
    } finally {
      liberar();
    }
    expect((await protegida).status).toBe(200);
    expect(mockDb.sessions - sessoes).toBe(2); // callback repetido
    expect(tarefa).toMatchObject({ status: 'concluido', cronometroAtivo: false, tempoGasto: 40 });
    expect(detalhesLog()).toEqual([
      'Cronômetro pausado automaticamente pela alteração de status para pendente. +30 mins',
      'Status alterado para pendente',
      'Status alterado para concluido',
    ]);
  });

  describe('16 a 20. falhas dentro da transacao: rollback completo e a mesma chave pode tentar de novo', () => {
    const FALHAS = [
      ['16. atualizacao da tarefa', () => { mockTx.failUpdate = Object.assign(new Error('conexao interrompida'), { name: 'MongoNetworkError' }); }],
      ['17. ActivityLog de status', () => { mockTx.failLogTipo = 'atualizacao_status'; }],
      ['18. ActivityLog da pausa', () => { mockTx.failLogTipo = 'cronometro_pausado'; }],
      ['19. notificacao', () => { mockTx.failNotification = new Error('falha ao gravar notificacao'); }],
    ];

    test.each(FALHAS)('%s: 500, nada confirmado; depois da falha a mesma chave executa uma vez (20)', async (_rotulo, falhar) => {
      ativo(30, { status: 'em_andamento' });
      const antes = estado();
      falhar();
      const response = await putStatus('concluido', { key: KEY });
      expect([response.status, response.body]).toEqual([500, ERRO_500]);
      expect(estado()).toEqual(antes); // tarefa, logs, notificacoes e emissoes intactos
      expect(mockDb.commits).toBe(0);
      expect(chave()).toMatchObject({ status: 'failed', failure: { statusCode: 500, code: 'execution_failed', retryable: true } });

      Object.assign(mockTx, mockTxDefaults());
      const novaTentativa = await putStatus('concluido', { key: KEY });
      expect(novaTentativa.status).toBe(200);
      expect(tarefa).toMatchObject({ status: 'concluido', cronometroAtivo: false, tempoGasto: 40 });
      expect(tiposLog()).toEqual(['cronometro_pausado', 'atualizacao_status']);
      expect(mockDb.notifications).toHaveLength(1);
      expect(mockDb.emits).toHaveLength(1);
      expect(chave()).toMatchObject({ status: 'completed', attempts: 2 });
    });
  });

  test('matchedCount != 1 dentro da transacao: 409 de conflito, nada gravado; resultado sem confirmacao: 500', async () => {
    ativo(30, { status: 'em_andamento' });
    const antes = estado();
    mockTx.updateResult = { acknowledged: true, matchedCount: 0, modifiedCount: 0 };
    const conflito = await putStatus('concluido', { key: KEY });
    expect([conflito.status, conflito.body]).toEqual([409, { erro: MSG_CONFLITO }]);
    expect(chave()).toMatchObject({ status: 'failed', failure: { statusCode: 409, code: 'tarefa_alterada', retryable: false } });
    mockTx.updateResult = { acknowledged: false };
    const semConfirmacao = await putStatus('concluido', { key: KEY_2 });
    expect([semConfirmacao.status, semConfirmacao.body]).toEqual([500, ERRO_500]);
    expect(estado()).toEqual(antes);
  });

  test('matchedCount = 0: 409 guardado; a mesma chave repete a recusa; uma chave nova executa depois', async () => {
    ativo(30, { status: 'em_andamento' });
    const antes = estado();
    mockTx.updateResult = { acknowledged: true, matchedCount: 0, modifiedCount: 0 };
    const recusa = await putStatus('concluido', { key: KEY });
    expect([recusa.status, recusa.body]).toEqual([409, { erro: MSG_CONFLITO }]);
    expect(chave()).toMatchObject({ status: 'failed', failure: { statusCode: 409, code: 'tarefa_alterada', retryable: false } });

    // Conflito resolvido, mas a mesma chave so devolve a falha registrada: nenhuma nova transacao ou gravacao.
    mockTx.updateResult = null;
    const sessoes = mockDb.sessions;
    const gravacoes = mockDb.updateCalls.length;
    const repeticao = await putStatus('concluido', { key: KEY });
    expect([repeticao.status, repeticao.body]).toEqual([409, { erro: MSG_CONFLITO }]);
    expect(repeticao.headers['idempotency-replayed']).toBe('true');
    expect(mockDb.sessions).toBe(sessoes);
    expect(mockDb.updateCalls).toHaveLength(gravacoes);
    expect(estado()).toEqual(antes); // nada da tentativa recusada: sem logs, notificacoes nem emissoes

    const nova = await putStatus('concluido', { key: KEY_2 });
    expect(nova.status).toBe(200);
    expect(tarefa).toMatchObject({ status: 'concluido', cronometroAtivo: false, tempoGasto: 40 });
    expect(tiposLog()).toEqual(['cronometro_pausado', 'atualizacao_status']);
    expect(mockDb.notifications).toHaveLength(1);
    expect(mockDb.emits).toHaveLength(1);
  });

  test('21. Socket.IO so depois do commit, fora de qualquer transacao, uma vez', async () => {
    ativo(30, { status: 'em_andamento' });
    expect((await putStatus('concluido', { key: KEY })).status).toBe(200);
    expect(mockDb.emits).toEqual([
      expect.objectContaining({ room: `user_${admin._id}`, event: 'notification_created', commitsAtEmit: 1, openSessions: 0 }),
    ]);
    expect(mockDb.emits[0].payload).toMatchObject({ texto: 'Pessoa Ficticia marcou a tarefa "Relatório" como concluída', tipo: 'task' });
    // Quem muda e o proprio criador: nao notifica nem emite (regra atual).
    tarefa.createdBy = colaborador._id;
    equipe.createdBy = colaborador._id;
    expect((await putStatus('pendente', { key: KEY_2 })).status).toBe(200);
    expect(mockDb.emits).toHaveLength(1);
  });

  test('22. callback repetido pelo withTransaction: efeitos uma vez, com os dados da execucao que entrou', async () => {
    ativo(30, { status: 'em_andamento' });
    mockTx.commitPlan = ['transient'];
    expect((await putStatus('concluido', { key: KEY })).status).toBe(200);
    expect(mockDb.sessions).toBe(2);
    expect(gravacoesNaSessao()).toHaveLength(2);
    expect(tarefa).toMatchObject({ status: 'concluido', tempoGasto: 40, cronometroAtivo: false });
    expect(tiposLog()).toEqual(['cronometro_pausado', 'atualizacao_status']);
    expect(mockDb.notifications).toHaveLength(1);
    expect(mockDb.emits).toHaveLength(1);
  });

  test('23. resultado desconhecido do commit: entrou -> 200 uma vez; nao entrou -> 409 e a chave nao executa sozinha', async () => {
    ativo(30, { status: 'em_andamento' });
    mockTx.commitPlan = ['unknown_applied'];
    const entrou = await putStatus('concluido', { key: KEY });
    expect(entrou.status).toBe(200);
    expect(tarefa.tempoGasto).toBe(40);
    expect(mockDb.emits).toHaveLength(1);
    expect(tiposLog()).toEqual(['cronometro_pausado', 'atualizacao_status']);

    ativo(30, { status: 'em_andamento' });
    const antes = estado();
    mockTx.commitPlan = ['unknown_not_applied'];
    const naoEntrou = await putStatus('concluido', { key: KEY_2 });
    const desconhecido = {
      erro: 'Não foi possível confirmar se o status foi atualizado. Verifique a tarefa antes de tentar de novo.',
      code: 'idempotency_outcome_unknown',
    };
    expect([naoEntrou.status, naoEntrou.body]).toEqual([409, desconhecido]);
    expect(estado()).toEqual(antes);
    const sessoes = mockDb.sessions;
    const repeticao = await putStatus('concluido', { key: KEY_2 });
    expect([repeticao.status, repeticao.body]).toEqual([409, desconhecido]);
    expect(mockDb.sessions).toBe(sessoes);
    expect(estado()).toEqual(antes);
  });

  test('24. sem transacoes ou sem o indice unico: 503 sem gravar; sem a chave segue funcionando', async () => {
    mockTx.supported = false;
    const semTx = await putStatus('concluido', { key: KEY });
    expect([semTx.status, semTx.body]).toEqual([503, { erro: 'Serviço temporariamente indisponível.', code: 'transactions_unavailable' }]);
    expect(semTx.headers['retry-after']).toBe('2');
    mockTx.supported = true;
    for (const indexes of [[{ key: { _id: 1 }, name: '_id_' }], new Error('ns not found')]) {
      mockTx.indexes = indexes;
      app = loadApp(); // servico novo: a verificacao do indice fica em cache por instancia
      const response = await putStatus('concluido', { key: KEY });
      expect(response.status).toBe(503);
      expect(response.body.code).toBe('idempotency_unavailable');
    }
    expect(tarefa.status).toBe('pendente');
    expect(mockDb.keys).toEqual([]);
    expect((await putStatus('concluido')).status).toBe(200);
    mockTx.indexes = null;
    app = loadApp();
  });

  test('25. cronometro inconsistente: 409 sem alterar nada; a recusa fica guardada', async () => {
    Object.assign(tarefa, { cronometroAtivo: true, status: 'em_andamento', ultimaAtualizacaoCronometro: null });
    const antes = estado();
    const response = await putStatus('concluido', { key: KEY });
    expect([response.status, response.body]).toEqual([409, { erro: MSG_INCONSISTENTE }]);
    expect(estado()).toEqual(antes);
    expect(gravacoesNaSessao()).toEqual([]);
    expect(chave()).toMatchObject({ status: 'failed', failure: { statusCode: 409, code: 'cronometro_inconsistente', retryable: false } });
    expect(console.warn).toHaveBeenCalledWith('Cronômetro inconsistente; operação recusada:', 'inicio_ausente', tarefa._id);
    const repeticao = await putStatus('concluido', { key: KEY });
    expect([repeticao.status, repeticao.body]).toEqual([409, { erro: MSG_INCONSISTENTE }]);
    expect(repeticao.headers['idempotency-replayed']).toBe('true');
    // Inicio ate 59.999 ms no futuro e valido (0 minuto); 60.000 ms ou mais e recusado.
    tarefa.ultimaAtualizacaoCronometro = new Date(Date.now() + 30 * 1000);
    expect((await putStatus('concluido', { key: KEY_2 })).status).toBe(200);
    expect(tarefa).toMatchObject({ tempoGasto: 10, cronometroAtivo: false });
    Object.assign(tarefa, { cronometroAtivo: true, status: 'em_andamento', ultimaAtualizacaoCronometro: new Date(Date.now() + 10 * 60 * 1000) });
    expect((await putStatus('concluido', { key: KEY_3 })).status).toBe(409);
  });

  test('26. resposta e URLs assinadas montadas na hora; a chave guarda so o resumo', async () => {
    const primeira = await putStatus('concluido', { key: KEY });
    const repeticao = await putStatus('concluido', { key: KEY });
    const url1 = primeira.body.tarefa.anexos[0].url;
    const url2 = repeticao.body.tarefa.anexos[0].url;
    expect(url1).toMatch(/^https:\/\/storage\.test\/tarefas\/anexo\.pdf\?X-Goog-Signature=sig\d+$/);
    expect(url2).toMatch(/^https:\/\/storage\.test\/tarefas\/anexo\.pdf\?X-Goog-Signature=sig\d+$/);
    expect(url2).not.toBe(url1);
    expect(tarefa.anexos[0].url).toBe('tarefas/anexo.pdf');
    expect(chave().result).toEqual({ statusCode: 200, resourceType: 'tarefa', resourceId: tarefa._id });
    const guardado = JSON.stringify(mockDb.keys);
    expect(guardado).not.toContain('storage.test');
    expect(guardado).not.toContain('marcou a tarefa');
    expect(guardado).not.toContain('Relatório');
  });

  test('27. outra rota muda campos da tarefa no meio do caminho: preservados; o update so toca a transicao', async () => {
    ativo(30, { status: 'em_andamento' });
    let pausou = false;
    let liberar;
    const portao = new Promise((resolve) => { liberar = resolve; });
    mockTx.aposLer = async ({ session }) => {
      if (session && !pausou) {
        pausou = true;
        await portao;
      }
    };
    const pedido = iniciar(putStatus('concluido', { key: KEY }));
    try {
      await waitFor(() => pausou, 'protegida leu');
      escreverFora((t) => {
        Object.assign(t, { descricao: 'Nova descrição', detalhes: 'Novo detalhe', tags: ['nova'], urgencia: 'alta' });
        t.subtarefas.push({ _id: id(), descricao: 'Sub nova', concluida: false });
      });
    } finally {
      liberar();
    }
    const response = await pedido;
    expect(response.status).toBe(200);
    expect(tarefa).toMatchObject({
      descricao: 'Nova descrição', detalhes: 'Novo detalhe', tags: ['nova'], urgencia: 'alta',
      status: 'concluido', cronometroAtivo: false, tempoGasto: 40,
    });
    expect(tarefa.subtarefas.map((sub) => sub.descricao)).toEqual(['Sub nova']);
    expect(response.body.tarefa.descricao).toBe('Nova descrição'); // resposta relida apos o commit
    gravacoesNaSessao().forEach(({ update }) => {
      Object.keys(update.$set).forEach((campo) => expect(CAMPOS_DA_TRANSICAO).toContain(campo));
      Object.keys(update.$unset || {}).forEach((campo) => expect(campo).toBe('ultimaAtualizacaoCronometro'));
    });
    expect(mockDb.notifications[0].texto).toBe('Pessoa Ficticia marcou a tarefa "Nova descrição" como concluída');
  });

  test('28b. leitura demorada que atravessa a virada do minuto: o instante e tomado depois da leitura (40, nunca 39)', async () => {
    const T0 = Date.parse('2026-11-20T10:00:00.000Z');
    jest.useFakeTimers({ doNotFake: NAO_FALSIFICAR_ALEM_DE_DATE, now: T0 + (29 * 60 + 59.5) * 1000 });
    token = issueAuthToken(colaborador);
    Object.assign(tarefa, {
      status: 'em_andamento', cronometroAtivo: true, ultimaAtualizacaoCronometro: new Date(T0), tempoGasto: 10, tempoEstimado: 100,
    });
    // A consulta da tarefa dentro da transacao "demora" 1 s: o relogio passa de 29:59,5 para 30:00,5 durante ela.
    // So o Date e falsificado; setTimeout e performance continuam reais (os prazos de seguranca seguem valendo).
    let leituras = 0;
    mockTx.aposLer = async ({ session }) => {
      if (session) {
        leituras += 1;
        jest.setSystemTime(T0 + (30 * 60 + 0.5) * 1000);
      }
    };
    const response = await putStatus('concluido', { key: KEY });
    expect(response.status).toBe(200);
    expect(leituras).toBe(1);
    expect(tarefa).toMatchObject({ tempoGasto: 40, cronometroAtivo: false, status: 'concluido' });
    expect(gravacoesNaSessao().map((item) => item.update.$set.tempoGasto)).toEqual([40]);
    expect(detalhesLog()).toEqual([
      'Cronômetro pausado automaticamente pela alteração de status para concluido. +30 mins',
      'Status alterado para concluido',
    ]);
    expect(mockDb.notifications).toHaveLength(1);
    expect(mockDb.emits).toHaveLength(1);
  });

  test('28. conflito que atravessa a virada do minuto: grava e loga os minutos da execucao confirmada', async () => {
    const T0 = Date.parse('2026-11-20T10:00:00.000Z');
    jest.useFakeTimers({ doNotFake: NAO_FALSIFICAR_ALEM_DE_DATE, now: T0 + (29 * 60 + 59.5) * 1000 });
    token = issueAuthToken(colaborador);
    Object.assign(tarefa, {
      status: 'em_andamento', cronometroAtivo: true, ultimaAtualizacaoCronometro: new Date(T0), tempoGasto: 10, tempoEstimado: 100,
    });
    let primeira = true;
    mockTx.antesDeGravar = async (chamada) => {
      if (chamada.withSession && primeira) {
        primeira = false;
        jest.setSystemTime(T0 + (30 * 60 + 0.5) * 1000); // 29:59 -> 30:00
        escreverFora((t) => { t.tempoEstimado = 39; }); // escrita concorrente: WriteConflict nesta execucao
      }
    };
    const response = await putStatus('concluido', { key: KEY });
    expect(response.status).toBe(200);
    expect(gravacoesNaSessao().map((item) => item.update.$set.tempoGasto)).toEqual([39, 40]);
    expect(tarefa).toMatchObject({ tempoGasto: 40, tempoExcedido: true, cronometroAtivo: false, status: 'concluido' });
    expect(tarefa.updatedAt.getTime()).toBe(T0 + (30 * 60 + 0.5) * 1000);
    expect(detalhesLog()).toEqual([
      'Cronômetro pausado automaticamente pela alteração de status para concluido. +30 mins',
      'Status alterado para concluido',
    ]);
    expect(mockDb.notifications).toHaveLength(1);
    expect(mockDb.emits).toHaveLength(1);
  });
});
