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

test('a URI do replica set descartavel recusa producao e bancos que nao sao de teste', () => {
  const check = (uri) => () => assertDisposableUri(uri);
  expect(check('mongodb+srv://user:pass@cluster0.example.mongodb.net/Flowly')).toThrow();
  expect(check('mongodb://127.0.0.1:27017/Flowly?replicaSet=rs0')).toThrow();
  expect(check('mongodb://10.0.0.5:27999/flowly_recovery_test?replicaSet=rs0')).toThrow();
  expect(check('mongodb://127.0.0.1:27999/flowly_recovery_test')).toThrow();
  expect(check('mongodb://127.0.0.1:27999/flowly_recovery_test?replicaSet=rs0')).not.toThrow();
});
