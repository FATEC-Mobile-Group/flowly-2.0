// Apoio da recuperacao facial: transacoes, codigos de seguranca e trilha de auditoria.
jest.mock('../models/SecurityAuditEvent', () => ({ create: jest.fn(async (entry) => entry) }));

const SecurityAuditEvent = require('../models/SecurityAuditEvent');
const { resetTransactionSupportCache, runInTransaction, supportsTransactions } = require('../utils/mongoTransactions');
const { generateSecurityCode, hashSecurityCode, matchesSecurityCode } = require('../utils/securityCodes');
const { recordSecurityEvent } = require('../utils/securityAudit');

const connectionAnswering = (hello) => ({
  db: { admin: () => ({ command: jest.fn(async () => (hello instanceof Error ? Promise.reject(hello) : hello)) }) },
});

describe('capacidade de transacao do MongoDB', () => {
  beforeEach(() => resetTransactionSupportCache());

  test.each([
    ['replica set (Atlas)', { setName: 'atlas-abc', isWritablePrimary: true }, true],
    ['mongos', { msg: 'isdbgrid' }, true],
    ['standalone (mongo:5 do k8s local)', { isWritablePrimary: true }, false],
  ])('%s', async (_label, hello, expected) => {
    expect(await supportsTransactions(connectionAnswering(hello))).toBe(expected);
  });

  test('sem conexao aberta responde nao e tenta de novo depois', async () => {
    expect(await supportsTransactions({})).toBe(false);
    expect(await supportsTransactions(connectionAnswering({ setName: 'rs0' }))).toBe(true);
  });

  test('erro ao consultar responde nao', async () => {
    expect(await supportsTransactions(connectionAnswering(new Error('timeout')))).toBe(false);
  });
});

describe('runInTransaction', () => {
  const fakeConnection = (behavior = {}) => {
    const session = {
      withTransaction: jest.fn(async (fn) => {
        try {
          await fn();
        } catch (err) {
          session.aborted = true;
          throw err;
        }
      }),
      endSession: jest.fn(async () => {}),
      ...behavior,
    };
    return { session, connection: { startSession: jest.fn(async () => session) } };
  };

  test('entrega a session ao trabalho, devolve o resultado e encerra a session', async () => {
    const { session, connection } = fakeConnection();

    const result = await runInTransaction(async (received) => {
      expect(received).toBe(session);
      return 'ok';
    }, connection);

    expect(result).toBe('ok');
    expect(session.endSession).toHaveBeenCalled();
  });

  test('erro no trabalho aborta, e relancado e a session e encerrada', async () => {
    const { session, connection } = fakeConnection();

    await expect(runInTransaction(async () => { throw new Error('falhou'); }, connection)).rejects.toThrow('falhou');
    expect(session.aborted).toBe(true);
    expect(session.endSession).toHaveBeenCalled();
  });
});

describe('codigos de seguranca', () => {
  test('codigo de 6 digitos e hash HMAC amarrado ao proposito', () => {
    const code = generateSecurityCode();

    expect(code).toMatch(/^\d{6}$/);
    expect(hashSecurityCode('face_recovery', code)).toMatch(/^[a-f\d]{64}$/);
    expect(hashSecurityCode('face_recovery', code)).not.toContain(code);
    expect(matchesSecurityCode('face_recovery', code, hashSecurityCode('face_recovery', code))).toBe(true);
    expect(matchesSecurityCode('face_recovery_ownership', code, hashSecurityCode('face_recovery', code))).toBe(false);
  });

  test.each([
    ['codigo que nao e texto', 123456, 'a'.repeat(64)],
    ['hash ausente', '123456', undefined],
    ['hash malformado', '123456', 'zz'],
  ])('%s nao confere', (_label, code, hash) => {
    expect(matchesSecurityCode('face_recovery', code, hash)).toBe(false);
  });
});

describe('trilha de auditoria', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'info').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    console.info.mockRestore();
    console.error.mockRestore();
  });

  test('so os campos permitidos chegam ao banco e ao log', async () => {
    await recordSecurityEvent({
      event: 'face_recovery_completed',
      outcome: 'denied',
      reason: 'invalid_credentials',
      actor: 'self',
      userId: '507f1f77bcf86cd799439011',
      codigo: '123456',
      senha: 'Senha@1',
      email: 'titular@exemplo.com',
      imagesBase64: ['data:image/jpeg;base64,AAAA'],
      embeddings: [[0.123456]],
      token: 'eyJhbGciOi',
    });

    const stored = SecurityAuditEvent.create.mock.calls[0][0];
    expect(Object.keys(stored).sort()).toEqual(['actor', 'event', 'outcome', 'reason', 'userId']);
    const logged = console.info.mock.calls.flat().join(' ');
    for (const forbidden of ['123456', 'Senha@1', 'titular@', 'base64', '0.123456', 'eyJ']) {
      expect(logged).not.toContain(forbidden);
    }
  });

  test('falha ao gravar nao lanca', async () => {
    SecurityAuditEvent.create.mockRejectedValueOnce(new Error('banco fora'));

    await expect(recordSecurityEvent({ event: 'x', outcome: 'failed', actor: 'system' })).resolves.toBeUndefined();
    expect(console.error).toHaveBeenCalled();
  });
});
