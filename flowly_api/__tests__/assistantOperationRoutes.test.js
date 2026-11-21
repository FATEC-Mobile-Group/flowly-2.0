// /api/assistant/operations (rotas internas de confirmacao do assistente): app real, auth e sessionGuard reais.
// Simulados: User (sessao), o model AssistantOperation (banco em memoria) e o relogio (so o Date).
// O falso de AssistantOperation usa o model REAL para validar a criacao e converter filtros/updates (strict,
// immutable), compara e aplica sem await no meio (atomico) e aplica os indices unicos, inclusive o parcial da
// vaga ativa. Como no MongoDB, nao valida o documento inteiro apos um update. Nenhuma conexao real, nenhum indice.
const request = require('supertest');
const express = require('express');
const mongoose = require('mongoose');

jest.setTimeout(30000);

const mockDb = {
  users: [], rows: [], calls: [], seq: 0, userCalls: 0, userError: null,
  indexes: null, readyState: 1, listIndexesCalls: 0,
};
const mockHooks = { beforeAtomic: null, fail: null, failIndexes: null };
const mockSame = (a, b) => a != null && b != null && String(a) === String(b);
// ObjectId pelo tipo BSON: o app carregado com isolateModules usa outra instancia do mongoose (instanceof falharia).
const mockIsObjectId = (value) => Boolean(value) && value._bsontype === 'ObjectId';
const mockClone = (value) => {
  if (value instanceof Date) return new Date(value.getTime());
  if (mockIsObjectId(value)) return value.toHexString();
  if (value && typeof value.toObject === 'function' && value.$__) return mockClone(value.toObject());
  if (Array.isArray(value)) return value.map(mockClone);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, mockClone(item)]));
  }
  return value;
};
const mockComparable = (value) => {
  if (value instanceof Date) return value.getTime();
  if (mockIsObjectId(value)) return value.toHexString();
  return value;
};
const mockIsOperator = (cond) => cond !== null && typeof cond === 'object' && !(cond instanceof Date)
  && !(mockIsObjectId(cond)) && Object.keys(cond).some((key) => key.startsWith('$'));
const mockEq = (value, cond) => {
  if (cond === null) return value === null || value === undefined;
  if (value === null || value === undefined) return false;
  return String(mockComparable(value)) === String(mockComparable(cond));
};
const mockField = (value, cond) => {
  if (!mockIsOperator(cond)) return mockEq(value, cond);
  return Object.entries(cond).every(([op, arg]) => {
    const v = mockComparable(value);
    const a = mockComparable(arg);
    if (op === '$lt') return value != null && v < a;
    if (op === '$lte') return value != null && v <= a;
    if (op === '$gt') return value != null && v > a;
    if (op === '$gte') return value != null && v >= a;
    throw new Error(`operador nao suportado no teste: ${op}`);
  });
};
const mockMatches = (row, filter) => Object.entries(filter).every(([key, cond]) => (
  key === '$or' ? cond.some((branch) => mockMatches(row, branch)) : mockField(row[key], cond)
));
const mockProject = (row, selected) => {
  const copy = mockClone(row);
  ['idempotencyKey', 'claimToken'].forEach((name) => {
    if (!String(selected || '').includes(`+${name}`)) delete copy[name];
  });
  return copy;
};
const mockStep = async (op, info) => {
  mockDb.calls.push({ op, ...info });
  if (mockHooks.beforeAtomic) await mockHooks.beforeAtomic(op, info);
  const failure = mockHooks.fail && mockHooks.fail(op, info);
  if (failure) throw failure;
};
const mockDuplicate = (keyPattern, name) =>
  Object.assign(new Error(`E11000 duplicate key error index: ${name}`), { code: 11000, keyPattern });
const mockCheckUnique = (candidate, ignore) => {
  const others = mockDb.rows.filter((row) => row !== ignore);
  if (others.some((row) => row.operationId === candidate.operationId)) throw mockDuplicate({ operationId: 1 }, 'operation_id_unique');
  if (candidate.activeSlot === true && others.some((row) => row.activeSlot === true
    && row.ownerId === candidate.ownerId && row.conversationId === candidate.conversationId)) {
    throw mockDuplicate({ ownerId: 1, conversationId: 1 }, 'active_operation_per_conversation');
  }
};

jest.mock('@google-cloud/storage', () => ({
  Storage: jest.fn().mockImplementation(() => ({ bucket: jest.fn().mockReturnValue({ file: jest.fn() }) })),
}));
jest.mock('../services/storage', () => {
  const bucket = { file: jest.fn() };
  bucket.getSignedUrl = jest.fn(async (path) => (path ? `https://storage.test/${path}?X-Goog-Signature=sig` : ''));
  bucket.getObjectPath = jest.fn();
  bucket.verifyFileAccessToken = jest.fn();
  return bucket;
});
jest.mock('../utils/sendEmail', () => jest.fn().mockResolvedValue(true));
jest.mock('../models/User', () => ({
  // sessionGuard: User.findById(id, 'tipo authVersion')
  findById: jest.fn((id) => ({
    then: (resolve, reject) => Promise.resolve().then(() => {
      mockDb.userCalls += 1;
      if (mockDb.userError) throw mockDb.userError;
      const user = mockDb.users.find((item) => mockSame(item._id, id));
      return user ? { tipo: user.tipo, authVersion: user.authVersion } : null;
    }).then(resolve, reject),
  })),
  find: jest.fn(() => ({ then: (resolve) => resolve([]) })),
  findOne: jest.fn(() => ({ then: (resolve) => resolve(null) })),
}));

jest.mock('../models/AssistantOperation', () => {
  const Real = jest.requireActual('../models/AssistantOperation');
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
  const fake = {
    create: jest.fn(async (data) => {
      const doc = new Real(data);
      await doc.validate(); // schema real (inclui o gancho de invariantes)
      await mockStep('create', { data });
      const row = mockClone(doc.toObject({ versionKey: false }));
      row.ownerId = String(row.ownerId);
      mockCheckUnique(row);
      row.createdAt = new Date();
      row.updatedAt = new Date();
      mockDb.seq += 1;
      row._seq = mockDb.seq;
      mockDb.rows.push(row);
      return { toObject: () => mockProject(row, '+idempotencyKey +claimToken') };
    }),
    findOne: jest.fn((filter) => chain(async ({ selected, sort }) => {
      const query = Real.findOne(filter);
      query.cast(Real);
      const casted = query.getFilter();
      await mockStep('findOne', { filter });
      let rows = mockDb.rows.filter((row) => mockMatches(row, casted));
      if (sort) rows = [...rows].sort((a, b) => b.createdAt - a.createdAt || b._seq - a._seq);
      return rows[0] ? mockProject(rows[0], selected) : null;
    })),
    findOneAndUpdate: jest.fn((filter, update, options) => chain(async ({ selected }) => {
      const query = Real.findOneAndUpdate(filter, update, options);
      query.cast(Real);
      const casted = query.getFilter();
      const castUpdate = query._castUpdate(query._update);
      await mockStep('findOneAndUpdate', { filter, update });
      // Atomico: comparar e aplicar sem await no meio.
      const row = mockDb.rows.find((item) => mockMatches(item, casted));
      if (!row) return null;
      const next = mockClone(row);
      Object.entries(castUpdate.$set || {}).forEach(([path, value]) => { next[path] = mockClone(value); });
      Object.keys(castUpdate.$unset || {}).forEach((path) => { delete next[path]; });
      Object.entries(castUpdate.$inc || {}).forEach(([path, amount]) => { next[path] = (next[path] || 0) + amount; });
      next.updatedAt = new Date();
      mockCheckUnique(next, row);
      Object.keys(row).forEach((key) => delete row[key]);
      Object.assign(row, next);
      return mockProject(row, selected);
    })),
    listIndexes: jest.fn(async () => {
      mockDb.listIndexesCalls += 1;
      if (mockHooks.failIndexes) throw mockHooks.failIndexes;
      return mockClone(mockDb.indexes);
    }),
  };
  Object.defineProperty(fake, 'db', { get: () => ({ readyState: mockDb.readyState }) });
  Object.keys(Real).filter((name) => /^[A-Z0-9_]+$/.test(name) || name === 'invariantViolations').forEach((name) => {
    fake[name] = Real[name];
  });
  return fake;
});

const { issueAuthToken } = require('../utils/faceAuth');

const SECRET = `segredo-interno-de-teste-${'s'.repeat(32)}`;
const HEADER = 'X-Assistant-Operations-Secret';
const BASE = '/api/assistant/operations';
const CONV = 'voice-aaaa-1732100000000';
const TASK_ID = 'c'.repeat(24);
const T0 = Date.parse('2026-11-21T12:00:00.000Z');
const SECOND = 1000;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const OUTRO_ID = '1a2b3c4d-5e6f-4a1b-8c2d-3e4f5a6b7c8d';
const NAO_FALSIFICAR_ALEM_DE_DATE = [
  'hrtime', 'nextTick', 'performance', 'queueMicrotask', 'requestAnimationFrame', 'cancelAnimationFrame',
  'requestIdleCallback', 'cancelIdleCallback', 'setImmediate', 'clearImmediate', 'setInterval', 'clearInterval',
  'setTimeout', 'clearTimeout',
];
const PUBLIC_KEYS = ['attempts', 'commandKey', 'conversationId', 'createdAt', 'expiresAt', 'operationId',
  'paramsFingerprint', 'recoverUntil', 'result', 'status', 'summary', 'updatedAt'];
const CLAIM_KEYS = [...PUBLIC_KEYS, 'claimToken', 'idempotencyKey', 'leaseUntil', 'params', 'recovery'].sort();
const INDICES_OK = [
  { v: 2, key: { _id: 1 }, name: '_id_' },
  { v: 2, key: { operationId: 1 }, name: 'operation_id_unique', unique: true },
  { v: 2, key: { ownerId: 1, conversationId: 1 }, name: 'active_operation_per_conversation', unique: true, partialFilterExpression: { activeSlot: true } },
  { v: 2, key: { ownerId: 1, conversationId: 1, createdAt: -1 }, name: 'owner_conversation_recent' },
  { v: 2, key: { retainUntil: 1 }, name: 'retain_until_ttl', expireAfterSeconds: 0 },
];
const STATUS_BODY = {
  conversationId: CONV,
  commandKey: 'update_status',
  params: { task_id: TASK_ID, status: 'concluido' },
  summary: 'mudar o status da tarefa "Relatório" para concluída',
};

const loadApp = () => {
  let app;
  jest.isolateModules(() => {
    app = require('../app');
  });
  return app;
};
const waitFor = async (predicate, label) => {
  const deadline = performance.now() + 5000;
  while (!predicate()) {
    if (performance.now() > deadline) throw new Error(`tempo esgotado esperando: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
};

describe('/api/assistant/operations', () => {
  let app;
  let userA;
  let userB;
  let tokenA;
  let tokenB;

  const call = (method, path, { token = tokenA, secret = SECRET, body, query } = {}) => {
    let req = request(app)[method](`${BASE}${path}`);
    if (token !== null) req = req.set('Authorization', `Bearer ${token}`);
    if (secret !== null) req = req.set(HEADER, secret);
    if (query) req = req.query(query);
    return body !== undefined ? req.send(body) : req;
  };
  const criar = (body = STATUS_BODY, opts = {}) => call('post', '/', { body, ...opts });
  const claim = (id, opts = {}) => call('post', `/${id}/claim`, { body: { conversationId: CONV }, ...opts });
  const complete = (id, claimToken, outcome = 'completed', extra = {}) =>
    call('post', `/${id}/complete`, { body: { conversationId: CONV, claimToken, outcome, ...extra } });
  const resultado = (id, opts = {}) => call('get', `/${id}/result`, { query: { conversationId: CONV }, ...opts });
  const advance = (ms) => jest.setSystemTime(Date.now() + ms);
  const rowOf = (operationId) => mockDb.rows.find((row) => row.operationId === operationId);
  const collide = async (op, count, runs) => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    let paused = 0;
    mockHooks.beforeAtomic = async (name) => {
      if (name === op && paused < count) {
        paused += 1;
        await gate;
      }
    };
    const pending = runs.map((run) => run().then((response) => response));
    try {
      await waitFor(() => paused === count, `${count} chamadas de ${op} paradas`);
    } finally {
      mockHooks.beforeAtomic = null;
      release();
    }
    return Promise.all(pending);
  };

  beforeAll(() => {
    app = loadApp();
  });

  beforeEach(() => {
    jest.useFakeTimers({ doNotFake: NAO_FALSIFICAR_ALEM_DE_DATE, now: T0 });
    Object.assign(mockDb, {
      users: [], rows: [], calls: [], seq: 0, userCalls: 0, userError: null,
      indexes: mockClone(INDICES_OK), readyState: 1, listIndexesCalls: 0,
    });
    Object.assign(mockHooks, { beforeAtomic: null, fail: null, failIndexes: null });
    process.env.ASSISTANT_OPERATIONS_SECRET = SECRET;
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'log').mockImplementation(() => {});
    userA = { _id: 'a'.repeat(24), tipo: 'user', authVersion: 0 };
    userB = { _id: 'b'.repeat(24), tipo: 'admin', authVersion: 0 };
    mockDb.users.push(userA, userB);
    tokenA = issueAuthToken(userA);
    tokenB = issueAuthToken(userB);
  });

  afterEach(() => {
    // Nada sensivel nos logs: nem segredo, nem JWT, nem claimToken/idempotencyKey.
    const logs = JSON.stringify(console.error.mock.calls.concat(console.warn.mock.calls, console.log.mock.calls));
    expect(logs).not.toContain(SECRET);
    expect(logs).not.toContain(tokenA);
    mockDb.rows.forEach((row) => {
      expect(logs).not.toContain(row.idempotencyKey);
      if (row.claimToken) expect(logs).not.toContain(row.claimToken);
    });
    // Nunca uma conexao real.
    expect(mongoose.connection.readyState).toBe(0);
    delete process.env.ASSISTANT_OPERATIONS_SECRET;
    mockHooks.beforeAtomic = null;
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  describe('autenticacao: segredo interno + JWT + sessao atual (1 a 10)', () => {
    const CASOS = [
      ['1. sem JWT', () => ({ token: null }), 401],
      ['2. JWT invalido', () => ({ token: 'nao-e-um-jwt' }), 401],
      ['2b. JWT assinado com outra chave', () => ({ token: require('jsonwebtoken').sign({ id: userA._id, tipo: 'user', av: 0 }, 'x'.repeat(40)) }), 401],
      ['3. sessao revogada (authVersion mudou)', () => { userA.authVersion = 1; return {}; }, 401],
      ['4. usuario inexistente', () => { mockDb.users.splice(0, 1); return {}; }, 401],
      ['5. papel alterado depois do login', () => { userA.tipo = 'admin'; return {}; }, 401],
      ['10. segredo valido, JWT invalido', () => ({ token: `${tokenA}x` }), 401],
    ];
    test.each(CASOS)('%s: recusa sem acessar o servico de operacoes', async (_rotulo, preparar, status) => {
      const opts = preparar();
      const response = await criar(STATUS_BODY, opts);
      expect(response.status).toBe(status);
      expect(response.body.ok).not.toBe(true);
      expect(mockDb.calls).toEqual([]);
      expect(mockDb.listIndexesCalls).toBe(0);
      expect(mockDb.rows).toEqual([]);
    });

    test('6. sem segredo configurado: 503 fail-closed, antes do JWT e do banco', async () => {
      for (const valor of [undefined, '', '   ']) {
        if (valor === undefined) delete process.env.ASSISTANT_OPERATIONS_SECRET;
        else process.env.ASSISTANT_OPERATIONS_SECRET = valor;
        const response = await criar();
        expect([response.status, response.body]).toEqual([503, { ok: false, code: 'assistant_operations_not_configured' }]);
      }
      expect(mockDb.userCalls).toBe(0);
      expect(mockDb.calls).toEqual([]);
    });

    test('6b. segredo configurado curto demais: 503 fail-closed, mesmo com o cabecalho igual, sem expor o valor', async () => {
      const curtos = ['a', 'segredo-fraco', 'x'.repeat(32), 'y'.repeat(42)];
      for (const curto of curtos) {
        process.env.ASSISTANT_OPERATIONS_SECRET = curto;
        const response = await criar(STATUS_BODY, { secret: curto });
        expect([response.status, response.body]).toEqual([503, { ok: false, code: 'assistant_operations_not_configured' }]);
      }
      expect(mockDb.userCalls).toBe(0);
      expect(mockDb.calls).toEqual([]);
      const logs = JSON.stringify(console.error.mock.calls);
      ['segredo-fraco', 'x'.repeat(32), 'y'.repeat(42)].forEach((valor) => expect(logs).not.toContain(valor));
    });

    test('6c. segredo com tamanho adequado (32 bytes aleatorios em base64url, base64 ou hex; 43 no minimo): aceito', async () => {
      const crypto = require('crypto');
      const segredos = [
        crypto.randomBytes(32).toString('base64url'), // 43
        crypto.randomBytes(32).toString('base64'), // 44
        crypto.randomBytes(32).toString('hex'), // 64
        'k'.repeat(43), // exatamente o minimo
      ];
      for (const segredo of segredos) {
        expect(segredo.length).toBeGreaterThanOrEqual(43);
        process.env.ASSISTANT_OPERATIONS_SECRET = segredo;
        const ok = await call('get', '/current', { secret: segredo, query: { conversationId: CONV } });
        expect([ok.status, ok.body]).toEqual([200, { ok: true, operation: null }]);
        const errado = await call('get', '/current', { secret: `${segredo.slice(0, -1)}#`, query: { conversationId: CONV } });
        expect([errado.status, errado.body]).toEqual([401, { ok: false, code: 'assistant_secret_invalid' }]);
      }
      const logs = JSON.stringify(console.error.mock.calls.concat(console.log.mock.calls));
      segredos.forEach((segredo) => expect(logs).not.toContain(segredo));
    });

    test.each([
      ['7. segredo incorreto', `${SECRET}x`],
      ['7b. segredo com tamanho diferente', 'curto'],
      ['8. segredo ausente', null],
      ['8b. segredo vazio', ''],
      ['9. JWT valido com segredo de outro servico', 'segredo-do-analytics'],
    ])('%s: 401 antes de autenticar o usuario e de tocar o banco', async (_rotulo, secret) => {
      const response = await criar(STATUS_BODY, { secret });
      expect([response.status, response.body]).toEqual([401, { ok: false, code: 'assistant_secret_invalid' }]);
      expect(mockDb.userCalls).toBe(0);
      expect(mockDb.calls).toEqual([]);
    });

    test('Cache-Control: no-store em todas as respostas das rotas internas, inclusive recusas e erros', async () => {
      const criada = await criar(); // 201
      const { operationId } = criada.body.operation;
      const respostas = [
        criada,
        await call('get', '/current', { query: { conversationId: CONV } }), // 200
        await claim(operationId), // 200 (privada)
        await claim(operationId), // 409 em andamento
        await call('get', `/${OUTRO_ID}/result`, { query: { conversationId: CONV } }), // 404
        await call('post', `/${operationId}/cancel`, { body: { conversationId: CONV, extra: 1 } }), // 400
        await criar(STATUS_BODY, { secret: null }), // 401 credencial
        await criar(STATUS_BODY, { token: null }), // 401 JWT
        await call('get', '/rota-inexistente', {}), // 404 do app, dentro do prefixo
      ];
      delete process.env.ASSISTANT_OPERATIONS_SECRET;
      respostas.push(await criar()); // 503 sem segredo configurado
      expect(respostas.map((r) => r.status)).toEqual([201, 200, 200, 409, 404, 400, 401, 401, 404, 503]);
      respostas.forEach((response) => expect(response.headers['cache-control']).toBe('no-store'));
    });

    test('banco de usuarios fora do ar: 503 (sessao nao validada nao libera a rota)', async () => {
      mockDb.userError = Object.assign(new Error('conexao'), { name: 'MongoNetworkError' });
      const response = await criar();
      expect(response.status).toBe(503);
      expect(mockDb.calls).toEqual([]);
    });

    test('todas as rotas exigem segredo e JWT (inclusive consultas)', async () => {
      const id = OUTRO_ID;
      const rotas = [
        ['post', '/', STATUS_BODY], ['get', '/current', undefined, { conversationId: CONV }],
        ['get', `/${id}/result`, undefined, { conversationId: CONV }], ['post', `/${id}/claim`, { conversationId: CONV }],
        ['post', `/${id}/complete`, { conversationId: CONV }], ['post', `/${id}/retry`, { conversationId: CONV }],
        ['post', `/${id}/cancel`, { conversationId: CONV }],
      ];
      for (const [method, path, body, query] of rotas) {
        expect((await call(method, path, { body, query, secret: null })).status).toBe(401);
        expect((await call(method, path, { body, query, token: null })).status).toBe(401);
      }
      expect(mockDb.calls).toEqual([]);
    });
  });

  describe('fluxo, identidade e respostas', () => {
    test('13. criacao: 201 so com campos publicos; dono vem do JWT; sem cache', async () => {
      const response = await criar();
      expect(response.status).toBe(201);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.body.ok).toBe(true);
      expect(Object.keys(response.body.operation).sort()).toEqual(PUBLIC_KEYS);
      expect(response.body.operation).toMatchObject({ status: 'pending', attempts: 0, commandKey: 'update_status', conversationId: CONV, result: null });
      expect(response.body.operation.operationId).toMatch(UUID_V4);
      const row = rowOf(response.body.operation.operationId);
      expect(row.ownerId).toBe(userA._id);
      expect(JSON.stringify(response.body)).not.toContain(row.idempotencyKey);
    });

    test('14. duas criacoes simultaneas na mesma conversa: uma 201, outra 409 conversation_busy', async () => {
      const [r1, r2] = await collide('create', 2, [() => criar(), () => criar({ ...STATUS_BODY, commandKey: 'timer', params: { task_id: TASK_ID, acao: 'iniciar' }, summary: 'iniciar' })]);
      expect([r1.status, r2.status].sort()).toEqual([201, 409]);
      const busy = [r1, r2].find((r) => r.status === 409);
      expect(busy.body).toMatchObject({ ok: false, code: 'conversation_busy', operation: { status: 'pending' } });
      expect(Object.keys(busy.body.operation).sort()).toEqual(PUBLIC_KEYS);
      expect(mockDb.rows).toHaveLength(1);
    });

    test('15. claim: 200 com a resposta privada (params, idempotencyKey, claimToken) e no-store', async () => {
      const { operationId } = (await criar()).body.operation;
      const response = await claim(operationId);
      expect(response.status).toBe(200);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(Object.keys(response.body.claim).sort()).toEqual(CLAIM_KEYS);
      expect(response.body.claim).toMatchObject({
        status: 'executing', attempts: 1, recovery: false, params: STATUS_BODY.params,
        idempotencyKey: rowOf(operationId).idempotencyKey, claimToken: rowOf(operationId).claimToken,
      });
      expect(response.body.claim.idempotencyKey).toMatch(UUID_V4);
      // A consulta comum continua sem os campos privados.
      const atual = await call('get', '/current', { query: { conversationId: CONV } });
      expect(Object.keys(atual.body.operation).sort()).toEqual(PUBLIC_KEYS);
    });

    test('16. dois claims simultaneos: um 200, outro 409 operation_in_progress com Retry-After', async () => {
      const { operationId } = (await criar()).body.operation;
      const [r1, r2] = await collide('findOneAndUpdate', 2, [() => claim(operationId), () => claim(operationId)]);
      expect([r1.status, r2.status].sort()).toEqual([200, 409]);
      const perdedor = [r1, r2].find((r) => r.status === 409);
      expect(perdedor.body).toMatchObject({ ok: false, code: 'operation_in_progress' });
      expect(perdedor.headers['retry-after']).toBe('5');
      expect(perdedor.body.operation).not.toHaveProperty('claimToken');
      expect(rowOf(operationId).attempts).toBe(1);
    });

    test('17. claim depois da expiracao: 410 operation_expired', async () => {
      const { operationId } = (await criar()).body.operation;
      advance(121 * SECOND);
      const response = await claim(operationId);
      expect([response.status, response.body.code, response.body.operation.status]).toEqual([410, 'operation_expired', 'expired']);
    });

    test('18 e 19. lease ativo: 409; lease vencido: recuperacao com a mesma idempotencyKey e nova ficha', async () => {
      const { operationId } = (await criar()).body.operation;
      const primeiro = (await claim(operationId)).body.claim;
      advance(100 * SECOND);
      const ativo = await claim(operationId);
      expect([ativo.status, ativo.body.code, ativo.headers['retry-after']]).toEqual([409, 'operation_in_progress', '5']);
      advance(81 * SECOND);
      const recuperacao = await claim(operationId);
      expect(recuperacao.status).toBe(200);
      expect(recuperacao.body.claim).toMatchObject({ attempts: 2, recovery: true, idempotencyKey: primeiro.idempotencyKey });
      expect(recuperacao.body.claim.claimToken).not.toBe(primeiro.claimToken);
    });

    test('20 e 21. conclusao com claimToken incorreto ou do detentor antigo: 409 claim_lost; o atual conclui', async () => {
      const { operationId } = (await criar()).body.operation;
      const antigo = (await claim(operationId)).body.claim;
      expect((await complete(operationId, OUTRO_ID)).body).toMatchObject({ ok: false, code: 'claim_lost' });
      expect((await complete(operationId, 'nao-e-uuid')).body).toEqual({ ok: false, code: 'claim_token_invalid' });
      advance(181 * SECOND);
      const novo = (await claim(operationId)).body.claim;
      const doAntigo = await complete(operationId, antigo.claimToken);
      expect([doAntigo.status, doAntigo.body.code]).toEqual([409, 'claim_lost']);
      expect(doAntigo.body.operation).toMatchObject({ status: 'executing' });
      const doNovo = await complete(operationId, novo.claimToken, 'completed', { result: { httpStatus: 200, replayed: true } });
      expect(doNovo.status).toBe(200);
      expect(doNovo.body.operation).toMatchObject({ status: 'completed', result: { httpStatus: 200, replayed: true } });
    });

    test('22 e 23. cancelamento: pending -> 200; depois do claim -> 409 operation_in_progress', async () => {
      const a = (await criar()).body.operation;
      const cancel = await call('post', `/${a.operationId}/cancel`, { body: { conversationId: CONV } });
      expect([cancel.status, cancel.body.operation.status]).toEqual([200, 'cancelled']);
      const b = (await criar()).body.operation;
      await claim(b.operationId);
      const depois = await call('post', `/${b.operationId}/cancel`, { body: { conversationId: CONV } });
      expect([depois.status, depois.body.code]).toEqual([409, 'operation_in_progress']);
      expect(rowOf(b.operationId).status).toBe('executing');
    });

    test('24. resultados completed, failed e unknown: consulta 200; novo claim 409 com o codigo do estado', async () => {
      for (const [outcome, code] of [['completed', 'operation_completed'], ['failed', 'operation_failed'], ['unknown', 'operation_unknown']]) {
        const { operationId } = (await criar()).body.operation;
        const parcial = await resultado(operationId);
        expect([parcial.status, parcial.body.code, parcial.headers['retry-after']]).toEqual([409, 'operation_not_terminal', '2']);
        const { claimToken } = (await claim(operationId)).body.claim;
        expect((await complete(operationId, claimToken, outcome, { result: { httpStatus: outcome === 'completed' ? 200 : 409, code: 'teste' } })).status).toBe(200);
        const final = await resultado(operationId);
        expect([final.status, final.body.operation.status]).toEqual([200, outcome]);
        expect(Object.keys(final.body.operation).sort()).toEqual(PUBLIC_KEYS);
        advance(181 * SECOND);
        const reclaim = await claim(operationId);
        expect([reclaim.status, reclaim.body.code]).toEqual([409, code]); // unknown nunca autoriza executar de novo
      }
    });

    test('retry: retry_pending e recuperacao dentro da janela; depois das tentativas, unknown', async () => {
      const { operationId } = (await criar()).body.operation;
      let { claimToken } = (await claim(operationId)).body.claim;
      const retry = await call('post', `/${operationId}/retry`, { body: { conversationId: CONV, claimToken, result: { httpStatus: 503, code: 'transactions_unavailable' } } });
      expect([retry.status, retry.body.operation.status]).toEqual([200, 'retry_pending']);
      ({ claimToken } = (await claim(operationId)).body.claim);
      await call('post', `/${operationId}/retry`, { body: { conversationId: CONV, claimToken } });
      ({ claimToken } = (await claim(operationId)).body.claim);
      const fim = await call('post', `/${operationId}/retry`, { body: { conversationId: CONV, claimToken } });
      expect(fim.body.operation).toMatchObject({ status: 'unknown', attempts: 3, result: { code: 'attempts_exhausted' } });
    });

    test('11 e 12. outro usuario ou outra conversa: 404 igual ao inexistente, sem dados; nada muda', async () => {
      const { operationId } = (await criar()).body.operation;
      const { claimToken } = (await claim(operationId)).body.claim;
      advance(181 * SECOND); // lease vencido: se o dono nao fosse conferido, B assumiria
      const antes = mockClone(rowOf(operationId));
      const alvos = [
        [operationId, { token: tokenB }], [OUTRO_ID, { token: tokenB }], [OUTRO_ID, {}],
      ];
      const respostas = [];
      for (const [id, opts] of alvos) {
        for (const [method, path, body, query] of [
          ['get', `/${id}/result`, undefined, { conversationId: CONV }],
          ['post', `/${id}/claim`, { conversationId: CONV }],
          ['post', `/${id}/cancel`, { conversationId: CONV }],
          ['post', `/${id}/complete`, { conversationId: CONV, claimToken, outcome: 'completed' }],
          ['post', `/${id}/retry`, { conversationId: CONV, claimToken }],
        ]) {
          const response = await call(method, path, { body, query, ...opts });
          respostas.push([response.status, response.body]);
        }
      }
      // Conversa errada do proprio dono.
      const conversaErrada = await claim(operationId, { body: { conversationId: 'web' } });
      respostas.push([conversaErrada.status, conversaErrada.body]);
      respostas.forEach((par) => expect(par).toEqual([404, { ok: false, code: 'operation_not_found' }]));
      expect(rowOf(operationId)).toEqual(antes);
      const atualB = await call('get', '/current', { token: tokenB, query: { conversationId: CONV } });
      expect(atualB.body).toEqual({ ok: true, operation: null });
    });

    test('27. validacao estrita: campos desconhecidos (ownerId inclusive), ausentes, tipos e query', async () => {
      const casos = [
        [criar({ ...STATUS_BODY, ownerId: userB._id }), 'invalid_request'],
        [criar({ ...STATUS_BODY, userId: userB._id }), 'invalid_request'],
        [criar({ ...STATUS_BODY, status: 'executing' }), 'invalid_request'],
        [criar({ conversationId: CONV, commandKey: 'update_status', params: STATUS_BODY.params }), 'invalid_request'],
        [criar({ ...STATUS_BODY, conversationId: { $ne: null } }), 'invalid_request'],
        [criar({ ...STATUS_BODY, params: { ...STATUS_BODY.params, _task_label: 'x' } }), 'params_invalid'],
        [criar({ ...STATUS_BODY, commandKey: 'delete_task' }), 'command_invalid'],
        [criar({ ...STATUS_BODY, conversationId: '../../x' }), 'conversation_invalid'],
        [call('get', '/current', { query: { conversationId: CONV, extra: '1' } }), 'invalid_request'],
        [call('get', '/current', {}), 'invalid_request'],
        [call('get', '/current', { query: { 'conversationId[$ne]': 'x' } }), 'invalid_request'],
        [call('post', '/nao-e-uuid/claim', { body: { conversationId: CONV } }), 'operation_invalid'],
        [call('post', `/${OUTRO_ID}/claim`, { body: { conversationId: CONV, claimToken: OUTRO_ID } }), 'invalid_request'],
        [call('post', `/${OUTRO_ID}/complete`, { body: { conversationId: CONV, claimToken: OUTRO_ID, outcome: 'retry' } }), 'outcome_invalid'],
        [call('post', `/${OUTRO_ID}/complete`, { body: { conversationId: CONV, claimToken: OUTRO_ID, outcome: 'completed', result: { mensagem: 'x' } } }), 'result_invalid'],
        [call('post', `/${OUTRO_ID}/cancel`, { body: [] }), 'invalid_request'],
      ];
      for (const [pedido, code] of casos) {
        const response = await pedido;
        expect([response.status, response.body]).toEqual([400, { ok: false, code }]);
      }
      expect(mockDb.rows).toEqual([]);
    });

    test('26. o controller nao devolve documento bruto: servico com campos extras passa pela lista de campos', async () => {
      const Real = jest.requireActual('../models/AssistantOperation');
      const documento = new Real({
        operationId: OUTRO_ID, ownerId: userA._id, conversationId: CONV, commandKey: 'update_status',
        params: STATUS_BODY.params, summary: 'x', idempotencyKey: '9d8c7b6a-5f4e-4d3c-8b2a-1f0e9d8c7b6a',
        status: 'pending', activeSlot: true, attempts: 0, expiresAt: new Date(T0 + 1), recoverUntil: new Date(T0 + 2), retainUntil: new Date(T0 + 3),
      });
      const vazado = {
        ...documento.toObject(), _id: documento._id, __v: 0, ownerId: userA._id, activeSlot: true,
        claimToken: OUTRO_ID, token: tokenA, url: 'https://storage.test/a?X-Goog-Signature=x', params: { ...STATUS_BODY.params, segredo: SECRET },
        summary: documento, // ate um documento Mongoose num campo nao passa
      };
      const stub = {
        create: async () => ({ ok: true, operation: vazado }),
        getCurrent: async () => documento,
        getResult: async () => ({ ok: true, operation: vazado }),
        claim: async () => ({ ok: true, operation: vazado }),
        complete: async () => ({ ok: false, reason: 'claim_lost', operation: vazado }),
        recordRetry: async () => ({ ok: true, operation: vazado }),
        cancel: async () => ({ ok: true, operation: vazado }),
      };
      const { createAssistantOperationRouter } = require('../routes/assistantOperationRoutes');
      const mini = express().use(express.json()).use(BASE, createAssistantOperationRouter({ getService: () => stub }));
      const req = (method, path, body, query) => {
        let r = request(mini)[method](`${BASE}${path}`).set('Authorization', `Bearer ${tokenA}`).set(HEADER, SECRET);
        if (query) r = r.query(query);
        return body ? r.send(body) : r;
      };
      const publicas = [
        await req('post', '/', STATUS_BODY),
        await req('get', '/current', null, { conversationId: CONV }),
        await req('get', `/${OUTRO_ID}/result`, null, { conversationId: CONV }),
        await req('post', `/${OUTRO_ID}/complete`, { conversationId: CONV, claimToken: OUTRO_ID, outcome: 'completed' }),
        await req('post', `/${OUTRO_ID}/retry`, { conversationId: CONV, claimToken: OUTRO_ID }),
        await req('post', `/${OUTRO_ID}/cancel`, { conversationId: CONV }),
      ];
      publicas.forEach((response) => {
        const keys = Object.keys(response.body.operation).sort();
        keys.forEach((key) => expect(PUBLIC_KEYS).toContain(key));
        const texto = JSON.stringify(response.body);
        // Chaves exatas (entre aspas) e valores sensiveis.
        ['"idempotencyKey"', '"claimToken"', '"ownerId"', '"_id"', '"__v"', '"activeSlot"', '"params"', '"token"', '"url"', SECRET, tokenA, 'X-Goog']
          .forEach((proibido) => expect(texto).not.toContain(proibido));
      });
      const privada = await req('post', `/${OUTRO_ID}/claim`, { conversationId: CONV });
      expect(Object.keys(privada.body.claim).sort().every((key) => CLAIM_KEYS.includes(key))).toBe(true);
      expect(privada.body.claim.params).toEqual(STATUS_BODY.params); // chave extra 'segredo' descartada
      const textoPrivado = JSON.stringify(privada.body);
      ['"ownerId"', '"_id"', '"__v"', '"activeSlot"', '"segredo"', '"token"', '"url"', tokenA, SECRET, 'X-Goog']
        .forEach((proibido) => expect(textoPrivado).not.toContain(proibido));
      expect(privada.body.claim).not.toHaveProperty('summary'); // documento Mongoose num campo escalar e descartado
    });
  });

  describe('falhas de banco e prontidao (25 e 28)', () => {
    test('25. sem conexao ou indices: 503 com codigo estavel; Retry-After so quando esperar resolve', async () => {
      const casos = [
        [() => { mockDb.readyState = 0; }, 'database_unavailable', '5'],
        [() => { mockHooks.failIndexes = Object.assign(new Error('ns does not exist'), { code: 26 }); }, 'operation_indexes_unavailable', '5'],
        [() => { mockDb.indexes = INDICES_OK.filter((i) => i.name !== 'active_operation_per_conversation'); }, 'operation_indexes_missing', undefined],
      ];
      for (const [quebrar, code, retryAfter] of casos) {
        app = loadApp(); // servico novo: a prontidao fica em cache por instancia
        Object.assign(mockDb, { readyState: 1, indexes: mockClone(INDICES_OK) });
        mockHooks.failIndexes = null;
        quebrar();
        const response = await criar();
        expect([response.status, response.body]).toEqual([503, { ok: false, code }]);
        expect(response.headers['retry-after']).toBe(retryAfter);
        expect(mockDb.rows).toEqual([]);
      }
      Object.assign(mockDb, { readyState: 1, indexes: mockClone(INDICES_OK) });
      app = loadApp();
    });

    test('28. falha do banco: 500 sem sucesso falso e sem detalhes; nada muda', async () => {
      const { operationId } = (await criar()).body.operation;
      const antes = mockClone(mockDb.rows);
      const erro = Object.assign(new Error(`conexao perdida ${SECRET}`), { name: 'MongoNetworkError' });
      mockHooks.fail = (op) => (op === 'findOneAndUpdate' ? erro : null);
      for (const pedido of [
        () => claim(operationId),
        () => call('post', `/${operationId}/cancel`, { body: { conversationId: CONV } }),
        () => call('get', '/current', { query: { conversationId: CONV } }),
        () => criar({ ...STATUS_BODY, conversationId: 'web' }),
      ]) {
        const response = await pedido();
        expect([response.status, response.body]).toEqual([500, { ok: false, code: 'internal_error' }]);
      }
      mockHooks.fail = (op) => (op === 'findOne' ? erro : null);
      expect((await resultado(operationId)).status).toBe(500);
      mockHooks.fail = null;
      expect(mockDb.rows).toEqual(antes);
      expect(console.error).toHaveBeenCalledWith(expect.stringContaining('[assistant-operations]'), 'MongoNetworkError');
    });

    test('indice unico recusando o claim (invariante quebrada no banco): 409 operation_state_conflict, nunca sucesso', async () => {
      const a = (await criar()).body.operation;
      delete rowOf(a.operationId).activeSlot; // inconsistencia: A pending sem vaga
      const b = await criar({ ...STATUS_BODY, commandKey: 'timer', params: { task_id: TASK_ID, acao: 'iniciar' }, summary: 'iniciar' });
      expect(b.status).toBe(201);
      try {
        const response = await claim(a.operationId);
        expect([response.status, response.body]).toEqual([409, { ok: false, code: 'operation_state_conflict' }]);
        expect(rowOf(a.operationId)).toMatchObject({ status: 'pending', attempts: 0 });
      } finally {
        Object.assign(rowOf(a.operationId), { status: 'cancelled' });
      }
    });
  });
});
