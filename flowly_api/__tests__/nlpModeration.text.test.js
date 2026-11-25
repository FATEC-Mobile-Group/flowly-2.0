// Moderacao textual do chat: frases sinteticas, sem rede e sem dados reais.
const { moderateText, classifyText, MAX_TEXT_LENGTH } = require('../services/nlpModerationService');

const LEGITIMATE = [
  // Exemplos da auditoria que antes eram bloqueados por engano.
  'Precisamos levar o lixo eletrônico para o descarte',
  'Vou matar essa pendência ainda hoje',
  'Configurem o filtro de spam do e-mail da equipe',
  'Para baixar o relatório, clique aqui no link do drive',
  'Mapeamos a ameaça de segurança no relatório de riscos',
  'O tema do TCC é prevenção da violência escolar',
  'Que burro eu fui, esqueci de anexar o PDF',
  // Outras frases comuns de equipe com palavras ambiguas.
  'Leve seu lixo para a lixeira da copa',
  'Seu lixo eletrônico foi recolhido ontem',
  'A disputa pelo cliente está acirrada, cuidado com a reputação',
  'O computador da sala 3 não liga',
  'Essa piada vai te matar de rir',
  'Você vai morrer de rir com esse bug',
  'O prazo apertado vai te matar, descansa um pouco',
  'Você não é burro, só estava cansado',
  'Vou bater a meta da sprint',
  'Você vai apanhar um pouco do React no começo',
  'O relatório 1.2.3 está pronto, versão v2 no drive',
  'Matar o processo travado resolveu o deploy',
  'Antas são mamíferos da América do Sul',
  'Reunião às 14h, tragam o notebook',
  '😀 bom dia equipe!',
];

// Mensagens que o usuario homologou como permitidas em producao.
const HOMOLOGATED_ALLOWED = [
  'Olá, tudo bem?',
  'Esse projeto está ficando muito bom.',
  'O documento acumula informações importantes.',
  'Precisamos executar essa tarefa.',
  'Vamos discutir o assunto amanhã.',
];

// Criticas profissionais e palavras ambiguas sem ataque pessoal.
const PROFESSIONAL = [
  'O burro é um animal doméstico.',
  'Precisamos descartar o lixo eletrônico.',
  'Vou matar essa pendência hoje.',
  'Você não é burro, só estava cansado.',
  'Que burro eu fui, esqueci de anexar o PDF.',
  'O relatório apresenta uma falha técnica.',
  'Precisamos melhorar a qualidade desse trabalho.',
  'O tema do seu trabalho é lixo eletrônico',
  'Seu trabalho não é um lixo, só precisa de revisão',
  'Burro!',
  'Ferrar o cavalo exige cuidado',
  'Ele foi muito bem na apresentação',
];

// Assuntos academicos e sensiveis: a mencao nunca bloqueia.
const ACADEMIC = [
  'sex',
  'O tema do nosso TCC é educação sexual.',
  'Pesquisa sobre sexo, sexualidade, orientação sexual e identidade de gênero',
  'Precisamos estudar a ascensão do nazismo.',
  'Vamos pesquisar sobre racismo estrutural.',
  'Hitler foi um ditador.',
  'Precisamos combater o nazismo.',
  'Nosso trabalho aborda a prevenção do suicídio.',
  'Vamos discutir a violência escolar.',
  'A pesquisa aborda políticas de combate às drogas.',
  'Precisamos estudar os impactos da discriminação religiosa.',
  'Os nazistas queriam exterminar os judeus',
  'Os negros são vítimas do racismo estrutural',
  'Mulheres são maioria na turma',
];

// Negacao, condenacao e citacao atribuida de construcoes de odio.
const HATE_FRAMED = [
  'Não apoio o nazismo',
  'Hitler não estava certo',
  'Dizer que negros são inferiores é racismo',
  'O mito de que judeus são ratos foi propaganda nazista',
  'Os nazistas gritavam "Heil Hitler" nos comícios',
  'Nem todos os imigrantes são criminosos',
  'Os salários de mulheres são inferiores aos dos homens',
  'Negar que o holocausto aconteceu é crime',
  'Gays não merecem morrer',
  'salve galera kkk',
];

const INSULTS = [
  'você é um idiota',
  'IDIOTA',
  'voce e um 1diota',
  'voce e um i d i o t a',
  'você é i d i o t a',
  'voce e um idiotaaa',
  'seu b.u.r.r.o',
  'seu burro',
  'cala a boca, seu inútil',
  'para de errar seu burro',
  'você é muito burro',
  'vc eh uma anta',
  'ela é uma incompetente completa',
  'seu imbecil',
  'fdp',
  'otário',
  ['i', 'd', 'i', 'o', 't', 'a'].join(String.fromCharCode(0x200b)),
  'Ｉｄｉｏｔａ',
  // Casos da politica de 2026-11.
  'Idiota',
  'Você é burro.',
  'Seu burro!',
  'Você é um idiota.',
  'Você é muito incompetente.',
  'Seu trabalho é um lixo.',
  'O código dele ficou um lixo',
  'Você é um macaco',
];

const PROFANITY = [
  'vai tomar no cu',
  'porra, de novo isso',
  'filho da puta',
  'vai se f0der',
  'foda-se',
  // Homologados em producao.
  'Porra',
  'Caralho',
  'Vai tomar no cu',
  // Politica de 2026-11: merda e bosta passaram a palavrao explicito em qualquer posicao. Antes, "Que merda, o
  // build quebrou de novo" era aceita e "voce e uma merda" contava como insulto dirigido.
  'Merda',
  'MERDA',
  'Que merda!',
  'Que merda, o build quebrou de novo',
  'voce e uma merda',
  'Seu trabalho está uma merda.',
  'Bosta!',
  'que bostaaa',
  'm.e.r.d.a',
  // Flexoes da lista fechada e expressoes.
  'caralhinho',
  'merdinha',
  'vai à merda',
  'Vai se ferrar',
  'vai se fuder',
  'Essa entrega está foda',
];

const THREATS = [
  'vou te matar',
  'vou te mat4r',
  'eu te mato',
  'te espanco amanhã',
  'vou matar você',
  'você vai morrer',
  'sei onde você mora',
  'te pego lá fora',
  'vou te matar de porrada',
];

const HATE = [
  'Morte aos judeus',
  'Heil Hitler',
  'Viva o nazismo!',
  'Hitler estava certo',
  'Judeus são ratos',
  'Todos os imigrantes são bandidos',
  'Gays merecem morrer',
  'Odeio nordestinos',
  'Eu acho que negros são inferiores',
  'Sou nazista',
  'O holocausto nunca aconteceu',
  'Vamos expulsar os imigrantes',
  'Mulheres são inferiores aos homens',
  'jud3us são vermes',
  // Citacao sem atribuicao continua bloqueada: "concordo" nao diz de quem e a fala.
  'Eu concordo: "morte aos judeus"',
  // Limitacao conservadora: a condenacao em outra frase nao e vista pela regra, que avalia frase a frase.
  'Negros são inferiores? Isso é racismo',
];

// Coincidencias de palavras que nao podem bloquear (nada de busca por pedaco de palavra).
const NO_SUBSTRING = [
  'computador', 'computação', 'disputa', 'Repúdio ao fascismo', 'caramelo', 'escorregador',
  'O bostoniano chegou', 'Merdeka é uma palavra malaia', 'Fodor publicou um artigo', 'Puteaux fica na França',
];

describe('moderateText', () => {
  test.each([...LEGITIMATE, ...HOMOLOGATED_ALLOWED, ...PROFESSIONAL, ...ACADEMIC, ...HATE_FRAMED, ...NO_SUBSTRING])(
    'aceita mensagem legítima: %s',
    (text) => {
      expect(moderateText(text)).toEqual({ allowed: true, reason: '', score: 0.02 });
    },
  );

  test.each(INSULTS)('bloqueia insulto direto: %s', (text) => {
    expect(moderateText(text)).toMatchObject({ allowed: false, reason: 'unsafe_content', category: 'insult' });
  });

  test.each(PROFANITY)('bloqueia palavrão explícito: %s', (text) => {
    expect(moderateText(text)).toMatchObject({ allowed: false, reason: 'unsafe_content', category: 'profanity' });
  });

  test.each(THREATS)('bloqueia ameaça explícita: %s', (text) => {
    expect(moderateText(text)).toMatchObject({ allowed: false, reason: 'unsafe_content', category: 'threat' });
  });

  test.each(HATE)('bloqueia discurso de ódio ou discriminação explícito: %s', (text) => {
    expect(moderateText(text)).toMatchObject({ allowed: false, reason: 'unsafe_content', category: 'hate' });
  });

  test('a categoria é a mais grave da mensagem', () => {
    expect(moderateText('porra, vou te matar').category).toBe('threat');
    expect(moderateText('que merda, seu idiota').category).toBe('insult');
    expect(moderateText('caralho. Morte aos judeus').category).toBe('hate');
  });

  test.each(['', '   ', '\n\t', null, undefined])('texto vazio é recusado: %p', (text) => {
    expect(moderateText(text)).toEqual({ allowed: false, reason: 'empty_content', score: 1 });
  });

  test('mantém o limite de 4000 caracteres', () => {
    expect(MAX_TEXT_LENGTH).toBe(4000);
    expect(moderateText('a'.repeat(4000)).allowed).toBe(true);
    expect(moderateText('a'.repeat(4001))).toEqual({ allowed: false, reason: 'possible_spam', score: 0.8 });
  });

  test('mantém o contrato público: allowed, reason e score', () => {
    const blocked = moderateText('seu idiota');
    expect(Object.keys(blocked).sort()).toEqual(['allowed', 'category', 'reason', 'score']);
    expect(typeof blocked.score).toBe('number');
  });

  test('textos longos legítimos são avaliados rápido', () => {
    const text = 'Atualizei o quadro da sprint e revisei as tarefas pendentes. '.repeat(60).slice(0, 4000);
    const started = Date.now();
    expect(moderateText(text).allowed).toBe(true);
    expect(Date.now() - started).toBeLessThan(200);
  });

  test('entradas adversariais no limite de tamanho não travam as expressões', () => {
    const adversarial = [
      'os '.repeat(1333),
      'nao '.repeat(1000),
      `${'todos os judeus '.repeat(249)}sao`.slice(0, 4000),
      '"'.repeat(4000),
      'a.'.repeat(2000),
      'i '.repeat(2000),
    ];
    const started = Date.now();
    adversarial.forEach((text) => moderateText(text));
    expect(Date.now() - started).toBeLessThan(500);
  });
});

describe('classifyText (criterio compartilhado com os insights)', () => {
  test('mesma categoria da moderação; vazio e longo não são categorias ofensivas', () => {
    expect(classifyText('o burro é um animal')).toBeNull();
    expect(classifyText('lixo eletrônico')).toBeNull();
    expect(classifyText('que merda')).toBe('profanity');
    expect(classifyText('você é um idiota')).toBe('insult');
    expect(classifyText('')).toBeNull();
    expect(classifyText(null)).toBeNull();
  });
});
