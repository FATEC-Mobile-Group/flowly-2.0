// Diagnostico opcional de latencia da conversa por voz, so no console deste navegador e so quando ligado:
//   localStorage.setItem('flowly:voice-debug', '1')   (desligar: localStorage.removeItem('flowly:voice-debug'))
// Registra apenas o nome da etapa e os milissegundos. Nunca o texto falado, a resposta, tokens ou IDs.

export const VOICE_DEBUG_KEY = 'flowly:voice-debug';

const debugEnabled = () => {
  try {
    return window.localStorage.getItem(VOICE_DEBUG_KEY) === '1';
  } catch (error) {
    return false;
  }
};

const now = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now());

// Etapas medidas (inicio -> fim):
//   microfone-pronto: toque na estrela (ou retomada) -> audio chegando
//   envio: fala concluida -> pedido enviado
//   resposta: pedido enviado -> resposta recebida
//   inicio-da-voz: resposta recebida -> voz do assistente comecou
//   retomada: voz terminou (ou resposta sem voz) -> microfone pronto de novo
export function createVoiceTrace(log = (...args) => console.info(...args)) {
  const marks = {};
  return {
    mark(name) {
      marks[name] = now();
    },
    measure(step, fromMark) {
      const start = marks[fromMark];
      if (start === undefined) return null;
      const ms = Math.round(now() - start);
      delete marks[fromMark];
      if (debugEnabled()) log('[flowly:voz]', step, `${ms} ms`);
      return ms;
    },
    clear() {
      Object.keys(marks).forEach((key) => delete marks[key]);
    },
  };
}
