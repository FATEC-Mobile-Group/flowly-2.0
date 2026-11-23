// Nucleo de gestao de perfis user <-> admin: regras, transacao, trava, auditoria e revogacao de sessoes.
// Banco e transacao simulados em memoria (helpers/memoryModel); nenhum banco real, rota ou script.

const mockDb = { users: [], equipes: [], tarefas: [], faces: [], roleLocks: [], roleChanges: [] };
const mockTx = { supported: true };
const mockIo = { disconnected: [] };

jest.mock('../models/User', () => require('./helpers/memoryModel').createMemoryModel(mockDb, 'users'));
jest.mock('../models/Equipe', () => require('./helpers/memoryModel').createMemoryModel(mockDb, 'equipes'));
jest.mock('../models/Tarefa', () => require('./helpers/memoryModel').createMemoryModel(mockDb, 'tarefas'));
jest.mock('../models/FaceProfile', () => require('./helpers/memoryModel').createMemoryModel(mockDb, 'faces'));
jest.mock('../models/RoleLock', () => require('./helpers/memoryModel').createMemoryModel(mockDb, 'roleLocks'));
jest.mock('../models/RoleChangeEvent', () => require('./helpers/memoryModel').createMemoryModel(mockDb, 'roleChanges'));
jest.mock('../utils/mongoTransactions', () =>
  require('./helpers/memoryModel').createMemoryTransactions(
    mockDb, ['users', 'equipes', 'tarefas', 'faces', 'roleLocks', 'roleChanges'], mockTx
  )
);
jest.mock('../utils/socketInstance', () => ({
  setIo: jest.fn(),
  getIo: () => ({ in: (room) => ({ disconnectSockets: () => mockIo.disconnected.push(room) }) }),
}));

const config = require('../config/config');
const User = require('../models/User');
const RoleChangeEvent = require('../models/RoleChangeEvent');
const transactions = require('../utils/mongoTransactions');
const { assertActiveSession, socketSessionRoom } = require('../utils/sessionGuard');
const { newId } = require('./helpers/memoryModel');
const service = require('../services/adminRoleService');

const OPERATOR = 'operador-perfis@teste.invalid';
const REASON = 'Homologacao do nucleo de perfis administrativos.';
const asOperator = { kind: 'operator', operator: OPERATOR };
const asAdmin = (user) => ({ kind: 'admin', userId: String(user._id) });

const user = (overrides = {}) => {
  const doc = {
    _id: newId(), nome: 'Conta Ficticia', email: `${newId()}@teste.invalid`, senha: 'hash-ficticio',
    tipo: 'user', verificado: true, authVersion: 0, ...overrides,
  };
  mockDb.users.push(doc);
  return doc;
};
const withFace = (account) => {
  mockDb.faces.push({ _id: newId(), userId: account._id, enrolled: true });
  return account;
};
const team = (creator, membros = []) => {
  const doc = { _id: newId(), nome: 'Equipe Ficticia', createdBy: creator._id, membros: [creator._id, ...membros.map((m) => m._id)] };
  mockDb.equipes.push(doc);
  return doc;
};
const task = (assignee, status = 'pendente') => {
  const doc = { _id: newId(), descricao: 'Tarefa', user: assignee._id, status };
  mockDb.tarefas.push(doc);
  return doc;
};
const byId = (collection, id) => mockDb[collection].find((item) => String(item._id) === String(id));
const lockVersion = () => byId('roleLocks', service.ROLE_LOCK_ID).version;
const snapshot = () => JSON.stringify({ users: mockDb.users, equipes: mockDb.equipes, roleChanges: mockDb.roleChanges, roleLocks: mockDb.roleLocks });
const expectError = async (promise, statusCode, code) => {
  await expect(promise).rejects.toMatchObject({ name: 'AdminRoleError', statusCode, code });
};
const claimsOf = (account, tipo = account.tipo, av = 0) => ({ id: String(account._id), tipo, av });

const originalOperators = [...config.adminRoles.operators];

beforeEach(() => {
  jest.clearAllMocks();
  Object.assign(mockDb, {
    users: [], equipes: [], tarefas: [], faces: [], roleChanges: [],
    // Em producao o upsert cria a trava; aqui ela ja existe.
    roleLocks: [{ _id: service.ROLE_LOCK_ID, version: 0 }],
  });
  mockTx.supported = true;
  mockIo.disconnected = [];
  config.adminRoles.operators = [OPERATOR];
});

afterAll(() => {
  config.adminRoles.operators = originalOperators;
});

describe('primeiro administrador (bootstrap)', () => {
  test('sem nenhum admin, operador listado promove conta confirmada, mesmo sem biometria', async () => {
    const alvo = user();

    const result = await service.bootstrapFirstAdmin({ targetUserId: alvo._id, actor: asOperator, reason: REASON });

    expect(result).toEqual({ userId: String(alvo._id), role: 'admin' });
    expect(byId('users', alvo._id)).toEqual(expect.objectContaining({ tipo: 'admin', authVersion: 1 }));
    expect(mockDb.roleChanges).toEqual([expect.objectContaining({
      action: 'bootstrap', targetUserId: String(alvo._id), fromRole: 'user', toRole: 'admin',
      actorKind: 'operator', actorOperator: OPERATOR, reason: REASON, faceProfileEnrolled: false,
    })]);
    expect(lockVersion()).toBe(1);
    expect(mockIo.disconnected).toEqual([socketSessionRoom(alvo._id)]);
  });

  test('ja existindo admin, o bootstrap e recusado e nada muda', async () => {
    user({ tipo: 'admin' });
    const alvo = user();
    const before = snapshot();

    await expectError(service.bootstrapFirstAdmin({ targetUserId: alvo._id, actor: asOperator, reason: REASON }), 409, 'admins_exist');

    expect(snapshot()).toBe(before);
    expect(mockIo.disconnected).toEqual([]);
  });

  test.each([
    ['operador fora da lista', { kind: 'operator', operator: 'intruso@teste.invalid' }, undefined],
    ['lista de operadores vazia', asOperator, () => { config.adminRoles.operators = []; }],
    ['autor admin (nao ha admin para autorizar)', null, undefined],
    ['autor ausente', undefined, undefined],
  ])('recusado: %s', async (_caso, actor, arrange) => {
    arrange?.();
    const alvo = user();
    const autor = actor === null ? asAdmin(user({ tipo: 'user' })) : actor;

    await expectError(service.bootstrapFirstAdmin({ targetUserId: alvo._id, actor: autor, reason: REASON }), 403, 'invalid_actor');
    expect(byId('users', alvo._id).tipo).toBe('user');
    expect(mockDb.roleChanges).toHaveLength(0);
  });

  test('conta com e-mail nao confirmado ou com tarefa aberta nao vira o primeiro admin', async () => {
    const naoConfirmada = user({ verificado: false });
    const comTarefa = user();
    task(comTarefa, 'em_andamento');

    await expectError(service.bootstrapFirstAdmin({ targetUserId: naoConfirmada._id, actor: asOperator, reason: REASON }), 409, 'email_not_verified');
    await expectError(service.bootstrapFirstAdmin({ targetUserId: comTarefa._id, actor: asOperator, reason: REASON }), 409, 'open_tasks');
    expect(mockDb.users.every((account) => account.tipo === 'user')).toBe(true);
  });
});

describe('promocao user -> admin', () => {
  let admin;

  beforeEach(() => {
    admin = withFace(user({ tipo: 'admin' }));
  });

  test('admin promove conta confirmada, com biometria e sem tarefas abertas', async () => {
    const alvo = withFace(user());
    task(alvo, 'concluido');

    await service.promoteToAdmin({ targetUserId: alvo._id, actor: asAdmin(admin), reason: REASON });

    expect(byId('users', alvo._id)).toEqual(expect.objectContaining({ tipo: 'admin', authVersion: 1 }));
    expect(mockDb.roleChanges).toEqual([expect.objectContaining({
      action: 'promote', fromRole: 'user', toRole: 'admin', actorKind: 'admin', actorUserId: String(admin._id), faceProfileEnrolled: true,
    })]);
  });

  test('operador listado tambem promove', async () => {
    const alvo = withFace(user());

    await service.promoteToAdmin({ targetUserId: alvo._id, actor: asOperator, reason: REASON });

    expect(byId('users', alvo._id).tipo).toBe('admin');
    expect(mockDb.roleChanges[0]).toEqual(expect.objectContaining({ actorKind: 'operator', actorOperator: OPERATOR }));
  });

  test('sessoes anteriores deixam de valer e as conexoes em tempo real caem', async () => {
    const alvo = withFace(user());
    await expect(assertActiveSession(claimsOf(alvo))).resolves.toEqual({ tipo: 'user', authVersion: 0 });

    await service.promoteToAdmin({ targetUserId: alvo._id, actor: asAdmin(admin), reason: REASON });

    await expect(assertActiveSession(claimsOf(alvo, 'user', 0))).rejects.toMatchObject({ statusCode: 401 });
    await expect(assertActiveSession(claimsOf(alvo, 'admin', 1))).resolves.toEqual({ tipo: 'admin', authVersion: 1 });
    expect(mockIo.disconnected).toEqual([socketSessionRoom(alvo._id)]);
  });

  test('autopromocao: uma conta user que se apresenta como autor admin e recusada', async () => {
    const comum = withFace(user());

    await expectError(service.promoteToAdmin({ targetUserId: comum._id, actor: asAdmin(comum), reason: REASON }), 403, 'self_change');
    const outro = withFace(user());
    await expectError(service.promoteToAdmin({ targetUserId: outro._id, actor: asAdmin(comum), reason: REASON }), 403, 'invalid_actor');
    expect([byId('users', comum._id).tipo, byId('users', outro._id).tipo]).toEqual(['user', 'user']);
    expect(mockDb.roleChanges).toHaveLength(0);
  });

  test('autor admin inexistente ou que ja nao e admin e recusado', async () => {
    const alvo = withFace(user());

    await expectError(service.promoteToAdmin({ targetUserId: alvo._id, actor: { kind: 'admin', userId: String(newId()) }, reason: REASON }), 403, 'invalid_actor');
    byId('users', admin._id).tipo = 'user';
    await expectError(service.promoteToAdmin({ targetUserId: alvo._id, actor: asAdmin(admin), reason: REASON }), 403, 'invalid_actor');
  });

  test.each([
    ['conta inexistente', () => String(newId()), 404, 'not_found'],
    ['id malformado', () => 'nao-e-id', 404, 'not_found'],
    ['e-mail nao confirmado', () => withFace(user({ verificado: false }))._id, 409, 'email_not_verified'],
    ['ja administradora', () => withFace(user({ tipo: 'admin' }))._id, 409, 'already_admin'],
    ['sem verificacao facial', () => user()._id, 409, 'face_profile_required'],
  ])('recusada: %s', async (_caso, alvoId, status, code) => {
    const before = snapshot();
    const id = alvoId();
    const depois = snapshot();

    await expectError(service.promoteToAdmin({ targetUserId: id, actor: asAdmin(admin), reason: REASON }), status, code);

    expect(snapshot()).toBe(depois);
    expect(before.length).toBeGreaterThan(0);
  });

  test('tarefas abertas atribuidas impedem a promocao e o erro informa quantas', async () => {
    const alvo = withFace(user());
    task(alvo, 'pendente');
    task(alvo, 'em_andamento');
    task(alvo, 'concluido');

    await expect(service.promoteToAdmin({ targetUserId: alvo._id, actor: asAdmin(admin), reason: REASON }))
      .rejects.toMatchObject({ statusCode: 409, code: 'open_tasks', details: { openTasks: 2 } });
    expect(byId('users', alvo._id).tipo).toBe('user');
  });

  test.each([['', 400], ['curto', 400], ['x'.repeat(501), 400], [null, 400]])('motivo invalido (%p) e recusado', async (motivo, status) => {
    const alvo = withFace(user());

    await expectError(service.promoteToAdmin({ targetUserId: alvo._id, actor: asAdmin(admin), reason: motivo }), status, 'invalid_reason');
  });

  test('promover preserva as equipes da conta (continua membro)', async () => {
    const alvo = withFace(user());
    const equipe = team(admin, [alvo]);

    await service.promoteToAdmin({ targetUserId: alvo._id, actor: asAdmin(admin), reason: REASON });

    expect(byId('equipes', equipe._id).membros.map(String)).toContain(String(alvo._id));
  });
});

describe('rebaixamento admin -> user', () => {
  let autor;

  beforeEach(() => {
    autor = withFace(user({ tipo: 'admin' }));
  });

  test('admin rebaixa outro admin sem equipes: perfil, authVersion, auditoria e sessoes', async () => {
    const alvo = withFace(user({ tipo: 'admin', authVersion: 3 }));

    const result = await service.demoteToUser({ targetUserId: alvo._id, actor: asAdmin(autor), reason: REASON });

    expect(result).toEqual({ userId: String(alvo._id), role: 'user', transferredTeamIds: [] });
    expect(byId('users', alvo._id)).toEqual(expect.objectContaining({ tipo: 'user', authVersion: 4 }));
    expect(mockDb.roleChanges).toEqual([expect.objectContaining({ action: 'demote', fromRole: 'admin', toRole: 'user', actorUserId: String(autor._id) })]);
    await expect(assertActiveSession(claimsOf(alvo, 'admin', 3))).rejects.toMatchObject({ statusCode: 401 });
    expect(mockIo.disconnected).toEqual([socketSessionRoom(alvo._id)]);
  });

  test('ultimo administrador nao pode ser rebaixado (operador)', async () => {
    const before = snapshot();

    await expectError(service.demoteToUser({ targetUserId: autor._id, actor: asOperator, reason: REASON }), 409, 'last_admin');

    expect(snapshot()).toBe(before);
  });

  test('ninguem rebaixa a si mesmo', async () => {
    withFace(user({ tipo: 'admin' }));

    await expectError(service.demoteToUser({ targetUserId: autor._id, actor: asAdmin(autor), reason: REASON }), 403, 'self_change');
    expect(byId('users', autor._id).tipo).toBe('admin');
  });

  test('conta que nao e admin: 409', async () => {
    const comum = user();

    await expectError(service.demoteToUser({ targetUserId: comum._id, actor: asAdmin(autor), reason: REASON }), 409, 'not_admin');
  });

  describe('administrador criador de equipes', () => {
    let alvo;
    let membro;
    let equipeA;
    let equipeB;

    beforeEach(() => {
      alvo = withFace(user({ tipo: 'admin' }));
      membro = user();
      equipeA = team(alvo, [membro]);
      equipeB = team(alvo);
    });

    test('sem transferencia: 409 informando quantas equipes e nada muda', async () => {
      const before = snapshot();

      await expect(service.demoteToUser({ targetUserId: alvo._id, actor: asAdmin(autor), reason: REASON }))
        .rejects.toMatchObject({ statusCode: 409, code: 'owns_teams', details: { teams: 2 } });
      expect(snapshot()).toBe(before);
    });

    test('com transferencia: equipes passam ao outro admin, que entra como membro; o rebaixado continua membro', async () => {
      const result = await service.demoteToUser({ targetUserId: alvo._id, actor: asAdmin(autor), reason: REASON, transferTeamsTo: autor._id });

      expect(result.transferredTeamIds.sort()).toEqual([String(equipeA._id), String(equipeB._id)].sort());
      [equipeA, equipeB].forEach((equipe) => {
        const atual = byId('equipes', equipe._id);
        expect(String(atual.createdBy)).toBe(String(autor._id));
        expect(atual.membros.map(String)).toEqual(expect.arrayContaining([String(autor._id), String(alvo._id)]));
      });
      expect(byId('equipes', equipeA._id).membros.map(String)).toContain(String(membro._id));
      expect(byId('users', alvo._id).tipo).toBe('user');
      expect(mockDb.roleChanges[0]).toEqual(expect.objectContaining({ transferredTo: String(autor._id) }));
    });

    test.each([
      ['para conta que nao e admin', () => user()._id, 409],
      ['para conta inexistente', () => newId(), 409],
      ['para a propria conta rebaixada', () => alvo._id, 400],
    ])('transferencia %s e recusada e nada muda', async (_caso, destino, status) => {
      const id = destino();
      const before = snapshot();

      await expectError(service.demoteToUser({ targetUserId: alvo._id, actor: asAdmin(autor), reason: REASON, transferTeamsTo: id }), status, 'invalid_transfer');
      expect(snapshot()).toBe(before);
    });
  });
});

describe('concorrencia', () => {
  test('dois rebaixamentos simultaneos dos dois unicos admins: exatamente um conclui', async () => {
    const a = withFace(user({ tipo: 'admin' }));
    const b = withFace(user({ tipo: 'admin' }));

    const results = await Promise.allSettled([
      service.demoteToUser({ targetUserId: a._id, actor: asOperator, reason: REASON }),
      service.demoteToUser({ targetUserId: b._id, actor: asOperator, reason: REASON }),
    ]);

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.find((r) => r.status === 'rejected').reason).toMatchObject({ code: 'last_admin' });
    expect(mockDb.users.filter((account) => account.tipo === 'admin')).toHaveLength(1);
    expect(mockDb.roleChanges).toHaveLength(1);
    expect(lockVersion()).toBe(1);
  });

  test('duas promocoes simultaneas da mesma conta: uma conclui, a outra recebe already_admin', async () => {
    const admin = withFace(user({ tipo: 'admin' }));
    const alvo = withFace(user());

    const results = await Promise.allSettled([
      service.promoteToAdmin({ targetUserId: alvo._id, actor: asAdmin(admin), reason: REASON }),
      service.promoteToAdmin({ targetUserId: alvo._id, actor: asAdmin(admin), reason: REASON }),
    ]);

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.find((r) => r.status === 'rejected').reason).toMatchObject({ code: 'already_admin' });
    expect(byId('users', alvo._id).authVersion).toBe(1);
    expect(mockDb.roleChanges).toHaveLength(1);
  });

  test('perfil alterado por fora entre a leitura e a gravacao: conflito, sem auditoria', async () => {
    const admin = withFace(user({ tipo: 'admin' }));
    const alvo = withFace(user());
    User.findOneAndUpdate.mockImplementationOnce(async () => null);

    await expectError(service.promoteToAdmin({ targetUserId: alvo._id, actor: asAdmin(admin), reason: REASON }), 409, 'conflict');
    expect(mockDb.roleChanges).toHaveLength(0);
    expect(mockIo.disconnected).toEqual([]);
  });
});

describe('falhas de transacao e auditoria', () => {
  test('sem suporte a transacoes: 503 e nada e feito', async () => {
    mockTx.supported = false;
    const admin = withFace(user({ tipo: 'admin' }));
    const alvo = withFace(user());
    const before = snapshot();

    await expectError(service.promoteToAdmin({ targetUserId: alvo._id, actor: asAdmin(admin), reason: REASON }), 503, 'transactions_unavailable');
    expect(transactions.runInTransaction).not.toHaveBeenCalled();
    expect(snapshot()).toBe(before);
  });

  test('falha ao gravar a auditoria desfaz a promocao (sem mudanca sem registro)', async () => {
    const admin = withFace(user({ tipo: 'admin' }));
    const alvo = withFace(user());
    const before = snapshot();
    RoleChangeEvent.create.mockImplementationOnce(async () => { throw new Error('falha simulada na auditoria'); });

    await expect(service.promoteToAdmin({ targetUserId: alvo._id, actor: asAdmin(admin), reason: REASON })).rejects.toThrow('falha simulada');

    expect(snapshot()).toBe(before);
    expect(byId('users', alvo._id)).toEqual(expect.objectContaining({ tipo: 'user', authVersion: 0 }));
    expect(mockIo.disconnected).toEqual([]);
  });

  test('falha ao gravar a auditoria desfaz o rebaixamento e a transferencia das equipes', async () => {
    const autor = withFace(user({ tipo: 'admin' }));
    const alvo = withFace(user({ tipo: 'admin' }));
    const equipe = team(alvo);
    const before = snapshot();
    RoleChangeEvent.create.mockImplementationOnce(async () => { throw new Error('falha simulada na auditoria'); });

    await expect(service.demoteToUser({ targetUserId: alvo._id, actor: asAdmin(autor), reason: REASON, transferTeamsTo: autor._id })).rejects.toThrow();

    expect(snapshot()).toBe(before);
    expect(String(byId('equipes', equipe._id).createdBy)).toBe(String(alvo._id));
  });

  test('auditoria guarda o essencial e nada sensivel', async () => {
    const admin = withFace(user({ tipo: 'admin' }));
    const alvo = withFace(user({ email: 'alvo-secreto@teste.invalid', senha: 'hash-secreto' }));

    await service.promoteToAdmin({ targetUserId: alvo._id, actor: asAdmin(admin), reason: REASON });

    const [evento] = mockDb.roleChanges;
    expect(Object.keys(evento).sort()).toEqual(
      ['_id', 'action', 'actorKind', 'actorUserId', 'faceProfileEnrolled', 'fromRole', 'reason', 'targetUserId', 'toRole'].sort()
    );
    expect(JSON.stringify(evento)).not.toMatch(/alvo-secreto|hash-secreto|senha|token/);
    expect(RoleChangeEvent.create).toHaveBeenCalledWith([expect.any(Object)], { session: expect.any(Object) });
  });

  test('a mudanca, a trava e a auditoria usam a mesma sessao de transacao', async () => {
    const admin = withFace(user({ tipo: 'admin' }));
    const alvo = withFace(user());

    await service.promoteToAdmin({ targetUserId: alvo._id, actor: asAdmin(admin), reason: REASON });

    const sessoes = [
      require('../models/RoleLock').findOneAndUpdate.mock.calls[0][2].session,
      User.findOneAndUpdate.mock.calls[0][2].session,
      RoleChangeEvent.create.mock.calls[0][1].session,
    ];
    expect(new Set(sessoes.map((s) => s.id)).size).toBe(1);
  });
});
