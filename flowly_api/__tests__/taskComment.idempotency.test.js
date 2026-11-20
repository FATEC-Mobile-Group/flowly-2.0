// POST /api/tarefas/:id/comentarios com Idempotency-Key (opt-in): rotas reais, auth e sessionGuard reais, banco e
// transacao em memoria. Comment e ActivityLog usam documentos Mongoose REAIS (schema, validacao, toObject); so a
// gravacao vai para o banco em memoria, isolada por sessao ate o commit. Nenhuma conexao real, nenhum indice criado.
const request = require('supertest');
const mongoose = require('mongoose');

jest.setTimeout(30000);

const mockFresh = () => ({
  users: [], equipes: [], tarefas: [], comments: [], logs: [], keys: [],
  commentSaves: [], logSaves: [], equipeFindSessions: [], tarefaFindSessions: [], equipeFinds: 0, pausedSaves: 0, commits: 0,
  sessions: 0,
});
const mockDb = mockFresh();
const mockTx = { supported: true, indexes: null, failCommentSave: null, failLogSave: null, pauseSave: null, commitPlan: [] };
const mockSame = (a, b) => a != null && b != null && String(a) === String(b);
const mockQuery = (value, onSession) => {
  const promise = Promise.resolve(value);
  promise.select = () => promise;
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
jest.mock('../services/storage', () => {
  const bucket = { file: jest.fn() };
  bucket.getSignedUrl = jest.fn(async (value) => value || '');
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

// Equipes acessiveis: admin = membro ou criador; colaborador = membro (filtros do controller).
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

jest.mock('../models/Tarefa', () => ({
  findOne: jest.fn((filter) => {
    const found = mockDb.tarefas.find(
      (tarefa) =>
        mockSame(tarefa._id, filter._id) &&
        (!filter.equipe || filter.equipe.$in.some((id) => mockSame(id, tarefa.equipe)))
    );
    return mockQuery(found ? { _id: found._id } : null, (session) => {
      mockDb.tarefaFindSessions.push(Boolean(session));
    });
  }),
  find: jest.fn(() => mockQuery([])),
}));

// Documento Mongoose real; save desviado para o banco em memoria (na sessao, so aparece no commit).
const mockRealModel = (path, table, saves, failKey) => {
  const Real = jest.requireActual(path);
  function Model(data) {
    const doc = new Real(data);
    doc.save = async (options = {}) => {
      saves.push({ withSession: Boolean(options.session) });
      if (table === 'comments' && mockTx.pauseSave) {
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

jest.mock('../models/Comment', () => {
  const Model = mockRealModel('../models/Comment', 'comments', mockDb.commentSaves, 'failCommentSave');
  // populate('user', 'nome'): troca o ID pelo { _id, nome } do autor, como o Mongoose faz.
  const populated = (row) => {
    if (!row) return null;
    const plain = JSON.parse(JSON.stringify(row));
    const autor = mockDb.users.find((user) => mockSame(user._id, row.user));
    plain.user = autor ? { _id: autor._id, nome: autor.nome } : null;
    return plain;
  };
  const query = (row) => {
    const promise = Promise.resolve(row ? JSON.parse(JSON.stringify(row)) : null);
    promise.populate = () => Promise.resolve(populated(row));
    return promise;
  };
  Model.findById = jest.fn((id) => query(mockDb.comments.find((row) => mockSame(row._id, id))));
  Model.findOne = jest.fn((filter) =>
    query(mockDb.comments.find((row) => mockSame(row._id, filter._id) && (!filter.tarefa || mockSame(row.tarefa, filter.tarefa))))
  );
  Model.find = jest.fn(() => mockQuery([]));
  return Model;
});

jest.mock('../models/ActivityLog', () => {
  const Model = mockRealModel('../models/ActivityLog', 'logs', mockDb.logSaves, 'failLogSave');
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
    session.comments = [];
    session.logs = [];
  };
  const commit = (session) => {
    session.keys.forEach((copy, row) => {
      Object.keys(row).forEach((name) => delete row[name]);
      Object.assign(row, copy);
    });
    mockDb.comments.push(...session.comments);
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
        const session = { id: mockDb.sessions, keys: new Map(), comments: [], logs: [] };
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
const TAREFA_404 = { erro: 'Tarefa nÃ£o encontrada' }; // mesmo texto (e mesma codificacao) do fluxo legado
const id = () => new mongoose.Types.ObjectId().toString();
const keysOf = (value) => Object.keys(value).sort();

const loadApp = () => {
  let app;
  jest.isolateModules(() => {
    app = require('../app');
  });
  return app;
};

describe('POST /api/tarefas/:id/comentarios com Idempotency-Key', () => {
  let app;
  let admin;
  let colaborador;
  let colaboradorFora;
  let equipe;
  let tarefa;
  let outraTarefa;
  let tokenUser;

  const post = (texto, { key, token = tokenUser, tarefaId = tarefa._id, extra = {} } = {}) => {
    const req = request(app).post(`/api/tarefas/${tarefaId}/comentarios`).set('Authorization', `Bearer ${token}`);
    if (key !== undefined) req.set('Idempotency-Key', key);
    return req.send(texto === undefined ? extra : { texto, ...extra });
  };

  beforeEach(() => {
    Object.keys(mockDb).forEach((name) => {
      const value = mockFresh()[name];
      if (Array.isArray(value)) mockDb[name].splice(0, mockDb[name].length);
      else mockDb[name] = value;
    });
    Object.assign(mockTx, { supported: true, indexes: null, failCommentSave: null, failLogSave: null, pauseSave: null, commitPlan: [] });
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'log').mockImplementation(() => {});

    admin = { _id: id(), nome: 'Admin Ficticio', tipo: 'admin', authVersion: 0 };
    colaborador = { _id: id(), nome: 'Pessoa Ficticia', tipo: 'user', authVersion: 0 };
    colaboradorFora = { _id: id(), nome: 'Pessoa de Fora', tipo: 'user', authVersion: 0 };
    mockDb.users.push(admin, colaborador, colaboradorFora);
    equipe = { _id: id(), createdBy: admin._id, membros: [colaborador._id] }; // admin so como criador
    mockDb.equipes.push(equipe);
    tarefa = { _id: id(), equipe: equipe._id };
    outraTarefa = { _id: id(), equipe: equipe._id };
    mockDb.tarefas.push(tarefa, outraTarefa);
    tokenUser = issueAuthToken(colaborador);
    app = loadApp();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('1. sem o cabecalho: fluxo legado inalterado (sem transacao, sem chave)', async () => {
    const response = await post('Primeiro comentário');
    expect(response.status).toBe(201);
    expect(response.headers['idempotency-replayed']).toBeUndefined();
    expect(mockDb.commentSaves).toEqual([{ withSession: false }]);
    expect(mockDb.logSaves).toEqual([{ withSession: false }]);
    expect(mockDb.equipeFindSessions).toEqual([]); // consulta legada nem chama .session()
    expect(mockDb.keys).toHaveLength(0);
    expect(mockDb.sessions).toBe(0);
    expect((await post('Primeiro comentário')).status).toBe(201); // sem cabecalho, repetir publica de novo
    expect(mockDb.comments).toHaveLength(2);
    expect(mockDb.logs).toHaveLength(2);
  });

  test('2. chave valida: acesso, comentario e log na mesma transacao; chave concluida junto', async () => {
    const response = await post('Revisar os números', { key: KEY });
    expect(response.status).toBe(201);
    // Duas consultas de acesso: uma dentro da transacao (com session) e a revalidacao depois do commit (sem).
    expect(mockDb.equipeFinds).toBe(2);
    expect(mockDb.equipeFindSessions).toEqual([true]);
    expect(mockDb.tarefaFindSessions).toEqual([true]);
    expect(mockDb.commentSaves).toEqual([{ withSession: true }]);
    expect(mockDb.logSaves).toEqual([{ withSession: true }]);
    expect(mockDb.commits).toBe(1);
    const [comentario] = mockDb.comments;
    expect(comentario.texto).toBe('Revisar os números');
    expect(String(comentario.user)).toBe(colaborador._id);
    expect(String(comentario.tarefa)).toBe(tarefa._id);
    expect(mockDb.logs[0]).toMatchObject({ tipoAcao: 'comentario', detalhes: 'Comentário adicionado' });
    expect(String(mockDb.logs[0].tarefa)).toBe(tarefa._id);
    expect(String(mockDb.logs[0].user)).toBe(colaborador._id);
    expect(mockDb.keys[0]).toMatchObject({
      userId: colaborador._id, key: KEY, method: 'POST', route: '/api/tarefas/:id/comentarios', status: 'completed',
      result: { statusCode: 201, resourceType: 'comentario', resourceId: String(comentario._id) },
    });
    expect(response.body._id).toBe(String(comentario._id));
  });

  test('3 e 4. repeticao: mesmo comentario, 201, sem novo comentario e sem novo log', async () => {
    const first = await post('Revisar os números', { key: KEY });
    for (let i = 0; i < 3; i += 1) {
      const again = await post('Revisar os números', { key: KEY.toUpperCase() });
      expect(again.status).toBe(201);
      expect(again.headers['idempotency-replayed']).toBe('true');
      expect(again.body).toEqual(first.body);
    }
    expect(mockDb.comments).toHaveLength(1);
    expect(mockDb.logs).toHaveLength(1);
    expect(mockDb.commentSaves).toHaveLength(1);
    expect(mockDb.logSaves).toHaveLength(1);
  });

  test('5. mesma chave com texto ou tarefa diferentes: 422 sem publicar', async () => {
    await post('Revisar os números', { key: KEY });
    for (const options of [
      { texto: 'Revisar os números!' },
      { texto: 'revisar os números' },
      { texto: 'Revisar os números', tarefaId: outraTarefa._id },
    ]) {
      const response = await post(options.texto, { key: KEY, tarefaId: options.tarefaId });
      expect(response.status).toBe(422);
      expect(response.body).toEqual({ erro: 'Esta chave de idempotência já foi usada com outro pedido.', code: 'idempotency_key_reused' });
    }
    expect(mockDb.comments).toHaveLength(1);
    expect(mockDb.logs).toHaveLength(1);
  });

  test('6. requisicoes simultaneas: uma publica; a outra recebe 409; nada aparece antes do commit', async () => {
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    mockTx.pauseSave = () => gate;
    const firstRun = post('Revisar os números', { key: KEY }).then((response) => response);
    let first;
    try {
      const deadline = Date.now() + 5000;
      while (mockDb.pausedSaves === 0) {
        if (Date.now() > deadline) throw new Error('o primeiro comentario nao chegou ao ponto de pausa');
        await new Promise((resolve) => setImmediate(resolve));
      }
      expect(mockDb.comments).toHaveLength(0);
      expect(mockDb.logs).toHaveLength(0);

      mockTx.pauseSave = null;
      const second = await post('Revisar os números', { key: KEY });
      expect(second.status).toBe(409);
      expect(second.body.code).toBe('idempotency_in_progress');
      expect(second.headers['retry-after']).toBe('2');
    } finally {
      // Sempre libera a requisicao pausada, mesmo se uma verificacao acima falhar (senao o Jest nao encerra).
      mockTx.pauseSave = null;
      release();
      first = await firstRun.catch((err) => ({ status: undefined, requestError: err }));
    }
    expect(first.status).toBe(201);
    const third = await post('Revisar os números', { key: KEY });
    expect(third.status).toBe(201);
    expect(third.body._id).toBe(first.body._id);
    expect(mockDb.comments).toHaveLength(1);
    expect(mockDb.logs).toHaveLength(1);
  });

  test('7. permissoes: fora da equipe 404 (guardado); admin criador pode; token invalido ou revogado 401', async () => {
    const fora = await post('Oi', { key: KEY, token: issueAuthToken(colaboradorFora) });
    expect(fora.status).toBe(404);
    expect(fora.body).toEqual(TAREFA_404);
    const consultas = mockDb.tarefaFindSessions.length;
    const repetida = await post('Oi', { key: KEY, token: issueAuthToken(colaboradorFora) });
    expect(repetida.status).toBe(404);
    expect(repetida.headers['idempotency-replayed']).toBe('true');
    expect(mockDb.tarefaFindSessions).toHaveLength(consultas); // repeticao nao consulta de novo
    expect(mockDb.comments).toHaveLength(0);

    // Admin que so criou a equipe (nao e membro) tem acesso, como no legado.
    expect((await post('Comentário do admin', { key: KEY_2, token: issueAuthToken(admin) })).status).toBe(201);

    expect((await post('Oi', { key: KEY, token: 'nao-e-um-jwt' })).status).toBe(401);
    const revoked = tokenUser;
    colaborador.authVersion = 1;
    expect((await post('Oi', { key: KEY, token: revoked })).status).toBe(401);
    expect(mockDb.keys.map((row) => row.userId).sort()).toEqual([admin._id, colaboradorFora._id].sort());
  });

  test('7b. texto invalido e ID malformado: 400/404 antes da chave, com as mensagens do legado', async () => {
    for (const extra of [{}, { texto: '' }, { texto: 123 }, { texto: ['a'] }, { texto: { $ne: null } }]) {
      const protegido = await post(undefined, { key: KEY, extra });
      const legado = await post(undefined, { extra });
      expect(protegido.status).toBe(400);
      expect(protegido.body).toEqual({ erro: 'Texto do comentário vazio' });
      expect(legado.body).toEqual(protegido.body);
    }
    const malformado = await post('Oi', { key: KEY, tarefaId: 'nao-e-id' });
    expect(malformado.status).toBe(404);
    expect(malformado.body).toEqual(TAREFA_404);
    expect(mockDb.keys).toHaveLength(0);
    expect(mockDb.sessions).toBe(0);
  });

  test('8. falha ao salvar o comentario: rollback; a mesma chave publica uma unica vez depois', async () => {
    mockTx.failCommentSave = new Error('falha interna /tmp/segredo');
    const failed = await post('Revisar', { key: KEY });
    expect(failed.status).toBe(500);
    expect(failed.body).toEqual({ erro: 'Erro ao adicionar comentário' });
    expect(JSON.stringify(failed.body)).not.toContain('segredo');
    expect(mockDb.comments).toHaveLength(0);
    expect(mockDb.logs).toHaveLength(0);
    expect(mockDb.keys[0]).toMatchObject({ status: 'failed', failure: { retryable: true } });

    mockTx.failCommentSave = null;
    expect((await post('Revisar', { key: KEY })).status).toBe(201);
    expect(mockDb.comments).toHaveLength(1);
    expect(mockDb.logs).toHaveLength(1);
  });

  test('8b. falha ao registrar o log: comentario e chave tambem voltam; nada fica pela metade', async () => {
    mockTx.failLogSave = new Error('log fora do ar');
    const failed = await post('Revisar', { key: KEY });
    expect(failed.status).toBe(500);
    expect(mockDb.commentSaves).toEqual([{ withSession: true }]); // gravado na sessao...
    expect(mockDb.comments).toHaveLength(0); // ...e desfeito junto com o log
    expect(mockDb.logs).toHaveLength(0);
    expect(mockDb.keys[0].status).not.toBe('completed');
    expect(mockDb.keys[0].result).toBeUndefined();

    mockTx.failLogSave = null;
    const retry = await post('Revisar', { key: KEY });
    expect(retry.status).toBe(201);
    expect(mockDb.comments).toHaveLength(1);
    expect(mockDb.logs).toHaveLength(1);
  });

  test('8c. conflito transitorio: o withTransaction repete e fica um comentario e um log', async () => {
    mockTx.commitPlan = ['transient', 'transient'];
    expect((await post('Revisar', { key: KEY })).status).toBe(201);
    expect(mockDb.commentSaves).toHaveLength(3);
    expect(mockDb.comments).toHaveLength(1);
    expect(mockDb.logs).toHaveLength(1);
  });

  test('9. commit com resultado desconhecido: sem confirmacao nao publica de novo; se entrou, responde 201', async () => {
    mockTx.commitPlan = ['unknown_not_applied'];
    const unknown = await post('Revisar', { key: KEY });
    expect(unknown.status).toBe(409);
    expect(unknown.body.code).toBe('idempotency_outcome_unknown');
    expect(unknown.body.erro).toContain('comentário');
    expect((await post('Revisar', { key: KEY })).status).toBe(409);
    expect(mockDb.comments).toHaveLength(0);

    mockTx.commitPlan = ['unknown_applied'];
    expect((await post('Revisar', { key: KEY_2 })).status).toBe(201);
    expect((await post('Revisar', { key: KEY_2 })).headers['idempotency-replayed']).toBe('true');
    expect(mockDb.comments).toHaveLength(1);
    expect(mockDb.logs).toHaveLength(1);
  });

  test('10. sem transacoes ou sem o indice unico: 503 sem publicar; o fluxo sem cabecalho segue funcionando', async () => {
    mockTx.supported = false;
    const semTx = await post('Revisar', { key: KEY });
    expect(semTx.status).toBe(503);
    expect(semTx.body).toEqual({ erro: 'Serviço temporariamente indisponível.', code: 'transactions_unavailable' });
    expect(semTx.headers['retry-after']).toBe('2');
    expect((await post('Revisar')).status).toBe(201);
    mockTx.supported = true;

    for (const indexes of [[{ key: { _id: 1 }, name: '_id_' }], new Error('ns not found')]) {
      mockTx.indexes = indexes;
      app = loadApp();
      const response = await post('Revisar', { key: KEY });
      expect(response.status).toBe(503);
      expect(response.body.code).toBe('idempotency_unavailable');
    }
    expect(mockDb.comments).toHaveLength(1); // so o do fluxo legado
    expect(mockDb.keys).toHaveLength(0);
  });

  test('11. formato da resposta igual ao legado (autor populado so com nome); texto fora do registro da chave', async () => {
    const legado = await post('Comentário legado');
    const protegido = await post('Comentário protegido', { key: KEY });
    expect(keysOf(protegido.body)).toEqual(keysOf(legado.body));
    expect(protegido.body.user).toEqual({ _id: colaborador._id, nome: 'Pessoa Ficticia' });
    expect(keysOf(protegido.body.user)).toEqual(keysOf(legado.body.user));
    expect(protegido.body).toMatchObject({ texto: 'Comentário protegido', tarefa: tarefa._id });
    const stored = JSON.stringify(mockDb.keys);
    for (const text of ['Comentário', 'protegido', 'Pessoa Ficticia', 'Bearer']) {
      expect(stored).not.toContain(text);
    }
  });

  test('12. revalidacao na repeticao: saiu da equipe, comentario ou tarefa excluidos, sessao revogada', async () => {
    const created = await post('Revisar', { key: KEY });
    expect(created.status).toBe(201);

    equipe.membros = []; // saiu da equipe depois de publicar
    const semAcesso = await post('Revisar', { key: KEY });
    expect(semAcesso.status).toBe(404);
    expect(semAcesso.body).toEqual(TAREFA_404);
    expect(JSON.stringify(semAcesso.body)).not.toContain('Revisar');
    equipe.membros = [colaborador._id];

    const comentario = mockDb.comments.pop(); // comentario excluido
    const semComentario = await post('Revisar', { key: KEY });
    expect(semComentario.status).toBe(404);
    expect(semComentario.body).toEqual({ erro: 'Comentário não encontrado' });
    mockDb.comments.push(comentario);

    mockDb.tarefas.splice(mockDb.tarefas.indexOf(tarefa), 1); // tarefa excluida
    expect((await post('Revisar', { key: KEY })).status).toBe(404);
    mockDb.tarefas.push(tarefa);

    colaborador.authVersion = 1; // sessao revogada
    expect((await post('Revisar', { key: KEY })).status).toBe(401);
    expect(mockDb.comments).toHaveLength(1);
    expect(mockDb.logs).toHaveLength(1);
    expect(mockDb.commentSaves).toHaveLength(1);
  });

  test('identidade so do JWT: user no corpo e ignorado; chave invalida responde 400 sem cair no legado', async () => {
    const spoof = await post('Oi', { key: KEY, extra: { user: admin._id } });
    expect(spoof.status).toBe(201);
    expect(String(mockDb.comments[0].user)).toBe(colaborador._id);
    expect(mockDb.keys[0].userId).toBe(colaborador._id);

    for (const key of ['', 'abc', `${KEY}, ${KEY_2}`]) {
      const response = await post('Oi', { key });
      expect(response.status).toBe(400);
      expect(response.body).toEqual({ erro: 'Chave de idempotência inválida.', code: 'idempotency_key_invalid' });
    }
    expect(mockDb.comments).toHaveLength(1);
  });
});
