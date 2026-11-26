const AssistantInsight = require('../models/AssistantInsight');
const Equipe = require('../models/Equipe');
const User = require('../models/User');
const crypto = require('crypto');
const insightsAdmin = require('../services/insightsAdminService');

const secretsMatch = (expected, received) => {
  const expectedBuffer = Buffer.from(expected);
  const receivedBuffer = Buffer.from(String(received || ''));
  return expectedBuffer.length === receivedBuffer.length &&
    crypto.timingSafeEqual(expectedBuffer, receivedBuffer);
};

const CONTEUDO_OCULTO = {
  team_chat_blocked: 'Mensagem bloqueada pela moderação do chat. O conteúdo não é exibido.',
  outro: 'Registro do assistente. O conteúdo da conversa não é exibido.',
};

// Chave da equipe nos agrupamentos: teamId (ObjectId) ou, sem ele, o canal (texto), sempre como texto, para o
// mesmo time nao virar duas linhas (ObjectId e string sao chaves diferentes no MongoDB).
const TEAM_KEY = { $toString: { $ifNull: ['$teamId', '$channelId'] } };

const CHAT_INSIGHTS_DAYS = 7;
const BEHAVIOR_ALERT_DAYS = 14;
const ALERT_REASON_LABELS = {
  offensive_language: 'Linguagem ofensiva detectada',
  offensive_language_excess: 'Linguagem ofensiva recorrente',
  blocked_message: 'Mensagem bloqueada por segurança',
  moderation_profanity: 'Bloqueio por palavrão',
  moderation_insult: 'Bloqueio por insulto',
  moderation_threat: 'Bloqueio por ameaça',
  moderation_hate: 'Bloqueio por discurso de ódio ou discriminação',
  possible_conflict: 'Possível conflito na conversa',
  conflict_language: 'Linguagem de conflito detectada',
  help_request: 'Pedido de ajuda ou dúvida recorrente',
  team_help_needed: 'Equipe pode precisar de apoio',
  help_needed: 'Possível necessidade de apoio',
  negative_sentiment: 'Tom negativo recorrente',
  spam: 'Indício de spam ou uso inadequado',
};

const formatAlertLevel = (level = 'none') => ({
  high: 'Alto',
  medium: 'Médio',
  low: 'Baixo',
  none: 'Sem alerta',
}[level] || level);

const formatSignals = (signals = [], fallbackLevel = 'none') => {
  const flattened = [...new Set((signals || []).flat().filter(Boolean))];
  const labels = flattened.map((signal) => ALERT_REASON_LABELS[signal] || signal.replace(/_/g, ' '));

  if (labels.length > 0) {
    return labels;
  }

  if (fallbackLevel === 'high') {
    return ['Risco alto identificado no histórico recente'];
  }

  if (fallbackLevel === 'medium') {
    return ['Risco médio identificado no histórico recente'];
  }

  return ['Acompanhamento preventivo'];
};

const buildSuggestions = ({
  sentiments = {},
  topTopics = [],
  spamAlerts = 0,
  totalMessages = 0,
  criticalAlerts = 0,
  conflictRisk = 0,
}) => {
  const suggestions = [];
  const negative = sentiments.negativo || 0;
  const negativeRatio = totalMessages > 0 ? negative / totalMessages : 0;
  const topicNames = topTopics.map((item) => item.topic);

  if (negativeRatio >= 0.35) {
    suggestions.push('Priorize uma conversa com a equipe: há volume relevante de mensagens negativas.');
  }
  if (criticalAlerts > 0 || conflictRisk >= 0.5) {
    suggestions.push('Verifique possivel conflito ou necessidade de apoio: ha alertas criticos no chat da equipe.');
  }
  // Removidas (PR #64): "mensagens neutras podem esconder duvidas" e a sugestao pelo topico "chat", que e o
  // valor padrao quando nenhum assunto e reconhecido. Nenhuma das duas tinha evidencia nos registros.
  if (topicNames.includes('tarefas')) {
    suggestions.push('Revise clareza de tarefas, status e responsabilidades com a equipe.');
  }
  if (topicNames.includes('equipes')) {
    suggestions.push('Verifique dúvidas sobre composição, papéis ou comunicação da equipe.');
  }
  if (spamAlerts > 0) {
    suggestions.push('Investigue alertas de spam ou uso inadequado no canal da equipe.');
  }
  if (suggestions.length === 0) {
    suggestions.push('Nenhum sinal de acompanhamento foi registrado. A ausência de registros não garante que não existam dificuldades.');
  }

  return suggestions;
};

const buildAggregation = async (adminId) => {
  const chatSince = new Date(Date.now() - CHAT_INSIGHTS_DAYS * 24 * 60 * 60 * 1000);
  const behaviorSince = new Date(Date.now() - BEHAVIOR_ALERT_DAYS * 24 * 60 * 60 * 1000);
  const adminEquipes = await Equipe.find({
    $or: [{ membros: adminId }, { createdBy: adminId }],
  })
    .select('_id nome')
    .lean();
  const allowedTeamIds = adminEquipes.map((equipe) => String(equipe._id));
  const teamNames = adminEquipes.reduce((acc, equipe) => {
    acc[String(equipe._id)] = equipe.nome;
    return acc;
  }, {});

  const scopedTeamMatch = allowedTeamIds.length > 0
    ? {
        $or: [
          { teamId: { $in: adminEquipes.map((equipe) => equipe._id) } },
          // O canal so vale para registro sem teamId: um canal autorizado nao libera um teamId de outra equipe.
          { teamId: null, channelId: { $in: allowedTeamIds } },
        ],
      }
    : { _id: { $exists: false } };

  const chatMatch = {
    ...scopedTeamMatch,
    source: { $in: ['team_chat', 'team_chat_blocked'] },
    createdAt: { $gte: chatSince },
  };
  const scopedAnd = (extraMatch) => ({ $and: [scopedTeamMatch, extraMatch] });
  // Ranking por usuario: so indicadores da propria pessoa (bloqueios dela, spam ou linguagem ofensiva na mensagem
  // dela). Nivel, risco e sinais coletivos gravados na mensagem de quem falou por ultimo nao contam como conduta.
  const isUserBlock = { $eq: ['$source', 'team_chat_blocked'] };

  const [totalMessages, sentimentRows, topicRows, spamAlerts, criticalAlerts, recent, teamRows, behaviorRows] = await Promise.all([
    AssistantInsight.countDocuments(scopedTeamMatch),
    AssistantInsight.aggregate([
      { $match: scopedTeamMatch },
      { $group: { _id: '$sentiment', count: { $sum: 1 } } },
      { $sort: { count: -1 } },
    ]),
    AssistantInsight.aggregate([
      { $match: scopedTeamMatch },
      { $unwind: '$topics' },
      { $group: { _id: '$topics', count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $limit: 10 },
    ]),
    AssistantInsight.countDocuments({ ...scopedTeamMatch, spamAlert: true }),
    AssistantInsight.countDocuments({ ...scopedTeamMatch, alertLevel: { $in: ['medium', 'high'] } }),
    AssistantInsight.find(scopedAnd({
      $or: [
        { alertLevel: { $in: ['medium', 'high'] } },
        { helpNeeded: true },
        { spamAlert: true },
      ],
    }))
      .sort({ createdAt: -1 })
      .limit(12)
      .select('userId channelId teamId teamName content source sentiment topics spamAlert alertLevel conflictRisk helpNeeded signals recommendation createdAt')
      .lean(),
    AssistantInsight.aggregate([
      { $match: chatMatch },
      {
        $facet: {
          totals: [
            {
              $group: {
                _id: TEAM_KEY,
                totalMessages: { $sum: 1 },
                spamAlerts: { $sum: { $cond: ['$spamAlert', 1, 0] } },
                criticalAlerts: {
                  $sum: { $cond: [{ $in: ['$alertLevel', ['medium', 'high']] }, 1, 0] },
                },
                avgConflictRisk: { $avg: '$conflictRisk' },
              },
            },
          ],
          sentiments: [
            {
              $group: {
                _id: {
                  teamKey: TEAM_KEY,
                  sentiment: '$sentiment',
                },
                count: { $sum: 1 },
              },
            },
          ],
          topics: [
            { $unwind: '$topics' },
            {
              $group: {
                _id: {
                  teamKey: TEAM_KEY,
                  topic: '$topics',
                },
                count: { $sum: 1 },
              },
            },
            { $sort: { count: -1 } },
          ],
        },
      },
    ]),
    AssistantInsight.aggregate([
      {
        $match: scopedAnd({
          source: { $in: ['team_chat', 'team_chat_blocked'] },
          createdAt: { $gte: behaviorSince },
          $or: [
            { source: 'team_chat_blocked' },
            { spamAlert: true },
            { signals: 'offensive_language' },
          ],
        }),
      },
      {
        $group: {
          _id: {
            teamKey: TEAM_KEY,
            userId: '$userId',
          },
          count: { $sum: 1 },
          highAlerts: { $sum: { $cond: [{ $and: [isUserBlock, { $eq: ['$alertLevel', 'high'] }] }, 1, 0] } },
          spamAlerts: { $sum: { $cond: ['$spamAlert', 1, 0] } },
          // Risco individual so dos bloqueios (nas mensagens aprovadas o risco gravado e o da equipe).
          avgConflictRisk: { $avg: { $cond: [isUserBlock, '$conflictRisk', null] } },
          signals: {
            $addToSet: {
              $cond: [
                isUserBlock,
                '$signals',
                { $filter: { input: { $ifNull: ['$signals', []] }, cond: { $eq: ['$$this', 'offensive_language'] } } },
              ],
            },
          },
          lastAt: { $max: '$createdAt' },
        },
      },
      { $sort: { highAlerts: -1, count: -1, avgConflictRisk: -1 } },
      { $limit: 20 },
    ]),
  ]);

  const sentiments = sentimentRows.reduce((acc, row) => {
    acc[row._id || 'neutro'] = row.count;
    return acc;
  }, { positivo: 0, neutro: 0, negativo: 0 });

  const teamFacet = teamRows[0] || { totals: [], sentiments: [], topics: [] };

  const recentUserIds = recent.map((item) => item.userId).filter(Boolean);
  const behaviorUserIds = behaviorRows.map((row) => row._id.userId).filter(Boolean);
  const users = await User.find({ _id: { $in: [...new Set([...recentUserIds, ...behaviorUserIds])] } })
    .select('nome email')
    .lean();
  const userNames = users.reduce((acc, user) => {
    acc[String(user._id)] = user.nome || user.email || String(user._id);
    return acc;
  }, {});

  const recentAlerts = recent.map((item) => {
    const reasonSignals = [
      ...(item.signals || []),
      ...(item.spamAlert ? ['spam'] : []),
      ...(item.helpNeeded ? ['help_needed'] : []),
    ];
    const reasonLabels = formatSignals(reasonSignals, item.alertLevel);
    // Alerta coletivo (tendencia da conversa) gravado na mensagem de quem falou por ultimo: nao e atribuido a ela.
    const scope = item.source === 'team_chat_blocked' || item.spamAlert || (item.signals || []).includes('offensive_language')
      ? 'user'
      : 'team';

    return {
      ...item,
      // Bloqueios antigos (antes do PR #61) guardavam o texto original, e eventos do assistente guardam a conversa:
      // so a mensagem aprovada do chat (que os administradores da equipe ja leem no chat) sai como texto.
      content: item.source === 'team_chat' ? item.content : CONTEUDO_OCULTO[item.source] || CONTEUDO_OCULTO.outro,
      scope,
      userName: scope === 'team' ? 'Indicador coletivo da equipe' : userNames[String(item.userId)] || item.userId,
      alertLevelLabel: formatAlertLevel(item.alertLevel),
      reasonLabels,
      reasonText: reasonLabels.join(', '),
    };
  });

  const byTeam = teamFacet.totals.map((row) => {
    const channelId = String(row._id || 'web');
    const sentimentsByTeam = teamFacet.sentiments
      .filter((item) => String(item._id.teamKey || 'web') === channelId)
      .reduce((acc, item) => {
        acc[item._id.sentiment || 'neutro'] = item.count;
        return acc;
      }, { positivo: 0, neutro: 0, negativo: 0 });
    const topTopics = teamFacet.topics
      .filter((item) => String(item._id.teamKey || 'web') === channelId)
      .slice(0, 6)
      .map((item) => ({ topic: item._id.topic, count: item.count }));
    const teamInsight = {
      channelId,
      teamName: teamNames[channelId] || (channelId === 'web' ? 'Canal Web' : `Equipe ${channelId.slice(-6)}`),
      totalMessages: row.totalMessages,
      spamAlerts: row.spamAlerts,
      criticalAlerts: row.criticalAlerts || 0,
      conflictRisk: Number((row.avgConflictRisk || 0).toFixed(2)),
      sentiments: sentimentsByTeam,
      topTopics,
    };
    return {
      ...teamInsight,
      suggestions: buildSuggestions(teamInsight),
    };
  }).sort((a, b) => b.totalMessages - a.totalMessages);

  const badActors = behaviorRows
    .map((row) => {
      const channelId = String(row._id.teamKey || 'web');
      const flattenedSignals = [
        ...new Set([
          ...(row.signals || []).flat().filter(Boolean),
          ...(row.spamAlerts > 0 ? ['spam'] : []),
        ]),
      ];
      const reasonLabels = formatSignals(flattenedSignals, row.highAlerts > 0 ? 'high' : 'medium');
      return {
        channelId,
        teamName: teamNames[channelId] || (channelId === 'web' ? 'Canal Web' : `Equipe ${channelId.slice(-6)}`),
        userId: row._id.userId,
        userName: userNames[String(row._id.userId)] || row._id.userId,
        count: row.count,
        highAlerts: row.highAlerts || 0,
        spamAlerts: row.spamAlerts || 0,
        conflictRisk: Number((row.avgConflictRisk || 0).toFixed(2)),
        signals: flattenedSignals,
        reasonLabels,
        reasonText: reasonLabels.join(', '),
        lastAt: row.lastAt,
        recommendation: row.highAlerts > 0 || row.count >= 3
          ? 'Converse em particular com este usuario e acompanhe a conduta nas proximas interacoes.'
          : 'Observe o comportamento deste usuario nas proximas conversas da equipe.',
      };
    })
    .filter((item) => item.count >= 2 || item.highAlerts > 0 || item.conflictRisk >= 0.5);

  const globalInsight = {
    totalMessages,
    sentiments,
    topTopics: topicRows.map((row) => ({ topic: row._id, count: row.count })),
    spamAlerts,
    criticalAlerts,
    recent: recentAlerts,
    byTeam,
    chatSummaries: byTeam,
    chatWindowDays: CHAT_INSIGHTS_DAYS,
    badActors,
    behaviorWindowDays: BEHAVIOR_ALERT_DAYS,
  };

  return {
    ...globalInsight,
    suggestions: buildSuggestions(globalInsight),
  };
};

const ingestAssistantInsight = async (req, res) => {
  const expectedSecret = process.env.ASSISTANT_ANALYTICS_SECRET || '';
  const receivedSecret = req.headers['x-assistant-secret'];

  if (!expectedSecret) {
    return res.status(503).json({ success: false, error: 'Servico interno nao configurado' });
  }

  if (!secretsMatch(expectedSecret, receivedSecret)) {
    return res.status(401).json({ success: false, error: 'Segredo interno inválido' });
  }

  const { event, insight } = req.body || {};
  if (!event?.id || !event?.userId || !event?.content || !insight) {
    return res.status(400).json({ success: false, error: 'Payload de insight inválido' });
  }

  try {
    const document = await AssistantInsight.findOneAndUpdate(
      { eventId: event.id },
      {
        eventId: event.id,
        userId: String(event.userId),
        channelId: event.channelId || 'web',
        teamId: /^[a-fA-F0-9]{24}$/.test(String(event.teamId || event.channelId || ''))
          ? String(event.teamId || event.channelId)
          : undefined,
        teamName: event.teamName || undefined,
        content: String(event.content),
        source: event.source || 'frontend',
        eventCreatedAt: event.createdAt ? new Date(event.createdAt) : undefined,
        sentiment: insight.sentiment || 'neutro',
        topics: Array.isArray(insight.topics) ? insight.topics : [],
        entities: Array.isArray(insight.entities) ? insight.entities : [],
        spamAlert: Boolean(insight.spam_alert ?? insight.spamAlert),
        alertLevel: insight.alertLevel || insight.alert_level || 'none',
        conflictRisk: Number(insight.conflictRisk ?? insight.conflict_risk ?? 0),
        helpNeeded: Boolean(insight.helpNeeded ?? insight.help_needed),
        signals: Array.isArray(insight.signals) ? insight.signals : [],
        recommendation: insight.recommendation || undefined,
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    return res.status(201).json({ success: true, id: document._id });
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Erro ao salvar insight do assistente' });
  }
};

// Sem `versao`: resposta antiga, para o frontend que ja esta publicado. `versao=2`: contrato novo, com periodo,
// equipe e ocorrencia (services/insightsAdminService.js). A resposta nova sempre traz `versao: 2`; o frontend
// novo so trata como dados do periodo uma resposta com esse campo.
const getAssistantInsights = async (req, res) => {
  const versao = req.query?.versao;
  if (versao !== undefined) {
    if (versao !== String(insightsAdmin.VERSAO)) {
      return res.status(400).json({ success: false, codigo: 'versao_invalida', erro: 'Versão do contrato de insights não suportada.' });
    }
    try {
      const insights = await insightsAdmin.obterInsightsAdmin({ adminId: req.user.id, query: req.query });
      return res.json({ success: true, versao: insightsAdmin.VERSAO, insights });
    } catch (err) {
      if (err instanceof insightsAdmin.ParametroInvalido) {
        return res.status(400).json({ success: false, codigo: err.codigo, erro: err.message });
      }
      console.error('Erro ao carregar insights administrativos:', err?.message || err);
      return res.status(500).json({ success: false, error: 'Erro ao carregar insights do assistente' });
    }
  }

  try {
    const insights = await buildAggregation(req.user.id);
    return res.json({ success: true, insights });
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Erro ao carregar insights do assistente' });
  }
};

module.exports = {
  ingestAssistantInsight,
  getAssistantInsights,
};
