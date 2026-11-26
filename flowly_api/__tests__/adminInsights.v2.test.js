// PR #64: Insights administrativos, contrato versao 2 (GET /api/admin/assistant-insights?versao=2) e a resposta
// antiga (sem versao), que continua atendendo o frontend publicado.
// Rota, autenticacao e papel reais. Os modelos sao interceptados por uma base em memoria que avalia exatamente os
// estagios usados pelas consultas ($match com $or/$in/$gte/$lte/null, $group com $dateToString no fuso, $first e
// $sum, $sort e $limit). Nenhuma conexao com banco. A data do sistema e fixa (so Date e falsificado).
const request = require('supertest');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');

jest.mock('../utils/sessionGuard', () => require('./helpers/sessionGuardStub'));
jest.mock('@google-cloud/storage', () => ({
  Storage: jest.fn().mockImplementation(() => ({ bucket: jest.fn().mockReturnValue({ file: jest.fn() }) })),
}));

const config = require('../config/config');
const app = require('../app');
const AssistantInsight = require('../models/AssistantInsight');
const Equipe = require('../models/Equipe');
const Notification = require('../models/Notification');
const User = require('../models/User');
const servico = require('../services/insightsAdminService');

const NAO_FALSIFICAR_ALEM_DE_DATE = [
  'hrtime', 'nextTick', 'performance', 'queueMicrotask', 'requestAnimationFrame', 'cancelAnimationFrame',
  'requestIdleCallback', 'cancelIdleCallback', 'setImmediate', 'clearImmediate', 'setInterval', 'clearInterval',
  'setTimeout', 'clearTimeout',
];
// 25/11/2026, 12:00 em Sao Paulo (15:00 UTC). Periodo de 7 dias: 19/11 00:00 (03:00 UTC) ate agora.
const AGORA = new Date('2026-11-25T15:00:00.000Z');

// ----------------------------------------------------------------------------------------------------------------
// Base em memoria
// ----------------------------------------------------------------------------------------------------------------
const db = { equipes: [], users: [], insights: [], notifications: [] };

const obter = (doc, caminho) => caminho.split('.').reduce((valor, chave) => (valor == null ? undefined : valor[chave]), doc);
const igual = (a, b) => a != null && b != null && String(a) === String(b);
const ehOperador = (valor) => valor && typeof valor === 'object' && !Array.isArray(valor) && !(valor instanceof Date)
  && !(valor instanceof mongoose.Types.ObjectId) && Object.keys(valor).some((chave) => chave.startsWith('$'));

const casa = (doc, filtro) => Object.entries(filtro).every(([campo, condicao]) => {
  if (campo === '$or') return condicao.some((alternativa) => casa(doc, alternativa));
  if (campo === '$and') return condicao.every((parte) => casa(doc, parte));
  const valor = obter(doc, campo);
  if (condicao === null) return valor == null;
  if (ehOperador(condicao)) {
    return Object.entries(condicao).every(([operador, argumento]) => {
      if (operador === '$in') {
        return argumento.some((item) => (Array.isArray(valor) ? valor.some((v) => igual(v, item)) : igual(valor, item)));
      }
      if (operador === '$gte') return valor != null && valor >= argumento;
      if (operador === '$lte') return valor != null && valor <= argumento;
      if (operador === '$exists') return (valor !== undefined) === argumento;
      if (operador === '$ne') return !igual(valor, argumento);
      throw new Error(`operador nao suportado no teste: ${operador}`);
    });
  }
  if (Array.isArray(valor)) return valor.some((item) => igual(item, condicao));
  return igual(valor, condicao);
});

const diaNoFuso = (data, fuso) => new Intl.DateTimeFormat('en-CA', {
  timeZone: fuso, year: 'numeric', month: '2-digit', day: '2-digit',
}).format(data);

const ehObjectId = (valor) => valor instanceof mongoose.Types.ObjectId;
// Verdadeiro para expressoes do MongoDB: false, null, 0 e campo ausente sao falsos.
const verdadeiro = (valor) => valor !== undefined && valor !== null && valor !== false && valor !== 0;
// Igualdade de expressoes ($eq/$in): sensivel ao tipo, como no MongoDB (ObjectId nao e igual a texto).
const igualTipado = (a, b) => {
  if (a === undefined || b === undefined) return a === b;
  if (a === null || b === null) return a === b;
  if (ehObjectId(a) || ehObjectId(b)) return ehObjectId(a) && ehObjectId(b) && a.equals(b);
  if (a instanceof Date || b instanceof Date) return a instanceof Date && b instanceof Date && a.getTime() === b.getTime();
  if (typeof a === 'object' || typeof b === 'object') return JSON.stringify(a) === JSON.stringify(b);
  return a === b;
};
const tipoMongo = (valor) => {
  if (valor === undefined) return 'missing';
  if (valor === null) return 'null';
  if (ehObjectId(valor)) return 'objectId';
  if (valor instanceof Date) return 'date';
  if (Array.isArray(valor)) return 'array';
  if (typeof valor === 'string') return 'string';
  if (typeof valor === 'boolean') return 'bool';
  if (typeof valor === 'number') return Number.isInteger(valor) ? 'int' : 'double';
  return 'object';
};
// Chave de grupo com tipo: ObjectId('x') e 'x' sao grupos diferentes, como no MongoDB.
const serial = (valor) => {
  if (valor === null) return 'null';
  if (ehObjectId(valor)) return `oid(${valor.toHexString()})`;
  if (valor instanceof Date) return `date(${valor.toISOString()})`;
  if (Array.isArray(valor)) return `[${valor.map(serial).join(',')}]`;
  if (typeof valor === 'object') return `{${Object.entries(valor).map(([chave, sub]) => `${chave}:${serial(sub)}`).join(',')}}`;
  return `${typeof valor}(${String(valor)})`;
};

const OPERADORES = {
  $dateToString: ({ format, date, timezone }, doc, vars) => {
    if (format !== '%Y-%m-%d') throw new Error(`formato nao suportado no teste: ${format}`);
    const valor = avaliar(doc, date, vars);
    return valor instanceof Date ? diaNoFuso(valor, timezone) : null;
  },
  $ifNull: ([a, b], doc, vars) => {
    const valor = avaliar(doc, a, vars);
    return valor === undefined || valor === null ? avaliar(doc, b, vars) : valor;
  },
  $toString: (arg, doc, vars) => {
    const valor = avaliar(doc, arg, vars);
    if (valor === undefined || valor === null) return null;
    if (ehObjectId(valor)) return valor.toHexString();
    if (valor instanceof Date) return valor.toISOString();
    if (typeof valor === 'object') throw new Error('$toString: conversao de objeto nao suportada (como no MongoDB)');
    return String(valor);
  },
  $toLower: (arg, doc, vars) => {
    const valor = avaliar(doc, arg, vars);
    return valor === undefined || valor === null ? '' : String(valor).toLowerCase();
  },
  $concat: (partes, doc, vars) => {
    const valores = partes.map((parte) => avaliar(doc, parte, vars));
    if (valores.some((valor) => valor === undefined || valor === null)) return null;
    if (valores.some((valor) => typeof valor !== 'string')) throw new Error('$concat so aceita texto');
    return valores.join('');
  },
  $cond: (arg, doc, vars) => {
    const [se, entao, senao] = Array.isArray(arg) ? arg : [arg.if, arg.then, arg.else];
    return verdadeiro(avaliar(doc, se, vars)) ? avaliar(doc, entao, vars) : avaliar(doc, senao, vars);
  },
  $switch: ({ branches, default: padrao }, doc, vars) => {
    const ramo = branches.find((item) => verdadeiro(avaliar(doc, item.case, vars)));
    return ramo ? avaliar(doc, ramo.then, vars) : avaliar(doc, padrao, vars);
  },
  // Para no primeiro falso (o MongoDB tambem): a expressao seguinte nao chega a ser avaliada.
  $and: (lista, doc, vars) => lista.every((item) => verdadeiro(avaliar(doc, item, vars))),
  $or: (lista, doc, vars) => lista.some((item) => verdadeiro(avaliar(doc, item, vars))),
  $eq: ([a, b], doc, vars) => igualTipado(avaliar(doc, a, vars), avaliar(doc, b, vars)),
  $ne: ([a, b], doc, vars) => !igualTipado(avaliar(doc, a, vars), avaliar(doc, b, vars)),
  $in: ([a, b], doc, vars) => {
    const valor = avaliar(doc, a, vars);
    const lista = avaliar(doc, b, vars);
    if (!Array.isArray(lista)) throw new Error('$in requer uma lista como segundo argumento (como no MongoDB)');
    return lista.some((item) => igualTipado(valor, item));
  },
  $isArray: (arg, doc, vars) => Array.isArray(avaliar(doc, Array.isArray(arg) ? arg[0] : arg, vars)),
  $type: (arg, doc, vars) => tipoMongo(avaliar(doc, arg, vars)),
  $regexMatch: ({ input, regex, options }, doc, vars) => {
    const valor = avaliar(doc, input, vars);
    if (valor === null || valor === undefined) return false;
    if (typeof valor !== 'string') throw new Error('$regexMatch requer texto');
    return new RegExp(regex, options || '').test(valor);
  },
  $filter: ({ input, cond, as = 'this' }, doc, vars) => {
    const lista = avaliar(doc, input, vars);
    if (lista === null || lista === undefined) return null;
    return lista.filter((item) => verdadeiro(avaliar(doc, cond, { ...vars, [as]: item })));
  },
};

function avaliar(doc, expressao, vars = {}) {
  if (typeof expressao === 'string') {
    if (expressao.startsWith('$$')) {
      const [nome, ...resto] = expressao.slice(2).split('.');
      return resto.length ? obter(vars[nome], resto.join('.')) : vars[nome];
    }
    return expressao.startsWith('$') ? obter(doc, expressao.slice(1)) : expressao;
  }
  if (Array.isArray(expressao)) return expressao.map((item) => avaliar(doc, item, vars));
  if (expressao === null || typeof expressao !== 'object' || expressao instanceof Date || ehObjectId(expressao)) return expressao;
  const chaves = Object.keys(expressao);
  if (chaves.length === 1 && chaves[0].startsWith('$')) {
    const operador = OPERADORES[chaves[0]];
    if (!operador) throw new Error(`operador nao suportado no teste: ${chaves[0]}`);
    return operador(expressao[chaves[0]], doc, vars);
  }
  // Como no MongoDB: campo ausente nao aparece no documento resultante.
  return Object.fromEntries(chaves
    .map((chave) => [chave, avaliar(doc, expressao[chave], vars)])
    .filter(([, valor]) => valor !== undefined));
}

const comparar = (a, b) => {
  const nulo = (valor) => valor === undefined || valor === null;
  if (nulo(a) || nulo(b)) return nulo(a) && nulo(b) ? 0 : nulo(a) ? -1 : 1;
  const va = a instanceof Date ? a.getTime() : a;
  const vb = b instanceof Date ? b.getTime() : b;
  return va < vb ? -1 : va > vb ? 1 : 0;
};
const ordenar = (lista, criterio) => [...lista].sort((a, b) => {
  for (const [campo, direcao] of Object.entries(criterio)) {
    const resultado = comparar(obter(a, campo), obter(b, campo));
    if (resultado) return resultado * direcao;
  }
  return 0;
});

const ACUMULADORES = {
  $sum: (docs, arg) => docs.reduce((total, doc) => {
    const valor = typeof arg === 'number' ? arg : avaliar(doc, arg);
    return typeof valor === 'number' ? total + valor : total;
  }, 0),
  $first: (docs, arg) => (docs.length ? avaliar(docs[0], arg) : null),
  $max: (docs, arg) => docs.map((doc) => avaliar(doc, arg)).filter((valor) => valor !== undefined && valor !== null)
    .reduce((maior, valor) => (maior === null || comparar(valor, maior) > 0 ? valor : maior), null),
  $avg: (docs, arg) => {
    const numeros = docs.map((doc) => avaliar(doc, arg)).filter((valor) => typeof valor === 'number');
    return numeros.length ? numeros.reduce((total, n) => total + n, 0) / numeros.length : null;
  },
  $addToSet: (docs, arg) => {
    const vistos = new Map();
    docs.forEach((doc) => {
      const valor = avaliar(doc, arg);
      if (valor !== undefined) vistos.set(serial(valor), valor);
    });
    return [...vistos.values()];
  },
};

const projetarEstagio = (doc, especificacao, adicionar) => {
  const saida = adicionar ? { ...doc } : {};
  if (!adicionar && especificacao._id !== 0 && doc._id !== undefined) saida._id = doc._id;
  Object.entries(especificacao).forEach(([campo, valor]) => {
    if (campo === '_id' && valor === 0) return;
    const resultado = valor === 1 || valor === true ? obter(doc, campo) : avaliar(doc, valor);
    if (resultado !== undefined) saida[campo] = resultado;
  });
  return saida;
};

const agregar = (docs, pipeline) => pipeline.reduce((atual, estagio) => {
  const [nome, especificacao] = Object.entries(estagio)[0];
  if (nome === '$match') return atual.filter((doc) => casa(doc, especificacao));
  if (nome === '$sort') return ordenar(atual, especificacao);
  if (nome === '$limit') return atual.slice(0, especificacao);
  if (nome === '$project') return atual.map((doc) => projetarEstagio(doc, especificacao, false));
  if (nome === '$addFields') return atual.map((doc) => projetarEstagio(doc, especificacao, true));
  if (nome === '$facet') return [Object.fromEntries(Object.entries(especificacao).map(([campo, sub]) => [campo, agregar(atual, sub)]))];
  if (nome === '$unwind') {
    const campo = especificacao.slice(1);
    return atual.flatMap((doc) => {
      const valor = obter(doc, campo);
      if (valor === undefined || valor === null || (Array.isArray(valor) && valor.length === 0)) return [];
      return (Array.isArray(valor) ? valor : [valor]).map((item) => ({ ...doc, [campo]: item }));
    });
  }
  if (nome === '$group') {
    const grupos = new Map();
    atual.forEach((doc) => {
      const chave = avaliar(doc, especificacao._id);
      const chaveSerial = serial(chave === undefined ? null : chave);
      if (!grupos.has(chaveSerial)) grupos.set(chaveSerial, { _id: chave === undefined ? null : chave, docs: [] });
      grupos.get(chaveSerial).docs.push(doc);
    });
    return [...grupos.values()].map(({ _id, docs: membros }) => {
      const saida = { _id };
      Object.entries(especificacao).filter(([campo]) => campo !== '_id').forEach(([campo, acumulador]) => {
        const [operador, argumento] = Object.entries(acumulador)[0];
        if (!ACUMULADORES[operador]) throw new Error(`acumulador nao suportado no teste: ${operador}`);
        saida[campo] = ACUMULADORES[operador](membros, argumento);
      });
      return saida;
    });
  }
  throw new Error(`estagio nao suportado no teste: ${nome}`);
}, docs);

const projetar = (doc, campos) => {
  if (!campos) return { ...doc };
  const lista = campos.split(/\s+/).filter(Boolean);
  return Object.fromEntries(Object.entries(doc).filter(([campo]) => campo === '_id' || lista.includes(campo)));
};

// Consulta encadeavel (sort/limit/select/lean), registrada para os testes conferirem projecao e limite.
const consultas = [];
const cursor = (fonte, filtro) => {
  const estado = { filtro, sort: null, limit: null, select: null };
  consultas.push(estado);
  const resolver = () => {
    let lista = fonte().filter((doc) => casa(doc, filtro));
    if (estado.sort) lista = ordenar(lista, estado.sort);
    if (estado.limit != null) lista = lista.slice(0, estado.limit);
    return lista.map((doc) => projetar(doc, estado.select));
  };
  const consulta = {
    sort: (criterio) => { estado.sort = criterio; return consulta; },
    limit: (n) => { estado.limit = n; return consulta; },
    select: (campos) => { estado.select = campos; return consulta; },
    lean: () => Promise.resolve().then(resolver),
  };
  return consulta;
};

const pipelines = { insights: [], notifications: [] };

// ----------------------------------------------------------------------------------------------------------------
// Dados ficticios
// ----------------------------------------------------------------------------------------------------------------
const hex = (n) => n.toString(16).padStart(24, '0');
const oid = (n) => new mongoose.Types.ObjectId(hex(n));

const ADMIN = hex(1);
const ANA = hex(2);
const BRUNO = hex(3);
const OUTRO_ADMIN = hex(4);
const COLABORADOR = hex(5);
const ALFA = hex(11);
const BETA = hex(12);
const GAMA = hex(13);
const ALHEIA = hex(14);

const TEXTOS_PRIVADOS = ['seu idiota texto original ofensivo', 'conversa privada com o assistente', 'segredo da Alheia'];

const registro = (n, campos = {}) => {
  const doc = {
    _id: oid(1000 + n),
    eventId: `evento-${n}`,
    userId: ANA,
    channelId: ALFA,
    teamId: oid(11),
    teamName: 'Alfa',
    content: `texto aprovado ${n}`,
    source: 'team_chat',
    sentiment: 'neutro',
    topics: ['chat'],
    entities: [],
    signals: [],
    spamAlert: false,
    alertLevel: 'none',
    conflictRisk: 0.42,
    helpNeeded: false,
    createdAt: new Date('2026-11-24T15:00:00.000Z'),
    ...campos,
  };
  Object.keys(doc).forEach((chave) => { if (doc[chave] === undefined) delete doc[chave]; });
  return doc;
};
const idRegistro = (n) => hex(1000 + n);

const registrosPadrao = () => [
  registro(1, { topics: ['tarefas'], signals: ['help_request'] }),
  // 02:30 UTC de 25/11 = 23:30 de 24/11 em Sao Paulo
  registro(2, { topics: ['tarefas', 'equipes'], signals: ['help_request', 'conflict_language'], alertLevel: 'medium', createdAt: new Date('2026-11-25T02:30:00.000Z') }),
  registro(3, { spamAlert: true, createdAt: new Date('2026-11-19T03:00:00.000Z') }), // primeiro instante do periodo
  registro(4, { signals: ['help_request'], createdAt: new Date('2026-11-19T02:59:59.999Z') }), // 1 ms antes: fora
  registro(5, {
    source: 'team_chat_blocked', spamAlert: true, alertLevel: 'low', signals: ['blocked_message', 'moderation_profanity'],
    content: 'Mensagem bloqueada pela moderação do chat (palavrão). Motivo: unsafe_content.', createdAt: new Date('2026-11-23T12:00:00.000Z'),
  }),
  registro(6, {
    source: 'team_chat_blocked', spamAlert: true, alertLevel: 'high', signals: ['blocked_message', 'moderation_threat'],
    createdAt: new Date('2026-11-23T13:00:00.000Z'),
  }),
  // Bloqueio anterior ao PR #61: texto original no content, spamAlert true, sem categoria
  registro(7, {
    source: 'team_chat_blocked', spamAlert: true, alertLevel: 'high', signals: ['blocked_message', 'offensive_language'],
    content: TEXTOS_PRIVADOS[0], createdAt: new Date('2026-11-22T12:00:00.000Z'),
  }),
  registro(8, { source: 'frontend', spamAlert: true, content: TEXTOS_PRIVADOS[1], topics: ['tarefas'], createdAt: new Date('2026-11-22T14:00:00.000Z') }),
  registro(9, { source: 'mobile', createdAt: new Date('2026-11-21T12:00:00.000Z') }),
  registro(10, { source: undefined, createdAt: new Date('2026-11-21T13:00:00.000Z') }), // origem desconhecida
  registro(11, { teamId: undefined, channelId: ALFA, createdAt: new Date('2026-11-20T12:00:00.000Z') }), // so o canal
  registro(12, { teamId: oid(12), channelId: BETA, userId: BRUNO, createdAt: new Date('2026-11-24T18:00:00.000Z') }),
  registro(13, {
    teamId: oid(12), channelId: BETA, userId: BRUNO, source: 'team_chat_blocked', spamAlert: true, alertLevel: 'low',
    signals: ['blocked_message', 'moderation_insult'], createdAt: new Date('2026-11-24T20:00:00.000Z'),
  }),
  registro(14, {
    teamId: oid(12), channelId: BETA, userId: BRUNO, source: 'team_chat_blocked', spamAlert: true, alertLevel: 'high',
    signals: ['blocked_message', 'moderation_hate'], createdAt: new Date('2026-11-25T10:00:00.000Z'),
  }),
  registro(15, { teamId: oid(14), channelId: ALHEIA, signals: ['help_request'], content: TEXTOS_PRIVADOS[2] }),
  registro(16, { teamId: oid(14), channelId: ALHEIA, source: 'team_chat_blocked', spamAlert: true, signals: ['blocked_message', 'moderation_threat'] }),
  // teamId de outra equipe com o canal de Alfa: vale o teamId, fica fora
  registro(17, { teamId: oid(14), channelId: ALFA }),
];

const notificacao = (n, campos = {}, metadata = {}) => ({
  _id: oid(5000 + n),
  texto: `Alerta ${n} Risco 42%`,
  user: oid(1),
  tipo: 'system',
  origemId: /^[a-f\d]{24}$/i.test(String(metadata.insightId ?? '')) ? new mongoose.Types.ObjectId(metadata.insightId) : null,
  lida: false,
  createdAt: new Date('2026-11-24T12:00:00.000Z'),
  ...campos,
  metadata: { kind: 'team_insight_alert', ...metadata },
});

const notificacoesPadrao = () => [
  // Alerta individual por ameaca, enviado a dois administradores: conta uma vez
  ...[ADMIN, OUTRO_ADMIN].map((destinatario, indice) => notificacao(1 + indice, {
    user: new mongoose.Types.ObjectId(destinatario), createdAt: new Date(`2026-11-23T13:00:0${indice + 1}.000Z`),
  }, {
    scope: 'user', alertReason: 'threat', equipeId: ALFA, insightId: idRegistro(6), alertLevel: 'high',
    conflictRisk: 1, signals: ['blocked_message', 'moderation_threat'], occurrences: 1, userId: ANA, userName: 'Ana (gravado)',
  })),
  notificacao(3, { createdAt: new Date('2026-11-25T02:30:01.000Z') }, {
    scope: 'team', equipeId: ALFA, insightId: idRegistro(2), alertLevel: 'medium', conflictRisk: 0.55,
    signals: ['help_request', 'conflict_language', 'possible_conflict'],
  }),
  // Historico: sem escopo, com o usuario da ultima mensagem gravado
  notificacao(4, { createdAt: new Date('2026-11-24T20:00:01.000Z') }, {
    equipeId: BETA, insightId: idRegistro(13), alertLevel: 'high', conflictRisk: 0.9, signals: ['blocked_message'],
    userId: BRUNO, userName: 'Bruno',
  }),
  notificacao(5, { createdAt: new Date('2026-11-25T10:00:01.000Z') }, {
    scope: 'user', alertReason: 'hate', equipeId: BETA, insightId: idRegistro(14), alertLevel: 'high',
    signals: ['blocked_message', 'moderation_hate'], occurrences: 2, userId: BRUNO, userName: 'Bruno',
  }),
  // Fora do periodo de 7 dias (alvo da navegacao por notificacao antiga)
  notificacao(6, { createdAt: new Date('2026-11-10T12:00:00.000Z') }, {
    scope: 'user', alertReason: 'recurrence', equipeId: ALFA, insightId: hex(50), alertLevel: 'medium', occurrences: 2,
    userId: ANA, userName: 'Ana',
  }),
  notificacao(7, {}, { scope: 'user', alertReason: 'threat', equipeId: ALHEIA, insightId: idRegistro(16), alertLevel: 'high', userId: COLABORADOR, userName: 'Pessoa Alheia' }),
  notificacao(8, { tipo: 'task' }, { equipeId: ALFA, insightId: hex(60) }),
  { ...notificacao(9, {}, { equipeId: ALFA, insightId: hex(61) }), metadata: { kind: 'outro', equipeId: ALFA, insightId: hex(61) } },
];

const token = (id, tipo) => jwt.sign({ id, tipo, tokenType: 'access' }, config.jwt.secret, {
  issuer: config.jwt.issuer,
  audience: config.jwt.accessAudience,
});
const ADMIN_TOKEN = token(ADMIN, 'admin');

const consultar = (query = {}, autorizacao = ADMIN_TOKEN) => {
  const pedido = request(app).get('/api/admin/assistant-insights').query(query);
  return autorizacao ? pedido.set('Authorization', `Bearer ${autorizacao}`) : pedido;
};
const v2 = async (query = {}) => {
  const res = await consultar({ versao: '2', ...query });
  expect(res.status).toBe(200);
  expect(res.body).toMatchObject({ success: true, versao: 2 });
  return res.body.insights;
};
const daEquipe = (insights, id) => insights.porEquipe.find((item) => item.equipe.id === id);

beforeEach(() => {
  jest.useFakeTimers({ doNotFake: NAO_FALSIFICAR_ALEM_DE_DATE, now: AGORA });
  consultas.length = 0;
  pipelines.insights = [];
  pipelines.notifications = [];
  db.users = [
    { _id: oid(1), nome: 'Admin', email: 'admin@exemplo.com', tipo: 'admin' },
    { _id: oid(2), nome: 'Ana', email: 'ana@exemplo.com', tipo: 'user' },
    { _id: oid(3), nome: 'Bruno', email: 'bruno@exemplo.com', tipo: 'user' },
    { _id: oid(4), nome: 'Outro Admin', email: 'outro@exemplo.com', tipo: 'admin' },
    { _id: oid(5), nome: 'Pessoa Alheia', email: 'alheia@exemplo.com', tipo: 'user' },
  ];
  db.equipes = [
    { _id: oid(12), nome: 'Beta', createdBy: OUTRO_ADMIN, membros: [ADMIN, BRUNO] },
    { _id: oid(11), nome: 'Alfa', createdBy: ADMIN, membros: [ADMIN, ANA] },
    { _id: oid(13), nome: 'Gama sem registros', createdBy: ADMIN, membros: [ANA] }, // criada por ele, sem participar
    { _id: oid(14), nome: 'Alheia', createdBy: OUTRO_ADMIN, membros: [OUTRO_ADMIN, COLABORADOR] },
  ];
  db.insights = registrosPadrao();
  db.notifications = notificacoesPadrao();

  jest.spyOn(Equipe, 'find').mockImplementation((filtro) => cursor(() => db.equipes, filtro));
  jest.spyOn(User, 'find').mockImplementation((filtro) => cursor(() => db.users, filtro));
  jest.spyOn(AssistantInsight, 'find').mockImplementation((filtro) => cursor(() => db.insights, filtro));
  jest.spyOn(AssistantInsight, 'countDocuments').mockImplementation(async (filtro) => db.insights.filter((doc) => casa(doc, filtro)).length);
  jest.spyOn(AssistantInsight, 'aggregate').mockImplementation(async (pipeline) => {
    pipelines.insights.push(pipeline);
    return agregar(db.insights, pipeline);
  });
  jest.spyOn(Notification, 'aggregate').mockImplementation(async (pipeline) => {
    pipelines.notifications.push(pipeline);
    return agregar(db.notifications, pipeline);
  });
});

afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

// ----------------------------------------------------------------------------------------------------------------
describe('periodo em dias civis de America/Sao_Paulo', () => {
  test.each([
    [7, '2026-11-19', '2026-11-19T03:00:00.000Z'],
    [14, '2026-11-12', '2026-11-12T03:00:00.000Z'],
    [30, '2026-10-27', '2026-10-27T03:00:00.000Z'],
  ])('%i dias incluem o dia atual', (dias, primeiroDia, inicio) => {
    const periodo = servico.calcularPeriodo(dias, AGORA);
    expect(periodo).toMatchObject({ dias, primeiroDia, ultimoDia: '2026-11-25', fusoHorario: 'America/Sao_Paulo' });
    expect(periodo.inicio.toISOString()).toBe(inicio);
    expect(periodo.fim).toBe(AGORA);
    expect(periodo.diasCalendario).toHaveLength(dias);
    expect(periodo.diasCalendario.at(-1)).toBe('2026-11-25');
  });

  test('perto da meia-noite vale o dia de Sao Paulo, nao o de UTC', () => {
    const agora = new Date('2026-11-25T02:00:00.000Z'); // 24/11, 23:00 em Sao Paulo
    const periodo = servico.calcularPeriodo(7, agora);
    expect(periodo.ultimoDia).toBe('2026-11-24');
    expect(periodo.inicio.toISOString()).toBe('2026-11-18T03:00:00.000Z');
  });

  test('o primeiro instante entra, 1 ms antes nao; o dia do grafico e o de Sao Paulo', async () => {
    const insights = await v2();
    const { dias, series } = insights.evolucao;
    expect(dias).toEqual(['2026-11-19', '2026-11-20', '2026-11-21', '2026-11-22', '2026-11-23', '2026-11-24', '2026-11-25']);
    expect(series.chat).toEqual([1, 1, 0, 0, 0, 3, 0]); // registro 2 (02:30 UTC de 25/11) conta em 24/11
    expect(series.ajuda).toEqual([0, 0, 0, 0, 0, 2, 0]); // o registro 4 (1 ms antes do inicio) nao entra
    expect(series.bloqueadas).toEqual([0, 0, 0, 1, 2, 1, 1]);
    expect(series.assistente).toEqual([0, 0, 0, 1, 0, 0, 0]); // 'mobile' (registro 9) nao e origem conhecida do assistente
    expect(insights.periodo).toMatchObject({ dias: 7, primeiroDia: '2026-11-19', ultimoDia: '2026-11-25', inicio: '2026-11-19T03:00:00.000Z', fim: AGORA.toISOString() });
    const filtro = pipelines.insights[0][0].$match;
    expect(filtro.createdAt).toEqual({ $gte: new Date('2026-11-19T03:00:00.000Z'), $lte: AGORA });
  });

  test('14 e 30 dias ampliam a consulta e o grafico', async () => {
    db.insights.push(registro(30, { createdAt: new Date('2026-11-13T12:00:00.000Z') }));
    const sete = await v2();
    const quatorze = await v2({ periodo: '14' });
    expect(quatorze.totais.chat).toBe(sete.totais.chat + 2); // registros 4 (18/11 23:59 SP) e 30
    expect(quatorze.evolucao.dias).toHaveLength(14);
    expect((await v2({ periodo: '30' })).evolucao.dias).toHaveLength(30);
  });
});

describe('parametros invalidos e manipulacao', () => {
  test.each([
    [{ periodo: '10' }, 'periodo_invalido'],
    [{ periodo: 'abc' }, 'periodo_invalido'],
    [{ periodo: '-7' }, 'periodo_invalido'],
    [{ equipe: 'nao-e-id' }, 'equipe_invalida'],
    [{ equipe: `${ALFA}' || '1` }, 'equipe_invalida'],
    [{ ocorrencia: 'xyz' }, 'ocorrencia_invalida'],
  ])('%o -> 400 %s, sem consultar registros', async (query, codigo) => {
    const res = await consultar({ versao: '2', ...query });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ success: false, codigo });
    expect(AssistantInsight.aggregate).not.toHaveBeenCalled();
  });

  test('parametro repetido (lista) e versao desconhecida sao recusados', async () => {
    const lista = await request(app).get(`/api/admin/assistant-insights?versao=2&equipe=${ALFA}&equipe=${BETA}`)
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`);
    expect(lista.status).toBe(400);
    expect(lista.body.codigo).toBe('equipe_invalida');
    const versao = await consultar({ versao: '3' });
    expect(versao.status).toBe(400);
    expect(versao.body.codigo).toBe('versao_invalida');
  });
});

describe('autenticacao, papel e escopo por equipe', () => {
  test('sem token 401; colaborador 403, inclusive pedindo uma equipe dele', async () => {
    expect((await consultar({ versao: '2' }, null)).status).toBe(401);
    const res = await consultar({ versao: '2', equipe: ALFA }, token(ANA, 'user'));
    expect(res.status).toBe(403);
    expect(AssistantInsight.aggregate).not.toHaveBeenCalled();
  });

  test('so equipes de que o administrador participa ou que criou, em ordem alfabetica', async () => {
    const insights = await v2();
    expect(insights.equipes).toEqual([
      { id: ALFA, nome: 'Alfa', participa: true },
      { id: BETA, nome: 'Beta', participa: true },
      { id: GAMA, nome: 'Gama sem registros', participa: false },
    ]);
    expect(insights.porEquipe.map((item) => item.equipe.id)).toEqual([ALFA, BETA, GAMA]);
    const texto = JSON.stringify(insights);
    expect(texto).not.toContain('Alheia');
    expect(texto).not.toContain(ALHEIA);
    expect(texto).not.toContain('Pessoa Alheia');
  });

  test('equipe de outro administrador pela URL: nada dela, resposta cobre as autorizadas e avisa', async () => {
    const insights = await v2({ equipe: ALHEIA });
    expect(insights.filtros.equipe).toBeNull();
    expect(insights.equipeSolicitada).toEqual({ id: ALHEIA, disponivel: false });
    const todas = await v2();
    expect(insights.totais).toEqual(todas.totais);
    const filtro = pipelines.insights[0][0].$match;
    expect(filtro.$or[0].teamId.$in.map(String)).toEqual([ALFA, BETA, GAMA]);
    expect(JSON.stringify(insights)).not.toContain(TEXTOS_PRIVADOS[2]);
  });

  test('equipe inexistente tambem nao vira filtro', async () => {
    const insights = await v2({ equipe: hex(777) });
    expect(insights.equipeSolicitada).toEqual({ id: hex(777), disponivel: false });
    expect(insights.porEquipe).toHaveLength(3);
  });

  test('equipe autorizada: consultas, totais e alertas so dela', async () => {
    const insights = await v2({ equipe: BETA.toUpperCase() });
    expect(insights.filtros.equipe).toBe(BETA);
    expect(insights.equipeSolicitada).toBeNull();
    expect(insights.porEquipe.map((item) => item.equipe.id)).toEqual([BETA]);
    expect(insights.totais).toMatchObject({ registros: 3, chat: 1, bloqueadas: 2, ajuda: 0 });
    expect(insights.alertas.itens.map((item) => item.equipe.id)).toEqual([BETA, BETA]);
    expect(pipelines.notifications[0][0].$match['metadata.equipeId']).toEqual({ $in: [BETA] });
  });

  test('administrador sem equipes: nada consultado, indicadores zerados e recomendacao honesta', async () => {
    db.equipes = db.equipes.filter((equipe) => igual(equipe._id, ALHEIA));
    const insights = await v2();
    expect(AssistantInsight.aggregate).not.toHaveBeenCalled();
    expect(Notification.aggregate).not.toHaveBeenCalled();
    expect(insights.equipes).toEqual([]);
    expect(insights.porEquipe).toEqual([]);
    expect(insights.totais).toMatchObject({ registros: 0, equipesComAlertas: 0, alertas: { total: 0 } });
    expect(insights.recomendacoes.map((item) => item.tipo)).toEqual(['sem_sinais']);
  });
});

describe('contagens: origens separadas e consistentes', () => {
  test('chat, moderacao, assistente e origem desconhecida por equipe', async () => {
    const insights = await v2();
    expect(daEquipe(insights, ALFA)).toMatchObject({
      registros: 10, chat: 4, bloqueadas: 3, ajuda: 2, assistente: 1, origemDesconhecida: 2, indiciosSpam: 1, sinaisColetivos: 1,
    });
    expect(daEquipe(insights, BETA)).toMatchObject({ registros: 3, chat: 1, bloqueadas: 2, ajuda: 0, assistente: 0, origemDesconhecida: 0 });
    expect(daEquipe(insights, GAMA)).toMatchObject({ registros: 0, chat: 0, bloqueadas: 0, assuntos: [] });
    expect(insights.totais).toMatchObject({
      registros: 13, chat: 5, bloqueadas: 5, ajuda: 2, assistente: 1, origemDesconhecida: 2, indiciosSpam: 1,
      sinaisColetivos: 1, equipesComRegistros: 2, equipesComAlertas: 2,
    });
  });

  test('o total e a soma das origens exclusivas, das equipes e dos dias', async () => {
    const insights = await v2();
    const { totais, porEquipe, evolucao, moderacao } = insights;
    expect(totais.registros).toBe(totais.chat + totais.bloqueadas + totais.assistente + totais.origemDesconhecida);
    ['registros', 'chat', 'bloqueadas', 'ajuda', 'assistente', 'origemDesconhecida', 'indiciosSpam', 'sinaisColetivos'].forEach((campo) => {
      expect(porEquipe.reduce((soma, item) => soma + item[campo], 0)).toBe(totais[campo]);
    });
    const soma = (lista) => lista.reduce((total, n) => total + n, 0);
    expect(soma(evolucao.series.chat)).toBe(totais.chat);
    expect(soma(evolucao.series.bloqueadas)).toBe(totais.bloqueadas);
    expect(soma(evolucao.series.ajuda)).toBe(totais.ajuda);
    expect(soma(evolucao.series.assistente)).toBe(totais.assistente);
    expect(moderacao.total).toBe(totais.bloqueadas);
    expect(soma(moderacao.porCategoria.map((item) => item.total))).toBe(totais.bloqueadas);
    expect(totais.alertas.total).toBe(totais.alertas.individuais + totais.alertas.coletivos + totais.alertas.historicos);
  });

  test('registro so com o canal conta para a equipe; teamId de outra equipe com o canal dela nao', async () => {
    const insights = await v2();
    expect(daEquipe(insights, ALFA).chat).toBe(4); // inclui o 11, exclui o 17
    expect(pipelines.insights[0][0].$match.$or[1]).toEqual({ teamId: null, channelId: { $in: [ALFA, BETA, GAMA] } });
  });

  test('assuntos so das mensagens aprovadas do chat, sem o topico padrao "chat"', async () => {
    const insights = await v2();
    expect(daEquipe(insights, ALFA).assuntos).toEqual([
      { codigo: 'tarefas', rotulo: 'Tarefas', total: 2 }, // o registro 8 (assistente) com "tarefas" nao entra
      { codigo: 'equipes', rotulo: 'Equipes', total: 1 },
    ]);
    expect(daEquipe(insights, BETA).assuntos).toEqual([]);
  });
});

describe('moderacao: categorias reais e registros historicos', () => {
  test('categorias pelo sinal moderation_*; bloqueio antigo fica sem categoria', async () => {
    const { moderacao } = await v2();
    expect(moderacao.porCategoria).toEqual([
      { codigo: 'profanity', rotulo: 'Linguagem inadequada (palavrão)', total: 1 },
      { codigo: 'insult', rotulo: 'Ofensa direcionada (insulto)', total: 1 },
      { codigo: 'threat', rotulo: 'Ameaça', total: 1 },
      { codigo: 'hate', rotulo: 'Discurso de ódio ou discriminação', total: 1 },
      { codigo: 'sem_categoria', rotulo: 'Sem categoria registrada', total: 1 },
    ]);
  });

  test('spamAlert dos bloqueios nao vira spam; indicio de spam so em mensagem aprovada', async () => {
    const insights = await v2();
    // Os 5 bloqueios tem spamAlert true; o assistente (registro 8) tambem: nenhum entra.
    expect(insights.moderacao.indiciosSpam).toBe(1);
    expect(insights.totais.indiciosSpam).toBe(1);
    expect(daEquipe(insights, BETA).indiciosSpam).toBe(0);
  });

  test('ocorrencias recentes: limitadas, so equipe, data, categoria e gravidade', async () => {
    const { moderacao } = await v2();
    expect(moderacao.recentes.map((item) => item.id)).toEqual([14, 13, 6, 5, 7].map(idRegistro));
    expect(moderacao.recentes[0]).toEqual({
      id: idRegistro(14),
      data: '2026-11-25T10:00:00.000Z',
      equipe: { id: BETA, nome: 'Beta' },
      categoria: { codigo: 'hate', rotulo: 'Discurso de ódio ou discriminação' },
      grave: true,
      gravidade: { codigo: 'high', rotulo: 'Alto' },
    });
    const consulta = consultas.find((item) => item.filtro.source === 'team_chat_blocked');
    expect(consulta.limit).toBe(servico.LIMITE_MODERACAO_RECENTES);
    expect(consulta.sort).toEqual({ createdAt: -1 });
    expect(consulta.select.split(' ')).not.toContain('content');
    expect(consulta.select.split(' ')).not.toContain('userId');
  });
});

describe('alertas emitidos: individuais, coletivos e historicos', () => {
  test('uma notificacao por destinatario conta como um alerta; contagem por escopo e equipe', async () => {
    const insights = await v2();
    expect(daEquipe(insights, ALFA).alertas).toEqual({ individuais: 1, coletivos: 1, historicos: 0, semVinculo: 0, total: 2 });
    expect(daEquipe(insights, BETA).alertas).toEqual({ individuais: 1, coletivos: 0, historicos: 1, semVinculo: 0, total: 2 });
    expect(insights.totais.alertas).toEqual({ individuais: 2, coletivos: 1, historicos: 1, semVinculo: 0, total: 4 });
    expect(insights.alertas.total).toBe(4);
  });

  test('itens com os metadados registrados; pessoa so no individual, com o nome atual', async () => {
    const { itens } = (await v2()).alertas;
    expect(itens.map((item) => item.id)).toEqual([idRegistro(14), idRegistro(2), idRegistro(13), idRegistro(6)]);
    const [odio, coletivo, historico, ameaca] = itens;
    expect(ameaca).toEqual({
      id: idRegistro(6),
      vinculo: 'confiavel',
      data: '2026-11-23T13:00:01.000Z',
      equipe: { id: ALFA, nome: 'Alfa' },
      escopo: 'individual',
      gravidade: { codigo: 'high', rotulo: 'Alto' },
      categoria: { codigo: 'threat', rotulo: 'Ameaça' },
      ocorrencias: 1,
      motivos: ['Mensagem bloqueada pela moderação', 'Bloqueio por ameaça'],
      colaborador: { id: ANA, nome: 'Ana' },
    });
    expect(odio).toMatchObject({ escopo: 'individual', ocorrencias: 2, categoria: { codigo: 'hate' }, colaborador: { id: BRUNO, nome: 'Bruno' } });
    expect(coletivo).toMatchObject({
      escopo: 'coletivo', colaborador: null, ocorrencias: null,
      gravidade: { codigo: 'medium', rotulo: 'Moderado' }, categoria: { codigo: 'conflito', rotulo: 'Possível conflito na conversa' },
    });
    // Antigo sem escopo: o usuario gravado nao e exibido
    expect(historico).toMatchObject({
      escopo: 'historico', colaborador: null, categoria: { codigo: 'historico', rotulo: 'Registro histórico sem classificação confiável' },
    });
  });

  test('notificacao antiga sem metadados: gravidade nao registrada, sem motivos e sem pessoa', async () => {
    db.notifications = [notificacao(20, {}, { equipeId: ALFA, insightId: hex(70) })];
    const [item] = (await v2()).alertas.itens;
    expect(item).toMatchObject({
      id: hex(70), vinculo: 'confiavel', escopo: 'historico', gravidade: { codigo: null, rotulo: 'Não registrada' }, motivos: [], ocorrencias: null, colaborador: null,
    });
  });

  test('lista limitada aos mais recentes; o total continua completo', async () => {
    db.notifications = Array.from({ length: 130 }, (_, i) => notificacao(100 + i, {
      createdAt: new Date(AGORA.getTime() - (i + 1) * 60 * 1000),
    }, { scope: 'team', equipeId: ALFA, insightId: hex(2000 + i), alertLevel: 'medium', signals: ['team_help_needed'] }));
    const insights = await v2();
    expect(insights.alertas.total).toBe(130);
    expect(insights.alertas.itens).toHaveLength(servico.LIMITE_ALERTAS_LISTA);
    expect(insights.alertas.itens[0].id).toBe(hex(2000));
    expect(insights.limites).toMatchObject({ alertasExibidos: 100, limiteAlertas: 100, alertasParciais: false });
    expect(insights.alertas.itens[0].categoria).toEqual({ codigo: 'apoio', rotulo: 'Sinais de necessidade de ajuda na equipe' });
    // Limite intencional da lista (100) separado da protecao das contagens (2000 grupos).
    const { $facet: facetas } = pipelines.notifications[0].at(-1);
    expect(facetas.lista.at(-1)).toEqual({ $limit: servico.LIMITE_ALERTAS_LISTA });
    expect(facetas.contagens.at(-1)).toEqual({ $limit: servico.LIMITE_GRUPOS_ALERTAS + 1 });
  });

  test('so notificacoes do tipo de alerta de equipe entram', async () => {
    const texto = JSON.stringify((await v2()).alertas);
    expect(texto).not.toContain(hex(60));
    expect(texto).not.toContain(hex(61));
  });
});

describe('ocorrencia pedida pela notificacao', () => {
  test('no periodo', async () => {
    const insights = await v2({ ocorrencia: idRegistro(6) });
    expect(insights.ocorrenciaSolicitada).toMatchObject({ id: idRegistro(6), status: 'no_periodo', item: { id: idRegistro(6), escopo: 'individual' } });
  });

  test('antiga, fora do periodo: informada como tal, com os dados do alerta', async () => {
    const insights = await v2({ ocorrencia: hex(50), equipe: ALFA });
    expect(insights.ocorrenciaSolicitada).toMatchObject({
      id: hex(50), status: 'fora_do_periodo', item: { data: '2026-11-10T12:00:00.000Z', equipe: { id: ALFA }, categoria: { codigo: 'recurrence' } },
    });
    expect(insights.alertas.itens.map((item) => item.id)).not.toContain(hex(50));
  });

  test('de equipe nao autorizada ou de outra equipe que nao a filtrada: indisponivel, sem dados', async () => {
    const alheia = await v2({ ocorrencia: idRegistro(16) });
    expect(alheia.ocorrenciaSolicitada).toEqual({ id: idRegistro(16), status: 'indisponivel', item: null });
    expect(JSON.stringify(alheia)).not.toContain('Pessoa Alheia');
    const outraEquipe = await v2({ ocorrencia: idRegistro(6), equipe: BETA });
    expect(outraEquipe.ocorrenciaSolicitada).toEqual({ id: idRegistro(6), status: 'indisponivel', item: null });
  });

  test('inexistente', async () => {
    expect((await v2({ ocorrencia: hex(888) })).ocorrenciaSolicitada).toEqual({ id: hex(888), status: 'indisponivel', item: null });
  });
});

describe('recomendacoes baseadas em evidencias', () => {
  test('cada uma com situacao, evidencia, quantidade, equipe, periodo e acao, em ordem de prioridade', async () => {
    const { recomendacoes, periodo } = await v2();
    expect(recomendacoes.map((item) => item.chave)).toEqual([
      `moderacao_grave:${ALFA}`, `moderacao_grave:${BETA}`,
      `alertas_individuais:${ALFA}`, `alertas_individuais:${BETA}`,
      `alertas_coletivos:${ALFA}`,
      `moderacao_recorrente:${ALFA}`, `moderacao_recorrente:${BETA}`,
      `ajuda:${ALFA}`,
    ]);
    recomendacoes.forEach((item) => {
      expect(item).toEqual(expect.objectContaining({
        situacao: expect.any(String), evidencia: expect.any(String), acao: expect.any(String),
        quantidade: expect.any(Number), equipe: expect.objectContaining({ id: expect.any(String), nome: expect.any(String) }),
        origem: 'regra_automatica',
      }));
      expect(item.periodo).toMatchObject({ dias: 7, primeiroDia: periodo.primeiroDia, ultimoDia: periodo.ultimoDia });
    });
    const ajuda = recomendacoes.find((item) => item.tipo === 'ajuda');
    expect(ajuda).toMatchObject({ quantidade: 2, equipe: { id: ALFA, nome: 'Alfa' }, destino: { aba: 'equipes', equipe: ALFA } });
    expect(ajuda.evidencia).toBe('Foram identificadas 2 mensagens com sinais associados à necessidade de ajuda nesta equipe.');
    expect(ajuda.situacao).toBe('Sinais de necessidade de ajuda no chat');
    expect(ajuda.acao).toBe('São sinais automatizados por análise textual, não confirmações de dificuldades: verifique se existem dúvidas ou impedimentos relatados.');
    const recorrente = recomendacoes.find((item) => item.chave === `moderacao_recorrente:${ALFA}`);
    expect(recorrente.evidencia).toBe(
      'Foram registradas 3 ocorrências de moderação nesta equipe, somando todas as pessoas (linguagem inadequada (palavrão): 1; ameaça: 1; sem categoria registrada: 1).',
    );
    expect(recomendacoes.find((item) => item.tipo === 'alertas_coletivos').evidencia).toBe('Foi registrado 1 alerta coletivo no período.');
    expect(recomendacoes.find((item) => item.chave === `moderacao_grave:${BETA}`).evidencia)
      .toBe('Foi registrado 1 bloqueio por ameaça ou discurso de ódio nesta equipe.');
  });

  test('sem nada registrado: uma recomendacao honesta, que nao garante ausencia de problemas', async () => {
    db.insights = [registro(40, { signals: [] }), registro(41, { sentiment: 'negativo' })];
    db.notifications = [];
    const { recomendacoes } = await v2();
    expect(recomendacoes).toHaveLength(1);
    expect(recomendacoes[0]).toMatchObject({
      tipo: 'sem_sinais', equipe: null, quantidade: 0,
      evidencia: 'Nenhum sinal de acompanhamento foi registrado no período selecionado.',
    });
    expect(recomendacoes[0].acao).toContain('não garante');
  });

  test('mensagens neutras, negativas ou pouca conversa nao geram inferencias', async () => {
    db.insights = Array.from({ length: 12 }, (_, i) => registro(60 + i, { sentiment: i < 6 ? 'neutro' : 'negativo', topics: ['chat'] }));
    db.notifications = [];
    const texto = JSON.stringify((await v2()).recomendacoes).toLowerCase();
    ['neutra', 'esconder', 'produtiv', 'desinteresse', 'dedicação', 'perfil', 'negativ'].forEach((termo) => {
      expect(texto).not.toContain(termo);
    });
  });

  test('um unico bloqueio comum nao vira recomendacao de recorrencia', async () => {
    db.insights = [registro(80, { source: 'team_chat_blocked', spamAlert: true, signals: ['blocked_message', 'moderation_profanity'] })];
    db.notifications = [];
    expect((await v2()).recomendacoes.map((item) => item.tipo)).toEqual(['sem_sinais']);
  });
});

describe('privacidade', () => {
  test('nenhum texto de mensagem, conversa do assistente, e-mail ou percentual de risco no contrato novo', async () => {
    const insights = await v2({ ocorrencia: idRegistro(6) });
    const texto = JSON.stringify(insights);
    TEXTOS_PRIVADOS.forEach((privado) => expect(texto).not.toContain(privado));
    expect(texto).not.toContain('texto aprovado');
    expect(texto).not.toMatch(/conflictRisk|Risco \d+%|0\.42|@exemplo\.com/);
    pipelines.insights.forEach((pipeline) => expect(JSON.stringify(pipeline)).not.toContain('$content'));
    expect(User.find).toHaveBeenCalledWith({ _id: { $in: [BRUNO, ANA] } }); // so quem tem alerta individual
    const consultaUsuarios = consultas.find((item) => item.filtro?._id?.$in);
    expect(consultaUsuarios.select).toBe('nome');
  });

  test('falha no banco: 500 sem detalhes', async () => {
    AssistantInsight.aggregate.mockImplementationOnce(async () => { throw new Error('conexao recusada em mongodb://segredo'); });
    jest.spyOn(console, 'error').mockImplementation(() => {});
    const res = await consultar({ versao: '2' });
    expect(res.status).toBe(500);
    expect(JSON.stringify(res.body)).not.toContain('segredo');
  });
});

describe('contrato anterior (sem versao), para o frontend ja publicado', () => {
  test('mesmo formato, sem os campos novos', async () => {
    const res = await consultar();
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.versao).toBeUndefined();
    expect(Object.keys(res.body.insights).sort()).toEqual([
      'badActors', 'behaviorWindowDays', 'byTeam', 'chatSummaries', 'chatWindowDays', 'criticalAlerts', 'recent',
      'sentiments', 'spamAlerts', 'suggestions', 'topTopics', 'totalMessages',
    ].sort());
    expect(res.body.insights.chatWindowDays).toBe(7);
    expect(res.body.insights.behaviorWindowDays).toBe(14);
    // Parametros novos sem `versao` sao ignorados: nada de filtro fingido na resposta antiga.
    const comParametros = await consultar({ periodo: '30', equipe: BETA });
    expect(comParametros.body.insights.totalMessages).toBe(res.body.insights.totalMessages);
  });

  test('sem a inferencia sobre mensagens neutras e sem a sugestao pelo topico padrao "chat"', async () => {
    const { suggestions } = (await consultar()).body.insights;
    const texto = suggestions.join(' ').toLowerCase();
    expect(texto).not.toContain('neutras');
    expect(texto).not.toContain('esconder');
    expect(texto).not.toContain('dúvidas operacionais');
  });

  test('texto de bloqueio antigo e conversa do assistente nao saem em recent; mensagem aprovada continua', async () => {
    const { recent } = (await consultar()).body.insights;
    const texto = JSON.stringify(recent);
    expect(texto).not.toContain(TEXTOS_PRIVADOS[0]);
    expect(texto).not.toContain(TEXTOS_PRIVADOS[1]);
    expect(texto).not.toContain(TEXTOS_PRIVADOS[2]); // equipe alheia
    const bloqueio = recent.find((item) => item._id === idRegistro(7));
    expect(bloqueio.content).toBe('Mensagem bloqueada pela moderação do chat. O conteúdo não é exibido.');
    expect(recent.find((item) => item._id === idRegistro(8)).content).toBe('Registro do assistente. O conteúdo da conversa não é exibido.');
    expect(recent.find((item) => item._id === idRegistro(2)).content).toBe('texto aprovado 2');
  });
});

// ----------------------------------------------------------------------------------------------------------------
// Ajustes apos revisao (PR #64): origem explicita, limites de agregacao, identidade dos alertas, isolamento legado.
// ----------------------------------------------------------------------------------------------------------------
describe('origem dos registros: so valores conhecidos', () => {
  test.each([
    ['team_chat', 'chat'],
    ['team_chat_blocked', 'moderacao'],
    ['frontend', 'assistente'],
    ['FRONTEND', 'desconhecida'],
    ['mobile', 'desconhecida'],
    ['voice', 'desconhecida'],
    ['', 'desconhecida'],
    [undefined, 'desconhecida'],
    [null, 'desconhecida'],
    [42, 'desconhecida'],
    [{ tipo: 'frontend' }, 'desconhecida'],
  ])('origemDoRegistro(%p) = %s', (source, origem) => {
    expect(servico.origemDoRegistro(source)).toBe(origem);
  });

  test('na consulta: ausente, vazio, inesperado e malformado contam como desconhecida; o total fecha', async () => {
    db.insights = [
      registro(200, { source: 'frontend' }),
      registro(201, { source: '' }),
      registro(202, { source: undefined }),
      registro(203, { source: null }),
      registro(204, { source: 'mobile' }),
      registro(205, { source: 'FRONTEND' }),
      registro(206, { source: 42 }),
      registro(207, { source: { tipo: 'frontend' } }),
      registro(208, { source: 'team_chat' }),
    ];
    db.notifications = [];
    const { totais, evolucao } = await v2({ equipe: ALFA });
    expect(totais).toMatchObject({ registros: 9, chat: 1, bloqueadas: 0, assistente: 1, origemDesconhecida: 7 });
    expect(totais.registros).toBe(totais.chat + totais.bloqueadas + totais.assistente + totais.origemDesconhecida);
    expect(evolucao.series.assistente.reduce((a, b) => a + b, 0)).toBe(1);
  });
});

describe('limites de agregacao: totais completos ou indisponiveis', () => {
  const muitasEquipes = (n) => Array.from({ length: n }, (_, i) => ({
    _id: oid(10000 + i), nome: `Equipe ${String(i).padStart(4, '0')}`, createdBy: ADMIN, membros: [ADMIN],
  }));

  test('volume grande com valores de source variados: um grupo por origem, totais completos', async () => {
    db.insights = Array.from({ length: 6000 }, (_, i) => registro(10000 + i, {
      source: `origem-${i}`, createdAt: new Date(AGORA.getTime() - (i % 500) * 60 * 1000),
    }));
    db.notifications = [];
    const insights = await v2({ equipe: ALFA });
    expect(insights.limites).toMatchObject({ registrosParciais: false, assuntosParciais: false, recomendacoesIndisponiveis: false });
    expect(insights.totais).toMatchObject({ registros: 6000, origemDesconhecida: 6000, chat: 0 });
  }, 60000);

  test('acima de 5000 grupos de registros: contagens, grafico, moderacao e recomendacoes indisponiveis, nunca zero', async () => {
    const equipes = muitasEquipes(626);
    db.equipes = equipes;
    const origens = [
      { source: 'team_chat' },
      { source: 'frontend' },
      { source: 'mobile' },
      { source: 'team_chat_blocked', signals: ['blocked_message'] },
      ...['profanity', 'insult', 'threat', 'hate'].map((categoria) => ({ source: 'team_chat_blocked', signals: ['blocked_message', `moderation_${categoria}`] })),
    ];
    let n = 0;
    db.insights = equipes.flatMap((equipe) => origens.map((campos) => {
      n += 1;
      return registro(20000 + n, { teamId: equipe._id, channelId: String(equipe._id), ...campos });
    }));
    db.notifications = [notificacao(900, {}, { scope: 'team', equipeId: String(equipes[0]._id), insightId: hex(3000), alertLevel: 'medium' })];

    const insights = await v2();
    expect(db.insights).toHaveLength(5008); // 626 equipes x 8 combinacoes = 5008 grupos (> 5000)
    expect(insights.limites).toMatchObject({ registrosParciais: true, alertasParciais: false, recomendacoesIndisponiveis: true });
    expect(insights.totais).toMatchObject({ registros: null, chat: null, bloqueadas: null, ajuda: null, assistente: null, equipesComRegistros: null });
    expect(insights.porEquipe.every((item) => item.registros === null && item.bloqueadas === null)).toBe(true);
    expect(insights.porEquipe[0].moderacao).toEqual({ profanity: null, insult: null, threat: null, hate: null, sem_categoria: null });
    expect(insights.evolucao).toBeNull();
    expect(insights.moderacao).toMatchObject({ total: null, porCategoria: null, indiciosSpam: null });
    expect(insights.recomendacoes).toBeNull();
    // Listas e resultados independentes continuam: ocorrencias recentes (limite intencional) e alertas (completos).
    expect(insights.moderacao.recentes).toHaveLength(servico.LIMITE_MODERACAO_RECENTES);
    expect(insights.totais.alertas).toEqual({ individuais: 0, coletivos: 1, historicos: 0, semVinculo: 0, total: 1 });
    expect(insights.totais.equipesComAlertas).toBe(1);
  }, 60000);

  test('acima de 2000 grupos de alertas: totais de alertas e recomendacoes indisponiveis; lista dos 100 mais recentes continua', async () => {
    const equipes = muitasEquipes(667);
    db.equipes = equipes;
    db.insights = [];
    let n = 0;
    db.notifications = equipes.flatMap((equipe) => [{ scope: 'user', alertReason: 'threat' }, { scope: 'team' }, {}].map((meta) => {
      n += 1;
      return notificacao(10000 + n, { createdAt: new Date(AGORA.getTime() - n * 1000) }, {
        ...meta, equipeId: String(equipe._id), insightId: hex(50000 + n), alertLevel: 'high',
      });
    }));

    const insights = await v2();
    expect(insights.limites).toMatchObject({ alertasParciais: true, registrosParciais: false, recomendacoesIndisponiveis: true });
    expect(insights.totais.alertas).toEqual({ individuais: null, coletivos: null, historicos: null, semVinculo: null, total: null });
    expect(insights.totais.equipesComAlertas).toBeNull();
    expect(insights.porEquipe[0].alertas.total).toBeNull();
    expect(insights.alertas.total).toBeNull();
    expect(insights.alertas.itens).toHaveLength(servico.LIMITE_ALERTAS_LISTA);
    expect(insights.alertas.itens[0].id).toBe(hex(50001));
    expect(insights.recomendacoes).toBeNull();
    expect(insights.totais.registros).toBe(0); // contagens de registros completas continuam disponiveis
  }, 60000);
});

describe('identidade e deduplicacao dos alertas', () => {
  const coletivo = { scope: 'team', equipeId: ALFA, alertLevel: 'medium', signals: ['team_help_needed'] };

  test('mesma ocorrencia para dois destinatarios conta uma vez, mesmo com uma notificacao so com origemId', async () => {
    db.notifications = [
      notificacao(300, {}, { ...coletivo, insightId: hex(700) }),
      notificacao(301, { user: oid(4), origemId: new mongoose.Types.ObjectId(hex(700)) }, { ...coletivo }),
    ];
    const insights = await v2();
    expect(insights.alertas.itens).toHaveLength(1);
    expect(insights.alertas.itens[0]).toMatchObject({ id: hex(700), vinculo: 'confiavel', escopo: 'coletivo' });
    expect(insights.totais.alertas).toMatchObject({ coletivos: 1, semVinculo: 0, total: 1 });
  });

  test('sem identificador valido: cada notificacao conta sozinha, sem vinculo e sem pessoa', async () => {
    const individual = { scope: 'user', alertReason: 'threat', equipeId: ALFA, userId: ANA, userName: 'Ana (gravado)', alertLevel: 'high' };
    db.notifications = [
      notificacao(310, { origemId: null }, { ...individual, insightId: 'nao-e-id' }),
      notificacao(311, { user: oid(4), origemId: null }, { ...individual, insightId: { invalido: true } }),
    ];
    const insights = await v2();
    expect(insights.alertas.itens).toHaveLength(2);
    insights.alertas.itens.forEach((item) => {
      expect(item).toMatchObject({ id: null, vinculo: 'ausente', escopo: 'individual', colaborador: null });
    });
    expect(insights.totais.alertas).toMatchObject({ individuais: 2, semVinculo: 2, total: 2 });
    expect(JSON.stringify(insights)).not.toContain('Ana (gravado)');
    expect(User.find).not.toHaveBeenCalled();
  });

  test('ids divergentes: nao funde com a ocorrencia de um dos ids; vinculo divergente e sem pessoa', async () => {
    const individual = { scope: 'user', alertReason: 'threat', equipeId: ALFA, userId: ANA, alertLevel: 'high' };
    db.notifications = [
      notificacao(320, {}, { ...individual, insightId: hex(710) }),
      notificacao(321, { user: oid(4), origemId: new mongoose.Types.ObjectId(hex(711)) }, { ...individual, insightId: hex(710) }),
    ];
    const insights = await v2();
    const confiavel = insights.alertas.itens.find((item) => item.vinculo === 'confiavel');
    const divergente = insights.alertas.itens.find((item) => item.vinculo === 'divergente');
    expect(confiavel).toMatchObject({ id: hex(710), colaborador: { nome: 'Ana' } });
    expect(divergente).toMatchObject({ id: null, colaborador: null });
    expect(insights.totais.alertas).toMatchObject({ individuais: 2, semVinculo: 1, total: 2 });
    const pedida = await v2({ ocorrencia: hex(711) });
    expect(pedida.ocorrenciaSolicitada).toEqual({ id: hex(711), status: 'indisponivel', item: null });
  });

  test('ocorrencia pelo origemId (como notificationTarget), restrita a equipe consultada', async () => {
    db.notifications = [notificacao(330, { origemId: new mongoose.Types.ObjectId(hex(720)) }, { scope: 'team', equipeId: BETA, alertLevel: 'medium' })];
    const insights = await v2({ ocorrencia: hex(720) });
    expect(insights.ocorrenciaSolicitada).toMatchObject({ status: 'no_periodo', item: { id: hex(720), equipe: { id: BETA } } });
    expect((await v2({ ocorrencia: hex(720), equipe: ALFA })).ocorrenciaSolicitada).toEqual({ id: hex(720), status: 'indisponivel', item: null });
  });

  test('equipe pedida indisponivel: a ocorrencia nao e procurada nas outras equipes', async () => {
    const insights = await v2({ equipe: ALHEIA, ocorrencia: idRegistro(6) });
    expect(insights.equipeSolicitada).toEqual({ id: ALHEIA, disponivel: false });
    expect(insights.ocorrenciaSolicitada).toEqual({ id: idRegistro(6), status: 'indisponivel', item: null });
    expect(Notification.aggregate).toHaveBeenCalledTimes(1); // so a consulta principal
  });

  test('alerta individual de quem nao e mais membro: nome atual, sem e-mail', async () => {
    db.users.push({ _id: oid(6), nome: 'Ex-integrante', email: 'ex@exemplo.com', tipo: 'user' });
    db.notifications = [notificacao(340, {}, {
      scope: 'user', alertReason: 'recurrence', equipeId: ALFA, insightId: hex(730), userId: hex(6), occurrences: 3, alertLevel: 'high',
    })];
    const [item] = (await v2()).alertas.itens;
    expect(item.colaborador).toEqual({ id: hex(6), nome: 'Ex-integrante' });
    expect(JSON.stringify(item)).not.toContain('@');
  });

  test('alerta coletivo com usuario e nome gravados: nada da pessoa sai', async () => {
    db.notifications = [notificacao(350, {}, {
      scope: 'team', equipeId: ALFA, insightId: hex(740), userId: ANA, userName: 'Nome Gravado Coletivo', alertLevel: 'medium',
    })];
    const insights = await v2();
    expect(insights.alertas.itens[0].colaborador).toBeNull();
    expect(JSON.stringify(insights)).not.toContain('Nome Gravado Coletivo');
    expect(User.find).not.toHaveBeenCalled();
  });
});

describe('contrato anterior: isolamento por equipe e chave normalizada', () => {
  test('teamId de equipe alheia com canal autorizado: nada do registro e devolvido', async () => {
    db.insights.push(registro(90, {
      teamId: oid(14), channelId: ALFA, content: 'conteudo alheio pelo canal de Alfa', alertLevel: 'high', spamAlert: true, topics: ['usuarios'],
    }));
    const { insights } = (await consultar()).body;
    expect(JSON.stringify(insights)).not.toContain('conteudo alheio pelo canal de Alfa');
    expect(insights.totalMessages).toBe(14); // registros 1 a 14 (o 11 pelo canal, sem teamId); 15, 16, 17 e 90 fora
    expect(insights.topTopics.map((item) => item.topic)).not.toContain('usuarios');
    const ids = insights.recent.map((item) => item._id);
    expect(ids).not.toContain(idRegistro(90));
    expect(ids).not.toContain(idRegistro(17));
    const ramoCanal = pipelines.insights[0][0].$match.$or[1];
    expect(Object.keys(ramoCanal).sort()).toEqual(['channelId', 'teamId']);
    expect(ramoCanal.teamId).toBeNull();
    expect([...ramoCanal.channelId.$in].sort()).toEqual([ALFA, BETA, GAMA]);
  });

  test('registro com teamId e registro so com o canal da mesma equipe formam uma linha so', async () => {
    const { byTeam } = (await consultar()).body.insights;
    const alfa = byTeam.filter((item) => item.channelId === ALFA);
    expect(alfa).toHaveLength(1);
    expect(alfa[0]).toMatchObject({ teamName: 'Alfa', totalMessages: 8 }); // 1-7 e o 11 (chat e bloqueios, 7 dias)
    expect(byTeam.filter((item) => item.channelId === BETA)).toEqual([expect.objectContaining({ totalMessages: 3 })]);
    expect(byTeam.map((item) => item.channelId)).not.toContain(ALHEIA);
  });
});
