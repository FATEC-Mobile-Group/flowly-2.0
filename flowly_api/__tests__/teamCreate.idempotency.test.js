// POST /api/equipes com Idempotency-Key (opt-in): rotas reais, auth e sessionGuard reais, banco e transacao
// simulados em memoria. Sem o cabecalho, o fluxo legado continua igual. Nenhuma conexao real, nenhum indice criado.
const request = require('supertest');
const mongoose = require('mongoose');

jest.setTimeout(30000);

const mockDb = {
  users: [], equipes: [], keys: [], saves: [], userFinds: 0, userFindSessions: [], pausedSaves: 0, commits: 0, sessions: 0,
};
const mockTx = {
  supported: true,
  indexes: null,
  failSave: null,
  pauseSave: null,
  commitPlan: [],
};
const mockSame = (a, b) => a != null && b != null && String(a) === String(b);

jest.mock('@google-cloud/storage', () => ({
  Storage: jest.fn().mockImplementation(() => ({ bucket: jest.fn().mockReturnValue({ file: jest.fn() }) })),
}));

// URLs assinadas distintas a cada chamada: provam que a resposta e montada na hora e nunca guardada.
jest.mock('../services/storage', () => {
  let counter = 0;
  return {
    getSignedUrl: jest.fn(async (path) => {
      counter += 1;
      return path ? `https://storage.test/${path}?X-Goog-Signature=sig${counter}` : '';
    }),
    getObjectPath: jest.fn(),
    verifyFileAccessToken: jest.fn(),
  };
});
jest.mock('../utils/sendEmail', () => jest.fn().mockResolvedValue(true));

jest.mock('../models/User', () => {
  const query = (value) => {
    const promise = Promise.resolve(value);
    promise.select = () => promise;
    promise.session = (session) => {
      mockDb.userFindSessions.push(Boolean(session));
      return promise;
    };
    return promise;
  };
  return {
    find: jest.fn((filter) => {
      mockDb.userFinds += 1;
      const ids = filter._id.$in;
      const found = mockDb.users.filter((user) => ids.some((id) => mockSame(id, user._id)) && user.tipo === filter.tipo);
      return query(found);
    }),
    // sessionGuard real: confere tipo e versao da sessao no "banco".
    findById: jest.fn(async (id) => mockDb.users.find((user) => mockSame(user._id, id)) || null),
    findOne: jest.fn(async () => null),
  };
});

jest.mock('../models/Equipe', () => {
  const { ObjectId } = jest.requireActual('mongoose').Types;
  const populate = (equipe) =>
    equipe && {
      ...equipe,
      membros: equipe.membros
        .map((id) => mockDb.users.find((user) => mockSame(user._id, id)))
        .filter(Boolean)
        .map((user) => ({ _id: user._id, nome: user.nome, email: user.email, fotoPerfil: user.fotoPerfil })),
    };
  const query = (equipe) => {
    const promise = Promise.resolve(equipe ? { ...equipe } : null);
    promise.populate = () => Promise.resolve(populate(equipe));
    return promise;
  };
  function Equipe(data) {
    Object.assign(this, { _id: new ObjectId(), membros: [], ...data });
  }
  Equipe.prototype.save = jest.fn(async function save(options = {}) {
    mockDb.saves.push({ withSession: Boolean(options.session) });
    if (mockTx.pauseSave) {
      mockDb.pausedSaves += 1;
      await mockTx.pauseSave();
    }
    if (mockTx.failSave) throw mockTx.failSave;
    const doc = {
      _id: String(this._id),
      nome: this.nome,
      membros: this.membros.map(String),
      createdBy: String(this.createdBy),
    };
    // Na transacao a equipe so aparece no commit; fora dela (legado), na hora.
    if (options.session) options.session.equipes.push(doc);
    else mockDb.equipes.push(doc);
    return this;
  });
  const visible = (filter) =>
    mockDb.equipes.find((equipe) => {
      if (!mockSame(equipe._id, filter._id)) return false;
      if (!filter.$or) return true;
      return filter.$or.some(
        (condition) =>
          (condition.membros && equipe.membros.some((id) => mockSame(id, condition.membros))) ||
          (condition.createdBy && mockSame(equipe.createdBy, condition.createdBy))
      );
    }) || null;
  Equipe.find = jest.fn((filter) => {
    const found = mockDb.equipes.filter((equipe) => equipe.membros.some((id) => mockSame(id, filter.membros)));
    const promise = Promise.resolve(found);
    promise.populate = () => Promise.resolve(found.map(populate));
    return promise;
  });
  Equipe.findById = jest.fn((id) => query(visible({ _id: id })));
  Equipe.findOne = jest.fn((filter) => query(visible(filter)));
  Equipe.updateMany = jest.fn(async () => ({}));
  return Equipe;
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
  // Constantes de validacao (padrao da chave, rotas etc.) vem do model real.
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
    session.equipes = [];
  };
  const commit = (session) => {
    session.keys.forEach((copy, row) => {
      Object.keys(row).forEach((name) => delete row[name]);
      Object.assign(row, copy);
    });
    mockDb.equipes.push(...session.equipes);
    mockDb.commits += 1;
    rollback(session);
  };
  return {
    supportsTransactions: jest.fn(async () => mockTx.supported),
    resetTransactionSupportCache: jest.fn(),
    runInTransaction: jest.fn(async (work) => {
      for (let attempt = 1; attempt <= 5; attempt += 1) {
        mockDb.sessions += 1;
        const session = { id: mockDb.sessions, keys: new Map(), equipes: [] };
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

// App carregado de novo a cada teste: servico de idempotencia novo (sem cache da verificacao do indice).
const loadApp = () => {
  let app;
  jest.isolateModules(() => {
    app = require('../app');
  });
  return app;
};

describe('POST /api/equipes com Idempotency-Key', () => {
  let app;
  let admin;
  let admin2;
  let colaborador;
  let colaborador2;
  let tokenAdmin;

  const post = (body, { key, token = tokenAdmin } = {}) => {
    const req = request(app).post('/api/equipes').set('Authorization', `Bearer ${token}`);
    if (key !== undefined) req.set('Idempotency-Key', key);
    return req.send(body);
  };
  const body = (extra = {}) => ({ nome: 'marketing digital', membros: [colaborador._id], ...extra });

  beforeEach(() => {
    Object.assign(mockDb, {
      users: [], equipes: [], keys: [], saves: [], userFinds: 0, userFindSessions: [], pausedSaves: 0, commits: 0, sessions: 0,
    });
    Object.assign(mockTx, { supported: true, indexes: null, failSave: null, pauseSave: null, commitPlan: [] });
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'log').mockImplementation(() => {});

    admin = { _id: id(), nome: 'Admin Ficticio', email: 'admin@flowly.test', tipo: 'admin', authVersion: 0, fotoPerfil: 'fotos/admin.png' };
    admin2 = { _id: id(), nome: 'Admin Dois', email: 'admin2@flowly.test', tipo: 'admin', authVersion: 0, fotoPerfil: '' };
    colaborador = { _id: id(), nome: 'Pessoa Ficticia', email: 'pessoa@flowly.test', tipo: 'user', authVersion: 0, fotoPerfil: 'fotos/p.png' };
    colaborador2 = { _id: id(), nome: 'Pessoa Dois', email: 'pessoa2@flowly.test', tipo: 'user', authVersion: 0, fotoPerfil: '' };
    mockDb.users.push(admin, admin2, colaborador, colaborador2);
    tokenAdmin = issueAuthToken(admin);
    app = loadApp();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('1. sem o cabecalho: fluxo legado inalterado (sem transacao e sem registro de chave)', async () => {
    const response = await post(body());
    expect(response.status).toBe(201);
    expect(response.body.nome).toBe('Marketing Digital');
    expect(response.headers['idempotency-replayed']).toBeUndefined();
    expect(mockDb.saves).toEqual([{ withSession: false }]);
    expect(mockDb.keys).toHaveLength(0);
    expect(mockDb.sessions).toBe(0);
    // Sem cabecalho, repetir cria de novo (comportamento de hoje).
    expect((await post(body())).status).toBe(201);
    expect(mockDb.equipes).toHaveLength(2);
  });

  test('2. com chave valida: cria uma vez, dentro da transacao, e conclui a chave junto', async () => {
    const response = await post(body(), { key: KEY });
    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({ nome: 'Marketing Digital', createdBy: admin._id });
    expect(response.headers['idempotency-replayed']).toBeUndefined();
    expect(mockDb.saves).toEqual([{ withSession: true }]);
    expect(mockDb.userFindSessions).toEqual([true]); // a verificacao dos membros tambem roda na transacao
    expect(mockDb.commits).toBe(1);
    expect(mockDb.equipes).toHaveLength(1);
    expect(mockDb.keys).toHaveLength(1);
    expect(mockDb.keys[0]).toMatchObject({
      userId: admin._id, key: KEY, method: 'POST', route: '/api/equipes', status: 'completed',
      result: { statusCode: 201, resourceType: 'equipe', resourceId: mockDb.equipes[0]._id },
    });
  });

  test('3. repeticao da mesma chave e dados: mesmo recurso, 201, sem nova criacao', async () => {
    const first = await post(body(), { key: KEY });
    for (let i = 0; i < 3; i += 1) {
      const again = await post(body(), { key: KEY.toUpperCase() });
      expect(again.status).toBe(201);
      expect(again.headers['idempotency-replayed']).toBe('true');
      expect(again.body._id).toBe(first.body._id);
      expect(again.body.nome).toBe(first.body.nome);
    }
    expect(mockDb.equipes).toHaveLength(1);
    expect(mockDb.saves).toHaveLength(1);
  });

  test('4. mesma chave com corpo diferente: 422 sem criar', async () => {
    await post(body(), { key: KEY });
    for (const changed of [body({ nome: 'Vendas' }), body({ membros: [colaborador2._id] }), body({ membros: [] }), { nome: 'marketing digital' }]) {
      const response = await post(changed, { key: KEY });
      expect(response.status).toBe(422);
      expect(response.body).toEqual({ erro: 'Esta chave de idempotência já foi usada com outro pedido.', code: 'idempotency_key_reused' });
    }
    expect(mockDb.equipes).toHaveLength(1);
  });

  test('5. duas requisicoes simultaneas: uma cria; a outra recebe 409; nenhuma equipe aparece antes do commit', async () => {
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    mockTx.pauseSave = () => gate;
    const firstRun = post(body(), { key: KEY }).then((response) => response);
    let first;
    try {
      // Espera a primeira gravacao chegar ao ponto de pausa, com prazo (se nunca chegar, falha em vez de girar).
      const deadline = Date.now() + 5000;
      while (mockDb.pausedSaves === 0) {
        if (Date.now() > deadline) throw new Error('a primeira criacao nao chegou ao ponto de pausa');
        await new Promise((resolve) => setImmediate(resolve));
      }
      expect(mockDb.equipes).toHaveLength(0); // equipe ainda so na sessao

      mockTx.pauseSave = null;
      const second = await post(body(), { key: KEY });
      expect(second.status).toBe(409);
      expect(second.body.code).toBe('idempotency_in_progress');
      expect(second.headers['retry-after']).toBe('2');
    } finally {
      // Sempre libera a requisicao pausada, mesmo se uma verificacao acima falhar: sem isso ela ficaria pendente
      // com a conexao aberta e o Jest nao encerraria. Nao lanca nada aqui, para nao esconder a falha original.
      mockTx.pauseSave = null;
      release();
      first = await firstRun.catch((err) => ({ status: undefined, requestError: err }));
    }
    expect(first.status).toBe(201);
    const third = await post(body(), { key: KEY });
    expect(third.status).toBe(201);
    expect(third.body._id).toBe(first.body._id);
    expect(mockDb.equipes).toHaveLength(1);
    expect(mockDb.saves).toHaveLength(1);
  });

  test('6. usuario sem permissao de administrador: 403 antes de qualquer registro', async () => {
    const response = await post(body(), { key: KEY, token: issueAuthToken(colaborador) });
    expect(response.status).toBe(403);
    expect(mockDb.keys).toHaveLength(0);
    expect(mockDb.equipes).toHaveLength(0);
    expect(mockDb.sessions).toBe(0);
  });

  test('7. token invalido ou revogado: 401 sem registro nem criacao', async () => {
    expect((await post(body(), { key: KEY, token: 'nao-e-um-jwt' })).status).toBe(401);
    const revoked = tokenAdmin;
    admin.authVersion = 1; // sessoes antigas revogadas
    expect((await post(body(), { key: KEY, token: revoked })).status).toBe(401);
    expect((await request(app).post('/api/equipes').set('Idempotency-Key', KEY).send(body())).status).toBe(401);
    expect(mockDb.keys).toHaveLength(0);
    expect(mockDb.equipes).toHaveLength(0);
  });

  test('8. erros de validacao: formato nao consome a chave; membro que nao e colaborador fica registrado', async () => {
    // Formato invalido: 400 antes da chave (mesmas mensagens do fluxo legado).
    for (const [invalid, mensagem] of [
      [{ membros: [] }, 'O nome da equipe é obrigatório'],
      [{ nome: '   ' }, 'O nome da equipe é obrigatório'],
      [{ nome: 'X', membros: ['nao-e-id'] }, 'Existem membros com identificadores inválidos'],
      [{ nome: 'X', membros: [{ $ne: null }] }, 'Existem membros com identificadores inválidos'],
    ]) {
      const protegido = await post(invalid, { key: KEY });
      const legado = await post(invalid);
      expect(protegido.status).toBe(400);
      expect(protegido.body).toEqual({ erro: mensagem });
      expect(legado.status).toBe(400);
      expect(legado.body).toEqual(protegido.body); // paridade com o legado
    }
    expect(mockDb.keys).toHaveLength(0);

    // Membro que nao e colaborador (admin): 400 decidido na transacao; repetir devolve o mesmo sem consultar.
    const comAdmin = body({ membros: [admin2._id] });
    const first = await post(comAdmin, { key: KEY });
    expect(first.status).toBe(400);
    expect(first.body).toEqual({ erro: 'Alguns membros não são usuarios válidos' });
    const finds = mockDb.userFinds;
    const again = await post(comAdmin, { key: KEY });
    expect(again.status).toBe(400);
    expect(again.headers['idempotency-replayed']).toBe('true');
    expect(again.body).toEqual(first.body);
    expect(mockDb.userFinds).toBe(finds);
    expect(mockDb.keys[0]).toMatchObject({ status: 'failed', failure: { statusCode: 400, code: 'membros_nao_usuarios', retryable: false } });
    // Corrigido, com chave nova: cria.
    expect((await post(body(), { key: KEY_2 })).status).toBe(201);
    expect(mockDb.equipes).toHaveLength(1);
  });

  test('9. falha na transacao: rollback, nenhuma equipe, e a mesma chave cria uma unica vez depois', async () => {
    mockTx.failSave = new Error('falha interna /tmp/segredo');
    const failed = await post(body(), { key: KEY });
    expect(failed.status).toBe(500);
    expect(failed.body).toEqual({ erro: 'Erro ao criar equipe' });
    expect(JSON.stringify(failed.body)).not.toContain('segredo');
    expect(mockDb.equipes).toHaveLength(0);
    expect(mockDb.keys[0]).toMatchObject({ status: 'failed', failure: { retryable: true } });

    mockTx.failSave = null;
    expect((await post(body(), { key: KEY })).status).toBe(201);
    expect(mockDb.equipes).toHaveLength(1);
  });

  test('9b. commit com resultado desconhecido: sem confirmacao nao cria de novo; se entrou, responde 201', async () => {
    mockTx.commitPlan = ['unknown_not_applied'];
    const unknown = await post(body(), { key: KEY });
    expect(unknown.status).toBe(409);
    expect(unknown.body.code).toBe('idempotency_outcome_unknown');
    expect((await post(body(), { key: KEY })).status).toBe(409); // nao repete sozinho
    expect(mockDb.equipes).toHaveLength(0);

    mockTx.commitPlan = ['unknown_applied'];
    const applied = await post(body(), { key: KEY_2 });
    expect(applied.status).toBe(201);
    expect(mockDb.equipes).toHaveLength(1);
    expect((await post(body(), { key: KEY_2 })).headers['idempotency-replayed']).toBe('true');
    expect(mockDb.equipes).toHaveLength(1);
  });

  test('9c. conflito transitorio: o withTransaction repete e a equipe e criada uma vez', async () => {
    mockTx.commitPlan = ['transient', 'transient'];
    expect((await post(body(), { key: KEY })).status).toBe(201);
    expect(mockDb.saves).toHaveLength(3);
    expect(mockDb.equipes).toHaveLength(1);
  });

  test('10. banco sem transacoes: 503 sem criar; o fluxo sem cabecalho continua funcionando', async () => {
    mockTx.supported = false;
    const response = await post(body(), { key: KEY });
    expect(response.status).toBe(503);
    expect(response.body).toEqual({ erro: 'Serviço temporariamente indisponível.', code: 'transactions_unavailable' });
    expect(response.headers['retry-after']).toBe('2');
    expect(mockDb.equipes).toHaveLength(0);
    expect(mockDb.keys).toHaveLength(0);
    expect((await post(body())).status).toBe(201);
  });

  test('11. sem o indice unico (ou colecao inexistente): 503 sem criar', async () => {
    for (const indexes of [[{ key: { _id: 1 }, name: '_id_' }], new Error('ns not found')]) {
      mockTx.indexes = indexes;
      app = loadApp();
      const response = await post(body(), { key: KEY });
      expect(response.status).toBe(503);
      expect(response.body.code).toBe('idempotency_unavailable');
    }
    expect(mockDb.equipes).toHaveLength(0);
    expect(mockDb.keys).toHaveLength(0);
  });

  test('12. formato da resposta igual ao legado; nada da resposta fica no registro da chave', async () => {
    const legado = await post(body());
    const protegido = await post(body(), { key: KEY });
    expect(Object.keys(protegido.body).sort()).toEqual(Object.keys(legado.body).sort());
    expect(protegido.body.membros.map((m) => Object.keys(m).sort())).toEqual(legado.body.membros.map((m) => Object.keys(m).sort()));
    const membro = protegido.body.membros.find((m) => m._id === colaborador._id);
    expect(membro).toMatchObject({ nome: 'Pessoa Ficticia', email: 'pessoa@flowly.test' });
    expect(membro.fotoPerfil).toMatch(/^https:\/\/storage\.test\/fotos\/p\.png\?X-Goog-Signature=sig\d+$/);

    const replay = await post(body(), { key: KEY });
    const replayFoto = replay.body.membros.find((m) => m._id === colaborador._id).fotoPerfil;
    expect(replayFoto).not.toBe(membro.fotoPerfil); // assinada de novo, nunca guardada
    const stored = JSON.stringify(mockDb.keys);
    for (const text of ['storage.test', 'X-Goog-Signature', 'pessoa@flowly.test', 'Pessoa Ficticia', 'Marketing', 'Bearer']) {
      expect(stored).not.toContain(text);
    }
  });

  test('13. repeticao apos mudanca de autorizacao: nada e devolvido sem o acesso atual', async () => {
    const created = await post(body(), { key: KEY });
    expect(created.status).toBe(201);

    // a) Admin rebaixado: o token antigo cai na sessao (401); um token novo de colaborador cai no isAdmin (403).
    admin.tipo = 'user';
    const old = await post(body(), { key: KEY });
    expect(old.status).toBe(401);
    expect(JSON.stringify(old.body)).not.toContain('Marketing');
    const asUser = await post(body(), { key: KEY, token: issueAuthToken(admin) });
    expect(asUser.status).toBe(403);
    expect(JSON.stringify(asUser.body)).not.toContain('Marketing');
    admin.tipo = 'admin';

    // b) Ainda admin, mas sem acesso a equipe (transferida): 404 sem dados.
    const equipe = mockDb.equipes[0];
    equipe.createdBy = admin2._id;
    equipe.membros = [colaborador._id];
    const semAcesso = await post(body(), { key: KEY });
    expect(semAcesso.status).toBe(404);
    expect(semAcesso.body).toEqual({ erro: 'Equipe não encontrada' });

    // c) Equipe excluida: 404, e nenhuma equipe nova e criada pela repeticao.
    mockDb.equipes.length = 0;
    expect((await post(body(), { key: KEY })).status).toBe(404);
    expect(mockDb.equipes).toHaveLength(0);
    expect(mockDb.saves).toHaveLength(1);
  });

  test('identidade so do JWT e escopo por usuario: userId no corpo e ignorado; outra conta tem a propria chave', async () => {
    const spoof = await post({ ...body(), userId: admin2._id, createdBy: admin2._id }, { key: KEY });
    expect(spoof.status).toBe(201);
    expect(mockDb.keys[0].userId).toBe(admin._id);
    expect(mockDb.equipes[0].createdBy).toBe(admin._id);

    const other = await post(body(), { key: KEY, token: issueAuthToken(admin2) });
    expect(other.status).toBe(201);
    expect(other.headers['idempotency-replayed']).toBeUndefined();
    expect(other.body._id).not.toBe(spoof.body._id);
    expect(mockDb.equipes.map((e) => e.createdBy)).toEqual([admin._id, admin2._id]);
  });

  test('chave invalida (inclusive vazia ou repetida): 400, sem cair no fluxo legado', async () => {
    for (const key of ['', 'abc', `${KEY}, ${KEY_2}`, '3f1c2b6e8a4d4c1b9e2f7a6b5c4d3e2f', 'x'.repeat(300)]) {
      const response = await post(body(), { key });
      expect(response.status).toBe(400);
      expect(response.body).toEqual({ erro: 'Chave de idempotência inválida.', code: 'idempotency_key_invalid' });
    }
    expect(mockDb.equipes).toHaveLength(0);
    expect(mockDb.saves).toHaveLength(0);
    expect(mockDb.keys).toHaveLength(0);
  });

  test('outras rotas de equipe nao sao afetadas pelo cabecalho', async () => {
    await post(body());
    const listed = await request(app)
      .get('/api/equipes/minhas')
      .set('Authorization', `Bearer ${tokenAdmin}`)
      .set('Idempotency-Key', KEY);
    expect(listed.status).toBe(200);
    expect(listed.body).toHaveLength(1);
    expect(listed.body[0].nome).toBe('Marketing Digital');
    expect(mockDb.keys).toHaveLength(0);
    expect(mockDb.sessions).toBe(0);
  });
});
