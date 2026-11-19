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
  const [listening, setListening] = useState(false);
  const [processing, setProcessing] = useState(false);
  const [status, setStatus] = useState('standby');
  const [rainbowActive, setRainbowActive] = useState(false);
  // Sessao de reconhecimento atual. Eventos de sessoes encerradas, canceladas ou substituidas sao ignorados.
  const sessionRef = useRef(null);
  // Um comando por vez. Ref (e nao estado) para nao depender de closures com valor antigo.
  const sendingRef = useRef(false);
  // Texto do campo e sua origem: 'typed' (digitado) ou 'voice' (transcricao da sessao em andamento).
  const draftRef = useRef({ text: '', source: 'typed' });
  const messagesEndRef = useRef(null);
  const conversationIdRef = useRef(`voice-${authUtils.getUserId() || 'guest'}-${Date.now()}`);

  const supported = useMemo(() => Boolean(SpeechRecognition), []);

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

  const speak = useCallback((payload) => {
    const text = payload?.tts?.text || payload?.reply_text || '';
    if (!text || !window.speechSynthesis) return;

    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = payload?.tts?.language || 'pt-BR';
    utterance.rate = 1;
    window.speechSynthesis.speak(utterance);
  }, []);

  const updateDraft = useCallback((text, source = 'typed') => {
    draftRef.current = { text, source };
    setDraft(text);
  }, []);

  // Encerra a sessao: os handlers sao desligados e eventos tardios do navegador nao chegam mais aqui.
  // abort descarta o audio captado (stop ainda entregaria um resultado e dispararia onend).
  const releaseSession = useCallback((session, { abort = false } = {}) => {
    if (!session || session.closed) return;
    session.closed = true;
    if (sessionRef.current === session) sessionRef.current = null;

    const { recognition } = session;
    recognition.onstart = null;
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
    setListening(false);
    setStatus('standby');
  }, [updateDraft]);

  const enterStandby = useCallback(async ({ silent = false } = {}) => {
    releaseSession(sessionRef.current, { abort: true });
    setListening(false);
    setProcessing(false);
    setStatus('standby');

    if (window.speechSynthesis) {
      window.speechSynthesis.cancel();
    }

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
  }, [addMessage, releaseSession]);

  const sendUtterance = useCallback(async (utterance, { nextDraft = '' } = {}) => {
    const cleanUtterance = String(utterance || '').trim();
    if (!cleanUtterance || sendingRef.current) return;
    sendingRef.current = true;

    addMessage('user', cleanUtterance);
    updateDraft(nextDraft);
    setProcessing(true);
    setStatus('processing');

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
      speak(payload);

      if (payload?.command?.key === 'exit') {
        await enterStandby({ silent: true });
        return;
      }
    } catch (error) {
      addMessage('assistant', 'Não consegui falar com a API do assistente.', { error: true });
    } finally {
      sendingRef.current = false;
      setProcessing(false);
      setStatus('standby');
    }
  }, [addMessage, enterStandby, speak, updateDraft]);

  const startListening = useCallback(() => {
    // Uma sessao por vez, e nenhuma enquanto um comando esta sendo processado.
    if (!supported || sessionRef.current || sendingRef.current) return;

    const session = {
      recognition: null,
      closed: false,
      finalText: '',
      typedDraft: draftRef.current.source === 'typed' ? draftRef.current.text : '',
    };
    const failToListen = () => {
      if (session.recognition) releaseSession(session);
      setListening(false);
      setStatus('standby');
      addMessage('assistant', 'Não consegui ouvir agora. Tente novamente ou digite o comando.', { error: true });
    };
    const isCurrent = () => sessionRef.current === session && !session.closed;

    let recognition;
    try {
      recognition = new SpeechRecognition();
    } catch (error) {
      failToListen();
      return;
    }
    recognition.lang = 'pt-BR';
    recognition.continuous = false;
    recognition.interimResults = true;
    session.recognition = recognition;
    sessionRef.current = session;

    recognition.onstart = () => {
      if (!isCurrent()) return;
      setListening(true);
      setStatus('listening');
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
      const shown = [...finals, ...interims].join(' ');
      if (shown) updateDraft(shown, 'voice');
    };

    recognition.onerror = () => {
      if (!isCurrent()) return;
      // Com erro, nada desta sessao e enviado: nem o texto provisorio, nem um final incompleto.
      failToListen();
    };

    recognition.onend = () => {
      if (!isCurrent()) return;
      const { finalText, typedDraft } = session;
      releaseSession(session);
      // So o resultado final vira comando; texto apenas provisorio nunca e executado.
      if (finalText) sendUtterance(finalText, { nextDraft: typedDraft });
    };

    try {
      recognition.start();
    } catch (error) {
      failToListen();
    }
  }, [addMessage, releaseSession, sendUtterance, supported, updateDraft]);

  const toggleListening = () => {
    setRainbowActive(true);
    setTimeout(() => {
      setRainbowActive(false);
    }, 1200);

    if (listening) {
      enterStandby();
      return;
    }
    startListening();
  };

  const submitTypedCommand = (event) => {
    event.preventDefault();
    const { text, source } = draftRef.current;
    // Transcricao da sessao em andamento (provisoria ou final ainda sem onend) nunca sai pelo botao:
    // so o onend envia, e apenas o resultado final.
    if (source === 'voice' || !text.trim()) return;
    // Texto digitado enviado durante a escuta: a captura e descartada e este e o unico envio.
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
            {status === 'listening' ? 'Ouvindo' : status === 'processing' ? 'Processando' : 'Standby'}
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
              aria-label={listening ? 'Parar escuta' : 'Iniciar escuta'}
              title={supported ? 'Falar com o assistente' : 'Reconhecimento de voz indisponível'}
            >
              <span className={`rainbow-ripple ${rainbowActive ? 'active' : ''}`} />
              <GeminiStar status={status} listening={listening} />
            </button>
          </div>

          <form className="voice-command-form" onSubmit={submitTypedCommand}>
            <div className="voice-input-wrap">
              <FaVolumeUp />
              <input
                value={draft}
                onChange={changeDraft}
                placeholder={supported ? 'O texto reconhecido aparece aqui' : 'Digite um comando'}
                disabled={processing}
              />
            </div>
            <button type="submit" disabled={!draft.trim() || processing} title="Enviar comando">
              <FaPaperPlane />
            </button>
            <button type="button" onClick={() => enterStandby()} title="Standby">
              <FaPowerOff />
            </button>
          </form>
        </section>
      </main>
    </div>
  );
}

export default VoiceAssistantPage;
