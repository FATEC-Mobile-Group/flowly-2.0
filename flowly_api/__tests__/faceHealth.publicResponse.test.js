const request = require('supertest');

jest.mock('@google-cloud/storage', () => ({
  Storage: jest.fn().mockImplementation(() => ({
    bucket: jest.fn().mockReturnValue({ file: jest.fn() }),
  })),
}));

const config = require('../config/config');
const app = require('../app');

const SERVICE_URL = 'http://servico-interno.local:5001';
const HEALTHY_RESPONSE = { api: 'ok', faceService: { status: 'ok' } };
const UNAVAILABLE_RESPONSE = {
  api: 'ok',
  faceService: { status: 'unavailable' },
  erro: 'Serviço facial indisponível.',
};
// Corpo exatamente como flowly_iot_face/main.py responde em /health.
const HEALTHY_BODY = {
  status: 'ok',
  service: 'flowly_iot_face',
  model: 'VGG-Face',
  detector: 'opencv',
  threshold_default: 0.4,
  verify_threshold: 0.35,
};
const INTERNAL_FIELDS = [
  'service',
  'model',
  'detector',
  'threshold',
  'threshold_default',
  'verify_threshold',
  'embedding',
  'distance',
  'score',
  'similarity',
  'url',
  'detalhe',
  'stack',
];
const INTERNAL_VALUES = ['flowly_iot_face', 'VGG-Face', 'opencv', '0.35', 'servico-interno', '5001', '10.0.0.5', 'ECONNREFUSED'];

const health = () => request(app).get('/api/face/health');

const keysOf = (value) =>
  value && typeof value === 'object'
    ? Object.entries(value).flatMap(([key, item]) => [key, ...keysOf(item)])
    : [];

const expectNothingInternal = (res) => {
  const body = JSON.stringify(res.body);
  INTERNAL_FIELDS.forEach((field) => expect(keysOf(res.body)).not.toContain(field));
  INTERNAL_VALUES.forEach((value) => expect(body).not.toContain(value));
  INTERNAL_VALUES.forEach((value) => expect(JSON.stringify(res.headers)).not.toContain(value));
};

const serviceResponds = (status, body) => {
  global.fetch.mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: jest.fn().mockResolvedValue(body),
  });
};

describe('D56: GET /api/face/health so responde o estado', () => {
  const originalFetch = global.fetch;
  const originalServiceUrl = config.face.serviceUrl;
  let warnSpy;

  beforeAll(() => {
    config.face.serviceUrl = SERVICE_URL;
  });

  afterAll(() => {
    config.face.serviceUrl = originalServiceUrl;
    global.fetch = originalFetch;
  });

  beforeEach(() => {
    global.fetch = jest.fn();
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('A: servico saudavel', () => {
    beforeEach(() => {
      serviceResponds(200, HEALTHY_BODY);
    });

    test('responde 200 com api ok e faceService.status ok, e nada mais', async () => {
      const res = await health();

      expect(res.status).toBe(200);
      expect(res.body).toEqual(HEALTHY_RESPONSE);
    });

    test('modelo, detector e limiares nao chegam ao cliente', async () => {
      const res = await health();

      expect(res.body.faceService.model).toBeUndefined();
      expect(res.body.faceService.detector).toBeUndefined();
      expect(res.body.faceService.threshold_default).toBeUndefined();
      expect(res.body.faceService.verify_threshold).toBeUndefined();
      expectNothingInternal(res);
    });

    test('consulta o /health do servico configurado, sem revelar o endereco', async () => {
      const res = await health();

      expect(global.fetch).toHaveBeenCalledTimes(1);
      expect(global.fetch).toHaveBeenCalledWith(`${SERVICE_URL}/health`);
      expect(JSON.stringify(res.body)).not.toContain(SERVICE_URL);
    });
  });

  describe('B: servico indisponivel', () => {
    test.each([
      ['mensagem com IP e porta', () => new Error('connect ECONNREFUSED 10.0.0.5:5001')],
      ['forma real do fetch, com a causa interna', () =>
        new TypeError('fetch failed', { cause: new Error('connect ECONNREFUSED 10.0.0.5:5001') })],
      ['host interno que nao resolve', () => new Error('getaddrinfo ENOTFOUND servico-interno.local')],
    ])('%s: 503 com resposta generica', async (_label, buildError) => {
      global.fetch.mockRejectedValue(buildError());

      const res = await health();

      expect(res.status).toBe(503);
      expect(res.body).toEqual(UNAVAILABLE_RESPONSE);
      expectNothingInternal(res);
      expect(JSON.stringify(res.body)).not.toContain('fetch failed');
    });

    test('a resposta nao traz stack', async () => {
      global.fetch.mockRejectedValue(new Error('connect ECONNREFUSED 10.0.0.5:5001'));

      const res = await health();

      expect(JSON.stringify(res.body)).not.toMatch(/\bat\s.+:\d+/);
    });

    test('a causa fica so no log do servidor', async () => {
      global.fetch.mockRejectedValue(
        new TypeError('fetch failed', { cause: new Error('connect ECONNREFUSED 10.0.0.5:5001') })
      );

      const res = await health();

      expect(JSON.stringify(warnSpy.mock.calls)).toContain('ECONNREFUSED');
      expect(JSON.stringify(res.body)).not.toContain('ECONNREFUSED');
    });
  });

  describe('C: resposta inesperada do servico nao vira saude nem vaza', () => {
    test.each([
      ['erro 500 com JSON', 500, { erro: 'trace interno /app/main.py servico-interno' }],
      ['estado diferente de ok', 200, { ...HEALTHY_BODY, status: 'degraded' }],
      ['estado ok em outra grafia', 200, { ...HEALTHY_BODY, status: 'OK' }],
      ['sem estado', 200, { model: 'VGG-Face' }],
      ['corpo nulo', 200, null],
      ['lista', 200, ['VGG-Face']],
    ])('%s: 503 generico', async (_label, status, body) => {
      serviceResponds(status, body);

      const res = await health();

      expect(res.status).toBe(503);
      expect(res.body).toEqual(UNAVAILABLE_RESPONSE);
      expectNothingInternal(res);
    });

    test('corpo que nao e JSON: 503 sem repetir o trecho recebido', async () => {
      global.fetch.mockResolvedValue({
        ok: false,
        status: 502,
        json: jest.fn().mockRejectedValue(new SyntaxError('Unexpected token <, "<html>proxy interno" is not valid JSON')),
      });

      const res = await health();

      expect(res.status).toBe(503);
      expect(res.body).toEqual(UNAVAILABLE_RESPONSE);
      expect(JSON.stringify(res.body)).not.toContain('html');
    });

    test('resposta sem estado ok tambem deixa rastro no log', async () => {
      serviceResponds(500, { erro: 'falha' });

      await health();

      expect(warnSpy).toHaveBeenCalled();
    });
  });

  describe('D: a rota continua publica', () => {
    test('nao exige JWT', async () => {
      serviceResponds(200, HEALTHY_BODY);

      expect((await health()).status).toBe(200);
    });

    test('Authorization invalido nao muda a resposta', async () => {
      serviceResponds(200, HEALTHY_BODY);

      const res = await health().set('Authorization', 'Bearer token-invalido');

      expect(res.status).toBe(200);
      expect(res.body).toEqual(HEALTHY_RESPONSE);
    });
  });
});
