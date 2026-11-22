// Moderacao textual do chat por regras locais (sem classificador externo).
// Criterio conservador: bloqueia insultos diretos, palavroes explicitos e ameacas explicitas.
// Palavras ambiguas ("lixo", "burro", "matar", "ameaca") so bloqueiam quando dirigidas a alguem.
const MAX_TEXT_LENGTH = 4000;

// Termos que nao tem uso legitimo numa conversa de equipe: bloqueiam em qualquer posicao.
const EXPLICIT_INSULTS = [
  'idiota', 'idiotas', 'imbecil', 'imbecis', 'otario', 'otaria', 'otarios', 'otarias',
  'babaca', 'babacas', 'cretino', 'cretina', 'cretinos', 'cretinas',
  'arrombado', 'arrombada', 'arrombados', 'arrombadas',
  'desgracado', 'desgracada', 'desgracados', 'desgracadas',
  'viado', 'viados', 'fdp',
];
const EXPLICIT_PROFANITY = [
  'puta', 'putas', 'porra', 'caralho', 'caralhos',
  'foder', 'fodase', 'foda', 'fodido', 'fodida', 'fodidos', 'fodidas',
  'vtnc', 'vsf', 'tnc', 'pqp',
];

// Termos ambiguos: so bloqueiam quando dirigidos a uma pessoa ("voce e um X", "seu X").
const DIRECTED_TERMS = [
  'burro', 'burra', 'burros', 'burras', 'lixo', 'lixos', 'inutil', 'inuteis',
  'estupido', 'estupida', 'estupidos', 'estupidas', 'anta', 'antas',
  'retardado', 'retardada', 'retardados', 'retardadas', 'merda', 'merdas', 'bosta', 'bostas',
  'nojento', 'nojenta', 'nojentos', 'nojentas', 'incompetente', 'incompetentes',
  'vagabundo', 'vagabunda', 'vagabundos', 'vagabundas', 'palhaco', 'palhaca', 'palhacos', 'palhacas',
  'imprestavel', 'imprestaveis',
];
// No fim da frase ("leve seu lixo"), "lixo" costuma ser objeto e nao xingamento.
const OBJECT_NOUNS = new Set(['lixo', 'lixos']);

const SUBJECTS = new Set(['voce', 'vc', 'voces', 'vcs', 'tu', 'ele', 'ela', 'eles', 'elas']);
const LINKING_VERBS = new Set(['e', 'eh', 'es', 'sao', 'parece', 'parecem', 'ta', 'tah', 'esta', 'estao', 'fica', 'virou']);
const POSSESSIVES = new Set(['seu', 'sua', 'seus', 'suas']);
const FILLERS = new Set([
  'um', 'uma', 'uns', 'umas', 'muito', 'mt', 'mto', 'tao', 'bem', 'meio', 'mesmo', 'mesma', 'so',
  'completo', 'completa', 'grande', 'baita', 'tremendo', 'tremenda', 'totalmente', 'completamente', 'realmente',
]);
const MAX_FILLERS = 3;

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
const PROFANE_PHRASES = [/(?:^| )tomar? no cu\b/, /(?:^| )filh[oa]s? da puta\b/];

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

const stripAccents = (text) => text.normalize('NFKD').replace(/[\u0300-\u036f]/g, '');

const baseNormalize = (text) => stripAccents(text)
  .replace(/[\u200b-\u200d\u2060\ufeff]/g, '')
  .toLowerCase()
  // "b.u.r.r.o", "i-d-i-o-t-a": letras isoladas separadas por pontuacao viram uma palavra.
  .replace(/(?<![a-z0-9@$])[a-z0-9@$](?:[.\-_*]+[a-z0-9@$]){2,}(?![a-z0-9@$])/g, (match) => match.replace(/[.\-_*]+/g, ''));

const deLeet = (token) => (/[a-z]/.test(token) && /[0-9@$]/.test(token)
  ? token.replace(/[0-9@$]/g, (char) => LEET_MAP[char] || char)
  : token);

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
  .split(/[.,;:!?\u2026\n\r()[\]{}"'\u201c\u201d\u2018\u2019]+/)
  .map((clause) => clause.split(/[^a-z0-9@$]+/).filter(Boolean).map(deLeet))
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

const classifyClause = ({ tokens, spelled }) => {
  const squeezed = tokens.map(squeeze);
  if (squeezed.some((token) => EXPLICIT_INSULT_SET.has(token))) return 'insult';
  if (squeezed.some((token) => EXPLICIT_PROFANITY_SET.has(token))) return 'profanity';
  // Letras soltas coladas a palavras vizinhas ("e i d i o t a" -> "eidiota").
  if (spelled.some((run) => EXPLICIT_FOR_SPELLED.some((term) => squeeze(run).includes(squeeze(term))))) return 'insult';

  const sentence = tokens.join(' ');
  if (THREAT_PATTERNS.some((pattern) => pattern.test(sentence))) return 'threat';
  if (PROFANE_PHRASES.some((pattern) => pattern.test(sentence))) return 'profanity';
  if (isDirectedInsult(tokens, squeezed)) return 'insult';
  return null;
};

const moderateText = (text) => {
  const normalized = String(text || '').trim().replace(/\s+/g, ' ');
  if (!normalized) return { allowed: false, reason: 'empty_content', score: 1 };
  if (normalized.length > MAX_TEXT_LENGTH) return { allowed: false, reason: 'possible_spam', score: 0.8 };

  for (const clause of splitClauses(baseNormalize(normalized))) {
    const category = classifyClause(clause);
    if (category) return { allowed: false, reason: 'unsafe_content', score: 0.95, category };
  }
  return { allowed: true, reason: '', score: 0.02 };
};

module.exports = { moderateText, MAX_TEXT_LENGTH };
