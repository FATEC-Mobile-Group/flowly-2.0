// Recuperacao facial contra um MongoDB real em replica set DESCARTAVEL (nunca producao).
// Sem FLOWLY_TEST_REPLSET_URI a suite e pulada. Exemplo de replica set local de no unico:
//   mongod --replSet rs0 --port 27999 --bind_ip 127.0.0.1 --dbpath <pasta-temporaria>
//   (uma vez) db.adminCommand({ replSetInitiate: { _id: 'rs0', members: [{ _id: 0, host: '127.0.0.1:27999' }] } })
//   FLOWLY_TEST_REPLSET_URI="mongodb://127.0.0.1:27999/flowly_recovery_test?replicaSet=rs0" npx jest faceRecovery.replicaSet
const REPLSET_URI = process.env.FLOWLY_TEST_REPLSET_URI;

jest.mock('@google-cloud/storage', () => ({
  Storage: jest.fn().mockImplementation(() => ({ bucket: jest.fn().mockReturnValue({ file: jest.fn() }) })),
}));
jest.mock('../utils/sendEmail', () => jest.fn(async () => {}));
jest.mock('../utils/socketInstance', () => ({ setIo: jest.fn(), getIo: () => null }));
jest.mock('../services/faceService', () => {
  const faces = { 'dono-frente': [1, 0], 'dono-lado': [0.98, Math.sqrt(1 - 0.98 ** 2)] };
  return {
    extractEmbedding: jest.fn(async (label) => ({ face_detected: true, embedding: faces[label], model: 'VGG-Face' })),
  };
});

jest.setTimeout(60000);

// Recusa qualquer coisa que nao seja um replica set local com banco de teste.
const assertDisposableUri = (uri) => {
  const parsed = new URL(uri);
  const dbName = parsed.pathname.replace(/^\//, '');
  if (
    parsed.protocol !== 'mongodb:' ||
    !['127.0.0.1', 'localhost'].includes(parsed.hostname) ||
    !dbName.startsWith('flowly_recovery_test') ||
    !parsed.searchParams.get('replicaSet')
  ) {
    throw new Error('FLOWLY_TEST_REPLSET_URI deve ser mongodb://127.0.0.1:<porta>/flowly_recovery_test...?replicaSet=<nome>');
  }
};

const describeReplicaSet = REPLSET_URI ? describe : describe.skip;

describeReplicaSet('recuperacao facial com transacao real do MongoDB', () => {
  const mongoose = require('mongoose');
  const argon2 = require('argon2');
  const config = require('../config/config');
  const sendEmail = require('../utils/sendEmail');
  const User = require('../models/User');
  const FaceProfile = require('../models/FaceProfile');
  const TwoFactorToken = require('../models/TwoFactorToken');
  const FaceRecoveryAuthorization = require('../models/FaceRecoveryAuthorization');
  const SecurityAuditEvent = require('../models/SecurityAuditEvent');
  const { decryptEmbeddings } = require('../utils/faceEmbeddingCrypto');
  const { resetTransactionSupportCache, supportsTransactions } = require('../utils/mongoTransactions');
  const service = require('../services/faceRecoveryService');

  const PASSWORD = 'SenhaDoTitular@1';
  const EMAIL = 'titular@teste.invalid';
  const OLD = [[0, 1], [0.1, 0.995]];
  let main;
  let authorization;
  let code;

  const raw = (model, filter) => model.collection.findOne(filter);
  const reenroll = () =>
    service.reenrollWithRecoveryCode({ email: EMAIL, codigo: code, senha: PASSWORD, imagesBase64: ['dono-frente', 'dono-lado'] });

  const expectUntouched = async () => {
    const profile = await raw(FaceProfile, { userId: main._id });
    expect(profile.enrolled).toBe(true);
    expect(profile.embeddings).toEqual(OLD);
    expect(profile.encryptedEmbeddings).toBeUndefined();
    expect((await raw(User, { _id: main._id })).authVersion).toBe(0);
    expect((await raw(FaceRecoveryAuthorization, { _id: authorization._id })).status).toBe('active');
    expect(await raw(TwoFactorToken, { userId: main._id, purpose: 'face_recovery' })).not.toBeNull();
  };

  beforeAll(async () => {
    assertDisposableUri(REPLSET_URI);
    config.face.embeddingKey = Buffer.alloc(32, 9).toString('base64');
    await mongoose.connect(REPLSET_URI);
    await mongoose.connection.dropDatabase();
    // Em transacao nao se cria colecao: todas existem antes, como em producao.
    await Promise.all([User, FaceProfile, TwoFactorToken, FaceRecoveryAuthorization, SecurityAuditEvent].map((model) => model.createCollection()));
    resetTransactionSupportCache();
  });

  afterAll(async () => {
    if (mongoose.connection.readyState === 1) {
      await mongoose.connection.dropDatabase();
      await mongoose.disconnect();
    }
  });

  beforeEach(async () => {
    jest.restoreAllMocks();
    jest.spyOn(console, 'info').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
    await Promise.all([User, FaceProfile, TwoFactorToken, FaceRecoveryAuthorization, SecurityAuditEvent].map((model) => model.deleteMany({})));

    main = await User.create({ nome: 'Titular', email: EMAIL, senha: await argon2.hash(PASSWORD), tipo: 'user', verificado: true });
    // Cadastro legado em texto puro, como os de junho.
    await FaceProfile.collection.insertOne({ userId: main._id, enrolled: true, model: 'VGG-Face', embeddings: OLD });
    authorization = await FaceRecoveryAuthorization.create({
      userId: main._id,
      operator: 'operador@teste.invalid',
      reason: 'Validacao em replica set descartavel.',
      status: 'active',
      ownershipExpiresAt: new Date(Date.now() - 60000),
      activatedAt: new Date(),
      expiresAt: new Date(Date.now() + 30 * 60000),
    });
    await service.sendRecoveryCode(EMAIL);
    code = sendEmail.mock.calls.at(-1)[3].match(/class="code">(\d{6})</)[1];
  });

  test('o replica set e reconhecido como transacional', async () => {
    expect(await supportsTransactions()).toBe(true);
  });

  test('sucesso: perfil criptografado, legado removido, codigo e autorizacao consumidos, sessoes revogadas', async () => {
    await reenroll();

    const profile = await raw(FaceProfile, { userId: main._id });
    expect(profile.enrolled).toBe(true);
    expect(profile.embeddings).toBeUndefined();
    expect(decryptEmbeddings(profile.encryptedEmbeddings)).toEqual([[1, 0], [0.98, Math.sqrt(1 - 0.98 ** 2)]]);
    expect(await raw(TwoFactorToken, { userId: main._id, purpose: 'face_recovery' })).toBeNull();
    expect((await raw(FaceRecoveryAuthorization, { _id: authorization._id })).status).toBe('consumed');
    expect((await raw(User, { _id: main._id })).authVersion).toBe(1);
  });

  test('falha DEPOIS de gravar o perfil: o abort desfaz perfil, codigo, autorizacao e versao', async () => {
    jest.spyOn(User, 'updateOne').mockImplementationOnce(() => Promise.reject(new Error('falha simulada apos o perfil')));

    await expect(reenroll()).rejects.toMatchObject({ statusCode: 500 });

    await expectUntouched();
  });

  test('falha ao gravar o perfil: codigo e autorizacao, ja tocados na transacao, voltam', async () => {
    jest.spyOn(FaceProfile, 'findOneAndUpdate').mockImplementationOnce(() => Promise.reject(new Error('falha simulada no perfil')));

    await expect(reenroll()).rejects.toMatchObject({ statusCode: 500 });

    await expectUntouched();
  });

  test('duas requisicoes simultaneas: exatamente uma conclui', async () => {
    const results = await Promise.allSettled([reenroll(), reenroll()]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((result) => result.status === 'rejected');
    expect([401, 403, 409]).toContain(rejected.reason.statusCode);
    expect((await raw(User, { _id: main._id })).authVersion).toBe(1);
    expect((await raw(FaceRecoveryAuthorization, { _id: authorization._id })).status).toBe('consumed');
    expect(await raw(TwoFactorToken, { userId: main._id, purpose: 'face_recovery' })).toBeNull();
  });
});

// Fluxo completo a partir do operador, no mesmo replica set descartavel: pedido, codigo de titularidade
// (capturado do e-mail simulado), confirmacao, codigo do titular, recadastro e revogacao das sessoes.
// Operadores existem so neste teste (config em memoria); contas, e-mails e embeddings sao ficticios.
describeReplicaSet('operador autoriza e titular recadastra, com MongoDB real', () => {
  const mongoose = require('mongoose');
  const argon2 = require('argon2');
  const config = require('../config/config');
  const sendEmail = require('../utils/sendEmail');
  const User = require('../models/User');
  const FaceProfile = require('../models/FaceProfile');
  const TwoFactorToken = require('../models/TwoFactorToken');
  const FaceRecoveryAuthorization = require('../models/FaceRecoveryAuthorization');
  const SecurityAuditEvent = require('../models/SecurityAuditEvent');
  const { decryptEmbeddings } = require('../utils/faceEmbeddingCrypto');
  const { resetTransactionSupportCache } = require('../utils/mongoTransactions');
  const { issueAuthToken, verifyAuthToken } = require('../utils/faceAuth');
  const { assertActiveSession } = require('../utils/sessionGuard');
  const operatorService = require('../services/faceRecoveryAuthorizationService');
  const service = require('../services/faceRecoveryService');

  const OPERATOR_A = 'operador-a@teste.invalid';
  const OPERATOR_B = 'operador-b@teste.invalid';
  const PASSWORD = 'SenhaFicticia@1';
  const EMAIL = 'titular-operador@teste.invalid';
  const OLD = [[0, 1], [0.1, 0.995]];
  const REASON = 'Homologacao local em replica set descartavel.';
  const MODELS = [User, FaceProfile, TwoFactorToken, FaceRecoveryAuthorization, SecurityAuditEvent];
  const originalOperators = [...config.face.recovery.operators];
  let titular;

  const raw = (model, filter) => model.collection.findOne(filter);
  const lastEmailCode = () => sendEmail.mock.calls.at(-1)[3].match(/class="code">(\d{6})</)[1];
  const lastEmailTo = () => sendEmail.mock.calls.at(-1)[0];
  const minutesAgo = (value) => new Date(Date.now() - value * 60 * 1000);

  const requestOwnership = (overrides = {}) =>
    operatorService.requestAuthorization({ email: EMAIL, operator: OPERATOR_A, reason: REASON, ...overrides });

  // Operador A pede, o titular repassa o codigo do e-mail e o operador A confirma.
  const activateAuthorization = async () => {
    const { authorizationId } = await requestOwnership();
    const ownershipCode = lastEmailCode();
    await operatorService.confirmAuthorization({ authorizationId, operator: OPERATOR_A, code: ownershipCode });
    return authorizationId;
  };

  const requestRecoveryCode = async () => {
    const before = sendEmail.mock.calls.length;
    await service.sendRecoveryCode(EMAIL);
    return sendEmail.mock.calls.length > before ? lastEmailCode() : null;
  };

  const reenroll = (codigo, extra = {}) =>
    service.reenrollWithRecoveryCode({ email: EMAIL, codigo, senha: PASSWORD, imagesBase64: ['dono-frente', 'dono-lado'], ...extra });

  beforeAll(async () => {
    assertDisposableUri(REPLSET_URI);
    config.face.embeddingKey = Buffer.alloc(32, 9).toString('base64');
    config.face.recovery.operators = [OPERATOR_A, OPERATOR_B];
    await mongoose.connect(REPLSET_URI);
    await mongoose.connection.dropDatabase();
    await Promise.all(MODELS.map((model) => model.createCollection()));
    resetTransactionSupportCache();
  });

  afterAll(async () => {
    config.face.recovery.operators = originalOperators;
    if (mongoose.connection.readyState === 1) {
      await mongoose.connection.dropDatabase();
      await mongoose.disconnect();
    }
  });

  beforeEach(async () => {
    jest.restoreAllMocks();
    sendEmail.mockClear();
    jest.spyOn(console, 'info').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    await Promise.all(MODELS.map((model) => model.deleteMany({})));

    titular = await User.create({ nome: 'Titular Ficticio', email: EMAIL, senha: await argon2.hash(PASSWORD), tipo: 'user', verificado: true });
    await FaceProfile.collection.insertOne({ userId: titular._id, enrolled: true, model: 'VGG-Face', embeddings: OLD });
  });

  test('1-3. operador autorizado pede, o codigo vai ao e-mail da conta e o codigo correto ativa', async () => {
    const { authorizationId } = await requestOwnership();

    const pending = await raw(FaceRecoveryAuthorization, { _id: new mongoose.Types.ObjectId(authorizationId) });
    expect(pending).toEqual(expect.objectContaining({ status: 'pending', operator: OPERATOR_A, ownershipAttempts: 0 }));
    expect(pending.ownershipCodeHash).toMatch(/^[a-f\d]{64}$/);
    expect(lastEmailTo()).toBe(EMAIL);
    const ownershipCode = lastEmailCode();
    expect(JSON.stringify(pending)).not.toContain(ownershipCode);

    const confirmed = await operatorService.confirmAuthorization({ authorizationId, operator: OPERATOR_A, code: ownershipCode });

    const active = await raw(FaceRecoveryAuthorization, { _id: pending._id });
    expect(active.status).toBe('active');
    expect(active.ownershipCodeHash).toBeUndefined();
    expect(active.expiresAt.getTime()).toBe(new Date(confirmed.expiresAt).getTime());
    expect(active.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  test('1b. operador fora da lista nao consegue nem pedir', async () => {
    await expect(requestOwnership({ operator: 'intruso@teste.invalid' })).rejects.toThrow('Operador nao autorizado');

    expect(await FaceRecoveryAuthorization.countDocuments({})).toBe(0);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  test('4a. operador diferente nao confirma, e nao gasta tentativas do titular', async () => {
    const { authorizationId } = await requestOwnership();
    const ownershipCode = lastEmailCode();

    await expect(operatorService.confirmAuthorization({ authorizationId, operator: OPERATOR_B, code: ownershipCode }))
      .rejects.toThrow('de outro operador');

    const doc = await raw(FaceRecoveryAuthorization, { _id: new mongoose.Types.ObjectId(authorizationId) });
    expect(doc.status).toBe('pending');
    expect(doc.ownershipAttempts).toBe(0);
  });

  test('4b. codigo incorreto nao ativa e conta tentativa; o correto ainda ativa depois', async () => {
    const { authorizationId } = await requestOwnership();
    const ownershipCode = lastEmailCode();
    const wrong = ownershipCode === '111111' ? '222222' : '111111';

    await expect(operatorService.confirmAuthorization({ authorizationId, operator: OPERATOR_A, code: wrong }))
      .rejects.toThrow('Codigo de titularidade invalido');
    const afterWrong = await raw(FaceRecoveryAuthorization, { _id: new mongoose.Types.ObjectId(authorizationId) });
    expect(afterWrong).toEqual(expect.objectContaining({ status: 'pending', ownershipAttempts: 1 }));

    await operatorService.confirmAuthorization({ authorizationId, operator: OPERATOR_A, code: ownershipCode });
    expect((await raw(FaceRecoveryAuthorization, { _id: afterWrong._id })).status).toBe('active');
  });

  test('4c. cinco codigos incorretos revogam a autorizacao', async () => {
    const { authorizationId } = await requestOwnership();
    const ownershipCode = lastEmailCode();
    const wrong = ownershipCode === '111111' ? '222222' : '111111';

    for (let attempt = 0; attempt < config.face.recovery.maxAttempts; attempt += 1) {
      await expect(operatorService.confirmAuthorization({ authorizationId, operator: OPERATOR_A, code: wrong })).rejects.toThrow();
    }

    const doc = await raw(FaceRecoveryAuthorization, { _id: new mongoose.Types.ObjectId(authorizationId) });
    expect(doc.status).toBe('revoked');
    await expect(operatorService.confirmAuthorization({ authorizationId, operator: OPERATOR_A, code: ownershipCode })).rejects.toThrow();
  });

  test('5. codigo de titularidade vencido e recusado, sem contar tentativa', async () => {
    const { authorizationId } = await requestOwnership({ now: minutesAgo(20) });
    const ownershipCode = lastEmailCode();

    await expect(operatorService.confirmAuthorization({ authorizationId, operator: OPERATOR_A, code: ownershipCode }))
      .rejects.toThrow('expirada');

    const doc = await raw(FaceRecoveryAuthorization, { _id: new mongoose.Types.ObjectId(authorizationId) });
    expect(doc.status).toBe('pending');
    expect(doc.ownershipAttempts).toBe(0);
  });

  test('6. sem autorizacao ativa o titular nao recebe codigo; com ela, recebe so o hash no banco', async () => {
    expect(await requestRecoveryCode()).toBeNull();
    expect(await raw(TwoFactorToken, { userId: titular._id, purpose: 'face_recovery' })).toBeNull();

    await activateAuthorization();
    const code = await requestRecoveryCode();

    expect(code).toMatch(/^\d{6}$/);
    expect(lastEmailTo()).toBe(EMAIL);
    const token = await raw(TwoFactorToken, { userId: titular._id, purpose: 'face_recovery' });
    expect(token.codigo).toMatch(/^[a-f\d]{64}$/);
    expect(token.codigo).not.toBe(code);
    expect(token.criadoEm).toBeInstanceOf(Date);
  });

  test('7-9. codigo, senha e duas fotos recadastram; autorizacao e codigo consumidos; sessoes antigas revogadas', async () => {
    const oldToken = issueAuthToken(titular);
    await expect(assertActiveSession(verifyAuthToken(oldToken))).resolves.toEqual(expect.objectContaining({ authVersion: 0 }));
    const authorizationId = await activateAuthorization();
    const code = await requestRecoveryCode();

    await reenroll(code);

    const profile = await raw(FaceProfile, { userId: titular._id });
    expect(profile.enrolled).toBe(true);
    expect(profile.embeddings).toBeUndefined();
    expect(decryptEmbeddings(profile.encryptedEmbeddings)).toEqual([[1, 0], [0.98, Math.sqrt(1 - 0.98 ** 2)]]);
    const authorization = await raw(FaceRecoveryAuthorization, { _id: new mongoose.Types.ObjectId(authorizationId) });
    expect(authorization.status).toBe('consumed');
    expect(authorization.consumedAt).toBeInstanceOf(Date);
    expect(await raw(TwoFactorToken, { userId: titular._id, purpose: 'face_recovery' })).toBeNull();
    expect((await raw(User, { _id: titular._id })).authVersion).toBe(1);
    await expect(assertActiveSession(verifyAuthToken(oldToken))).rejects.toMatchObject({ statusCode: 401 });
    const freshToken = issueAuthToken(await User.findById(titular._id));
    await expect(assertActiveSession(verifyAuthToken(freshToken))).resolves.toEqual(expect.objectContaining({ authVersion: 1 }));
  });

  test('7b. senha errada ou codigo errado nao recadastram e nada e consumido', async () => {
    const authorizationId = await activateAuthorization();
    const code = await requestRecoveryCode();
    const wrong = code === '111111' ? '222222' : '111111';

    await expect(reenroll(code, { senha: 'SenhaErrada@9' })).rejects.toMatchObject({ statusCode: 401 });
    await expect(reenroll(wrong)).rejects.toMatchObject({ statusCode: 401 });

    expect((await raw(FaceProfile, { userId: titular._id })).embeddings).toEqual(OLD);
    expect((await raw(FaceRecoveryAuthorization, { _id: new mongoose.Types.ObjectId(authorizationId) })).status).toBe('active');
    expect((await raw(TwoFactorToken, { userId: titular._id, purpose: 'face_recovery' })).tentativas).toBe(2);
    expect((await raw(User, { _id: titular._id })).authVersion).toBe(0);
  });

  test('10. autorizacao consumida nao serve de novo: sem codigo novo, codigo antigo recusado e reconfirmacao recusada', async () => {
    const authorizationId = await activateAuthorization();
    const code = await requestRecoveryCode();
    await reenroll(code);
    const profileAfter = await raw(FaceProfile, { userId: titular._id });

    expect(await requestRecoveryCode()).toBeNull();
    await expect(reenroll(code)).rejects.toMatchObject({ statusCode: 401 });
    await expect(operatorService.confirmAuthorization({ authorizationId, operator: OPERATOR_A, code: '123456' })).rejects.toThrow();

    expect(await raw(FaceProfile, { userId: titular._id })).toEqual(profileAfter);
    expect((await raw(User, { _id: titular._id })).authVersion).toBe(1);
  });

  test('auditoria no banco real: eventos do operador e do titular, sem codigo, senha, e-mail ou embedding', async () => {
    const { authorizationId } = await requestOwnership();
    const ownershipCode = lastEmailCode();
    await operatorService.confirmAuthorization({ authorizationId, operator: OPERATOR_A, code: ownershipCode });
    const code = await requestRecoveryCode();
    await reenroll(code);

    const events = await SecurityAuditEvent.collection.find({}).toArray();
    expect(events.map((event) => `${event.event}:${event.outcome}`)).toEqual(expect.arrayContaining([
      'face_recovery_authorization_requested:requested',
      'face_recovery_authorized:success',
      'face_recovery_code_requested:requested',
      'face_recovery_completed:success',
    ]));
    const dump = JSON.stringify(events);
    [ownershipCode, code, PASSWORD, EMAIL, '0.98'].forEach((secret) => expect(dump).not.toContain(secret));
  });
});

test('a URI do replica set descartavel recusa producao e bancos que nao sao de teste', () => {
  const check = (uri) => () => assertDisposableUri(uri);
  expect(check('mongodb+srv://user:pass@cluster0.example.mongodb.net/Flowly')).toThrow();
  expect(check('mongodb://127.0.0.1:27017/Flowly?replicaSet=rs0')).toThrow();
  expect(check('mongodb://10.0.0.5:27999/flowly_recovery_test?replicaSet=rs0')).toThrow();
  expect(check('mongodb://127.0.0.1:27999/flowly_recovery_test')).toThrow();
  expect(check('mongodb://127.0.0.1:27999/flowly_recovery_test?replicaSet=rs0')).not.toThrow();
});
