jest.mock('../models/AssistantInsight', () => ({ findOneAndUpdate: jest.fn() }));
jest.mock('../models/Equipe', () => ({}));
jest.mock('../models/User', () => ({}));

const { ingestAssistantInsight } = require('../controllers/assistantInsightController');

const createResponse = () => {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
};

describe('segredo de ingestao de analytics', () => {
  const originalSecret = process.env.ASSISTANT_ANALYTICS_SECRET;

  afterEach(() => {
    if (originalSecret === undefined) delete process.env.ASSISTANT_ANALYTICS_SECRET;
    else process.env.ASSISTANT_ANALYTICS_SECRET = originalSecret;
  });

  test('falha fechada quando o segredo nao esta configurado', async () => {
    delete process.env.ASSISTANT_ANALYTICS_SECRET;
    const res = createResponse();
    await ingestAssistantInsight({ headers: {}, body: {} }, res);
    expect(res.status).toHaveBeenCalledWith(503);
  });

  test('rejeita segredo incorreto', async () => {
    process.env.ASSISTANT_ANALYTICS_SECRET = 'segredo-correto';
    const res = createResponse();
    await ingestAssistantInsight(
      { headers: { 'x-assistant-secret': 'incorreto' }, body: {} },
      res
    );
    expect(res.status).toHaveBeenCalledWith(401);
  });
});
