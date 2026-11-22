// Servico de confirmacoes compartilhadas do assistente (services/assistantOperationService.js), sem rotas.
// Banco simulado em memoria, sem conexao real e sem indices criados. O falso usa o model REAL:
// - create valida o documento pelo schema real (strict 'throw', enum, padroes, invariantes) e aplica os dois
//   indices unicos: operationId e a vaga ativa por conversa (unico parcial em { activeSlot: true });
// - findOneAndUpdate passa filtro e update pela conversao real do Mongoose (strict, immutable) e depois compara e
//   aplica sem nenhum await no meio (atomico por documento, como no MongoDB); o documento resultante e validado
//   inteiro pelo schema (as invariantes nao podem quebrar numa transicao);
// - campos select:false (idempotencyKey, claimToken) so voltam quando pedidos com '+campo';
// - um gancho antes do passo atomico permite colocar chamadas concorrentes lado a lado.
// O relogio do servico e controlado pelo teste.
const mongoose = require('mongoose');
const AssistantOperation = require('../models/AssistantOperation');
const { invariantViolations } = AssistantOperation;
const {
  createAssistantOperationService,
  configFromEnv,
  AssistantOperationInputError,
  AssistantOperationUnavailableError,
  missingIndexes,
  MAX_CLAIMS,
  paramsFingerprint,
} = require('../services/assistantOperationService');

const OWNER_A = 'a'.repeat(24);
const OWNER_B = 'b'.repeat(24);
const TASK_ID = 'c'.repeat(24);
const CONV = 'voice-aaaa-1732100000000';
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SECOND = 1000;
const MINUTE = 60 * SECOND;
const T0 = Date.parse('2026-11-21T12:00:00.000Z');

const STATUS_CMD = { commandKey: 'update_status', params: { task_id: TASK_ID, status: 'concluido' }, summary: 'mudar o status da tarefa "Relatório" para concluída' };

// ---------- Banco em memoria ----------
// Copia no mesmo realm do teste (structuredClone devolveria Date de outro realm no Jest e o instanceof falharia).
const deepClone = (value) => {
  if (value instanceof Date) return new Date(value.getTime());
  if (value instanceof mongoose.Types.ObjectId) return value.toHexString();
  if (value && typeof value.toObject === 'function' && value.$__) return deepClone(value.toObject()); // subdocumento
  if (Array.isArray(value)) return value.map(deepClone);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, deepClone(item)]));
  }
  return value;
};
const isOperator = (cond) =>
  cond !== null && typeof cond === 'object' && !(cond instanceof Date) && !(cond instanceof mongoose.Types.ObjectId)
  && Object.keys(cond).some((key) => key.startsWith('$'));
const comparable = (value) => (value instanceof Date ? value.getTime() : value instanceof mongoose.Types.ObjectId ? value.toHexString() : value);
const eq = (value, cond) => {
  if (cond === null) return value === null || value === undefined;
  if (value === null || value === undefined) return false;
  return String(comparable(value)) === String(comparable(cond)) && typeof comparable(value) === typeof comparable(cond);
};
const matchField = (value, cond) => {
  if (!isOperator(cond)) return eq(value, cond);
  return Object.entries(cond).every(([op, arg]) => {
    const v = comparable(value);
    const a = comparable(arg);
    switch (op) {
      case '$lt': return value != null && v < a;
      case '$lte': return value != null && v <= a;
      case '$gt': return value != null && v > a;
      case '$gte': return value != null && v >= a;
      case '$in': return arg.some((item) => eq(value, item));
      default: throw new Error(`operador nao suportado no teste: ${op}`);
    }
  });
};
const matches = (row, filter) => Object.entries(filter).every(([key, cond]) => {
  if (key === '$or') return cond.some((branch) => matches(row, branch));
  return matchField(row[key], cond);
});
const PRIVATE = ['idempotencyKey', 'claimToken'];
const project = (row, selected) => {
  const copy = deepClone(row);
  PRIVATE.forEach((name) => {
    if (!selected.includes(`+${name}`)) delete copy[name];
  });
  return copy;
};

// Indices como o listIndexes do MongoDB os devolveria depois da migracao.
const INDICES_OK = [
  { v: 2, key: { _id: 1 }, name: '_id_' },
  { v: 2, key: { operationId: 1 }, name: 'operation_id_unique', unique: true },
  { v: 2, key: { ownerId: 1, conversationId: 1 }, name: 'active_operation_per_conversation', unique: true, partialFilterExpression: { activeSlot: true } },
  { v: 2, key: { ownerId: 1, conversationId: 1, createdAt: -1 }, name: 'owner_conversation_recent' },
  { v: 2, key: { retainUntil: 1 }, name: 'retain_until_ttl', expireAfterSeconds: 0 },
];

const createFakeModel = (clock) => {
  const db = { rows: [], calls: [], seq: 0, indexes: deepClone(INDICES_OK), readyState: 1, listIndexesCalls: 0 };
  // strictDoc: o falso valida o documento inteiro apos cada update (mais do que o MongoDB faz). Desligado, imita o
  // banco real: so a conversao do Mongoose e os indices unicos; nenhuma regra de coerencia status x activeSlot.
  const hooks = { beforeAtomic: null, fail: null, strictDoc: true, failIndexes: null };
  const plainOf = (doc) => {
    const obj = doc.toObject({ depopulate: true, versionKey: false });
    obj.ownerId = String(obj.ownerId);
    obj._id = String(obj._id);
    return obj;
  };
  const dup = (keyPattern, name) => Object.assign(new Error(`E11000 duplicate key error index: ${name}`), { code: 11000, keyPattern });
  const checkUnique = (candidate, ignore) => {
    const others = db.rows.filter((row) => row !== ignore);
    if (others.some((row) => row.operationId === candidate.operationId)) throw dup({ operationId: 1 }, 'operation_id_unique');
    if (candidate.activeSlot === true && others.some((row) => row.activeSlot === true
      && row.ownerId === candidate.ownerId && row.conversationId === candidate.conversationId)) {
      throw dup({ ownerId: 1, conversationId: 1 }, 'active_operation_per_conversation');
    }
  };
  const chain = (run) => {
    let selected = '';
    let sort = null;
    const query = {
      select: (fields) => { selected = fields; return query; },
      sort: (value) => { sort = value; return query; },
      lean: () => run({ selected, sort }),
    };
    return query;
  };
  const step = async (op, info) => {
    db.calls.push({ op, ...info });
    if (hooks.beforeAtomic) await hooks.beforeAtomic(op, info);
    const failure = hooks.fail && hooks.fail(op, info);
    if (failure) throw failure;
  };

  const Model = {
    create: jest.fn(async (data) => {
      const doc = new AssistantOperation(data);
      await doc.validate(); // schema real
      await step('create', { data });
      const row = plainOf(doc);
      // Atomico: unicidade e insercao sem await no meio.
      checkUnique(row);
      row.createdAt = new Date(clock.now);
      row.updatedAt = new Date(clock.now);
      db.seq += 1;
      row._seq = db.seq;
      db.rows.push(row);
      return { toObject: () => project(row, ['+idempotencyKey', '+claimToken']) };
    }),
    findOne: jest.fn((filter) => chain(async ({ selected, sort }) => {
      const query = AssistantOperation.findOne(filter);
      query.cast(AssistantOperation);
      const casted = query.getFilter();
      await step('findOne', { filter });
      let rows = db.rows.filter((row) => matches(row, casted));
      if (sort) rows = [...rows].sort((a, b) => b.createdAt - a.createdAt || b._seq - a._seq);
      return rows[0] ? project(rows[0], selected) : null;
    })),
    findOneAndUpdate: jest.fn((filter, update, options) => chain(async ({ selected }) => {
      // Conversao real (strict 'throw', immutable); a query nunca e executada.
      const query = AssistantOperation.findOneAndUpdate(filter, update, options);
      query.cast(AssistantOperation);
      const casted = query.getFilter();
      const castUpdate = query._castUpdate(query._update);
      await step('findOneAndUpdate', { filter, update, castUpdate });
      // Atomico: comparar, aplicar e validar sem await no meio.
      const row = db.rows.find((item) => matches(item, casted));
      if (!row) return null;
      const next = deepClone(row);
      Object.entries(castUpdate.$set || {}).forEach(([path, value]) => {
        const parts = path.split('.');
        let target = next;
        parts.slice(0, -1).forEach((part) => { target[part] = target[part] || {}; target = target[part]; });
        target[parts[parts.length - 1]] = value instanceof mongoose.Types.ObjectId ? value.toHexString() : deepClone(value);
      });
      Object.keys(castUpdate.$unset || {}).forEach((path) => { delete next[path]; });
      Object.entries(castUpdate.$inc || {}).forEach(([path, amount]) => { next[path] = (next[path] || 0) + amount; });
      next.updatedAt = new Date(clock.now);
      const { _seq, createdAt, updatedAt, _id, ...persisted } = next;
      if (hooks.strictDoc) {
        // Regras de campo (validateSync) e invariantes (o gancho pre('validate') nao roda no validateSync).
        const error = new AssistantOperation(persisted).validateSync();
        if (error) throw error;
        const violations = invariantViolations(next);
        if (violations.length) throw new Error(`invariante quebrada: ${violations.map(([, m]) => m).join('; ')}`);
      }
      checkUnique(next, row); // isto o MongoDB garante (indice unico parcial)
      Object.keys(row).forEach((key) => delete row[key]);
      Object.assign(row, next);
      return project(row, selected);
    })),
    listIndexes: jest.fn(async () => {
      db.listIndexesCalls += 1;
      if (hooks.failIndexes) throw hooks.failIndexes;
      return deepClone(db.indexes);
    }),
  };
  Object.defineProperty(Model, 'db', { get: () => ({ readyState: db.readyState }) });
  return { Model, db, hooks };
};

// Espera com prazo real de 5 s.
const waitFor = async (predicate, label) => {
  const deadline = performance.now() + 5000;
  while (!predicate()) {
    if (performance.now() > deadline) throw new Error(`tempo esgotado esperando: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
};

describe('assistantOperationService', () => {
  let clock;
  let fake;
  let service;
  const advance = (ms) => { clock.now += ms; };
  const rowOf = (operationId) => fake.db.rows.find((row) => row.operationId === operationId);
  const ids = (operation, owner = OWNER_A) => ({ ownerId: owner, conversationId: CONV, operationId: operation.operationId });
  const createPending = async (extra = {}) => {
    const created = await service.create({ ownerId: OWNER_A, conversationId: CONV, ...STATUS_CMD, ...extra });
    expect(created.ok).toBe(true);
    return created.operation;
  };

  // Faz as N primeiras chamadas de `op` pararem antes do passo atomico; libera todas juntas. Liberacao no finally.
  const collide = async (op, count, runs) => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    let paused = 0;
    fake.hooks.beforeAtomic = async (name) => {
      if (name === op && paused < count) {
        paused += 1;
        await gate;
      }
    };
    const pending = runs.map((run) => run());
    try {
      await waitFor(() => paused === count, `${count} chamadas de ${op} paradas`);
    } finally {
      fake.hooks.beforeAtomic = null;
      release();
    }
    return Promise.all(pending);
  };

  beforeEach(() => {
    clock = { now: T0 };
    fake = createFakeModel(clock);
    service = createAssistantOperationService({
      Model: fake.Model,
      now: () => new Date(clock.now),
      config: configFromEnv({}),
    });
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    fake.hooks.beforeAtomic = null;
    fake.hooks.fail = null;
    jest.restoreAllMocks();
    // Nenhum teste abre conexao real (nem cria colecao/indice): o model real so e usado para validar e converter.
    expect(mongoose.connection.readyState).toBe(0);
    // Invariante em todo teste: no maximo uma operacao ativa por (dono, conversa), e activeSlot so nas ativas.
    const ativos = fake.db.rows.filter((row) => row.activeSlot === true);
    const chaves = ativos.map((row) => `${row.ownerId}:${row.conversationId}`);
    expect(new Set(chaves).size).toBe(chaves.length);
    fake.db.rows.forEach((row) => {
      expect(row.activeSlot === true).toBe(['pending', 'executing', 'retry_pending'].includes(row.status));
      expect(row.attempts).toBeLessThanOrEqual(MAX_CLAIMS);
    });
  });

  describe('formato do model e dos filtros (estrutura, nao comportamento)', () => {
    test('model nao cria colecao nem indices; indices previstos declarados', () => {
      const { schema } = AssistantOperation;
      expect(schema.get('autoIndex')).toBe(false);
      expect(schema.get('autoCreate')).toBe(false);
      expect(schema.get('strict')).toBe('throw');
      expect(AssistantOperation.collection.collectionName).toBe('assistantoperations');
      const indexes = Object.fromEntries(schema.indexes().map(([keys, options]) => [options.name, { keys, options }]));
      expect(indexes.operation_id_unique).toMatchObject({ keys: { operationId: 1 }, options: { unique: true } });
      expect(indexes.active_operation_per_conversation).toMatchObject({
        keys: { ownerId: 1, conversationId: 1 },
        options: { unique: true, partialFilterExpression: { activeSlot: true } },
      });
      expect(indexes.owner_conversation_recent).toMatchObject({ keys: { ownerId: 1, conversationId: 1, createdAt: -1 } });
      expect(indexes.retain_until_ttl).toMatchObject({ keys: { retainUntil: 1 }, options: { expireAfterSeconds: 0 } });
    });

    test('schema recusa campos inesperados, valores fora do padrao e invariantes quebradas', async () => {
      const base = {
        operationId: '3f1c2b6e-8a4d-4c1b-9e2f-7a6b5c4d3e2f', ownerId: OWNER_A, conversationId: CONV,
        commandKey: 'update_status', params: { task_id: TASK_ID, status: 'concluido' }, summary: 'x',
        idempotencyKey: '9d8c7b6a-5f4e-4d3c-8b2a-1f0e9d8c7b6a', status: 'pending', activeSlot: true, attempts: 0,
        expiresAt: new Date(T0 + 1), recoverUntil: new Date(T0 + 2), retainUntil: new Date(T0 + 3),
      };
      expect(new AssistantOperation(base).validateSync()).toBeUndefined();
      expect(() => new AssistantOperation({ ...base, token: 'x' })).toThrow(/not in schema/);
      // Campo desconhecido dentro de params: o documento fica invalido (StrictModeError na conversao do subdocumento).
      expect(String(new AssistantOperation({ ...base, params: { task_id: TASK_ID, _task_label: 'x' } }).validateSync()))
        .toMatch(/StrictModeError/);
      const invalidos = [
        { operationId: 'nao-e-uuid' }, { commandKey: 'delete_task' }, { status: 'done' }, { conversationId: 'com espaço' },
        { summary: 'x'.repeat(4001) }, { params: { task_id: 'nao-e-id' } }, { params: { status: 'feito' } },
        { activeSlot: undefined }, { status: 'completed' }, { recoverUntil: new Date(T0 + 5) }, { attempts: 4 },
        { idempotencyKey: '3f1c2b6e-8a4d-1c1b-9e2f-7a6b5c4d3e2f' }, // v1, nao v4
      ];
      // validate() assincrono, como no create(): inclui as invariantes do gancho pre('validate').
      for (const change of invalidos) {
        await expect(new AssistantOperation({ ...base, ...change }).validate()).rejects.toBeDefined();
      }
      await expect(new AssistantOperation(base).validate()).resolves.toBeUndefined();
    });

    test('conversao real do Mongoose ignora $set em campos imutaveis (inclusive params.x)', () => {
      for (const update of [{ $set: { commandKey: 'timer' } }, { $set: { params: { task_id: TASK_ID } } }, { $set: { 'params.status': 'pendente' } }, { $set: { summary: 'outro' } }, { $set: { idempotencyKey: '9d8c7b6a-5f4e-4d3c-8b2a-1f0e9d8c7b6a' } }]) {
        const query = AssistantOperation.findOneAndUpdate({}, update);
        const casted = query._castUpdate(query._update) || {};
        expect(casted.$set || {}).toEqual({});
      }
    });
  });

  describe('criacao e vaga da conversa', () => {
    test('cria pending com IDs v4 distintos, prazos do servidor e visao publica sem dados internos', async () => {
      const created = await service.create({ ownerId: OWNER_A, conversationId: CONV, ...STATUS_CMD });
      expect(created.ok).toBe(true);
      const { operation } = created;
      expect(operation.operationId).toMatch(UUID_V4);
      expect(operation).toMatchObject({ status: 'pending', attempts: 0, commandKey: 'update_status', conversationId: CONV });
      expect(operation.expiresAt).toBe(new Date(T0 + 120 * SECOND).toISOString());
      expect(operation.recoverUntil).toBe(new Date(T0 + 120 * SECOND + 10 * MINUTE).toISOString());
      expect(Object.keys(operation)).not.toEqual(expect.arrayContaining(['idempotencyKey']));
      ['idempotencyKey', 'claimToken', 'ownerId', 'params', 'leaseUntil'].forEach((name) => expect(operation).not.toHaveProperty(name));
      const row = rowOf(operation.operationId);
      expect(row.idempotencyKey).toMatch(UUID_V4);
      expect(row.idempotencyKey).not.toBe(row.operationId);
      expect(row.retainUntil.getTime()).toBe(T0 + 24 * 3600 * SECOND);
      expect(row).toMatchObject({ ownerId: OWNER_A, activeSlot: true, params: STATUS_CMD.params });
    });

    test('1. duas criacoes simultaneas na mesma conversa: o indice unico parcial deixa so uma', async () => {
      const [r1, r2] = await collide('create', 2, [
        () => service.create({ ownerId: OWNER_A, conversationId: CONV, ...STATUS_CMD }),
        () => service.create({ ownerId: OWNER_A, conversationId: CONV, commandKey: 'timer', params: { task_id: TASK_ID, acao: 'iniciar' }, summary: 'iniciar o cronômetro' }),
      ]);
      const ok = [r1, r2].filter((r) => r.ok);
      const busy = [r1, r2].filter((r) => !r.ok);
      expect(ok).toHaveLength(1);
      expect(busy).toEqual([{ ok: false, reason: 'conversation_busy', operation: expect.objectContaining({ operationId: ok[0].operation.operationId, status: 'pending' }) }]);
      expect(fake.db.rows).toHaveLength(1);
      // As duas passaram pela leitura previa (settle) antes de tentar inserir: quem barrou foi o indice.
      expect(fake.db.calls.filter((c) => c.op === 'create')).toHaveLength(2);
    });

    test('15. nova operacao depois de concluida ou cancelada; em execucao/recuperacao a vaga nao e substituida', async () => {
      const primeira = await createPending();
      expect((await service.create({ ownerId: OWNER_A, conversationId: CONV, ...STATUS_CMD })).reason).toBe('conversation_busy');
      expect((await service.cancel(ids(primeira))).ok).toBe(true);
      const segunda = await createPending();
      const claim = await service.claim(ids(segunda));
      expect((await service.create({ ownerId: OWNER_A, conversationId: CONV, ...STATUS_CMD })).reason).toBe('conversation_busy');
      await service.recordRetry({ ...ids(segunda), claimToken: claim.operation.claimToken });
      expect(rowOf(segunda.operationId).status).toBe('retry_pending');
      expect((await service.create({ ownerId: OWNER_A, conversationId: CONV, ...STATUS_CMD })).reason).toBe('conversation_busy');
      const reclaim = await service.claim(ids(segunda));
      expect((await service.complete({ ...ids(segunda), claimToken: reclaim.operation.claimToken, outcome: 'completed', result: { httpStatus: 200 } })).ok).toBe(true);
      const terceira = await service.create({ ownerId: OWNER_A, conversationId: CONV, ...STATUS_CMD });
      expect(terceira.ok).toBe(true);
      expect((await service.getCurrent({ ownerId: OWNER_A, conversationId: CONV })).operationId).toBe(terceira.operation.operationId);
      // Outra conversa do mesmo usuario e independente.
      expect((await service.create({ ownerId: OWNER_A, conversationId: 'web', ...STATUS_CMD })).ok).toBe(true);
    });

    test('pending vencida nao prende a conversa: a criacao seguinte a assenta como expired', async () => {
      const antiga = await createPending();
      advance(121 * SECOND);
      const nova = await service.create({ ownerId: OWNER_A, conversationId: CONV, ...STATUS_CMD });
      expect(nova.ok).toBe(true);
      expect(rowOf(antiga.operationId)).toMatchObject({ status: 'expired' });
      expect(rowOf(antiga.operationId).activeSlot).toBeUndefined();
    });

    test('16. sem JWT, credencial ou URL assinada; parametros e resultado so no formato previsto', async () => {
      const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnop';
      const tentativas = [
        [{ commandKey: 'add_comment', params: { task_id: TASK_ID, texto: `meu token ${jwt}` }, summary: 'comentar' }, 'params_sensitive'],
        [{ commandKey: 'add_comment', params: { task_id: TASK_ID, texto: 'veja https://storage.test/a.pdf?X-Goog-Signature=abc' }, summary: 'comentar' }, 'params_sensitive'],
        [{ ...STATUS_CMD, summary: 'Bearer abcdefghijklmnopqrstuvwxyz' }, 'summary_sensitive'],
        [{ ...STATUS_CMD, params: { ...STATUS_CMD.params, _task_label: 'Relatório' } }, 'params_invalid'],
        [{ ...STATUS_CMD, params: { ...STATUS_CMD.params, token: 'x' } }, 'params_invalid'],
        [{ ...STATUS_CMD, params: { task_id: TASK_ID } }, 'params_invalid'], // falta status
        [{ ...STATUS_CMD, params: { task_id: TASK_ID, status: 1 } }, 'params_invalid'],
        [{ ...STATUS_CMD, commandKey: 'delete_task' }, 'command_invalid'],
        [{ ...STATUS_CMD, conversationId: '../../etc' }, 'conversation_invalid'],
        [{ ...STATUS_CMD, ownerId: 'nao-e-id' }, 'owner_invalid'],
      ];
      for (const [input, code] of tentativas) {
        await expect(service.create({ ownerId: OWNER_A, conversationId: CONV, ...input })).rejects.toMatchObject({ name: 'AssistantOperationInputError', code });
      }
      expect(fake.db.rows).toEqual([]);
      const op = await createPending();
      const claim = await service.claim(ids(op));
      await expect(service.complete({ ...ids(op), claimToken: claim.operation.claimToken, outcome: 'completed', result: { httpStatus: 200, mensagem: 'texto livre' } }))
        .rejects.toMatchObject({ code: 'result_invalid' });
      await expect(service.complete({ ...ids(op), claimToken: claim.operation.claimToken, outcome: 'completed', result: { resourceId: 'https://x' } }))
        .rejects.toMatchObject({ code: 'result_invalid' });
      const guardado = JSON.stringify(fake.db.rows);
      expect(guardado).not.toMatch(/eyJ|X-Goog|Bearer/);
    });
  });

  describe('impressao digital dos parametros (resposta perdida no create)', () => {
    // Mesmo vetor de flowly_assistente/tests/test_shared_confirmations.py (pontos de codigo, sem escapes no fonte).
    const VECTOR_CODES = [82, 101, 118, 34, 110, 250, 109, 34, 10, 224, 109, 227, 32, 92, 32, 111, 107, 1, 31, 127, 32,
      0x2028, 32, 0x2713, 32, 0x1f600];
    const VECTOR_HASH = '67e7a379e9a71251cc564c4cee1cb4686c202ac63a4ae98cdbfa44aed47e5e13';

    test('serializacao canonica igual a do Python: vetor de referencia, ordem das chaves e formatos inesperados', () => {
      const texto = String.fromCodePoint(...VECTOR_CODES);
      expect(paramsFingerprint('add_comment', { texto, task_id: '1'.repeat(24) })).toBe(VECTOR_HASH);
      expect(paramsFingerprint('add_comment', { task_id: '1'.repeat(24), texto })).toBe(VECTOR_HASH);
      expect(paramsFingerprint('add_comment', { task_id: '1'.repeat(24), texto, user: undefined })).toBe(VECTOR_HASH);
      expect(paramsFingerprint('add_subtask', { texto, task_id: '1'.repeat(24) })).not.toBe(VECTOR_HASH);
      [{ texto: 1 }, ['texto'], null, 'texto'].forEach((bad) => expect(paramsFingerprint('add_comment', bad)).toBeNull());
    });

    test('estado traz so a impressao dos params gravados; mesmo comando e resumo com params diferentes divergem', async () => {
      const primeira = await service.create({ ownerId: OWNER_A, conversationId: CONV, ...STATUS_CMD });
      expect(primeira.operation).not.toHaveProperty('params');
      expect(primeira.operation.paramsFingerprint).toBe(paramsFingerprint('update_status', STATUS_CMD.params));
      expect(JSON.stringify(primeira.operation)).not.toContain(TASK_ID);
      await service.cancel({ ownerId: OWNER_A, conversationId: CONV, operationId: primeira.operation.operationId });
      const outra = { ...STATUS_CMD, params: { ...STATUS_CMD.params, task_id: 'd'.repeat(24) } };
      const segunda = await service.create({ ownerId: OWNER_A, conversationId: CONV, ...outra });
      const atual = await service.getCurrent({ ownerId: OWNER_A, conversationId: CONV });
      expect(atual.operationId).toBe(segunda.operation.operationId);
      expect([atual.commandKey, atual.summary]).toEqual([primeira.operation.commandKey, primeira.operation.summary]);
      expect(atual.paramsFingerprint).toMatch(/^[0-9a-f]{64}$/);
      expect(atual.paramsFingerprint).not.toBe(primeira.operation.paramsFingerprint);
      expect(atual).not.toHaveProperty('params');
    });
  });

  describe('claim e lease', () => {
    test('claim de pending: executing, attempts 1, claimToken e idempotencyKey so na visao do claim', async () => {
      const op = await createPending();
      const claim = await service.claim(ids(op));
      expect(claim.ok).toBe(true);
      expect(claim.operation).toMatchObject({ status: 'executing', attempts: 1, recovery: false, params: STATUS_CMD.params, commandKey: 'update_status' });
      expect(claim.operation.claimToken).toMatch(UUID_V4);
      expect(claim.operation.idempotencyKey).toBe(rowOf(op.operationId).idempotencyKey);
      expect(claim.operation.leaseUntil).toBe(new Date(T0 + 180 * SECOND).toISOString());
      const atual = await service.getCurrent({ ownerId: OWNER_A, conversationId: CONV });
      ['idempotencyKey', 'claimToken', 'params'].forEach((name) => expect(atual).not.toHaveProperty(name));
    });

    test('2. duas reivindicacoes simultaneas: so uma vence', async () => {
      const op = await createPending();
      const [c1, c2] = await collide('findOneAndUpdate', 2, [() => service.claim(ids(op)), () => service.claim(ids(op))]);
      const vencedor = [c1, c2].filter((c) => c.ok);
      const perdedor = [c1, c2].filter((c) => !c.ok);
      expect(vencedor).toHaveLength(1);
      expect(perdedor).toEqual([expect.objectContaining({ ok: false, reason: 'in_progress' })]);
      expect(rowOf(op.operationId)).toMatchObject({ status: 'executing', attempts: 1, claimToken: vencedor[0].operation.claimToken });
    });

    test('8. lease valido impede novo claim', async () => {
      const op = await createPending();
      expect((await service.claim(ids(op))).ok).toBe(true);
      advance(179 * SECOND);
      expect(await service.claim(ids(op))).toMatchObject({ ok: false, reason: 'in_progress' });
      expect(rowOf(op.operationId).attempts).toBe(1);
    });

    test('9. lease vencido: recuperacao com a MESMA idempotencyKey e nova ficha', async () => {
      const op = await createPending();
      const primeira = await service.claim(ids(op));
      advance(181 * SECOND); // ja passou tambem do prazo de confirmacao (120 s): nao impede a recuperacao
      const segunda = await service.claim(ids(op));
      expect(segunda.ok).toBe(true);
      expect(segunda.operation).toMatchObject({ status: 'executing', attempts: 2, recovery: true });
      expect(segunda.operation.idempotencyKey).toBe(primeira.operation.idempotencyKey);
      expect(segunda.operation.claimToken).not.toBe(primeira.operation.claimToken);
    });

    test('5. detentor antigo nao conclui nem libera depois de perder o lease; o novo conclui', async () => {
      const op = await createPending();
      const antigo = await service.claim(ids(op));
      advance(181 * SECOND);
      const novo = await service.claim(ids(op));
      for (const tentativa of [
        () => service.complete({ ...ids(op), claimToken: antigo.operation.claimToken, outcome: 'completed', result: { httpStatus: 200 } }),
        () => service.complete({ ...ids(op), claimToken: antigo.operation.claimToken, outcome: 'failed', result: { httpStatus: 400 } }),
        () => service.recordRetry({ ...ids(op), claimToken: antigo.operation.claimToken }),
      ]) {
        expect(await tentativa()).toMatchObject({ ok: false, reason: 'claim_lost' });
      }
      expect(rowOf(op.operationId)).toMatchObject({ status: 'executing', claimToken: novo.operation.claimToken, attempts: 2 });
      const fim = await service.complete({ ...ids(op), claimToken: novo.operation.claimToken, outcome: 'completed', result: { httpStatus: 200, replayed: true } });
      expect(fim.operation).toMatchObject({ status: 'completed', result: { httpStatus: 200, replayed: true } });
    });

    test('lease vencido sem novo claim: o detentor tambem nao conclui (a recuperacao decide pela mesma chave)', async () => {
      const op = await createPending();
      const claim = await service.claim(ids(op));
      advance(181 * SECOND);
      expect(await service.complete({ ...ids(op), claimToken: claim.operation.claimToken, outcome: 'completed' })).toMatchObject({ ok: false, reason: 'claim_lost' });
      expect(rowOf(op.operationId).status).toBe('executing');
    });

    test('prazo de confirmacao vencido nao cancela execucao ja reivindicada', async () => {
      const op = await createPending();
      const claim = await service.claim(ids(op));
      advance(150 * SECOND); // depois de expiresAt (120 s), dentro do lease (180 s)
      expect((await service.getCurrent({ ownerId: OWNER_A, conversationId: CONV })).status).toBe('executing');
      const fim = await service.complete({ ...ids(op), claimToken: claim.operation.claimToken, outcome: 'completed', result: { httpStatus: 200 } });
      expect(fim.ok).toBe(true);
    });

    test('10. tres claims esgotados: nenhum quarto; vira unknown (terminal)', async () => {
      const op = await createPending();
      for (let n = 1; n <= MAX_CLAIMS; n += 1) {
        const claim = await service.claim(ids(op));
        expect(claim.operation.attempts).toBe(n);
        advance(181 * SECOND);
      }
      const quarta = await service.claim(ids(op));
      expect(quarta).toMatchObject({ ok: false, reason: 'terminal', operation: { status: 'unknown', result: { code: 'attempts_exhausted' } } });
      expect(rowOf(op.operationId).attempts).toBe(MAX_CLAIMS);
    });

    test('recordRetry no terceiro claim: unknown por tentativas esgotadas; antes disso, retry_pending', async () => {
      const op = await createPending();
      let claim = await service.claim(ids(op));
      let retry = await service.recordRetry({ ...ids(op), claimToken: claim.operation.claimToken, result: { httpStatus: 503, code: 'transactions_unavailable' } });
      expect(retry.operation).toMatchObject({ status: 'retry_pending', result: { httpStatus: 503 } });
      claim = await service.claim(ids(op));
      expect(claim.operation).toMatchObject({ attempts: 2, recovery: true });
      retry = await service.recordRetry({ ...ids(op), claimToken: claim.operation.claimToken });
      claim = await service.claim(ids(op));
      expect(claim.operation.attempts).toBe(3);
      retry = await service.recordRetry({ ...ids(op), claimToken: claim.operation.claimToken, result: { code: 'network_error' } });
      expect(retry.operation).toMatchObject({ status: 'unknown', result: { code: 'attempts_exhausted' } });
      expect(await service.claim(ids(op))).toMatchObject({ ok: false, reason: 'terminal' });
    });

    test('7. claim depois da expiracao: pending vira expired, sem execucao', async () => {
      const op = await createPending();
      advance(120 * SECOND); // expiresAt exato: ja nao vale (> e estrito)
      expect(await service.claim(ids(op))).toMatchObject({ ok: false, reason: 'expired', operation: { status: 'expired' } });
      expect(rowOf(op.operationId)).toMatchObject({ status: 'expired', attempts: 0 });
    });

    test('retry_pending so pode ser reivindicada dentro da janela de recuperacao', async () => {
      const op = await createPending();
      const claim = await service.claim(ids(op));
      await service.recordRetry({ ...ids(op), claimToken: claim.operation.claimToken });
      advance(120 * SECOND + 10 * MINUTE); // recoverUntil exato
      expect(await service.claim(ids(op))).toMatchObject({ ok: false, reason: 'terminal', operation: { status: 'unknown', result: { code: 'recovery_window_elapsed' } } });
      expect(rowOf(op.operationId).attempts).toBe(1);
    });
  });

  describe('estados terminais, cancelamento e concorrencia', () => {
    test('11 e 12. completed, failed, cancelled, expired e unknown nunca executam de novo', async () => {
      const desfechos = [];
      for (const outcome of ['completed', 'failed', 'unknown']) {
        const op = await createPending();
        const claim = await service.claim(ids(op));
        expect((await service.complete({ ...ids(op), claimToken: claim.operation.claimToken, outcome })).ok).toBe(true);
        desfechos.push(op);
      }
      const cancelada = await createPending();
      await service.cancel(ids(cancelada));
      const expirada = await createPending();
      advance(121 * SECOND);
      await service.expire(ids(expirada));
      for (const op of [...desfechos, cancelada, expirada]) {
        const antes = deepClone(rowOf(op.operationId));
        advance(181 * SECOND);
        const claim = await service.claim(ids(op));
        expect(claim.ok).toBe(false);
        expect(['terminal', 'expired']).toContain(claim.reason);
        expect(rowOf(op.operationId)).toEqual({ ...antes });
        expect((await service.cancel(ids(op))).ok).toBe(false);
        expect((await service.getResult(ids(op))).ok).toBe(true);
      }
    });

    test('3. cancelamento concorrente com a confirmacao, nas duas ordens', async () => {
      const a = await createPending();
      const [claimA, cancelA] = await collide('findOneAndUpdate', 2, [() => service.claim(ids(a)), () => service.cancel(ids(a))]);
      // Quem chegar primeiro ao passo atomico decide; o outro recebe a recusa coerente.
      if (claimA.ok) {
        expect(cancelA).toMatchObject({ ok: false, reason: 'in_progress' });
        expect(rowOf(a.operationId).status).toBe('executing');
      } else {
        expect(cancelA.ok).toBe(true);
        expect(claimA).toMatchObject({ ok: false, reason: 'terminal', operation: { status: 'cancelled' } });
      }
      if (claimA.ok) {
        await service.complete({ ...ids(a), claimToken: claimA.operation.claimToken, outcome: 'completed' });
      }
      // As duas ordens de forma deterministica.
      const b = await createPending();
      const claimB = await service.claim(ids(b));
      expect(claimB.ok).toBe(true);
      expect(await service.cancel(ids(b))).toMatchObject({ ok: false, reason: 'in_progress' });
      expect(rowOf(b.operationId).status).toBe('executing');
      await service.complete({ ...ids(b), claimToken: claimB.operation.claimToken, outcome: 'completed' });
      const c = await createPending();
      expect((await service.cancel(ids(c))).ok).toBe(true);
      expect(await service.claim(ids(c))).toMatchObject({ ok: false, reason: 'terminal', operation: { status: 'cancelled' } });
    });

    test('4. conclusao concorrente com recuperacao: lease valido -> conclusao vence; vencido -> so a recuperacao vale', async () => {
      // Lease valido: o claim de recuperacao nao casa; a conclusao entra.
      const op = await createPending();
      const claim = await service.claim(ids(op));
      advance(100 * SECOND);
      const [fim, recuperacao] = await collide('findOneAndUpdate', 2, [
        () => service.complete({ ...ids(op), claimToken: claim.operation.claimToken, outcome: 'completed', result: { httpStatus: 200 } }),
        () => service.claim(ids(op)),
      ]);
      expect(fim.ok).toBe(true);
      expect(recuperacao).toMatchObject({ ok: false });
      expect(['in_progress', 'terminal']).toContain(recuperacao.reason);
      expect(rowOf(op.operationId)).toMatchObject({ status: 'completed', attempts: 1 });

      // Lease vencido: a conclusao do antigo falha em qualquer ordem; a recuperacao assume.
      const op2 = await createPending();
      const claim2 = await service.claim(ids(op2));
      advance(181 * SECOND);
      const [fim2, recuperacao2] = await collide('findOneAndUpdate', 2, [
        () => service.complete({ ...ids(op2), claimToken: claim2.operation.claimToken, outcome: 'completed' }),
        () => service.claim(ids(op2)),
      ]);
      expect(fim2).toMatchObject({ ok: false, reason: 'claim_lost' });
      expect(recuperacao2.ok).toBe(true);
      expect(rowOf(op2.operationId)).toMatchObject({ status: 'executing', attempts: 2, claimToken: recuperacao2.operation.claimToken });
    });

    test('6. commandKey e params nao mudam depois da criacao (servico e conversao do Mongoose)', async () => {
      const op = await createPending();
      const claim = await service.claim(ids(op));
      await service.recordRetry({ ...ids(op), claimToken: claim.operation.claimToken });
      const reclaim = await service.claim(ids(op));
      await service.complete({ ...ids(op), claimToken: reclaim.operation.claimToken, outcome: 'completed', result: { httpStatus: 200 } });
      // Nenhuma atualizacao montada pelo servico toca campo imutavel.
      const MUTAVEIS = ['status', 'claimToken', 'leaseUntil', 'attempts', 'result', 'activeSlot'];
      fake.db.calls.filter((c) => c.op === 'findOneAndUpdate').forEach(({ update }) => {
        ['$set', '$unset', '$inc'].forEach((opr) => Object.keys(update[opr] || {}).forEach((path) => expect(MUTAVEIS).toContain(path)));
      });
      const antes = deepClone(rowOf(op.operationId));
      // Chamada direta ao model (como faria um codigo com defeito): a conversao real descarta os campos imutaveis.
      await fake.Model.findOneAndUpdate(
        { operationId: op.operationId },
        { $set: { commandKey: 'timer', params: { task_id: TASK_ID, acao: 'pausar' }, 'params.status': 'pendente', summary: 'outro' } },
        { new: true }
      ).lean();
      const depois = rowOf(op.operationId);
      expect(depois.commandKey).toBe(antes.commandKey);
      expect(depois.params).toEqual(antes.params);
      expect(depois.summary).toBe(antes.summary);
      expect(depois.idempotencyKey).toBe(antes.idempotencyKey);
    });

    test('13. outro usuario nao ve, nao reivindica, nao cancela e nao conclui: igual a operacao inexistente', async () => {
      const op = await createPending();
      const claimDono = await service.claim(ids(op));
      advance(181 * SECOND); // lease vencido: se o filtro de dono falhasse, B conseguiria assumir
      const naoExiste = { ...ids(op, OWNER_B), operationId: '1a2b3c4d-5e6f-4a1b-8c2d-3e4f5a6b7c8d' };
      for (const alvo of [ids(op, OWNER_B), naoExiste]) {
        expect(await service.claim(alvo)).toEqual({ ok: false, reason: 'not_found' });
        expect(await service.cancel(alvo)).toEqual({ ok: false, reason: 'not_found' });
        expect(await service.getResult(alvo)).toEqual({ ok: false, reason: 'not_found' });
        expect(await service.expire(alvo)).toEqual({ ok: false, reason: 'not_found' });
        expect(await service.complete({ ...alvo, claimToken: claimDono.operation.claimToken, outcome: 'completed' })).toEqual({ ok: false, reason: 'not_found' });
        expect(await service.recordRetry({ ...alvo, claimToken: claimDono.operation.claimToken })).toEqual({ ok: false, reason: 'not_found' });
      }
      expect(await service.getCurrent({ ownerId: OWNER_B, conversationId: CONV })).toBeNull();
      expect(rowOf(op.operationId)).toMatchObject({ status: 'executing', attempts: 1, claimToken: claimDono.operation.claimToken });
      // Conversa errada do proprio dono tambem nao acha.
      expect(await service.claim({ ...ids(op), conversationId: 'web' })).toEqual({ ok: false, reason: 'not_found' });
    });

    test('14. falha do banco: o erro sobe, nunca vira sucesso, e nada muda', async () => {
      const op = await createPending();
      const antes = deepClone(fake.db.rows);
      const erro = Object.assign(new Error('conexao interrompida'), { name: 'MongoNetworkError' });
      fake.hooks.fail = (name) => (name === 'findOneAndUpdate' ? erro : null);
      await expect(service.claim(ids(op))).rejects.toBe(erro);
      await expect(service.cancel(ids(op))).rejects.toBe(erro);
      await expect(service.create({ ownerId: OWNER_A, conversationId: 'web', ...STATUS_CMD })).rejects.toBe(erro);
      fake.hooks.fail = (name) => (name === 'create' ? erro : null);
      await expect(service.create({ ownerId: OWNER_A, conversationId: 'web', ...STATUS_CMD })).rejects.toBe(erro);
      fake.hooks.fail = (name) => (name === 'findOne' ? erro : null);
      await expect(service.getResult(ids(op))).rejects.toBe(erro);
      fake.hooks.fail = null;
      expect(fake.db.rows).toEqual(antes);
      // Erro de duplicidade que nao e da vaga (ex.: operationId repetido) tambem sobe.
      const repetido = createAssistantOperationService({ Model: fake.Model, now: () => new Date(clock.now), newUuid: () => op.operationId, config: configFromEnv({}) });
      await expect(repetido.create({ ownerId: OWNER_A, conversationId: 'outra', ...STATUS_CMD })).rejects.toThrow(/distintos/);
      let n = 0;
      const ids4 = [op.operationId, '1a2b3c4d-5e6f-4a1b-8c2d-3e4f5a6b7c8d'];
      const colisao = createAssistantOperationService({ Model: fake.Model, now: () => new Date(clock.now), newUuid: () => ids4[n++ % 2], config: configFromEnv({}) });
      await expect(colisao.create({ ownerId: OWNER_A, conversationId: 'outra', ...STATUS_CMD })).rejects.toMatchObject({ code: 11000 });
    });
  });

  describe('consultas, expiracao manual e configuracao', () => {
    test('getCurrent devolve a mais recente (ativa ou terminal) e assenta prazos; getResult so para terminais', async () => {
      expect(await service.getCurrent({ ownerId: OWNER_A, conversationId: CONV })).toBeNull();
      const op = await createPending();
      expect(await service.getResult(ids(op))).toMatchObject({ ok: false, reason: 'not_terminal', operation: { status: 'pending' } });
      advance(121 * SECOND);
      expect(await service.getCurrent({ ownerId: OWNER_A, conversationId: CONV })).toMatchObject({ operationId: op.operationId, status: 'expired' });
      advance(SECOND);
      const nova = await createPending();
      expect((await service.getCurrent({ ownerId: OWNER_A, conversationId: CONV })).operationId).toBe(nova.operationId);
    });

    test('expire so marca pending vencida; cancel so pending no prazo', async () => {
      const op = await createPending();
      expect(await service.expire(ids(op))).toMatchObject({ ok: false, reason: 'not_pending_or_not_due' });
      advance(121 * SECOND);
      expect(await service.cancel(ids(op))).toMatchObject({ ok: false, reason: 'expired' });
      expect(rowOf(op.operationId).status).toBe('expired');
      expect(await service.expire(ids(op))).toMatchObject({ ok: false, reason: 'not_pending_or_not_due' });
    });

    test('entradas invalidas sao recusadas antes de qualquer acesso ao banco', async () => {
      const op = await createPending();
      const chamadas = fake.db.calls.length;
      await expect(service.claim({ ...ids(op), operationId: 'nao-e-uuid' })).rejects.toBeInstanceOf(AssistantOperationInputError);
      await expect(service.complete({ ...ids(op), claimToken: 'x', outcome: 'completed' })).rejects.toMatchObject({ code: 'claim_token_invalid' });
      await expect(service.complete({ ...ids(op), claimToken: '1a2b3c4d-5e6f-4a1b-8c2d-3e4f5a6b7c8d', outcome: 'retry' })).rejects.toMatchObject({ code: 'outcome_invalid' });
      await expect(service.getCurrent({ ownerId: { $ne: null }, conversationId: CONV })).rejects.toMatchObject({ code: 'owner_invalid' });
      expect(fake.db.calls.length).toBe(chamadas);
    });

    test('configuracao: padroes (120 s, 10 min, 180 s, 24 h, 3 claims), limites e retencao nunca acima da chave da API', () => {
      expect(configFromEnv({})).toEqual({ confirmMs: 120000, recoveryMs: 600000, leaseMs: 180000, retentionMs: 24 * 3600000, maxClaims: 3 });
      expect(configFromEnv({ ASSISTANT_OPERATION_LEASE_SECONDS: '5', ASSISTANT_OPERATION_RETENTION_HOURS: '999' })).toMatchObject({ leaseMs: 60000, retentionMs: 24 * 3600000 });
      expect(configFromEnv({ ASSISTANT_OPERATION_RETENTION_HOURS: '2' }).retentionMs).toBe(2 * 3600000);
      expect(() => createAssistantOperationService({ Model: fake.Model, config: { confirmMs: 1, recoveryMs: 1, leaseMs: 1, retentionMs: 2, maxClaims: 3 } })).toThrow(/retencao/);
    });
  });

  describe('prontidao: conexao e indices obrigatorios (fail-closed)', () => {
    const tentarCriar = () => service.create({ ownerId: OWNER_A, conversationId: CONV, ...STATUS_CMD });
    const trocar = (name, change) => (indexes) => indexes.map((index) => (index.name === name ? change({ ...index }) : index));

    test('todos os indices presentes: opera; o sucesso fica em cache (uma consulta para varias operacoes)', async () => {
      const op = await createPending();
      await service.getCurrent({ ownerId: OWNER_A, conversationId: CONV });
      await service.claim(ids(op));
      expect(fake.db.listIndexesCalls).toBe(1);
    });

    test('os indices declarados no model satisfazem os requisitos verificados', () => {
      const declarados = AssistantOperation.schema.indexes().map(([key, options]) => ({ key, ...options }));
      expect(missingIndexes(declarados)).toEqual([]);
      expect(missingIndexes([])).toEqual(['operation_id_unique', 'active_operation_per_conversation', 'retain_until_ttl']);
    });

    const QUEBRAS = [
      ['unico de operationId ausente', (ix) => ix.filter((i) => i.name !== 'operation_id_unique'), ['operation_id_unique']],
      ['operationId sem unique', trocar('operation_id_unique', (i) => ({ ...i, unique: false })), ['operation_id_unique']],
      ['operationId unico mas parcial', trocar('operation_id_unique', (i) => ({ ...i, partialFilterExpression: { status: 'pending' } })), ['operation_id_unique']],
      ['operationId unico mas esparso', trocar('operation_id_unique', (i) => ({ ...i, sparse: true })), ['operation_id_unique']],
      ['nome certo com campos errados', trocar('operation_id_unique', (i) => ({ ...i, key: { summary: 1 } })), ['operation_id_unique']],
      ['vaga ativa sem filtro parcial', trocar('active_operation_per_conversation', ({ partialFilterExpression, ...i }) => i), ['active_operation_per_conversation']],
      ['vaga ativa com outro filtro parcial', trocar('active_operation_per_conversation', (i) => ({ ...i, partialFilterExpression: { activeSlot: { $exists: true } } })), ['active_operation_per_conversation']],
      ['vaga ativa com filtro parcial a mais', trocar('active_operation_per_conversation', (i) => ({ ...i, partialFilterExpression: { activeSlot: true, status: 'pending' } })), ['active_operation_per_conversation']],
      ['vaga ativa com campos em outra ordem', trocar('active_operation_per_conversation', (i) => ({ ...i, key: { conversationId: 1, ownerId: 1 } })), ['active_operation_per_conversation']],
      ['vaga ativa sem unique', trocar('active_operation_per_conversation', (i) => ({ ...i, unique: false })), ['active_operation_per_conversation']],
      ['vaga ativa com collation que muda a comparacao', trocar('active_operation_per_conversation', (i) => ({ ...i, collation: { locale: 'pt', strength: 1 } })), ['active_operation_per_conversation']],
      ['TTL ausente', (ix) => ix.filter((i) => i.name !== 'retain_until_ttl'), ['retain_until_ttl']],
      ['TTL com expireAfterSeconds diferente de 0', trocar('retain_until_ttl', (i) => ({ ...i, expireAfterSeconds: 3600 })), ['retain_until_ttl']],
      ['TTL virou indice comum', trocar('retain_until_ttl', ({ expireAfterSeconds, ...i }) => i), ['retain_until_ttl']],
      ['TTL parcial', trocar('retain_until_ttl', (i) => ({ ...i, partialFilterExpression: { status: 'completed' } })), ['retain_until_ttl']],
      ['nenhum indice alem do _id', () => [{ v: 2, key: { _id: 1 }, name: '_id_' }], ['operation_id_unique', 'active_operation_per_conversation', 'retain_until_ttl']],
    ];
    test.each(QUEBRAS)('%s: recusa com operation_indexes_missing, sem tocar a colecao', async (_rotulo, quebrar, faltando) => {
      fake.db.indexes = quebrar(deepClone(INDICES_OK));
      await expect(tentarCriar()).rejects.toMatchObject({
        name: 'AssistantOperationUnavailableError', code: 'operation_indexes_missing', missing: faltando,
      });
      expect(fake.db.calls).toEqual([]);
      expect(fake.db.rows).toEqual([]);
    });

    test('indice correto com outro nome vale; {$eq: true} no filtro parcial tambem', async () => {
      fake.db.indexes = INDICES_OK.map((index) => ({
        ...index,
        name: `${index.name}_v2`,
        ...(index.partialFilterExpression ? { partialFilterExpression: { activeSlot: { $eq: true } } } : {}),
      }));
      expect((await tentarCriar()).ok).toBe(true);
    });

    test('erro ao consultar os indices (ex.: colecao inexistente): recusa e confere de novo depois', async () => {
      fake.hooks.failIndexes = Object.assign(new Error('ns does not exist'), { code: 26 });
      await expect(tentarCriar()).rejects.toMatchObject({ code: 'operation_indexes_unavailable' });
      await expect(tentarCriar()).rejects.toMatchObject({ code: 'operation_indexes_unavailable' });
      fake.hooks.failIndexes = null;
      expect((await tentarCriar()).ok).toBe(true);
      expect(fake.db.listIndexesCalls).toBe(3); // falha nunca fica em cache
      expect(fake.db.rows).toHaveLength(1);
    });

    test('sem conexao (desconectado, conectando ou verificacao com erro): database_unavailable sem consultar indices', async () => {
      for (const readyState of [0, 2, 3]) {
        fake.db.readyState = readyState;
        await expect(tentarCriar()).rejects.toMatchObject({ code: 'database_unavailable' });
      }
      const quebrado = createAssistantOperationService({
        Model: fake.Model, now: () => new Date(clock.now), config: configFromEnv({}), isConnected: () => { throw new Error('x'); },
      });
      await expect(quebrado.getCurrent({ ownerId: OWNER_A, conversationId: CONV })).rejects.toMatchObject({ code: 'database_unavailable' });
      expect(fake.db.listIndexesCalls).toBe(0);
      expect(fake.db.calls).toEqual([]);
    });

    test('todas as funcoes publicas recusam enquanto nao ha prontidao (nenhum sucesso presumido)', async () => {
      fake.db.indexes = [];
      const alvo = { ownerId: OWNER_A, conversationId: CONV, operationId: '1a2b3c4d-5e6f-4a1b-8c2d-3e4f5a6b7c8d' };
      const token = '9d8c7b6a-5f4e-4d3c-8b2a-1f0e9d8c7b6a';
      for (const chamada of [
        () => tentarCriar(),
        () => service.getCurrent({ ownerId: OWNER_A, conversationId: CONV }),
        () => service.claim(alvo),
        () => service.complete({ ...alvo, claimToken: token, outcome: 'completed' }),
        () => service.recordRetry({ ...alvo, claimToken: token }),
        () => service.cancel(alvo),
        () => service.expire(alvo),
        () => service.getResult(alvo),
      ]) {
        await expect(chamada()).rejects.toBeInstanceOf(AssistantOperationUnavailableError);
      }
      expect(fake.db.calls).toEqual([]);
    });
  });

  describe('invariante activeSlot sem depender do falso (banco so com os indices unicos)', () => {
    // strictDoc desligado: o falso nao valida mais o documento apos o update (como o MongoDB). Quem detecta erro de
    // activeSlot aqui e o estado gravado (vaga livre/ocupada) e a checagem de todas as linhas no afterEach.
    beforeEach(() => { fake.hooks.strictDoc = false; });
    const slot = (op) => rowOf(op.operationId).activeSlot;
    const novaNaConversa = () => service.create({ ownerId: OWNER_A, conversationId: CONV, ...STATUS_CMD });

    test('pending, executing e retry_pending ocupam a vaga; completed a libera', async () => {
      const op = await createPending();
      expect(slot(op)).toBe(true);
      let claim = await service.claim(ids(op));
      expect(slot(op)).toBe(true);
      expect((await novaNaConversa()).reason).toBe('conversation_busy');
      await service.recordRetry({ ...ids(op), claimToken: claim.operation.claimToken });
      expect(rowOf(op.operationId)).toMatchObject({ status: 'retry_pending', activeSlot: true });
      expect((await novaNaConversa()).reason).toBe('conversation_busy');
      claim = await service.claim(ids(op));
      expect(rowOf(op.operationId)).toMatchObject({ status: 'executing', activeSlot: true });
      await service.complete({ ...ids(op), claimToken: claim.operation.claimToken, outcome: 'completed' });
      expect(slot(op)).toBeUndefined();
      expect((await novaNaConversa()).ok).toBe(true);
    });

    test.each(['failed', 'unknown'])('conclusao %s libera a vaga', async (outcome) => {
      const op = await createPending();
      const claim = await service.claim(ids(op));
      await service.complete({ ...ids(op), claimToken: claim.operation.claimToken, outcome });
      expect(rowOf(op.operationId)).toMatchObject({ status: outcome });
      expect(slot(op)).toBeUndefined();
      expect((await novaNaConversa()).ok).toBe(true);
    });

    test('cancelamento e expiracao (manual e ao criar) liberam a vaga', async () => {
      const cancelada = await createPending();
      await service.cancel(ids(cancelada));
      expect(slot(cancelada)).toBeUndefined();
      const expirada = await createPending();
      advance(121 * SECOND);
      await service.expire(ids(expirada));
      expect(slot(expirada)).toBeUndefined();
      const vencida = await createPending();
      advance(121 * SECOND);
      expect((await novaNaConversa()).ok).toBe(true); // a criacao assenta a vencida antes de inserir
      expect(rowOf(vencida.operationId)).toMatchObject({ status: 'expired' });
      expect(slot(vencida)).toBeUndefined();
    });

    test('unknown por janela encerrada ou tentativas esgotadas libera a vaga', async () => {
      const janela = await createPending();
      const claim = await service.claim(ids(janela));
      await service.recordRetry({ ...ids(janela), claimToken: claim.operation.claimToken });
      advance(13 * MINUTE);
      await service.getCurrent({ ownerId: OWNER_A, conversationId: CONV });
      expect(rowOf(janela.operationId)).toMatchObject({ status: 'unknown', result: { code: 'recovery_window_elapsed' } });
      expect(slot(janela)).toBeUndefined();
      const esgotada = await createPending();
      for (let n = 0; n < MAX_CLAIMS; n += 1) {
        await service.claim(ids(esgotada));
        advance(181 * SECOND);
      }
      expect((await novaNaConversa()).ok).toBe(true);
      expect(rowOf(esgotada.operationId)).toMatchObject({ status: 'unknown', result: { code: 'attempts_exhausted' } });
      expect(slot(esgotada)).toBeUndefined();
    });

    test('reforco M8: pending que perdeu activeSlot (inconsistencia) nao entra em executing: o indice parcial recusa o claim', async () => {
      const a = await createPending();
      const chaveA = rowOf(a.operationId).idempotencyKey;
      try {
        // Inconsistencia preexistente simulada no banco: A continua pending, mas sem a vaga.
        delete rowOf(a.operationId).activeSlot;
        // B ocupa a vaga legitimamente (o indice parcial so enxerga quem tem activeSlot: true).
        const b = await service.create({ ownerId: OWNER_A, conversationId: CONV, commandKey: 'timer', params: { task_id: TASK_ID, acao: 'iniciar' }, summary: 'iniciar o cronômetro' });
        expect(b.ok).toBe(true);
        const bAntes = deepClone(rowOf(b.operation.operationId));

        let resultado;
        let erro;
        try {
          resultado = await service.claim(ids(a));
        } catch (err) {
          erro = err;
        }
        // O claim de A tentaria gravar activeSlot: true: o indice unico parcial recusa (E11000 propagado nesta etapa
        // isolada; o mapeamento HTTP fica para a 6A.2B). Nunca um claim bem-sucedido.
        expect(resultado).toBeUndefined();
        expect(erro).toMatchObject({ code: 11000, keyPattern: { ownerId: 1, conversationId: 1 } });
        const linhaA = rowOf(a.operationId);
        expect(linhaA).toMatchObject({ status: 'pending', attempts: 0, idempotencyKey: chaveA });
        expect(linhaA.claimToken).toBeUndefined();
        expect(linhaA.leaseUntil).toBeUndefined();
        expect(fake.db.rows.filter((row) => row.status === 'executing')).toEqual([]);
        expect(rowOf(b.operation.operationId)).toEqual(bAntes); // B intacta
      } finally {
        // Limpa a inconsistencia artificial (A encerrada, sem vaga) para nao contaminar o afterEach nem outros testes.
        const linhaA = rowOf(a.operationId);
        Object.assign(linhaA, { status: 'cancelled' });
        ['activeSlot', 'claimToken', 'leaseUntil'].forEach((campo) => delete linhaA[campo]);
      }
    });

    test('reforco M9: quarto claim recusado pelo filtro, sem depender do max: 3 do schema', async () => {
      // strictDoc desligado (beforeEach do bloco): o falso nao valida mais o documento inteiro, como o MongoDB, onde
      // o $inc nao passa pelos validadores de update. Quem barra o quarto claim e so o filtro attempts < 3.
      expect(fake.hooks.strictDoc).toBe(false);
      const op = await createPending();
      const chave = rowOf(op.operationId).idempotencyKey;
      const tokens = [];
      for (let n = 1; n <= MAX_CLAIMS; n += 1) {
        const claim = await service.claim(ids(op));
        expect(claim.ok).toBe(true);
        expect(claim.operation).toMatchObject({ attempts: n, idempotencyKey: chave });
        tokens.push(claim.operation.claimToken);
        advance(181 * SECOND); // vence o lease
      }
      const quarta = await service.claim(ids(op));
      expect(quarta).toMatchObject({
        ok: false, reason: 'terminal', operation: { status: 'unknown', attempts: MAX_CLAIMS, result: { code: 'attempts_exhausted' } },
      });
      expect(quarta.operation).not.toHaveProperty('claimToken');
      expect(quarta.operation).not.toHaveProperty('idempotencyKey');
      const linha = rowOf(op.operationId);
      expect(linha).toMatchObject({ status: 'unknown', attempts: MAX_CLAIMS, idempotencyKey: chave });
      expect(linha.claimToken).toBeUndefined();
      expect(linha.activeSlot).toBeUndefined();
      // Nenhum claimToken anterior conclui, e nenhuma nova tentativa aparece.
      for (const token of tokens) {
        expect((await service.complete({ ...ids(op), claimToken: token, outcome: 'completed' })).ok).toBe(false);
      }
      expect(await service.claim(ids(op))).toMatchObject({ ok: false, reason: 'terminal' });
      expect(rowOf(op.operationId)).toMatchObject({ status: 'unknown', attempts: MAX_CLAIMS, idempotencyKey: chave });
    });

    test('formato: toda transicao terminal remove activeSlot; toda transicao entre ativos o grava como true', async () => {
      const a = await createPending();
      let claim = await service.claim(ids(a));
      await service.recordRetry({ ...ids(a), claimToken: claim.operation.claimToken });
      claim = await service.claim(ids(a));
      await service.complete({ ...ids(a), claimToken: claim.operation.claimToken, outcome: 'completed' });
      const b = await createPending();
      await service.cancel(ids(b));
      const updates = fake.db.calls.filter((c) => c.op === 'findOneAndUpdate').map((c) => c.update);
      updates.forEach((update) => {
        const status = update.$set && update.$set.status;
        if (['completed', 'failed', 'cancelled', 'expired', 'unknown'].includes(status)) {
          expect(update.$unset).toHaveProperty('activeSlot');
          expect(update.$set).not.toHaveProperty('activeSlot');
        } else {
          expect(update.$set.activeSlot).toBe(true);
          expect(update.$unset || {}).not.toHaveProperty('activeSlot');
        }
      });
    });
  });

  describe('contrato com os sete comandos de escrita do assistente Python', () => {
    const TEAM_ID = 'd'.repeat(24);
    const USER_ID = 'e'.repeat(24);
    // Parametros como o prepare_write entrega (valores ja resolvidos, sempre texto), sem os rotulos _*.
    const CASOS = [
      ['create_team', { nome: 'equipe de vendas' }],
      ['create_task', { nome: 'Relatório', descricao: 'Detalhar custos', dataEntrega: '2026-12-01', urgencia: 'media', equipe: TEAM_ID, user: '__none__' }],
      ['create_task', { nome: 'Relatório', descricao: 'Detalhar custos', dataEntrega: '2026-12-01', urgencia: 'alta', equipe: TEAM_ID, user: USER_ID }],
      ['create_task', { nome: 'Relatório', dataEntrega: '2026-12-01', urgencia: 'baixa', equipe: TEAM_ID }],
      ['add_comment', { task_id: TASK_ID, texto: 'x'.repeat(2000) }],
      ['add_subtask', { task_id: TASK_ID, descricao: 'Revisar planilha' }],
      ['assign_to_me', { task_id: TASK_ID }], // selecao na lista: so a tarefa
      ['assign_to_me', { team_id: TEAM_ID, task_id: TASK_ID }], // frase completa: equipe e tarefa
      ['update_status', { task_id: TASK_ID, status: 'em_andamento' }],
      ['timer', { task_id: TASK_ID, acao: 'pausar' }],
    ];
    test.each(CASOS)('%s: cria e o claim devolve exatamente os parametros para executar', async (commandKey, params) => {
      const summary = commandKey === 'add_comment'
        ? `comentar na tarefa "${'Tarefa com nome longo '.repeat(20)} (equipe Vendas)": "${params.texto}"` // ~2470 caracteres
        : `resumo de ${commandKey}`;
      const created = await service.create({ ownerId: OWNER_A, conversationId: CONV, commandKey, params, summary });
      expect(created.ok).toBe(true);
      expect(created.operation.summary).toBe(summary); // guardado sem cortes
      const claim = await service.claim(ids(created.operation));
      expect(claim.operation.params).toEqual(params);
    });

    test('rotulos internos e chaves extras sao recusados (o assistente precisa enviar so o executavel)', async () => {
      for (const [commandKey, params] of [
        ['update_status', { task_id: TASK_ID, status: 'concluido', _task_label: 'Relatório' }],
        ['create_task', { nome: 'R', dataEntrega: '2026-12-01', urgencia: 'media', equipe: TEAM_ID, _team_label: 'Vendas', _user_label: 'Ana' }],
        ['update_status', { task_id: TASK_ID, status: 'concluido', team_id: TEAM_ID }],
        ['timer', { task_id: TASK_ID, acao: 'pausar', q: 'x' }],
      ]) {
        await expect(service.create({ ownerId: OWNER_A, conversationId: CONV, commandKey, params, summary: 's' }))
          .rejects.toMatchObject({ code: 'params_invalid' });
      }
    });

    test('valores ainda nao resolvidos sao recusados: nome no lugar do ID, data em texto livre, status sem normalizar', async () => {
      for (const [commandKey, params] of [
        ['update_status', { task_id: 'Relatório mensal', status: 'concluido' }],
        ['create_task', { nome: 'R', dataEntrega: 'dia vinte', urgencia: 'media', equipe: TEAM_ID }],
        ['update_status', { task_id: TASK_ID, status: 'concluída' }],
        ['create_task', { nome: 'R', dataEntrega: '2026-12-01', urgencia: 'média', equipe: TEAM_ID }],
        ['create_task', { nome: 'R', dataEntrega: '2026-12-01', urgencia: 'media', equipe: TEAM_ID, user: 'para mim' }],
      ]) {
        await expect(service.create({ ownerId: OWNER_A, conversationId: CONV, commandKey, params, summary: 's' }))
          .rejects.toMatchObject({ code: 'params_invalid' });
      }
    });

    test('resumo: ate 4000 caracteres guardado inteiro; acima disso recusado', async () => {
      const ok = await service.create({ ownerId: OWNER_A, conversationId: CONV, ...STATUS_CMD, summary: 'r'.repeat(4000) });
      expect(ok.ok).toBe(true);
      await expect(service.create({ ownerId: OWNER_A, conversationId: 'web', ...STATUS_CMD, summary: 'r'.repeat(4001) }))
        .rejects.toMatchObject({ code: 'summary_invalid' });
    });
  });
});
