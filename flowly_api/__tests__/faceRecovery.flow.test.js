// Recadastro facial por recuperacao excepcional: rotas reais, banco e transacao simulados em memoria.
const request = require('supertest');
const argon2 = require('argon2');

// Varias verificacoes argon2 por teste: com a suite inteira em paralelo, 5 s nao bastam.
jest.setTimeout(30000);

const mockDb = { users: [], faces: [], tokens: [], authorizations: [], audit: [] };
const mockTx = { supported: true };
const mockIo = { disconnected: [] };

jest.mock('@google-cloud/storage', () => ({
  Storage: jest.fn().mockImplementation(() => ({ bucket: jest.fn().mockReturnValue({ file: jest.fn() }) })),
}));
jest.mock('../models/User', () => require('./helpers/memoryModel').createMemoryModel(mockDb, 'users'));
jest.mock('../models/FaceProfile', () => require('./helpers/memoryModel').createMemoryModel(mockDb, 'faces'));
jest.mock('../models/TwoFactorToken', () => require('./helpers/memoryModel').createMemoryModel(mockDb, 'tokens'));
jest.mock('../models/FaceRecoveryAuthorization', () =>
  require('./helpers/memoryModel').createMemoryModel(mockDb, 'authorizations')
);
jest.mock('../models/SecurityAuditEvent', () => require('./helpers/memoryModel').createMemoryModel(mockDb, 'audit'));
jest.mock('../utils/mongoTransactions', () =>
  require('./helpers/memoryModel').createMemoryTransactions(mockDb, ['users', 'faces', 'tokens', 'authorizations'], mockTx)
);
jest.mock('../utils/sendEmail', () => jest.fn(async () => {}));
jest.mock('../utils/socketInstance', () => ({
  setIo: jest.fn(),
  getIo: () => ({ in: (room) => ({ disconnectSockets: () => mockIo.disconnected.push(room) }) }),
}));
// Limites por e-mail tem testes proprios; aqui a mesma conta faz muitas tentativas seguidas.
jest.mock('../middlewares/rateLimiters', () => {
  const passThrough = (_req, _res, next) => next();
  return {
    ...jest.requireActual('../middlewares/rateLimiters'),
    emailCodeLimiter: passThrough,
    codeValidationLimiter: passThrough,
    loginLimiter: passThrough,
    faceVerifyLimiter: passThrough,
  };
});

// Servico facial simulado: cada "foto" e um rotulo com um vetor conhecido.
const mockFaces = {};
jest.mock('../services/faceService', () => {
  const { cosineDistance } = require('../utils/faceDistance');
  const failure = (statusCode, message) => Object.assign(new Error(message), { statusCode });
  const embed = (label) => {
    if (label === 'sem-rosto') throw failure(400, 'Não foi possível identificar um rosto na foto.');
    if (label === 'servico-fora') throw failure(503, 'Serviço facial indisponível.');
    return { face_detected: true, embedding: mockFaces[label], model: 'VGG-Face' };
  };
  const compare = (references, label) => {
    const probe = embed(label).embedding;
    const distance = Math.min(...references.map((reference) => cosineDistance(reference, probe)));
    return { match: distance <= 0.5, face_detected: true, distance, threshold: 0.5, model: 'VGG-Face' };
  };
  return {
    extractEmbedding: jest.fn(async (label) => embed(label)),
    verifyFace: jest.fn(async (reference, label) => compare([reference], label)),
    verifyFaceMulti: jest.fn(async (references, label) => compare(references, label)),
    checkHealth: jest.fn(),
  };
});

const config = require('../config/config');
const sendEmail = require('../utils/sendEmail');
const faceService = require('../services/faceService');
const FaceProfile = require('../models/FaceProfile');
const { decryptEmbeddings } = require('../utils/faceEmbeddingCrypto');
const { issueAuthToken } = require('../utils/faceAuth');
const { newId } = require('./helpers/memoryModel');
const operatorService = require('../services/faceRecoveryAuthorizationService');
const app = require('../app');

const PASSWORD = 'SenhaDoTitular@1';
const MAIN_EMAIL = 'titular@exemplo.com';
const OTHER_EMAIL = 'outra@exemplo.com';
const OPERATOR = 'operador@flowly.test';
const minutes = (value) => value * 60 * 1000;
const unit = (vector) => {
  const norm = Math.hypot(...vector);
  return vector.map((value) => value / norm);
};
// Vetor unitario a uma distancia de cosseno exata de [1, 0].
const atDistance = (distance) => [1 - distance, Math.sqrt(1 - (1 - distance) ** 2)];

Object.assign(mockFaces, {
  'dono-frente': [1, 0],
  'dono-lado': atDistance(0.02),
  'rosto-outro': unit([-1, 0.2]),
});
const OLD_MAIN = [unit([0, 1]), unit([0.1, 1])];

const GENERIC_SEND = 'Se a recuperacao facial estiver autorizada para esta conta, um codigo sera enviado ao e-mail cadastrado.';
const INVALID_CREDENTIALS = 'Codigo, e-mail ou senha invalidos.';

let main;
let other;
let passwordHash;

const byId = (collection, id) => mockDb[collection].find((item) => String(item._id) === String(id));
const userNow = () => byId('users', main._id);
const mainFace = () => mockDb.faces.find((face) => String(face.userId) === String(main._id));
const recoveryToken = () => mockDb.tokens.find((token) => token.purpose === 'face_recovery');
const authorizationOf = () => mockDb.authorizations.find((item) => String(item.userId) === String(main._id));
const codeFromEmail = () => sendEmail.mock.calls.at(-1)[3].match(/class="code">(\d{6})</)[1];

const authorize = (overrides = {}) => {
  const authorization = {
    _id: newId(),
    userId: main._id,
    operator: OPERATOR,
    reason: 'Titular sem acesso por cadastro facial antigo.',
    status: 'active',
    ownershipAttempts: 0,
    ownershipExpiresAt: new Date(Date.now() - minutes(5)),
    activatedAt: new Date(),
    expiresAt: new Date(Date.now() + minutes(30)),
    ...overrides,
  };
  mockDb.authorizations.push(authorization);
  return authorization;
};

const sendCode = (email = MAIN_EMAIL) => request(app).post('/api/face/recovery/send-code').send({ email });
const reenroll = (body = {}) =>
  request(app)
    .post('/api/face/recovery/re-enroll')
    .send({ email: MAIN_EMAIL, senha: PASSWORD, imagesBase64: ['dono-frente', 'dono-lado'], ...body });

const authorizedCode = async () => {
  authorize();
  await sendCode();
  return codeFromEmail();
};

const snapshot = () => JSON.stringify({ faces: mockDb.faces, users: mockDb.users, authorizations: mockDb.authorizations });

const expectNothingChanged = (before) => {
  expect(mainFace().enrolled).toBe(true);
  expect(mainFace().embeddings).toEqual(OLD_MAIN);
  expect(mainFace().encryptedEmbeddings).toBeUndefined();
  expect(userNow().authVersion).toBe(0);
  if (before) {
    expect(JSON.stringify({ faces: mockDb.faces, users: mockDb.users })).toBe(
      JSON.stringify({ faces: JSON.parse(before).faces, users: JSON.parse(before).users })
    );
  }
};

beforeAll(async () => {
  config.face.serviceSecret = 'segredo-de-teste';
  config.face.embeddingKey = Buffer.alloc(32, 7).toString('base64');
  passwordHash = await argon2.hash(PASSWORD);
});

const TRANSACTION_MODELS = ['User', 'FaceProfile', 'TwoFactorToken', 'FaceRecoveryAuthorization'].map((name) =>
  require(`../models/${name}`)
);

beforeEach(() => {
  jest.clearAllMocks();
  TRANSACTION_MODELS.forEach((model) => {
    model.sessionsSeen.length = 0;
  });
  Object.assign(mockDb, { users: [], faces: [], tokens: [], authorizations: [], audit: [] });
  mockTx.supported = true;
  mockIo.disconnected = [];
  jest.spyOn(console, 'info').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});

  main = { _id: newId(), nome: 'Titular', email: MAIN_EMAIL, senha: passwordHash, tipo: 'user', verificado: true, authVersion: 0, fotoPerfil: '' };
  other = { _id: newId(), nome: 'Outra', email: OTHER_EMAIL, senha: passwordHash, tipo: 'admin', verificado: true, authVersion: 0, fotoPerfil: '' };
  mockDb.users.push(main, other);
  // Cadastro legado da conta principal: vetores em texto puro que nao reconhecem mais o titular.
  mockDb.faces.push({ _id: newId(), userId: main._id, enrolled: true, model: 'VGG-Face', embeddings: OLD_MAIN });
});

afterEach(() => {
  [console.info, console.warn, console.error].forEach((spy) => spy.mockRestore());
});

describe('pedido do codigo de recuperacao', () => {
  test('sem autorizacao do operador: resposta generica, sem codigo e sem e-mail', async () => {
    const res = await sendCode();

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ msg: GENERIC_SEND });
    expect(mockDb.tokens).toHaveLength(0);
    expect(sendEmail).not.toHaveBeenCalled();
    expect(mockDb.audit).toEqual([expect.objectContaining({ outcome: 'denied', reason: 'not_authorized' })]);
  });

  test.each([
    ['autorizacao expirada', () => authorize({ expiresAt: new Date(Date.now() - 1000) })],
    ['autorizacao so pendente', () => authorize({ status: 'pending' })],
    ['autorizacao ja consumida', () => authorize({ status: 'consumed' })],
    ['autorizacao revogada', () => authorize({ status: 'revoked' })],
  ])('%s: resposta generica e nada enviado', async (_label, seed) => {
    seed();

    const res = await sendCode();

    expect(res.body).toEqual({ msg: GENERIC_SEND });
    expect(mockDb.tokens).toHaveLength(0);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  test('conta inexistente responde igual', async () => {
    const res = await sendCode('ninguem@exemplo.com');

    expect(res.body).toEqual({ msg: GENERIC_SEND });
    expect(sendEmail).not.toHaveBeenCalled();
  });

  test('com autorizacao ativa: grava so o hash e manda o codigo ao e-mail da conta', async () => {
    authorize();

    const res = await sendCode(' Titular@Exemplo.com ');

    const code = codeFromEmail();
    expect(res.body).toEqual({ msg: GENERIC_SEND });
    expect(sendEmail.mock.calls[0][0]).toBe(MAIN_EMAIL);
    expect(recoveryToken().purpose).toBe('face_recovery');
    expect(recoveryToken().tentativas || 0).toBe(0);
    expect(recoveryToken().codigo).toMatch(/^[a-f\d]{64}$/);
    expect(JSON.stringify(mockDb.tokens)).not.toContain(code);
  });

  test('e-mail que nao e texto responde 400', async () => {
    const res = await request(app).post('/api/face/recovery/send-code').send({ email: { $ne: null } });

    expect(res.status).toBe(400);
    expect(mockDb.tokens).toHaveLength(0);
  });
});

describe('recadastro com codigo, senha e duas fotos', () => {
  test.each([
    ['sem codigo', { codigo: undefined }],
    ['sem senha', { senha: '' }],
    ['uma foto so', { imagesBase64: ['dono-frente'] }],
    ['tres fotos', { imagesBase64: ['dono-frente', 'dono-lado', 'dono-lado'] }],
    ['foto que nao e texto', { imagesBase64: ['dono-frente', { $gt: '' }] }],
    ['codigo que nao e texto', { codigo: { $ne: null } }],
  ])('%s: 400 sem tocar no cadastro', async (_label, body) => {
    const code = await authorizedCode();

    const res = await reenroll({ codigo: code, ...body });

    expect(res.status).toBe(400);
    expectNothingChanged();
    expect(faceService.extractEmbedding).not.toHaveBeenCalled();
  });

  test('senha incorreta: 401 generico e conta tentativa', async () => {
    const code = await authorizedCode();

    const res = await reenroll({ codigo: code, senha: 'SenhaErrada@9' });

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ erro: INVALID_CREDENTIALS });
    expect(recoveryToken().tentativas).toBe(1);
    expectNothingChanged();
    expect(faceService.extractEmbedding).not.toHaveBeenCalled();
  });

  test('codigo incorreto: mesma resposta e conta tentativa', async () => {
    await authorizedCode();

    const res = await reenroll({ codigo: '000000' });

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ erro: INVALID_CREDENTIALS });
    expect(recoveryToken().tentativas).toBe(1);
    expectNothingChanged();
  });

  test('sem codigo pedido: 401 generico', async () => {
    authorize();

    expect((await reenroll({ codigo: '123456' })).status).toBe(401);
  });

  test('conta inexistente: mesma resposta generica', async () => {
    const res = await reenroll({ email: 'ninguem@exemplo.com', codigo: '123456' });

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ erro: INVALID_CREDENTIALS });
  });

  test('limite de tentativas: 429, o codigo some e nem o certo funciona depois', async () => {
    const code = await authorizedCode();
    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect((await reenroll({ codigo: '000000' })).status).toBe(401);
    }

    const blocked = await reenroll({ codigo: code });

    expect(blocked.status).toBe(429);
    expect(recoveryToken()).toBeUndefined();
    expect((await reenroll({ codigo: code })).status).toBe(401);
    expectNothingChanged();
  });

  test.each([
    ['revogada', { status: 'revoked' }],
    ['expirada', { expiresAt: new Date(Date.now() - 1000) }],
  ])('autorizacao %s depois do codigo: 403 e nada consumido', async (_label, change) => {
    const code = await authorizedCode();
    Object.assign(authorizationOf(), change);

    const res = await reenroll({ codigo: code });

    expect(res.status).toBe(403);
    expect(recoveryToken()).toBeDefined();
    expectNothingChanged();
    expect(faceService.extractEmbedding).not.toHaveBeenCalled();
  });

  test('foto sem rosto: 400 de foto, sem consumir codigo, autorizacao nem tentativa', async () => {
    const code = await authorizedCode();

    const res = await reenroll({ codigo: code, imagesBase64: ['dono-frente', 'sem-rosto'] });

    expect(res.status).toBe(400);
    expect(res.body.erro).toMatch(/rosto/);
    expect(recoveryToken().tentativas || 0).toBe(0);
    expect(authorizationOf().status).toBe('active');
    expectNothingChanged();
  });

  test('servico facial fora: 503 e nada muda', async () => {
    const code = await authorizedCode();

    const res = await reenroll({ codigo: code, imagesBase64: ['servico-fora', 'dono-lado'] });

    expect(res.status).toBe(503);
    expect(authorizationOf().status).toBe('active');
    expectNothingChanged();
  });

  describe('duplicidade contra outras contas', () => {
    // Do lado oposto ao de 'dono-lado': a distancia mais curta ate as fotos novas e a de 'dono-frente'.
    const mirrored = (distance) => [atDistance(distance)[0], -atDistance(distance)[1]];
    const seedOtherFace = (distance) =>
      mockDb.faces.push({ _id: newId(), userId: other._id, enrolled: true, model: 'VGG-Face', embeddings: [mirrored(distance)] });

    test('outra conta a 0,48 (acima do 0,46 antigo, abaixo do login 0,5): 409 e nada muda', async () => {
      seedOtherFace(0.48);
      const code = await authorizedCode();

      const res = await reenroll({ codigo: code });

      expect(res.status).toBe(409);
      expect(res.body.codigo).toBe('FACE_DUPLICATE');
      expect(authorizationOf().status).toBe('active');
      expect(recoveryToken()).toBeDefined();
      expectNothingChanged();
      expect(sendEmail.mock.calls.some(([to]) => to === OTHER_EMAIL)).toBe(true);
      expect(mockDb.audit.some((event) => event.reason === 'duplicate')).toBe(true);
    });

    test('outra conta a 0,52: recadastro segue', async () => {
      seedOtherFace(0.52);
      const code = await authorizedCode();

      expect((await reenroll({ codigo: code })).status).toBe(200);
    });
  });

  test('MongoDB sem transacao: 503 e nada consumido', async () => {
    const code = await authorizedCode();
    mockTx.supported = false;

    const res = await reenroll({ codigo: code });

    expect(res.status).toBe(503);
    expect(authorizationOf().status).toBe('active');
    expect(recoveryToken()).toBeDefined();
    expectNothingChanged();
    expect(faceService.extractEmbedding).not.toHaveBeenCalled();
  });

  test('falha ao gravar o perfil: transacao desfeita, codigo e autorizacao voltam e a conta segue protegida', async () => {
    const code = await authorizedCode();
    const before = snapshot();
    FaceProfile.findOneAndUpdate.mockRejectedValueOnce(new Error('WriteConflict 10.0.0.5'));

    const res = await reenroll({ codigo: code });

    expect(res.status).toBe(500);
    expect(JSON.stringify(res.body)).not.toMatch(/WriteConflict|10\.0\.0\.5/);
    expect(mockTx.aborted).toBeGreaterThan(0);
    expect(authorizationOf().status).toBe('active');
    expect(recoveryToken()).toBeDefined();
    expectNothingChanged(before);
    expect(mockIo.disconnected).toHaveLength(0);
    expect(sendEmail.mock.calls.filter(([to]) => to === MAIN_EMAIL)).toHaveLength(1);
    expect(mockDb.audit.at(-1)).toMatchObject({ event: 'face_recovery_completed', outcome: 'failed' });
  });

  describe('sucesso', () => {
    let oldToken;
    let code;
    let res;

    beforeEach(async () => {
      oldToken = issueAuthToken(main);
      code = await authorizedCode();
      res = await reenroll({ codigo: code });
    });

    test('responde sem token de acesso', () => {
      expect(res.status).toBe(200);
      expect(Object.keys(res.body)).toEqual(['msg']);
      expect(JSON.stringify(res.body)).not.toMatch(/eyJ/);
    });

    test('grava os embeddings novos criptografados e tira os campos legados, sem desligar o rosto', () => {
      const face = mainFace();

      expect(face.enrolled).toBe(true);
      expect(face.embeddings).toBeUndefined();
      expect(face.embedding).toBeUndefined();
      expect(decryptEmbeddings(face.encryptedEmbeddings)).toEqual([mockFaces['dono-frente'], mockFaces['dono-lado']]);
      expect(JSON.stringify(face.encryptedEmbeddings)).not.toContain('0.98');
    });

    test('consome codigo e autorizacao e revoga as sessoes, tudo na mesma transacao', () => {
      expect(recoveryToken()).toBeUndefined();
      expect(authorizationOf()).toMatchObject({ status: 'consumed' });
      expect(userNow().authVersion).toBe(1);
      expect(mockIo.disconnected).toEqual([`auth_user_${main._id}`]);
      const sessions = TRANSACTION_MODELS.flatMap((model) => model.sessionsSeen);
      expect(TRANSACTION_MODELS.map((model) => model.sessionsSeen.length)).toEqual([1, 1, 1, 1]);
      expect(new Set(sessions.map((session) => session.id)).size).toBe(1);
    });

    test('avisa o titular por e-mail depois da confirmacao', () => {
      const last = sendEmail.mock.calls.at(-1);
      expect(last[0]).toBe(MAIN_EMAIL);
      expect(last[1]).toMatch(/recadastrada/);
      expect(mockDb.audit.at(-1)).toMatchObject({ event: 'face_recovery_completed', outcome: 'success' });
    });

    test('token antigo deixa de valer', async () => {
      const status = await request(app).get('/api/face/status').set('Authorization', `Bearer ${oldToken}`);

      expect(status.status).toBe(401);
    });

    test('o proximo login continua exigindo o rosto, agora o novo', async () => {
      const login = await request(app).post('/api/auth/login').send({ email: MAIN_EMAIL, senha: PASSWORD });

      expect(login.body.requiresFaceVerification).toBe(true);
      expect(login.body.token).toBeUndefined();

      const verifyWith = (image) =>
        request(app).post('/api/face/verify').send({ faceSessionToken: login.body.faceSessionToken, imageBase64: image });
      expect((await verifyWith('rosto-outro')).status).toBe(401);
      const ok = await verifyWith('dono-frente');
      expect(ok.status).toBe(200);
      expect(ok.body.token).toBeDefined();
    });

    test('o mesmo codigo nao funciona de novo', async () => {
      const again = await reenroll({ codigo: code, imagesBase64: ['rosto-outro', 'rosto-outro'] });

      expect(again.status).toBe(401);
      expect(decryptEmbeddings(mainFace().encryptedEmbeddings)[0]).toEqual(mockFaces['dono-frente']);
    });
  });

  test('requisicoes simultaneas com o mesmo codigo: uma conclui, a outra nao grava nada', async () => {
    const code = await authorizedCode();

    const results = await Promise.all([
      reenroll({ codigo: code }),
      reenroll({ codigo: code, imagesBase64: ['rosto-outro', 'rosto-outro'] }),
    ]);

    // A segunda encontra o codigo apagado (401), a autorizacao consumida (403) ou perde na transacao (409).
    const statuses = results.map((result) => result.status).sort();
    expect(statuses[0]).toBe(200);
    expect([401, 403, 409]).toContain(statuses[1]);
    expect(userNow().authVersion).toBe(1);
    const saved = decryptEmbeddings(mainFace().encryptedEmbeddings);
    expect([saved[0], saved[1]]).toEqual(
      results[0].status === 200
        ? [mockFaces['dono-frente'], mockFaces['dono-lado']]
        : [mockFaces['rosto-outro'], mockFaces['rosto-outro']]
    );
  });

  test('erro inesperado (banco fora na leitura da conta): 500 generico, sem detalhe interno', async () => {
    const User = require('../models/User');
    User.findOne.mockRejectedValueOnce(new Error('connection refused 10.0.0.5:27017'));

    const res = await reenroll({ codigo: '123456' });

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ erro: 'Nao foi possivel concluir a recuperacao. Nada foi alterado.' });
    expect(JSON.stringify(res.body)).not.toMatch(/10\.0\.0\.5|27017|refused/);
    expectNothingChanged();
  });

  test('falha no e-mail de aviso nao desfaz o recadastro', async () => {
    const code = await authorizedCode();
    sendEmail.mockRejectedValueOnce(new Error('smtp fora'));

    const res = await reenroll({ codigo: code });

    expect(res.status).toBe(200);
    expect(authorizationOf().status).toBe('consumed');
    expect(mainFace().encryptedEmbeddings).toBeDefined();
  });

  test('registros de seguranca e logs nao guardam codigo, senha, foto, embedding, token nem e-mail', async () => {
    const oldToken = issueAuthToken(main);
    const code = await authorizedCode();
    await reenroll({ codigo: '000000' });
    await reenroll({ codigo: code, imagesBase64: ['sem-rosto', 'dono-lado'] });
    await reenroll({ codigo: code });

    const logged = [console.info, console.warn, console.error]
      .flatMap((spy) => spy.mock.calls.flat())
      .map((item) => (item instanceof Error ? item.message : String(item)))
      .join('\n');
    const stored = JSON.stringify(mockDb.audit);
    for (const forbidden of [code, PASSWORD, 'dono-frente', 'dono-lado', String(mockFaces['dono-lado'][1]).slice(0, 8), oldToken, MAIN_EMAIL]) {
      expect(stored).not.toContain(forbidden);
      expect(logged).not.toContain(forbidden);
    }
    expect(mockDb.audit.map((event) => event.outcome)).toEqual(expect.arrayContaining(['denied', 'success']));
  });
});

test('ponta a ponta: operador autoriza com o codigo de titularidade e o titular recadastra', async () => {
  const originalOperators = config.face.recovery.operators;
  config.face.recovery.operators = [OPERATOR];
  try {
    const { authorizationId } = await operatorService.requestAuthorization({
      email: MAIN_EMAIL,
      operator: OPERATOR,
      reason: 'Titular sem acesso por cadastro facial antigo; chamado 42.',
    });
    await operatorService.confirmAuthorization({ authorizationId, operator: OPERATOR, code: codeFromEmail() });

    await sendCode();
    const res = await reenroll({ codigo: codeFromEmail() });

    expect(res.status).toBe(200);
    expect(byId('authorizations', authorizationId).status).toBe('consumed');
  } finally {
    config.face.recovery.operators = originalOperators;
  }
});
