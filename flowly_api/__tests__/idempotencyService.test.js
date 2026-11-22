// Nucleo de idempotencia (services/idempotencyService.js): banco e transacao simulados em memoria.
// Nenhuma conexao real, nenhum indice criado. O falso de transacao imita o withTransaction do driver:
// repete o callback em TransientTransactionError, desfaz so o que a sessao gravou e pode falhar no commit
// (com ou sem a transacao ter entrado), para provar que a operacao real acontece no maximo uma vez.
const mongoose = require('mongoose');
const { matches } = require('./helpers/memoryModel');
const IdempotencyKey = require('../models/IdempotencyKey');
const {
  createIdempotencyService,
  hashRequest,
  normalizeKey,
  retentionMsFromEnv,
  leaseMsFromEnv,
  IdempotentRequestError,
} = require('../services/idempotencyService');

const USER_A = 'a'.repeat(24);
const USER_B = 'b'.repeat(24);
const KEY = '3f1c2b6e-8a4d-4c1b-9e2f-7a6b5c4d3e2f';
const KEY_2 = '9d8c7b6a-5f4e-4d3c-8b2a-1f0e9d8c7b6a';
const TEAM_ID = 'c'.repeat(24);
const HOUR = 3600 * 1000;

const labeled = (message, ...labels) => Object.assign(new Error(message), { errorLabels: labels });
const clone = (value) => structuredClone(value);

// ---------- Banco e transacao em memoria ----------
const createFakes = ({ supported = true, indexes } = {}) => {
  // locks: registro -> { session, promise, release }. Como no MongoDB, a escrita de uma transacao trava o
  // documento ate o commit/abort: escrita fora da transacao ESPERA; escrita de outra transacao recebe
  // WriteConflict (TransientTransactionError) e o withTransaction repete depois.
  const db = { keys: [], effects: [], seq: 0, txAttempts: 0, sessions: 0, locks: new Map(), waits: 0 };
  const state = {
    supported,
    indexes: indexes || [
      { key: { _id: 1 }, name: '_id_' },
      { key: { userId: 1, key: 1 }, name: 'user_key_unique', unique: true },
      { key: { expiresAt: 1 }, name: 'expires_at_ttl', expireAfterSeconds: 0 },
    ],
    commitPlan: [], // por chamada de commit: 'transient' | 'unknown_not_applied' | 'unknown_applied' | null
    beforeStart: null, // async () => {} antes de abrir a sessao (pausa uma tentativa antes da transacao)
    beforeWork: null, // async (attemptNumber) => {} para pausar uma transacao
    failStartSession: false,
    failCreateWith: null,
  };
  const newId = () => {
    db.seq += 1;
    return db.seq.toString(16).padStart(24, '0');
  };

  // Isolamento como no MongoDB: o que a sessao grava fica numa copia propria, invisivel fora dela ate o
  // commit; dentro dela, a propria escrita e lida (read-your-own-writes).
  const viewOf = (row, session) => (session && session.pending.has(row) ? session.pending.get(row) : row);
  const waitUnlocked = async (filter) => {
    const row = db.keys.find((item) => String(item._id) === String(filter._id));
    while (row && db.locks.has(row)) {
      db.waits += 1;
      await db.locks.get(row).promise;
    }
  };
  const lockFor = (row, session) => {
    const current = db.locks.get(row);
    if (current && current.session !== session) {
      const conflict = labeled('WriteConflict', 'TransientTransactionError');
      conflict.waitFor = current.promise;
      throw conflict;
    }
    if (!current) {
      let release;
      const promise = new Promise((resolve) => {
        release = resolve;
      });
      db.locks.set(row, { session, promise, release });
      session.locked.push(row);
    }
  };
  const releaseLocks = (session) => {
    session.locked.forEach((row) => {
      const lock = db.locks.get(row);
      if (lock && lock.session === session) {
        db.locks.delete(row);
        lock.release();
      }
    });
    session.locked = [];
  };
  const applyUpdate = (doc, update) => {
    Object.assign(doc, clone(update.$set || {}));
    Object.keys(update.$unset || {}).forEach((name) => delete doc[name]);
    Object.entries(update.$inc || {}).forEach(([name, amount]) => {
      doc[name] = (Number(doc[name]) || 0) + amount;
    });
  };
  const lean = (value) => ({ lean: async () => (value ? clone(value) : null) });

  const Model = {
    create: jest.fn(async (data) => {
      if (state.failCreateWith) throw state.failCreateWith;
      // Indice unico userId+key, como o do model.
      if (db.keys.some((row) => String(row.userId) === String(data.userId) && row.key === data.key)) {
        throw Object.assign(new Error('E11000 duplicate key error'), { code: 11000 });
      }
      const row = { _id: newId(), ...clone(data) };
      db.keys.push(row);
      return clone(row);
    }),
    findOne: jest.fn((filter) => lean(db.keys.find((row) => matches(row, filter)))),
    findOneAndUpdate: jest.fn((filter, update) => ({
      lean: async () => {
        await waitUnlocked(filter); // fora de transacao: espera a trava e so entao avalia o filtro
        const row = db.keys.find((item) => matches(item, filter));
        if (row) applyUpdate(row, update);
        return row ? clone(row) : null;
      },
    })),
    updateOne: jest.fn(async (filter, update, options = {}) => {
      const { session } = options;
      if (!session) await waitUnlocked(filter);
      const row = db.keys.find((item) => matches(viewOf(item, session), filter));
      if (row) {
        if (session) {
          lockFor(row, session);
          const copy = clone(viewOf(row, session));
          applyUpdate(copy, update);
          session.pending.set(row, copy);
        } else {
          applyUpdate(row, update);
        }
      }
      return { matchedCount: row ? 1 : 0, modifiedCount: row ? 1 : 0 };
    }),
    listIndexes: jest.fn(async () => {
      if (state.indexes instanceof Error) throw state.indexes;
      return clone(state.indexes);
    }),
  };

  // "Operacao real" (ex.: criar equipe): so existe se a transacao entrar.
  const createEffect = (data, session) => {
    if (!session) throw new Error('efeito fora da sessao');
    const row = { _id: newId(), ...data };
    session.effects.push(row);
    return row;
  };

  const rollback = (session) => {
    session.pending.clear();
    session.effects = [];
    releaseLocks(session);
  };
  const commit = (session) => {
    session.pending.forEach((copy, row) => {
      Object.keys(row).forEach((name) => delete row[name]);
      Object.assign(row, copy);
    });
    db.effects.push(...session.effects);
    rollback(session);
  };

  const transactions = {
    supportsTransactions: jest.fn(async () => {
      if (state.supported instanceof Error) throw state.supported;
      return state.supported;
    }),
    runInTransaction: jest.fn(async (work) => {
      if (state.beforeStart) await state.beforeStart();
      if (state.failStartSession) throw new Error('falha ao abrir sessao');
      for (let attempt = 1; attempt <= 5; attempt += 1) {
        db.sessions += 1;
        db.txAttempts += 1;
        const session = { id: db.sessions, pending: new Map(), effects: [], locked: [] };
        if (state.beforeWork) await state.beforeWork(attempt);
        let result;
        try {
          result = await work(session);
        } catch (err) {
          rollback(session); // abortTransaction
          if (attempt < 5 && err?.errorLabels?.includes('TransientTransactionError')) {
            if (err.waitFor) await err.waitFor; // o driver repete com espera; aqui, ate a trava sair
            continue;
          }
          throw err;
        }
        const plan = state.commitPlan.shift() || null;
        if (plan === 'transient') {
          rollback(session); // ex.: WriteConflict no commit: o driver repete o callback inteiro
          continue;
        }
        if (plan === 'unknown_not_applied') {
          rollback(session);
          throw labeled('commit sem resposta', 'UnknownTransactionCommitResult');
        }
        if (plan === 'unknown_applied') {
          // Transacao entrou, mas a confirmacao se perdeu na rede.
          commit(session);
          throw labeled('commit sem resposta', 'UnknownTransactionCommitResult');
        }
        commit(session);
        return result;
      }
      throw labeled('tentativas esgotadas', 'TransientTransactionError');
    }),
  };

  return { db, state, Model, transactions, createEffect };
};

const setup = (options = {}) => {
  const fakes = createFakes(options);
  let clock = new Date('2026-11-21T12:00:00.000Z').getTime();
  let tokens = 0;
  const logger = { error: jest.fn() };
  const service = createIdempotencyService({
    Model: fakes.Model,
    supportsTransactions: fakes.transactions.supportsTransactions,
    runInTransaction: fakes.transactions.runInTransaction,
    now: () => new Date(clock),
    newToken: () => {
      tokens += 1;
      return `00000000-0000-4000-8000-${String(tokens).padStart(12, '0')}`;
    },
    retentionMs: 168 * HOUR,
    leaseMs: 30 * 1000,
    logger,
  });
  const advance = (ms) => {
    clock += ms;
  };
  return { ...fakes, service, advance, logger };
};

const request = (overrides = {}) => ({
  userId: USER_A,
  key: KEY,
  method: 'POST',
  route: '/api/equipes',
  params: {},
  body: { nome: 'Marketing', membros: [] },
  ...overrides,
});

// Trabalho tipico: grava o efeito na sessao e devolve so o resumo (+ aviso pos-commit).
const createTeamWork = (fakes, extra = {}) => {
  const afterCommit = jest.fn();
  const work = jest.fn(async (session) => {
    const team = fakes.createEffect({ kind: 'team', nome: 'Marketing', by: extra.by || USER_A }, session);
    return { statusCode: 201, resourceType: 'equipe', resourceId: team._id, afterCommit, ...extra.result };
  });
  return { work, afterCommit };
};

describe('primeira execucao e repeticao', () => {
  test('chave valida: executa uma vez, grava o resumo e chama o afterCommit depois do commit', async () => {
    const fakes = setup();
    const { work, afterCommit } = createTeamWork(fakes);

    const response = await fakes.service.execute(request(), work);

    expect(response).toEqual({ outcome: 'executed', statusCode: 201, result: { resourceType: 'equipe', resourceId: fakes.db.effects[0]._id } });
    expect(work).toHaveBeenCalledTimes(1);
    expect(afterCommit).toHaveBeenCalledTimes(1);
    expect(fakes.db.effects).toHaveLength(1);
    const [record] = fakes.db.keys;
    expect(record).toMatchObject({ userId: USER_A, key: KEY, method: 'POST', route: '/api/equipes', status: 'completed', attempts: 1 });
    expect(record.result).toEqual({ statusCode: 201, resourceType: 'equipe', resourceId: fakes.db.effects[0]._id });
    expect(record.requestHash).toBe(hashRequest(request()));
  });

  test('mesma chave e mesmo pedido: devolve o mesmo resultado sem executar de novo', async () => {
    const fakes = setup();
    const first = createTeamWork(fakes);
    const executed = await fakes.service.execute(request(), first.work);
    const again = createTeamWork(fakes);

    for (let i = 0; i < 3; i += 1) {
      const replay = await fakes.service.execute(request({ key: KEY.toUpperCase() }), again.work);
      expect(replay).toEqual({ ...executed, outcome: 'replayed' });
    }
    expect(again.work).not.toHaveBeenCalled();
    expect(again.afterCommit).not.toHaveBeenCalled();
    expect(fakes.db.effects).toHaveLength(1);
  });

  test('mesma chave com parametros, corpo, rota ou metodo diferentes: 422 sem executar', async () => {
    const fakes = setup();
    await fakes.service.execute(request(), createTeamWork(fakes).work);
    const other = createTeamWork(fakes);
    for (const changed of [
      { body: { nome: 'Vendas', membros: [] } },
      { body: { nome: 'Marketing', membros: [USER_B] } },
      { params: { id: TEAM_ID } },
      { route: '/api/tarefas' },
      { method: 'PUT' },
    ]) {
      const response = await fakes.service.execute(request(changed), other.work);
      expect(response).toEqual({ outcome: 'conflict', statusCode: 422, code: 'idempotency_key_reused', retryable: false });
    }
    expect(other.work).not.toHaveBeenCalled();
    expect(fakes.db.effects).toHaveLength(1);
    expect(fakes.db.keys[0].status).toBe('completed');
  });

  test('hash canonico: ordem das chaves e undefined nao mudam; valores e tipos mudam', () => {
    const base = request({ body: { nome: 'X', membros: ['1'], extra: undefined } });
    expect(hashRequest(base)).toBe(hashRequest(request({ body: { membros: ['1'], nome: 'X' } })));
    expect(hashRequest(base)).not.toBe(hashRequest(request({ body: { nome: 'X', membros: [1] } })));
    expect(hashRequest(base)).not.toBe(hashRequest(request({ body: { nome: 'X ', membros: ['1'] } })));
    expect(hashRequest(request({ body: { id: new mongoose.Types.ObjectId(TEAM_ID) } }))).toBe(
      hashRequest(request({ body: { id: TEAM_ID } }))
    );
  });
});

describe('hash canonico com propriedades especiais', () => {
  // O corpo chega do express.json, que usa JSON.parse: "__proto__" vira propriedade propria, nao prototipo.
  const hashOf = (json) => hashRequest(request({ body: JSON.parse(json) }));

  test('regressao: {"nome":"Marketing"} e o mesmo com "__proto__" tem hashes diferentes', () => {
    expect(hashOf('{"nome":"Marketing"}')).not.toBe(hashOf('{"nome":"Marketing","__proto__":{"x":1}}'));
    expect(hashOf('{"nome":"Marketing","__proto__":{"x":1}}')).not.toBe(hashOf('{"nome":"Marketing","__proto__":{"x":2}}'));
    expect(hashOf('{"nome":"Marketing","__proto__":{"x":1}}')).not.toBe(hashOf('{"nome":"Marketing","x":1}'));
  });

  test('constructor, prototype, toJSON e hasOwnProperty contam como chaves comuns', () => {
    const plain = hashOf('{"nome":"Marketing"}');
    const seen = new Set([plain]);
    for (const name of ['__proto__', 'constructor', 'prototype', 'toJSON', 'hasOwnProperty', 'valueOf']) {
      for (const value of ['{"x":1}', '"texto"', '1', 'null']) {
        const hash = hashOf(`{"nome":"Marketing","${name}":${value}}`);
        expect(seen.has(hash)).toBe(false); // nenhum colide com outro nem com o pedido sem a chave
        seen.add(hash);
      }
    }
  });

  test('chaves especiais aninhadas e dentro de listas tambem contam', () => {
    for (const [a, b] of [
      ['{"equipe":{"nome":"A"}}', '{"equipe":{"nome":"A","__proto__":{"admin":true}}}'],
      ['{"membros":[{"id":"1"}]}', '{"membros":[{"id":"1","__proto__":{"id":"2"}}]}'],
      ['{"a":{"b":{"c":{}}}}', '{"a":{"b":{"c":{"constructor":{"prototype":{"x":1}}}}}}'],
      ['{"lista":[1,2]}', '{"lista":[1,2,{"__proto__":null}]}'],
    ]) {
      expect(hashOf(a)).not.toBe(hashOf(b));
    }
  });

  test('a ordem das propriedades continua sem importar, inclusive com chaves especiais', () => {
    expect(hashOf('{"__proto__":{"y":2,"x":1},"nome":"M","constructor":1}')).toBe(
      hashOf('{"constructor":1,"nome":"M","__proto__":{"x":1,"y":2}}')
    );
    expect(hashOf('{"a":[{"b":1,"__proto__":{"c":3}}]}')).toBe(hashOf('{"a":[{"__proto__":{"c":3},"b":1}]}'));
    expect(hashOf('{"a":[1,2]}')).not.toBe(hashOf('{"a":[2,1]}')); // ordem de listas importa, como no JSON
  });

  test('nenhum prototipo e alterado durante o calculo', () => {
    const body = JSON.parse('{"__proto__":{"poluido":true},"constructor":{"prototype":{"poluido":true}}}');
    hashRequest(request({ body }));
    expect({}.poluido).toBeUndefined();
    expect(Object.prototype.poluido).toBeUndefined();
    expect(Object.getPrototypeOf(body)).toBe(Object.prototype);
  });

  test('Date equivale a sua string ISO e nao colide com um objeto {"$date": ...}', () => {
    const iso = '2026-12-01T00:00:00.000Z';
    expect(hashRequest(request({ body: { quando: new Date(iso) } }))).toBe(hashRequest(request({ body: { quando: iso } })));
    expect(hashRequest(request({ body: { quando: new Date(iso) } }))).not.toBe(hashOf(`{"quando":{"$date":"${iso}"}}`));
  });

  test('getters (que nao vem do JSON) sao recusados em vez de executados', async () => {
    const fakes = setup();
    const getter = jest.fn(() => 'x');
    const body = Object.defineProperty({}, 'nome', { get: getter, enumerable: true });
    const response = await fakes.service.execute(request({ body }), createTeamWork(fakes).work);
    expect(response).toMatchObject({ outcome: 'invalid', code: 'idempotency_request_invalid' });
    expect(getter).not.toHaveBeenCalled();
  });
});

describe('validacao da chave e do pedido', () => {
  test('formato e tamanho invalidos sao recusados antes de tocar no banco', async () => {
    const fakes = setup();
    const { work } = createTeamWork(fakes);
    for (const key of [undefined, null, 123, '', 'abc', `${KEY} `, ` ${KEY}`, `${KEY}0`, KEY.slice(0, 35),
      '3f1c2b6e8a4d4c1b9e2f7a6b5c4d3e2f', '3f1c2b6e-8a4d-0c1b-9e2f-7a6b5c4d3e2f', '3f1c2b6e-8a4d-4c1b-7e2f-7a6b5c4d3e2f',
      'zzzzzzzz-8a4d-4c1b-9e2f-7a6b5c4d3e2f', 'x'.repeat(10000)]) {
      const response = await fakes.service.execute(request({ key }), work);
      expect(response).toEqual({ outcome: 'invalid', statusCode: 400, code: 'idempotency_key_invalid', retryable: false });
    }
    expect(normalizeKey(KEY.toUpperCase())).toBe(KEY);
    for (const [field, value, code] of [
      ['userId', 'nao-e-id', 'idempotency_user_invalid'],
      ['userId', 'aaaaaaaaaaaa', 'idempotency_user_invalid'],
      ['method', 'GET', 'idempotency_method_invalid'],
      ['route', 'api/equipes', 'idempotency_route_invalid'],
      ['route', '/api/equipes?x=1', 'idempotency_route_invalid'],
      ['body', { quando: new Date('invalida') }, 'idempotency_request_invalid'],
      ['body', { n: Number.NaN }, 'idempotency_request_invalid'],
      ['body', { f: () => 1 }, 'idempotency_request_invalid'],
      ['body', { m: new Map() }, 'idempotency_request_invalid'],
    ]) {
      const response = await fakes.service.execute(request({ [field]: value }), work);
      expect(response).toMatchObject({ outcome: 'invalid', statusCode: 400, code });
    }
    expect(fakes.Model.create).not.toHaveBeenCalled();
    expect(fakes.transactions.supportsTransactions).not.toHaveBeenCalled();
    expect(work).not.toHaveBeenCalled();
  });
});

describe('concorrencia', () => {
  test('duas requisicoes simultaneas: so uma executa; a outra recebe 409 em andamento', async () => {
    const fakes = setup();
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const slow = jest.fn(async (session) => {
      await gate;
      const team = fakes.createEffect({ kind: 'team' }, session);
      return { statusCode: 201, resourceType: 'equipe', resourceId: team._id };
    });
    const fast = createTeamWork(fakes);

    const first = fakes.service.execute(request(), slow);
    await new Promise((resolve) => setImmediate(resolve));
    const second = await fakes.service.execute(request(), fast.work);
    expect(second).toEqual({ outcome: 'in_progress', statusCode: 409, code: 'idempotency_in_progress', retryable: true });
    release();
    expect((await first).outcome).toBe('executed');
    expect((await fakes.service.execute(request(), fast.work)).outcome).toBe('replayed');
    expect(fast.work).not.toHaveBeenCalled();
    expect(fakes.db.effects).toHaveLength(1);
  });

  test('conflito do indice unico: a leitura seguinte decide (repete, espera ou 422), nunca executa duas vezes', async () => {
    const fakes = setup();
    await fakes.service.execute(request(), createTeamWork(fakes).work);
    const other = createTeamWork(fakes);
    // Insert concorrente perdeu a corrida (E11000) e o registro vencedor ja concluiu.
    expect((await fakes.service.execute(request(), other.work)).outcome).toBe('replayed');
    // E11000, mas o registro sumiu antes da leitura (retencao): nao arrisca executar.
    fakes.Model.findOne.mockImplementationOnce(() => ({ lean: async () => null }));
    expect((await fakes.service.execute(request(), other.work)).outcome).toBe('in_progress');
    // E11000 informado como writeErrors (insertMany/bulk).
    fakes.state.failCreateWith = Object.assign(new Error('bulk'), { writeErrors: [{ code: 11000 }] });
    expect((await fakes.service.execute(request(), other.work)).outcome).toBe('replayed');
    expect(other.work).not.toHaveBeenCalled();
    expect(fakes.db.effects).toHaveLength(1);
  });

  test('reserva vencida: outra tentativa assume e a antiga, ao voltar, e barrada pela cerca', async () => {
    const fakes = setup();
    let resumeOld;
    const oldPaused = new Promise((resolve) => {
      resumeOld = resolve;
    });
    fakes.state.beforeWork = jest.fn(async () => {
      fakes.state.beforeWork = null; // so a primeira transacao (a antiga) fica parada
      await oldPaused;
    });
    const oldWork = createTeamWork(fakes);
    const oldRun = fakes.service.execute(request(), oldWork.work);
    await new Promise((resolve) => setImmediate(resolve));

    fakes.advance(31 * 1000); // prazo de 30 s vencido: a tentativa antiga parece ter caido
    const newWork = createTeamWork(fakes);
    const takeover = await fakes.service.execute(request(), newWork.work);
    expect(takeover.outcome).toBe('executed');
    expect(fakes.db.keys[0].attempts).toBe(2);

    resumeOld();
    expect(await oldRun).toEqual({ outcome: 'in_progress', statusCode: 409, code: 'idempotency_in_progress', retryable: true });
    expect(oldWork.work).not.toHaveBeenCalled();
    expect(fakes.db.effects).toHaveLength(1);
    expect((await fakes.service.execute(request(), createTeamWork(fakes).work)).outcome).toBe('replayed');
  });

  test('tentativa antiga que falha depois de ser substituida nao sobrescreve o registro da nova', async () => {
    const fakes = setup();
    let resumeOld;
    const oldPaused = new Promise((resolve) => {
      resumeOld = resolve;
    });
    fakes.state.beforeStart = jest.fn(async () => {
      fakes.state.beforeStart = null; // so a antiga para (antes de abrir a sessao: nao segura trava)
      await oldPaused;
    });
    const oldWork = createTeamWork(fakes);
    const oldRun = fakes.service.execute(request(), oldWork.work);
    await new Promise((resolve) => setImmediate(resolve));
    fakes.advance(31 * 1000);
    expect((await fakes.service.execute(request(), createTeamWork(fakes).work)).outcome).toBe('executed');

    fakes.state.failStartSession = true; // a antiga volta e falha ao abrir a sessao
    resumeOld();
    expect((await oldRun).outcome).toBe('unavailable');
    fakes.state.failStartSession = false;
    // A marcacao da antiga e condicional a ficha dela: o registro da nova continua concluido.
    expect(fakes.db.keys[0]).toMatchObject({ status: 'completed', attempts: 2 });
    expect(fakes.db.keys[0].failure).toBeUndefined();
    expect((await fakes.service.execute(request(), createTeamWork(fakes).work)).outcome).toBe('replayed');
    expect(oldWork.work).not.toHaveBeenCalled();
    expect(fakes.db.effects).toHaveLength(1);
  });

  // Item 5 da revisao: transacao que passa do prazo de reserva e sofre uma tentativa concorrente de assumir.
  const pauseInsideWork = (fakes) => {
    let resume;
    const paused = new Promise((resolve) => {
      resume = resolve;
    });
    const work = jest.fn(async (session) => {
      await paused; // a cerca ja foi gravada na sessao: o registro esta travado por esta transacao
      const team = fakes.createEffect({ kind: 'team', by: 'antiga' }, session);
      return { statusCode: 201, resourceType: 'equipe', resourceId: team._id };
    });
    return { work, resume };
  };

  test('transacao lenta que entra depois do prazo: quem tenta assumir espera e nao executa de novo', async () => {
    const fakes = setup();
    const old = pauseInsideWork(fakes);
    const oldRun = fakes.service.execute(request(), old.work);
    await new Promise((resolve) => setImmediate(resolve));
    expect(old.work).toHaveBeenCalledTimes(1);

    fakes.advance(31 * 1000); // prazo de reserva vencido com a transacao antiga ainda aberta
    const newer = createTeamWork(fakes);
    let newerDone = false;
    const newerRun = fakes.service.execute(request(), newer.work).then((response) => {
      newerDone = true;
      return response;
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(newerDone).toBe(false); // a escrita de quem assume espera a trava da transacao antiga
    expect(fakes.db.waits).toBeGreaterThan(0);
    expect(newer.work).not.toHaveBeenCalled();

    old.resume();
    expect((await oldRun).outcome).toBe('executed'); // a antiga entra
    expect(await newerRun).toMatchObject({ outcome: 'in_progress', statusCode: 409 }); // e ninguem assume
    expect(newer.work).not.toHaveBeenCalled();
    expect(fakes.db.keys[0]).toMatchObject({ status: 'completed', attempts: 1 });
    expect((await fakes.service.execute(request(), createTeamWork(fakes).work)).outcome).toBe('replayed');
    expect(fakes.db.effects).toEqual([expect.objectContaining({ by: 'antiga' })]);
  });

  test('transacao lenta que aborta depois do prazo: a tentativa concorrente executa uma unica vez', async () => {
    const fakes = setup();
    let resume;
    const paused = new Promise((resolve) => {
      resume = resolve;
    });
    const oldWork = jest.fn(async (session) => {
      await paused;
      fakes.createEffect({ kind: 'parcial' }, session);
      throw new Error('falha interna');
    });
    const oldRun = fakes.service.execute(request(), oldWork);
    await new Promise((resolve) => setImmediate(resolve));
    fakes.advance(31 * 1000);
    const newer = createTeamWork(fakes, { by: 'nova' });
    const newerRun = fakes.service.execute(request(), newer.work);
    await new Promise((resolve) => setImmediate(resolve));
    expect(newer.work).not.toHaveBeenCalled();

    resume();
    expect((await oldRun).outcome).toBe('failed');
    let response = await newerRun;
    if (response.outcome === 'in_progress') {
      // A marcacao "failed retentavel" da antiga chegou antes da tomada: o cliente repete e entao executa.
      response = await fakes.service.execute(request(), newer.work);
    }
    expect(response.outcome).toBe('executed');
    expect(newer.work).toHaveBeenCalledTimes(1);
    expect(fakes.db.effects).toEqual([expect.objectContaining({ by: 'nova' })]);
    expect((await fakes.service.execute(request(), createTeamWork(fakes).work)).outcome).toBe('replayed');
  });

  test('duas transacoes no mesmo registro: a segunda recebe WriteConflict, repete e e barrada pela cerca', async () => {
    const fakes = setup();
    const old = pauseInsideWork(fakes);
    const oldRun = fakes.service.execute(request(), old.work);
    await new Promise((resolve) => setImmediate(resolve));
    // Ficha trocada por fora (como se outra tentativa tivesse assumido): a transacao nova bate na trava da
    // antiga, recebe WriteConflict e, ao repetir depois do commit, a cerca nao acha mais a ficha dela.
    const record = fakes.db.keys[0];
    const intruder = fakes.transactions.runInTransaction(async (session) => {
      const fenced = await fakes.Model.updateOne(
        { _id: record._id, status: 'in_progress', claimToken: record.claimToken }, { $set: { status: 'completed' } }, { session }
      );
      return fenced.matchedCount;
    });
    await new Promise((resolve) => setImmediate(resolve));
    old.resume();
    expect((await oldRun).outcome).toBe('executed');
    expect(await intruder).toBe(0); // repetiu depois do commit da antiga e nao encontrou o registro em andamento
    expect(fakes.db.effects).toHaveLength(1);
  });

  test('reserva ainda valida nao e assumida', async () => {
    const fakes = setup();
    fakes.state.failStartSession = true;
    await fakes.service.execute(request(), createTeamWork(fakes).work); // deixa failed retryable
    fakes.db.keys[0].status = 'in_progress';
    fakes.db.keys[0].lockedUntil = new Date(Date.parse('2026-11-21T12:00:20.000Z'));
    fakes.state.failStartSession = false;
    const work = createTeamWork(fakes).work;
    expect((await fakes.service.execute(request(), work)).outcome).toBe('in_progress');
    expect(work).not.toHaveBeenCalled();
  });
});

describe('falhas antes, durante e no commit da transacao', () => {
  test('banco sem suporte a transacoes (ou erro ao verificar): 503 e nada gravado', async () => {
    for (const supported of [false, new Error('hello falhou')]) {
      const fakes = setup({ supported });
      const { work } = createTeamWork(fakes);
      const response = await fakes.service.execute(request(), work);
      expect(response).toEqual({ outcome: 'unavailable', statusCode: 503, code: 'transactions_unavailable', retryable: true });
      expect(fakes.Model.create).not.toHaveBeenCalled();
      expect(work).not.toHaveBeenCalled();
      expect(fakes.db.keys).toHaveLength(0);
    }
  });

  test('sem o indice unico (ou colecao inexistente): 503 sem gravar; o servico nunca cria indices', async () => {
    for (const indexes of [[{ key: { _id: 1 }, name: '_id_' }], [{ key: { userId: 1, key: 1 }, name: 'x' }], new Error('ns not found')]) {
      const fakes = setup({ indexes });
      const { work } = createTeamWork(fakes);
      expect(await fakes.service.execute(request(), work)).toMatchObject({ outcome: 'unavailable', code: 'idempotency_unavailable' });
      expect(fakes.Model.create).not.toHaveBeenCalled();
      expect(work).not.toHaveBeenCalled();
    }
    expect(Object.keys(createFakes().Model)).not.toEqual(expect.arrayContaining(['createIndexes', 'syncIndexes', 'ensureIndexes']));
  });

  test('falha ao gravar a reivindicacao: 503 e o trabalho nao roda', async () => {
    const fakes = setup();
    fakes.state.failCreateWith = new Error('rede');
    const { work } = createTeamWork(fakes);
    expect(await fakes.service.execute(request(), work)).toMatchObject({ outcome: 'unavailable', statusCode: 503 });
    expect(work).not.toHaveBeenCalled();
  });

  test('falha antes de a transacao comecar: 503, chave liberada para nova tentativa que executa uma vez', async () => {
    const fakes = setup();
    fakes.state.failStartSession = true;
    const first = createTeamWork(fakes);
    expect(await fakes.service.execute(request(), first.work)).toEqual({
      outcome: 'unavailable', statusCode: 503, code: 'transaction_not_started', retryable: true,
    });
    expect(first.work).not.toHaveBeenCalled();
    expect(fakes.db.keys[0]).toMatchObject({ status: 'failed', failure: { retryable: true } });

    fakes.state.failStartSession = false;
    const retry = createTeamWork(fakes);
    expect((await fakes.service.execute(request(), retry.work)).outcome).toBe('executed');
    expect(fakes.db.keys[0]).toMatchObject({ status: 'completed', attempts: 2 });
    expect(fakes.db.keys[0].failure).toBeUndefined();
    expect(fakes.db.effects).toHaveLength(1);
  });

  test('falha de negocio durante a transacao: efeito desfeito, 4xx guardado e repetido sem executar', async () => {
    const fakes = setup();
    const work = jest.fn(async (session) => {
      fakes.createEffect({ kind: 'parcial' }, session); // gravado e depois desfeito pelo abort
      throw new IdempotentRequestError(403, 'forbidden');
    });
    expect(await fakes.service.execute(request(), work)).toEqual({
      outcome: 'failed', statusCode: 403, code: 'forbidden', retryable: false, replayed: false,
    });
    expect(fakes.db.effects).toHaveLength(0);
    const again = createTeamWork(fakes);
    expect(await fakes.service.execute(request(), again.work)).toEqual({
      outcome: 'failed', statusCode: 403, code: 'forbidden', retryable: false, replayed: true,
    });
    expect(again.work).not.toHaveBeenCalled();
    expect(fakes.db.effects).toHaveLength(0);
  });

  test('erro inesperado durante a transacao: nada gravado, 500 e a mesma chave pode executar depois', async () => {
    const fakes = setup();
    const broken = jest.fn(async (session) => {
      fakes.createEffect({ kind: 'parcial' }, session);
      throw new Error('falha interna com detalhe /tmp/segredo');
    });
    const response = await fakes.service.execute(request(), broken);
    expect(response).toEqual({ outcome: 'failed', statusCode: 500, code: 'execution_failed', retryable: true, replayed: false });
    expect(JSON.stringify(response)).not.toContain('segredo');
    expect(fakes.logger.error.mock.calls.flat().join(' ')).not.toContain('segredo');
    expect(fakes.db.effects).toHaveLength(0);

    const retry = createTeamWork(fakes);
    expect((await fakes.service.execute(request(), retry.work)).outcome).toBe('executed');
    expect(fakes.db.effects).toHaveLength(1);
  });

  test('withTransaction repete o callback (conflito transitorio): efeito e afterCommit uma unica vez', async () => {
    const fakes = setup();
    fakes.state.commitPlan = ['transient', 'transient'];
    const { work, afterCommit } = createTeamWork(fakes);
    const response = await fakes.service.execute(request(), work);
    expect(response.outcome).toBe('executed');
    expect(work).toHaveBeenCalledTimes(3); // o callback rodou 3 vezes...
    expect(fakes.db.effects).toHaveLength(1); // ...mas so a ultima transacao entrou
    expect(afterCommit).toHaveBeenCalledTimes(1);
    expect(fakes.db.keys[0]).toMatchObject({ status: 'completed', attempts: 1 });
    expect(response.result.resourceId).toBe(fakes.db.effects[0]._id); // resultado da tentativa que entrou
  });

  test('erro transitorio lancado pelo proprio trabalho tambem e repetido pelo withTransaction', async () => {
    const fakes = setup();
    let calls = 0;
    const work = jest.fn(async (session) => {
      calls += 1;
      if (calls === 1) {
        fakes.createEffect({ kind: 'parcial' }, session);
        throw labeled('WriteConflict', 'TransientTransactionError');
      }
      const team = fakes.createEffect({ kind: 'team' }, session);
      return { statusCode: 201, resourceType: 'equipe', resourceId: team._id };
    });
    expect((await fakes.service.execute(request(), work)).outcome).toBe('executed');
    expect(fakes.db.effects).toEqual([expect.objectContaining({ kind: 'team' })]);
  });

  test('commit com resultado desconhecido e transacao NAO aplicada: "unknown", nada repete sozinho', async () => {
    const fakes = setup();
    fakes.state.commitPlan = ['unknown_not_applied'];
    const { work, afterCommit } = createTeamWork(fakes);
    expect(await fakes.service.execute(request(), work)).toEqual({
      outcome: 'unknown', statusCode: 409, code: 'idempotency_outcome_unknown', retryable: false,
    });
    expect(afterCommit).not.toHaveBeenCalled();
    expect(fakes.db.effects).toHaveLength(0);
    expect(fakes.db.keys[0]).toMatchObject({ status: 'unknown', failure: { code: 'commit_outcome_unknown', retryable: false } });

    fakes.advance(24 * HOUR); // nem depois do prazo de reserva a chave executa sozinha
    const retry = createTeamWork(fakes);
    expect((await fakes.service.execute(request(), retry.work)).outcome).toBe('unknown');
    expect(retry.work).not.toHaveBeenCalled();
    expect(fakes.db.effects).toHaveLength(0);
  });

  test('commit com resultado desconhecido mas transacao aplicada: o registro prova e responde executado', async () => {
    const fakes = setup();
    fakes.state.commitPlan = ['unknown_applied'];
    const { work, afterCommit } = createTeamWork(fakes);
    const response = await fakes.service.execute(request(), work);
    expect(response.outcome).toBe('executed');
    expect(afterCommit).toHaveBeenCalledTimes(1);
    expect(fakes.db.effects).toHaveLength(1);
    expect(fakes.db.keys[0].status).toBe('completed');
    expect((await fakes.service.execute(request(), createTeamWork(fakes).work)).outcome).toBe('replayed');
    expect(fakes.db.effects).toHaveLength(1);
  });

  test('commit desconhecido e banco inacessivel para conferir: "unknown" e o registro continua reservado', async () => {
    const fakes = setup();
    fakes.state.commitPlan = ['unknown_not_applied'];
    const original = fakes.Model.findOne.getMockImplementation();
    fakes.Model.findOne.mockImplementation(() => ({ lean: async () => { throw new Error('rede'); } }));
    expect((await fakes.service.execute(request(), createTeamWork(fakes).work)).outcome).toBe('unknown');
    fakes.Model.findOne.mockImplementation(original);
    // Registro continua in_progress (nao concluido = a transacao nao entrou). Depois do prazo, assumir e seguro.
    expect(fakes.db.keys[0].status).toBe('in_progress');
    fakes.advance(31 * 1000);
    expect((await fakes.service.execute(request(), createTeamWork(fakes).work)).outcome).toBe('executed');
    expect(fakes.db.effects).toHaveLength(1);
  });

  test('registro concluido sem resumo (inconsistente) nao vira sucesso inventado', async () => {
    const fakes = setup();
    await fakes.service.execute(request(), createTeamWork(fakes).work);
    delete fakes.db.keys[0].result;
    const again = createTeamWork(fakes);
    expect((await fakes.service.execute(request(), again.work)).outcome).toBe('unknown');
    expect(again.work).not.toHaveBeenCalled();
  });

  test('falha no afterCommit nao desfaz nem repete a operacao', async () => {
    const fakes = setup();
    const afterCommit = jest.fn(async () => { throw new Error('socket'); });
    const work = jest.fn(async (session) => {
      const team = fakes.createEffect({ kind: 'team' }, session);
      return { statusCode: 201, resourceType: 'equipe', resourceId: team._id, afterCommit };
    });
    expect((await fakes.service.execute(request(), work)).outcome).toBe('executed');
    expect(afterCommit).toHaveBeenCalledTimes(1);
    expect(fakes.db.effects).toHaveLength(1);
    expect(fakes.db.keys[0].status).toBe('completed');
  });
});

describe('escopo por usuario', () => {
  test('a mesma chave de outro usuario nunca devolve nem bloqueia o resultado do primeiro', async () => {
    const fakes = setup();
    await fakes.service.execute(request(), createTeamWork(fakes).work);
    const recordA = clone(fakes.db.keys[0]);

    const workB = createTeamWork(fakes, { by: USER_B });
    const responseB = await fakes.service.execute(request({ userId: USER_B }), workB.work);
    expect(responseB.outcome).toBe('executed'); // escopo proprio: nao ve nem repete o registro de A
    expect(responseB.result.resourceId).not.toBe(recordA.result.resourceId);
    expect(workB.work).toHaveBeenCalledTimes(1);
    // Pedido diferente com a mesma chave em outro usuario tambem nao e "reuso" do primeiro.
    const otherB = await fakes.service.execute(
      request({ userId: USER_B, key: KEY_2, body: { nome: 'Vendas', membros: [] } }),
      createTeamWork(fakes, { by: USER_B }).work
    );
    expect(otherB.outcome).toBe('executed');
    expect(fakes.db.keys[0]).toEqual(recordA); // registro de A intacto
    expect(fakes.db.keys.map((row) => row.userId)).toEqual([USER_A, USER_B, USER_B]);

    // Repeticoes de cada um devolvem so o proprio resultado (sem vazar o recurso do outro).
    const replayB = await fakes.service.execute(request({ userId: USER_B }), createTeamWork(fakes).work);
    expect(replayB).toEqual({ ...responseB, outcome: 'replayed' });
    const replayA = await fakes.service.execute(request(), createTeamWork(fakes).work);
    expect(replayA.result.resourceId).toBe(recordA.result.resourceId);
  });
});

describe('o que fica guardado e por quanto tempo', () => {
  test('so o resumo: sem corpo, textos, tokens ou URLs assinadas', async () => {
    const fakes = setup();
    const secretBody = { texto: 'comentario privado', token: 'Bearer abc.def.ghi' };
    const work = jest.fn(async (session) => {
      const row = fakes.createEffect({ kind: 'comment' }, session);
      return {
        statusCode: 201,
        resourceType: 'comentario',
        resourceId: row._id,
        body: { url: 'https://storage.example/anexo?X-Goog-Signature=assinatura', ...secretBody },
      };
    });
    const response = await fakes.service.execute(request({ route: '/api/tarefas/:id/comentarios', params: { id: TEAM_ID }, body: secretBody }), work);
    const stored = JSON.stringify(fakes.db.keys);
    for (const text of ['comentario privado', 'Bearer', 'X-Goog-Signature', 'assinatura', 'https://']) {
      expect(stored).not.toContain(text);
      expect(JSON.stringify(response)).not.toContain(text);
    }
    expect(Object.keys(fakes.db.keys[0].result)).toEqual(['statusCode', 'resourceType', 'resourceId']);
  });

  test('resultado fora do contrato (status nao 2xx, tipo ou ID invalidos) aborta sem gravar', async () => {
    for (const result of [{ statusCode: 500 }, { statusCode: 201, resourceType: 'Equipe X' }, { statusCode: 201, resourceId: 'abc' }, null]) {
      const fakes = setup();
      const work = jest.fn(async (session) => {
        fakes.createEffect({ kind: 'team' }, session);
        return result;
      });
      expect(await fakes.service.execute(request(), work)).toMatchObject({ outcome: 'failed', statusCode: 422, code: 'idempotency_invalid_result' });
      expect(fakes.db.effects).toHaveLength(0);
    }
  });

  test('retencao: minimo de 24 h, padrao de 7 dias, maximo de 30; prazo nunca encurta numa nova tentativa', async () => {
    expect(retentionMsFromEnv({})).toBe(168 * HOUR);
    expect(retentionMsFromEnv({ IDEMPOTENCY_RETENTION_HOURS: '1' })).toBe(24 * HOUR);
    expect(retentionMsFromEnv({ IDEMPOTENCY_RETENTION_HOURS: '100000' })).toBe(720 * HOUR);
    expect(retentionMsFromEnv({ IDEMPOTENCY_RETENTION_HOURS: 'abc' })).toBe(168 * HOUR);
    expect(leaseMsFromEnv({})).toBe(30 * 1000);
    expect(leaseMsFromEnv({ IDEMPOTENCY_LEASE_SECONDS: '0' })).toBe(5 * 1000);

    const fakes = setup();
    fakes.state.failStartSession = true;
    await fakes.service.execute(request(), createTeamWork(fakes).work);
    const firstExpiry = new Date(fakes.db.keys[0].expiresAt).getTime();
    expect(firstExpiry - Date.parse('2026-11-21T12:00:00.000Z')).toBe(168 * HOUR);
    fakes.state.failStartSession = false;
    fakes.advance(HOUR);
    await fakes.service.execute(request(), createTeamWork(fakes).work);
    expect(new Date(fakes.db.keys[0].expiresAt).getTime()).toBe(firstExpiry + HOUR);
  });

  test('retencao configurada menor numa tentativa seguinte nao encurta o prazo ja garantido', async () => {
    const fakes = setup();
    fakes.state.failStartSession = true;
    await fakes.service.execute(request(), createTeamWork(fakes).work);
    const firstExpiry = new Date(fakes.db.keys[0].expiresAt).getTime();
    fakes.state.failStartSession = false;

    const shorter = createIdempotencyService({
      Model: fakes.Model,
      supportsTransactions: fakes.transactions.supportsTransactions,
      runInTransaction: fakes.transactions.runInTransaction,
      now: () => new Date(Date.parse('2026-11-21T13:00:00.000Z')),
      newToken: () => KEY_2,
      retentionMs: 24 * HOUR,
      leaseMs: 30 * 1000,
      logger: fakes.logger,
    });
    expect((await shorter.execute(request(), createTeamWork(fakes).work)).outcome).toBe('executed');
    expect(new Date(fakes.db.keys[0].expiresAt).getTime()).toBe(firstExpiry);
  });
});

describe('model', () => {
  test('indices declarados: unico por usuario+chave e TTL; carregar o model nao cria colecao nem indice', () => {
    expect(IdempotencyKey.schema.indexes()).toEqual(
      expect.arrayContaining([
        [{ userId: 1, key: 1 }, expect.objectContaining({ unique: true, name: 'user_key_unique' })],
        [{ expiresAt: 1 }, expect.objectContaining({ expireAfterSeconds: 0, name: 'expires_at_ttl' })],
      ])
    );
    expect(IdempotencyKey.schema.get('autoIndex')).toBe(false);
    expect(IdempotencyKey.schema.get('autoCreate')).toBe(false);
    expect(IdempotencyKey.schema.get('strict')).toBe('throw');
    expect(IdempotencyKey.collection.collectionName).toBe('idempotencykeys');
  });

  test('validacao do documento: chave UUID, status conhecido, resumo 2xx e nenhum campo extra', () => {
    const valid = {
      userId: USER_A, key: KEY, method: 'POST', route: '/api/equipes', requestHash: 'f'.repeat(64), status: 'completed',
      claimToken: KEY_2, lockedUntil: new Date(), attempts: 1, expiresAt: new Date(),
      result: { statusCode: 201, resourceType: 'equipe', resourceId: TEAM_ID },
    };
    expect(new IdempotencyKey(valid).validateSync()).toBeUndefined();
    for (const [field, value] of [
      ['key', 'nao-e-uuid'], ['status', 'feito'], ['method', 'GET'], ['requestHash', 'abc'],
      ['result', { statusCode: 500 }], ['failure', { statusCode: 200, code: 'x', retryable: false }],
    ]) {
      expect(new IdempotencyKey({ ...valid, [field]: value }).validateSync()?.errors).toBeDefined();
    }
    expect(() => new IdempotencyKey({ ...valid, body: { texto: 'x' } })).toThrow();
    // No subdocumento, o campo extra vira erro de validacao do resumo (o save seria recusado) e nao e guardado.
    const withUrl = new IdempotencyKey({ ...valid, result: { ...valid.result, url: 'https://x' } });
    expect(withUrl.validateSync()?.errors?.result).toBeDefined();
    expect(JSON.stringify(withUrl.toObject())).not.toContain('https://x');
  });
});
