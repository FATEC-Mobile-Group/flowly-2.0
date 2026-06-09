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
  const recognitionRef = useRef(null);
  const transcriptRef = useRef('');
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

  const enterStandby = useCallback(async ({ silent = false } = {}) => {
    setListening(false);
    setProcessing(false);
    setStatus('standby');
    transcriptRef.current = '';

    if (recognitionRef.current) {
      try {
        recognitionRef.current.stop();
      } catch (error) {
        // Browser recognition may already be stopped.
      }
    }

    if (window.speechSynthesis) {
      window.speechSynthesis.cancel();
    }

    try {
      await fetch(API_ENDPOINTS.ASSISTANT_STANDBY, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ conversationId: conversationIdRef.current }),
      });
    } catch (error) {
      if (!silent) {
        addMessage('assistant', 'Não consegui avisar o standby, mas parei a escuta local.');
      }
    }
  }, [addMessage]);

  const sendUtterance = useCallback(async (utterance) => {
    const cleanUtterance = String(utterance || '').trim();
    if (!cleanUtterance || processing) return;

    addMessage('user', cleanUtterance);
    setDraft('');
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
      setProcessing(false);
      setStatus('standby');
    }
  }, [addMessage, enterStandby, processing, speak]);

  const startListening = useCallback(() => {
    if (!supported || processing) return;

    const recognition = new SpeechRecognition();
    recognition.lang = 'pt-BR';
    recognition.continuous = false;
    recognition.interimResults = true;
    transcriptRef.current = '';

    recognition.onstart = () => {
      setListening(true);
      setStatus('listening');
    };

    recognition.onresult = (event) => {
      let finalTranscript = '';
      let interimTranscript = '';

      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const transcript = event.results[i][0].transcript;
        if (event.results[i].isFinal) {
          finalTranscript += transcript;
        } else {
          interimTranscript += transcript;
        }
      }

      const current = (finalTranscript || interimTranscript).trim();
      if (current) {
        transcriptRef.current = current;
        setDraft(current);
      }
    };

    recognition.onerror = () => {
      setListening(false);
      setStatus('standby');
      addMessage('assistant', 'Não consegui ouvir agora. Tente novamente ou digite o comando.', { error: true });
    };

    recognition.onend = () => {
      setListening(false);
      const spoken = transcriptRef.current.trim();
      transcriptRef.current = '';
      if (spoken) {
        sendUtterance(spoken);
      } else {
        setStatus('standby');
      }
    };

    recognitionRef.current = recognition;
    recognition.start();
  }, [addMessage, processing, sendUtterance, supported]);

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
    sendUtterance(draft);
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
                onChange={(event) => setDraft(event.target.value)}
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
