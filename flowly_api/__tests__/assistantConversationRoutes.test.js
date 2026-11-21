// /api/assistant/conversations (contexto compartilhado das conversas do assistente): app real, auth e sessionGuard
// reais. Simulados: User (sessao), o model AssistantConversation (banco em memoria) e o relogio (so o Date).
// O falso usa o model REAL para validar a criacao e converter filtros/updates (strict, immutable), compara e aplica
// sem await no meio (atomico por documento) e aplica o indice unico (ownerId, conversationId). Nenhuma conexao real,
// nenhum indice criado.
const request = require('supertest');
const mongoose = require('mongoose');

jest.setTimeout(30000);

const mockDb = {
  users: [], rows: [], calls: [], userError: null, indexes: null, readyState: 1, listIndexesCalls: 0,
};
const mockHooks = { beforeAtomic: null, failIndexes: null };
const mockSame = (a, b) => a != null && b != null && String(a) === String(b);
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
const mockField = (value, cond) => {
  if (!mockIsOperator(cond)) {
    if (value === null || value === undefined) return cond === null;
    return String(mockComparable(value)) === String(mockComparable(cond));
  }
  return Object.entries(cond).every(([op, arg]) => {
    const v = mockComparable(value);
    const a = mockComparable(arg);
    if (op === '$lte') return value != null && v <= a;
    if (op === '$gt') return value != null && v > a;
    throw new Error(`operador nao suportado no teste: ${op}`);
  });
};
const mockMatches = (row, filter) => Object.entries(filter).every(([key, cond]) => mockField(row[key], cond));
const mockStep = async (op, info) => {
  mockDb.calls.push({ op, ...info });
  if (mockHooks.beforeAtomic) await mockHooks.beforeAtomic(op, info);
};
const mockCheckUnique = (candidate, ignore) => {
  if (mockDb.rows.some((row) => row !== ignore && row.ownerId === candidate.ownerId
    && row.conversationId === candidate.conversationId)) {
    throw Object.assign(new Error('E11000 duplicate key error index: owner_conversation_unique'),
      { code: 11000, keyPattern: { ownerId: 1, conversationId: 1 } });
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
  findById: jest.fn((id) => ({
    then: (resolve, reject) => Promise.resolve().then(() => {
      if (mockDb.userError) throw mockDb.userError;
      const user = mockDb.users.find((item) => mockSame(item._id, id));
      return user ? { tipo: user.tipo, authVersion: user.authVersion } : null;
    }).then(resolve, reject),
  })),
  find: jest.fn(() => ({ then: (resolve) => resolve([]) })),
  findOne: jest.fn(() => ({ then: (resolve) => resolve(null) })),
}));

jest.mock('../models/AssistantConversation', () => {
  const Real = jest.requireActual('../models/AssistantConversation');
  const lean = (run) => ({ lean: () => run() });
  const castFilter = (filter) => {
    const query = Real.findOne(filter);
    query.cast(Real);
    return query.getFilter();
  };
  const fake = {
    create: jest.fn(async (data) => {
      const doc = new Real(data);
      await doc.validate();
      await mockStep('create', { data });
      const row = mockClone(doc.toObject({ versionKey: false }));
      row.ownerId = String(row.ownerId);
      mockCheckUnique(row);
      row.createdAt = new Date();
      row.updatedAt = new Date();
      mockDb.rows.push(row);
      return { toObject: () => mockClone(row) };
    }),
    findOne: jest.fn((filter) => lean(async () => {
      const casted = castFilter(filter);
      await mockStep('findOne', { filter });
      const row = mockDb.rows.find((item) => mockMatches(item, casted));
      return row ? mockClone(row) : null;
    })),
    findOneAndUpdate: jest.fn((filter, update, options) => lean(async () => {
      const query = Real.findOneAndUpdate(filter, update, options);
      query.cast(Real);
      const casted = query.getFilter();
      const castUpdate = query._castUpdate(query._update);
      await mockStep('findOneAndUpdate', { filter, update });
      const row = mockDb.rows.find((item) => mockMatches(item, casted)); // atomico: sem await daqui em diante
      if (!row) return null;
      const next = mockClone(row);
      Object.entries(castUpdate.$set || {}).forEach(([path, value]) => { next[path] = mockClone(value); });
      Object.entries(castUpdate.$inc || {}).forEach(([path, amount]) => { next[path] = (next[path] || 0) + amount; });
      next.updatedAt = new Date();
      Object.keys(row).forEach((key) => delete row[key]);
      Object.assign(row, next);
      return mockClone(row);
    })),
    deleteOne: jest.fn(async (filter) => {
      const casted = castFilter(filter);
      await mockStep('deleteOne', { filter });
      const index = mockDb.rows.findIndex((item) => mockMatches(item, casted));
      if (index < 0) return { deletedCount: 0 };
      mockDb.rows.splice(index, 1);
      return { deletedCount: 1 };
    }),
    listIndexes: jest.fn(async () => {
      mockDb.listIndexesCalls += 1;
      if (mockHooks.failIndexes) throw mockHooks.failIndexes;
      return mockClone(mockDb.indexes);
    }),
  };
  Object.defineProperty(fake, 'db', { get: () => ({ readyState: mockDb.readyState }) });
  fake.CONVERSATION_ID_PATTERN = Real.CONVERSATION_ID_PATTERN;
  return fake;
});

const { issueAuthToken } = require('../utils/faceAuth');
const {
  normalizeState,
  missingIndexes,
  STATE_MAX_BYTES,
} = require('../services/assistantConversationService');

const SECRET = `segredo-interno-de-teste-${'s'.repeat(32)}`;
const HEADER = 'X-Assistant-Operations-Secret';
const BASE = '/api/assistant/conversations';
const CONV = 'voice-aaaa-1732100000000';
const T0 = Date.parse('2026-11-21T12:00:00.000Z');
const SECOND = 1000;
const NAO_FALSIFICAR_ALEM_DE_DATE = [
  'hrtime', 'nextTick', 'performance', 'queueMicrotask', 'requestAnimationFrame', 'cancelAnimationFrame',
  'requestIdleCallback', 'cancelIdleCallback', 'setImmediate', 'clearImmediate', 'setInterval', 'clearInterval',
  'setTimeout', 'clearTimeout',
];
const INDICES_OK = [
  { v: 2, key: { _id: 1 }, name: '_id_' },
  { v: 2, key: { ownerId: 1, conversationId: 1 }, name: 'owner_conversation_unique', unique: true },
  { v: 2, key: { expiresAt: 1 }, name: 'conversation_expires_ttl', expireAfterSeconds: 0 },
];
const PARAMS_STATE = { command_key: 'create_task', params: { nome: 'Relatório semanal' }, missing: ['dataEntrega', 'urgencia'] };
const SELECTION_STATE = {
  mode: 'task_selection',
  tasks: [{ _id: '1'.repeat(24), descricao: 'Relatório final', status: 'pendente', urgencia: null, dataEntrega: null,
    equipe: { nome: 'Equipe Alfa' }, user: null }],
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

describe('/api/assistant/conversations', () => {
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
  const ler = (opts = {}) => call('get', '/current', { query: { conversationId: CONV }, ...opts });
  const gravar = (expectedVersion, state = PARAMS_STATE, opts = {}) =>
    call('put', '/current', { body: { conversationId: CONV, expectedVersion, state }, ...opts });
  const limpar = (expectedVersion, opts = {}) => call('post', '/current/clear', {
    body: expectedVersion === undefined ? { conversationId: CONV } : { conversationId: CONV, expectedVersion }, ...opts,
  });
  const advance = (ms) => jest.setSystemTime(Date.now() + ms);
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
      users: [], rows: [], calls: [], userError: null, indexes: mockClone(INDICES_OK), readyState: 1, listIndexesCalls: 0,
    });
    Object.assign(mockHooks, { beforeAtomic: null, failIndexes: null });
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
    const logs = JSON.stringify(console.error.mock.calls.concat(console.warn.mock.calls, console.log.mock.calls));
    expect(logs).not.toContain(SECRET);
    expect(logs).not.toContain(tokenA);
    expect(logs).not.toContain('Relatório'); // conteudo do contexto nunca vai para o log
    expect(mongoose.connection.readyState).toBe(0);
    delete process.env.ASSISTANT_OPERATIONS_SECRET;
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  describe('credenciais (10, 11)', () => {
    test.each([
      ['segredo ausente', { secret: null }, 401],
      ['segredo incorreto', { secret: `${SECRET}x` }, 401],
      ['sem JWT', { token: null }, 401],
      ['JWT invalido', { token: 'nao-e-um-jwt' }, 401],
    ])('%s: recusa sem tocar no banco', async (_rotulo, opts, status) => {
      for (const response of [await ler(opts), await gravar(0, PARAMS_STATE, opts), await limpar(undefined, opts)]) {
        expect(response.status).toBe(status);
        expect(response.body.ok).not.toBe(true);
      }
      expect(mockDb.calls).toEqual([]);
      expect(mockDb.listIndexesCalls).toBe(0);
    });

    test('segredo nao configurado no servidor: 503 sem tocar no banco', async () => {
      delete process.env.ASSISTANT_OPERATIONS_SECRET;
      const response = await ler();
      expect([response.status, response.body]).toEqual([503, { ok: false, code: 'assistant_operations_not_configured' }]);
      expect(mockDb.calls).toEqual([]);
    });

    test('sessao revogada ou papel alterado: 401 e o contexto fica intacto', async () => {
      expect((await gravar(0)).status).toBe(200);
      userA.authVersion = 1;
      expect((await ler()).status).toBe(401);
      expect((await limpar(undefined)).status).toBe(401);
      expect(mockDb.rows).toHaveLength(1);
    });

    test('ownerId/userId do corpo ou da query nunca vira identidade', async () => {
      expect((await call('get', '/current', { query: { conversationId: CONV, ownerId: userB._id } })).status).toBe(400);
      const forjado = await call('put', '/current', { body: { conversationId: CONV, expectedVersion: 0, state: PARAMS_STATE, userId: userB._id } });
      expect([forjado.status, forjado.body.code]).toEqual([400, 'invalid_request']);
      expect(mockDb.rows).toEqual([]);
    });
  });

  describe('leitura, gravacao e isolamento (3, 4)', () => {
    test('grava, le e versiona; a resposta nao traz dono nem documento do banco', async () => {
      expect((await ler()).body).toEqual({ ok: true, context: null });
      const salvo = await gravar(0);
      expect(salvo.status).toBe(200);
      expect(salvo.body.context).toEqual({ conversationId: CONV, version: 1, expiresAt: new Date(T0 + 900 * SECOND).toISOString(),
        updatedAt: expect.any(String) });
      const lido = await ler();
      expect(lido.body.context).toMatchObject({ conversationId: CONV, version: 1, state: PARAMS_STATE });
      expect(Object.keys(lido.body.context).sort()).toEqual(['conversationId', 'expiresAt', 'state', 'updatedAt', 'version']);
      expect(lido.headers['cache-control']).toBe('no-store');
      expect((await gravar(1, SELECTION_STATE)).body.context.version).toBe(2);
      expect((await ler()).body.context.state).toEqual(SELECTION_STATE);
    });

    test('dois usuarios no mesmo conversationId e duas conversas do mesmo usuario nao se misturam', async () => {
      await gravar(0, PARAMS_STATE);
      await gravar(0, SELECTION_STATE, { token: tokenB });
      await call('put', '/current', { body: { conversationId: 'web', expectedVersion: 0, state: SELECTION_STATE } });
      expect((await ler()).body.context.state).toEqual(PARAMS_STATE);
      expect((await ler({ token: tokenB })).body.context.state).toEqual(SELECTION_STATE);
      expect((await call('get', '/current', { query: { conversationId: 'web' } })).body.context.state).toEqual(SELECTION_STATE);
      // Limpar a de B nao toca na de A.
      expect((await limpar(undefined, { token: tokenB })).body).toEqual({ ok: true, cleared: true });
      expect((await ler()).body.context.state).toEqual(PARAMS_STATE);
      expect(mockDb.rows).toHaveLength(2);
    });
  });

  describe('concorrencia (5, 12)', () => {
    test('mensagem antiga (version lido antes) nao sobrescreve a nova: 409 com o version atual', async () => {
      await gravar(0);
      expect((await gravar(1, SELECTION_STATE)).status).toBe(200); // a mais nova
      const antiga = await gravar(1, PARAMS_STATE);
      expect([antiga.status, antiga.body]).toEqual([409, { ok: false, code: 'context_version_conflict', version: 2 }]);
      expect((await ler()).body.context).toMatchObject({ version: 2, state: SELECTION_STATE });
      const criarDeNovo = await gravar(0);
      expect([criarDeNovo.status, criarDeNovo.body.version]).toEqual([409, 2]);
    });

    test('duas gravacoes simultaneas com o mesmo version: so uma entra', async () => {
      await gravar(0);
      const respostas = await collide('findOneAndUpdate', 2, [() => gravar(1, SELECTION_STATE), () => gravar(1, PARAMS_STATE)]);
      expect(respostas.map((r) => r.status).sort()).toEqual([200, 409]);
      expect(mockDb.rows).toHaveLength(1);
      expect(mockDb.rows[0].version).toBe(2);
    });

    test('duas criacoes simultaneas: o indice unico deixa uma, a outra recebe conflito', async () => {
      const respostas = await collide('create', 2, [() => gravar(0, SELECTION_STATE), () => gravar(0, PARAMS_STATE)]);
      expect(respostas.map((r) => r.status).sort()).toEqual([200, 409]);
      expect(mockDb.rows).toHaveLength(1);
    });

    test('limpeza condicional remove so o version lido; a incondicional (standby) remove o que houver', async () => {
      await gravar(0);
      await gravar(1, SELECTION_STATE);
      const antiga = await limpar(1);
      expect([antiga.status, antiga.body.version]).toEqual([409, 2]);
      expect(mockDb.rows).toHaveLength(1);
      expect((await limpar(2)).body).toEqual({ ok: true, cleared: true });
      expect((await limpar(2)).body).toEqual({ ok: true, cleared: false }); // repetir e inofensivo
      await gravar(0);
      expect((await limpar(0)).status).toBe(409); // "nao havia nada", mas surgiu um vivo
      expect((await limpar(undefined)).body).toEqual({ ok: true, cleared: true });
    });
  });

  describe('expiracao (7)', () => {
    test('vencido e inexistente: leitura nula, version antigo recusado, recriacao com 0 reaproveita o documento', async () => {
      await gravar(0);
      advance(900 * SECOND);
      expect((await ler()).body.context).toBeNull();
      expect((await gravar(1)).status).toBe(409);
      const novo = await gravar(0, SELECTION_STATE);
      expect([novo.status, novo.body.context.version]).toEqual([200, 2]);
      expect(mockDb.rows).toHaveLength(1);
      expect(novo.body.context.expiresAt).toBe(new Date(T0 + 1800 * SECOND).toISOString());
    });
  });

  describe('validacao do conteudo (8)', () => {
    test.each([
      ['confirmacao local antiga', { mode: 'write_confirmation', command: 'create_team', params: {}, owner_id: 'x' }, 'state_invalid'],
      ['modo desconhecido', { mode: 'outro', tasks: [] }, 'state_invalid'],
      ['campo a mais', { ...PARAMS_STATE, idempotencyKey: 'x' }, 'state_invalid'],
      ['valor nao texto', { ...PARAMS_STATE, params: { nome: 7 } }, 'state_invalid'],
      ['tarefa com campo a mais', { ...SELECTION_STATE, tasks: [{ ...SELECTION_STATE.tasks[0], token: 'x' }] }, 'state_invalid'],
      ['mais de 10 tarefas', { mode: 'task_selection', tasks: Array(11).fill(SELECTION_STATE.tasks[0]) }, 'state_invalid'],
      ['JWT colado', { ...PARAMS_STATE, params: { texto: `eyJ${'a'.repeat(10)}.${'b'.repeat(10)}.${'c'.repeat(10)}` } }, 'state_sensitive'],
      ['chave de idempotencia', { ...PARAMS_STATE, params: { nota: '1a2b3c4d-5e6f-4a1b-8c2d-3e4f5a6b7c8d' } }, 'state_sensitive'],
      ['lista em vez de objeto', [PARAMS_STATE], 'state_invalid'],
    ])('%s: 400 e nada gravado', async (_rotulo, state, code) => {
      const response = await gravar(0, state);
      expect([response.status, response.body]).toEqual([400, { ok: false, code }]);
      expect(mockDb.rows).toEqual([]);
    });

    test('limite de tamanho e versao invalida', async () => {
      const grande = { command_key: 'add_comment', params: Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`p${i}`, 'x'.repeat(2000)])), missing: [] };
      expect((await gravar(0, grande)).body.code).toBe('state_too_large');
      for (const version of [-1, 1.5, '1', null]) {
        expect((await gravar(version)).status).toBe(400);
      }
      expect(mockDb.rows).toEqual([]);
      expect(STATE_MAX_BYTES).toBe(32 * 1024);
      expect(() => normalizeState(PARAMS_STATE)).not.toThrow();
    });
  });

  describe('banco e indices (9)', () => {
    beforeEach(() => {
      app = loadApp(); // servico novo: a prontidao fica em cache por instancia
    });
    afterAll(() => {
      app = loadApp();
    });

    test('sem conexao: 503 sem consultar indices', async () => {
      mockDb.readyState = 0;
      const response = await gravar(0);
      expect([response.status, response.body.code, response.headers['retry-after']]).toEqual([503, 'database_unavailable', '5']);
      expect(mockDb.listIndexesCalls).toBe(0);
      expect(mockDb.rows).toEqual([]);
    });

    test('indices ausentes ou incorretos: 503 e nada gravado; nunca cria indice', async () => {
      mockDb.indexes = [INDICES_OK[0], { ...INDICES_OK[1], unique: false }, INDICES_OK[2]];
      const response = await gravar(0);
      expect([response.status, response.body.code]).toEqual([503, 'context_indexes_missing']);
      expect(mockDb.rows).toEqual([]);
      expect(missingIndexes([INDICES_OK[0]])).toEqual(['owner_conversation_unique', 'conversation_expires_ttl']);
      expect(missingIndexes([{ ...INDICES_OK[2], expireAfterSeconds: 60 }, INDICES_OK[1]])).toEqual(['conversation_expires_ttl']);
    });

    test('falha ao listar indices: 503 temporario', async () => {
      mockHooks.failIndexes = new Error('rede');
      const response = await ler();
      expect([response.status, response.body.code]).toEqual([503, 'context_indexes_unavailable']);
    });
  });
});
