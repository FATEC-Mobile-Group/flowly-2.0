// PUT /api/tarefas/:id/cronometro com Idempotency-Key (opt-in): rotas reais, auth e sessionGuard reais; banco,
// transacao e Socket.IO simulados. Mesmo falso transacional da suite de status (taskStatus.idempotency):
// - leitura: documento Mongoose REAL (hydrate: padroes do schema, conversao de tipos);
// - updateOne: filtro e update passam pela conversao real do Mongoose; o filtro e avaliado com a semantica do
//   MongoDB (null/ausente, $in, $ne, $not/$type);
// - transacao: escrita trava a tarefa ate o commit/abort; outra transacao recebe WriteConflict
//   (TransientTransactionError) e o withTransaction repete o callback depois que a trava sai; escrita fora de
//   transacao ESPERA a trava e so entao avalia o filtro. Isolamento por snapshot: se a tarefa recebeu uma escrita
//   confirmada depois do inicio da transacao, a escrita da transacao recebe WriteConflict (como no MongoDB);
// - logs, notificacoes, chave e tarefa ficam na sessao ate o commit; rollback descarta tudo;
// - Socket.IO registra cada emissao (o cronometro nao deve emitir nada).
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
const SEM_ACESSO_403 = { erro: 'Acesso negado à tarefa' };
const ERRO_500 = { erro: 'Erro ao controlar cronômetro' };
const JA_ATIVO_400 = { erro: 'Cronômetro já está ativo' };
const JA_PAUSADO_400 = { erro: 'Cronômetro já está pausado' };
const KEY_4 = '4b3a2c1d-0e9f-4a8b-9c7d-6e5f4a3b2c1d';
const KEY_5 = '5c4b3a2d-1e0f-4b9a-8d7c-6f5e4d3c2b1a';
const CAMPOS_DO_CRONOMETRO = ['tempoGasto', 'tempoGastoSegundos', 'cronometroAtivo', 'tempoExcedido', 'ultimaAtualizacaoCronometro', 'updatedAt'];
const MSG_INCONSISTENTE = 'O cronômetro desta tarefa está inconsistente: o horário de início está ausente, '
  + 'inválido ou no futuro. Nenhum tempo foi contabilizado e a tarefa não foi alterada.';
const MSG_CONFLITO = 'A tarefa foi alterada por outra operação ao mesmo tempo. Tente novamente.';
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

describe('PUT /api/tarefas/:id/cronometro com Idempotency-Key', () => {
  let app;
  let admin;
  let colaborador;
  let outro;
  let equipe;
  let tarefa;
  let token;

  const putCrono = (acao, { key, tokenUsado = token, tarefaId = tarefa._id, extra = {} } = {}) => {
    const req = request(app).put(`/api/tarefas/${tarefaId}/cronometro`).set('Authorization', `Bearer ${tokenUsado}`);
    if (key !== undefined) req.set('Idempotency-Key', key);
    return req.send({ acao, ...extra });
  };
  const putStatus = (status, { key } = {}) => {
    const req = request(app).put(`/api/tarefas/${tarefa._id}/status`).set('Authorization', `Bearer ${token}`);
    if (key !== undefined) req.set('Idempotency-Key', key);
    return req.send({ status });
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
  // Pausa a primeira leitura feita DENTRO de uma transacao; liberacao sempre no finally de quem chama.
  const pausarPrimeiraLeituraNaSessao = () => {
    const estadoPausa = { pausou: false, liberar: null };
    const portao = new Promise((resolve) => { estadoPausa.liberar = resolve; });
    mockTx.aposLer = async ({ session }) => {
      if (session && !estadoPausa.pausou) {
        estadoPausa.pausou = true;
        await portao;
      }
    };
    return estadoPausa;
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
      status: 'em_andamento',
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
    // Em nenhum teste uma transacao fica aberta, uma trava fica presa, um numero nao finito e gravado, nem o
    // cronometro gera notificacao ou Socket.IO.
    expect(mockDb.openSessions).toBe(0);
    expect(mockDb.locks.size).toBe(0);
    mockDb.updateCalls.forEach(({ update }) => {
      Object.values(update.$set || {}).forEach((valor) => {
        if (typeof valor === 'number') expect(Number.isFinite(valor)).toBe(true);
        if (valor instanceof Date) expect(Number.isFinite(valor.getTime())).toBe(true);
      });
    });
  });

  test('1. iniciar sem a chave: fluxo legado da 5B.1, sem transacao, log imediato', async () => {
    const antes = Date.now();
    const response = await putCrono('iniciar');
    expect(response.status).toBe(200);
    expect(keysOf(response.body)).toEqual(['msg', 'tarefa', 'tempoExcedido']);
    expect(response.body).toMatchObject({ msg: 'Cronômetro iniciardo com sucesso', tempoExcedido: false });
    expect(response.headers['idempotency-replayed']).toBeUndefined();
    expect(tarefa.cronometroAtivo).toBe(true);
    expect(tarefa.ultimaAtualizacaoCronometro.getTime()).toBeGreaterThanOrEqual(antes);
    expect(mockDb.sessions).toBe(0);
    expect(mockDb.keys).toEqual([]);
    expect(mockDb.updateCalls.map((item) => item.withSession)).toEqual([false]);
    expect(mockDb.logSaves).toEqual([{ withSession: false, tipoAcao: 'cronometro_iniciado' }]);
    expect(detalhesLog()).toEqual(['Cronômetro iniciado']);
  });

  test('2. pausar sem a chave: minutos inteiros, inicio mantido, log imediato', async () => {
    ativo(30);
    const inicio = tarefa.ultimaAtualizacaoCronometro.getTime();
    const response = await putCrono('pausar');
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ msg: 'Cronômetro pausardo com sucesso', tempoExcedido: false });
    expect(tarefa).toMatchObject({ cronometroAtivo: false, tempoGasto: 40 });
    expect(tarefa.ultimaAtualizacaoCronometro.getTime()).toBe(inicio);
    expect(mockDb.sessions).toBe(0);
    expect(mockDb.logSaves).toEqual([{ withSession: false, tipoAcao: 'cronometro_pausado' }]);
    expect(detalhesLog()).toEqual(['Cronômetro pausado. +30 mins']);
  });

  test('3. iniciar com a chave: gravacao, log e chave na mesma transacao; instante depois da leitura', async () => {
    const antes = Date.now();
    const response = await putCrono('iniciar', { key: KEY });
    expect(response.status).toBe(200);
    expect(keysOf(response.body)).toEqual(['msg', 'tarefa', 'tempoExcedido']);
    expect(response.body).toMatchObject({ msg: 'Cronômetro iniciardo com sucesso', tempoExcedido: false, tarefa: { cronometroAtivo: true } });
    expect(tarefa.cronometroAtivo).toBe(true);
    expect(tarefa.ultimaAtualizacaoCronometro.getTime()).toBeGreaterThanOrEqual(antes);
    expect(tarefa.ultimaAtualizacaoCronometro.getTime()).toBe(tarefa.updatedAt.getTime());
    expect(mockDb.commits).toBe(1);
    expect(gravacoesNaSessao()).toHaveLength(1);
    expect(gravacoesNaSessao()[0]).toMatchObject({ timestamps: false, runValidators: true });
    expect(gravacoesNaSessao()[0].filtro).toMatchObject({ cronometroAtivo: { $ne: true }, status: 'em_andamento' });
    expect(String(gravacoesNaSessao()[0].filtro.user)).toBe(colaborador._id);
    expect(mockDb.logSaves).toEqual([{ withSession: true, tipoAcao: 'cronometro_iniciado' }]);
    expect(chave()).toMatchObject({
      userId: colaborador._id, method: 'PUT', route: '/api/tarefas/:id/cronometro', status: 'completed',
      result: { statusCode: 200, resourceType: 'tarefa', resourceId: tarefa._id },
    });
  });

  test('4. pausar com a chave: minutos, tempoExcedido e inicio mantido, tudo na transacao', async () => {
    ativo(30, { tempoEstimado: 20 });
    const inicio = tarefa.ultimaAtualizacaoCronometro.getTime();
    const response = await putCrono('pausar', { key: KEY });
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ msg: 'Cronômetro pausardo com sucesso', tempoExcedido: true, tarefa: { tempoGasto: 40 } });
    expect(tarefa).toMatchObject({ cronometroAtivo: false, tempoGasto: 40, tempoExcedido: true });
    expect(tarefa.ultimaAtualizacaoCronometro.getTime()).toBe(inicio); // pausa manual mantem o inicio
    const [gravacao] = gravacoesNaSessao();
    expect(gravacao.update.$unset).toBeUndefined();
    expect(gravacao.filtro).toMatchObject({ cronometroAtivo: true, tempoGasto: 10, tempoEstimado: 20, tempoExcedido: { $ne: true } });
    expect(gravacao.filtro.ultimaAtualizacaoCronometro.getTime()).toBe(inicio);
    expect(mockDb.logSaves).toEqual([{ withSession: true, tipoAcao: 'cronometro_pausado' }]);
    expect(detalhesLog()).toEqual(['Cronômetro pausado. +30 mins']);
  });

  test('5. repeticao do inicio: mesma resposta, sem novo inicio nem log', async () => {
    expect((await putCrono('iniciar', { key: KEY })).status).toBe(200);
    const depois = estado();
    const gravacoes = mockDb.updateCalls.length;
    const repeticao = await putCrono('iniciar', { key: KEY, extra: { ignorado: true } });
    expect(repeticao.status).toBe(200);
    expect(repeticao.headers['idempotency-replayed']).toBe('true');
    expect(repeticao.body).toMatchObject({ msg: 'Cronômetro iniciardo com sucesso', tarefa: { cronometroAtivo: true } });
    expect(mockDb.updateCalls).toHaveLength(gravacoes);
    expect(mockDb.sessions).toBe(1);
    expect(estado()).toEqual(depois); // inicio (ultimaAtualizacaoCronometro) intacto
  });

  test('6. repeticao da pausa: nao soma os minutos de novo', async () => {
    ativo(30);
    expect((await putCrono('pausar', { key: KEY })).status).toBe(200);
    const depois = estado();
    const repeticao = await putCrono('pausar', { key: KEY });
    expect(repeticao.status).toBe(200);
    expect(repeticao.headers['idempotency-replayed']).toBe('true');
    expect(repeticao.body).toMatchObject({ msg: 'Cronômetro pausardo com sucesso', tarefa: { tempoGasto: 40 }, tempoExcedido: false });
    expect(estado()).toEqual(depois); // tempoGasto, tempoExcedido, inicio e logs intactos
    expect(mockDb.sessions).toBe(1);
  });

  test('7 e 8. mesma chave com outra acao ou outra tarefa: 422, nada executado', async () => {
    expect((await putCrono('iniciar', { key: KEY })).status).toBe(200);
    const depois = estado();
    const outraAcao = await putCrono('pausar', { key: KEY });
    expect(outraAcao.status).toBe(422);
    expect(outraAcao.body).toEqual({ erro: 'Esta chave de idempotência já foi usada com outro pedido.', code: 'idempotency_key_reused' });
    const outraTarefa = { ...mockClone(tarefa), _id: id(), cronometroAtivo: false };
    mockDb.tarefas.push(outraTarefa);
    expect((await putCrono('iniciar', { key: KEY, tarefaId: outraTarefa._id })).status).toBe(422);
    expect(outraTarefa.cronometroAtivo).toBe(false);
    expect(mockDb.sessions).toBe(1);
    expect(estado()).toEqual(depois);
  });

  test('9. acao invalida antes da chave; chave invalida ou vazia: 400 sem reivindicar nada', async () => {
    for (const acao of [undefined, '', 'parar', ['iniciar'], { $ne: null }, 1]) {
      const response = await putCrono(acao, { key: KEY });
      expect([response.status, response.body]).toEqual([400, { erro: 'Ação inválida.' }]);
    }
    for (const key of ['nao-e-uuid', '']) {
      const response = await putCrono('iniciar', { key });
      expect([response.status, response.body]).toEqual([400, { erro: 'Chave de idempotência inválida.', code: 'idempotency_key_invalid' }]);
    }
    expect(mockDb.keys).toEqual([]);
    expect(mockDb.sessions).toBe(0);
    expect(tarefa.cronometroAtivo).toBe(false);
  });

  test('10 e 11. ja ativo / ja pausado: 400 com as mensagens de sempre, nada gravado, recusa guardada', async () => {
    const pausado = await putCrono('pausar', { key: KEY });
    expect([pausado.status, pausado.body]).toEqual([400, JA_PAUSADO_400]);
    expect(chave(KEY)).toMatchObject({ status: 'failed', failure: { statusCode: 400, code: 'cronometro_ja_pausado', retryable: false } });
    ativo(5);
    const antes = estado();
    const jaAtivo = await putCrono('iniciar', { key: KEY_2 });
    expect([jaAtivo.status, jaAtivo.body]).toEqual([400, JA_ATIVO_400]);
    expect(chave(KEY_2)).toMatchObject({ status: 'failed', failure: { statusCode: 400, code: 'cronometro_ja_ativo', retryable: false } });
    expect(gravacoesNaSessao()).toEqual([]);
    expect(estado()).toEqual(antes);
  });

  test('12. repeticao de uma recusa definitiva: devolve a recusa sem executar; chave nova segue a regra atual', async () => {
    ativo(5);
    expect((await putCrono('iniciar', { key: KEY })).status).toBe(400);
    escreverFora((t) => Object.assign(t, { cronometroAtivo: false })); // o cronometro e pausado por outra via
    const sessoes = mockDb.sessions;
    const repeticao = await putCrono('iniciar', { key: KEY });
    expect([repeticao.status, repeticao.body]).toEqual([400, JA_ATIVO_400]);
    expect(repeticao.headers['idempotency-replayed']).toBe('true');
    expect(mockDb.sessions).toBe(sessoes);
    expect(tarefa.cronometroAtivo).toBe(false);
    const nova = await putCrono('iniciar', { key: KEY_2 });
    expect(nova.status).toBe(200);
    expect(tarefa.cronometroAtivo).toBe(true);
    expect(tiposLog()).toEqual(['cronometro_iniciado']);
  });

  test('13. token invalido ou revogado: 401 antes da chave; admin barrado pelo isUser', async () => {
    expect((await putCrono('iniciar', { key: KEY, tokenUsado: 'nao-e-um-jwt' })).status).toBe(401);
    colaborador.authVersion = 1;
    expect((await putCrono('iniciar', { key: KEY })).status).toBe(401);
    expect((await putCrono('iniciar', { key: KEY, tokenUsado: issueAuthToken(admin) })).status).toBe(403);
    expect(mockDb.keys).toEqual([]);
    expect(tarefa.cronometroAtivo).toBe(false);
  });

  test('14. quem nao e responsavel: 403 guardado; ID invalido: 403 antes da chave', async () => {
    tarefa.user = outro._id;
    const response = await putCrono('iniciar', { key: KEY });
    expect([response.status, response.body]).toEqual([403, SEM_ACESSO_403]);
    expect(chave()).toMatchObject({ status: 'failed', failure: { statusCode: 403, code: 'tarefa_inacessivel', retryable: false } });
    const invalido = await putCrono('iniciar', { key: KEY_2, tarefaId: 'nao-e-id' });
    expect([invalido.status, invalido.body]).toEqual([403, SEM_ACESSO_403]);
    expect(chave(KEY_2)).toBeUndefined();
    expect(tarefa.cronometroAtivo).toBe(false);
    expect(mockDb.logs).toEqual([]);
  });

  test('15. reatribuida antes da repeticao: 403 sem dados da tarefa e sem efeitos', async () => {
    expect((await putCrono('iniciar', { key: KEY })).status).toBe(200);
    tarefa.user = outro._id;
    const depois = estado();
    const repeticao = await putCrono('iniciar', { key: KEY });
    expect([repeticao.status, repeticao.body]).toEqual([403, SEM_ACESSO_403]);
    expect(estado()).toEqual(depois);
    tarefa.user = colaborador._id;
    colaborador.authVersion = 1;
    expect((await putCrono('iniciar', { key: KEY })).status).toBe(401);
  });

  test('15b. reatribuida durante a operacao: o anterior nao grava (403), sem log', async () => {
    ativo(30);
    const pausa = pausarPrimeiraLeituraNaSessao();
    const pedido = iniciar(putCrono('pausar', { key: KEY }));
    try {
      await waitFor(() => pausa.pausou, 'leitura na transacao');
      escreverFora((t) => { t.user = outro._id; });
    } finally {
      pausa.liberar();
    }
    const response = await pedido;
    expect([response.status, response.body]).toEqual([403, SEM_ACESSO_403]);
    expect(tarefa).toMatchObject({ cronometroAtivo: true, tempoGasto: 10, user: outro._id });
    expect(mockDb.logs).toEqual([]);
  });

  test('16. operacoes protegidas simultaneas: dois inicios e duas pausas valem uma vez', async () => {
    // Dois inicios com chaves diferentes: o segundo espera a trava, rele e recebe "ja esta ativo".
    let inicioA;
    await withGate('pauseAfterLock', async ({ pending, release }) => {
      const a = iniciar(putCrono('iniciar', { key: KEY }));
      pending.push(a);
      await waitFor(() => mockDb.locks.size === 1, 'A com a trava');
      mockTx.pauseAfterLock = null;
      const b = iniciar(putCrono('iniciar', { key: KEY_2 }));
      pending.push(b);
      await waitFor(() => mockDb.conflicts >= 1, 'B em WriteConflict');
      release();
      const [ra, rb] = await Promise.all([a, b]);
      expect([ra.status, rb.status]).toEqual([200, 400]);
      expect(rb.body).toEqual(JA_ATIVO_400);
      inicioA = tarefa.ultimaAtualizacaoCronometro.getTime();
    });
    expect(tiposLog()).toEqual(['cronometro_iniciado']);
    expect(tarefa.ultimaAtualizacaoCronometro.getTime()).toBe(inicioA);

    // Duas pausas: o tempo entra uma vez.
    mockDb.logs.splice(0, mockDb.logs.length);
    ativo(30, { tempoGasto: 10, tempoGastoSegundos: undefined }); // tarefa "antiga" de novo: so o acumulado legado (o preciso da parte anterior sai)
    await withGate('pauseAfterLock', async ({ pending, release }) => {
      const a = iniciar(putCrono('pausar', { key: KEY_3 }));
      pending.push(a);
      await waitFor(() => mockDb.locks.size === 1, 'A com a trava');
      mockTx.pauseAfterLock = null;
      const b = iniciar(putCrono('pausar', { key: KEY_4 }));
      pending.push(b);
      await waitFor(() => mockDb.conflicts >= 2, 'B em WriteConflict');
      release();
      const [ra, rb] = await Promise.all([a, b]);
      expect([ra.status, rb.status]).toEqual([200, 400]);
      expect(rb.body).toEqual(JA_PAUSADO_400);
    });
    expect(tarefa).toMatchObject({ cronometroAtivo: false, tempoGasto: 40 });
    expect(detalhesLog()).toEqual(['Cronômetro pausado. +30 mins']);
  });

  test('17. protegido x legado, nas duas ordens: o tempo entra uma vez', async () => {
    // a) A pausa protegida segura a trava; a pausa legada espera, nao casa, rele e recebe "ja esta pausado".
    ativo(30);
    await withGate('pauseAfterLock', async ({ pending, release }) => {
      const protegida = iniciar(putCrono('pausar', { key: KEY }));
      pending.push(protegida);
      await waitFor(() => mockDb.locks.size === 1, 'protegida com a trava');
      mockTx.pauseAfterLock = null;
      const legado = iniciar(putCrono('pausar'));
      pending.push(legado);
      await waitFor(() => mockDb.updateCalls.some((item) => !item.withSession), 'legado esperando a trava');
      release();
      const [rp, rl] = await Promise.all([protegida, legado]);
      expect([rp.status, rl.status]).toEqual([200, 400]);
      expect(rl.body).toEqual(JA_PAUSADO_400);
    });
    expect(tarefa).toMatchObject({ cronometroAtivo: false, tempoGasto: 40 });
    expect(detalhesLog()).toEqual(['Cronômetro pausado. +30 mins']);

    // b) A pausa legada grava entre a leitura e a gravacao da protegida: WriteConflict, o callback rele e recusa.
    mockDb.logs.splice(0, mockDb.logs.length);
    ativo(30, { tempoGasto: 10, tempoGastoSegundos: undefined }); // tarefa "antiga" de novo: so o acumulado legado (o preciso da parte anterior sai)
    const pausa = pausarPrimeiraLeituraNaSessao();
    const sessoes = mockDb.sessions;
    const protegida = iniciar(putCrono('pausar', { key: KEY_2 }));
    try {
      await waitFor(() => pausa.pausou, 'protegida leu');
      expect((await putCrono('pausar')).status).toBe(200);
    } finally {
      pausa.liberar();
    }
    const resposta = await protegida;
    expect([resposta.status, resposta.body]).toEqual([400, JA_PAUSADO_400]);
    expect(mockDb.sessions - sessoes).toBe(2); // callback repetido
    expect(tarefa).toMatchObject({ cronometroAtivo: false, tempoGasto: 40 });
    expect(detalhesLog()).toEqual(['Cronômetro pausado. +30 mins']);
  });

  test('18. cronometro x status (legado e idempotente): a pausa conta uma vez', async () => {
    // a) Pausa protegida com a trava x mudanca de status legada (que pausaria): o status rele e so muda o status.
    ativo(30);
    await withGate('pauseAfterLock', async ({ pending, release }) => {
      const pausa = iniciar(putCrono('pausar', { key: KEY }));
      pending.push(pausa);
      await waitFor(() => mockDb.locks.size === 1, 'pausa com a trava');
      mockTx.pauseAfterLock = null;
      const status = iniciar(putStatus('concluido'));
      pending.push(status);
      await waitFor(() => mockDb.updateCalls.some((item) => !item.withSession), 'status esperando');
      release();
      const [rp, rs] = await Promise.all([pausa, status]);
      expect([rp.status, rs.status]).toEqual([200, 200]);
    });
    expect(tarefa).toMatchObject({ status: 'concluido', cronometroAtivo: false, tempoGasto: 40 });
    expect(detalhesLog()).toEqual(['Cronômetro pausado. +30 mins', 'Status alterado para concluido']);

    // b) Pausa protegida com a trava x mudanca de status idempotente: WriteConflict, o status rele e nao pausa.
    mockDb.logs.splice(0, mockDb.logs.length);
    ativo(30, { tempoGasto: 10, tempoGastoSegundos: undefined, status: 'em_andamento' }); // tarefa "antiga" de novo: so o acumulado legado (o preciso da parte anterior sai)
    await withGate('pauseAfterLock', async ({ pending, release }) => {
      const pausa = iniciar(putCrono('pausar', { key: KEY_2 }));
      pending.push(pausa);
      await waitFor(() => mockDb.locks.size === 1, 'pausa com a trava');
      mockTx.pauseAfterLock = null;
      const conflitos = mockDb.conflicts;
      const status = iniciar(putStatus('pendente', { key: KEY_3 }));
      pending.push(status);
      await waitFor(() => mockDb.conflicts > conflitos, 'status em WriteConflict');
      release();
      const [rp, rs] = await Promise.all([pausa, status]);
      expect([rp.status, rs.status]).toEqual([200, 200]);
    });
    expect(tarefa).toMatchObject({ status: 'pendente', cronometroAtivo: false, tempoGasto: 40 });
    expect(detalhesLog()).toEqual(['Cronômetro pausado. +30 mins', 'Status alterado para pendente']);

    // c) Status idempotente pausa primeiro (com a trava); a pausa protegida rele e recebe "ja esta pausado".
    mockDb.logs.splice(0, mockDb.logs.length);
    ativo(30, { tempoGasto: 10, tempoGastoSegundos: undefined, status: 'em_andamento' }); // tarefa "antiga" de novo: so o acumulado legado (o preciso da parte anterior sai)
    await withGate('pauseAfterLock', async ({ pending, release }) => {
      const status = iniciar(putStatus('concluido', { key: KEY_4 }));
      pending.push(status);
      await waitFor(() => mockDb.locks.size === 1, 'status com a trava');
      mockTx.pauseAfterLock = null;
      const conflitos = mockDb.conflicts;
      const pausa = iniciar(putCrono('pausar', { key: KEY_5 }));
      pending.push(pausa);
      await waitFor(() => mockDb.conflicts > conflitos, 'pausa em WriteConflict');
      release();
      const [rs, rp] = await Promise.all([status, pausa]);
      expect([rs.status, rp.status]).toEqual([200, 400]);
      expect(rp.body).toEqual(JA_PAUSADO_400);
    });
    expect(tarefa).toMatchObject({ status: 'concluido', cronometroAtivo: false, tempoGasto: 40 });
    expect(detalhesLog()).toEqual([
      'Cronômetro pausado automaticamente pela alteração de status para concluido. +30 mins',
      'Status alterado para concluido',
    ]);
  });

  describe('19 a 21. falhas dentro da transacao: rollback completo e a mesma chave executa uma vez depois', () => {
    const FALHAS = [
      ['19. atualizacao da tarefa (pausa)', 'pausar', () => { mockTx.failUpdate = Object.assign(new Error('conexao interrompida'), { name: 'MongoNetworkError' }); }],
      ['19. atualizacao da tarefa (inicio)', 'iniciar', () => { mockTx.failUpdate = Object.assign(new Error('conexao interrompida'), { name: 'MongoNetworkError' }); }],
      ['20. ActivityLog da pausa', 'pausar', () => { mockTx.failLogTipo = 'cronometro_pausado'; }],
      ['20. ActivityLog do inicio', 'iniciar', () => { mockTx.failLogTipo = 'cronometro_iniciado'; }],
    ];

    test.each(FALHAS)('%s: 500, nada confirmado (21)', async (_rotulo, acao, falhar) => {
      if (acao === 'pausar') ativo(30);
      const antes = estado();
      falhar();
      const response = await putCrono(acao, { key: KEY });
      expect([response.status, response.body]).toEqual([500, ERRO_500]);
      expect(estado()).toEqual(antes); // tarefa e logs intactos
      expect(mockDb.commits).toBe(0);
      expect(chave()).toMatchObject({ status: 'failed', failure: { statusCode: 500, code: 'execution_failed', retryable: true } });

      Object.assign(mockTx, mockTxDefaults());
      const novaTentativa = await putCrono(acao, { key: KEY });
      expect(novaTentativa.status).toBe(200);
      expect(tarefa.cronometroAtivo).toBe(acao === 'iniciar');
      if (acao === 'pausar') expect(tarefa.tempoGasto).toBe(40);
      expect(tiposLog()).toEqual([acao === 'iniciar' ? 'cronometro_iniciado' : 'cronometro_pausado']);
      expect(chave()).toMatchObject({ status: 'completed', attempts: 2 });
    });
  });

  test('matchedCount != 1 na transacao: 409 guardado; a mesma chave repete a recusa; chave nova executa', async () => {
    ativo(30);
    const antes = estado();
    mockTx.updateResult = { acknowledged: true, matchedCount: 0, modifiedCount: 0 };
    const recusa = await putCrono('pausar', { key: KEY });
    expect([recusa.status, recusa.body]).toEqual([409, { erro: MSG_CONFLITO }]);
    expect(chave()).toMatchObject({ status: 'failed', failure: { statusCode: 409, code: 'tarefa_alterada', retryable: false } });
    mockTx.updateResult = null;
    const repeticao = await putCrono('pausar', { key: KEY });
    expect([repeticao.status, repeticao.body]).toEqual([409, { erro: MSG_CONFLITO }]);
    expect(repeticao.headers['idempotency-replayed']).toBe('true');
    expect(estado()).toEqual(antes);
    mockTx.updateResult = { acknowledged: false };
    expect((await putCrono('pausar', { key: KEY_2 })).status).toBe(500); // sem confirmacao: erro real
    mockTx.updateResult = null;
    expect((await putCrono('pausar', { key: KEY_3 })).status).toBe(200);
    expect(tarefa.tempoGasto).toBe(40);
    expect(detalhesLog()).toEqual(['Cronômetro pausado. +30 mins']);
  });

  test('22. callback repetido (WriteConflict e commit transitorio): efeitos uma vez, minutos da execucao que entrou', async () => {
    ativo(30, { tempoEstimado: 120 });
    let primeira = true;
    mockTx.antesDeGravar = async (chamada) => {
      if (chamada.withSession && primeira) {
        primeira = false;
        escreverFora((t) => { t.tempoEstimado = 35; }); // escrita concorrente: WriteConflict nesta execucao
      }
    };
    expect((await putCrono('pausar', { key: KEY })).status).toBe(200);
    expect(mockDb.sessions).toBe(2);
    expect(tarefa).toMatchObject({ tempoGasto: 40, tempoExcedido: true, cronometroAtivo: false }); // estimado novo
    expect(tiposLog()).toEqual(['cronometro_pausado']);

    mockTx.antesDeGravar = null;
    mockTx.commitPlan = ['transient'];
    expect((await putCrono('iniciar', { key: KEY_2 })).status).toBe(200);
    expect(mockDb.sessions).toBe(4);
    expect(tiposLog()).toEqual(['cronometro_pausado', 'cronometro_iniciado']);
  });

  test('23. resultado desconhecido do commit: entrou -> 200 uma vez; nao entrou -> 409 e nao executa sozinho', async () => {
    ativo(30);
    mockTx.commitPlan = ['unknown_applied'];
    expect((await putCrono('pausar', { key: KEY })).status).toBe(200);
    expect(tarefa.tempoGasto).toBe(40);
    expect(tiposLog()).toEqual(['cronometro_pausado']);

    const antes = estado();
    mockTx.commitPlan = ['unknown_not_applied'];
    const naoEntrou = await putCrono('iniciar', { key: KEY_2 });
    const desconhecido = {
      erro: 'Não foi possível confirmar se o cronômetro foi atualizado. Verifique a tarefa antes de tentar de novo.',
      code: 'idempotency_outcome_unknown',
    };
    expect([naoEntrou.status, naoEntrou.body]).toEqual([409, desconhecido]);
    expect(estado()).toEqual(antes);
    const sessoes = mockDb.sessions;
    const repeticao = await putCrono('iniciar', { key: KEY_2 });
    expect([repeticao.status, repeticao.body]).toEqual([409, desconhecido]);
    expect(mockDb.sessions).toBe(sessoes);
    expect(estado()).toEqual(antes);
  });

  test('24. sem transacoes ou sem o indice unico: 503 sem gravar; sem a chave segue funcionando', async () => {
    mockTx.supported = false;
    const semTx = await putCrono('iniciar', { key: KEY });
    expect([semTx.status, semTx.body]).toEqual([503, { erro: 'Serviço temporariamente indisponível.', code: 'transactions_unavailable' }]);
    expect(semTx.headers['retry-after']).toBe('2');
    mockTx.supported = true;
    for (const indexes of [[{ key: { _id: 1 }, name: '_id_' }], new Error('ns not found')]) {
      mockTx.indexes = indexes;
      app = loadApp(); // servico novo: a verificacao do indice fica em cache por instancia
      const response = await putCrono('iniciar', { key: KEY });
      expect(response.status).toBe(503);
      expect(response.body.code).toBe('idempotency_unavailable');
    }
    expect(tarefa.cronometroAtivo).toBe(false);
    expect(mockDb.keys).toEqual([]);
    expect((await putCrono('iniciar')).status).toBe(200);
    mockTx.indexes = null;
    app = loadApp();
  });

  test.each([
    ['ausente', 'inicio_ausente', () => { delete tarefa.ultimaAtualizacaoCronometro; }],
    ['nulo', 'inicio_ausente', () => { tarefa.ultimaAtualizacaoCronometro = null; }],
    ['texto gravado que nao converte', 'inicio_ausente', () => { tarefa.ultimaAtualizacaoCronometro = 'nao-e-data'; }],
    ['10 min no futuro', 'inicio_no_futuro', () => { tarefa.ultimaAtualizacaoCronometro = new Date(Date.now() + 10 * 60 * 1000); }],
  ])('25. pausa com inicio %s: 409 sem alterar nada; a recusa fica guardada', async (_rotulo, motivo, aplicar) => {
    tarefa.cronometroAtivo = true;
    aplicar();
    const antes = estado();
    const response = await putCrono('pausar', { key: KEY });
    expect([response.status, response.body]).toEqual([409, { erro: MSG_INCONSISTENTE }]);
    expect(estado()).toEqual(antes);
    expect(gravacoesNaSessao()).toEqual([]);
    expect(chave()).toMatchObject({ status: 'failed', failure: { statusCode: 409, code: 'cronometro_inconsistente', retryable: false } });
    expect(console.warn).toHaveBeenCalledWith('Cronômetro inconsistente; operação recusada:', motivo, tarefa._id);
    const repeticao = await putCrono('pausar', { key: KEY });
    expect([repeticao.status, repeticao.headers['idempotency-replayed']]).toEqual([409, 'true']);
  });

  test('26. tolerancia de inicio no futuro: ate 59.999 ms pausa com 0 minuto; 60.000 ms e recusado', async () => {
    const agora = Date.parse('2026-11-20T10:00:00.000Z');
    jest.useFakeTimers({ doNotFake: NAO_FALSIFICAR_ALEM_DE_DATE, now: agora });
    token = issueAuthToken(colaborador);
    Object.assign(tarefa, { cronometroAtivo: true, ultimaAtualizacaoCronometro: new Date(agora + 59999) });
    const tolerado = await putCrono('pausar', { key: KEY });
    expect(tolerado.status).toBe(200);
    expect(tarefa).toMatchObject({ cronometroAtivo: false, tempoGasto: 10 });
    expect(detalhesLog()).toEqual(['Cronômetro pausado. +0 mins']);
    Object.assign(tarefa, { cronometroAtivo: true, ultimaAtualizacaoCronometro: new Date(agora + 60000) });
    const recusado = await putCrono('pausar', { key: KEY_2 });
    expect([recusado.status, recusado.body]).toEqual([409, { erro: MSG_INCONSISTENTE }]);
    expect(tarefa.cronometroAtivo).toBe(true);
  });

  test.each([
    ['texto que nao converte', 'abc'],
    ['Infinity', Infinity],
  ])('27. tempo acumulado invalido gravado (%s): 500, nada gravado, sem log', async (_rotulo, valor) => {
    ativo(30, { tempoGasto: valor });
    const response = await putCrono('pausar', { key: KEY });
    expect([response.status, response.body]).toEqual([500, ERRO_500]);
    expect(gravacoesNaSessao()).toEqual([]);
    expect(mockDb.logs).toEqual([]);
    expect(tarefa.tempoGasto).toBe(valor);
  });

  test('28. virada do minuto durante a leitura e depois de um conflito: minutos da execucao confirmada', async () => {
    const T0 = Date.parse('2026-11-20T10:00:00.000Z');
    jest.useFakeTimers({ doNotFake: NAO_FALSIFICAR_ALEM_DE_DATE, now: T0 + (29 * 60 + 59.5) * 1000 });
    token = issueAuthToken(colaborador);
    // a) Leitura demorada: o relogio passa de 29:59,5 para 30:00,5 durante a consulta -> 40, nunca 39.
    Object.assign(tarefa, { cronometroAtivo: true, ultimaAtualizacaoCronometro: new Date(T0), tempoGasto: 10, tempoGastoSegundos: undefined, tempoEstimado: 100 });
    mockTx.aposLer = async ({ session }) => {
      if (session) jest.setSystemTime(T0 + (30 * 60 + 0.5) * 1000);
    };
    expect((await putCrono('pausar', { key: KEY })).status).toBe(200);
    expect(gravacoesNaSessao().map((item) => item.update.$set.tempoGasto)).toEqual([40]);
    expect(detalhesLog()).toEqual(['Cronômetro pausado. +30 mins']);

    // b) Conflito: a 1a execucao calcula 29 (39); WriteConflict; a 2a, ja em 30:00,5, grava 40 e loga +30.
    mockTx.aposLer = null;
    mockDb.logs.splice(0, mockDb.logs.length);
    mockDb.updateCalls.splice(0, mockDb.updateCalls.length);
    jest.setSystemTime(T0 + (29 * 60 + 59.5) * 1000);
    Object.assign(tarefa, { cronometroAtivo: true, ultimaAtualizacaoCronometro: new Date(T0), tempoGasto: 10, tempoGastoSegundos: undefined, tempoEstimado: 100 });
    let primeira = true;
    mockTx.antesDeGravar = async (chamada) => {
      if (chamada.withSession && primeira) {
        primeira = false;
        jest.setSystemTime(T0 + (30 * 60 + 0.5) * 1000);
        escreverFora((t) => { t.tempoEstimado = 39; });
      }
    };
    const response = await putCrono('pausar', { key: KEY_2 });
    expect(response.status).toBe(200);
    expect(gravacoesNaSessao().map((item) => item.update.$set.tempoGasto)).toEqual([39, 40]);
    expect(tarefa).toMatchObject({ tempoGasto: 40, tempoExcedido: true, cronometroAtivo: false });
    expect(response.body.tempoExcedido).toBe(true);
    expect(detalhesLog()).toEqual(['Cronômetro pausado. +30 mins']);
  });

  test('29. resposta e URLs assinadas montadas na hora; a chave guarda so o resumo', async () => {
    const primeira = await putCrono('iniciar', { key: KEY });
    const repeticao = await putCrono('iniciar', { key: KEY });
    const url1 = primeira.body.tarefa.anexos[0].url;
    const url2 = repeticao.body.tarefa.anexos[0].url;
    expect(url1).toMatch(/^https:\/\/storage\.test\/tarefas\/anexo\.pdf\?X-Goog-Signature=sig\d+$/);
    expect(url2).toMatch(/^https:\/\/storage\.test\/tarefas\/anexo\.pdf\?X-Goog-Signature=sig\d+$/);
    expect(url2).not.toBe(url1);
    expect(tarefa.anexos[0].url).toBe('tarefas/anexo.pdf');
    expect(chave().result).toEqual({ statusCode: 200, resourceType: 'tarefa', resourceId: tarefa._id });
    const guardado = JSON.stringify(mockDb.keys);
    expect(guardado).not.toContain('storage.test');
    expect(guardado).not.toContain('Cronômetro');
    expect(guardado).not.toContain('Relatório');
  });

  test('30. cronometro nao gera notificacao nem Socket.IO (legado, protegido e repeticao)', async () => {
    expect((await putCrono('iniciar')).status).toBe(200);
    expect((await putCrono('pausar', { key: KEY })).status).toBe(200);
    expect((await putCrono('pausar', { key: KEY })).status).toBe(200);
    expect(mockDb.notificationInserts).toEqual([]);
    expect(mockDb.notifications).toEqual([]);
    expect(mockDb.emits).toEqual([]);
  });

  test('31. outra rota muda campos da tarefa no meio do caminho: preservados; o update so toca o cronometro', async () => {
    ativo(30);
    const pausa = pausarPrimeiraLeituraNaSessao();
    const pedido = iniciar(putCrono('pausar', { key: KEY }));
    try {
      await waitFor(() => pausa.pausou, 'protegida leu');
      escreverFora((t) => {
        Object.assign(t, { descricao: 'Nova descrição', detalhes: 'Novo detalhe', tags: ['nova'], urgencia: 'alta', status: 'concluido' });
        t.subtarefas.push({ _id: id(), descricao: 'Sub nova', concluida: false });
      });
    } finally {
      pausa.liberar();
    }
    const response = await pedido;
    expect(response.status).toBe(200);
    expect(tarefa).toMatchObject({
      descricao: 'Nova descrição', detalhes: 'Novo detalhe', tags: ['nova'], urgencia: 'alta', status: 'concluido',
      cronometroAtivo: false, tempoGasto: 40,
    });
    expect(tarefa.subtarefas.map((sub) => sub.descricao)).toEqual(['Sub nova']);
    expect(response.body.tarefa.descricao).toBe('Nova descrição'); // resposta relida apos o commit
    gravacoesNaSessao().forEach(({ update }) => {
      Object.keys(update.$set).forEach((campo) => expect(CAMPOS_DO_CRONOMETRO).toContain(campo));
      expect(update.$unset).toBeUndefined();
    });
  });

  test('32. repeticao de uma pausa depois de um novo inicio: nao interrompe a nova sessao', async () => {
    ativo(30);
    expect((await putCrono('pausar', { key: KEY })).status).toBe(200);
    expect(tarefa.tempoGasto).toBe(40);
    expect((await putCrono('iniciar', { key: KEY_2 })).status).toBe(200);
    const novoInicio = tarefa.ultimaAtualizacaoCronometro.getTime();
    const depois = estado();
    const repeticao = await putCrono('pausar', { key: KEY });
    expect(repeticao.status).toBe(200);
    expect(repeticao.headers['idempotency-replayed']).toBe('true');
    expect(repeticao.body).toMatchObject({ msg: 'Cronômetro pausardo com sucesso', tarefa: { cronometroAtivo: true, tempoGasto: 40 } });
    expect(estado()).toEqual(depois);
    expect(tarefa.ultimaAtualizacaoCronometro.getTime()).toBe(novoInicio);
    expect(tiposLog()).toEqual(['cronometro_pausado', 'cronometro_iniciado']);
  });
});
