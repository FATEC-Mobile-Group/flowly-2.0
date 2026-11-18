// Anti-spoofing nos fluxos da API: com o servico facial recusando a captura (foto ou tela) ou sem conseguir
// analisar, nenhum fluxo emite token nem grava rosto. So a rede e simulada: faceService.js e controllers reais.
const request = require('supertest');
const argon2 = require('argon2');

jest.setTimeout(30000);

const mockDb = { users: [], faces: [], tokens: [], authorizations: [], audit: [] };
const mockTx = { supported: true };

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
jest.mock('../utils/socketInstance', () => ({ setIo: jest.fn(), getIo: () => null }));
jest.mock('../middlewares/rateLimiters', () => {
  const passThrough = (_req, _res, next) => next();
  return {
    ...jest.requireActual('../middlewares/rateLimiters'),
    faceVerifyLimiter: passThrough,
    sensitivePasswordActionLimiter: passThrough,
    codeValidationLimiter: passThrough,
    emailCodeLimiter: passThrough,
  };
});

const config = require('../config/config');
const { issueAuthToken, issueFaceSessionToken } = require('../utils/faceAuth');
const { hashSecurityCode } = require('../utils/securityCodes');
const { newId } = require('./helpers/memoryModel');
const app = require('../app');

// Mensagens exatamente como flowly_iot_face/main.py responde.
const SPOOF =
  'Não foi possível confirmar que a captura é de um rosto ao vivo. ' +
  'Olhe diretamente para a câmera, sem fotos ou telas, com boa iluminação, e tente novamente.';
const UNAVAILABLE = 'Serviço facial indisponível no momento. Tente novamente em instantes.';
const PASSWORD = 'SenhaDoTitular@1';
const EMAIL = 'titular@exemplo.com';
const CODE = '481516';
const IMAGES = ['data:image/jpeg;base64,AAAA', 'data:image/jpeg;base64,BBBB'];
const STORED = [[0.6, 0.8]];

let user;
let serviceReply;

const respond = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const spoofed = (path) => respond(400, path === '/embed' ? { face_detected: false, erro: SPOOF } : { match: false, face_detected: false, erro: SPOOF });
const unavailable = (path) => respond(503, path === '/embed' ? { face_detected: false, erro: UNAVAILABLE } : { match: false, face_detected: false, erro: UNAVAILABLE });
const approved = (path) =>
  respond(200, path === '/embed' ? { face_detected: true, embedding: [0.6, 0.8], model: 'VGG-Face' } : { match: true, face_detected: true, distance: 0.1 });

const profileOf = () => mockDb.faces.find((face) => String(face.userId) === String(user._id));
const tokenIn = (body) => JSON.stringify(body).includes('eyJ');

beforeAll(async () => {
  config.face.serviceSecret = 'segredo-de-teste';
  config.face.embeddingKey = Buffer.alloc(32, 5).toString('base64');
  user = { senha: await argon2.hash(PASSWORD) };
});

beforeEach(() => {
  Object.assign(mockDb, { users: [], faces: [], tokens: [], authorizations: [], audit: [] });
  user = { _id: newId(), nome: 'Titular', email: EMAIL, senha: user.senha, tipo: 'user', verificado: true, authVersion: 0, fotoPerfil: '' };
  mockDb.users.push(user);
  serviceReply = approved;
  global.fetch = jest.fn(async (url) => serviceReply(new URL(url).pathname));
  jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.spyOn(console, 'info').mockImplementation(() => {});
});

afterEach(() => {
  console.error.mockRestore();
  console.info.mockRestore();
});

const enrolledProfile = () => mockDb.faces.push({ _id: newId(), userId: user._id, enrolled: true, model: 'VGG-Face', embeddings: STORED });

const flows = {
  login: {
    setup: enrolledProfile,
    send: () =>
      request(app).post('/api/face/verify').send({ faceSessionToken: issueFaceSessionToken(user._id, 'face_verify'), imageBase64: IMAGES[0] }),
    nothingSaved: () => expect(profileOf().embeddings).toEqual(STORED),
  },
  'primeiro cadastro': {
    setup: () => Object.assign(user, { faceEnrollmentOffered: true }),
    send: () =>
      request(app).post('/api/face/enroll').send({ faceSessionToken: issueFaceSessionToken(user._id, 'face_enroll'), imagesBase64: IMAGES }),
    nothingSaved: () => {
      expect(profileOf()).toBeUndefined();
      expect(user.faceEnrollmentOfferConcluded).not.toBe(true);
    },
  },
  'atualizacao pelo perfil': {
    setup: enrolledProfile,
    send: () =>
      request(app)
        .post('/api/face/enroll-profile')
        .set('Authorization', `Bearer ${issueAuthToken(user)}`)
        .send({ imagesBase64: IMAGES, senhaAtual: PASSWORD }),
    nothingSaved: () => expect(profileOf().embeddings).toEqual(STORED),
  },
  recuperacao: {
    setup: () => {
      enrolledProfile();
      mockDb.authorizations.push({
        _id: newId(), userId: user._id, operator: 'operador@flowly.test', reason: 'Titular sem acesso ao rosto antigo.',
        status: 'active', ownershipAttempts: 0, ownershipExpiresAt: new Date(), expiresAt: new Date(Date.now() + 30 * 60000),
      });
      mockDb.tokens.push({ _id: newId(), userId: user._id, purpose: 'face_recovery', codigo: hashSecurityCode('face_recovery', CODE), token: 'x' });
    },
    send: () =>
      request(app).post('/api/face/recovery/re-enroll').send({ email: EMAIL, codigo: CODE, senha: PASSWORD, imagesBase64: IMAGES }),
    nothingSaved: () => {
      expect(profileOf().embeddings).toEqual(STORED);
      expect(mockDb.authorizations[0].status).toBe('active');
      expect(mockDb.tokens).toHaveLength(1);
      expect(user.authVersion).toBe(0);
    },
  },
};

describe.each(Object.entries(flows))('%s', (_name, flow) => {
  beforeEach(() => flow.setup());

  test('foto ou tela recusada: 400 com a orientacao, sem token e sem gravar nada', async () => {
    serviceReply = spoofed;

    const res = await flow.send();

    expect(res.status).toBe(400);
    expect(res.body.erro).toBe(SPOOF);
    expect(tokenIn(res.body)).toBe(false);
    flow.nothingSaved();
    expect(global.fetch).toHaveBeenCalled();
  });

  test('anti-spoofing indisponivel: 503, sem token e sem gravar nada', async () => {
    serviceReply = unavailable;

    const res = await flow.send();

    expect(res.status).toBe(503);
    expect(tokenIn(res.body)).toBe(false);
    expect(JSON.stringify(res.body)).not.toContain(SPOOF);
    flow.nothingSaved();
  });
});

test('controle: com o servico aprovando a captura, o login autentica normalmente', async () => {
  enrolledProfile();

  const res = await flows.login.send();

  expect(res.status).toBe(200);
  expect(res.body.token).toBeDefined();
});
