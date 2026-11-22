// Recuperacao facial por e-mail: casos complementares ao faceRecovery.flow.test.js, com a mesma simulacao
// (rotas reais; banco, transacao, e-mail e servico facial em memoria). Nada real e enviado ou gravado.
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

// ---------------------------------------------------------------------------------------------
// Lacunas nao cobertas por faceRecovery.flow.test.js (mesmo cenario simulado, nada real).
// ---------------------------------------------------------------------------------------------

describe('envio do codigo: falha de e-mail, conta nao verificada e reenvio', () => {
  test('falha no servico de e-mail: resposta generica, nenhum codigo fica valido e o evento e registrado', async () => {
    authorize();
    sendEmail.mockRejectedValueOnce(new Error('SMTP 535 credenciais smtp-secreto'));

    const res = await sendCode();

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ msg: GENERIC_SEND });
    expect(recoveryToken()).toBeUndefined();
    expect(mockDb.audit).toEqual(expect.arrayContaining([
      expect.objectContaining({ event: 'face_recovery_code_requested', outcome: 'failed', reason: 'email_failed' }),
    ]));
    const logs = JSON.stringify([console.info.mock.calls, console.warn.mock.calls, console.error.mock.calls]);
    expect(logs).not.toMatch(/smtp-secreto|535/);
  });

  test('depois da falha de e-mail, nenhum codigo funciona no recadastro', async () => {
    authorize();
    sendEmail.mockRejectedValueOnce(new Error('SMTP fora'));
    await sendCode();

    const res = await reenroll({ codigo: '123456' });

    expect(res.status).toBe(401);
    expectNothingChanged();
  });

  test('conta com e-mail nao verificado: mesma resposta generica e nenhum e-mail', async () => {
    main.verificado = false;
    authorize();

    const res = await sendCode();

    expect(res.body).toEqual({ msg: GENERIC_SEND });
    expect(sendEmail).not.toHaveBeenCalled();
    expect(recoveryToken()).toBeUndefined();
  });

  test('pedir de novo invalida o codigo anterior', async () => {
    const primeiro = await authorizedCode();
    await sendCode();
    const segundo = codeFromEmail();

    const antigo = await reenroll({ codigo: primeiro });

    expect(mockDb.tokens.filter((token) => token.purpose === 'face_recovery')).toHaveLength(1);
    if (primeiro !== segundo) {
      expect(antigo.status).toBe(401);
      expectNothingChanged();
    }
    const atual = await reenroll({ codigo: segundo });
    expect(atual.status).toBe(200);
  });

  test('reenvio zera o contador de tentativas do codigo (limitado pelos limitadores por e-mail)', async () => {
    await authorizedCode();
    await reenroll({ codigo: '000000' });
    await reenroll({ codigo: '000001' });
    expect(recoveryToken().tentativas).toBe(2);

    await sendCode();

    expect(recoveryToken().tentativas || 0).toBe(0);
  });

  test('o e-mail do codigo vai so para o endereco da propria conta', async () => {
    authorize();
    await sendCode('  TITULAR@Exemplo.com ');

    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(sendEmail.mock.calls[0][0]).toBe(MAIN_EMAIL);
  });
});

describe('codigo vinculado a conta', () => {
  const authorizeOther = () => authorize({ _id: newId(), userId: other._id });

  test('codigo da conta A nao serve para a conta B, mesmo com B autorizada', async () => {
    const codigoDoTitular = await authorizedCode();
    authorizeOther();
    mockDb.faces.push({ _id: newId(), userId: other._id, enrolled: true, model: 'VGG-Face', embeddings: [unit([1, 1])] });
    await sendCode(OTHER_EMAIL);
    const codigoDaOutra = codeFromEmail();

    const res = await reenroll({ email: OTHER_EMAIL, codigo: codigoDoTitular });

    if (codigoDoTitular !== codigoDaOutra) {
      expect(res.status).toBe(401);
      expect(res.body).toEqual({ erro: INVALID_CREDENTIALS });
    }
    const perfilDaOutra = mockDb.faces.find((face) => String(face.userId) === String(other._id));
    expect(perfilDaOutra.encryptedEmbeddings).toBeUndefined();
  });

  test('codigo certo com a senha de outra conta: 401 e conta tentativa', async () => {
    const codigo = await authorizedCode();
    const senhaDaOutra = 'OutraSenha@2';
    other.senha = await argon2.hash(senhaDaOutra);

    const res = await reenroll({ codigo, senha: senhaDaOutra });

    expect(res.status).toBe(401);
    expect(recoveryToken().tentativas).toBe(1);
    expectNothingChanged();
  });

  test('conta autorizada nao consegue gravar o rosto de outra conta: duplicidade responde 409', async () => {
    mockFaces['rosto-da-outra'] = [0, 1];
    mockDb.faces.push({ _id: newId(), userId: other._id, enrolled: true, model: 'VGG-Face', embeddings: [[0, 1], [0, 1]] });
    const codigo = await authorizedCode();

    const res = await reenroll({ codigo, imagesBase64: ['rosto-da-outra', 'rosto-da-outra'] });

    expect(res.status).toBe(409);
    expect(res.body.codigo).toBe('FACE_DUPLICATE');
    expectNothingChanged();
    expect(recoveryToken()).toBeDefined();
  });

  test('pedir codigo para outra conta sem autorizacao nao gera codigo nem e-mail para ela', async () => {
    authorize();

    await sendCode(OTHER_EMAIL);

    expect(sendEmail).not.toHaveBeenCalled();
    expect(mockDb.tokens).toHaveLength(0);
  });
});

describe('expiracao', () => {
  test('autorizacao do operador vencida depois do envio: 403, nada muda e o codigo nao e gasto', async () => {
    const codigo = await authorizedCode();
    authorizationOf().expiresAt = new Date(Date.now() - 1000);

    const res = await reenroll({ codigo });

    expect(res.status).toBe(403);
    expectNothingChanged();
    expect(recoveryToken()).toBeDefined();
  });

  test('autorizacao revogada pelo operador depois do envio: 403', async () => {
    const codigo = await authorizedCode();
    authorizationOf().status = 'revoked';

    const res = await reenroll({ codigo });

    expect(res.status).toBe(403);
    expectNothingChanged();
  });

});

describe('prazo do codigo (15 min), conferido no servico e nao so pelo TTL do MongoDB', () => {
  const { isRecoveryCodeExpired } = require('../services/faceRecoveryService');
  const envelhecer = (ms) => {
    recoveryToken().criadoEm = new Date(Date.now() - ms);
  };

  test('o codigo guarda criadoEm no momento do envio', async () => {
    const antes = Date.now();
    await authorizedCode();

    const criadoEm = new Date(recoveryToken().criadoEm).getTime();
    expect(criadoEm).toBeGreaterThanOrEqual(antes);
    expect(criadoEm).toBeLessThanOrEqual(Date.now());
  });

  test('o prazo usa a configuracao de 15 minutos', () => {
    expect(config.face.recovery.codeMinutes).toBe(15);
  });

  describe('limite exato', () => {
    const emitido = new Date('2026-11-22T10:00:00.000Z');
    const token = { criadoEm: emitido };

    test.each([
      ['recem-criado', 0, false],
      ['14 min 59,999 s', minutes(15) - 1, false],
      ['exatamente 15 min', minutes(15), true],
      ['15 min e 1 ms', minutes(15) + 1, true],
      ['2 horas', minutes(120), true],
    ])('%s: vencido=%p', (_caso, idade, vencido) => {
      expect(isRecoveryCodeExpired(token, new Date(emitido.getTime() + idade))).toBe(vencido);
    });

    test.each([
      ['sem criadoEm', {}],
      ['criadoEm invalido', { criadoEm: 'ontem' }],
      ['token ausente', null],
    ])('%s: tratado como vencido (falha fechada)', (_caso, semData) => {
      expect(isRecoveryCodeExpired(semData, new Date())).toBe(true);
    });
  });

  test('codigo valido dentro do prazo (14 min): recadastro conclui', async () => {
    const codigo = await authorizedCode();
    envelhecer(minutes(14));

    const res = await reenroll({ codigo });

    expect(res.status).toBe(200);
    expect(mainFace().encryptedEmbeddings).toBeDefined();
  });

  test('codigo com mais de 15 min ainda no banco: 401 generico, removido, nada muda', async () => {
    const codigo = await authorizedCode();
    envelhecer(minutes(16));

    const res = await reenroll({ codigo });

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ erro: INVALID_CREDENTIALS });
    expectNothingChanged();
    expect(recoveryToken()).toBeUndefined();
    expect(authorizationOf().status).toBe('active');
    expect(faceService.extractEmbedding).not.toHaveBeenCalled();
    expect(mockDb.audit).toEqual(expect.arrayContaining([
      expect.objectContaining({ event: 'face_recovery_completed', outcome: 'denied', reason: 'code_expired' }),
    ]));
  });

  test('codigo vencido nao permite recadastro nem na segunda tentativa', async () => {
    const codigo = await authorizedCode();
    envelhecer(minutes(20));

    const primeira = await reenroll({ codigo });
    const segunda = await reenroll({ codigo });

    expect([primeira.status, segunda.status]).toEqual([401, 401]);
    expect(segunda.body).toEqual({ erro: INVALID_CREDENTIALS });
    expectNothingChanged();
  });

  test('vencido, codigo errado, senha errada e conta inexistente respondem igual', async () => {
    const codigo = await authorizedCode();
    const errado = await reenroll({ codigo: '000000' });
    const senhaErrada = await reenroll({ codigo, senha: 'SenhaErrada@9' });
    const inexistente = await reenroll({ email: 'ninguem@exemplo.com', codigo });
    envelhecer(minutes(16));
    const vencido = await reenroll({ codigo });

    [errado, senhaErrada, inexistente, vencido].forEach((res) => {
      expect(res.status).toBe(401);
      expect(res.body).toEqual({ erro: INVALID_CREDENTIALS });
    });
  });

  test('codigo vencido nao gasta tentativa nem esbarra no limite: o titular pede outro e conclui', async () => {
    const codigo = await authorizedCode();
    envelhecer(minutes(16));
    await reenroll({ codigo });

    await sendCode();
    const novo = codeFromEmail();
    const res = await reenroll({ codigo: novo });

    expect(res.status).toBe(200);
    expect(authorizationOf().status).toBe('consumed');
  });

  test('codigo que vence durante a extracao facial: 401, nada gravado e a autorizacao continua ativa', async () => {
    const codigo = await authorizedCode();
    envelhecer(minutes(15) - 1000);
    faceService.extractEmbedding.mockImplementationOnce(async (label) => {
      envelhecer(minutes(15) + 1);
      return { face_detected: true, embedding: mockFaces[label], model: 'VGG-Face' };
    });

    const res = await reenroll({ codigo });

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ erro: INVALID_CREDENTIALS });
    expectNothingChanged();
    expect(recoveryToken()).toBeUndefined();
    expect(authorizationOf().status).toBe('active');
    expect(userNow().authVersion).toBe(0);
  });

  test('codigo reutilizado depois do sucesso: 401 e nada muda de novo', async () => {
    const codigo = await authorizedCode();
    const primeira = await reenroll({ codigo });
    const perfilDepois = JSON.stringify(mainFace());

    const segunda = await reenroll({ codigo });

    expect(primeira.status).toBe(200);
    expect(segunda.status).toBe(401);
    expect(segunda.body).toEqual({ erro: INVALID_CREDENTIALS });
    expect(JSON.stringify(mainFace())).toBe(perfilDepois);
  });

  test('limite de tentativas continua valendo para codigo dentro do prazo', async () => {
    const codigo = await authorizedCode();
    for (let i = 0; i < config.face.recovery.maxAttempts; i += 1) {
      await reenroll({ codigo: '000000' });
    }

    const res = await reenroll({ codigo });

    expect(res.status).toBe(429);
    expectNothingChanged();
  });
});

describe('servico facial e anti-spoofing no recadastro', () => {
  test('foto recusada pelo servico (ex.: spoof detectado) nao consome nada', async () => {
    faceService.extractEmbedding.mockImplementationOnce(async () => {
      throw Object.assign(new Error('Spoof detected'), { statusCode: 400 });
    });
    const codigo = await authorizedCode();

    const res = await reenroll({ codigo });

    expect(res.status).toBe(400);
    expectNothingChanged();
    expect(recoveryToken()).toBeDefined();
    expect(authorizationOf().status).toBe('active');
  });

  test('o recadastro usa o mesmo caminho de extracao do cadastro (contexto enroll)', async () => {
    const codigo = await authorizedCode();

    await reenroll({ codigo });

    expect(faceService.extractEmbedding).toHaveBeenCalledWith('dono-frente', 'enroll');
    expect(faceService.extractEmbedding).toHaveBeenCalledWith('dono-lado', 'enroll');
  });

  test('timeout do servico facial: 504 e nada muda', async () => {
    faceService.extractEmbedding.mockImplementationOnce(async () => {
      throw Object.assign(new Error('timeout'), { statusCode: 504 });
    });
    const codigo = await authorizedCode();

    const res = await reenroll({ codigo });

    expect(res.status).toBe(504);
    expect(res.body).toEqual({ erro: 'Servico facial indisponivel.' });
    expectNothingChanged();
  });
});

describe('limitadores reais das rotas de recuperacao (middleware isolado)', () => {
  const limiters = jest.requireActual('../middlewares/rateLimiters');
  const chamar = (limiter, { ip = '10.0.0.1', email = 'alvo@exemplo.com', path = '/recovery/x' } = {}) => {
    const res = { statusCode: 200, set: jest.fn(), status(code) { this.statusCode = code; return this; }, json: jest.fn() };
    const next = jest.fn();
    limiter({ ip, body: { email }, route: { path } }, res, next);
    return { bloqueado: !next.mock.calls.length, status: res.statusCode };
  };

  test('envio de codigo: 5 por 15 min por IP+e-mail; o 6o recebe 429', () => {
    const resultados = Array.from({ length: 6 }, () => chamar(limiters.emailCodeLimiter, { path: '/recovery/send-code-a' }));

    expect(resultados.slice(0, 5).every((item) => !item.bloqueado)).toBe(true);
    expect(resultados[5]).toEqual({ bloqueado: true, status: 429 });
  });

  test('validacao: 10 por 15 min por IP+e-mail; a 11a recebe 429', () => {
    const resultados = Array.from({ length: 11 }, () => chamar(limiters.codeValidationLimiter, { path: '/recovery/re-enroll-a' }));

    expect(resultados.slice(0, 10).every((item) => !item.bloqueado)).toBe(true);
    expect(resultados[10]).toEqual({ bloqueado: true, status: 429 });
  });

  test('LIMITACAO: o contador e por IP+e-mail; outro IP tem contador proprio para o mesmo e-mail', () => {
    Array.from({ length: 10 }, () => chamar(limiters.codeValidationLimiter, { path: '/recovery/re-enroll-b' }));

    const outroIp = chamar(limiters.codeValidationLimiter, { path: '/recovery/re-enroll-b', ip: '10.0.0.2' });

    expect(outroIp.bloqueado).toBe(false);
  });
});

describe('enumeracao', () => {
  test('re-enroll: conta inexistente, sem codigo e codigo errado tem a mesma resposta', async () => {
    authorize();
    await sendCode();

    const inexistente = await reenroll({ email: 'ninguem@exemplo.com', codigo: '123456' });
    const outraSemCodigo = await reenroll({ email: OTHER_EMAIL, codigo: '123456' });
    const errado = await reenroll({ codigo: '000000' });

    [inexistente, outraSemCodigo, errado].forEach((res) => {
      expect(res.status).toBe(401);
      expect(res.body).toEqual({ erro: INVALID_CREDENTIALS });
    });
  });
});
