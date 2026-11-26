// Insights administrativos, contrato versao 2 (GET /api/admin/assistant-insights?versao=2).
// So leitura e apresentacao: nada aqui grava, migra ou reclassifica registros, e as janelas que disparam os
// alertas do chat (assistantInsightService) nao mudam. O periodo escolhido so seleciona quais registros entram.
//
// Fontes:
// - AssistantInsight: registros de analise. Origem pelo campo `source` (ver ORIGENS_ASSISTENTE): team_chat
//   (mensagem aprovada do chat, um registro por mensagem), team_chat_blocked (tentativa bloqueada pela moderacao),
//   valores conhecidos do assistente e, para todo o resto (ausente, vazio, inesperado), origem desconhecida.
// - Notification (metadata.kind = team_insight_alert): alertas efetivamente emitidos. Cada alerta gera uma
//   notificacao por destinatario; aqui eles sao contados uma vez (identidade em `identidadeDoAlerta`).
//
// Totais completos ou indisponiveis: o banco devolve contagens ja agregadas por chaves de cardinalidade controlada
// (equipe x origem x categoria, dia x origem, equipe x assunto; alertas por equipe x escopo x vinculo). Se mesmo
// assim um limite de protecao for atingido, os indicadores que dependem daquele resultado saem como null (nunca
// como zero) e as recomendacoes nao sao geradas.
//
// Privacidade: o campo `content` nunca e lido. Registros bloqueados antigos (antes do PR #61) guardavam o texto
// original nele, e os eventos do assistente guardam o texto da conversa.
const mongoose = require('mongoose');
const AssistantInsight = require('../models/AssistantInsight');
const Equipe = require('../models/Equipe');
const Notification = require('../models/Notification');
const User = require('../models/User');

const VERSAO = 2;
const FUSO_HORARIO = 'America/Sao_Paulo';
const PERIODOS_VALIDOS = [7, 14, 30];
const PERIODO_PADRAO = 7;
// Protecoes de volume (grupos devolvidos por resultado agregado). Com as chaves atuais elas so seriam atingidas
// com centenas de equipes no escopo; quando atingidas, a resposta marca o resultado como parcial.
const LIMITE_GRUPOS_REGISTROS = 5000;
const LIMITE_GRUPOS_ALERTAS = 2000;
// Limites intencionais de listas (nao afetam totais): alertas mais recentes e ocorrencias recentes de moderacao.
const LIMITE_ALERTAS_LISTA = 100;
const LIMITE_MODERACAO_RECENTES = 20;
const LIMITE_ASSUNTOS_POR_EQUIPE = 6;

const OBJECT_ID_RE = /^[a-f\d]{24}$/i;
const OBJECT_ID_REGEX_TEXTO = '^[a-fA-F0-9]{24}$';

// Valores de `source` que o codigo de producao grava para eventos do assistente:
// - flowly_assistente/flowly_assistant/assistant_core/message_agent.py: "source": self.body.get("source") or "frontend"
//   (o cliente web, VoiceAssistantPage.jsx, nao envia `source`; o app Flutter nao chama o assistente);
// - flowly_assistente/flowly_assistant/storage/analytics_repository.py: event.get("source") or "frontend";
// - rota interna POST /api/admin/assistant-insights/ingest (este backend): event.source || 'frontend'.
// Limite: `source` vem do corpo da requisicao ao assistente e nao e autenticado. A classificacao descreve o valor
// gravado, nao prova a procedencia do evento.
const ORIGENS_ASSISTENTE = ['frontend'];

const origemDoRegistro = (source) => {
  if (source === 'team_chat') return 'chat';
  if (source === 'team_chat_blocked') return 'moderacao';
  if (typeof source === 'string' && ORIGENS_ASSISTENTE.includes(source)) return 'assistente';
  return 'desconhecida';
};

// Categorias reais da moderacao do chat (nlpModerationService.classifyText), gravadas desde o PR #61 como
// sinal `moderation_<categoria>`. Bloqueio sem esse sinal (historico, ou motivo sem categoria como mensagem
// vazia ou longa demais) fica em `sem_categoria`: nao ha como saber o motivo sem ler o conteudo.
const CATEGORIAS_MODERACAO = [
  { codigo: 'profanity', rotulo: 'Linguagem inadequada (palavrão)' },
  { codigo: 'insult', rotulo: 'Ofensa direcionada (insulto)' },
  { codigo: 'threat', rotulo: 'Ameaça' },
  { codigo: 'hate', rotulo: 'Discurso de ódio ou discriminação' },
  { codigo: 'sem_categoria', rotulo: 'Sem categoria registrada' },
];
const CODIGOS_CATEGORIA = CATEGORIAS_MODERACAO.map(({ codigo }) => codigo);
const ROTULO_CATEGORIA = Object.fromEntries(CATEGORIAS_MODERACAO.map(({ codigo, rotulo }) => [codigo, rotulo]));
const CATEGORIAS_GRAVES = new Set(['threat', 'hate']);

const categoriaDeModeracao = (signals) => {
  const lista = Array.isArray(signals) ? signals : [];
  const achada = CATEGORIAS_MODERACAO.find(({ codigo }) => lista.includes(`moderation_${codigo}`));
  return achada ? achada.codigo : 'sem_categoria';
};

// Gravidade como o sistema registrou. Os termos substituem os niveis tecnicos; nenhum percentual de risco sai
// nesta versao (o conflictRisk continua gravado e na resposta antiga, mas nao e probabilidade de nada).
const GRAVIDADES = {
  low: 'Atenção',
  medium: 'Moderado',
  high: 'Alto',
};
const gravidade = (nivel) => (GRAVIDADES[nivel] ? { codigo: nivel, rotulo: GRAVIDADES[nivel] } : { codigo: null, rotulo: 'Não registrada' });

// Assuntos: so os topicos das mensagens aprovadas do chat. "chat" e tambem o valor padrao quando nenhum assunto
// e reconhecido, entao nao e tratado como assunto identificado.
const ROTULOS_ASSUNTOS = {
  tarefas: 'Tarefas',
  equipes: 'Equipes',
  usuarios: 'Usuários e perfis',
};

// help_request e team_help_needed vem de palavras-chave (nlpMiningService): sao sinais, nao pedidos confirmados.
const MOTIVOS_ALERTA = {
  offensive_language: 'Linguagem ofensiva detectada',
  offensive_language_excess: 'Bloqueios recorrentes da mesma pessoa nas últimas 24 horas',
  blocked_message: 'Mensagem bloqueada pela moderação',
  moderation_profanity: 'Bloqueio por palavrão',
  moderation_insult: 'Bloqueio por insulto',
  moderation_threat: 'Bloqueio por ameaça',
  moderation_hate: 'Bloqueio por discurso de ódio ou discriminação',
  possible_conflict: 'Possível conflito na conversa',
  conflict_language: 'Linguagem de conflito na conversa',
  help_request: 'Sinal de necessidade de ajuda',
  team_help_needed: 'Sinais recorrentes de necessidade de ajuda na equipe',
};
const motivosRegistrados = (signals) => [...new Set((Array.isArray(signals) ? signals : []).filter(Boolean))]
  .map((sinal) => MOTIVOS_ALERTA[sinal])
  .filter(Boolean);

// ---------------------------------------------------------------------------------------------------------------
// Periodo: dias civis em America/Sao_Paulo, incluindo o dia atual. "7" = de 00:00 de seis dias atras ate agora.
// ---------------------------------------------------------------------------------------------------------------
const formatadorDia = new Intl.DateTimeFormat('en-CA', {
  timeZone: FUSO_HORARIO, year: 'numeric', month: '2-digit', day: '2-digit',
});
const formatadorPartes = new Intl.DateTimeFormat('en-US', {
  timeZone: FUSO_HORARIO,
  hourCycle: 'h23',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

const diaCivil = (instante) => formatadorDia.format(instante);

// Diferenca entre o relogio de Sao Paulo e o UTC naquele instante (hoje -3 h, sem horario de verao; calculada
// pelo Intl para continuar certa se a regra mudar).
const deslocamentoMs = (instante) => {
  const partes = Object.fromEntries(formatadorPartes.formatToParts(instante).map(({ type, value }) => [type, value]));
  const comoUtc = Date.UTC(+partes.year, +partes.month - 1, +partes.day, +partes.hour, +partes.minute, +partes.second);
  return comoUtc - Math.floor(instante.getTime() / 1000) * 1000;
};

const somarDias = (dia, quantidade) => {
  const [ano, mes, d] = dia.split('-').map(Number);
  return new Date(Date.UTC(ano, mes - 1, d + quantidade)).toISOString().slice(0, 10);
};

const inicioDoDia = (dia) => {
  const [ano, mes, d] = dia.split('-').map(Number);
  const meiaNoiteUtc = Date.UTC(ano, mes - 1, d);
  let candidato = meiaNoiteUtc - deslocamentoMs(new Date(meiaNoiteUtc));
  const corrigido = meiaNoiteUtc - deslocamentoMs(new Date(candidato));
  if (corrigido !== candidato) candidato = corrigido;
  return new Date(candidato);
};

const calcularPeriodo = (dias, agora = new Date()) => {
  const ultimoDia = diaCivil(agora);
  const primeiroDia = somarDias(ultimoDia, -(dias - 1));
  return {
    dias,
    fusoHorario: FUSO_HORARIO,
    primeiroDia,
    ultimoDia,
    inicio: inicioDoDia(primeiroDia),
    fim: agora,
    diasCalendario: Array.from({ length: dias }, (_, indice) => somarDias(primeiroDia, indice)),
  };
};

const noPeriodo = (instante, periodo) => {
  const data = instante instanceof Date ? instante : new Date(instante);
  return !Number.isNaN(data.getTime()) && data >= periodo.inicio && data <= periodo.fim;
};

// ---------------------------------------------------------------------------------------------------------------
// Parametros
// ---------------------------------------------------------------------------------------------------------------
class ParametroInvalido extends Error {
  constructor(codigo, mensagem) {
    super(mensagem);
    this.codigo = codigo;
  }
}

const textoDoParametro = (valor) => {
  if (valor === undefined) return '';
  if (typeof valor !== 'string') return null; // ?a=1&a=2 vira lista: invalido
  return valor.trim();
};

const lerParametros = (query = {}) => {
  const periodoTexto = textoDoParametro(query.periodo);
  if (periodoTexto === null || (periodoTexto && !PERIODOS_VALIDOS.map(String).includes(periodoTexto))) {
    throw new ParametroInvalido('periodo_invalido', 'Período inválido. Use 7, 14 ou 30 dias.');
  }
  const equipe = textoDoParametro(query.equipe);
  if (equipe === null || (equipe && !OBJECT_ID_RE.test(equipe))) {
    throw new ParametroInvalido('equipe_invalida', 'Identificador de equipe inválido.');
  }
  const ocorrencia = textoDoParametro(query.ocorrencia);
  if (ocorrencia === null || (ocorrencia && !OBJECT_ID_RE.test(ocorrencia))) {
    throw new ParametroInvalido('ocorrencia_invalida', 'Identificador de ocorrência inválido.');
  }
  return {
    periodo: periodoTexto ? Number(periodoTexto) : PERIODO_PADRAO,
    equipe: equipe ? equipe.toLowerCase() : null,
    ocorrencia: ocorrencia ? ocorrencia.toLowerCase() : null,
  };
};

// ---------------------------------------------------------------------------------------------------------------
// Consultas
// ---------------------------------------------------------------------------------------------------------------
// teamId decide o escopo quando existe; o canal so vale para registro sem teamId (mesma regra do contrato antigo).
const filtroRegistros = (equipeIds, periodo) => ({
  createdAt: { $gte: periodo.inicio, $lte: periodo.fim },
  $or: [
    { teamId: { $in: equipeIds.map((id) => new mongoose.Types.ObjectId(id)) } },
    { teamId: null, channelId: { $in: equipeIds } },
  ],
});

// Expressoes de classificacao, avaliadas no banco (mesma semantica de origemDoRegistro e categoriaDeModeracao).
const SINAIS = { $cond: [{ $isArray: '$signals' }, '$signals', []] };
const EH_CHAT = { $eq: ['$source', 'team_chat'] };
const EH_BLOQUEIO = { $eq: ['$source', 'team_chat_blocked'] };
const EXPRESSAO_ORIGEM = {
  $switch: {
    branches: [
      { case: EH_CHAT, then: 'chat' },
      { case: EH_BLOQUEIO, then: 'moderacao' },
      { case: { $in: ['$source', ORIGENS_ASSISTENTE] }, then: 'assistente' },
    ],
    default: 'desconhecida',
  },
};
const EXPRESSAO_CATEGORIA = {
  $cond: [
    EH_BLOQUEIO,
    {
      $switch: {
        branches: CODIGOS_CATEGORIA.filter((codigo) => codigo !== 'sem_categoria')
          .map((codigo) => ({ case: { $in: [`moderation_${codigo}`, SINAIS] }, then: codigo })),
        default: 'sem_categoria',
      },
    },
    null,
  ],
};
const contarVerdadeiros = (campo) => ({ $sum: { $cond: [`$${campo}`, 1, 0] } });

// Cada registro vira uma linha so com o que os indicadores usam (sem `content`), e o $facet devolve tres
// resultados pequenos: por equipe, por dia (equipes ja filtradas pelo $match) e assuntos por equipe.
const pipelineRegistros = (filtro) => [
  { $match: filtro },
  {
    $project: {
      _id: 0,
      equipe: { $toString: { $ifNull: ['$teamId', '$channelId'] } },
      dia: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt', timezone: FUSO_HORARIO } },
      origem: EXPRESSAO_ORIGEM,
      categoria: EXPRESSAO_CATEGORIA,
      ajuda: { $and: [EH_CHAT, { $in: ['help_request', SINAIS] }] },
      spam: { $and: [EH_CHAT, { $eq: ['$spamAlert', true] }] },
      sinal: { $and: [EH_CHAT, { $in: ['$alertLevel', ['medium', 'high']] }] },
      topicos: { $cond: [{ $and: [EH_CHAT, { $isArray: '$topics' }] }, '$topics', []] },
    },
  },
  {
    $facet: {
      porEquipe: [
        {
          $group: {
            _id: { equipe: '$equipe', origem: '$origem', categoria: '$categoria' },
            total: { $sum: 1 },
            ajuda: contarVerdadeiros('ajuda'),
            spam: contarVerdadeiros('spam'),
            sinal: contarVerdadeiros('sinal'),
          },
        },
        { $limit: LIMITE_GRUPOS_REGISTROS + 1 },
      ],
      porDia: [
        { $group: { _id: { dia: '$dia', origem: '$origem' }, total: { $sum: 1 }, ajuda: contarVerdadeiros('ajuda') } },
        { $limit: LIMITE_GRUPOS_REGISTROS + 1 },
      ],
      assuntos: [
        { $unwind: '$topicos' },
        { $group: { _id: { equipe: '$equipe', topico: '$topicos' }, total: { $sum: 1 } } },
        { $limit: LIMITE_GRUPOS_REGISTROS + 1 },
      ],
    },
  },
];

const CAMPOS_MODERACAO_RECENTE = '_id teamId channelId signals alertLevel createdAt';

const filtroAlertas = (equipeIds, periodo) => ({
  tipo: 'system',
  'metadata.kind': 'team_insight_alert',
  'metadata.equipeId': { $in: equipeIds },
  ...(periodo ? { createdAt: { $gte: periodo.inicio, $lte: periodo.fim } } : {}),
});

// Identificador valido (24 hex) ou null. $and para no primeiro falso: $toString so roda em texto ou ObjectId.
const idValido = (campo) => ({
  $cond: [
    {
      $and: [
        { $in: [{ $type: campo }, ['string', 'objectId']] },
        { $regexMatch: { input: { $toString: campo }, regex: OBJECT_ID_REGEX_TEXTO } },
      ],
    },
    { $toLower: { $toString: campo } },
    null,
  ],
});

// Identidade do alerta (o registro de origem). Precedencia: metadata.insightId e origemId sao gravados juntos com o
// mesmo id (assistantInsightService). Se so um for valido, ele e a identidade. Se os dois forem validos e
// diferentes, o vinculo e duvidoso: a identidade e o par (so funde com notificacoes do mesmo par). Sem nenhum id
// valido, cada notificacao conta sozinha (sem deduplicacao possivel de comprovar).
const IDENTIDADE_DO_ALERTA = {
  $switch: {
    branches: [
      { case: { $and: ['$idInsight', '$idOrigem', { $ne: ['$idInsight', '$idOrigem'] }] }, then: { $concat: ['divergente:', '$idInsight', ':', '$idOrigem'] } },
      { case: { $ne: ['$idInsight', null] }, then: '$idInsight' },
      { case: { $ne: ['$idOrigem', null] }, then: '$idOrigem' },
    ],
    default: { $concat: ['notificacao:', { $toString: '$_id' }] },
  },
};
const VINCULO_DO_ALERTA = {
  $switch: {
    branches: [
      { case: { $and: ['$idInsight', '$idOrigem', { $ne: ['$idInsight', '$idOrigem'] }] }, then: 'divergente' },
      { case: { $or: [{ $ne: ['$idInsight', null] }, { $ne: ['$idOrigem', null] }] }, then: 'confiavel' },
    ],
    default: 'ausente',
  },
};

// Um alerta = as notificacoes de mesma identidade, equipe, escopo e motivo (uma por destinatario).
const estagiosAlertas = (filtro) => [
  { $match: filtro },
  {
    $project: {
      createdAt: 1,
      equipeId: '$metadata.equipeId',
      scope: '$metadata.scope',
      alertReason: '$metadata.alertReason',
      alertLevel: '$metadata.alertLevel',
      signals: '$metadata.signals',
      occurrences: '$metadata.occurrences',
      userId: '$metadata.userId',
      userName: '$metadata.userName',
      idInsight: idValido('$metadata.insightId'),
      idOrigem: idValido('$origemId'),
    },
  },
  { $addFields: { identidade: IDENTIDADE_DO_ALERTA, vinculo: VINCULO_DO_ALERTA } },
  { $sort: { createdAt: 1 } },
  {
    $group: {
      _id: { identidade: '$identidade', equipeId: '$equipeId', scope: '$scope', alertReason: '$alertReason' },
      vinculo: { $first: '$vinculo' },
      createdAt: { $first: '$createdAt' },
      alertLevel: { $first: '$alertLevel' },
      signals: { $first: '$signals' },
      occurrences: { $first: '$occurrences' },
      userId: { $first: '$userId' },
      userName: { $first: '$userName' },
    },
  },
];

// Contagens completas (equipe x escopo x vinculo, calculadas no banco) e a lista dos mais recentes.
const pipelineAlertas = (filtro) => [
  ...estagiosAlertas(filtro),
  {
    $facet: {
      contagens: [
        { $group: { _id: { equipeId: '$_id.equipeId', scope: '$_id.scope', vinculo: '$vinculo' }, total: { $sum: 1 } } },
        { $limit: LIMITE_GRUPOS_ALERTAS + 1 },
      ],
      lista: [{ $sort: { createdAt: -1 } }, { $limit: LIMITE_ALERTAS_LISTA }],
    },
  },
];

// Ocorrencia pedida (notificacao): pelo insightId ou, como em notificationTarget, pelo origemId. So vale a
// ocorrencia cuja identidade e exatamente o id pedido (vinculo divergente nao e resolvido).
const pipelineOcorrencia = (filtro, id) => [
  ...estagiosAlertas({ ...filtro, $or: [{ 'metadata.insightId': id }, { origemId: new mongoose.Types.ObjectId(id) }] }),
  { $match: { '_id.identidade': id } },
  { $sort: { createdAt: -1 } },
  { $limit: 1 },
];

// ---------------------------------------------------------------------------------------------------------------
// Classificacao (pura)
// ---------------------------------------------------------------------------------------------------------------
const contagemVazia = () => ({
  registros: 0,
  chat: 0,
  bloqueadas: 0,
  ajuda: 0,
  assistente: 0,
  origemDesconhecida: 0,
  indiciosSpam: 0,
  sinaisColetivos: 0,
});
const contagemIndisponivel = () => Object.fromEntries(Object.keys(contagemVazia()).map((campo) => [campo, null]));

const moderacaoVazia = () => Object.fromEntries(CODIGOS_CATEGORIA.map((codigo) => [codigo, 0]));
const moderacaoIndisponivel = () => Object.fromEntries(CODIGOS_CATEGORIA.map((codigo) => [codigo, null]));
const alertasVazios = () => ({ individuais: 0, coletivos: 0, historicos: 0, semVinculo: 0, total: 0 });
const alertasIndisponiveis = () => ({ individuais: null, coletivos: null, historicos: null, semVinculo: null, total: null });

const idNormalizado = (id) => {
  if (id === undefined || id === null || id === '') return null;
  const texto = String(id).toLowerCase();
  return OBJECT_ID_RE.test(texto) ? texto : null;
};

const CAMPO_DA_ORIGEM = { chat: 'chat', moderacao: 'bloqueadas', assistente: 'assistente', desconhecida: 'origemDesconhecida' };

// resultado: o documento do $facet de pipelineRegistros. permitidas: ids (texto) das equipes consultadas.
const resumirRegistros = (resultado, permitidas, diasCalendario) => {
  const porEquipeBruto = Array.isArray(resultado?.porEquipe) ? resultado.porEquipe : [];
  const porDiaBruto = Array.isArray(resultado?.porDia) ? resultado.porDia : [];
  const assuntosBrutos = Array.isArray(resultado?.assuntos) ? resultado.assuntos : [];
  const contagensParciais = porEquipeBruto.length > LIMITE_GRUPOS_REGISTROS || porDiaBruto.length > LIMITE_GRUPOS_REGISTROS;
  const assuntosParciais = assuntosBrutos.length > LIMITE_GRUPOS_REGISTROS;

  const porEquipe = new Map();
  const moderacao = new Map();
  const iniciar = (equipeId) => {
    if (!porEquipe.has(equipeId)) {
      porEquipe.set(equipeId, contagemVazia());
      moderacao.set(equipeId, moderacaoVazia());
    }
  };
  porEquipeBruto.forEach(({ _id: chave = {}, total, ajuda, spam, sinal }) => {
    const equipeId = idNormalizado(chave.equipe);
    const campo = CAMPO_DA_ORIGEM[chave.origem];
    if (!equipeId || !permitidas.has(equipeId) || !campo) return;
    iniciar(equipeId);
    const contagem = porEquipe.get(equipeId);
    const quantidade = Number(total) || 0;
    contagem.registros += quantidade;
    contagem[campo] += quantidade;
    if (chave.origem === 'chat') {
      contagem.ajuda += Number(ajuda) || 0;
      contagem.indiciosSpam += Number(spam) || 0;
      contagem.sinaisColetivos += Number(sinal) || 0;
    }
    if (chave.origem === 'moderacao') {
      const categoria = CODIGOS_CATEGORIA.includes(chave.categoria) ? chave.categoria : 'sem_categoria';
      moderacao.get(equipeId)[categoria] += quantidade;
    }
  });

  const indiceDia = new Map(diasCalendario.map((dia, indice) => [dia, indice]));
  const serie = () => diasCalendario.map(() => 0);
  const evolucao = { chat: serie(), bloqueadas: serie(), ajuda: serie(), assistente: serie() };
  porDiaBruto.forEach(({ _id: chave = {}, total, ajuda }) => {
    const indice = indiceDia.get(chave.dia);
    if (indice === undefined) return;
    if (chave.origem === 'chat') {
      evolucao.chat[indice] += Number(total) || 0;
      evolucao.ajuda[indice] += Number(ajuda) || 0;
    } else if (chave.origem === 'moderacao') {
      evolucao.bloqueadas[indice] += Number(total) || 0;
    } else if (chave.origem === 'assistente') {
      evolucao.assistente[indice] += Number(total) || 0;
    }
  });

  const assuntos = new Map();
  assuntosBrutos.forEach(({ _id: chave = {}, total }) => {
    const equipeId = idNormalizado(chave.equipe);
    if (!equipeId || !permitidas.has(equipeId) || typeof chave.topico !== 'string' || !chave.topico || chave.topico === 'chat') return;
    if (!assuntos.has(equipeId)) assuntos.set(equipeId, new Map());
    const mapa = assuntos.get(equipeId);
    mapa.set(chave.topico, (mapa.get(chave.topico) || 0) + (Number(total) || 0));
  });

  return { porEquipe, moderacao, evolucao, assuntos, contagensParciais, assuntosParciais };
};

const escopoDoAlerta = (scope) => {
  if (scope === 'user') return 'individual';
  if (scope === 'team') return 'coletivo';
  return 'historico';
};

const CATEGORIAS_ALERTA = {
  threat: 'Ameaça',
  hate: 'Discurso de ódio ou discriminação',
  recurrence: 'Bloqueios recorrentes da mesma pessoa',
  conflito: 'Possível conflito na conversa',
  apoio: 'Sinais de necessidade de ajuda na equipe',
  coletivo: 'Sinal coletivo da conversa',
  moderacao_sem_motivo: 'Moderação (motivo não registrado)',
  historico: 'Registro histórico sem classificação confiável',
};

const categoriaDoAlerta = (escopo, alertReason, signals) => {
  const lista = Array.isArray(signals) ? signals : [];
  let codigo;
  if (escopo === 'individual') {
    codigo = CATEGORIAS_ALERTA[alertReason] ? alertReason : 'moderacao_sem_motivo';
  } else if (escopo === 'coletivo') {
    if (lista.includes('possible_conflict') || lista.includes('conflict_language')) codigo = 'conflito';
    else if (lista.includes('team_help_needed') || lista.includes('help_request')) codigo = 'apoio';
    else codigo = 'coletivo';
  } else {
    codigo = 'historico';
  }
  return { codigo, rotulo: CATEGORIAS_ALERTA[codigo] };
};

const vinculoDoGrupo = (grupo) => (['confiavel', 'divergente'].includes(grupo?.vinculo) ? grupo.vinculo : 'ausente');
const individualConfiavel = (grupo) => grupo?._id?.scope === 'user' && vinculoDoGrupo(grupo) === 'confiavel';

// grupo: saida de estagiosAlertas. nomes: Map userId -> nome atual. equipesPorId: Map id -> { id, nome }.
const montarAlerta = (grupo, { nomes, equipesPorId }) => {
  const chave = grupo._id || {};
  const equipeId = idNormalizado(chave.equipeId);
  const escopo = escopoDoAlerta(chave.scope);
  const vinculo = vinculoDoGrupo(grupo);
  const ocorrencias = Number.isInteger(grupo.occurrences) && grupo.occurrences > 0 ? grupo.occurrences : null;
  const userId = idNormalizado(grupo.userId);
  // Pessoa so no alerta individual com vinculo confiavel (o motivo e a conduta dela). Nos coletivos e nos antigos
  // sem escopo, o usuario gravado era quem mandou a ultima mensagem: nem o id nem o nome registrado sao usados.
  // Nao exige que a pessoa ainda seja membro da equipe (alerta historico legitimo). So o nome, nunca o e-mail.
  const colaborador = individualConfiavel(grupo) && userId
    ? { id: userId, nome: nomes.get(userId) || (typeof grupo.userName === 'string' && grupo.userName.trim()) || 'Colaborador não identificado' }
    : null;
  return {
    id: vinculo === 'confiavel' ? idNormalizado(chave.identidade) : null,
    vinculo,
    data: grupo.createdAt instanceof Date ? grupo.createdAt.toISOString() : grupo.createdAt || null,
    equipe: equipesPorId.get(equipeId) || null,
    escopo,
    gravidade: gravidade(grupo.alertLevel),
    categoria: categoriaDoAlerta(escopo, chave.alertReason, grupo.signals),
    ocorrencias,
    motivos: motivosRegistrados(grupo.signals),
    colaborador,
  };
};

// contagens: saida do facet `contagens` de pipelineAlertas (equipe x escopo x vinculo).
const contarAlertasPorEquipe = (contagens, permitidas) => {
  const porEquipe = new Map();
  contagens.forEach(({ _id: chave = {}, total }) => {
    const equipeId = idNormalizado(chave.equipeId);
    if (!equipeId || !permitidas.has(equipeId)) return;
    if (!porEquipe.has(equipeId)) porEquipe.set(equipeId, alertasVazios());
    const contagem = porEquipe.get(equipeId);
    const quantidade = Number(total) || 0;
    const escopo = escopoDoAlerta(chave.scope);
    if (escopo === 'individual') contagem.individuais += quantidade;
    else if (escopo === 'coletivo') contagem.coletivos += quantidade;
    else contagem.historicos += quantidade;
    if (chave.vinculo !== 'confiavel') contagem.semVinculo += quantidade;
    contagem.total += quantidade;
  });
  return porEquipe;
};

// ---------------------------------------------------------------------------------------------------------------
// Recomendacoes: cada uma cita o que foi registrado, quantas vezes, onde e em que periodo. Nenhuma tira
// conclusao sobre pessoas, produtividade ou sentimento; ausencia de registro nao e tratada como garantia.
// So sao geradas com contagens completas (o chamador passa null quando algum resultado ficou parcial).
// ---------------------------------------------------------------------------------------------------------------
// 'Foi registrado 1 alerta' / 'Foram registrados 2 alertas'.
const registrados = (n, singular, pluralTexto) => (n === 1 ? `Foi registrado 1 ${singular}` : `Foram registrados ${n} ${pluralTexto}`);

const PRIORIDADE_RECOMENDACAO = {
  moderacao_grave: 1,
  alertas_individuais: 2,
  alertas_coletivos: 3,
  moderacao_recorrente: 4,
  ajuda: 5,
};

const descreverCategorias = (moderacao) => CATEGORIAS_MODERACAO
  .filter(({ codigo }) => moderacao[codigo] > 0)
  .map(({ codigo, rotulo }) => `${rotulo.toLowerCase()}: ${moderacao[codigo]}`)
  .join('; ');

const gerarRecomendacoes = (equipes, periodoResumo) => {
  const recomendacoes = [];
  const adicionar = (tipo, equipe, dados) => recomendacoes.push({
    chave: `${tipo}:${equipe.id}`,
    tipo,
    origem: 'regra_automatica',
    equipe: { id: equipe.id, nome: equipe.nome },
    periodo: periodoResumo,
    ...dados,
  });

  equipes.forEach(({ equipe, contagem, moderacao, alertas }) => {
    const graves = (moderacao.threat || 0) + (moderacao.hate || 0);
    if (graves > 0) {
      adicionar('moderacao_grave', equipe, {
        quantidade: graves,
        situacao: 'Bloqueios por ameaça ou discurso de ódio',
        evidencia: `${registrados(graves, 'bloqueio', 'bloqueios')} por ameaça ou discurso de ódio nesta equipe.`,
        acao: 'Revise os alertas individuais da equipe e avalie a necessidade de acompanhamento.',
        destino: { aba: 'alertas', equipe: equipe.id },
      });
    }
    if (alertas.individuais > 0) {
      adicionar('alertas_individuais', equipe, {
        quantidade: alertas.individuais,
        situacao: 'Alertas individuais de moderação',
        evidencia: `${registrados(alertas.individuais, 'alerta individual', 'alertas individuais')} no período.`,
        acao: 'Revise as ocorrências e os motivos registrados antes de qualquer conversa com as pessoas envolvidas.',
        destino: { aba: 'alertas', equipe: equipe.id },
      });
    }
    if (alertas.coletivos > 0) {
      adicionar('alertas_coletivos', equipe, {
        quantidade: alertas.coletivos,
        situacao: 'Alertas coletivos da conversa',
        evidencia: `${registrados(alertas.coletivos, 'alerta coletivo', 'alertas coletivos')} no período.`,
        acao: 'Revise as ocorrências e os motivos apresentados.',
        destino: { aba: 'alertas', equipe: equipe.id },
      });
    }
    // Contagem da equipe inteira: varias pessoas podem ter sido bloqueadas. Nao e reincidencia individual.
    if (contagem.bloqueadas >= 2) {
      adicionar('moderacao_recorrente', equipe, {
        quantidade: contagem.bloqueadas,
        situacao: 'Vários bloqueios da moderação na equipe',
        evidencia: `Foram registradas ${contagem.bloqueadas} ocorrências de moderação nesta equipe, somando todas as pessoas (${descreverCategorias(moderacao)}).`,
        acao: 'Consulte as categorias e avalie a necessidade de acompanhamento.',
        destino: { aba: 'moderacao', equipe: equipe.id },
      });
    }
    if (contagem.ajuda > 0) {
      adicionar('ajuda', equipe, {
        quantidade: contagem.ajuda,
        situacao: 'Sinais de necessidade de ajuda no chat',
        evidencia: contagem.ajuda === 1
          ? 'Foi identificada 1 mensagem com sinais associados à necessidade de ajuda nesta equipe.'
          : `Foram identificadas ${contagem.ajuda} mensagens com sinais associados à necessidade de ajuda nesta equipe.`,
        acao: 'São sinais automatizados por análise textual, não confirmações de dificuldades: verifique se existem dúvidas ou impedimentos relatados.',
        destino: { aba: 'equipes', equipe: equipe.id },
      });
    }
  });

  recomendacoes.sort((a, b) => (PRIORIDADE_RECOMENDACAO[a.tipo] - PRIORIDADE_RECOMENDACAO[b.tipo])
    || (b.quantidade - a.quantidade)
    || a.equipe.nome.localeCompare(b.equipe.nome, 'pt-BR'));

  if (recomendacoes.length === 0) {
    recomendacoes.push({
      chave: 'sem_sinais',
      tipo: 'sem_sinais',
      origem: 'regra_automatica',
      equipe: null,
      periodo: periodoResumo,
      quantidade: 0,
      situacao: 'Nenhum sinal de acompanhamento',
      evidencia: 'Nenhum sinal de acompanhamento foi registrado no período selecionado.',
      acao: 'A ausência de registros não garante que não existam dificuldades: continue acompanhando as equipes.',
      destino: null,
    });
  }
  return recomendacoes;
};

// ---------------------------------------------------------------------------------------------------------------
// Orquestracao
// ---------------------------------------------------------------------------------------------------------------
const somar = (lista, vazio) => lista.reduce((total, item) => {
  Object.keys(total).forEach((campo) => { total[campo] += item[campo]; });
  return total;
}, vazio);

// Mesma regra de escopo da resposta antiga: equipes de que o administrador participa ou que criou.
const equipesDoAdministrador = async (adminId) => {
  const equipes = await Equipe.find({ $or: [{ membros: adminId }, { createdBy: adminId }] })
    .select('_id nome membros')
    .lean();
  return equipes
    .map((equipe) => ({
      id: String(equipe._id).toLowerCase(),
      nome: typeof equipe.nome === 'string' && equipe.nome.trim() ? equipe.nome.trim() : 'Equipe sem nome',
      participa: (equipe.membros || []).some((membro) => String(membro?._id ?? membro) === String(adminId)),
    }))
    .sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR', { sensitivity: 'base' }) || a.id.localeCompare(b.id));
};

const nomesDosColaboradores = async (grupos) => {
  const ids = [...new Set(grupos.filter(individualConfiavel).map((grupo) => idNormalizado(grupo.userId)).filter(Boolean))];
  if (ids.length === 0) return new Map();
  const usuarios = await User.find({ _id: { $in: ids } }).select('nome').lean();
  return new Map(usuarios
    .filter((usuario) => typeof usuario.nome === 'string' && usuario.nome.trim())
    .map((usuario) => [String(usuario._id).toLowerCase(), usuario.nome.trim()]));
};

const obterInsightsAdmin = async ({ adminId, query, agora = new Date() }) => {
  const parametros = lerParametros(query);
  const periodo = calcularPeriodo(parametros.periodo, agora);
  const periodoResumo = {
    dias: periodo.dias,
    fusoHorario: periodo.fusoHorario,
    primeiroDia: periodo.primeiroDia,
    ultimoDia: periodo.ultimoDia,
    inicio: periodo.inicio.toISOString(),
    fim: periodo.fim.toISOString(),
  };

  const equipes = await equipesDoAdministrador(adminId);
  const equipesPorId = new Map(equipes.map((equipe) => [equipe.id, { id: equipe.id, nome: equipe.nome }]));
  // O id pedido so vale se estiver no escopo calculado aqui; fora dele, a resposta cobre todas as equipes.
  const equipeValida = parametros.equipe && equipesPorId.has(parametros.equipe) ? parametros.equipe : null;
  const equipeIndisponivel = Boolean(parametros.equipe) && !equipeValida;
  const alvo = equipeValida ? [equipeValida] : equipes.map((equipe) => equipe.id);
  const permitidas = new Set(alvo);
  // Ocorrencia ligada a uma equipe indisponivel nao e procurada nas demais equipes.
  const procurarOcorrencia = Boolean(parametros.ocorrencia) && !equipeIndisponivel;

  let registros = null;
  let recentesModeracao = [];
  let alertasBrutos = null;
  let gruposOcorrencia = [];
  if (alvo.length > 0) {
    const filtro = filtroRegistros(alvo, periodo);
    let resultadoRegistros;
    let resultadoAlertas;
    [resultadoRegistros, recentesModeracao, resultadoAlertas, gruposOcorrencia] = await Promise.all([
      AssistantInsight.aggregate(pipelineRegistros(filtro)),
      AssistantInsight.find({ ...filtro, source: 'team_chat_blocked' })
        .sort({ createdAt: -1 })
        .limit(LIMITE_MODERACAO_RECENTES)
        .select(CAMPOS_MODERACAO_RECENTE)
        .lean(),
      Notification.aggregate(pipelineAlertas(filtroAlertas(alvo, periodo))),
      procurarOcorrencia
        ? Notification.aggregate(pipelineOcorrencia(filtroAlertas(alvo, null), parametros.ocorrencia))
        : Promise.resolve([]),
    ]);
    [registros] = resultadoRegistros;
    [alertasBrutos] = resultadoAlertas;
  }

  const resumo = resumirRegistros(registros, permitidas, periodo.diasCalendario);
  const contagensAlertas = Array.isArray(alertasBrutos?.contagens) ? alertasBrutos.contagens : [];
  const listaAlertas = Array.isArray(alertasBrutos?.lista) ? alertasBrutos.lista : [];
  const alertasParciais = contagensAlertas.length > LIMITE_GRUPOS_ALERTAS;
  const { contagensParciais, assuntosParciais } = resumo;
  const alertasPorEquipe = contarAlertasPorEquipe(contagensAlertas, permitidas);
  const nomes = await nomesDosColaboradores([...listaAlertas, ...gruposOcorrencia]);

  const porEquipe = equipes
    .filter((equipe) => permitidas.has(equipe.id))
    .map((equipe) => ({
      equipe,
      contagem: resumo.porEquipe.get(equipe.id) || contagemVazia(),
      moderacao: resumo.moderacao.get(equipe.id) || moderacaoVazia(),
      alertas: alertasPorEquipe.get(equipe.id) || alertasVazios(),
      assuntos: [...(resumo.assuntos.get(equipe.id) || new Map())]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .slice(0, LIMITE_ASSUNTOS_POR_EQUIPE)
        .map(([codigo, total]) => ({ codigo, rotulo: ROTULOS_ASSUNTOS[codigo] || codigo, total })),
    }));

  const totais = somar(porEquipe.map((item) => item.contagem), contagemVazia());
  const totaisAlertas = somar(porEquipe.map((item) => item.alertas), alertasVazios());
  const totaisModeracao = somar(porEquipe.map((item) => item.moderacao), moderacaoVazia());

  const itensAlertas = listaAlertas
    .filter((grupo) => permitidas.has(idNormalizado(grupo?._id?.equipeId)))
    .map((grupo) => montarAlerta(grupo, { nomes, equipesPorId }));

  let ocorrenciaSolicitada = null;
  if (parametros.ocorrencia) {
    const grupo = gruposOcorrencia.find((item) => permitidas.has(idNormalizado(item?._id?.equipeId)));
    ocorrenciaSolicitada = grupo
      ? {
        id: parametros.ocorrencia,
        status: noPeriodo(grupo.createdAt, periodo) ? 'no_periodo' : 'fora_do_periodo',
        item: montarAlerta(grupo, { nomes, equipesPorId }),
      }
      : { id: parametros.ocorrencia, status: 'indisponivel', item: null };
  }

  // Resultado parcial: os indicadores que dependem dele saem como null (nunca zero) e nao ha recomendacoes.
  const contagemSaida = (contagem) => (contagensParciais ? contagemIndisponivel() : contagem);
  const recomendacoes = contagensParciais || alertasParciais ? null : gerarRecomendacoes(porEquipe, periodoResumo);

  return {
    versao: VERSAO,
    geradoEm: agora.toISOString(),
    periodo: { ...periodoResumo, diasCalendario: periodo.diasCalendario },
    filtros: { equipe: equipeValida, periodo: periodo.dias },
    equipeSolicitada: equipeIndisponivel ? { id: parametros.equipe, disponivel: false } : null,
    equipes,
    limites: {
      registrosParciais: contagensParciais,
      assuntosParciais,
      alertasParciais,
      recomendacoesIndisponiveis: recomendacoes === null,
      alertasExibidos: itensAlertas.length,
      limiteAlertas: LIMITE_ALERTAS_LISTA,
      limiteModeracaoRecentes: LIMITE_MODERACAO_RECENTES,
    },
    totais: {
      ...contagemSaida(totais),
      equipesComRegistros: contagensParciais ? null : porEquipe.filter((item) => item.contagem.registros > 0).length,
      equipesComAlertas: alertasParciais ? null : porEquipe.filter((item) => item.alertas.total > 0).length,
      alertas: alertasParciais ? alertasIndisponiveis() : totaisAlertas,
    },
    evolucao: contagensParciais ? null : { dias: periodo.diasCalendario, series: resumo.evolucao },
    porEquipe: porEquipe.map(({ equipe, contagem, moderacao, alertas, assuntos }) => ({
      equipe: { ...equipe },
      ...contagemSaida(contagem),
      moderacao: contagensParciais ? moderacaoIndisponivel() : moderacao,
      alertas: alertasParciais ? alertasIndisponiveis() : alertas,
      assuntos: assuntosParciais ? null : assuntos,
    })),
    moderacao: {
      total: contagensParciais ? null : totais.bloqueadas,
      porCategoria: contagensParciais ? null : CATEGORIAS_MODERACAO.map(({ codigo, rotulo }) => ({ codigo, rotulo, total: totaisModeracao[codigo] })),
      indiciosSpam: contagensParciais ? null : totais.indiciosSpam,
      // Lista independente das contagens (consulta propria, limite intencional).
      recentes: recentesModeracao
        .map((registro) => {
          const equipeId = idNormalizado(registro.teamId ?? registro.channelId);
          if (!permitidas.has(equipeId)) return null;
          const categoria = categoriaDeModeracao(registro.signals);
          return {
            id: String(registro._id),
            data: registro.createdAt instanceof Date ? registro.createdAt.toISOString() : registro.createdAt || null,
            equipe: equipesPorId.get(equipeId) || null,
            categoria: { codigo: categoria, rotulo: ROTULO_CATEGORIA[categoria] },
            grave: CATEGORIAS_GRAVES.has(categoria),
            gravidade: gravidade(registro.alertLevel),
          };
        })
        .filter(Boolean),
    },
    alertas: {
      total: alertasParciais ? null : totaisAlertas.total,
      itens: itensAlertas,
    },
    ocorrenciaSolicitada,
    recomendacoes,
  };
};

module.exports = {
  VERSAO,
  FUSO_HORARIO,
  PERIODOS_VALIDOS,
  PERIODO_PADRAO,
  ORIGENS_ASSISTENTE,
  LIMITE_ALERTAS_LISTA,
  LIMITE_GRUPOS_REGISTROS,
  LIMITE_GRUPOS_ALERTAS,
  LIMITE_MODERACAO_RECENTES,
  CAMPOS_MODERACAO_RECENTE,
  ParametroInvalido,
  calcularPeriodo,
  lerParametros,
  origemDoRegistro,
  categoriaDeModeracao,
  resumirRegistros,
  gerarRecomendacoes,
  pipelineRegistros,
  pipelineAlertas,
  obterInsightsAdmin,
};
