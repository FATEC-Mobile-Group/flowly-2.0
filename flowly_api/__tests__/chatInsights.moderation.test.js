// Insights do chat: criterio ofensivo da moderacao, recorrencia individual (mesmo usuario, mesma equipe, 24 h),
// indicadores coletivos separados, cooldown por chave e mensagem bloqueada sem o texto original.
// Sem banco e sem rede: uma base em memoria avalia os mesmos filtros (igualdade, $in, $ne, $gte) das consultas,
// e o relogio e fixo, entao janela e cooldown sao deterministicos.
const mockDb = { insights: [], notifications: [], clock: new Date('2026-11-25T12:00:00.000Z'), seq: 0 };

const mockGet = (doc, path) => path.split('.').reduce((value, key) => (value == null ? undefined : value[key]), doc);
const mockMatches = (doc, filter) => Object.entries(filter).every(([key, condition]) => {
  const value = mockGet(doc, key);
  const isOperator = condition && typeof condition === 'object' && !(condition instanceof Date)
    && Object.keys(condition).some((op) => op.startsWith('$'));
  if (!isOperator) return String(value) === String(condition);
  return Object.entries(condition).every(([op, arg]) => {
    if (op === '$in') return arg.map(String).includes(String(value));
    if (op === '$ne') return String(value) !== String(arg);
    if (op === '$gte') return value != null && value >= arg;
    throw new Error(`operador nao suportado no teste: ${op}`);
  });
});

jest.mock('../models/AssistantInsight', () => ({
  find: (filter) => ({
    sort: () => ({
      limit: (limit) => ({
        select: () => ({
          lean: async () => mockDb.insights
            .filter((doc) => mockMatches(doc, filter))
            .sort((a, b) => b.createdAt - a.createdAt)
            .slice(0, limit),
        }),
      }),
    }),
  }),
  countDocuments: async (filter) => mockDb.insights.filter((doc) => mockMatches(doc, filter)).length,
  findOneAndUpdate: async (filter, update) => {
    const existing = mockDb.insights.find((doc) => doc.eventId === filter.eventId);
    if (existing) return Object.assign(existing, update);
    mockDb.seq += 1;
    const doc = { _id: `insight-${mockDb.seq}`, createdAt: new Date(mockDb.clock), ...update };
    mockDb.insights.push(doc);
    return doc;
  },
}));
jest.mock('../models/Notification', () => ({
  findOne: (filter) => ({ select: async () => mockDb.notifications.find((doc) => mockMatches(doc, filter)) || null }),
}));
jest.mock('../models/User', () => ({
  find: () => ({ select: () => ({ lean: async () => [] }) }),
  findById: (id) => ({ select: () => ({ lean: async () => ({ nome: `Pessoa ${String(id).slice(-1)}` }) }) }),
}));
const mockNotifyUsers = jest.fn(async (payload) => {
  mockDb.notifications.push({ ...payload, createdAt: new Date(mockDb.clock) });
  return [];
});
jest.mock('../utils/notificationService', () => ({ notifyUsers: (...args) => mockNotifyUsers(...args) }));

const { mineText, analyzeConversationTrend, individualModerationAlert } = require('../services/nlpMiningService');
const { saveBlockedChatInsight, saveChatInsight } = require('../services/assistantInsightService');

const HOUR = 60 * 60 * 1000;
const TEAM_X = { _id: '507f1f77bcf86cd799439091', nome: 'Equipe X', createdBy: '507f1f77bcf86cd799439001', membros: [] };
const TEAM_Y = { _id: '507f1f77bcf86cd799439092', nome: 'Equipe Y', createdBy: '507f1f77bcf86cd799439001', membros: [] };
const A = '507f1f77bcf86cd79943901a';
const B = '507f1f77bcf86cd79943901b';
const C = '507f1f77bcf86cd79943901c';

const advance = (ms) => { mockDb.clock = new Date(mockDb.clock.getTime() + ms); };
const block = (userId, { category = 'profanity', equipe = TEAM_X } = {}) => {
  advance(60 * 1000); // um minuto entre ocorrencias: eventId e createdAt distintos e ordenados
  return saveBlockedChatInsight({ equipe, userId, reason: 'unsafe_content', category, now: new Date(mockDb.clock) });
};
const chat = (userId, texto, equipe = TEAM_X) => {
  advance(60 * 1000);
  mockDb.seq += 1;
  return saveChatInsight({ message: { _id: `m${mockDb.seq}`, texto }, equipe, userId, now: new Date(mockDb.clock) });
};
const userAlerts = () => mockNotifyUsers.mock.calls.map(([payload]) => payload.metadata).filter((m) => m.scope === 'user');
const teamAlerts = () => mockNotifyUsers.mock.calls.map(([payload]) => payload.metadata).filter((m) => m.scope === 'team');

beforeEach(() => {
  jest.clearAllMocks();
  mockDb.insights = [];
  mockDb.notifications = [];
  mockDb.clock = new Date('2026-11-25T12:00:00.000Z');
  mockDb.seq = 0;
});

describe('mineText: linguagem ofensiva com o criterio da moderacao', () => {
  test.each([
    'Precisamos descartar o lixo eletrônico',
    'O burro é um animal doméstico',
    'Que burro eu fui, esqueci o PDF',
    'Vamos estudar a ascensão do nazismo',
  ])('termo legítimo não gera offensive_language: %s', (text) => {
    expect(mineText(text).signals).not.toContain('offensive_language');
  });

  test.each(['Você é um idiota', 'que merda', 'Morte aos judeus'])('infração efetiva gera offensive_language: %s', (text) => {
    expect(mineText(text).signals).toContain('offensive_language');
  });

  test('sentimento, tópicos e demais sinais continuam', () => {
    const mined = mineText('Preciso de ajuda com o erro na tarefa da equipe');
    expect(mined.sentiment).toBe('negativo');
    expect(mined.topics).toEqual(expect.arrayContaining(['tarefas', 'equipes']));
    expect(mined.signals).toContain('help_request');
  });
});

describe('individualModerationAlert: política determinística', () => {
  test.each([
    [1, false, 'low', 0.33],
    [2, false, 'medium', 0.67],
    [3, false, 'high', 1],
    [7, false, 'high', 1],
    [1, true, 'high', 1],
  ])('%i ocorrência(s), grave=%s -> %s', (occurrences, severe, alertLevel, conflictRisk) => {
    expect(individualModerationAlert({ occurrences, severe })).toMatchObject({ alertLevel, conflictRisk });
  });

  test('o sinal de recorrência individual só a partir da segunda ocorrência', () => {
    expect(individualModerationAlert({ occurrences: 1 }).signals).toEqual([]);
    expect(individualModerationAlert({ occurrences: 2 }).signals).toEqual(['offensive_language_excess']);
  });
});

describe('recorrência individual: mesmo usuário, mesma equipe, 24 horas', () => {
  test('1. infração isolada: low, sem notificação', async () => {
    const doc = await block(A);
    expect(doc).toMatchObject({ alertLevel: 'low', userId: A, source: 'team_chat_blocked' });
    expect(doc.signals).not.toContain('offensive_language_excess');
    expect(mockNotifyUsers).not.toHaveBeenCalled();
  });

  test('2. A, B e C com uma infração cada: ninguém é reincidente', async () => {
    const docs = [await block(A), await block(B, { category: 'insult' }), await block(C)];
    expect(docs.map((doc) => doc.alertLevel)).toEqual(['low', 'low', 'low']);
    docs.forEach((doc) => expect(doc.signals).not.toContain('offensive_language_excess'));
    expect(mockNotifyUsers).not.toHaveBeenCalled();
  });

  test('3 e 4. mesmo usuário: segunda em 24 h é medium, terceira é high (cada ocorrência conta uma vez)', async () => {
    const first = await block(A);
    advance(5 * HOUR);
    const second = await block(A, { category: 'insult' });
    advance(5 * HOUR);
    const third = await block(A);

    expect([first.alertLevel, second.alertLevel, third.alertLevel]).toEqual(['low', 'medium', 'high']);
    expect(userAlerts().map((m) => [m.userId, m.alertLevel, m.occurrences, m.alertReason])).toEqual([
      [A, 'medium', 2, 'recurrence'],
      [A, 'high', 3, 'recurrence'],
    ]);
  });

  test('5. infrações fora da janela de 24 horas não elevam a recorrência', async () => {
    await block(A);
    await block(A);
    advance(24 * HOUR + 1);
    expect((await block(A)).alertLevel).toBe('low');
  });

  test('6. infrações do mesmo usuário em equipes diferentes não são somadas', async () => {
    expect((await block(A, { equipe: TEAM_X })).alertLevel).toBe('low');
    expect((await block(A, { equipe: TEAM_Y })).alertLevel).toBe('low');
    expect(mockNotifyUsers).not.toHaveBeenCalled();
  });

  test('7 e 8. ameaça e ódio isolados: high e notificados na primeira vez', async () => {
    const threat = await block(A, { category: 'threat' });
    const hate = await block(B, { category: 'hate' });
    expect([threat.alertLevel, hate.alertLevel]).toEqual(['high', 'high']);
    expect(userAlerts().map((m) => [m.userId, m.alertReason, m.alertLevel])).toEqual([
      [A, 'threat', 'high'],
      [B, 'hate', 'high'],
    ]);
    expect(mockNotifyUsers.mock.calls[1][0].texto).toContain('discurso de ódio ou discriminação');
  });

  test('9. mensagem legítima de outro usuário depois de bloqueios não é atribuída a ele', async () => {
    await block(B);
    await block(B);
    await block(B);
    const legit = await chat(A, 'Bom dia, equipe! Subi a revisão do relatório');

    expect(legit).toMatchObject({ userId: A, source: 'team_chat', alertLevel: 'none' });
    expect(legit.signals).not.toEqual(expect.arrayContaining(['blocked_message']));
    expect(legit.signals).not.toContain('offensive_language_excess');
    expect(userAlerts().every((m) => m.userId === B)).toBe(true);
    expect(teamAlerts()).toHaveLength(0);
  });
});

describe('cooldown das notificações', () => {
  test('10. o alerta de A não impede o alerta pertinente de B', async () => {
    await block(A);
    await block(A);
    await block(B);
    await block(B);
    expect(userAlerts().map((m) => [m.userId, m.alertLevel])).toEqual([[A, 'medium'], [B, 'medium']]);
  });

  test('11. alerta anterior de menor gravidade não impede a nova ocorrência grave', async () => {
    await block(A);
    await block(A); // medium por recorrencia
    await block(A, { category: 'threat' }); // high por ameaca: motivo e gravidade diferentes
    expect(userAlerts().map((m) => [m.alertReason, m.alertLevel])).toEqual([['recurrence', 'medium'], ['threat', 'high']]);
  });

  test('12. ocorrências repetidas não geram tempestade; passado o cooldown, volta a notificar', async () => {
    for (let i = 0; i < 6; i += 1) await block(A); // 1 low, 1 medium, 4 high na mesma hora
    expect(userAlerts().map((m) => m.alertLevel)).toEqual(['medium', 'high']);

    await block(A, { category: 'hate' });
    await block(A, { category: 'hate' });
    expect(userAlerts().filter((m) => m.alertReason === 'hate')).toHaveLength(1);

    advance(HOUR + 1);
    await block(A);
    expect(userAlerts().map((m) => m.alertLevel)).toEqual(['medium', 'high', 'high', 'high']);
  });
});

describe('privacidade e indicadores coletivos', () => {
  test('13. registro bloqueado sem o texto original, com os metadados necessários', async () => {
    const original = 'Que merda SEGREDO-XYZ, Fulano Beltrano';
    await saveBlockedChatInsight({ texto: original, equipe: TEAM_X, userId: A, reason: 'unsafe_content', category: 'profanity', now: mockDb.clock });
    await saveBlockedChatInsight({ texto: original, equipe: TEAM_X, userId: A, reason: 'unsafe_content', category: 'profanity', now: new Date(mockDb.clock.getTime() + 1000) });

    const [doc] = mockDb.insights;
    expect(doc).toMatchObject({
      eventId: expect.stringMatching(/^chat_blocked:/),
      userId: A,
      teamId: TEAM_X._id,
      source: 'team_chat_blocked',
      content: 'Mensagem bloqueada pela moderação do chat (palavrão). Motivo: unsafe_content.',
      entities: [],
      topics: ['chat'],
      spamAlert: true,
    });
    expect(doc.eventCreatedAt).toBeInstanceOf(Date);
    expect(doc.signals).toEqual(expect.arrayContaining(['blocked_message', 'moderation_profanity']));
    expect(JSON.stringify([mockDb.insights, mockDb.notifications])).not.toMatch(/SEGREDO|Fulano|merda/);
  });

  test('14. indicador coletivo continua funcionando, sem citar ninguém, e separado dos alertas individuais', async () => {
    await block(A);
    await block(A); // alerta individual de A
    const conflito = ['Essa briga sobre o erro não resolve', 'O problema é a culpa de quem atrasou', 'Mais um erro, conflito de novo'];
    const docs = [];
    for (const [index, texto] of conflito.entries()) docs.push(await chat([A, B, C][index], texto));

    expect(docs.at(-1).signals).toContain('possible_conflict');
    expect(['medium', 'high']).toContain(docs.at(-1).alertLevel);
    // O alerta individual de A na ultima hora nao cala o coletivo, e o coletivo nao leva usuario.
    expect(teamAlerts()).toHaveLength(1);
    expect(teamAlerts()[0]).not.toHaveProperty('userId');
    expect(teamAlerts()[0]).not.toHaveProperty('userName');
    expect(mockNotifyUsers.mock.calls.at(-1)[0].texto).not.toMatch(/Pessoa/);
    // A tendencia coletiva nao produz sinal de conduta individual.
    docs.forEach((doc) => expect(doc.signals).not.toContain('offensive_language_excess'));
  });

  test('15. a tendência coletiva ignora bloqueios e não usa parâmetros individuais', () => {
    const result = analyzeConversationTrend({
      currentInsight: mineText('Bom dia, equipe'),
      recentInsights: [{ sentiment: 'neutro', signals: ['blocked_message'], alertLevel: 'high' }],
    });
    expect(result.alertLevel).toBe('none');
    expect(result.signals).not.toContain('offensive_language_excess');
  });
});
