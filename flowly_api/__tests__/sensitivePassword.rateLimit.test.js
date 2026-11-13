const request = require('supertest');
const argon2 = require('argon2');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');

const mockDb = { users: [], faces: [] };
const mockFaceVectors = { 'rosto-a': [1, 0, 0, 0], 'rosto-b': [0, 1, 0, 0] };

jest.mock('@google-cloud/storage', () => ({
  Storage: jest.fn().mockImplementation(() => ({
    bucket: jest.fn().mockReturnValue({ file: jest.fn() }),
  })),
}));

jest.mock('../utils/sendEmail', () => jest.fn().mockResolvedValue(true));

jest.mock('../services/faceService', () => ({
  extractEmbedding: jest.fn(async (image) =>
    mockFaceVectors[image]
      ? { face_detected: true, embedding: mockFaceVectors[image], model: 'VGG-Face' }
      : { face_detected: false, erro: 'no face' }
  ),
}));

jest.mock('../models/User', () => {
  // Consulta do Mongoose: pode ser aguardada direto ou encadeada com select.
  const mockQuery = (value) => {
    const query = Promise.resolve(value);
    query.select = () => query;
    return query;
  };
  return {
    findOne: jest.fn(async ({ email }) => mockDb.users.find((user) => user.email === email) || null),
    findById: jest.fn((id) => mockQuery(mockDb.users.find((user) => String(user._id) === String(id)) || null)),
  };
});

jest.mock('../models/FaceProfile', () => ({
  findOne: jest.fn(async ({ userId, enrolled }) =>
    mockDb.faces.find((face) => String(face.userId) === String(userId) && face.enrolled === enrolled) || null
  ),
  find: jest.fn((filter) => ({
    select: async () =>
      mockDb.faces.filter((face) => face.enrolled && String(face.userId) !== String(filter.userId.$ne)),
  })),
  findOneAndUpdate: jest.fn(async ({ userId }, update) => {
    let face = mockDb.faces.find((item) => String(item.userId) === String(userId));
    if (!face) {
      face = {};
      mockDb.faces.push(face);
    }
    Object.assign(face, update.$set);
    return face;
  }),
}));

jest.mock('../models/TwoFactorToken', () => {
  function Token(data) {
    Object.assign(this, data);
  }
  Token.prototype.save = async function save() {
    return this;
  };
  Token.deleteMany = jest.fn().mockResolvedValue({});
  return Token;
});

const config = require('../config/config');
const faceService = require('../services/faceService');
const FaceProfile = require('../models/FaceProfile');
const User = require('../models/User');
const { issueAuthToken, issueFaceSessionToken } = require('../utils/faceAuth');
const app = require('../app');

const MAX_ATTEMPTS = 5;
const WINDOW_MS = 15 * 60 * 1000;
const PASSWORD = 'SenhaOriginal@1';
const WRONG_PASSWORD = 'SenhaErrada@999';
const NEW_PASSWORD = 'NovaSenha@456';
const LIMIT_RESPONSE = { erro: 'Muitas tentativas. Aguarde alguns minutos e tente novamente.' };
const RATE_LIMIT_HEADERS = ['ratelimit-limit', 'ratelimit-remaining', 'ratelimit-reset'];

const changePassword = (token, body = {}) => {
  const req = request(app).put('/api/users/me/password');
  if (token) req.set('Authorization', `Bearer ${token}`);
  return req.send({ senhaAtual: WRONG_PASSWORD, novaSenha: NEW_PASSWORD, ...body });
};

const enrollProfile = (token, body = {}) => {
  const req = request(app).post('/api/face/enroll-profile');
  if (token) req.set('Authorization', `Bearer ${token}`);
  return req.send({ imagesBase64: ['rosto-a'], senhaAtual: WRONG_PASSWORD, ...body });
};

const login = (email, senha = PASSWORD) => request(app).post('/api/auth/login').send({ email, senha });

const ROUTES = [
  ['PUT /api/users/me/password', changePassword, 'Senha atual invalida'],
  ['POST /api/face/enroll-profile', enrollProfile, 'Senha atual incorreta.'],
];

describe('D33: tentativas de senha atual com JWT valido', () => {
  const originalEmbeddingKey = config.face.embeddingKey;
  let passwordHash;
  let accounts = 0;
  let verifySpy;
  let hashSpy;

  beforeAll(async () => {
    // Custo baixo so para o teste ser rapido: a verificacao continua sendo Argon2 de verdade.
    passwordHash = await argon2.hash(PASSWORD, { memoryCost: 1024, timeCost: 2, parallelism: 1 });
    config.face.embeddingKey = Buffer.alloc(32, 1).toString('base64');
  });

  afterAll(() => {
    config.face.embeddingKey = originalEmbeddingKey;
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockDb.users = [];
    mockDb.faces = [];
    verifySpy = jest.spyOn(argon2, 'verify');
    hashSpy = jest.spyOn(argon2, 'hash');
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // O contador vive em memoria durante todo o arquivo: cada teste usa contas novas.
  const createAccount = (data = {}) => {
    accounts += 1;
    const user = {
      _id: new mongoose.Types.ObjectId(),
      nome: `Conta ${accounts}`,
      email: `conta${accounts}@exemplo.com`,
      senha: passwordHash,
      tipo: 'user',
      verificado: true,
      fotoPerfil: '',
      faceEnrollmentOffered: true,
      faceEnrollmentSkipped: true,
      save: jest.fn().mockResolvedValue(true),
      ...data,
    };
    user.toObject = () => ({ ...user });
    mockDb.users.push(user);
    return user;
  };

  const repeat = async (times, call) => {
    const results = [];
    for (let i = 0; i < times; i += 1) {
      results.push(await call(i));
    }
    return results;
  };

  const exhaust = (token, call) => repeat(MAX_ATTEMPTS, () => call(token));

  const expectLimited = (res) => {
    expect(res.status).toBe(429);
    expect(res.body).toEqual(LIMIT_RESPONSE);
  };

  describe.each(ROUTES)('%s', (_route, call, wrongMessage) => {
    test('A: as primeiras tentativas erradas respondem 400, nao 401', async () => {
      const token = issueAuthToken(createAccount());

      const results = await exhaust(token, call);

      results.forEach((res) => {
        expect(res.status).toBe(400);
        expect(res.body).toEqual({ erro: wrongMessage });
      });
      expect(verifySpy).toHaveBeenCalledTimes(MAX_ATTEMPTS);
    });

    test('B: depois do limite responde 429 e a senha deixa de ser verificada', async () => {
      const token = issueAuthToken(createAccount());
      await exhaust(token, call);
      verifySpy.mockClear();
      hashSpy.mockClear();
      User.findById.mockClear();

      const results = await repeat(3, () => call(token));

      results.forEach(expectLimited);
      expect(verifySpy).not.toHaveBeenCalled();
      expect(hashSpy).not.toHaveBeenCalled();
      expect(User.findById).not.toHaveBeenCalled();
    });

    test('B: depois do limite nem a senha correta passa', async () => {
      const user = createAccount();
      const token = issueAuthToken(user);
      await exhaust(token, call);

      expectLimited(await call(token, { senhaAtual: PASSWORD }));

      expect(user.senha).toBe(passwordHash);
      expect(user.save).not.toHaveBeenCalled();
      expect(mockDb.faces).toHaveLength(0);
    });

    test('C: sem JWT responde 401, sem falar do limite e sem verificar a senha', async () => {
      const results = await repeat(MAX_ATTEMPTS + 2, () => call(null));

      results.forEach((res) => {
        expect(res.status).toBe(401);
        RATE_LIMIT_HEADERS.forEach((header) => expect(res.headers[header]).toBeUndefined());
      });
      expect(verifySpy).not.toHaveBeenCalled();
    });

    test('C: JWT invalido, expirado ou de sessao facial responde 401 mesmo com a conta no limite', async () => {
      const user = createAccount();
      await exhaust(issueAuthToken(user), call);
      const expired = jwt.sign({ id: user._id, tipo: 'user', tokenType: 'access' }, config.jwt.secret, {
        issuer: config.jwt.issuer,
        audience: config.jwt.accessAudience,
        expiresIn: -10,
      });

      for (const token of ['jwt-invalido', expired, issueFaceSessionToken(user._id, 'face_verify')]) {
        const res = await call(token);

        expect(res.status).toBe(401);
        RATE_LIMIT_HEADERS.forEach((header) => expect(res.headers[header]).toBeUndefined());
      }
    });

    test('D: a conta A no limite nao bloqueia a conta B', async () => {
      const a = issueAuthToken(createAccount());
      const b = issueAuthToken(createAccount());
      await exhaust(a, call);
      expectLimited(await call(a));

      expect((await call(b)).status).toBe(400);
      expectLimited(await call(a));
    });
  });

  describe('fluxos legitimos dentro do limite', () => {
    test('troca de senha: a senha correta na ultima tentativa funciona', async () => {
      const user = createAccount();
      const token = issueAuthToken(user);
      await repeat(MAX_ATTEMPTS - 1, () => changePassword(token));

      const res = await changePassword(token, { senhaAtual: PASSWORD });

      expect(res.status).toBe(200);
      expect(user.save).toHaveBeenCalledTimes(1);
      expect(user.senha).not.toBe(passwordHash);
    });

    test('cadastro facial: a senha correta na ultima tentativa funciona', async () => {
      const user = createAccount();
      const token = issueAuthToken(user);
      await repeat(MAX_ATTEMPTS - 1, () => enrollProfile(token));

      const res = await enrollProfile(token, { senhaAtual: PASSWORD });

      expect(res.status).toBe(200);
      expect(res.body.enrolled).toBe(true);
      expect(mockDb.faces).toHaveLength(1);
    });
  });

  describe('POST /api/face/enroll-profile depois de bloqueado', () => {
    test('nao chama o servico facial e nao cria perfil', async () => {
      const token = issueAuthToken(createAccount());
      await exhaust(token, enrollProfile);
      expect(faceService.extractEmbedding).not.toHaveBeenCalled();

      expectLimited(await enrollProfile(token, { senhaAtual: PASSWORD }));

      expect(faceService.extractEmbedding).not.toHaveBeenCalled();
      expect(FaceProfile.findOneAndUpdate).not.toHaveBeenCalled();
      expect(mockDb.faces).toHaveLength(0);
    });

    test('nao altera o perfil existente', async () => {
      const user = createAccount();
      const profile = { userId: user._id, enrolled: true, embeddings: [mockFaceVectors['rosto-a']] };
      mockDb.faces.push(profile);
      const before = JSON.stringify(profile);
      const token = issueAuthToken(user);
      await exhaust(token, enrollProfile);

      expectLimited(await enrollProfile(token, { senhaAtual: PASSWORD, imagesBase64: ['rosto-b'] }));

      expect(JSON.stringify(profile)).toBe(before);
      expect(FaceProfile.findOneAndUpdate).not.toHaveBeenCalled();
    });

    test('a outra conta continua cadastrando o proprio rosto', async () => {
      const a = issueAuthToken(createAccount());
      const b = createAccount();
      await exhaust(a, enrollProfile);

      const res = await enrollProfile(issueAuthToken(b), { senhaAtual: PASSWORD, imagesBase64: ['rosto-b'] });

      expect(res.status).toBe(200);
      expect(mockDb.faces).toHaveLength(1);
      expect(String(mockDb.faces[0].userId)).toBe(String(b._id));
    });
  });

  describe('as duas rotas gastam o mesmo contador', () => {
    test('alternar a cada tentativa nao da tentativas a mais', async () => {
      const token = issueAuthToken(createAccount());

      const results = await repeat(MAX_ATTEMPTS, (i) => (i % 2 ? enrollProfile(token) : changePassword(token)));

      results.forEach((res) => expect(res.status).toBe(400));
      expect(verifySpy).toHaveBeenCalledTimes(MAX_ATTEMPTS);
      expectLimited(await changePassword(token));
      expectLimited(await enrollProfile(token));
      expect(verifySpy).toHaveBeenCalledTimes(MAX_ATTEMPTS);
    });

    test.each([
      ['/me/password', changePassword, enrollProfile],
      ['/face/enroll-profile', enrollProfile, changePassword],
    ])('esgotar %s tambem bloqueia a outra rota', async (_route, first, other) => {
      const token = issueAuthToken(createAccount());
      await exhaust(token, first);

      expectLimited(await other(token, { senhaAtual: PASSWORD }));
    });
  });

  describe('a chave depende so da conta', () => {
    test('trocar a senha testada, a nova senha e a imagem nao abre outro contador', async () => {
      const token = issueAuthToken(createAccount());

      await repeat(MAX_ATTEMPTS, (i) =>
        changePassword(token, { senhaAtual: `Tentativa@${i}`, novaSenha: `NovaSenha@${i}` })
      );

      expectLimited(await changePassword(token, { senhaAtual: 'Tentativa@final', novaSenha: 'NovaSenha@final' }));
      expectLimited(await enrollProfile(token, { senhaAtual: 'Tentativa@face', imagesBase64: ['rosto-b'] }));
    });

    test('outro JWT da mesma conta nao abre outro contador', async () => {
      const user = createAccount();
      await exhaust(issueAuthToken(user), changePassword);
      const anotherToken = jwt.sign({ id: user._id, tipo: 'user', tokenType: 'access', jti: 'outro' }, config.jwt.secret, {
        issuer: config.jwt.issuer,
        audience: config.jwt.accessAudience,
      });

      expectLimited(await changePassword(anotherToken));
    });

    test('trocar de IP nao abre outro contador', async () => {
      const token = issueAuthToken(createAccount());
      app.set('trust proxy', true);

      try {
        await repeat(MAX_ATTEMPTS, (i) => changePassword(token).set('X-Forwarded-For', `198.51.100.${i + 1}`));

        expectLimited(await changePassword(token).set('X-Forwarded-For', '203.0.113.50'));
      } finally {
        app.set('trust proxy', false);
      }
    });

    test('rajada simultanea: so o limite chega a verificar a senha', async () => {
      const token = issueAuthToken(createAccount());

      const results = await Promise.all(
        Array.from({ length: MAX_ATTEMPTS * 4 }, () => changePassword(token).then((res) => res))
      );

      expect(results.filter((res) => res.status === 400)).toHaveLength(MAX_ATTEMPTS);
      expect(results.filter((res) => res.status === 429)).toHaveLength(MAX_ATTEMPTS * 3);
      expect(verifySpy).toHaveBeenCalledTimes(MAX_ATTEMPTS);
    });

    test('senha nao aparece na resposta, nos cabecalhos nem nos logs', async () => {
      const logs = ['log', 'info', 'warn', 'error'].map((level) => jest.spyOn(console, level).mockImplementation(() => {}));
      const token = issueAuthToken(createAccount());
      const secret = 'SenhaSecretaDoTeste@77';

      const results = await repeat(MAX_ATTEMPTS + 1, () => changePassword(token, { senhaAtual: secret, novaSenha: secret }));

      expectLimited(results[MAX_ATTEMPTS]);
      const logged = JSON.stringify(logs.flatMap((spy) => spy.mock.calls));
      expect(logged).not.toContain(secret);
      results.forEach((res) => {
        expect(JSON.stringify(res.body)).not.toContain(secret);
        expect(JSON.stringify(res.headers)).not.toContain(secret);
      });
    });
  });

  describe('janela de 15 minutos', () => {
    test('continua bloqueado ate o fim da janela e libera depois', async () => {
      const start = Date.now();
      const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(start);
      const token = issueAuthToken(createAccount());
      await exhaust(token, changePassword);

      nowSpy.mockReturnValue(start + WINDOW_MS - 1000);
      expectLimited(await changePassword(token));

      nowSpy.mockReturnValue(start + WINDOW_MS + 1);
      expect((await changePassword(token)).status).toBe(400);
    });

    test('tentar durante o bloqueio nao estende a janela', async () => {
      const start = Date.now();
      const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(start);
      const token = issueAuthToken(createAccount());
      await exhaust(token, changePassword);

      for (const minutes of [5, 10, 14]) {
        nowSpy.mockReturnValue(start + minutes * 60 * 1000);
        expectLimited(await changePassword(token));
      }

      nowSpy.mockReturnValue(start + WINDOW_MS + 1);
      expect((await changePassword(token)).status).toBe(400);
    });
  });

  describe('nao provoca logout', () => {
    test('a sessao segue valida depois de 400 e de 429', async () => {
      const token = issueAuthToken(createAccount());
      await exhaust(token, changePassword);
      expectLimited(await changePassword(token));

      expect((await request(app).get('/api/users/me').set('Authorization', `Bearer ${token}`)).status).toBe(200);
      expect((await request(app).get('/api/face/status').set('Authorization', `Bearer ${token}`)).status).toBe(200);
    });
  });

  describe('login e recuperacao nao mudam', () => {
    test('conta no limite continua entrando com a senha correta', async () => {
      const user = createAccount();
      await exhaust(issueAuthToken(user), changePassword);

      const res = await login(user.email);

      expect(res.status).toBe(200);
      expect(res.body.token).toEqual(expect.any(String));
    });

    test('erros de login nao gastam o contador da senha atual', async () => {
      const user = createAccount();
      await repeat(MAX_ATTEMPTS + 1, () => login(user.email, WRONG_PASSWORD));

      expect((await changePassword(issueAuthToken(user))).status).toBe(400);
    });

    test('o limite do login continua sendo 10', async () => {
      const user = createAccount();

      const results = await repeat(11, () => login(user.email, WRONG_PASSWORD));

      expect(results.slice(0, 10).every((res) => res.status === 401)).toBe(true);
      expect(results[10].status).toBe(429);
    });

    test('a recuperacao de senha nao usa este contador', async () => {
      const user = createAccount();
      await exhaust(issueAuthToken(user), changePassword);

      const res = await request(app).post('/api/auth/recuperar-senha/enviar-codigo').send({ email: user.email });

      expect(res.status).toBe(200);
    });
  });

  describe('toda requisicao autenticada conta, nao so a senha errada', () => {
    test('nova senha fraca gasta tentativa, mesmo sem verificar a senha atual', async () => {
      const token = issueAuthToken(createAccount());

      const results = await repeat(MAX_ATTEMPTS, () => changePassword(token, { senhaAtual: PASSWORD, novaSenha: 'fraca' }));

      results.forEach((res) => expect(res.status).toBe(400));
      expect(verifySpy).not.toHaveBeenCalled();
      expectLimited(await changePassword(token, { senhaAtual: PASSWORD }));
    });

    test('foto sem rosto gasta tentativa, mesmo com a senha correta', async () => {
      const token = issueAuthToken(createAccount());

      const results = await repeat(MAX_ATTEMPTS, () =>
        enrollProfile(token, { senhaAtual: PASSWORD, imagesBase64: ['sem-rosto'] })
      );

      results.forEach((res) => expect(res.status).toBe(400));
      expectLimited(await enrollProfile(token, { senhaAtual: PASSWORD }));
    });
  });
});
