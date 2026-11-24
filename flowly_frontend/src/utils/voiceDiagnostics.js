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

// Etapas medidas (inicio -> fim). As do PR #54 continuam com o mesmo nome, para comparar:
//   microfone-pronto: toque na estrela -> captura pronta (soma das tres seguintes)
//     clique-ate-start: toque -> chamada de recognition.start() (trabalho da pagina)
//     start-ate-onstart: recognition.start() -> evento onstart (navegador)
//     onstart-ate-audio: onstart -> onaudiostart (navegador abrindo o microfone e o servico de fala). Aproximacao:
//       sem onaudiostart (outros navegadores), a captura conta como pronta no onstart, no onsoundstart ou no
//       primeiro resultado
//   ultimo-resultado-ate-final: ultimo resultado do navegador -> frase final pronta para envio (inclui a pausa de
//     2 s que conclui a fala e o tempo do navegador para encerrar)
//   fala-encerrada-ate-final: onspeechend -> frase final (so quando o navegador dispara onspeechend, o que nem
//     sempre acontece no modo continuo)
//   stop-ate-final: pedido de conclusao (stop) -> fim da sessao com a frase final
//   envio: frase final -> pedido enviado (trabalho da pagina; perto de zero, nao e o tempo desde a ultima palavra)
//   resposta: pedido enviado -> resposta recebida (rede + assistente)
//   inicio-da-voz: resposta recebida -> voz do assistente comecou
//   retomada: voz terminou (ou resposta sem voz) -> captura pronta de novo (soma das duas seguintes)
//     espera-da-retomada: voz terminou -> nova escuta pedida (intervalo de seguranca de 400 ms)
//     retomada-ate-pronto: nova escuta pedida -> captura pronta (navegador, como start/onstart/onaudiostart)
//   O "fim da voz" e o evento onend; sem ele (Chrome), e detectado por consulta a cada 0,5 s (ate 0,5 s depois).
export function createVoiceTrace(log = (...args) => console.info(...args)) {
  const marks = {};
  return {
    mark(name) {
      marks[name] = now();
    },
    // keep: a marca continua valendo para outra etapa que parte do mesmo ponto.
    measure(step, fromMark, { keep = false } = {}) {
      const start = marks[fromMark];
      if (start === undefined) return null;
      const ms = Math.round(now() - start);
      if (!keep) delete marks[fromMark];
      if (debugEnabled()) log('[flowly:voz]', step, `${ms} ms`);
      return ms;
    },
    // Sem nomes: apaga todas as marcas.
    clear(names) {
      (names || Object.keys(marks)).forEach((key) => delete marks[key]);
    },
  };
}
