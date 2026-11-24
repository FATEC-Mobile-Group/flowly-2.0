// Escolha da voz de resposta (speechSynthesis): portugues do Brasil quando o navegador tiver uma.
// Sem voz definida, alguns navegadores usam a voz padrao do sistema (as vezes em ingles) mesmo com lang pt-BR,
// e a pronuncia fica estranha. A escolha e deterministica: a mesma lista de vozes da sempre a mesma voz.

export const normalizeLang = (lang) => String(lang || '').trim().replace(/_/g, '-').toLowerCase();

// Vozes de melhor qualidade costumam trazer estes termos no nome (Edge: "Natural"/"Online"; Chrome: "Google").
const QUALITY_HINTS = [/natural/i, /neural/i, /online/i, /google/i];

const qualityRank = (voice) => {
  const name = String(voice?.name || '');
  const index = QUALITY_HINTS.findIndex((pattern) => pattern.test(name));
  return index === -1 ? QUALITY_HINTS.length : index;
};

const compareVoices = (a, b) => {
  const byQuality = qualityRank(a) - qualityRank(b);
  if (byQuality) return byQuality;
  // Empate: a voz padrao do sistema primeiro, depois ordem alfabetica do nome (sem depender da ordem da lista).
  if (Boolean(a.default) !== Boolean(b.default)) return a.default ? -1 : 1;
  return String(a.name || '').localeCompare(String(b.name || ''));
};

// { voice, kind }: kind 'pt-BR' (voz brasileira), 'pt' (outra variante do portugues) ou 'none' (nenhuma voz em
// portugues: a voz fica a cargo do navegador, com utterance.lang = 'pt-BR').
export function pickPortugueseVoice(voices) {
  const list = Array.isArray(voices) ? voices.filter((voice) => voice && typeof voice === 'object') : [];
  const brazilian = list.filter((voice) => normalizeLang(voice.lang) === 'pt-br');
  if (brazilian.length) return { voice: [...brazilian].sort(compareVoices)[0], kind: 'pt-BR' };
  const portuguese = list.filter((voice) => /^pt(-|$)/.test(normalizeLang(voice.lang)));
  if (portuguese.length) return { voice: [...portuguese].sort(compareVoices)[0], kind: 'pt' };
  return { voice: null, kind: 'none' };
}
