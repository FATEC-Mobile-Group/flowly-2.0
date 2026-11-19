import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FaPaperPlane, FaPowerOff, FaVolumeUp } from 'react-icons/fa';
import Sidebar from '../../components/layout/Sidebar';
import { API_ENDPOINTS } from '../../config/config';
import { authUtils } from '../../config/authUtils';
import '../../styles/pages/common/VoiceAssistantPage.css';

const SpeechRecognition =
  window.SpeechRecognition || window.webkitSpeechRecognition || null;

const initialMessages = [
  {
    id: 'welcome',
    role: 'assistant',
    text: 'Assistente em standby. Toque no microfone e diga um comando.',
  },
];

// Estados da conversa em que o assistente fez uma pergunta e espera a proxima fala.
const AWAITING_CONVERSATION = new Set([
  'awaiting_params',
  'awaiting_task_selection',
  'awaiting_task_action',
  'browsing_tasks',
]);
const STATUS_LABELS = {
  starting: 'Iniciando',
  listening: 'Ouvindo',
  processing: 'Processando',
  speaking: 'Falando',
  awaiting: 'Aguardando resposta',
  standby: 'Standby',
};
// Depois de Concluir (stop), o navegador deveria encerrar logo; sem onend, a sessao e fechada assim mesmo.
const FINISH_TIMEOUT_MS = 4000;
// Falhas seguidas antes de sugerir outro caminho (sem novas tentativas automaticas).
const FAILURE_HINT_AFTER = 3;

// Mensagens por erro do reconhecimento nativo (Web Speech API).
function recognitionErrorMessage(error) {
  switch (error) {
    case 'no-speech':
      return 'Não ouvi nenhuma fala. Toque no microfone, espere aparecer "Ouvindo" e fale perto do microfone.';
    case 'audio-capture':
      return 'Não encontrei um microfone funcionando. Confira se ele está conectado e escolhido no navegador.';
    case 'not-allowed':
      return 'O microfone está bloqueado para este site. Libere o acesso nas permissões do navegador e tente de novo.';
    case 'service-not-allowed':
      return 'Este navegador não permite o reconhecimento de voz neste site. Use o Chrome ou digite o comando.';
    case 'network':
      return typeof navigator !== 'undefined' && navigator.brave
        ? 'O Brave não oferece o reconhecimento de voz usado pelo assistente. Use o Chrome ou digite o comando.'
        : 'O serviço de reconhecimento de voz do navegador não respondeu. Confira a conexão e tente de novo, ou digite o comando.';
    case 'language-not-supported':
      return 'O navegador não reconhece fala em português neste dispositivo. Digite o comando.';
    case 'aborted':
      return 'A escuta foi interrompida pelo navegador. Toque no microfone para tentar de novo.';
    case 'start-failed':
      return 'Não consegui ligar o microfone agora. Tente de novo em instantes ou digite o comando.';
    default:
      return 'Não consegui ouvir agora. Tente novamente ou digite o comando.';
  }
}

const GeminiStar = ({ status, listening }) => {
  let gradientId = 'gradientStandby';
  if (listening) {
    gradientId = 'gradientListening';
  } else if (status === 'processing') {
    gradientId = 'gradientProcessing';
  }

  return (
    <svg viewBox="0 0 24 24" className="voice-star-svg" aria-hidden="true">
      <defs>
        <linearGradient id="gradientStandby" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#6366F1" />
          <stop offset="50%" stopColor="#A855F7" />
          <stop offset="100%" stopColor="#EC4899" />
        </linearGradient>

        <linearGradient id="gradientListening" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#06B6D4" />
          <stop offset="50%" stopColor="#10B981" />
          <stop offset="100%" stopColor="#34D399" />
        </linearGradient>

        <linearGradient id="gradientProcessing" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#FBBF24" />
          <stop offset="50%" stopColor="#F97316" />
          <stop offset="100%" stopColor="#EF4444" />
        </linearGradient>

        <linearGradient id="gradientRainbow" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#ff007f" />
          <stop offset="20%" stopColor="#7f00ff" />
          <stop offset="40%" stopColor="#007fff" />
          <stop offset="60%" stopColor="#00ff7f" />
          <stop offset="80%" stopColor="#ffbf00" />
          <stop offset="100%" stopColor="#ff007f" />
        </linearGradient>
      </defs>
      <path
        className="star-path-base"
        d="M12 0 Q12 12 24 12 Q12 12 12 24 Q12 12 0 12 Q12 12 12 0"
        fill={`url(#${gradientId})`}
      />
      <path
        className="star-path-hover"
        d="M12 0 Q12 12 24 12 Q12 12 12 24 Q12 12 0 12 Q12 12 12 0"
        fill="url(#gradientRainbow)"
      />
    </svg>
  );
};

function VoiceAssistantPage() {
  const [messages, setMessages] = useState(initialMessages);
  const [draft, setDraft] = useState('');
  // Microfone: idle, starting (start pedido), listening (onstart) ou finishing (Concluir, aguardando o final).
  const [mic, setMic] = useState('idle');
  const [processing, setProcessing] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [awaitingReply, setAwaitingReply] = useState(false);
  // Texto ouvido sem confirmacao do navegador, posto no campo para a pessoa conferir antes de enviar.
  const [recoveredText, setRecoveredText] = useState('');
  const [rainbowActive, setRainbowActive] = useState(false);
  // Sessao de reconhecimento atual. Eventos de sessoes encerradas, canceladas ou substituidas sao ignorados.
  const sessionRef = useRef(null);
  // Um comando por vez. Ref (e nao estado) para nao depender de closures com valor antigo.
  const sendingRef = useRef(false);
  // Pedido em andamento; muted quando a pessoa entra em standby antes da resposta.
  const requestRef = useRef(null);
  // Fala atual do assistente: eventos de falas antigas ou canceladas nao mudam o estado.
  const utteranceRef = useRef(null);
  const failuresRef = useRef(0);
  // Texto do campo e sua origem: 'typed' (digitado ou recuperado) ou 'voice' (transcricao da sessao em andamento).
  const draftRef = useRef({ text: '', source: 'typed' });
  const messagesEndRef = useRef(null);
  const conversationIdRef = useRef(`voice-${authUtils.getUserId() || 'guest'}-${Date.now()}`);

  const supported = useMemo(() => Boolean(SpeechRecognition), []);
  const listening = mic === 'listening';
  let status = 'standby';
  if (listening) status = 'listening';
  else if (mic === 'starting') status = 'starting';
  else if (processing || mic === 'finishing') status = 'processing';
  else if (speaking) status = 'speaking';
  else if (awaitingReply) status = 'awaiting';

  const addMessage = useCallback((role, text, meta = {}) => {
    const cleanText = String(text || '').trim();
    if (!cleanText) return;
    setMessages((current) => [
      ...current,
      {
        id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
        role,
        text: cleanText,
        ...meta,
      },
    ]);
  }, []);

  const stopSpeaking = useCallback(() => {
    utteranceRef.current = null;
    setSpeaking(false);
    if (window.speechSynthesis) window.speechSynthesis.cancel();
  }, []);

  const speak = useCallback((payload) => {
    // tts.enabled false (contrato do assistente): a resposta so aparece na tela.
    if (payload?.tts?.enabled === false) return;
    const text = payload?.tts?.text || payload?.reply_text || '';
    if (!text || !window.speechSynthesis) return;

    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = payload?.tts?.language || 'pt-BR';
    utterance.rate = 1;
    utteranceRef.current = utterance;
    const finished = () => {
      if (utteranceRef.current !== utterance) return;
      utteranceRef.current = null;
      setSpeaking(false);
    };
    utterance.onstart = () => {
      if (utteranceRef.current === utterance) setSpeaking(true);
    };
    utterance.onend = finished;
    utterance.onerror = finished;
    window.speechSynthesis.speak(utterance);
  }, []);

  const updateDraft = useCallback((text, source = 'typed') => {
    draftRef.current = { text, source };
    setDraft(text);
  }, []);

  // Encerra a sessao: os handlers sao desligados e eventos tardios do navegador nao chegam mais aqui.
  // abort descarta o audio captado; stop (Concluir) pede ao navegador o resultado final do que ja ouviu.
  const releaseSession = useCallback((session, { abort = false } = {}) => {
    if (!session || session.closed) return;
    session.closed = true;
    clearTimeout(session.finishTimer);
    if (sessionRef.current === session) sessionRef.current = null;

    const { recognition } = session;
    recognition.onstart = null;
    recognition.onspeechstart = null;
    recognition.onresult = null;
    recognition.onerror = null;
    recognition.onend = null;
    if (abort) {
      try {
        if (typeof recognition.abort === 'function') recognition.abort();
        else recognition.stop();
      } catch (error) {
        // O navegador pode ja ter encerrado a sessao.
      }
    }

    // A transcricao sai do campo e o texto digitado antes da escuta volta.
    if (draftRef.current.source === 'voice') updateDraft(session.typedDraft);
    setMic('idle');
  }, [updateDraft]);

  const enterStandby = useCallback(async ({ silent = false, keepSpeech = false } = {}) => {
    releaseSession(sessionRef.current, { abort: true });
    setAwaitingReply(false);
    // Comando ja enviado nao volta atras: a resposta ainda aparece na tela, mas nao e falada.
    if (requestRef.current) requestRef.current.muted = true;
    if (!keepSpeech) stopSpeaking();

    try {
      await fetch(API_ENDPOINTS.ASSISTANT_STANDBY, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${authUtils.getToken()}`,
        },
        body: JSON.stringify({ conversationId: conversationIdRef.current }),
      });
    } catch (error) {
      if (!silent) {
        addMessage('assistant', 'Não consegui avisar o standby, mas parei a escuta local.');
      }
    }
  }, [addMessage, releaseSession, stopSpeaking]);

  const sendUtterance = useCallback(async (utterance, { nextDraft = '' } = {}) => {
    const cleanUtterance = String(utterance || '').trim();
    if (!cleanUtterance || sendingRef.current) return;
    sendingRef.current = true;
    const request = { muted: false };
    requestRef.current = request;

    addMessage('user', cleanUtterance);
    updateDraft(nextDraft);
    setProcessing(true);
    setAwaitingReply(false);

    try {
      const response = await fetch(API_ENDPOINTS.ASSISTANT_COMMAND, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${authUtils.getToken()}`,
        },
        body: JSON.stringify({
          userId: authUtils.getUserId(),
          channelId: 'voice-assistant',
          conversationId: conversationIdRef.current,
          content: cleanUtterance,
        }),
      });

      const payload = await response.json();
      const reply = payload.reply_text || payload.message || 'Resposta recebida.';
      addMessage('assistant', reply, { error: !payload.ok });
      if (request.muted) return;

      if (payload?.command?.key === 'exit') {
        speak(payload);
        // A despedida e falada ate o fim; o standby nao corta a propria resposta.
        await enterStandby({ silent: true, keepSpeech: true });
        return;
      }
      setAwaitingReply(AWAITING_CONVERSATION.has(payload?.conversation?.status));
      speak(payload);
    } catch (error) {
      addMessage('assistant', 'Não consegui falar com a API do assistente.', { error: true });
    } finally {
      if (requestRef.current === request) requestRef.current = null;
      sendingRef.current = false;
      setProcessing(false);
    }
  }, [addMessage, enterStandby, speak, updateDraft]);

  // Fim da sessao (onend, erro ou prazo do Concluir): envia so o resultado final; o resto e recuperavel.
  const concludeSession = useCallback((session, { error = null, abort = false } = {}) => {
    const { finalText, interimText, typedDraft, speechDetected } = session;
    releaseSession(session, { abort });

    // Tudo o que o navegador entregou e final: e o comando, mesmo que um erro chegue depois dele.
    if (finalText && !interimText) {
      failuresRef.current = 0;
      sendUtterance(finalText, { nextDraft: typedDraft });
      return;
    }

    failuresRef.current += 1;
    const heard = [finalText, interimText].filter(Boolean).join(' ');
    if (heard) {
      // Nada e enviado. O texto ouvido fica no campo para a pessoa conferir, corrigir e enviar se quiser.
      if (typedDraft) {
        addMessage('assistant', `Ouvi “${heard}”, mas o navegador não confirmou a frase e ela pode estar incompleta. Nada foi enviado; o texto que você digitou continua no campo.`, { error: true });
      } else {
        updateDraft(heard, 'typed');
        setRecoveredText(heard);
        addMessage('assistant', `Ouvi “${heard}”, mas o navegador não confirmou a frase e ela pode estar incompleta. Nada foi enviado. Confira e corrija o texto no campo; só toque em Enviar se estiver certo, ou fale de novo.`, { error: true });
      }
    } else if (error) {
      addMessage('assistant', recognitionErrorMessage(error), { error: true });
    } else if (speechDetected) {
      addMessage('assistant', 'Ouvi sua voz, mas o navegador não conseguiu transcrever. Fale de novo, perto do microfone, ou digite o comando.', { error: true });
    } else {
      addMessage('assistant', recognitionErrorMessage('no-speech'), { error: true });
    }

    if (failuresRef.current === FAILURE_HINT_AFTER) {
      addMessage(
        'assistant',
        'O reconhecimento de voz falhou 3 vezes seguidas. Fale logo depois de aparecer "Ouvindo", perto do microfone e sem a voz do assistente tocando, ou digite o comando.',
        { error: true },
      );
    }
  }, [addMessage, releaseSession, sendUtterance, updateDraft]);

  const startListening = useCallback(() => {
    // Uma sessao por vez, e nenhuma enquanto um comando esta sendo processado.
    if (!supported || sessionRef.current || sendingRef.current) return;
    // A voz do assistente nao pode ser captada como se fosse a fala da pessoa.
    stopSpeaking();

    const session = {
      recognition: null,
      closed: false,
      finishTimer: null,
      finalText: '',
      interimText: '',
      speechDetected: false,
      typedDraft: draftRef.current.source === 'typed' ? draftRef.current.text : '',
    };
    const isCurrent = () => sessionRef.current === session && !session.closed;

    let recognition;
    try {
      recognition = new SpeechRecognition();
    } catch (error) {
      failuresRef.current += 1;
      addMessage('assistant', recognitionErrorMessage('start-failed'), { error: true });
      return;
    }
    recognition.lang = 'pt-BR';
    recognition.continuous = false;
    recognition.interimResults = true;
    session.recognition = recognition;
    sessionRef.current = session;

    recognition.onstart = () => {
      if (isCurrent() && !session.finishing) setMic('listening');
    };

    recognition.onspeechstart = () => {
      if (isCurrent()) session.speechDetected = true;
    };

    recognition.onresult = (event) => {
      if (!isCurrent()) return;
      // A lista de resultados e cumulativa: refazer o texto a cada evento evita repetir ou perder trechos.
      const finals = [];
      const interims = [];
      for (let i = 0; i < event.results.length; i += 1) {
        const result = event.results[i];
        const transcript = String(result?.[0]?.transcript || '').trim();
        if (transcript) (result.isFinal ? finals : interims).push(transcript);
      }
      session.finalText = finals.join(' ');
      session.interimText = interims.join(' ');
      session.speechDetected = true;
      const shown = [...finals, ...interims].join(' ');
      if (shown) updateDraft(shown, 'voice');
    };

    recognition.onerror = (event) => {
      if (isCurrent()) concludeSession(session, { error: event?.error || 'unknown' });
    };

    recognition.onend = () => {
      if (isCurrent()) concludeSession(session);
    };

    setMic('starting');
    try {
      recognition.start();
    } catch (error) {
      concludeSession(session, { error: 'start-failed' });
    }
  }, [addMessage, concludeSession, stopSpeaking, supported, updateDraft]);

  // Concluir (clique no microfone durante a escuta): o navegador entrega o resultado final do que ouviu.
  // Diferente de cancelar (Standby, sair da pagina, digitar), que descarta a captura com abort.
  const finishListening = useCallback(() => {
    const session = sessionRef.current;
    if (!session || session.finishing) return;
    session.finishing = true;
    setMic('finishing');
    try {
      session.recognition.stop();
    } catch (error) {
      concludeSession(session, { abort: true });
      return;
    }
    session.finishTimer = setTimeout(() => {
      if (sessionRef.current === session && !session.closed) concludeSession(session, { abort: true });
    }, FINISH_TIMEOUT_MS);
  }, [concludeSession]);

  const toggleListening = () => {
    setRainbowActive(true);
    setTimeout(() => {
      setRainbowActive(false);
    }, 1200);

    if (mic === 'listening') {
      finishListening();
      return;
    }
    // Iniciando ou concluindo: espera o navegador (o Standby cancela).
    if (mic !== 'idle') return;
    startListening();
  };

  const submitTypedCommand = (event) => {
    event.preventDefault();
    const { text, source } = draftRef.current;
    // Transcricao da sessao em andamento (provisoria ou final ainda sem onend) nunca sai pelo botao:
    // so o fim da sessao envia, e apenas o resultado final.
    if (source === 'voice' || !text.trim()) return;
    // Texto digitado (ou recuperado e conferido) enviado durante a escuta: a captura e descartada.
    releaseSession(sessionRef.current, { abort: true });
    sendUtterance(text);
  };

  const changeDraft = (event) => {
    // Digitar assume o comando: a captura em andamento e descartada e nao sobrescreve o texto.
    updateDraft(event.target.value, 'typed');
    releaseSession(sessionRef.current, { abort: true });
  };

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  useEffect(() => () => {
    enterStandby({ silent: true });
  }, [enterStandby]);

  let micLabel = 'Iniciar escuta';
  if (mic === 'listening') micLabel = 'Concluir fala';
  else if (mic === 'starting') micLabel = 'Iniciando escuta';
  else if (mic === 'finishing') micLabel = 'Concluindo fala';
  // Com captura ativa, o Standby descarta o que foi ouvido: o rotulo diz isso.
  const capturing = mic !== 'idle';
  const standbyLabel = capturing ? 'Cancelar escuta' : 'Standby';
  // Texto ainda igual ao recuperado (sem edicao nem envio): continua sem confirmacao do navegador.
  const unconfirmedDraft = !capturing && Boolean(recoveredText) && draft === recoveredText;
  // Orientacao visivel (mouse, teclado e toque) sobre concluir x cancelar e sobre o texto nao confirmado.
  let interactionHint = '';
  if (mic === 'starting') {
    interactionHint = 'Abrindo o microfone. "Cancelar escuta" descarta sem enviar.';
  } else if (mic === 'listening') {
    interactionHint = 'Toque de novo na estrela para concluir a fala e enviar o que o navegador confirmar. "Cancelar escuta" descarta sem enviar.';
  } else if (mic === 'finishing') {
    interactionHint = 'Aguardando o navegador confirmar a frase. "Cancelar escuta" descarta sem enviar.';
  } else if (unconfirmedDraft) {
    interactionHint = 'Texto não confirmado pelo navegador: pode estar incompleto. Confira e corrija antes de tocar em Enviar.';
  }
  const hintId = interactionHint ? 'voice-interaction-hint' : undefined;

  return (
    <div className="admin-page voice-assistant-page">
      <Sidebar />

      <main className="voice-assistant-shell">
        <section className="voice-assistant-header">
          <div>
            <p className="voice-assistant-kicker">Flowly Voice</p>
            <h1>Assistente de voz</h1>
          </div>
          <div className={`voice-status ${status}`}>
            <span />
            {STATUS_LABELS[status]}
          </div>
        </section>

        <section className="voice-chat-panel" aria-live="polite">
          <div className="voice-chat-messages">
            {messages.map((message) => (
              <article
                key={message.id}
                className={`voice-message ${message.role} ${message.error ? 'error' : ''}`}
              >
                <span className="voice-message-author">
                  {message.role === 'user' ? 'Você' : 'Assistente'}
                </span>
                <p>{message.text}</p>
              </article>
            ))}
            <div ref={messagesEndRef} />
          </div>

          <div className="voice-orb-zone">
            <button
              type="button"
              className={`voice-star-btn ${listening ? 'listening' : ''} ${status} ${rainbowActive ? 'rainbow-burst' : ''}`}
              onClick={toggleListening}
              disabled={!supported || processing}
              aria-label={micLabel}
              aria-describedby={capturing ? hintId : undefined}
              title={supported ? (capturing ? micLabel : 'Falar com o assistente') : 'Reconhecimento de voz indisponível'}
            >
              <span className={`rainbow-ripple ${rainbowActive ? 'active' : ''}`} />
              <GeminiStar status={status} listening={listening} />
            </button>
            {interactionHint && (
              <p id={hintId} className="voice-interaction-hint">{interactionHint}</p>
            )}
          </div>

          <form className="voice-command-form" onSubmit={submitTypedCommand}>
            <div className="voice-input-wrap">
              <FaVolumeUp />
              <input
                value={draft}
                onChange={changeDraft}
                placeholder={supported ? 'O texto reconhecido aparece aqui' : 'Digite um comando'}
                disabled={processing}
                aria-describedby={unconfirmedDraft ? hintId : undefined}
              />
            </div>
            <button type="submit" disabled={!draft.trim() || processing} title="Enviar comando">
              <FaPaperPlane />
            </button>
            <button
              type="button"
              onClick={() => enterStandby()}
              title={standbyLabel}
              aria-label={standbyLabel}
              aria-describedby={capturing ? hintId : undefined}
            >
              <FaPowerOff />
            </button>
          </form>
        </section>
      </main>
    </div>
  );
}

export default VoiceAssistantPage;
