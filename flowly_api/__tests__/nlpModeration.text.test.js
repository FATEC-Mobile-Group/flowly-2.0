// Moderacao textual do chat: frases sinteticas, sem rede e sem dados reais.
const { moderateText, MAX_TEXT_LENGTH } = require('../services/nlpModerationService');

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
  'Que merda, o build quebrou de novo',
  'Você não é burro, só estava cansado',
  'Vou bater a meta da sprint',
  'Você vai apanhar um pouco do React no começo',
  'O relatório 1.2.3 está pronto, versão v2 no drive',
  'Matar o processo travado resolveu o deploy',
  'Antas são mamíferos da América do Sul',
  'Reunião às 14h, tragam o notebook',
  '😀 bom dia equipe!',
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
  'voce e uma merda',
  'seu imbecil',
  'fdp',
  'otário',
  ['i', 'd', 'i', 'o', 't', 'a'].join(String.fromCharCode(0x200b)),
  'Ｉｄｉｏｔａ',
];

const PROFANITY = ['vai tomar no cu', 'porra, de novo isso', 'filho da puta', 'vai se f0der', 'foda-se'];

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

describe('moderateText', () => {
  test.each(LEGITIMATE)('aceita mensagem legítima: %s', (text) => {
    expect(moderateText(text)).toEqual({ allowed: true, reason: '', score: 0.02 });
  });

  test.each(INSULTS)('bloqueia insulto direto: %s', (text) => {
    expect(moderateText(text)).toMatchObject({ allowed: false, reason: 'unsafe_content', category: 'insult' });
  });

  test.each(PROFANITY)('bloqueia palavrão explícito: %s', (text) => {
    expect(moderateText(text)).toMatchObject({ allowed: false, reason: 'unsafe_content', category: 'profanity' });
  });

  test.each(THREATS)('bloqueia ameaça explícita: %s', (text) => {
    expect(moderateText(text)).toMatchObject({ allowed: false, reason: 'unsafe_content', category: 'threat' });
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
});
