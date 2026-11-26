// Voz do assistente (PR #69). Duas opcoes, escolhidas na Central de preferencias:
//   original: o comportamento anterior (pickPortugueseVoice: melhor voz pt-BR do navegador, rate 1);
//   tecnologica: Microsoft Daniel (pt-BR), grave, aprovada em teste real no Chrome: pitch 0.75, rate 1.05, volume 1.
// A voz tecnologica e encontrada pela identidade (nome/voiceURI), nunca pela posicao na lista. Sem ela no
// navegador, vale a original. Nunca escolhe uma voz que nao seja pt-BR para a opcao tecnologica.
import { normalizeLang, pickPortugueseVoice } from './voiceSelection';

export const VOZ_TECNOLOGICA = Object.freeze({
  nome: 'Microsoft Daniel - Portuguese (Brazil)',
  pitch: 0.75,
  rate: 1.05,
  volume: 1,
});
export const RATE_ORIGINAL = 1;
export const FRASE_DE_PREVIA = 'Olá! Eu sou o assistente do Flowly. Como posso ajudar você hoje?';

const ehBrasileira = (voice) => normalizeLang(voice?.lang) === 'pt-br';
const temIdentidade = (voice) => voice?.name === VOZ_TECNOLOGICA.nome || voice?.voiceURI === VOZ_TECNOLOGICA.nome;

// Prioridade: identidade exata e local; identidade exata; outra variante do Daniel em pt-BR (ex.: Edge).
export function encontrarVozTecnologica(voices) {
  const lista = Array.isArray(voices) ? voices.filter((voice) => voice && typeof voice === 'object' && ehBrasileira(voice)) : [];
  return lista.find((voice) => temIdentidade(voice) && voice.localService !== false)
    || lista.find(temIdentidade)
    || lista.find((voice) => /\bdaniel\b/i.test(String(voice.name || '')))
    || null;
}

// { perfil, voice, kind, rate, pitch, volume, tecnologicaIndisponivel }. pitch/volume null: padrao do navegador
// (como era antes na voz original).
export function escolherVozDoAssistente(voices, preferencia = 'tecnologica') {
  if (preferencia !== 'original') {
    const daniel = encontrarVozTecnologica(voices);
    if (daniel) {
      return {
        perfil: 'tecnologica',
        voice: daniel,
        kind: 'pt-BR',
        rate: VOZ_TECNOLOGICA.rate,
        pitch: VOZ_TECNOLOGICA.pitch,
        volume: VOZ_TECNOLOGICA.volume,
        tecnologicaIndisponivel: false,
      };
    }
  }
  const { voice, kind } = pickPortugueseVoice(voices);
  return {
    perfil: 'original',
    voice,
    kind,
    rate: RATE_ORIGINAL,
    pitch: null,
    volume: null,
    tecnologicaIndisponivel: preferencia !== 'original',
  };
}

// Aplica a escolha na fala (lang continua pt-BR mesmo sem voz definida).
export function aplicarVoz(utterance, escolha) {
  if (escolha?.voice) utterance.voice = escolha.voice;
  utterance.rate = escolha?.rate ?? RATE_ORIGINAL;
  if (escolha?.pitch != null) utterance.pitch = escolha.pitch;
  if (escolha?.volume != null) utterance.volume = escolha.volume;
  return utterance;
}

// A voz guardada so vale se ainda estiver na lista atual do navegador (voiceschanged troca os objetos).
export const vozAindaDisponivel = (escolha, voices) => !escolha?.voice
  || (Array.isArray(voices) && voices.includes(escolha.voice));
