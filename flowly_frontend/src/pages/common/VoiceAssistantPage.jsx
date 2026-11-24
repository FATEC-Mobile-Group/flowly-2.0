import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { FaCheck, FaPaperPlane, FaPowerOff, FaTimes, FaVolumeUp } from 'react-icons/fa';
import Sidebar from '../../components/layout/Sidebar';
import { API_ENDPOINTS } from '../../config/config';
import { authUtils } from '../../config/authUtils';
import AssistantQueryResults from '../../components/assistant/AssistantQueryResults';
import { parseAssistantQuery } from '../../utils/assistantQuery';
import { pickPortugueseVoice } from '../../utils/voiceSelection';
import { createVoiceTrace } from '../../utils/voiceDiagnostics';
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

// Sugestoes do estado inicial (consultas somente leitura do perfil user); enviadas como um comando digitado.
const SUGGESTIONS = ['Minhas tarefas de hoje', 'O que está atrasado?', 'Como está meu dia?'];
// Distancia do fim do historico ate a qual uma mensagem nova acompanha a conversa automaticamente.
const NEAR_BOTTOM_PX = 80;

// Estados da conversa em que o assistente fez uma pergunta e espera a proxima fala.
const AWAITING_CONVERSATION = new Set([
  'awaiting_params',
  'awaiting_confirmation',
  'awaiting_task_selection',
  'awaiting_task_action',
  'browsing_tasks',
]);
// "Ouvindo" so com o microfone captando de verdade; "Aguardando resposta" e o contexto da conversa (o assistente
// espera a proxima fala), com o microfone desligado.
const STATUS_LABELS = {
  starting: 'Preparando microfone',
  resuming: 'Retomando conversa',
  listening: 'Ouvindo — pode falar',
  finishing: 'Finalizando a fala',
  processing: 'Processando',
  speaking: 'Respondendo',
  error: 'Erro',
  awaiting: 'Aguardando resposta',
  standby: 'Standby',
};
// Conversa por voz: comeca no toque da estrela e, depois de cada resposta (quando a voz do assistente termina, ou
// logo apos a resposta se nao houver voz), o microfone volta sozinho. Pausa antes de reabrir, para o fim do audio
// do assistente nao ser captado. A conversa termina com Standby, Cancelar, digitacao, botoes, erro, resposta com
// falha ou operacao incerta, e por inatividade: microfone reaberto sem fala por NO_SPEECH_TIMEOUT_MS (8 s).
const RESUME_DELAY_MS = 400;
// Voz pedida que nao comecou: a fala e cancelada (nunca toca depois com o microfone aberto) e a conversa segue.
const SPEECH_START_TIMEOUT_MS = 6000;
// O Chrome as vezes nao dispara onend: com a fala iniciada, confere se ainda esta tocando.
const SPEECH_POLL_MS = 500;
// Fases da confirmacao em que a escuta nao volta sozinha (resultado incerto ou operacao em andamento).
const RESUME_BLOCKING_PHASES = new Set(['uncertain', 'retry', 'in_progress', 'cancel_unverified']);
const INACTIVITY_NOTICE = 'Conversa por voz encerrada por falta de fala. Toque na estrela para falar de novo.';
// Depois de Concluir (stop), o navegador deveria encerrar logo; sem onend, a sessao e fechada assim mesmo.
const FINISH_TIMEOUT_MS = 4000;
// Prontidao real: no Chrome o onstart chega antes da captura; o audio so esta disponivel no onaudiostart.
// Medido em 29 sessoes reais (Chrome 157): onaudiostart de 1,1 s a 11 s depois do onstart.
const SLOW_START_HINT_MS = 3000;
const AUDIO_START_TIMEOUT_MS = 12000;
// Falhas seguidas antes de sugerir outro caminho (sem novas tentativas automaticas).
const FAILURE_HINT_AFTER = 3;
// Escuta continua LIMITADA a uma fala: o navegador nao corta a frase na primeira pausa (no modo nao continuo o
// Chrome encerra no primeiro silencio curto e so entrega o primeiro trecho). A sessao conclui sozinha (stop, so o
// resultado final e enviado) depois de uma pausa sem novos resultados, fecha sem fala e tem duracao maxima.
const SPEECH_PAUSE_END_MS = 2000;
const NO_SPEECH_TIMEOUT_MS = 8000;
const MAX_LISTEN_MS = 30000;
// Falhas em que tentar de novo pode resolver (as de permissao ou de navegador nao).
const RETRYABLE_ERRORS = new Set([
  'no-speech', 'network', 'aborted', 'audio-capture', 'start-failed', 'audio-start-timeout', 'audio-not-started',
  'not-transcribed', 'unknown',
]);

// Junta os trechos de uma sessao sem repetir texto: alguns navegadores (Chrome no Android, modo continuo) entregam
// cada trecho com o texto anterior inteiro ("criar", "criar tarefa", "criar tarefa relatorio").
const normalizeSegment = (text) => String(text || '').toLowerCase().replace(/\s+/g, ' ').trim();
function mergeSegments(segments) {
  const merged = [];
  segments.forEach((segment) => {
    const last = merged[merged.length - 1];
    if (last !== undefined) {
      const previous = normalizeSegment(last);
      const current = normalizeSegment(segment);
      if (current.startsWith(previous)) {
        merged[merged.length - 1] = segment;
        return;
      }
      if (previous.startsWith(current)) return;
    }
    merged.push(segment);
  });
  return merged;
}

// Confirmacao de escrita ligada a operacao mostrada: o assistente devolve conversation.operation_id e o resumo
// guardado na API; a tela reenvia esse operationId em cada mensagem enquanto o resumo esta na tela (voz, texto ou
// botao). O navegador nunca cria IDs nem chama as rotas internas; quem valida e executa e o backend.
const TERMINAL_OPERATION_STATUSES = new Set(['completed', 'failed', 'cancelled', 'expired', 'unknown']);
const CONFIRMATION_PHASES = {
  awaiting_confirmation: 'awaiting',
  retry_pending: 'uncertain',
  operation_in_progress: 'in_progress',
  executing: 'in_progress',
  cancel_unverified: 'cancel_unverified',
  unverified: 'retry',
};
// Recusas em que o backend garante que nada foi enviado (pode tentar de novo sem risco).
const NOTHING_SENT_ERRORS = new Set(['lease_budget_exhausted', 'claim_invalid']);
const CONFIRMATION_TEXT = {
  awaiting: {
    title: 'Confirme a operação',
    note: 'Nada foi alterado ainda. Toque em Confirmar ou diga "confirmar". Para desistir, toque em Cancelar ou diga "cancelar".',
  },
  uncertain: {
    title: 'Resultado não confirmado',
    note: 'Não foi possível confirmar se a alteração foi feita: ela pode ter sido aplicada. "Concluir com segurança" verifica sem repetir; você também pode conferir no Flowly.',
  },
  retry: {
    title: 'Não executado',
    note: 'Nada foi enviado. Você pode tentar confirmar de novo.',
  },
  in_progress: {
    title: 'Em andamento',
    note: 'Essa operação já está sendo executada. Aguarde o resultado.',
  },
  cancel_unverified: {
    title: 'Cancelamento não confirmado',
    note: 'Nada foi executado, mas não consegui confirmar o cancelamento. Você pode tentar cancelar de novo; sem confirmação, o pedido expira sozinho.',
  },
  expired: {
    title: 'Prazo encerrado',
    note: 'O prazo para confirmar terminou. Nada foi alterado. Se ainda quiser, faça o pedido de novo.',
  },
};
const CONFIRMATION_ACTIONS = {
  awaiting: [['confirmar', 'Confirmar'], ['cancelar', 'Cancelar']],
  uncertain: [['confirmar', 'Concluir com segurança']],
  retry: [['confirmar', 'Tentar de novo']],
  cancel_unverified: [['cancelar', 'Cancelar']],
  in_progress: [],
  expired: [],
};
// Pedido que pode ser uma confirmacao (para nao chamar de "falha" uma resposta perdida depois de confirmar).
const looksLikeConfirmation = (text) => /\bconfirm/i.test(String(text || ''));

// Mensagens por erro do reconhecimento nativo (Web Speech API).
function recognitionErrorMessage(error) {
  switch (error) {
    case 'no-speech':
      return 'Não ouvi nenhuma fala. Toque no microfone, espere aparecer "Ouvindo — pode falar" e fale perto do microfone.';
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
    case 'audio-start-timeout':
      return 'O navegador não abriu o microfone a tempo. Nada foi enviado. Toque no microfone para tentar de novo ou digite o comando.';
    case 'audio-not-started':
      return 'O navegador encerrou a escuta antes de abrir o microfone. Nada foi enviado. Toque no microfone para tentar de novo.';
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
  // Microfone: idle, starting (start pedido, captura ainda nao confirmada), listening (audio chegando:
  // onaudiostart, ou onstart em navegador sem esse evento) ou finishing (Concluir, aguardando o final).
  const [mic, setMic] = useState('idle');
  const [processing, setProcessing] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [awaitingReply, setAwaitingReply] = useState(false);
  // Texto ouvido sem confirmacao do navegador, posto no campo para a pessoa conferir antes de enviar.
  const [recoveredText, setRecoveredText] = useState('');
  // Microfone demorando para abrir (mais de alguns segundos em "Iniciando").
  const [slowStart, setSlowStart] = useState(false);
  const [rainbowActive, setRainbowActive] = useState(false);
  // Ultima falha da escuta permite "Tentar de novo" (um toque, nunca automatico).
  const [retryable, setRetryable] = useState(false);
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
  // Historico com rolagem propria: acompanha o fim so quando a pessoa ja esta perto dele.
  const historyRef = useRef(null);
  const stickToBottomRef = useRef(true);
  const [showJump, setShowJump] = useState(false);
  // Uma conversa por montagem da pagina: atualizar ou reabrir gera outra, e uma confirmacao antiga nao vale nela.
  const conversationIdRef = useRef(`voice-${authUtils.getUserId() || 'guest'}-${Date.now()}`);
  // Confirmacao mostrada: { operationId, conversationId, summary, phase, expiresAt }. So em memoria e so como
  // referencia: o backend confere dono, conversa, prazo e estado antes de qualquer execucao.
  const [confirmation, setConfirmationState] = useState(null);
  const confirmationRef = useRef(null);
  const setConfirmation = useCallback((next) => {
    confirmationRef.current = next;
    setConfirmationState(next);
  }, []);

  // Conversa por voz ativa (epoch muda a cada inicio ou fim: callbacks de uma conversa antiga sao ignorados).
  const conversationRef = useRef({ active: false, epoch: 0 });
  const [conversationActive, setConversationActive] = useState(false);
  // Retomada automatica pendente ou microfone reabrindo sozinho.
  const [resuming, setResuming] = useState(false);
  const resumeTimerRef = useRef(null);
  // Ultima escuta falhou e precisa de acao da pessoa.
  const [micError, setMicError] = useState(false);
  // Motivo do fim da conversa por voz (mostrado junto da estrela ate a proxima acao).
  const [conversationNotice, setConversationNotice] = useState('');
  const startListeningRef = useRef(null);
  // Vozes do navegador (carregam depois da montagem: voiceschanged) e aviso quando nao ha voz em portugues.
  const voicesRef = useRef([]);
  const [voiceKind, setVoiceKind] = useState(null);
  const speechTimersRef = useRef({ start: null, poll: null });
  const traceRef = useRef(null);
  if (!traceRef.current) traceRef.current = createVoiceTrace();

  const supported = useMemo(() => Boolean(SpeechRecognition), []);
  const listening = mic === 'listening';
  let status = 'standby';
  if (listening) status = 'listening';
  else if (mic === 'starting') status = resuming ? 'resuming' : 'starting';
  else if (mic === 'finishing') status = 'finishing';
  else if (processing) status = 'processing';
  else if (speaking) status = 'speaking';
  else if (resuming) status = 'resuming';
  else if (micError) status = 'error';
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

  const clearSpeechTimers = useCallback(() => {
    clearTimeout(speechTimersRef.current.start);
    clearInterval(speechTimersRef.current.poll);
    speechTimersRef.current = { start: null, poll: null };
  }, []);

  // Interromper (Standby, nova escuta, sair): a fala para e o "terminou" dela nunca e avisado.
  const stopSpeaking = useCallback(() => {
    utteranceRef.current = null;
    clearSpeechTimers();
    setSpeaking(false);
    if (window.speechSynthesis) window.speechSynthesis.cancel();
  }, [clearSpeechTimers]);

  // Fala a resposta. onDone so e chamado quando a fala termina de verdade (fim, erro, ou nao comecou a tempo e foi
  // cancelada); nunca se ela for interrompida. Devolve false quando nao ha nada para falar.
  const speak = useCallback((payload, onDone = null) => {
    // tts.enabled false (contrato do assistente): a resposta so aparece na tela.
    if (payload?.tts?.enabled === false) return false;
    const text = payload?.tts?.text || payload?.reply_text || '';
    const synth = window.speechSynthesis;
    if (!text || !synth || typeof SpeechSynthesisUtterance === 'undefined') return false;

    synth.cancel();
    clearSpeechTimers();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = payload?.tts?.language || 'pt-BR';
    utterance.rate = 1;
    // Voz brasileira explicita quando o navegador tiver uma (sem ela, pode sair a voz padrao do sistema).
    const voices = voicesRef.current.length ? voicesRef.current : (synth.getVoices?.() || []);
    const { voice } = pickPortugueseVoice(voices);
    if (voice) utterance.voice = voice;
    utteranceRef.current = utterance;
    const finished = () => {
      if (utteranceRef.current !== utterance) return;
      utteranceRef.current = null;
      clearSpeechTimers();
      setSpeaking(false);
      traceRef.current.mark('voz-fim');
      if (onDone) onDone();
    };
    utterance.onstart = () => {
      if (utteranceRef.current !== utterance) return;
      clearTimeout(speechTimersRef.current.start);
      setSpeaking(true);
      traceRef.current.measure('inicio-da-voz', 'resposta');
      // Fim sem onend (Chrome): a fala ja nao esta tocando nem na fila.
      if (typeof synth.speaking === 'boolean') {
        speechTimersRef.current.poll = setInterval(() => {
          if (!synth.speaking && !synth.pending) finished();
        }, SPEECH_POLL_MS);
      }
    };
    utterance.onend = finished;
    utterance.onerror = finished;
    // Nao comecou a tempo (bloqueio do navegador, voz carregando): cancela para nao tocar depois com o microfone
    // aberto; a resposta continua na tela.
    speechTimersRef.current.start = setTimeout(() => {
      if (utteranceRef.current !== utterance) return;
      synth.cancel();
      finished();
    }, SPEECH_START_TIMEOUT_MS);
    synth.speak(utterance);
    return true;
  }, [clearSpeechTimers]);

  // Fim da conversa por voz: nenhuma retomada pendente ou tardia reabre o microfone.
  const endConversation = useCallback((notice = '') => {
    conversationRef.current = { active: false, epoch: conversationRef.current.epoch + 1 };
    clearTimeout(resumeTimerRef.current);
    resumeTimerRef.current = null;
    setConversationActive(false);
    setResuming(false);
    setConversationNotice(notice);
  }, []);

  // Toque explicito na estrela (ou em "Tentar de novo"): comeca uma conversa nova.
  const beginConversation = useCallback(() => {
    clearTimeout(resumeTimerRef.current);
    resumeTimerRef.current = null;
    conversationRef.current = { active: true, epoch: conversationRef.current.epoch + 1 };
    setConversationActive(true);
    setResuming(false);
    setConversationNotice('');
  }, []);

  // Proximo turno: reabre o microfone depois de uma pausa, se a conversa ainda for a mesma e nada estiver ativo.
  const scheduleResume = useCallback((epoch) => {
    const current = conversationRef.current;
    if (!current.active || current.epoch !== epoch) return;
    clearTimeout(resumeTimerRef.current);
    setResuming(true);
    resumeTimerRef.current = setTimeout(() => {
      resumeTimerRef.current = null;
      const latest = conversationRef.current;
      if (!latest.active || latest.epoch !== epoch || sessionRef.current || sendingRef.current || utteranceRef.current) {
        setResuming(false);
        return;
      }
      if (typeof document !== 'undefined' && document.hidden) {
        endConversation('A conversa por voz foi pausada porque a página ficou em segundo plano. Toque na estrela para continuar.');
        return;
      }
      startListeningRef.current?.({ auto: true });
    }, RESUME_DELAY_MS);
  }, [endConversation]);

  // Atualiza o vinculo com a operacao a partir da resposta do assistente (so desta conversa).
  const applyConfirmation = useCallback((payload) => {
    const conversation = payload?.conversation;
    if (!conversation || typeof conversation !== 'object') return;
    if (conversation.id && conversation.id !== conversationIdRef.current) return;
    const { status } = conversation;
    const current = confirmationRef.current;
    const operationId = typeof conversation.operation_id === 'string' ? conversation.operation_id : '';
    if (TERMINAL_OPERATION_STATUSES.has(status)) {
      // Resultado final confirmado: sai o vinculo (e os botoes) da operacao a que ele se refere.
      if (!operationId || !current || current.operationId === operationId) setConfirmation(null);
      return;
    }
    const phase = CONFIRMATION_PHASES[status];
    if (!operationId || !phase) return; // pergunta, leitura ou erro sem operacao: o vinculo fica como esta
    const sameOperation = current?.operationId === operationId;
    const seconds = Number(conversation.expires_in);
    let expiresAt = sameOperation ? current.expiresAt : null;
    if (phase === 'awaiting' && Number.isFinite(seconds) && seconds > 0) expiresAt = Date.now() + seconds * 1000;
    setConfirmation({
      operationId,
      conversationId: conversationIdRef.current,
      // Sempre o resumo devolvido pela API; nada reconstruido aqui.
      summary: String(conversation.summary || (sameOperation ? current.summary : '') || ''),
      phase: status === 'retry_pending' && NOTHING_SENT_ERRORS.has(payload?.error) ? 'retry' : phase,
      expiresAt,
    });
  }, [setConfirmation]);

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
    clearTimeout(session.readyTimer);
    clearTimeout(session.slowTimer);
    clearTimeout(session.pauseTimer);
    clearTimeout(session.noSpeechTimer);
    clearTimeout(session.maxTimer);
    if (sessionRef.current === session) sessionRef.current = null;

    const { recognition } = session;
    recognition.onstart = null;
    recognition.onaudiostart = null;
    recognition.onsoundstart = null;
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
    setSlowStart(false);
    setResuming(false);
  }, [updateDraft]);

  const enterStandby = useCallback(async ({ silent = false, keepSpeech = false } = {}) => {
    endConversation();
    setMicError(false);
    releaseSession(sessionRef.current, { abort: true });
    setAwaitingReply(false);
    // Standby cancela a confirmacao pendente no backend: os botoes saem e nenhuma resposta tardia os traz de volta.
    setConfirmation(null);
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
  }, [addMessage, endConversation, releaseSession, setConfirmation, stopSpeaking]);

  // fromVoice: fala concluida na conversa por voz (so assim o microfone pode voltar sozinho depois da resposta).
  const sendUtterance = useCallback(async (utterance, { nextDraft = '', fromVoice = false } = {}) => {
    const cleanUtterance = String(utterance || '').trim();
    // Um envio por vez (tambem para os botoes de confirmacao); o backend garante uma unica execucao.
    if (!cleanUtterance || sendingRef.current) return;
    sendingRef.current = true;
    const binding = confirmationRef.current;
    const operationId = binding && binding.conversationId === conversationIdRef.current && binding.phase !== 'expired'
      ? binding.operationId
      : '';
    const request = {
      muted: false,
      conversationId: conversationIdRef.current,
      operationId,
      confirming: Boolean(operationId) && looksLikeConfirmation(cleanUtterance),
      // Conversa por voz em que o pedido nasceu: a retomada so vale para ela (Standby ou fim trocam o epoch).
      voiceEpoch: fromVoice && conversationRef.current.active ? conversationRef.current.epoch : null,
    };
    requestRef.current = request;
    // Pedido digitado, sugestao ou botao: a conversa por voz para aqui (o microfone nao volta sozinho).
    if (request.voiceEpoch === null && conversationRef.current.active) endConversation();

    addMessage('user', cleanUtterance);
    updateDraft(nextDraft);
    setRetryable(false);
    setMicError(false);
    setProcessing(true);
    setAwaitingReply(false);
    traceRef.current.measure('envio', 'fim-da-fala');
    traceRef.current.mark('envio');

    // Proximo turno da conversa por voz (so a mesma conversa, sem confirmacao incerta nem resposta com falha).
    const continueConversation = (payload) => {
      if (request.voiceEpoch === null) return;
      const phase = confirmationRef.current?.phase;
      if (!payload?.ok || RESUME_BLOCKING_PHASES.has(phase)) {
        endConversation('Conversa por voz pausada. Confira a resposta acima e toque na estrela para continuar.');
        return;
      }
      const epoch = request.voiceEpoch;
      const resume = () => {
        traceRef.current.mark('retomada');
        scheduleResume(epoch);
      };
      if (!speak(payload, resume)) {
        traceRef.current.mark('voz-fim');
        resume();
      }
    };

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
          conversationId: request.conversationId,
          content: cleanUtterance,
          // So o ID que o proprio assistente mostrou nesta conversa; sem ele, confirmar nao executa nada.
          ...(operationId ? { operationId } : {}),
        }),
      });

      const payload = await response.json();
      traceRef.current.measure('resposta', 'envio');
      traceRef.current.mark('resposta');
      const reply = payload.reply_text || payload.message || 'Resposta recebida.';
      // Metadados da consulta (opcional): so com resposta ok e formato valido; senao fica so o texto.
      const query = payload.ok ? parseAssistantQuery(payload.query) : null;
      addMessage('assistant', reply, { error: !payload.ok, ...(query ? { query } : {}) });
      // Resposta tardia (depois do standby ou de outra conversa) nao mexe na confirmacao mostrada.
      if (request.muted || request.conversationId !== conversationIdRef.current) return;
      applyConfirmation(payload);

      if (payload?.command?.key === 'exit') {
        speak(payload);
        // A despedida e falada ate o fim; o standby nao corta a propria resposta.
        await enterStandby({ silent: true, keepSpeech: true });
        return;
      }
      setAwaitingReply(AWAITING_CONVERSATION.has(payload?.conversation?.status));
      if (request.voiceEpoch !== null) continueConversation(payload);
      else speak(payload);
    } catch (error) {
      // Resposta perdida: nada e repetido e o microfone nao volta sozinho.
      if (request.voiceEpoch !== null && !request.muted) {
        endConversation('Conversa por voz pausada. Toque na estrela para continuar.');
      }
      if (request.confirming && !request.muted && confirmationRef.current?.operationId === request.operationId) {
        // A confirmacao saiu e a resposta se perdeu: pode ter sido aplicada. Nunca vira sucesso nem falha.
        setConfirmation({ ...confirmationRef.current, phase: 'uncertain' });
        addMessage('assistant', 'Não consegui receber o resultado da confirmação. A alteração pode ter sido aplicada; confira antes de repetir.', { error: true });
      } else {
        addMessage('assistant', 'Não consegui falar com a API do assistente.', { error: true });
      }
    } finally {
      if (requestRef.current === request) requestRef.current = null;
      sendingRef.current = false;
      setProcessing(false);
    }
  }, [addMessage, applyConfirmation, endConversation, enterStandby, scheduleResume, setConfirmation, speak, updateDraft]);

  // Fim da sessao (onend, erro ou prazo do Concluir): envia so o resultado final; o resto e recuperavel.
  const concludeSession = useCallback((session, { error = null, abort = false } = {}) => {
    const { finalText, interimText, typedDraft, speechDetected, ready } = session;
    releaseSession(session, { abort });

    // Tudo o que o navegador entregou e final: e o comando, mesmo que um erro chegue depois dele.
    if (finalText && !interimText) {
      failuresRef.current = 0;
      traceRef.current.mark('fim-da-fala');
      sendUtterance(finalText, { nextDraft: typedDraft, fromVoice: true });
      return;
    }

    let kind = error;
    if (!kind) {
      if (speechDetected) kind = 'not-transcribed';
      else if (!ready) kind = 'audio-not-started';
      else kind = 'no-speech';
    }
    // Retomada sem nenhuma fala: fim da conversa por inatividade (nao e uma falha e nao tenta de novo).
    if (session.auto && kind === 'no-speech' && !finalText && !interimText) {
      endConversation(INACTIVITY_NOTICE);
      return;
    }
    // Qualquer outra falha encerra a conversa por voz: retomar fica com a pessoa (um toque, nunca automatico).
    endConversation(session.auto
      ? 'Não consegui retomar o microfone automaticamente. Toque na estrela para continuar.'
      : '');
    setMicError(true);
    failuresRef.current += 1;
    const braveNetwork = kind === 'network' && typeof navigator !== 'undefined' && navigator.brave;
    setRetryable(RETRYABLE_ERRORS.has(kind) && !braveNetwork);
    const heard = mergeSegments([finalText, interimText].filter(Boolean)).join(' ');
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
    } else if (!ready) {
      addMessage('assistant', recognitionErrorMessage('audio-not-started'), { error: true });
    } else {
      addMessage('assistant', recognitionErrorMessage('no-speech'), { error: true });
    }

    if (failuresRef.current === FAILURE_HINT_AFTER) {
      addMessage(
        'assistant',
        'O reconhecimento de voz falhou 3 vezes seguidas. Fale só depois de aparecer "Ouvindo — pode falar", perto do microfone e sem a voz do assistente tocando, ou digite o comando.',
        { error: true },
      );
    }
  }, [addMessage, endConversation, releaseSession, sendUtterance, updateDraft]);

  // Concluir a fala (toque em "Concluir fala", pausa, ou duracao maxima): o navegador entrega o resultado final do
  // que ja ouviu; sem resposta em FINISH_TIMEOUT_MS, a sessao e fechada assim mesmo. So o final e enviado.
  const finishSession = useCallback((session) => {
    if (!session || session.closed || session.finishing || sessionRef.current !== session) return;
    session.finishing = true;
    clearTimeout(session.pauseTimer);
    clearTimeout(session.noSpeechTimer);
    clearTimeout(session.maxTimer);
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

  // auto: retomada da conversa por voz depois da resposta (nao e um toque da pessoa).
  const startListening = useCallback(({ auto = false } = {}) => {
    // Uma sessao por vez, e nenhuma enquanto um comando esta sendo processado.
    if (!supported || sessionRef.current || sendingRef.current) return;
    setRetryable(false);
    setMicError(false);
    if (!auto) traceRef.current.mark('clique');
    // A voz do assistente nao pode ser captada como se fosse a fala da pessoa.
    stopSpeaking();

    const session = {
      recognition: null,
      closed: false,
      finishTimer: null,
      readyTimer: null,
      slowTimer: null,
      ready: false,
      finalText: '',
      interimText: '',
      speechDetected: false,
      typedDraft: draftRef.current.source === 'typed' ? draftRef.current.text : '',
      auto,
    };
    const isCurrent = () => sessionRef.current === session && !session.closed;
    // Microfone realmente captando: so entao a tela pede para a pessoa falar.
    const markReady = () => {
      if (!isCurrent() || session.ready) return;
      session.ready = true;
      clearTimeout(session.readyTimer);
      clearTimeout(session.slowTimer);
      setSlowStart(false);
      if (!session.finishing) setMic('listening');
      setResuming(false);
      if (auto) traceRef.current.measure('retomada', 'retomada');
      else traceRef.current.measure('microfone-pronto', 'clique');
      // Microfone aberto, mas sem fala: fecha sem enviar (o navegador nem sempre avisa no modo continuo).
      session.noSpeechTimer = setTimeout(() => {
        if (isCurrent() && !session.finishing && !session.finalText && !session.interimText) {
          concludeSession(session, { error: 'no-speech', abort: true });
        }
      }, NO_SPEECH_TIMEOUT_MS);
      // Limite da sessao: conclui como no toque, nunca deixa o microfone aberto.
      session.maxTimer = setTimeout(() => {
        if (isCurrent()) finishSession(session);
      }, MAX_LISTEN_MS);
    };

    let recognition;
    try {
      recognition = new SpeechRecognition();
    } catch (error) {
      failuresRef.current += 1;
      endConversation(auto ? 'Não consegui retomar o microfone automaticamente. Toque na estrela para continuar.' : '');
      setMicError(true);
      addMessage('assistant', recognitionErrorMessage('start-failed'), { error: true });
      return;
    }
    recognition.lang = 'pt-BR';
    // Continuo para nao cortar a frase na pausa, mas limitado a uma fala (pausa, sem fala, duracao maxima).
    recognition.continuous = true;
    recognition.interimResults = true;
    // Navegador sem o evento audiostart: o onstart e o melhor sinal disponivel de que a captura comecou.
    const reportsAudioStart = 'onaudiostart' in recognition;
    session.recognition = recognition;
    sessionRef.current = session;

    recognition.onstart = () => {
      if (!isCurrent()) return;
      if (!reportsAudioStart) {
        markReady();
        return;
      }
      // Servico iniciado, microfone ainda nao: continua "Iniciando" e espera o audiostart, com prazo.
      session.readyTimer = setTimeout(() => {
        if (isCurrent() && !session.ready) concludeSession(session, { error: 'audio-start-timeout', abort: true });
      }, AUDIO_START_TIMEOUT_MS);
    };

    recognition.onaudiostart = markReady;
    // Som, fala ou resultado so existem com o audio chegando: tambem confirmam a captura.
    recognition.onsoundstart = markReady;

    recognition.onspeechstart = () => {
      if (!isCurrent()) return;
      session.speechDetected = true;
      markReady();
    };

    recognition.onresult = (event) => {
      if (!isCurrent()) return;
      markReady();
      // A lista de resultados e cumulativa: refazer o texto a cada evento evita repetir ou perder trechos.
      const finals = [];
      const interims = [];
      for (let i = 0; i < event.results.length; i += 1) {
        const result = event.results[i];
        const transcript = String(result?.[0]?.transcript || '').trim();
        if (transcript) (result.isFinal ? finals : interims).push(transcript);
      }
      // Trechos repetidos de forma cumulativa (Chrome no Android) entram uma vez so.
      const finalSegments = mergeSegments(finals);
      session.finalText = finalSegments.join(' ');
      const finalNorm = normalizeSegment(session.finalText);
      session.interimText = interims.filter((text) => !finalNorm.startsWith(normalizeSegment(text))).join(' ');
      session.speechDetected = true;
      const shown = mergeSegments([...finalSegments, ...interims]).join(' ');
      if (shown) updateDraft(shown, 'voice');
      // Pausa: sem novos resultados por SPEECH_PAUSE_END_MS, a fala e concluida (stop: so o final e enviado).
      clearTimeout(session.noSpeechTimer);
      clearTimeout(session.pauseTimer);
      if (shown && !session.finishing) {
        session.pauseTimer = setTimeout(() => {
          if (isCurrent()) finishSession(session);
        }, SPEECH_PAUSE_END_MS);
      }
    };

    recognition.onerror = (event) => {
      if (isCurrent()) concludeSession(session, { error: event?.error || 'unknown' });
    };

    recognition.onend = () => {
      if (isCurrent()) concludeSession(session);
    };

    setMic('starting');
    // Abertura demorada (ou pedido de permissao): a tela avisa para esperar, sem encerrar.
    session.slowTimer = setTimeout(() => {
      if (isCurrent() && !session.ready) setSlowStart(true);
    }, SLOW_START_HINT_MS);
    try {
      recognition.start();
    } catch (error) {
      concludeSession(session, { error: 'start-failed' });
    }
  }, [addMessage, concludeSession, endConversation, finishSession, stopSpeaking, supported, updateDraft]);
  startListeningRef.current = startListening;

  // Concluir (clique no microfone durante a escuta): o navegador entrega o resultado final do que ouviu.
  // Diferente de cancelar (Standby, sair da pagina, digitar), que descarta a captura com abort.
  const finishListening = useCallback(() => {
    finishSession(sessionRef.current);
  }, [finishSession]);

  // Cancelar (junto da estrela): descarta a captura sem enviar nada; nao entra em standby, entao uma confirmacao
  // aberta na tela continua como estava.
  const cancelListening = () => {
    // Cancelar tambem encerra a conversa por voz: o microfone nao volta sozinho.
    endConversation();
    releaseSession(sessionRef.current, { abort: true });
  };

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
    // Toque explicito: comeca (ou recomeca) a conversa por voz; uma retomada pendente e substituida.
    beginConversation();
    startListening();
  };

  // "Tentar de novo" e um toque explicito: tambem comeca a conversa por voz.
  const retryListening = () => {
    beginConversation();
    startListening();
  };

  const submitTypedCommand = (event) => {
    event.preventDefault();
    const { text, source } = draftRef.current;
    // Transcricao da sessao em andamento (provisoria ou final ainda sem onend) nunca sai pelo botao:
    // so o fim da sessao envia, e apenas o resultado final.
    if (source === 'voice' || !text.trim()) return;
    // Texto digitado (ou recuperado e conferido) enviado durante a escuta: a captura e descartada e a conversa
    // por voz termina (o microfone nao abre sozinho depois de um comando digitado).
    endConversation();
    releaseSession(sessionRef.current, { abort: true });
    sendUtterance(text);
  };

  const changeDraft = (event) => {
    // Digitar assume o comando: a captura em andamento e descartada e nao sobrescreve o texto.
    updateDraft(event.target.value, 'typed');
    endConversation();
    releaseSession(sessionRef.current, { abort: true });
    setRetryable(false);
  };

  const scrollToLatest = useCallback(() => {
    const history = historyRef.current;
    if (history) history.scrollTop = history.scrollHeight;
    stickToBottomRef.current = true;
    setShowJump(false);
  }, []);

  const handleHistoryScroll = () => {
    const history = historyRef.current;
    if (!history) return;
    const nearBottom = history.scrollHeight - history.scrollTop - history.clientHeight <= NEAR_BOTTOM_PX;
    stickToBottomRef.current = nearBottom;
    if (nearBottom) setShowJump(false);
  };

  // Mensagem nova: acompanha se a pessoa estava no fim (ou se ela mesma enviou); lendo o historico, so avisa.
  // Antes da pintura e sem rolagem suave: a animacao gerava eventos de scroll no meio do caminho, que pareciam a
  // pessoa subindo, e a resposta seguinte deixava de ser acompanhada.
  useLayoutEffect(() => {
    const last = messages[messages.length - 1];
    if (stickToBottomRef.current || last?.role === 'user') scrollToLatest();
    else setShowJump(true);
  }, [messages, scrollToLatest]);

  useEffect(() => () => {
    enterStandby({ silent: true });
  }, [enterStandby]);

  // Vozes do navegador: podem chegar depois da montagem (voiceschanged). Sem voz em portugues, a tela avisa.
  useEffect(() => {
    const synth = window.speechSynthesis;
    if (!synth || typeof synth.getVoices !== 'function') return undefined;
    const load = () => {
      const voices = synth.getVoices() || [];
      voicesRef.current = voices;
      if (voices.length) setVoiceKind(pickPortugueseVoice(voices).kind);
    };
    load();
    if (typeof synth.addEventListener === 'function') {
      synth.addEventListener('voiceschanged', load);
      return () => synth.removeEventListener('voiceschanged', load);
    }
    const previous = synth.onvoiceschanged;
    synth.onvoiceschanged = load;
    return () => {
      if (synth.onvoiceschanged === load) synth.onvoiceschanged = previous || null;
    };
  }, []);

  // Prazo da confirmacao (do backend): vencido, os botoes saem; o backend recusaria de qualquer forma.
  useEffect(() => {
    if (!confirmation || confirmation.phase !== 'awaiting' || !confirmation.expiresAt) return undefined;
    const expire = () => {
      const current = confirmationRef.current;
      if (current?.operationId === confirmation.operationId && current.phase === 'awaiting') {
        setConfirmation({ ...current, phase: 'expired' });
      }
    };
    const remaining = confirmation.expiresAt - Date.now();
    if (remaining <= 0) {
      expire();
      return undefined;
    }
    const timer = setTimeout(expire, remaining);
    return () => clearTimeout(timer);
  }, [confirmation, setConfirmation]);

  const sendSuggestion = (text) => {
    // Mesmo caminho do comando digitado: descarta uma captura em andamento e envia o texto.
    endConversation();
    releaseSession(sessionRef.current, { abort: true });
    sendUtterance(text);
  };

  const answerConfirmation = (word) => {
    // Botao = a mesma mensagem explicita que a voz ou o texto mandariam, com o operationId mostrado.
    endConversation();
    releaseSession(sessionRef.current, { abort: true });
    sendUtterance(word);
  };

  // A estrela mantem o visual de processamento enquanto a fala e finalizada.
  const starStatus = status === 'finishing' ? 'processing' : status;
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
    interactionHint = slowStart
      ? 'O navegador ainda está abrindo o microfone (pode estar pedindo permissão). Espere aparecer "Ouvindo — pode falar" ou toque em "Cancelar".'
      : 'Abrindo o microfone: espere aparecer "Ouvindo — pode falar". "Cancelar" descarta sem enviar.';
  } else if (mic === 'listening') {
    interactionHint = 'Fale normalmente: depois de uma pausa eu concluo sozinho. Toque em "Concluir" para concluir a fala e enviar o que o navegador confirmar, ou em "Cancelar" para descartar sem enviar.';
  } else if (mic === 'finishing') {
    interactionHint = 'Aguardando o navegador confirmar a frase. "Cancelar" descarta sem enviar.';
  } else if (unconfirmedDraft) {
    interactionHint = 'Texto não confirmado pelo navegador: pode estar incompleto. Confira e corrija antes de tocar em Enviar.';
  } else if (processing) {
    interactionHint = 'Processando o seu pedido. Aguarde a resposta.';
  } else if (speaking) {
    interactionHint = conversationActive
      ? 'Respondendo por voz. Quando eu terminar, o microfone volta sozinho. Toque na estrela para interromper e falar já.'
      : 'Respondendo por voz. Toque na estrela para interromper e falar de novo.';
  } else if (resuming) {
    interactionHint = 'Retomando a conversa: espere aparecer "Ouvindo — pode falar". Standby encerra a conversa por voz.';
  } else if (conversationNotice) {
    interactionHint = conversationNotice;
  } else if (status === 'awaiting') {
    interactionHint = 'O assistente espera a sua resposta. Toque na estrela para falar ou digite.';
  }
  const hintId = interactionHint ? 'voice-interaction-hint' : undefined;
  // Sem conversa ainda: estrela em destaque e sugestoes; com conversa, o historico e o principal.
  const hasConversation = messages.some((message) => message.id !== 'welcome');
  const showSuggestions = !hasConversation && authUtils.getUserType() === 'user';

  return (
    <div className="admin-page voice-assistant-page">
      <Sidebar />

      <main className={`voice-assistant-shell ${hasConversation ? 'has-conversation' : 'is-empty'}`}>
        <section className="voice-assistant-header">
          <div>
            <p className="voice-assistant-kicker">Flowly Voice</p>
            <h1>Assistente de voz</h1>
          </div>
          <div className={`voice-status ${status}`} role="status" aria-live="polite">
            <span aria-hidden="true" />
            {STATUS_LABELS[status]}
          </div>
        </section>

        <section className="voice-chat-panel">
          <div className="voice-chat-history">
            <div
              ref={historyRef}
              className="voice-chat-messages"
              role="log"
              aria-live="polite"
              aria-relevant="additions"
              aria-label="Conversa com o assistente"
              onScroll={handleHistoryScroll}
            >
              {messages.map((message) => (
                <article
                  key={message.id}
                  className={`voice-message ${message.role} ${message.error ? 'error' : ''} ${message.query ? 'has-query' : ''}`}
                >
                  <span className="voice-message-author">
                    {message.role === 'user' ? 'Você' : 'Assistente'}
                  </span>
                  {message.query ? (
                    <AssistantQueryResults query={message.query} replyText={message.text} />
                  ) : (
                    <p className="voice-message-text">{message.text}</p>
                  )}
                </article>
              ))}
              {showSuggestions && (
                <div className="voice-suggestions" role="group" aria-label="Sugestões de perguntas">
                  {SUGGESTIONS.map((suggestion) => (
                    <button
                      key={suggestion}
                      type="button"
                      onClick={() => sendSuggestion(suggestion)}
                      disabled={processing}
                    >
                      {suggestion}
                    </button>
                  ))}
                </div>
              )}
              {processing && (
                // O estado ja e anunciado pelo indicador do cabecalho; aqui so o retorno visual na conversa.
                <div className="voice-typing" aria-hidden="true">
                  <span />
                  <span />
                  <span />
                </div>
              )}
            </div>
            {showJump && (
              <button type="button" className="voice-jump-latest" onClick={scrollToLatest}>
                Ir para a mensagem mais recente
              </button>
            )}
          </div>

          {confirmation && (
            <section
              className={`voice-confirmation ${confirmation.phase}`}
              role="group"
              aria-label={CONFIRMATION_TEXT[confirmation.phase].title}
              data-operation-id={confirmation.operationId}
            >
              <p className="voice-confirmation-title">{CONFIRMATION_TEXT[confirmation.phase].title}</p>
              {confirmation.summary && (
                <p className="voice-confirmation-summary">{confirmation.summary}</p>
              )}
              <p className="voice-confirmation-note">{CONFIRMATION_TEXT[confirmation.phase].note}</p>
              <div className="voice-confirmation-actions">
                {CONFIRMATION_ACTIONS[confirmation.phase].map(([word, label]) => (
                  <button
                    key={word}
                    type="button"
                    className={word === 'cancelar' ? 'secondary' : ''}
                    onClick={() => answerConfirmation(word)}
                    disabled={processing}
                  >
                    {label}
                  </button>
                ))}
                {confirmation.phase === 'expired' && (
                  <button type="button" className="secondary" onClick={() => setConfirmation(null)}>
                    Fechar
                  </button>
                )}
              </div>
            </section>
          )}

          <div className="voice-orb-zone">
            <button
              type="button"
              className={`voice-star-btn ${listening ? 'listening' : ''} ${starStatus} ${rainbowActive ? 'rainbow-burst' : ''}`}
              onClick={toggleListening}
              disabled={!supported || processing}
              aria-label={micLabel}
              aria-describedby={capturing ? hintId : undefined}
              title={supported ? (capturing ? micLabel : 'Falar com o assistente') : 'Reconhecimento de voz indisponível'}
            >
              <span className={`rainbow-ripple ${rainbowActive ? 'active' : ''}`} />
              <GeminiStar status={starStatus} listening={listening} />
            </button>
            {capturing && (
              // Controles da escuta junto da estrela (como no gravador de audio de um chat): Cancelar descarta a
              // captura (abort, nada e enviado nem avisado ao assistente); Concluir pede o resultado final (stop).
              <div className="voice-capture-controls" role="group" aria-label="Controles da escuta">
                <button
                  type="button"
                  className="voice-capture-btn cancel"
                  onClick={cancelListening}
                  aria-label="Cancelar a escuta"
                  aria-describedby={hintId}
                >
                  <FaTimes aria-hidden="true" />
                  <span>Cancelar</span>
                </button>
                <button
                  type="button"
                  className="voice-capture-btn conclude"
                  onClick={finishListening}
                  disabled={mic !== 'listening'}
                  aria-label="Concluir a fala"
                  aria-describedby={hintId}
                >
                  <FaCheck aria-hidden="true" />
                  <span>Concluir</span>
                </button>
              </div>
            )}
            {interactionHint && (
              <p id={hintId} className="voice-interaction-hint">{interactionHint}</p>
            )}
            {supported && retryable && !capturing && !processing && (
              <button type="button" className="voice-retry-btn" onClick={retryListening}>
                Tentar de novo
              </button>
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
          {voiceKind === 'none' && (
            <p className="voice-voice-warning">
              Este navegador não tem voz em português instalada; a resposta falada pode soar estranha. O texto continua na tela.
            </p>
          )}
        </section>
      </main>
    </div>
  );
}

export default VoiceAssistantPage;
