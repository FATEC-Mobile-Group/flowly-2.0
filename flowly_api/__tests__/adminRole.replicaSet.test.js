// Gestao de perfis user <-> admin contra um MongoDB real em replica set DESCARTAVEL (nunca producao).
// So aqui a atomicidade e a trava (RoleLock) sao comprovadas: os testes em memoria serializam as transacoes.
// Sem FLOWLY_TEST_REPLSET_URI a suite e pulada. Mesmo replica set local de faceRecovery.replicaSet.test.js:
//   mongod --replSet rs0 --port 27999 --bind_ip 127.0.0.1 --dbpath <pasta-temporaria>
//   (uma vez) db.adminCommand({ replSetInitiate: { _id: 'rs0', members: [{ _id: 0, host: '127.0.0.1:27999' }] } })
//   FLOWLY_TEST_REPLSET_URI="mongodb://127.0.0.1:27999/flowly_roles_test?replicaSet=rs0" npx jest adminRole.replicaSet --runInBand
// Banco proprio (flowly_roles_test), separado do flowly_recovery_test da recuperacao facial: a suite apaga o
// banco inteiro no inicio e no fim. Ao rodar as duas suites juntas, cada uma precisa da sua URI.
const REPLSET_URI = process.env.FLOWLY_TEST_REPLSET_URI;
// Porta do replica set de homologacao: nunca o MongoDB original da 27017 (nem a porta padrao omitida).
const HOMOLOGATION_PORT = '27999';
// Exatamente flowly_roles_test, ou com sufixo de teste (flowly_roles_test_ci, flowly_roles_test_2).
const ROLES_DB_PATTERN = /^flowly_roles_test(_[a-z0-9]{1,32})?$/;

jest.mock('@google-cloud/storage', () => ({
  Storage: jest.fn().mockImplementation(() => ({ bucket: jest.fn().mockReturnValue({ file: jest.fn() }) })),
}));
const mockIo = { disconnected: [] };
jest.mock('../utils/socketInstance', () => ({
  setIo: jest.fn(),
  getIo: () => ({ in: (room) => ({ disconnectSockets: () => mockIo.disconnected.push(room) }) }),
}));

jest.setTimeout(60000);

// Recusa qualquer coisa que nao seja um replica set local com o banco descartavel desta suite.
// Devolve o nome do banco validado, que e o usado na conexao.
const assertDisposableUri = (uri) => {
  const parsed = new URL(uri);
  const dbName = decodeURIComponent(parsed.pathname.replace(/^\//, ''));
  if (
    parsed.protocol !== 'mongodb:' ||
    !['127.0.0.1', 'localhost'].includes(parsed.hostname) ||
    parsed.port !== HOMOLOGATION_PORT ||
    !ROLES_DB_PATTERN.test(dbName) ||
    !parsed.searchParams.get('replicaSet')
  ) {
    throw new Error(`FLOWLY_TEST_REPLSET_URI deve ser mongodb://127.0.0.1:${HOMOLOGATION_PORT}/flowly_roles_test?replicaSet=<nome> (sufixo opcional: flowly_roles_test_<teste>)`);
  }
  return dbName;
};

const describeReplicaSet = REPLSET_URI ? describe : describe.skip;

describeReplicaSet('gestao de perfis com transacao real do MongoDB', () => {
  const mongoose = require('mongoose');
  const config = require('../config/config');
  const User = require('../models/User');
  const Equipe = require('../models/Equipe');
  const Tarefa = require('../models/Tarefa');
  const FaceProfile = require('../models/FaceProfile');
  const RoleLock = require('../models/RoleLock');
  const RoleChangeEvent = require('../models/RoleChangeEvent');
  const { resetTransactionSupportCache, supportsTransactions } = require('../utils/mongoTransactions');
  const { assertActiveSession, socketSessionRoom } = require('../utils/sessionGuard');
  const service = require('../services/adminRoleService');

  const OPERATOR = 'operador-perfis@teste.invalid';
  const REASON = 'Homologacao em replica set descartavel.';
  const asOperator = { kind: 'operator', operator: OPERATOR };
  const asAdmin = (account) => ({ kind: 'admin', userId: String(account._id) });
  const MODELS = [User, Equipe, Tarefa, FaceProfile, RoleLock, RoleChangeEvent];
  const originalOperators = [...config.adminRoles.operators];

  const raw = (model, filter) => model.collection.findOne(filter);
  const createUser = async (overrides = {}) => {
    const [doc] = await User.create([{
      nome: 'Conta Ficticia', email: `${new mongoose.Types.ObjectId()}@teste.invalid`, senha: 'hash-ficticio',
      tipo: 'user', verificado: true, ...overrides,
    }]);
    return doc;
  };
  const withFace = async (account) => {
    await FaceProfile.collection.insertOne({ userId: account._id, enrolled: true, model: 'VGG-Face', embeddings: [[1, 0]] });
    return account;
  };
  const createTeam = async (creator, membros = []) => {
    const [doc] = await Equipe.create([{ nome: 'Equipe Ficticia', createdBy: creator._id, membros: [creator._id, ...membros.map((m) => m._id)] }]);
    return doc;
  };
  const adminCount = () => User.countDocuments({ tipo: 'admin' });
  const lockVersion = async () => (await raw(RoleLock, { _id: service.ROLE_LOCK_ID }))?.version ?? 0;
  const claimsOf = (account, tipo, av) => ({ id: String(account._id), tipo, av });

  beforeAll(async () => {
    const dbName = assertDisposableUri(REPLSET_URI);
    config.adminRoles.operators = [OPERATOR];
    await mongoose.connect(REPLSET_URI, { dbName });
    // So apaga se a conexao caiu exatamente no banco validado.
    expect(mongoose.connection.name).toBe(dbName);
    await mongoose.connection.dropDatabase();
    // Colecoes criadas antes: em transacao o banco nao deve depender de criacao implicita.
    await Promise.all(MODELS.map((model) => model.createCollection()));
    resetTransactionSupportCache();
  });

  afterAll(async () => {
    config.adminRoles.operators = originalOperators;
    if (mongoose.connection.readyState === 1) {
      await mongoose.connection.dropDatabase();
      await mongoose.disconnect();
    }
  });

  beforeEach(async () => {
    jest.restoreAllMocks();
    mockIo.disconnected = [];
    await Promise.all(MODELS.map((model) => model.deleteMany({})));
  });

  test('o replica set e reconhecido como transacional', async () => {
    expect(await supportsTransactions()).toBe(true);
  });

  describe('bootstrap', () => {
    test('primeiro admin: perfil, authVersion, auditoria persistida e trava criada', async () => {
      const alvo = await createUser();

      await service.bootstrapFirstAdmin({ targetUserId: alvo._id, actor: asOperator, reason: REASON });

      expect(await raw(User, { _id: alvo._id })).toEqual(expect.objectContaining({ tipo: 'admin', authVersion: 1 }));
      const eventos = await RoleChangeEvent.collection.find({}).toArray();
      expect(eventos).toEqual([expect.objectContaining({ action: 'bootstrap', fromRole: 'user', toRole: 'admin', actorKind: 'operator' })]);
      expect(String(eventos[0].targetUserId)).toBe(String(alvo._id));
      expect(await lockVersion()).toBe(1);
    });

    test('com admin existente o bootstrap e recusado e nada e gravado', async () => {
      await createUser({ tipo: 'admin' });
      const alvo = await createUser();

      await expect(service.bootstrapFirstAdmin({ targetUserId: alvo._id, actor: asOperator, reason: REASON }))
        .rejects.toMatchObject({ code: 'admins_exist' });
      expect((await raw(User, { _id: alvo._id })).tipo).toBe('user');
      expect(await RoleChangeEvent.countDocuments({})).toBe(0);
      expect(await lockVersion()).toBe(0);
    });

    test('dois bootstraps simultaneos (trava ainda inexistente): no fim existe exatamente um admin', async () => {
      const [a, b] = await Promise.all([createUser(), createUser()]);

      const results = await Promise.allSettled([
        service.bootstrapFirstAdmin({ targetUserId: a._id, actor: asOperator, reason: REASON }),
        service.bootstrapFirstAdmin({ targetUserId: b._id, actor: asOperator, reason: REASON }),
      ]);

      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(results.find((r) => r.status === 'rejected').reason).toMatchObject({ code: 'admins_exist' });
      expect(await adminCount()).toBe(1);
      expect(await RoleChangeEvent.countDocuments({})).toBe(1);
    });
  });

  describe('promocao e rebaixamento', () => {
    test('promocao valida: authVersion + 1 e a sessao anterior deixa de valer', async () => {
      const admin = await withFace(await createUser({ tipo: 'admin' }));
      const alvo = await withFace(await createUser());
      await expect(assertActiveSession(claimsOf(alvo, 'user', 0))).resolves.toEqual({ tipo: 'user', authVersion: 0 });

      await service.promoteToAdmin({ targetUserId: alvo._id, actor: asAdmin(admin), reason: REASON });

      expect(await raw(User, { _id: alvo._id })).toEqual(expect.objectContaining({ tipo: 'admin', authVersion: 1 }));
      await expect(assertActiveSession(claimsOf(alvo, 'user', 0))).rejects.toMatchObject({ statusCode: 401 });
      await expect(assertActiveSession(claimsOf(alvo, 'admin', 1))).resolves.toEqual({ tipo: 'admin', authVersion: 1 });
      expect(mockIo.disconnected).toEqual([socketSessionRoom(alvo._id)]);
    });

    test('tarefa aberta real impede a promocao', async () => {
      const admin = await withFace(await createUser({ tipo: 'admin' }));
      const alvo = await withFace(await createUser());
      const equipe = await createTeam(admin, [alvo]);
      await Tarefa.create([{ descricao: 'Aberta', dataEntrega: new Date(), equipe: equipe._id, user: alvo._id, status: 'em_andamento' }]);

      await expect(service.promoteToAdmin({ targetUserId: alvo._id, actor: asAdmin(admin), reason: REASON }))
        .rejects.toMatchObject({ code: 'open_tasks', details: { openTasks: 1 } });
      expect((await raw(User, { _id: alvo._id })).tipo).toBe('user');
    });

    test('rebaixamento valido: authVersion + 1 e sessao anterior invalida', async () => {
      const autor = await withFace(await createUser({ tipo: 'admin' }));
      const alvo = await withFace(await createUser({ tipo: 'admin', authVersion: 2 }));

      await service.demoteToUser({ targetUserId: alvo._id, actor: asAdmin(autor), reason: REASON });

      expect(await raw(User, { _id: alvo._id })).toEqual(expect.objectContaining({ tipo: 'user', authVersion: 3 }));
      await expect(assertActiveSession(claimsOf(alvo, 'admin', 2))).rejects.toMatchObject({ statusCode: 401 });
    });

    test('ultimo administrador nao pode ser rebaixado', async () => {
      const unico = await createUser({ tipo: 'admin' });

      await expect(service.demoteToUser({ targetUserId: unico._id, actor: asOperator, reason: REASON }))
        .rejects.toMatchObject({ code: 'last_admin' });
      expect(await raw(User, { _id: unico._id })).toEqual(expect.objectContaining({ tipo: 'admin', authVersion: 0 }));
      expect(await RoleChangeEvent.countDocuments({})).toBe(0);
    });

    test('transferencia de equipes acontece na mesma transacao do rebaixamento', async () => {
      const autor = await withFace(await createUser({ tipo: 'admin' }));
      const alvo = await createUser({ tipo: 'admin' });
      const membro = await createUser();
      const equipe = await createTeam(alvo, [membro]);

      const result = await service.demoteToUser({ targetUserId: alvo._id, actor: asAdmin(autor), reason: REASON, transferTeamsTo: autor._id });

      const atual = await raw(Equipe, { _id: equipe._id });
      expect(String(atual.createdBy)).toBe(String(autor._id));
      expect(atual.membros.map(String)).toEqual(expect.arrayContaining([String(alvo._id), String(membro._id), String(autor._id)]));
      expect(result.transferredTeamIds).toEqual([String(equipe._id)]);
      const [evento] = await RoleChangeEvent.collection.find({}).toArray();
      expect(evento.transferredTeamIds.map(String)).toEqual([String(equipe._id)]);
    });
  });

  describe('concorrencia (conflito de escrita real na trava)', () => {
    const demoteBothOnce = async (withLock) => {
      await Promise.all(MODELS.map((model) => model.deleteMany({})));
      if (withLock) await RoleLock.collection.insertOne({ _id: service.ROLE_LOCK_ID, version: 0 });
      const [a, b] = await Promise.all([createUser({ tipo: 'admin' }), createUser({ tipo: 'admin' })]);
      const results = await Promise.allSettled([
        service.demoteToUser({ targetUserId: a._id, actor: asOperator, reason: REASON }),
        service.demoteToUser({ targetUserId: b._id, actor: asOperator, reason: REASON }),
      ]);
      return { results, admins: await adminCount(), events: await RoleChangeEvent.countDocuments({}) };
    };

    test.each([
      ['trava ja existente', true],
      ['trava criada no primeiro uso (upsert concorrente)', false],
    ])('dois rebaixamentos simultaneos dos dois unicos admins, %s: nunca zera os admins (10 rodadas)', async (_caso, withLock) => {
      for (let round = 0; round < 10; round += 1) {
        const { results, admins, events } = await demoteBothOnce(withLock);

        expect(admins).toBe(1);
        expect(events).toBe(1);
        expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
        expect(results.find((r) => r.status === 'rejected').reason).toMatchObject({ code: 'last_admin' });
      }
    });
  });

  describe('falha de auditoria', () => {
    test('rollback real: perfil, authVersion, equipes e trava voltam ao estado anterior', async () => {
      const autor = await withFace(await createUser({ tipo: 'admin' }));
      const alvo = await createUser({ tipo: 'admin' });
      const equipe = await createTeam(alvo);
      await RoleLock.collection.insertOne({ _id: service.ROLE_LOCK_ID, version: 5 });
      jest.spyOn(RoleChangeEvent, 'create').mockImplementationOnce(() => Promise.reject(new Error('falha simulada na auditoria')));

      await expect(service.demoteToUser({ targetUserId: alvo._id, actor: asAdmin(autor), reason: REASON, transferTeamsTo: autor._id }))
        .rejects.toThrow('falha simulada');

      expect(await raw(User, { _id: alvo._id })).toEqual(expect.objectContaining({ tipo: 'admin', authVersion: 0 }));
      expect(String((await raw(Equipe, { _id: equipe._id })).createdBy)).toBe(String(alvo._id));
      expect(await lockVersion()).toBe(5);
      expect(await RoleChangeEvent.countDocuments({})).toBe(0);
      expect(mockIo.disconnected).toEqual([]);
    });
  });

  // Premissa da protecao otimista de editarEquipe (controllers/equipeController.js): no MongoDB real, o
  // filtro { membros: [lista] } via Mongoose so casa com o array exatamente igual (mesmos ids, mesma ordem).
  describe('condicao de lista exata usada na edicao de equipes', () => {
    test('lista lida grava; lista desatualizada ou em outra ordem nao grava', async () => {
      const [criador, a, b] = await Promise.all([createUser({ tipo: 'admin' }), createUser(), createUser()]);
      const equipe = await createTeam(criador, [a, b]);
      const lida = Array.from((await Equipe.findOne({ _id: equipe._id }).select('membros')).membros);

      const desatualizada = await Equipe.findOneAndUpdate(
        { _id: equipe._id, membros: [criador._id, a._id] }, { membros: [criador._id] }, { new: true }
      );
      const outraOrdem = await Equipe.findOneAndUpdate(
        { _id: equipe._id, membros: [b._id, a._id, criador._id] }, { membros: [criador._id] }, { new: true }
      );
      expect(desatualizada).toBeNull();
      expect(outraOrdem).toBeNull();
      expect((await raw(Equipe, { _id: equipe._id })).membros.map(String)).toEqual([criador, a, b].map((u) => String(u._id)));

      const atual = await Equipe.findOneAndUpdate({ _id: equipe._id, membros: lida }, { membros: [criador._id, b._id] }, { new: true });
      expect(atual.membros.map(String)).toEqual([String(criador._id), String(b._id)]);

      // A mesma lista lida, agora desatualizada, nao grava de novo (a segunda edicao concorrente).
      const segunda = await Equipe.findOneAndUpdate({ _id: equipe._id, membros: lida }, { membros: [criador._id, a._id] }, { new: true });
      expect(segunda).toBeNull();
      expect((await raw(Equipe, { _id: equipe._id })).membros.map(String)).toEqual([String(criador._id), String(b._id)]);
    });
  });

  // Script do operador (scripts/adminRole.js) contra o mesmo banco descartavel, ja conectado.
  describe('script adminRole.js', () => {
    const { run } = require('../scripts/adminRole');
    const SNAPSHOT_MODELS = [User, Equipe, Tarefa, FaceProfile, RoleLock, RoleChangeEvent];
    let output;

    const cli = (argv) => run(argv, {
      service,
      configuredUri: () => REPLSET_URI,
      connect: async () => {},
      disconnect: async () => {},
      databaseName: () => mongoose.connection.name,
      log: (line) => output.log.push(line),
      error: (line) => output.error.push(line),
    });
    const result = () => JSON.parse(output.log.at(-1));
    const dbSnapshot = async () => JSON.stringify(
      await Promise.all(SNAPSHOT_MODELS.map((model) => model.collection.find({}).sort({ _id: 1 }).toArray()))
    );
    const allOutput = () => [...output.log, ...output.error].join('\n');

    beforeEach(() => {
      output = { log: [], error: [] };
    });

    test('--dry-run de promocao nao grava nada: nem trava, nem auditoria, nem authVersion', async () => {
      const admin = await withFace(await createUser({ tipo: 'admin' }));
      const alvo = await withFace(await createUser({ email: 'alvo-cli@teste.invalid' }));
      const before = await dbSnapshot();

      const code = await cli(['promote', '--email', 'alvo-cli@teste.invalid', '--operator', OPERATOR, '--reason', REASON, '--dry-run']);

      expect(code).toBe(0);
      expect(result()).toEqual(expect.objectContaining({
        mode: 'dry-run', nothingWritten: true, action: 'promote', userId: String(alvo._id), fromRole: 'user', toRole: 'admin',
      }));
      expect(await dbSnapshot()).toBe(before);
      expect(await raw(RoleLock, { _id: service.ROLE_LOCK_ID })).toBeNull();
      expect(mockIo.disconnected).toEqual([]);
      expect(admin).toBeDefined();
    });

    test('--dry-run informa a pre-condicao que impediria a gravacao, sem gravar', async () => {
      await withFace(await createUser({ tipo: 'admin' }));
      const alvo = await withFace(await createUser());
      const equipe = await createTeam(alvo);
      await Tarefa.create([{ descricao: 'Aberta', dataEntrega: new Date(), equipe: equipe._id, user: alvo._id }]);
      const before = await dbSnapshot();

      const code = await cli(['promote', '--user-id', String(alvo._id), '--operator', OPERATOR, '--reason', REASON, '--dry-run']);

      expect(code).toBe(1);
      expect(output.error[0]).toBe('ERRO [open_tasks]: A conta tem tarefas abertas atribuidas. Reatribua ou conclua antes de promover. (openTasks=1)');
      expect(await dbSnapshot()).toBe(before);
    });

    test('--apply promove com auditoria e authVersion + 1', async () => {
      await withFace(await createUser({ tipo: 'admin' }));
      const alvo = await withFace(await createUser({ email: 'alvo-apply@teste.invalid' }));

      const code = await cli(['promote', '--email', ' ALVO-APPLY@teste.invalid ', '--operator', OPERATOR, '--reason', REASON, '--apply', '--expect-db', 'flowly_roles_test']);

      expect(code).toBe(0);
      expect(result()).toEqual({ mode: 'apply', action: 'promote', userId: String(alvo._id), role: 'admin' });
      expect(await raw(User, { _id: alvo._id })).toEqual(expect.objectContaining({ tipo: 'admin', authVersion: 1 }));
      expect(await RoleChangeEvent.countDocuments({ action: 'promote', actorOperator: OPERATOR })).toBe(1);
    });

    test('bootstrap pelo script: --dry-run nao grava e --apply cria o primeiro admin', async () => {
      const alvo = await createUser({ email: 'primeiro@teste.invalid' });
      const before = await dbSnapshot();

      expect(await cli(['bootstrap', '--email', 'primeiro@teste.invalid', '--operator', OPERATOR, '--reason', REASON, '--dry-run'])).toBe(0);
      expect(await dbSnapshot()).toBe(before);

      expect(await cli(['bootstrap', '--email', 'primeiro@teste.invalid', '--operator', OPERATOR, '--reason', REASON, '--apply', '--expect-db', 'flowly_roles_test'])).toBe(0);
      expect((await raw(User, { _id: alvo._id })).tipo).toBe('admin');
      expect(await adminCount()).toBe(1);
    });

    test('demote pelo script com transferencia de equipes', async () => {
      const destino = await withFace(await createUser({ tipo: 'admin', email: 'destino@teste.invalid' }));
      const alvo = await createUser({ tipo: 'admin', email: 'rebaixar@teste.invalid' });
      const equipe = await createTeam(alvo);

      const code = await cli([
        'demote', '--email', 'rebaixar@teste.invalid', '--operator', OPERATOR, '--reason', REASON,
        '--transfer-to-email', 'destino@teste.invalid', '--apply', '--expect-db', 'flowly_roles_test',
      ]);

      expect(code).toBe(0);
      expect(result().transferredTeamIds).toEqual([String(equipe._id)]);
      expect(String((await raw(Equipe, { _id: equipe._id })).createdBy)).toBe(String(destino._id));
      expect((await raw(User, { _id: alvo._id })).tipo).toBe('user');
    });

    test('ultimo administrador continua protegido pelo script', async () => {
      await createUser({ tipo: 'admin', email: 'unico@teste.invalid' });
      const before = await dbSnapshot();

      const code = await cli(['demote', '--email', 'unico@teste.invalid', '--operator', OPERATOR, '--reason', REASON, '--apply', '--expect-db', 'flowly_roles_test']);

      expect(code).toBe(1);
      expect(output.error[0]).toMatch(/^ERRO \[last_admin\]/);
      expect(await dbSnapshot()).toBe(before);
    });

    test('operador fora da lista: recusado e nada gravado', async () => {
      await withFace(await createUser({ tipo: 'admin' }));
      await withFace(await createUser({ email: 'alvo-intruso@teste.invalid' }));
      const before = await dbSnapshot();

      const code = await cli(['promote', '--email', 'alvo-intruso@teste.invalid', '--operator', 'intruso@teste.invalid', '--reason', REASON, '--apply', '--expect-db', 'flowly_roles_test']);

      expect(code).toBe(1);
      expect(output.error[0]).toMatch(/^ERRO \[invalid_actor\]/);
      expect(await dbSnapshot()).toBe(before);
    });

    test('--apply com --expect-db de outro banco nao grava nada no banco conectado', async () => {
      await withFace(await createUser({ tipo: 'admin' }));
      await withFace(await createUser({ email: 'alvo-destino@teste.invalid' }));
      const before = await dbSnapshot();

      const code = await cli(['promote', '--email', 'alvo-destino@teste.invalid', '--operator', OPERATOR, '--reason', REASON, '--apply', '--expect-db', 'Flowly']);

      expect(code).toBe(1);
      expect(output.error[0]).toMatch(/^ERRO \[unexpected_database\]/);
      expect(await dbSnapshot()).toBe(before);
    });

    test('list mostra o resumo sem senha, authVersion, e-mail completo ou URL do banco', async () => {
      await withFace(await createUser({ tipo: 'admin', email: 'admin-lista@teste.invalid', nome: 'Admin Lista' }));

      expect(await cli(['list', '--operator', OPERATOR])).toBe(0);

      const resumo = result();
      expect(resumo.adminCount).toBe(1);
      expect(resumo.admins[0]).toEqual(expect.objectContaining({ nome: 'Admin Lista', email: 'a***@teste.invalid', faceProfileEnrolled: true }));
      expect(output.log[0]).toBe('Banco: flowly_roles_test');
      expect(allOutput()).not.toMatch(/admin-lista@|hash-ficticio|senha|authVersion|mongodb:\/\/|27999/);
    });
  });
});

test('a URI do replica set descartavel recusa producao, remotos, outras portas e bancos fora do padrao', () => {
  const check = (uri) => () => assertDisposableUri(uri);
  // Recusadas: Atlas, remoto, porta diferente da 27999 (inclusive a 27017 e a omitida), banco de producao,
  // sem replica set, banco de outra suite ou fora do padrao.
  [
    'mongodb+srv://user:pass@cluster0.example.mongodb.net/flowly_roles_test?replicaSet=rs0',
    'mongodb://10.0.0.5:27999/flowly_roles_test?replicaSet=rs0',
    'mongodb://db.example.com:27999/flowly_roles_test?replicaSet=rs0',
    'mongodb://127.0.0.1:27017/Flowly?replicaSet=rs0',
    'mongodb://127.0.0.1:27017/flowly_roles_test?replicaSet=rs0',
    'mongodb://localhost/flowly_roles_test?replicaSet=rs0',
    'mongodb://127.0.0.1:28000/flowly_roles_test?replicaSet=rs0',
    'mongodb://127.0.0.1:27999/flowly_roles_test',
    'mongodb://127.0.0.1:27999/flowly_recovery_test?replicaSet=rs0',
    'mongodb://127.0.0.1:27999/flowly_roles_testing?replicaSet=rs0',
    'mongodb://127.0.0.1:27999/flowly_roles_test_prod-copy?replicaSet=rs0',
    'mongodb://127.0.0.1:27999/flowly_roles?replicaSet=rs0',
    'mongodb://127.0.0.1:27999/?replicaSet=rs0',
    'mongodb://127.0.0.1:27999/flowly_roles_test%2Fadmin?replicaSet=rs0',
  ].forEach((uri) => expect(check(uri)).toThrow('flowly_roles_test'));

  expect(assertDisposableUri('mongodb://127.0.0.1:27999/flowly_roles_test?replicaSet=rs0')).toBe('flowly_roles_test');
  expect(assertDisposableUri('mongodb://localhost:27999/flowly_roles_test_ci?replicaSet=rs0')).toBe('flowly_roles_test_ci');
});
