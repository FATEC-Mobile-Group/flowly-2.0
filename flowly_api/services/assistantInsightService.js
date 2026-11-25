const AssistantInsight = require('../models/AssistantInsight');
const Notification = require('../models/Notification');
const User = require('../models/User');
const { mineText, analyzeConversationTrend, individualModerationAlert } = require('./nlpMiningService');
const { notifyUsers } = require('../utils/notificationService');

const ALERT_COOLDOWN_MS = 60 * 60 * 1000;
// Recorrencia individual: so bloqueios do mesmo usuario, na mesma equipe, nas ultimas 24 horas.
const INDIVIDUAL_WINDOW_MS = 24 * 60 * 60 * 1000;
const LEVELS_FROM = {
  low: ['low', 'medium', 'high'],
  medium: ['medium', 'high'],
  high: ['high'],
};

// Categorias da moderacao que justificam alerta ja na primeira ocorrencia.
const SEVERE_MODERATION_CATEGORIES = new Set(['threat', 'hate']);
const MODERATION_CATEGORY_LABELS = {
  profanity: 'palavrão',
  insult: 'insulto',
  threat: 'ameaça',
  hate: 'discurso de ódio ou discriminação',
};

// Indicadores coletivos (sentimento, conflito, ajuda): so mensagens aprovadas da equipe. Bloqueios ficam fora,
// porque sao conduta individual e nao podem pesar no registro de quem mandou a mensagem seguinte.
const recentTeamInsights = async (teamId, limit = 12) => AssistantInsight.find({
  teamId,
  source: 'team_chat',
})
  .sort({ createdAt: -1 })
  .limit(limit)
  .select('sentiment signals alertLevel helpNeeded conflictRisk')
  .lean();

// Bloqueios anteriores do mesmo usuario na mesma equipe dentro da janela (o atual ainda nao foi gravado).
const countRecentUserBlocks = async ({ teamId, userId, now }) => AssistantInsight.countDocuments({
  teamId,
  userId: String(userId),
  source: 'team_chat_blocked',
  createdAt: { $gte: new Date(now.getTime() - INDIVIDUAL_WINDOW_MS) },
});

const adminRecipientsForTeam = async (equipe) => {
  const recipients = new Set();
  if (equipe.createdBy) {
    recipients.add(String(equipe.createdBy));
  }

  const memberIds = (equipe.membros || []).map((membro) => String(membro._id || membro));
  if (memberIds.length) {
    const adminMembers = await User.find({ _id: { $in: memberIds }, tipo: 'admin' }).select('_id').lean();
    adminMembers.forEach((admin) => recipients.add(String(admin._id)));
  }

  return [...recipients];
};

// Cooldown: a mesma chave com gravidade igual ou maior na ultima hora suprime o alerta; gravidade menor nao.
const recentlyNotified = async ({ keyFilter, alertLevel, now }) => Notification.findOne({
  tipo: 'system',
  createdAt: { $gte: new Date(now.getTime() - ALERT_COOLDOWN_MS) },
  'metadata.kind': 'team_insight_alert',
  'metadata.alertLevel': { $in: LEVELS_FROM[alertLevel] || [alertLevel] },
  ...keyFilter,
}).select('_id');

// Alerta coletivo: chave por equipe (sem usuario). Nao cita ninguem: e indicador da conversa, nao conduta.
const maybeNotifyTeamInsight = async ({ document, equipe, now }) => {
  if (!['medium', 'high'].includes(document.alertLevel) && !document.helpNeeded) {
    return;
  }
  const alertLevel = ['medium', 'high'].includes(document.alertLevel) ? document.alertLevel : 'medium';
  const equipeId = String(equipe._id);
  // Notificacoes antigas nao tem `scope`: contam como coletivas.
  if (await recentlyNotified({ keyFilter: { 'metadata.equipeId': equipeId, 'metadata.scope': { $ne: 'user' } }, alertLevel, now })) {
    return;
  }

  const userIds = await adminRecipientsForTeam(equipe);
  if (!userIds.length) {
    return;
  }

  const risco = Math.round((document.conflictRisk || 0) * 100);
  const texto = alertLevel === 'high'
    ? `Alerta critico na equipe ${equipe.nome}: sinais de conflito ou tom negativo recorrente na conversa. Risco ${risco}%.`
    : `Acompanhamento recomendado na equipe ${equipe.nome}: possivel atrito ou necessidade de ajuda. Risco ${risco}%.`;

  await notifyUsers({
    userIds,
    texto,
    tipo: 'system',
    origemId: document._id,
    metadata: {
      kind: 'team_insight_alert',
      scope: 'team',
      equipeId,
      insightId: String(document._id),
      alertLevel,
      conflictRisk: document.conflictRisk,
      signals: document.signals || [],
    },
  });
};

// Alerta individual de moderacao: chave por equipe + usuario + motivo (ameaca, odio ou recorrencia), entao o
// alerta de A nao cala o de B e a recorrencia nao cala a primeira ameaca. Sem o texto bloqueado.
const maybeNotifyModerationAlert = async ({ document, equipe, alertReason, occurrences, now }) => {
  if (!['medium', 'high'].includes(document.alertLevel)) {
    return;
  }
  const equipeId = String(equipe._id);
  const userId = String(document.userId);
  const keyFilter = {
    'metadata.scope': 'user',
    'metadata.equipeId': equipeId,
    'metadata.userId': userId,
    'metadata.alertReason': alertReason,
  };
  if (await recentlyNotified({ keyFilter, alertLevel: document.alertLevel, now })) {
    return;
  }

  const userIds = await adminRecipientsForTeam(equipe);
  if (!userIds.length) {
    return;
  }

  const actor = await User.findById(userId).select('nome email').lean();
  const actorName = actor?.nome || actor?.email || 'Um usuario';
  const texto = alertReason === 'recurrence'
    ? `Alerta de comportamento na equipe ${equipe.nome}: ${actorName} teve ${occurrences} mensagens bloqueadas nas últimas 24 horas.`
    : `Alerta de comportamento na equipe ${equipe.nome}: uma mensagem de ${actorName} foi bloqueada por ${MODERATION_CATEGORY_LABELS[alertReason]}.`;

  await notifyUsers({
    userIds,
    texto,
    tipo: 'system',
    origemId: document._id,
    metadata: {
      kind: 'team_insight_alert',
      scope: 'user',
      alertReason,
      equipeId,
      insightId: String(document._id),
      alertLevel: document.alertLevel,
      conflictRisk: document.conflictRisk,
      signals: document.signals || [],
      occurrences,
      userId,
      userName: actorName,
    },
  });
};

const saveChatInsight = async ({ message, equipe, userId, now = new Date() }) => {
  const mined = mineText(message.texto);
  const recentInsights = await recentTeamInsights(equipe._id);
  const trend = analyzeConversationTrend({ currentInsight: mined, recentInsights });

  const document = await AssistantInsight.findOneAndUpdate(
    { eventId: `chat:${message._id}` },
    {
      eventId: `chat:${message._id}`,
      userId: String(userId),
      channelId: String(equipe._id),
      teamId: equipe._id,
      teamName: equipe.nome,
      content: message.texto,
      source: 'team_chat',
      eventCreatedAt: now,
      sentiment: mined.sentiment,
      topics: mined.topics,
      entities: mined.entities,
      spamAlert: Boolean(mined.spamAlert),
      alertLevel: trend.alertLevel,
      conflictRisk: trend.conflictRisk,
      helpNeeded: trend.helpNeeded,
      signals: trend.signals,
      recommendation: trend.recommendation,
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

  await maybeNotifyTeamInsight({ document, equipe, now });
  return document;
};

// Mensagem bloqueada: o texto original nao e recebido nem gravado (content, entidades, topicos, notificacoes).
// Ficam so os dados dos indicadores: evento, usuario, equipe, data, motivo, categoria e a recorrencia individual.
const saveBlockedChatInsight = async ({ equipe, userId, reason, category, now = new Date() }) => {
  const label = MODERATION_CATEGORY_LABELS[category];
  const severe = SEVERE_MODERATION_CATEGORIES.has(category);
  const occurrences = (await countRecentUserBlocks({ teamId: equipe._id, userId, now })) + 1;
  const individual = individualModerationAlert({ occurrences, severe });
  const eventId = `chat_blocked:${equipe._id}:${userId}:${now.getTime()}`;

  const document = await AssistantInsight.findOneAndUpdate(
    { eventId },
    {
      eventId,
      userId: String(userId),
      channelId: String(equipe._id),
      teamId: equipe._id,
      teamName: equipe.nome,
      content: `Mensagem bloqueada pela moderação do chat${label ? ` (${label})` : ''}. Motivo: ${reason || 'unsafe_content'}.`,
      source: 'team_chat_blocked',
      eventCreatedAt: now,
      sentiment: 'neutro',
      topics: ['chat'],
      entities: [],
      spamAlert: true,
      alertLevel: individual.alertLevel,
      conflictRisk: individual.conflictRisk,
      helpNeeded: false,
      signals: ['blocked_message', ...(label ? [`moderation_${category}`] : []), ...individual.signals],
      recommendation: individual.recommendation,
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

  await maybeNotifyModerationAlert({
    document,
    equipe,
    alertReason: severe ? category : 'recurrence',
    occurrences,
    now,
  });
  return document;
};

module.exports = {
  saveChatInsight,
  saveBlockedChatInsight,
  INDIVIDUAL_WINDOW_MS,
  ALERT_COOLDOWN_MS,
};
