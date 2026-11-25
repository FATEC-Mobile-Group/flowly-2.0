// Moderacao textual do chat por regras locais (sem classificador externo).
// Criterio conservador: bloqueia palavroes explicitos, insultos diretos, ameacas explicitas e construcoes
// explicitas de odio ou discriminacao. Palavras ambiguas ("lixo", "burro", "matar") so bloqueiam quando dirigidas
// a alguem. Assuntos sensiveis (sexualidade, nazismo, racismo, drogas, suicidio, religiao) nunca bloqueiam pela
// simples mencao. Sao regras deterministicas: reconhecem construcoes simples, nao entendem contexto nem intencao.
const MAX_TEXT_LENGTH = 4000;

// Termos que nao tem uso legitimo numa conversa de equipe: bloqueiam em qualquer posicao.
const EXPLICIT_INSULTS = [
  'idiota', 'idiotas', 'imbecil', 'imbecis', 'otario', 'otaria', 'otarios', 'otarias',
  'babaca', 'babacas', 'cretino', 'cretina', 'cretinos', 'cretinas',
  'arrombado', 'arrombada', 'arrombados', 'arrombadas',
  'desgracado', 'desgracada', 'desgracados', 'desgracadas',
  'viado', 'viados', 'fdp',
];
// Politica de 2026-11: "merda" e "bosta" passaram a palavrao explicito (antes so bloqueavam quando dirigidos a
// alguem), inclusive em desabafos como "que merda, o build quebrou". "foda" continua bloqueado tambem como elogio.
// Flexoes, diminutivos e aumentativos ficam numa lista fechada: nada de busca por pedaco de palavra.
const EXPLICIT_PROFANITY = [
  'puta', 'putas', 'putinha', 'putinhas', 'putona',
  'porra', 'porras', 'caralho', 'caralhos', 'caralhinho', 'caralhao', 'caralhada',
  'foder', 'fodase', 'foda', 'fodas', 'fodao', 'fodona', 'fodeu', 'fodido', 'fodida', 'fodidos', 'fodidas',
  'fuder', 'fudeu', 'fudido', 'fudida', 'fudidos', 'fudidas',
  'merda', 'merdas', 'merdinha', 'merdinhas', 'merdao',
  'bosta', 'bostas', 'bostinha', 'bostinhas', 'bostao',
  'vtnc', 'vsf', 'tnc', 'pqp',
];

// Termos ambiguos: so bloqueiam quando dirigidos a uma pessoa ("voce e um X", "seu X") ou ao trabalho dela
// ("seu trabalho e um X").
const DIRECTED_TERMS = [
  'burro', 'burra', 'burros', 'burras', 'lixo', 'lixos', 'inutil', 'inuteis',
  'estupido', 'estupida', 'estupidos', 'estupidas', 'anta', 'antas',
  'retardado', 'retardada', 'retardados', 'retardadas',
  'nojento', 'nojenta', 'nojentos', 'nojentas', 'incompetente', 'incompetentes',
  'vagabundo', 'vagabunda', 'vagabundos', 'vagabundas', 'palhaco', 'palhaca', 'palhacos', 'palhacas',
  'imprestavel', 'imprestaveis', 'macaco', 'macaca', 'macacos', 'macacas', 'verme', 'vermes',
];
// No fim da frase ("leve seu lixo"), "lixo" costuma ser objeto e nao xingamento.
const OBJECT_NOUNS = new Set(['lixo', 'lixos']);

const SUBJECTS = new Set(['voce', 'vc', 'voces', 'vcs', 'tu', 'ele', 'ela', 'eles', 'elas']);
const LINKING_VERBS = new Set([
  'e', 'eh', 'es', 'sao', 'parece', 'parecem', 'ta', 'tah', 'esta', 'estao', 'fica', 'ficou', 'foi', 'virou',
]);
const POSSESSIVES = new Set(['seu', 'sua', 'seus', 'suas', 'teu', 'tua', 'teus', 'tuas']);
const FILLERS = new Set([
  'um', 'uma', 'uns', 'umas', 'muito', 'mt', 'mto', 'tao', 'bem', 'meio', 'mesmo', 'mesma', 'so',
  'completo', 'completa', 'grande', 'baita', 'tremendo', 'tremenda', 'totalmente', 'completamente', 'realmente',
]);
const MAX_FILLERS = 3;

// Ataque ao trabalho de outra pessoa: "seu trabalho e um lixo", "o codigo dele ficou uma porcaria".
// So com dono explicito (seu/sua/teu/dele/dela), verbo de ligacao e o termo no fim da oracao:
// "o tema do seu trabalho e lixo eletronico" e "precisamos melhorar esse trabalho" continuam permitidos.
const WORK_NOUNS = new Set([
  'trabalho', 'trabalhos', 'codigo', 'codigos', 'projeto', 'projetos', 'relatorio', 'relatorios',
  'apresentacao', 'texto', 'textos', 'ideia', 'ideias', 'parte', 'tarefa', 'tarefas', 'entrega', 'entregas',
  'slide', 'slides', 'proposta', 'layout', 'design', 'documento', 'documentos', 'resposta', 'pesquisa', 'planilha',
]);
const OWNER_AFTER = new Set(['dele', 'dela', 'deles', 'delas']);
const WORK_TAIL = new Set([...FILLERS, 'total', 'absoluto', 'absoluta', 'puro', 'pura']);

// Ameacas explicitas, avaliadas sobre os tokens da oracao unidos por espaco.
// "de rir", "de fome" etc. sao expressoes idiomaticas; "de porrada", "de tiro" continuam ameaca.
const NOT_IDIOM = '(?! de (?!(?:porrada|pancada|tiro|tiros|faca|facada|soco|socos)\\b))';
const SECOND_PERSON = '(?:voce|vc|voces|vcs|tu)';
const FIRST_PERSON_AUX = '(?:vou|vo|vamos|vamo|irei|iremos|quero|eu)';
const VIOLENT_INFINITIVES = '(?:matar|espancar|esfaquear|enforcar|arrebentar|agredir|bater|socar)';
const VIOLENT_FIRST_PERSON = '(?:mato|matarei|mataria|espanco|espancarei|esfaqueio|enforco|arrebento|agrido|bato|soco)';
const THREAT_PATTERNS = [
  new RegExp(`(?:^| )te ${VIOLENT_FIRST_PERSON}\\b${NOT_IDIOM}`),
  new RegExp(`(?:^| )${FIRST_PERSON_AUX}(?: [a-z]+)? te ${VIOLENT_INFINITIVES}\\b${NOT_IDIOM}`),
  new RegExp(`(?:^| )${FIRST_PERSON_AUX} ${VIOLENT_INFINITIVES} ${SECOND_PERSON}\\b${NOT_IDIOM}`),
  new RegExp(`(?:^| )${VIOLENT_FIRST_PERSON} ${SECOND_PERSON}\\b${NOT_IDIOM}`),
  new RegExp(`(?:^| )${SECOND_PERSON} (?:vai|vao|ira|irao) morrer\\b${NOT_IDIOM}`),
  new RegExp(`(?:^| )sei onde ${SECOND_PERSON} (?:mora|moram|trabalha|estuda)\\b`),
  new RegExp(`(?:^| )te (?:pego|pegar|pegamos) (?:la fora|na saida)\\b`),
];
const PROFANE_PHRASES = [
  /(?:^| )tomar? no cu\b/,
  /(?:^| )filh[oa]s? da puta\b/,
  // "vai a merda" ja cai no palavrao; "ferrar" sozinho e legitimo ("ferrar o cavalo"), so a expressao bloqueia.
  /(?:^| )(?:vai|va|vao|vamos) (?:se|te) ferrar\b/,
];

// Odio e discriminacao: so construcoes explicitas de promocao de ideologia de odio, incitacao contra grupos
// protegidos, generalizacao desumanizante e hostilidade declarada. A mencao do assunto, a negacao ("nao apoio o
// nazismo"), a condenacao ("dizer que X e racismo") e a citacao atribuida ("eles gritavam '...'") nao bloqueiam.
// Palavras como "pesquisa", "historia" ou "TCC" nao liberam nada por si.
const GROUP_TERMS = [
  'judeus', 'judias', 'negros', 'negras', 'pretos', 'pretas', 'gays', 'lesbicas', 'homossexuais', 'bissexuais',
  'trans', 'transexuais', 'travestis', 'lgbt', 'lgbts', 'lgbtqia', 'mulheres', 'imigrantes', 'refugiados',
  'nordestinos', 'nordestinas', 'indigenas', 'indios', 'muculmanos', 'islamicos', 'cristaos', 'evangelicos',
  'catolicos', 'ateus', 'umbandistas', 'candomblecistas', 'ciganos', 'asiaticos', 'africanos', 'haitianos',
  'venezuelanos', 'bolivianos', 'deficientes', 'autistas', 'idosos',
];
const GROUPS = `(?:${GROUP_TERMS.join('|')})`;
const DETERMINERS = '(?:todos os|todas as|os|as|todos|todas|esses|essas|estes|estas|aqueles|aquelas)';
// O grupo precisa ser o sujeito: "salarios de mulheres sao inferiores" e "nem todos os imigrantes sao..." nao contam.
const NOT_SUBJECT = '(?<!\\b(?:de|dos|das|da|do|entre|para|com|sobre|contra|pelos|pelas|nem|os|as|todos|todas'
  + '|esses|essas|estes|estas|aqueles|aquelas))';
const GROUP_SUBJECT = `${NOT_SUBJECT} (?:${DETERMINERS} )?${GROUPS}`;
const GROUP_OBJECT = `(?:${DETERMINERS} )?${GROUPS}`;
const NOT_NEGATED = '(?<!\\b(?:nao|nunca|jamais))';
const DEHUMANIZING = '(?:inferiores|inferior|animais|macacos|ratos|vermes|pragas|praga|lixo|lixos|escoria|doentes'
  + '|aberracoes|aberracao|sub humanos|subhumanos|parasitas|nojentos|nojentas|imundos|imundas|burros|burras'
  + '|estupidos|estupidas|retardados|retardadas|idiotas|imbecis|incapazes|bandidos|criminosos|terroristas)';
// Sem "kkk": em portugues e risada ("salve kkk"). A sigla do grupo entra por extenso.
const IDEOLOGY = '(?:hitler|nazismo|fascismo|terceiro reich|reich|ku klux klan|supremacia branca|raca ariana'
  + '|ideologia nazista)';
const HATE_PATTERNS = [
  // Generalizacao desumanizante: "judeus sao ratos", "todos os imigrantes sao bandidos".
  new RegExp(`${GROUP_SUBJECT} (?:sao|e|eh|nao passam de) (?:(?:todos|todas|tudo|uns|umas|uma|um|so|apenas`
    + `|uma raca de|uma especie de|uma corja de) )?${DEHUMANIZING}\\b`, 'g'),
  // Incitacao: "gays merecem morrer", "imigrantes devem ser expulsos".
  new RegExp(`${GROUP_SUBJECT} (?:tem que|tinham que|devem|deveriam|merecem|precisam) (?:todos )?(?:morrer|apanhar`
    + '|sumir|ser (?:exterminados|exterminadas|mortos|mortas|eliminados|eliminadas|expulsos|expulsas|queimados|queimadas))\\b', 'g'),
  new RegExp(`(?:^| )morte (?:aos|as|a|ao) ${GROUPS}\\b`, 'g'),
  new RegExp(`${NOT_NEGATED} (?:vamos|vou|bora|temos que|precisamos) (?:matar|exterminar|eliminar|espancar|queimar`
    + `|expulsar) ${GROUP_OBJECT}\\b`, 'g'),
  new RegExp(`(?:^| )(?:matem|exterminem|eliminem|queimem|espanquem|expulsem) ${GROUP_OBJECT}\\b`, 'g'),
  // Hostilidade declarada: "odeio nordestinos", "tenho nojo de gays".
  new RegExp(`${NOT_NEGATED} (?:odeio|odiamos|detesto|tenho nojo de|tenho nojo dos|tenho nojo das) ${GROUP_OBJECT}\\b`, 'g'),
  // Promocao de ideologia de odio e negacao do Holocausto.
  new RegExp(`(?:^| )(?:viva|vivas|salve|heil|sieg heil|gloria ao|gloria a) (?:(?:o|a|ao) )?${IDEOLOGY}\\b`, 'g'),
  new RegExp(`${NOT_NEGATED} (?:apoio|defendo|admiro|amo) (?:(?:o|a) )?(?:${IDEOLOGY}|holocausto)\\b`, 'g'),
  new RegExp(' (?:o )?(?:hitler|nazismo|fascismo|os nazistas|nazistas) (?:estava|estavam|tinha|tinham|esta|estao)'
    + ' (?:certo|certos|com razao|razao)\\b', 'g'),
  new RegExp(`${NOT_NEGATED} (?:sou|somos) (?:nazista|nazistas|neonazista|neonazistas|fascista|fascistas`
    + '|supremacista|supremacistas)\\b', 'g'),
  new RegExp(' (?:o )?holocausto (?:nunca existiu|nao existiu|nunca aconteceu|nao aconteceu|e uma farsa|foi uma farsa'
    + '|e mentira|foi mentira|e uma mentira|foi uma mentira|e invencao|foi pouco|foi merecido)\\b', 'g'),
];
// Toda regra de odio exige um destes termos: frase sem nenhum deles nem passa pelas expressoes (desempenho).
const HATE_TRIGGERS = new Set([
  ...GROUP_TERMS,
  'hitler', 'nazismo', 'nazista', 'nazistas', 'neonazista', 'neonazistas', 'fascismo', 'fascista', 'fascistas',
  'reich', 'klan', 'supremacia', 'supremacista', 'supremacistas', 'ariana', 'holocausto',
]);
// Enquadramentos que transformam a frase em relato, negacao ou condenacao, avaliados so junto ao trecho encontrado.
const FRAME_BEFORE = new RegExp('(?:^| )(?:(?:dizer|diz|dizem|disse|diziam|dizia|afirmar|afirma|afirmam|afirmavam'
  + '|alegar|alegam|alegavam|pregar|pregava|pregavam|defendiam|defendia|acreditavam|acreditava|propagavam|propagava'
  + '|espalhar|espalham|negar|nega|negam|negavam) que|(?:ideia|mito|teoria|crenca|falacia|discurso|mentira'
  + '|propaganda) (?:de|da|do) que|(?:nao e verdade|e mentira|e falso|e absurdo) que'
  + '|(?:gritavam|gritava|gritaram|saudavam|saudava|cantavam|cantava|o lema|o slogan|o grito|a saudacao'
  + '|a expressao|a frase)(?: (?:de|com|o|a))?)$');
const FRAME_AFTER = new RegExp('^ (?:isso |o que )?(?:e|eh|foi|seria)(?: (?:uma?|o|a))?(?: (?:ideia|afirmacao|frase'
  + '|fala|discurso|pensamento|exemplo|caso))?(?: de)? (?:racista|racismo|preconceito|preconceituosa|preconceituoso'
  + '|falsa|falso|mentira|absurdo|absurda|discriminatoria|discriminatorio|discriminacao|homofobia|homofobica'
  + '|homofobico|transfobia|transfobica|xenofobia|xenofobica|xenofobico|machismo|machista|antissemitismo'
  + '|antissemita|negacionismo|crime|odio|inaceitavel)\\b');
// Trecho entre aspas so e tratado como citacao quando o resto da mensagem diz de quem e a fala.
const QUOTED = /["“”«»]([^"“”«»]{1,400})["“”«»]/g;
const REPORTING = /(?:^| )(?:disse|diziam|dizia|disseram|gritavam|gritava|gritaram|escreveu|escreviam|escreveram|afirmou|afirmavam|cantavam|frase|lema|slogan|cartaz|cartazes|faixa|discurso|citacao|propaganda|saudacao|expressao|panfleto|panfletos)\b/;

// Gravidade das categorias: a mensagem recebe a mais grave encontrada.
const SEVERITY = { profanity: 1, insult: 2, threat: 3, hate: 4 };

// Substituicoes de "leet" aplicadas apenas a tokens que misturam letras e simbolos ("1diota", "mat4r").
const LEET_MAP = { 0: 'o', 1: 'i', 3: 'e', 4: 'a', 5: 's', 7: 't', '@': 'a', $: 's' };

// Letras repetidas ("idiotaaa") sao comparadas na forma comprimida, dos dois lados.
const squeeze = (token) => token.replace(/([a-z])\1+/g, '$1');
const toSqueezedSet = (terms) => new Set(terms.map(squeeze));
const EXPLICIT_INSULT_SET = toSqueezedSet(EXPLICIT_INSULTS);
const EXPLICIT_PROFANITY_SET = toSqueezedSet(EXPLICIT_PROFANITY);
const DIRECTED_SET = toSqueezedSet(DIRECTED_TERMS);
const OBJECT_NOUN_SET = toSqueezedSet([...OBJECT_NOUNS]);
const EXPLICIT_FOR_SPELLED = [...EXPLICIT_INSULTS, ...EXPLICIT_PROFANITY].filter((term) => term.length >= 4);

const stripAccents = (text) => text.normalize('NFKD').replace(/[̀-ͯ]/g, '');

const baseNormalize = (text) => stripAccents(text)
  .replace(/[​-‍⁠﻿]/g, '')
  .toLowerCase()
  // "b.u.r.r.o", "i-d-i-o-t-a": letras isoladas separadas por pontuacao viram uma palavra.
  .replace(/(?<![a-z0-9@$])[a-z0-9@$](?:[.\-_*]+[a-z0-9@$]){2,}(?![a-z0-9@$])/g, (match) => match.replace(/[.\-_*]+/g, ''));

const deLeet = (token) => (/[a-z]/.test(token) && /[0-9@$]/.test(token)
  ? token.replace(/[0-9@$]/g, (char) => LEET_MAP[char] || char)
  : token);

const tokenize = (text) => text.split(/[^a-z0-9@$]+/).filter(Boolean).map(deLeet);

// Junta sequencias de 3+ letras soltas ("i d i o t a"). Sequencias legitimas ("e o a") nao formam termos.
const joinSpelledRuns = (tokens) => {
  const result = [];
  const spelled = [];
  let run = [];
  const flush = () => {
    if (run.length >= 3) {
      const joined = run.join('');
      result.push(joined);
      spelled.push(joined);
    } else {
      result.push(...run);
    }
    run = [];
  };
  tokens.forEach((token) => {
    if (token.length === 1 && /[a-z]/.test(token)) {
      run.push(token);
      return;
    }
    flush();
    result.push(token);
  });
  flush();
  return { tokens: result, spelled };
};

const splitClauses = (text) => text
  .split(/[.,;:!?…\n\r()[\]{}"'“”‘’]+/)
  .map(tokenize)
  .filter((tokens) => tokens.length > 0)
  .map(joinSpelledRuns);

const skipFillers = (tokens, start) => {
  let index = start;
  while (index < tokens.length && index - start < MAX_FILLERS && FILLERS.has(tokens[index])) index += 1;
  return index;
};

const isDirectedInsult = (tokens, squeezed) => {
  for (let i = 0; i < tokens.length - 1; i += 1) {
    if (SUBJECTS.has(tokens[i]) && LINKING_VERBS.has(tokens[i + 1])) {
      const target = skipFillers(tokens, i + 2);
      if (target < tokens.length && DIRECTED_SET.has(squeezed[target])) return true;
    }
  }
  // Vocativo isolado: a oracao inteira e "seu X" ("seu burro", "sua inutil").
  if (POSSESSIVES.has(tokens[0])) {
    const target = skipFillers(tokens, 1);
    if (target === tokens.length - 1 && DIRECTED_SET.has(squeezed[target])) return true;
  }
  // Vocativo no fim da oracao: "para de errar seu burro" (exceto objetos como "leve seu lixo").
  const last = tokens.length - 1;
  if (last >= 1 && DIRECTED_SET.has(squeezed[last]) && !OBJECT_NOUN_SET.has(squeezed[last])) {
    let index = last - 1;
    while (index > 0 && last - index <= MAX_FILLERS && FILLERS.has(tokens[index])) index -= 1;
    if (POSSESSIVES.has(tokens[index])) return true;
  }
  return false;
};

const isWorkAttack = (tokens, squeezed) => {
  for (let i = 0; i < tokens.length; i += 1) {
    if (WORK_NOUNS.has(tokens[i])) {
      let owned = i > 0 && POSSESSIVES.has(tokens[i - 1]);
      let next = i + 1;
      if (OWNER_AFTER.has(tokens[next])) {
        owned = true;
        next += 1;
      }
      if (owned && LINKING_VERBS.has(tokens[next])) {
        const target = skipFillers(tokens, next + 1);
        if (target < tokens.length && DIRECTED_SET.has(squeezed[target])
          && tokens.slice(target + 1).every((token) => WORK_TAIL.has(token))) return true;
      }
    }
  }
  return false;
};

const classifyClause = ({ tokens, spelled }) => {
  const squeezed = tokens.map(squeeze);
  const sentence = tokens.join(' ');
  if (THREAT_PATTERNS.some((pattern) => pattern.test(sentence))) return 'threat';
  if (squeezed.some((token) => EXPLICIT_INSULT_SET.has(token))) return 'insult';
  if (squeezed.some((token) => EXPLICIT_PROFANITY_SET.has(token))) return 'profanity';
  // Letras soltas coladas a palavras vizinhas ("e i d i o t a" -> "eidiota").
  if (spelled.some((run) => EXPLICIT_FOR_SPELLED.some((term) => squeeze(run).includes(squeeze(term))))) return 'insult';

  if (PROFANE_PHRASES.some((pattern) => pattern.test(sentence))) return 'profanity';
  if (isDirectedInsult(tokens, squeezed) || isWorkAttack(tokens, squeezed)) return 'insult';
  return null;
};

const isFramed = (sentence, match) => FRAME_BEFORE.test(sentence.slice(0, match.index).trimEnd())
  || FRAME_AFTER.test(sentence.slice(match.index + match[0].length));

// Avaliado por frase (nao por oracao), para enxergar o enquadramento em volta do trecho.
const hasHateSpeech = (normalized) => {
  let text = normalized;
  const outside = normalized.replace(QUOTED, ' ');
  if (outside !== normalized && REPORTING.test(tokenize(outside).join(' '))) text = outside;
  return text
    .split(/[.!?;\n\r…]+/)
    .map(tokenize)
    .filter((tokens) => tokens.some((token) => HATE_TRIGGERS.has(token)))
    .map((tokens) => ` ${tokens.join(' ')} `)
    .some((sentence) => HATE_PATTERNS.some((pattern) => [...sentence.matchAll(pattern)]
      .some((match) => !isFramed(sentence, match))));
};

// Categoria mais grave da mensagem (hate, threat, insult, profanity) ou null. Sem limites de tamanho nem
// texto vazio: usada tambem pelos insights, que precisam do mesmo criterio da moderacao.
const classifyText = (text) => {
  const normalized = baseNormalize(String(text || '').trim().replace(/\s+/g, ' '));
  if (!normalized) return null;
  if (hasHateSpeech(normalized)) return 'hate';
  let worst = null;
  for (const clause of splitClauses(normalized)) {
    const category = classifyClause(clause);
    if (category && (!worst || SEVERITY[category] > SEVERITY[worst])) worst = category;
    if (worst === 'threat') break;
  }
  return worst;
};

const moderateText = (text) => {
  const normalized = String(text || '').trim().replace(/\s+/g, ' ');
  if (!normalized) return { allowed: false, reason: 'empty_content', score: 1 };
  if (normalized.length > MAX_TEXT_LENGTH) return { allowed: false, reason: 'possible_spam', score: 0.8 };

  const category = classifyText(normalized);
  if (category) return { allowed: false, reason: 'unsafe_content', score: 0.95, category };
  return { allowed: true, reason: '', score: 0.02 };
};

module.exports = { moderateText, classifyText, MAX_TEXT_LENGTH, MODERATION_CATEGORIES: Object.keys(SEVERITY) };
