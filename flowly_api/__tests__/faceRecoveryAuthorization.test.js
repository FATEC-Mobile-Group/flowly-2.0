// Autorizacao do operador: depende do codigo de titularidade enviado ao e-mail da conta.
const mockDb = { users: [], faces: [], authorizations: [], audit: [] };

jest.mock('../models/User', () => require('./helpers/memoryModel').createMemoryModel(mockDb, 'users'));
jest.mock('../models/FaceProfile', () => require('./helpers/memoryModel').createMemoryModel(mockDb, 'faces'));
jest.mock('../models/FaceRecoveryAuthorization', () =>
  require('./helpers/memoryModel').createMemoryModel(mockDb, 'authorizations')
);
jest.mock('../models/SecurityAuditEvent', () => require('./helpers/memoryModel').createMemoryModel(mockDb, 'audit'));
jest.mock('../utils/sendEmail', () => jest.fn(async () => {}));

const config = require('../config/config');
const sendEmail = require('../utils/sendEmail');
const service = require('../services/faceRecoveryAuthorizationService');
const { newId } = require('./helpers/memoryModel');

const OPERATOR = 'operador@flowly.test';
const OTHER_OPERATOR = 'outro-operador@flowly.test';
const REASON = 'Titular sem acesso por cadastro facial antigo; pedido registrado no chamado 42.';
const NOW = new Date('2026-11-17T12:00:00Z');
const minutes = (value) => value * 60 * 1000;

const lastCodeSent = () => sendEmail.mock.calls.at(-1)[3].match(/class="code">(\d{6})</)[1];
const authorization = (id) => mockDb.authorizations.find((item) => String(item._id) === String(id));

let user;
const seedAccount = ({ verificado = true, face = true } = {}) => {
  user = { _id: newId(), nome: 'Titular', email: 'titular@exemplo.com', tipo: 'user', verificado };
  mockDb.users.push(user);
  if (face) {
    mockDb.faces.push({ _id: newId(), userId: user._id, enrolled: true });
  }
  return user;
};

const request = (overrides = {}) =>
  service.requestAuthorization({ email: 'Titular@Exemplo.com ', operator: OPERATOR, reason: REASON, now: NOW, ...overrides });

describe('autorizacao excepcional de recuperacao facial', () => {
  const originalOperators = config.face.recovery.operators;

  beforeEach(() => {
    Object.assign(mockDb, { users: [], faces: [], authorizations: [], audit: [] });
    jest.clearAllMocks();
    config.face.recovery.operators = [OPERATOR, OTHER_OPERATOR];
  });

  afterAll(() => {
    config.face.recovery.operators = originalOperators;
  });

  describe('pedido do operador', () => {
    test('sem operadores configurados, a recuperacao fica desligada', async () => {
      seedAccount();
      config.face.recovery.operators = [];

      await expect(request()).rejects.toThrow('Operador nao autorizado');
      expect(mockDb.authorizations).toHaveLength(0);
      expect(sendEmail).not.toHaveBeenCalled();
    });

    test('operador fora da lista e recusado', async () => {
      seedAccount();

      await expect(request({ operator: 'intruso@flowly.test' })).rejects.toThrow('Operador nao autorizado');
      expect(mockDb.authorizations).toHaveLength(0);
    });

    test('justificativa curta e recusada', async () => {
      seedAccount();

      await expect(request({ reason: 'pedido' })).rejects.toThrow('justificativa');
      expect(mockDb.authorizations).toHaveLength(0);
    });

    test.each([
      ['conta inexistente', () => {}],
      ['conta nao verificada', () => seedAccount({ verificado: false })],
      ['conta sem cadastro facial ativo', () => seedAccount({ face: false })],
    ])('%s e recusada sem enviar e-mail', async (_label, seed) => {
      seed();

      await expect(request()).rejects.toThrow();
      expect(mockDb.authorizations).toHaveLength(0);
      expect(sendEmail).not.toHaveBeenCalled();
    });

    test('cria autorizacao pendente, guarda so o hash e envia o codigo ao e-mail da conta', async () => {
      seedAccount();

      const result = await request();

      const created = authorization(result.authorizationId);
      const code = lastCodeSent();
      expect(created).toMatchObject({ status: 'pending', operator: OPERATOR, reason: REASON, ownershipAttempts: 0 });
      expect(String(created.userId)).toBe(user._id);
      expect(created.ownershipExpiresAt.getTime()).toBe(NOW.getTime() + minutes(15));
      expect(JSON.stringify(created)).not.toContain(code);
      expect(sendEmail.mock.calls[0][0]).toBe('titular@exemplo.com');
      expect(JSON.stringify(result)).not.toContain(code);
      expect(mockDb.audit).toEqual([
        expect.objectContaining({ event: 'face_recovery_authorization_requested', outcome: 'requested', operator: OPERATOR }),
      ]);
      expect(JSON.stringify(mockDb.audit)).not.toMatch(new RegExp(`${code}|titular@`));
    });

    test('novo pedido revoga a autorizacao aberta anterior', async () => {
      seedAccount();
      const first = await request();

      await request();

      expect(authorization(first.authorizationId)).toMatchObject({ status: 'revoked' });
      expect(mockDb.authorizations.filter((item) => item.status === 'pending')).toHaveLength(1);
    });

    test('falha no envio do e-mail revoga a autorizacao', async () => {
      seedAccount();
      sendEmail.mockRejectedValueOnce(new Error('smtp fora'));

      await expect(request()).rejects.toThrow('codigo de titularidade');
      expect(mockDb.authorizations[0]).toMatchObject({ status: 'revoked' });
      expect(mockDb.authorizations[0].ownershipCodeHash).toBeUndefined();
    });
  });

  describe('confirmacao com o codigo de titularidade', () => {
    let pending;
    let code;

    beforeEach(async () => {
      seedAccount();
      pending = await request();
      code = lastCodeSent();
    });

    const confirm = (overrides = {}) =>
      service.confirmAuthorization({
        authorizationId: pending.authorizationId,
        operator: OPERATOR,
        code,
        now: new Date(NOW.getTime() + minutes(5)),
        ...overrides,
      });

    test('codigo correto ativa por uma janela curta e descarta o hash', async () => {
      const result = await confirm();

      const active = authorization(pending.authorizationId);
      const confirmedAt = NOW.getTime() + minutes(5);
      expect(active.status).toBe('active');
      expect(active.expiresAt.getTime()).toBe(confirmedAt + minutes(config.face.recovery.windowMinutes));
      expect(config.face.recovery.windowMinutes).toBeLessThanOrEqual(120);
      expect(active.ownershipCodeHash).toBeUndefined();
      expect(result.expiresAt.getTime()).toBe(active.expiresAt.getTime());
      expect(mockDb.audit.at(-1)).toMatchObject({ event: 'face_recovery_authorized', outcome: 'success' });
    });

    test('so o operador que pediu pode confirmar, e o outro nao gasta tentativas', async () => {
      await expect(confirm({ operator: OTHER_OPERATOR })).rejects.toThrow();
      await expect(confirm({ operator: OTHER_OPERATOR, code: '000000' })).rejects.toThrow();

      expect(authorization(pending.authorizationId)).toMatchObject({ status: 'pending', ownershipAttempts: 0 });
    });

    test('codigo errado conta tentativa e a quinta revoga', async () => {
      for (let attempt = 1; attempt <= 4; attempt += 1) {
        await expect(confirm({ code: '000000' })).rejects.toThrow('Codigo de titularidade invalido');
        expect(authorization(pending.authorizationId)).toMatchObject({ status: 'pending', ownershipAttempts: attempt });
      }

      await expect(confirm({ code: '000000' })).rejects.toThrow();
      expect(authorization(pending.authorizationId).status).toBe('revoked');
      await expect(confirm()).rejects.toThrow();
      expect(authorization(pending.authorizationId).status).toBe('revoked');
    });

    test('codigo de titularidade expirado nao ativa nem conta tentativa', async () => {
      const expired = new Date(NOW.getTime() + minutes(16));

      await expect(confirm({ now: expired })).rejects.toThrow();
      await expect(confirm({ now: expired, code: '000000' })).rejects.toThrow();

      expect(authorization(pending.authorizationId)).toMatchObject({ status: 'pending', ownershipAttempts: 0 });
    });

    test('confirmar duas vezes nao reabre nem estende a autorizacao', async () => {
      await confirm();
      const firstExpiry = authorization(pending.authorizationId).expiresAt.getTime();

      await expect(confirm({ now: new Date(NOW.getTime() + minutes(10)) })).rejects.toThrow();
      expect(authorization(pending.authorizationId).expiresAt.getTime()).toBe(firstExpiry);
    });

    test('id que nao e ObjectId e recusado', async () => {
      await expect(confirm({ authorizationId: 'abc' })).rejects.toThrow();
    });
  });

  test('operador revoga autorizacao ativa', async () => {
    seedAccount();
    const pending = await request();
    await service.confirmAuthorization({ authorizationId: pending.authorizationId, operator: OPERATOR, code: lastCodeSent(), now: NOW });

    await service.revokeAuthorization({ authorizationId: pending.authorizationId, operator: OPERATOR, reason: 'Titular desistiu do pedido.', now: NOW });

    expect(authorization(pending.authorizationId)).toMatchObject({ status: 'revoked', revokedReason: 'Titular desistiu do pedido.' });
    expect(mockDb.audit.at(-1)).toMatchObject({ event: 'face_recovery_authorization_revoked', outcome: 'success' });
  });
});
