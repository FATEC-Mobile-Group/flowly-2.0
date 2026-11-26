// Conversa por voz continua: o microfone volta sozinho depois de cada resposta, so quando a voz do assistente
// terminou, e nunca depois de Standby, cancelamento, digitacao, falha ou operacao incerta. Escolha da voz pt-BR.
// SpeechRecognition, speechSynthesis e fetch simulados (relogio falso): isto nao prova o comportamento no Chrome real.
import { act, fireEvent, render, screen } from '@testing-library/react';
import { API_ENDPOINTS } from '../../config/config';
import { definirPreferencia, redefinirCacheDePreferencias } from '../../config/preferencias';

vi.mock('../../components/layout/Sidebar', () => ({ __esModule: true, default: () => null }));
vi.setConfig({ testTimeout: 20000, hookTimeout: 30000 });

class FakeRecognition {
  static instances = [];

  constructor() {
    this.start = vi.fn();
    this.stop = vi.fn();
    this.abort = vi.fn();
    this.onaudiostart = null;
    FakeRecognition.instances.push(this);
  }
}

const resultEvent = (entries) => ({
  resultIndex: 0,
  results: entries.map(([transcript, isFinal]) => Object.assign([{ transcript, confidence: 0.9 }], { isFinal })),
});
const fire = (handler, event = {}) => act(() => {
  handler?.(event);
});

const COMMAND_URL = API_ENDPOINTS.ASSISTANT_COMMAND;
const STANDBY_URL = API_ENDPOINTS.ASSISTANT_STANDBY;
let requests = [];
let replyFor = () => null;
let pendingReplies = [];
let voices = [];
let voiceListeners = [];
const jsonResponse = (payload) => ({ json: () => Promise.resolve(payload) });
const commandRequests = () => requests.filter((r) => r.url === COMMAND_URL).map((r) => r.body);
const sentCommands = () => commandRequests().map((body) => body.content);

let VoiceAssistantPage;

beforeAll(async () => {
  window.SpeechRecognition = FakeRecognition;
  window.HTMLElement.prototype.scrollIntoView = vi.fn();
  global.SpeechSynthesisUtterance = class {
    constructor(text) {
      this.text = text;
    }
  };
  VoiceAssistantPage = (await import('./VoiceAssistantPage')).default;
});

beforeEach(() => {
  vi.useFakeTimers();
  FakeRecognition.instances = [];
  requests = [];
  pendingReplies = [];
  voices = [];
  voiceListeners = [];
  replyFor = (content) => ({
    ok: true, reply_text: `Resposta para ${content}`, tts: { enabled: true, text: 'Resposta falada' },
    conversation: { status: 'browsing_tasks' },
  });
  window.speechSynthesis = {
    speak: vi.fn(),
    cancel: vi.fn(),
    getVoices: vi.fn(() => voices),
    addEventListener: vi.fn((name, listener) => { if (name === 'voiceschanged') voiceListeners.push(listener); }),
    removeEventListener: vi.fn(),
  };
  global.fetch = vi.fn((url, init) => {
    if (url !== COMMAND_URL && url !== STANDBY_URL) return Promise.reject(new Error(`rede real bloqueada: ${url}`));
    const body = init?.body ? JSON.parse(init.body) : {};
    requests.push({ url, body });
    if (url === STANDBY_URL) return Promise.resolve(jsonResponse({ ok: true }));
    const payload = replyFor(body.content, body);
    if (payload instanceof Error) return Promise.reject(payload);
    if (payload) return Promise.resolve(jsonResponse(payload));
    return new Promise((resolve) => { pendingReplies.push((reply) => resolve(jsonResponse(reply))); });
  });
});

afterEach(() => {
  vi.useRealTimers();
});

const settle = () => act(async () => {
  await vi.advanceTimersByTimeAsync(0);
});
const advance = (ms) => act(async () => {
  await vi.advanceTimersByTimeAsync(ms);
});
const statusText = () => document.querySelector('.voice-status').textContent.trim();
const hintText = () => document.querySelector('.voice-interaction-hint')?.textContent || '';
const sessions = () => FakeRecognition.instances;
const lastSession = () => FakeRecognition.instances.at(-1);
const lastUtterance = () => window.speechSynthesis.speak.mock.calls.at(-1)?.[0];
const clickStar = () => fireEvent.click(document.querySelector('.voice-star-btn'));
const clickStandby = () => fireEvent.click(screen.getByRole('button', { name: /^(Standby|Cancelar escuta)$/ }));
const sendTyped = (text) => {
  fireEvent.change(screen.getByRole('textbox'), { target: { value: text } });
  fireEvent.click(screen.getByTitle('Enviar comando'));
};
const ready = (session = lastSession()) => {
  fire(session.onstart);
  fire(session.onaudiostart);
};
// Fala com resultado final e fim da sessao pelo navegador: so o final e enviado.
const say = async (text, session = lastSession()) => {
  fire(session.onresult, resultEvent([[text, true]]));
  fire(session.onend);
  await settle();
};
const startConversation = () => {
  clickStar();
  ready();
};
// Resposta falada ate o fim e retomada: devolve a nova sessao, ja ouvindo.
const finishSpeechAndResume = async () => {
  const utterance = lastUtterance();
  fire(utterance.onstart);
  fire(utterance.onend);
  await advance(400);
  return lastSession();
};

describe('Conversa por voz continua', () => {
  test('toque explicito: a escuta volta sozinha so depois que a voz do assistente termina', async () => {
    render(<VoiceAssistantPage />);
    expect(sessions()).toHaveLength(0); // nada liga sozinho ao abrir a pagina
    startConversation();
    expect(statusText()).toBe('Ouvindo — pode falar');
    await say('minhas tarefas');
    expect(sentCommands()).toEqual(['minhas tarefas']);

    const utterance = lastUtterance();
    fire(utterance.onstart);
    expect(statusText()).toBe('Respondendo');
    await advance(10000); // fala longa: microfone continua desligado enquanto o assistente fala
    expect(sessions()).toHaveLength(1);

    fire(utterance.onend);
    expect(statusText()).toBe('Retomando conversa');
    expect(sessions()).toHaveLength(1); // pausa antes de reabrir (fim do audio do assistente)
    await advance(400);
    expect(sessions()).toHaveLength(2);
    expect(lastSession().start).toHaveBeenCalledTimes(1);
    fire(lastSession().onstart);
    expect(statusText()).toBe('Retomando conversa'); // servico iniciado, audio ainda nao
    fire(lastSession().onaudiostart);
    expect(statusText()).toBe('Ouvindo — pode falar');

    await say('detalhes da primeira');
    expect(sentCommands()).toEqual(['minhas tarefas', 'detalhes da primeira']);
  });

  test('resposta sem voz (tts desligado) ou navegador sem sintese: retoma depois da resposta textual', async () => {
    replyFor = (content) => ({ ok: true, reply_text: `Resposta para ${content}`, tts: { enabled: false } });
    render(<VoiceAssistantPage />);
    startConversation();
    await say('minhas tarefas');
    expect(window.speechSynthesis.speak).not.toHaveBeenCalled();
    await advance(400);
    expect(sessions()).toHaveLength(2);

    delete window.speechSynthesis;
    replyFor = (content) => ({ ok: true, reply_text: `Resposta para ${content}`, tts: { enabled: true, text: 'x' } });
    ready();
    await say('meu perfil');
    await advance(400);
    expect(sessions()).toHaveLength(3);
  });

  test('voz que nao comeca a tempo e cancelada antes de reabrir o microfone', async () => {
    render(<VoiceAssistantPage />);
    startConversation();
    await say('minhas tarefas');
    window.speechSynthesis.cancel.mockClear();
    await advance(5900);
    expect(sessions()).toHaveLength(1);
    await advance(100);
    expect(window.speechSynthesis.cancel).toHaveBeenCalled(); // nunca toca depois com o microfone aberto
    await advance(400);
    expect(sessions()).toHaveLength(2);
  });

  test('Chrome sem onend: a fala que parou de tocar libera a retomada', async () => {
    window.speechSynthesis.speaking = true;
    window.speechSynthesis.pending = false;
    render(<VoiceAssistantPage />);
    startConversation();
    await say('minhas tarefas');
    fire(lastUtterance().onstart);
    await advance(2000);
    expect(sessions()).toHaveLength(1);
    window.speechSynthesis.speaking = false;
    await advance(500 + 400);
    expect(sessions()).toHaveLength(2);
  });

  test('comando digitado nunca liga o microfone, e digitar encerra a conversa por voz', async () => {
    render(<VoiceAssistantPage />);
    sendTyped('minhas tarefas');
    await settle();
    await finishSpeechAndResume();
    await advance(10000);
    expect(sessions()).toHaveLength(0);

    startConversation();
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'meu perfil' } }); // digitar descarta a escuta
    fireEvent.click(screen.getByTitle('Enviar comando'));
    await settle();
    await finishSpeechAndResume();
    await advance(10000);
    expect(sessions()).toHaveLength(1);
  });

  test.each([
    ['durante a captura', async () => {}],
    ['durante o processamento', async () => {
      replyFor = () => null;
      await say('minhas tarefas');
    }],
    ['durante a voz da resposta', async () => {
      await say('minhas tarefas');
      fire(lastUtterance().onstart);
    }],
    ['durante a pausa antes de retomar', async () => {
      await say('minhas tarefas');
      fire(lastUtterance().onstart);
      fire(lastUtterance().onend);
    }],
  ])('Standby %s encerra a conversa: nada reabre o microfone', async (_caso, until) => {
    render(<VoiceAssistantPage />);
    startConversation();
    await until();
    const before = sessions().length;
    clickStandby();
    await settle();
    // Resposta ou fim de fala tardios nao trazem a escuta de volta.
    pendingReplies.forEach((release) => release(replyFor('x') || { ok: true, reply_text: 'tarde' }));
    await settle();
    fire(lastUtterance()?.onend);
    await advance(20000);
    expect(sessions()).toHaveLength(before);
    expect(statusText()).toBe('Standby');
  });

  test('Cancelar a escuta e sair da pagina tambem encerram a conversa', async () => {
    const { unmount } = render(<VoiceAssistantPage />);
    startConversation();
    await say('minhas tarefas');
    await finishSpeechAndResume();
    ready();
    fireEvent.click(screen.getByRole('button', { name: 'Cancelar a escuta' }));
    await advance(20000);
    expect(sessions()).toHaveLength(2);

    clickStar();
    ready();
    await say('meu perfil');
    fire(lastUtterance().onstart);
    fire(lastUtterance().onend);
    unmount(); // durante a pausa antes de retomar
    await advance(20000);
    expect(sessions()).toHaveLength(3);
  });

  test('inatividade: microfone reaberto sem fala por 8 s encerra a conversa, sem novas tentativas', async () => {
    render(<VoiceAssistantPage />);
    startConversation();
    await say('minhas tarefas');
    ready(await finishSpeechAndResume());
    await advance(8000);
    expect(hintText()).toContain('Conversa pausada por falta de fala');
    expect(screen.queryByText(/Não ouvi nenhuma fala/)).not.toBeInTheDocument();
    expect(statusText()).not.toBe('Ouvindo — pode falar');
    await advance(60000);
    expect(sessions()).toHaveLength(2);
    expect(sentCommands()).toEqual(['minhas tarefas']);
  });

  test.each(['not-allowed', 'network', 'audio-capture'])('erro %s na retomada: aviso, estado Erro e retomada so manual', async (error) => {
    render(<VoiceAssistantPage />);
    startConversation();
    await say('minhas tarefas');
    const resumed = await finishSpeechAndResume();
    fire(resumed.onstart);
    fire(resumed.onerror, { error });
    fire(resumed.onend);
    expect(statusText()).toBe('Erro');
    expect(hintText()).toContain('Não consegui retomar o microfone automaticamente');
    await advance(60000);
    expect(sessions()).toHaveLength(2);
  });

  test('erro na primeira escuta (sem retomada) nao entra em loop', async () => {
    render(<VoiceAssistantPage />);
    clickStar();
    fire(lastSession().onstart);
    fire(lastSession().onerror, { error: 'no-speech' });
    fire(lastSession().onend);
    await advance(60000);
    expect(sessions()).toHaveLength(1);
    expect(statusText()).toBe('Erro');
  });

  test('resultado provisorio nao e enviado nem retoma a conversa; o texto fica para conferir', async () => {
    render(<VoiceAssistantPage />);
    startConversation();
    fire(lastSession().onresult, resultEvent([['atribuir a sét', false]]));
    fire(lastSession().onend);
    await advance(20000);
    expect(sentCommands()).toEqual([]);
    expect(screen.getByRole('textbox')).toHaveValue('atribuir a sét');
    expect(sessions()).toHaveLength(1);
  });

  test('callbacks atrasados de sessoes e falas antigas nao mudam a conversa atual', async () => {
    render(<VoiceAssistantPage />);
    startConversation();
    const first = lastSession();
    const oldHandlers = { result: first.onresult, end: first.onend };
    await say('minhas tarefas', first);
    const oldUtterance = lastUtterance();
    const resumed = await finishSpeechAndResume();
    ready(resumed);

    // Eventos tardios da primeira sessao e da fala antiga.
    fire(oldHandlers.result, resultEvent([['confirmar', true]]));
    fire(oldHandlers.end);
    fire(oldUtterance.onend);
    await advance(1000);
    expect(sentCommands()).toEqual(['minhas tarefas']);
    expect(sessions()).toHaveLength(2);
    expect(statusText()).toBe('Ouvindo — pode falar');
  });

  test('uma captura por vez: tocar na estrela durante a pausa substitui a retomada, sem sessao duplicada', async () => {
    render(<VoiceAssistantPage />);
    startConversation();
    await say('minhas tarefas');
    fire(lastUtterance().onstart);
    fire(lastUtterance().onend);
    clickStar();
    await advance(5000);
    expect(sessions()).toHaveLength(2);
    expect(sessions().every((session) => session.start.mock.calls.length === 1)).toBe(true);
  });

  test('"Aguardando resposta" nao finge escuta: aparece so com o microfone desligado', async () => {
    replyFor = () => ({ ok: true, reply_text: 'Qual é o nome?', conversation: { status: 'awaiting_params' } });
    render(<VoiceAssistantPage />);
    sendTyped('criar equipe');
    await settle();
    await advance(7000); // voz nao iniciou: cancelada, sem conversa por voz
    expect(statusText()).toBe('Aguardando resposta');
    expect(document.querySelector('.voice-status.awaiting')).not.toBeNull();
    expect(sessions()).toHaveLength(0);
    expect(hintText()).toContain('Toque na estrela para falar ou digite');
  });
});

describe('Confirmacoes de escrita na conversa por voz', () => {
  const SUMMARY = 'mudar o status da tarefa "Relatório final" para concluída';
  const awaiting = { ok: true, reply_text: `Confirme: ${SUMMARY}.`, tts: { enabled: true, text: 'Confirme.' },
    conversation: { status: 'awaiting_confirmation', operation_id: 'op-1', summary: SUMMARY, expires_in: 120 } };

  test('a voz do resumo nunca e captada: o microfone so volta depois dela, e "confirmar" leva o operationId', async () => {
    replyFor = (content) => (content.startsWith('mudar') ? awaiting
      : { ok: true, reply_text: 'Feito.', conversation: { status: 'completed', operation_id: 'op-1' } });
    render(<VoiceAssistantPage />);
    startConversation();
    await say('mudar status do relatório para concluída');
    fire(lastUtterance().onstart);
    await advance(3000);
    expect(sessions()).toHaveLength(1); // nenhuma escuta enquanto o resumo e falado
    fire(lastUtterance().onend);
    await advance(400);
    ready();
    await say('confirmar');
    expect(commandRequests().at(-1)).toMatchObject({ content: 'confirmar', operationId: 'op-1' });
  });

  test('confirmacao com resposta perdida: estado incerto mantido e nenhuma retomada nem repeticao', async () => {
    replyFor = (content) => (content.startsWith('mudar') ? awaiting : new Error('rede caiu'));
    render(<VoiceAssistantPage />);
    startConversation();
    await say('mudar status do relatório para concluída');
    const resumed = await finishSpeechAndResume();
    ready(resumed);
    await say('confirmar', resumed);
    expect(screen.getByText('Resultado não confirmado')).toBeInTheDocument();
    await advance(60000);
    expect(sessions()).toHaveLength(2);
    expect(sentCommands().filter((c) => c === 'confirmar')).toHaveLength(1);
  });

  test.each([
    ['resultado incerto (retry_pending)', { ok: false, reply_text: 'Não confirmado.', error: 'write_unverified',
      conversation: { status: 'retry_pending', operation_id: 'op-1', summary: SUMMARY } }],
    ['resposta com falha', { ok: false, reply_text: 'Não consegui consultar.', error: 'api_error' }],
  ])('%s: a conversa por voz pausa e nada e repetido', async (_caso, reply) => {
    replyFor = (content) => (content.startsWith('mudar') ? awaiting : reply);
    render(<VoiceAssistantPage />);
    startConversation();
    await say('mudar status do relatório para concluída');
    ready(await finishSpeechAndResume());
    await say('confirmar');
    fire(lastUtterance()?.onstart);
    fire(lastUtterance()?.onend);
    await advance(60000);
    expect(sessions()).toHaveLength(2);
    expect(hintText()).toContain('Conversa por voz pausada');
    expect(sentCommands().filter((c) => c === 'confirmar')).toHaveLength(1);
  });
});

describe('Voz da resposta em portugues do Brasil', () => {
  const voice = (name, lang, extra = {}) => ({ name, lang, default: false, localService: true, ...extra });

  test('vozes carregadas depois da montagem (voiceschanged): usa a brasileira e mantem lang pt-BR', async () => {
    render(<VoiceAssistantPage />);
    voices = [voice('Microsoft David - English', 'en-US', { default: true }), voice('Microsoft Maria - Portuguese (Brazil)', 'pt_BR')];
    act(() => voiceListeners.forEach((listener) => listener()));
    sendTyped('meu perfil');
    await settle();
    expect(lastUtterance().voice.name).toBe('Microsoft Maria - Portuguese (Brazil)');
    expect(lastUtterance().lang).toBe('pt-BR');
    expect(lastUtterance().rate).toBe(1);
  });

  test('sem nenhuma voz em portugues: voz a cargo do navegador, lang pt-BR e aviso na tela', async () => {
    voices = [voice('Microsoft David - English', 'en-US', { default: true })];
    render(<VoiceAssistantPage />);
    sendTyped('meu perfil');
    await settle();
    expect(lastUtterance().voice).toBeUndefined();
    expect(lastUtterance().lang).toBe('pt-BR');
    expect(screen.getByText(/não tem voz em português instalada/)).toBeInTheDocument();
  });
});

describe('Conversa pausada x Aguardando resposta', () => {
  const pauseByInactivity = async () => {
    ready(await finishSpeechAndResume());
    await advance(8000);
  };

  test('consulta respondida e silencio: "Conversa pausada", microfone desligado e contexto preservado', async () => {
    render(<VoiceAssistantPage />);
    startConversation();
    await say('qual o prazo da primeira');
    await pauseByInactivity();
    expect(statusText()).toBe('Conversa pausada');
    expect(document.querySelector('.voice-status.paused')).not.toBeNull();
    expect(hintText()).toContain('Microfone desligado. Toque na estrela para continuar.');
    await advance(60000);
    expect(sessions()).toHaveLength(2); // nenhuma captura durante a pausa

    clickStar();
    ready();
    await say('qual é o status dela');
    const [first, last] = [commandRequests()[0], commandRequests().at(-1)];
    expect(last.conversationId).toBe(first.conversationId); // mesma conversa: o contexto do assistente continua
    expect(sentCommands()).toEqual(['qual o prazo da primeira', 'qual é o status dela']);
  });

  test('listagem respondida a um comando digitado tambem fica como pausada (nada pendente)', async () => {
    render(<VoiceAssistantPage />);
    sendTyped('minhas tarefas');
    await settle();
    expect(statusText()).toBe('Conversa pausada');
    expect(sessions()).toHaveLength(0);
  });

  test.each(['awaiting_params', 'awaiting_task_selection', 'awaiting_task_action'])(
    'pergunta real do assistente (%s) continua "Aguardando resposta" depois da pausa',
    async (conversationStatus) => {
      replyFor = () => ({ ok: true, reply_text: 'Qual?', tts: { enabled: true, text: 'Qual?' },
        conversation: { status: conversationStatus } });
      render(<VoiceAssistantPage />);
      startConversation();
      await say('criar equipe');
      await pauseByInactivity();
      expect(statusText()).toBe('Aguardando resposta');
      expect(hintText()).toContain('Conversa pausada por falta de fala'); // o aviso explica o microfone desligado
    },
  );

  test('confirmacao pendente, vencida ou incerta nunca aparece como "Conversa pausada"', async () => {
    const summary = 'criar a equipe "Vendas"';
    const awaitingReply = (expires = 120) => ({ ok: true, reply_text: `Confirme: ${summary}.`, tts: { enabled: false },
      conversation: { status: 'awaiting_confirmation', operation_id: 'op-9', summary, expires_in: expires } });
    replyFor = (content) => (content === 'criar equipe vendas' ? awaitingReply()
      // Consulta respondida com a confirmacao ainda na tela: continua visivel e nao vira "pausada".
      : { ok: true, reply_text: 'Lista.', tts: { enabled: false }, conversation: { status: 'browsing_tasks' } });
    render(<VoiceAssistantPage />);
    sendTyped('criar equipe vendas');
    await settle();
    expect(statusText()).toBe('Aguardando resposta');
    sendTyped('minhas tarefas');
    await settle();
    expect(screen.getByText('Confirme a operação')).toBeInTheDocument();
    expect(statusText()).not.toBe('Conversa pausada');

    await advance(121000); // prazo vencido: cartao "Prazo encerrado" continua visivel, sem "pausada"
    expect(screen.getByText('Prazo encerrado')).toBeInTheDocument();
    expect(statusText()).not.toBe('Conversa pausada');
  });

  test('confirmacao com resultado incerto: cartao visivel e indicador sem "pausada"', async () => {
    const summary = 'mudar o status da tarefa "Relatório final" para concluída';
    replyFor = (content) => (content.startsWith('mudar') ? { ok: true, reply_text: 'Confirme.', tts: { enabled: false },
      conversation: { status: 'awaiting_confirmation', operation_id: 'op-1', summary, expires_in: 120 } }
      : new Error('rede caiu'));
    render(<VoiceAssistantPage />);
    sendTyped('mudar status do relatório para concluída');
    await settle();
    sendTyped('confirmar');
    await settle();
    expect(screen.getByText('Resultado não confirmado')).toBeInTheDocument();
    expect(statusText()).not.toBe('Conversa pausada');
  });
});

describe('Diagnostico de latencia (flowly:voice-debug)', () => {
  afterEach(() => localStorage.removeItem('flowly:voice-debug'));

  test('separa as etapas do microfone, da fala, da resposta e da retomada, sem conteudo', async () => {
    localStorage.setItem('flowly:voice-debug', '1');
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    render(<VoiceAssistantPage />);
    clickStar();
    fire(lastSession().onstart);
    fire(lastSession().onaudiostart);
    fire(lastSession().onspeechend);
    await say('minhas tarefas');
    const resumed = await finishSpeechAndResume();
    fire(resumed.onstart);
    fire(resumed.onaudiostart);

    const steps = info.mock.calls.map((call) => call[1]);
    // PR #69: resposta-ate-sintese, voz (estado) e sintese-ate-onstart detalham o intervalo resposta -> voz.
    expect(steps).toEqual([
      'clique-ate-start', 'start-ate-onstart', 'onstart-ate-audio', 'microfone-pronto',
      'ultimo-resultado-ate-final', 'fala-encerrada-ate-final', 'envio', 'resposta',
      'resposta-ate-sintese', 'voz', 'sintese-ate-onstart', 'inicio-da-voz',
      'espera-da-retomada', 'start-ate-onstart', 'onstart-ate-audio', 'retomada-ate-pronto', 'retomada',
    ]);
    // Estados tecnicos: so valores fixos (perfil da voz, pausa em ms).
    const ESTADOS = new Set(['tecnologica', 'original', 'padrao-do-navegador']);
    info.mock.calls.forEach((call) => {
      expect(call).toHaveLength(3);
      expect(call[0]).toBe('[flowly:voz]');
      if (call[1] === 'voz') expect(ESTADOS.has(call[2])).toBe(true);
      else expect(call[2]).toMatch(/^\d+ ms$/);
      expect(call.join(' ')).not.toMatch(/minhas tarefas|Resposta|Bearer|voice-/);
    });
    info.mockRestore();
  });

  test('desligado por padrao: nada no console', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    render(<VoiceAssistantPage />);
    startConversation();
    await say('minhas tarefas');
    await finishSpeechAndResume();
    expect(info).not.toHaveBeenCalled();
    info.mockRestore();
  });
});

// PR #69: voz tecnologica (Microsoft Daniel) pela identidade, fallback pt-BR, lista de vozes tardia, sintese sem
// cancel desnecessario e retomada em 250 ms so depois do fim confirmado da voz.
describe('PR #69: voz do assistente e latencia', () => {
  const voz = (name, lang, extra = {}) => ({ name, voiceURI: name, lang, default: false, localService: true, ...extra });
  const DANIEL = voz('Microsoft Daniel - Portuguese (Brazil)', 'pt-BR');
  const MARIA = voz('Microsoft Maria - Portuguese (Brazil)', 'pt-BR');
  const GOOGLE = voz('Google português do Brasil', 'pt-BR', { localService: false });

  beforeEach(() => {
    localStorage.clear();
    redefinirCacheDePreferencias();
  });

  test('voz tecnologica por padrao: Daniel pela identidade (nao pela posicao), pitch 0.75, rate 1.05, volume 1', async () => {
    voices = [MARIA, GOOGLE, voz('Microsoft David - English', 'en-US', { default: true }), DANIEL];
    render(<VoiceAssistantPage />);
    sendTyped('meu perfil');
    await settle();
    const fala = lastUtterance();
    expect(fala.voice).toBe(DANIEL);
    expect(fala.lang).toBe('pt-BR');
    expect([fala.pitch, fala.rate, fala.volume]).toEqual([0.75, 1.05, 1]);
  });

  test('sem Daniel: comportamento original em pt-BR (rate 1, pitch do navegador); "Daniel" ingles nunca e usado', async () => {
    voices = [voz('Daniel', 'en-GB'), MARIA, GOOGLE];
    render(<VoiceAssistantPage />);
    sendTyped('meu perfil');
    await settle();
    const fala = lastUtterance();
    expect(fala.voice).toBe(GOOGLE);
    expect(fala.rate).toBe(1);
    expect(fala.pitch).toBeUndefined();
  });

  test('preferencia "Voz original" da conta: mesmo com Daniel, fica a voz anterior', async () => {
    localStorage.setItem('id', 'conta-1');
    definirPreferencia('vozAssistente', 'original');
    voices = [DANIEL, GOOGLE];
    render(<VoiceAssistantPage />);
    sendTyped('meu perfil');
    await settle();
    expect(lastUtterance().voice).toBe(GOOGLE);
    expect(lastUtterance().rate).toBe(1);
  });

  test('lista de vozes vazia: a resposta fala na hora (lang pt-BR, sem voz); quando a lista chega, passa a usar Daniel', async () => {
    voices = [];
    render(<VoiceAssistantPage />);
    sendTyped('meu perfil');
    await settle();
    expect(window.speechSynthesis.speak).toHaveBeenCalledTimes(1);
    expect(lastUtterance().voice).toBeUndefined();
    expect(lastUtterance().lang).toBe('pt-BR');

    voices = [MARIA, DANIEL];
    act(() => voiceListeners.forEach((listener) => listener()));
    sendTyped('minhas tarefas');
    await settle();
    expect(lastUtterance().voice).toBe(DANIEL);
  });

  test('voz escolhida antes e reaproveitada; lista nova (objetos novos) escolhe de novo, sem referencia invalida', async () => {
    voices = [DANIEL];
    render(<VoiceAssistantPage />);
    sendTyped('meu perfil');
    await settle();
    const chamadasAntes = window.speechSynthesis.getVoices.mock.calls.length;
    sendTyped('minhas tarefas');
    await settle();
    expect(window.speechSynthesis.getVoices.mock.calls.length).toBe(chamadasAntes);
    const danielNovo = { ...DANIEL };
    voices = [danielNovo];
    act(() => voiceListeners.forEach((listener) => listener()));
    sendTyped('meu perfil');
    await settle();
    expect(lastUtterance().voice).toBe(danielNovo);
  });

  test('sintese: sem fala tocando, nao chama cancel antes de speak; com fala tocando, cancela antes', async () => {
    window.speechSynthesis.speaking = false;
    window.speechSynthesis.pending = false;
    render(<VoiceAssistantPage />);
    window.speechSynthesis.cancel.mockClear();
    sendTyped('meu perfil');
    await settle();
    expect(window.speechSynthesis.speak).toHaveBeenCalledTimes(1);
    expect(window.speechSynthesis.cancel).not.toHaveBeenCalled();

    window.speechSynthesis.speaking = true;
    sendTyped('minhas tarefas');
    await settle();
    expect(window.speechSynthesis.cancel).toHaveBeenCalled();
    expect(window.speechSynthesis.speak).toHaveBeenCalledTimes(2);
  });

  test('retomada: nada de microfone durante a voz; nova escuta 250 ms depois do fim confirmado, uma sessao so', async () => {
    render(<VoiceAssistantPage />);
    startConversation();
    await say('minhas tarefas');
    const fala = lastUtterance();
    fire(fala.onstart);
    await advance(3000); // voz ainda tocando
    expect(sessions()).toHaveLength(1);
    fire(fala.onend);
    await advance(249);
    expect(sessions()).toHaveLength(1);
    await advance(1);
    expect(sessions()).toHaveLength(2);
    expect(lastSession().start).toHaveBeenCalledTimes(1);
    fire(fala.onend); // fim repetido nao abre outra sessao
    await advance(1000);
    expect(sessions()).toHaveLength(2);
  });

  test('Standby durante a voz cancela a fala e a retomada', async () => {
    render(<VoiceAssistantPage />);
    startConversation();
    await say('minhas tarefas');
    const fala = lastUtterance();
    fire(fala.onstart);
    clickStandby();
    await settle();
    fire(fala.onend);
    await advance(2000);
    expect(sessions()).toHaveLength(1);
    expect(window.speechSynthesis.cancel).toHaveBeenCalled();
  });

  test('diagnostico: pausa de conclusao e etapas novas so com tempos e estados tecnicos', async () => {
    localStorage.setItem('flowly:voice-debug', '1');
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    voices = [DANIEL];
    render(<VoiceAssistantPage />);
    startConversation();
    fire(lastSession().onresult, resultEvent([['minhas tarefas', true]]));
    await advance(1400);
    expect(lastSession().stop).toHaveBeenCalledTimes(1);
    fire(lastSession().onend);
    await settle();
    const registros = info.mock.calls.map((call) => [call[1], call[2]]);
    expect(registros).toContainEqual(['pausa-de-conclusao', '1400 ms']);
    expect(registros).toContainEqual(['voz', 'tecnologica']);
    expect(registros.map(([etapa]) => etapa)).toEqual(expect.arrayContaining([
      'ultimo-resultado-ate-stop', 'stop-ate-final', 'ultimo-resultado-ate-final', 'envio', 'resposta', 'resposta-ate-sintese',
    ]));
    info.mock.calls.forEach((call) => expect(call.join(' ')).not.toMatch(/minhas tarefas|Resposta|Bearer|Daniel/));
    info.mockRestore();
  });
});
