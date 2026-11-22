// Captura e envio de voz: SpeechRecognition, speechSynthesis e fetch simulados; rede real bloqueada.
import { act, fireEvent, render, screen } from '@testing-library/react';
import { API_ENDPOINTS } from '../../config/config';

vi.mock('../../components/layout/Sidebar', () => ({
  __esModule: true,
  default: () => null,
}));

// Na suite completa, sob carga, a primeira renderizacao passou de 5 s; um teste que estoura o tempo
// deixa o act aberto e derruba os seguintes do arquivo.
vi.setConfig({ testTimeout: 20000, hookTimeout: 30000 });

// Reconhecimento falso: guarda cada sessao criada e deixa o teste disparar os eventos como o navegador.
class FakeRecognition {
  static instances = [];

  static startError = null;

  static withoutAudioStart = false;

  constructor() {
    this.start = vi.fn(() => {
      if (FakeRecognition.startError) throw FakeRecognition.startError;
    });
    this.stop = vi.fn();
    this.abort = vi.fn();
    // O Chrome anuncia o evento audiostart; alguns navegadores nao.
    if (!FakeRecognition.withoutAudioStart) this.onaudiostart = null;
    FakeRecognition.instances.push(this);
  }
}

// Evento de resultado: entries = [[texto, isFinal], ...], cumulativo como no navegador.
const resultEvent = (entries, resultIndex = 0) => ({
  resultIndex,
  results: entries.map(([transcript, isFinal]) => Object.assign([{ transcript, confidence: 0.9 }], { isFinal })),
});

// Chama o handler registrado agora (ou um capturado antes), como o navegador faria.
const fire = (handler, event = {}) => act(() => {
  handler?.(event);
});

const COMMAND_URL = API_ENDPOINTS.ASSISTANT_COMMAND;
const STANDBY_URL = API_ENDPOINTS.ASSISTANT_STANDBY;
let requests = [];
let replyFor = () => null; // null: a resposta fica pendente ate o teste liberar
let pendingReplies = [];

const jsonResponse = (payload) => ({ json: () => Promise.resolve(payload) });
const sentCommands = () => requests.filter((r) => r.url === COMMAND_URL).map((r) => r.body.content);
const standbyCalls = () => requests.filter((r) => r.url === STANDBY_URL);

let VoiceAssistantPage;

beforeAll(async () => {
  window.SpeechRecognition = FakeRecognition;
  window.HTMLElement.prototype.scrollIntoView = vi.fn();
  global.SpeechSynthesisUtterance = class {
    constructor(text) {
      this.text = text;
    }
  };
  // O componente le window.SpeechRecognition ao carregar o modulo.
  VoiceAssistantPage = (await import('./VoiceAssistantPage')).default;
});

beforeEach(() => {
  FakeRecognition.instances = [];
  FakeRecognition.startError = null;
  FakeRecognition.withoutAudioStart = false;
  requests = [];
  pendingReplies = [];
  replyFor = () => null;
  window.speechSynthesis = { speak: vi.fn(), cancel: vi.fn() };
  global.fetch = vi.fn((url, init) => {
    if (url !== COMMAND_URL && url !== STANDBY_URL) {
      return Promise.reject(new Error(`rede real bloqueada: ${url}`));
    }
    requests.push({ url, body: init?.body ? JSON.parse(init.body) : {} });
    if (url === STANDBY_URL) return Promise.resolve(jsonResponse({ ok: true, status: 'standby' }));
    const payload = replyFor(JSON.parse(init.body).content);
    if (payload) return Promise.resolve(jsonResponse(payload));
    return new Promise((resolve) => {
      pendingReplies.push((reply) => resolve(jsonResponse(reply)));
    });
  });
});

const flush = () => act(async () => {
  await new Promise((resolve) => setTimeout(resolve, 0));
});

const input = () => screen.getByRole('textbox');
const lastSession = () => FakeRecognition.instances.at(-1);
const statusText = () => document.querySelector('.voice-status').textContent.trim();
const clickSend = () => fireEvent.click(screen.getByTitle('Enviar comando'));
const pressEnter = () => fireEvent.submit(screen.getByTitle('Enviar comando').closest('form'));
const clickConclude = () => fireEvent.click(screen.getByRole('button', { name: 'Concluir fala' }));
const clickCancel = () => fireEvent.click(screen.getByRole('button', { name: 'Cancelar escuta' }));
const sendTyped = (text) => {
  fireEvent.change(input(), { target: { value: text } });
  clickSend();
};

function startListening() {
  fireEvent.click(screen.getByRole('button', { name: 'Iniciar escuta' }));
  const session = lastSession();
  fire(session.onstart);
  fire(session.onaudiostart);
  return session;
}

function capturedHandlers(session) {
  return { result: session.onresult, error: session.onerror, end: session.onend };
}

describe('R1: resultado provisorio nunca vira comando', () => {
  test('provisorio seguido de erro: zero envios; o texto so vai para o campo para conferencia', async () => {
    render(<VoiceAssistantPage />);
    const session = startListening();
    fire(session.onresult, resultEvent([['atribuir a 1', false]]));
    expect(input()).toHaveValue('atribuir a 1');
    fire(session.onerror, { error: 'network' });
    fire(session.onend);
    await flush();

    expect(sentCommands()).toEqual([]);
    expect(input()).toHaveValue('atribuir a 1');
    expect(screen.getByText(/Ouvi “atribuir a 1”, mas o navegador não confirmou a frase e ela pode estar incompleta. Nada foi enviado/)).toBeInTheDocument();
    expect(statusText()).toBe('Standby');
  });

  test('provisorio seguido de fim sem resultado final: zero envios', async () => {
    render(<VoiceAssistantPage />);
    const session = startListening();
    fire(session.onresult, resultEvent([['meu per', false]]));
    fire(session.onend);
    await flush();

    expect(sentCommands()).toEqual([]);
    expect(input()).toHaveValue('meu per');
    expect(screen.getByText(/Ouvi “meu per”/)).toBeInTheDocument();
  });

  test('provisorio seguido de final: envia so o resultado final', async () => {
    render(<VoiceAssistantPage />);
    const session = startListening();
    fire(session.onresult, resultEvent([['meu', false]]));
    fire(session.onresult, resultEvent([['meu per', false]]));
    fire(session.onresult, resultEvent([['meu perfil', true]]));
    fire(session.onend);
    await flush();

    expect(sentCommands()).toEqual(['meu perfil']);
  });

  test('varios resultados finais, inclusive em eventos separados, nao perdem palavras', async () => {
    render(<VoiceAssistantPage />);
    let session = startListening();
    fire(session.onresult, resultEvent([['listar', true], ['equipes', true]]));
    fire(session.onend);
    await flush();
    act(() => pendingReplies.shift()({ ok: true, reply_text: 'ok' }));
    await flush();

    session = startListening();
    fire(session.onresult, resultEvent([['listar', true]]));
    fire(session.onresult, resultEvent([['listar', true], [' equipes', true]], 1));
    fire(session.onend);
    await flush();

    expect(sentCommands()).toEqual(['listar equipes', 'listar equipes']);
  });

  test('resultado final seguido de erro tardio: o final vale e e enviado uma vez', async () => {
    render(<VoiceAssistantPage />);
    const session = startListening();
    const late = capturedHandlers(session);
    fire(session.onresult, resultEvent([['meu perfil', true]]));
    fire(session.onerror, { error: 'network' });
    fire(late.end);
    fire(late.error, { error: 'network' });
    await flush();

    expect(sentCommands()).toEqual(['meu perfil']);
    expect(screen.queryByText(/não respondeu/)).not.toBeInTheDocument();
  });

  test('final com trecho provisorio depois e erro: nada enviado, frase inteira para conferencia', async () => {
    render(<VoiceAssistantPage />);
    const session = startListening();
    fire(session.onresult, resultEvent([['atribuir a', true], ['11 para', false]]));
    fire(session.onerror, { error: 'network' });
    await flush();

    expect(sentCommands()).toEqual([]);
    expect(input()).toHaveValue('atribuir a 11 para');
  });
});

describe('R2: concluir pede o resultado final; cancelar descarta a captura', () => {
  test('concluir no microfone usa stop, envia o final uma vez e ignora eventos repetidos', async () => {
    render(<VoiceAssistantPage />);
    const session = startListening();
    fire(session.onresult, resultEvent([['minhas tare', false]]));
    const late = capturedHandlers(session);

    clickConclude();
    expect(session.stop).toHaveBeenCalledTimes(1);
    expect(session.abort).not.toHaveBeenCalled();
    expect(statusText()).toBe('Finalizando a fala'); // distinto do "Processando" do pedido ao assistente
    // O navegador entrega o resultado final do que ouviu e encerra.
    fire(session.onresult, resultEvent([['minhas tarefas', true]]));
    fire(session.onend);
    fire(late.result, resultEvent([['minhas tarefas', true]]));
    fire(late.end);
    await flush();

    expect(sentCommands()).toEqual(['minhas tarefas']);
  });

  test('concluir sem resultado final: nada enviado e o texto fica para conferencia', async () => {
    render(<VoiceAssistantPage />);
    const session = startListening();
    fire(session.onresult, resultEvent([['listar equi', false]]));
    clickConclude();
    fire(session.onend);
    await flush();

    expect(sentCommands()).toEqual([]);
    expect(input()).toHaveValue('listar equi');
    expect(screen.getByRole('button', { name: 'Iniciar escuta' })).toBeEnabled();
  });

  test('concluir sem resposta do navegador: a sessao fecha sozinha e o final e enviado uma vez', async () => {
    vi.useFakeTimers();
    try {
      render(<VoiceAssistantPage />);
      const session = startListening();
      const late = capturedHandlers(session);
      fire(session.onresult, resultEvent([['meu perfil', true]]));
      clickConclude();
      expect(sentCommands()).toEqual([]);
      act(() => {
        vi.advanceTimersByTime(4000);
      });
      expect(session.abort).toHaveBeenCalledTimes(1);
      expect(sentCommands()).toEqual(['meu perfil']);
      fire(late.end);
      expect(sentCommands()).toEqual(['meu perfil']);
    } finally {
      vi.useRealTimers();
    }
  });

  test('Cancelar escuta (o Standby durante a escuta) descarta a captura', async () => {
    render(<VoiceAssistantPage />);
    const session = startListening();
    fire(session.onresult, resultEvent([['minhas tare', false]]));
    const late = capturedHandlers(session);
    clickCancel();
    // O navegador ainda pode entregar o que ouviu e encerrar depois do cancelamento.
    fire(late.result, resultEvent([['meu perfil', true]]));
    fire(late.end);
    fire(session.onresult, resultEvent([['meu perfil', true]]));
    fire(session.onend);
    await flush();

    expect(session.abort).toHaveBeenCalledTimes(1);
    expect(session.stop).not.toHaveBeenCalled();
    expect(sentCommands()).toEqual([]);
    expect(input()).toHaveValue('');
    expect(standbyCalls()).toHaveLength(1);
    expect(standbyCalls()[0].body.conversationId).toMatch(/^voice-/);
    expect(statusText()).toBe('Standby');
  });

  test('erro tardio de uma sessao cancelada nao gera mensagem', async () => {
    render(<VoiceAssistantPage />);
    const session = startListening();
    const late = capturedHandlers(session);
    clickCancel();
    fire(late.error, { error: 'aborted' });
    fire(late.end);
    await flush();

    expect(document.querySelectorAll('.voice-message.assistant')).toHaveLength(1); // so a boas-vindas
  });

  test('sair da pagina durante a escuta aborta e nao envia depois', async () => {
    const { unmount } = render(<VoiceAssistantPage />);
    const session = startListening();
    fire(session.onresult, resultEvent([['atribuir a 3', false]]));
    const late = capturedHandlers(session);
    unmount();
    fire(late.result, resultEvent([['atribuir a 3 para mim', true]]));
    fire(late.end);
    await flush();

    expect(session.abort).toHaveBeenCalledTimes(1);
    expect(sentCommands()).toEqual([]);
    expect(standbyCalls()).toHaveLength(1);
  });

  test('nova sessao depois de cancelar funciona, e eventos da antiga nao a afetam', async () => {
    render(<VoiceAssistantPage />);
    const first = startListening();
    const late = capturedHandlers(first);
    clickCancel();
    await flush();

    const second = startListening();
    fire(late.result, resultEvent([['atribuir a 1', true]]));
    fire(late.end);
    expect(input()).toHaveValue('');
    fire(second.onresult, resultEvent([['meu perfil', true]]));
    fire(second.onend);
    await flush();

    expect(sentCommands()).toEqual(['meu perfil']);
  });
});

describe('R3: no maximo um envio por sessao', () => {
  test('texto digitado enviado durante a escuta: um envio e a captura e cancelada', async () => {
    render(<VoiceAssistantPage />);
    fireEvent.change(input(), { target: { value: 'listar equipes' } });
    const session = startListening();
    const late = capturedHandlers(session);

    // A escuta ainda nao entregou nada: o campo tem o texto digitado, que pode ser enviado.
    clickSend();
    fire(late.result, resultEvent([['meu perfil', true]]));
    fire(late.end);
    await flush();

    expect(sentCommands()).toEqual(['listar equipes']);
    expect(session.abort).toHaveBeenCalledTimes(1);
  });

  test('dois resultados finais e dois onend: um envio', async () => {
    render(<VoiceAssistantPage />);
    const session = startListening();
    const late = capturedHandlers(session);
    fire(session.onresult, resultEvent([['listar equipes', true]]));
    fire(session.onresult, resultEvent([['listar equipes', true]]));
    fire(session.onend);
    fire(late.end);
    fire(session.onend);
    await flush();

    expect(sentCommands()).toEqual(['listar equipes']);
  });

  test('cliques rapidos no enviar: um envio enquanto a resposta esta pendente', async () => {
    render(<VoiceAssistantPage />);
    fireEvent.change(input(), { target: { value: 'meu perfil' } });
    const send = screen.getByTitle('Enviar comando');
    fireEvent.click(send);
    fireEvent.click(send);
    fireEvent.submit(send.closest('form'));
    await flush();

    expect(sentCommands()).toEqual(['meu perfil']);
  });

  test('com uma resposta pendente, outro envio e ignorado', async () => {
    render(<VoiceAssistantPage />);
    fireEvent.change(input(), { target: { value: 'listar equipes' } });
    const session = startListening();
    fire(session.onresult, resultEvent([['meu perfil', true]]));
    fire(session.onend);
    await flush();
    // O texto digitado voltou ao campo; um submit com a resposta ainda pendente nao gera outro envio.
    expect(input()).toHaveValue('listar equipes');
    pressEnter();
    await flush();

    expect(sentCommands()).toEqual(['meu perfil']);
  });

  test('sessao encerrada nao envia de novo enquanto a resposta esta pendente', async () => {
    render(<VoiceAssistantPage />);
    const session = startListening();
    const late = capturedHandlers(session);
    fire(late.result, resultEvent([['meu perfil', true]]));
    fire(late.end);
    await flush();
    expect(sentCommands()).toEqual(['meu perfil']);

    // Eventos repetidos da mesma sessao com a resposta ainda pendente.
    fire(late.result, resultEvent([['meu perfil', true]]));
    fire(late.end);
    await flush();
    expect(sentCommands()).toEqual(['meu perfil']);
    expect(screen.getByRole('button', { name: 'Iniciar escuta' })).toBeDisabled();

    act(() => pendingReplies.shift()({ ok: true, reply_text: 'Seu perfil: Pessoa Teste, conta de colaborador.' }));
    await flush();
    expect(screen.getByText('Seu perfil: Pessoa Teste, conta de colaborador.')).toBeInTheDocument();
    expect(sentCommands()).toEqual(['meu perfil']);
  });
});

describe('Enviar nunca executa a transcricao da sessao em andamento', () => {
  test('resultado provisorio seguido de Enviar: zero chamadas; depois do fim, so com confirmacao', async () => {
    render(<VoiceAssistantPage />);
    const session = startListening();
    fire(session.onresult, resultEvent([['atribuir a 1', false]]));
    expect(input()).toHaveValue('atribuir a 1');
    clickSend();
    pressEnter();
    await flush();

    expect(sentCommands()).toEqual([]);
    expect(session.abort).not.toHaveBeenCalled();
    // A sessao termina sem resultado final: nada e enviado; o texto fica no campo para conferencia.
    fire(session.onend);
    await flush();
    expect(sentCommands()).toEqual([]);
    expect(input()).toHaveValue('atribuir a 1');
    // So um toque explicito em Enviar, ja sem sessao ativa, envia o texto conferido.
    clickSend();
    await flush();
    expect(sentCommands()).toEqual(['atribuir a 1']);
  });

  test('provisorio com texto digitado antes da escuta: nada enviado e o rascunho volta', async () => {
    render(<VoiceAssistantPage />);
    fireEvent.change(input(), { target: { value: 'listar equipes' } });
    const session = startListening();
    fire(session.onresult, resultEvent([['atribuir a 1', false]]));
    // O campo mostra so a transcricao, sem misturar com o texto digitado.
    expect(input()).toHaveValue('atribuir a 1');
    clickSend();
    pressEnter();
    await flush();
    expect(sentCommands()).toEqual([]);

    fire(session.onerror, { error: 'network' });
    fire(session.onend);
    await flush();
    expect(sentCommands()).toEqual([]);
    expect(input()).toHaveValue('listar equipes');
    expect(screen.getByText(/o texto que você digitou continua no campo/)).toBeInTheDocument();
  });

  test('resultado final aguardando onend: Enviar nao antecipa nem duplica', async () => {
    render(<VoiceAssistantPage />);
    const session = startListening();
    fire(session.onresult, resultEvent([['meu perfil', true]]));
    clickSend();
    pressEnter();
    await flush();
    expect(sentCommands()).toEqual([]);

    fire(session.onend);
    await flush();
    clickSend();
    pressEnter();
    await flush();
    expect(sentCommands()).toEqual(['meu perfil']);
  });

  test('digitar durante a escuta e enviar o proprio texto: uma chamada', async () => {
    render(<VoiceAssistantPage />);
    const session = startListening();
    const late = capturedHandlers(session);
    fire(session.onresult, resultEvent([['atribuir a 1', false]]));
    fireEvent.change(input(), { target: { value: 'meu perfil' } });
    clickSend();
    fire(late.result, resultEvent([['atribuir a 1', true]]));
    fire(late.end);
    await flush();

    expect(session.abort).toHaveBeenCalledTimes(1);
    expect(sentCommands()).toEqual(['meu perfil']);
  });

  test('fluxo normal: resultado final e onend geram uma chamada', async () => {
    render(<VoiceAssistantPage />);
    const session = startListening();
    fire(session.onresult, resultEvent([['listar equipes', false]]));
    fire(session.onresult, resultEvent([['listar equipes', true]]));
    fire(session.onend);
    await flush();

    expect(requests.filter((r) => r.url === COMMAND_URL)).toHaveLength(1);
    expect(sentCommands()).toEqual(['listar equipes']);
  });
});

describe('Falhas do reconhecimento: mensagem por tipo, nada enviado e microfone livre', () => {
  const MESSAGES = {
    'no-speech': /Não ouvi nenhuma fala/,
    'audio-capture': /Não encontrei um microfone funcionando/,
    'not-allowed': /O microfone está bloqueado para este site/,
    'service-not-allowed': /não permite o reconhecimento de voz neste site/,
    network: /O serviço de reconhecimento de voz do navegador não respondeu/,
    'language-not-supported': /não reconhece fala em português/,
    aborted: /A escuta foi interrompida pelo navegador/,
  };

  test.each(Object.entries(MESSAGES))('%s sem transcricao', async (error, message) => {
    render(<VoiceAssistantPage />);
    const session = startListening();
    fire(session.onerror, { error });
    fire(session.onend);
    await flush();

    expect(screen.getByText(message)).toBeInTheDocument();
    expect(sentCommands()).toEqual([]);
    expect(statusText()).toBe('Standby');
    // Recuperacao: a proxima tentativa abre uma sessao nova normalmente.
    const next = startListening();
    fire(next.onresult, resultEvent([['meu perfil', true]]));
    fire(next.onend);
    await flush();
    expect(sentCommands()).toEqual(['meu perfil']);
  });

  test('network no Brave explica que o navegador nao oferece o reconhecimento', async () => {
    Object.defineProperty(navigator, 'brave', { value: { isBrave: () => Promise.resolve(true) }, configurable: true });
    try {
      render(<VoiceAssistantPage />);
      const session = startListening();
      fire(session.onerror, { error: 'network' });
      await flush();
      expect(screen.getByText(/O Brave não oferece o reconhecimento de voz/)).toBeInTheDocument();
    } finally {
      delete navigator.brave;
    }
  });

  test('no-speech com transcricao provisoria: texto para conferencia, nada enviado', async () => {
    render(<VoiceAssistantPage />);
    const session = startListening();
    fire(session.onresult, resultEvent([['minhas equipes', false]]));
    fire(session.onerror, { error: 'no-speech' });
    await flush();

    expect(sentCommands()).toEqual([]);
    expect(input()).toHaveValue('minhas equipes');
    expect(screen.queryByText(/Não ouvi nenhuma fala/)).not.toBeInTheDocument();
  });

  test('fim sem resultado: diferencia silencio de fala nao transcrita', async () => {
    render(<VoiceAssistantPage />);
    let session = startListening();
    fire(session.onend);
    await flush();
    expect(screen.getByText(/Não ouvi nenhuma fala/)).toBeInTheDocument();

    session = startListening();
    fire(session.onspeechstart);
    fire(session.onend);
    await flush();
    expect(screen.getByText(/Ouvi sua voz, mas o navegador não conseguiu transcrever/)).toBeInTheDocument();
    expect(sentCommands()).toEqual([]);
  });

  test('tres falhas seguidas trazem uma orientacao, sem novas tentativas automaticas', async () => {
    render(<VoiceAssistantPage />);
    for (let i = 0; i < 4; i += 1) {
      const session = startListening();
      fire(session.onerror, { error: 'no-speech' });
      await flush();
    }

    expect(screen.getAllByText(/falhou 3 vezes seguidas/)).toHaveLength(1);
    expect(FakeRecognition.instances).toHaveLength(4);
    expect(sentCommands()).toEqual([]);
  });

  test('erro sincrono no start mostra aviso e permite tentar de novo', async () => {
    FakeRecognition.startError = new Error('InvalidStateError');
    render(<VoiceAssistantPage />);
    fireEvent.click(screen.getByRole('button', { name: 'Iniciar escuta' }));
    await flush();

    expect(screen.getByText(/Não consegui ligar o microfone agora/)).toBeInTheDocument();
    expect(statusText()).toBe('Standby');
    expect(sentCommands()).toEqual([]);

    FakeRecognition.startError = null;
    const session = startListening();
    fire(session.onresult, resultEvent([['meu perfil', true]]));
    fire(session.onend);
    await flush();
    expect(FakeRecognition.instances).toHaveLength(2);
    expect(sentCommands()).toEqual(['meu perfil']);
  });
});

describe('R5: inicio e encerramento', () => {
  test('clique duplo no microfone cria uma unica sessao e mostra que esta iniciando', () => {
    render(<VoiceAssistantPage />);
    const mic = screen.getByRole('button', { name: 'Iniciar escuta' });
    fireEvent.click(mic);
    fireEvent.click(mic);

    expect(FakeRecognition.instances).toHaveLength(1);
    expect(lastSession().start).toHaveBeenCalledTimes(1);
    expect(statusText()).toBe('Iniciando');
    fire(lastSession().onstart);
    expect(statusText()).toBe('Iniciando');
    fire(lastSession().onaudiostart);
    expect(statusText()).toBe('Ouvindo — pode falar');
  });

  test('dois cliques no mesmo ciclo de renderizacao tambem criam uma unica sessao', () => {
    render(<VoiceAssistantPage />);
    const mic = screen.getByRole('button', { name: 'Iniciar escuta' });
    act(() => {
      mic.click();
      mic.click();
    });

    expect(FakeRecognition.instances).toHaveLength(1);
  });

  test('configuracao: pt-BR, continuo limitado a uma fala e com resultados provisorios', () => {
    render(<VoiceAssistantPage />);
    const session = startListening();

    expect(session.lang).toBe('pt-BR');
    // Continuo para a pausa nao cortar a frase; a propria pagina conclui (ver "Escuta limitada a uma fala").
    expect(session.continuous).toBe(true);
    expect(session.interimResults).toBe(true);
  });
});

describe('Texto digitado nao se mistura com a transcricao', () => {
  test('texto digitado volta ao campo se a captura falha', async () => {
    render(<VoiceAssistantPage />);
    fireEvent.change(input(), { target: { value: 'listar equipes' } });
    const session = startListening();
    fire(session.onresult, resultEvent([['meu', false]]));
    fire(session.onerror, { error: 'no-speech' });
    fire(session.onend);
    await flush();

    expect(input()).toHaveValue('listar equipes');
    expect(sentCommands()).toEqual([]);
  });

  test('comando falado e enviado sem levar o texto digitado, que continua no campo', async () => {
    render(<VoiceAssistantPage />);
    fireEvent.change(input(), { target: { value: 'listar equipes' } });
    const session = startListening();
    fire(session.onresult, resultEvent([['meu perfil', true]]));
    fire(session.onend);
    await flush();

    expect(sentCommands()).toEqual(['meu perfil']);
    expect(input()).toHaveValue('listar equipes');
  });

  test('digitar durante a escuta cancela a captura e o texto nao e sobrescrito', async () => {
    render(<VoiceAssistantPage />);
    const session = startListening();
    const late = capturedHandlers(session);
    fire(session.onresult, resultEvent([['meu perf', false]]));
    fireEvent.change(input(), { target: { value: 'listar equipes' } });
    fire(late.result, resultEvent([['meu perfil', true]]));
    fire(late.end);
    await flush();

    expect(session.abort).toHaveBeenCalledTimes(1);
    expect(input()).toHaveValue('listar equipes');
    expect(sentCommands()).toEqual([]);

    clickSend();
    await flush();
    expect(sentCommands()).toEqual(['listar equipes']);
  });

  test('comando digitado e depois comando falado: um envio de cada', async () => {
    replyFor = (content) => ({ ok: true, reply_text: `ok ${content}` });
    render(<VoiceAssistantPage />);
    sendTyped('meu perfil');
    await flush();
    const session = startListening();
    fire(session.onresult, resultEvent([['listar equipes', true]]));
    fire(session.onend);
    await flush();

    expect(sentCommands()).toEqual(['meu perfil', 'listar equipes']);
  });
});

describe('Voz do assistente e estados', () => {
  const speakOrders = () => window.speechSynthesis.speak.mock.invocationCallOrder;
  const cancelOrders = () => window.speechSynthesis.cancel.mock.invocationCallOrder;

  test('abrir o microfone corta a fala do assistente antes de ouvir', async () => {
    replyFor = () => ({ ok: true, reply_text: 'Seu perfil: Pessoa Teste.', tts: { enabled: true, text: 'Seu perfil.' } });
    render(<VoiceAssistantPage />);
    sendTyped('meu perfil');
    await flush();
    const spoke = speakOrders()[0];
    const session = startListening();
    const started = session.start.mock.invocationCallOrder[0];

    expect(cancelOrders().some((order) => order > spoke && order < started)).toBe(true);
  });

  test('mostra Falando durante a fala e ignora eventos de uma fala antiga', async () => {
    replyFor = (content) => ({ ok: true, reply_text: content, tts: { enabled: true, text: content } });
    render(<VoiceAssistantPage />);
    sendTyped('meu perfil');
    await flush();
    const first = window.speechSynthesis.speak.mock.calls[0][0];
    fire(first.onstart);
    expect(statusText()).toBe('Falando');
    fire(first.onend);
    expect(statusText()).toBe('Standby');

    sendTyped('listar equipes');
    await flush();
    const second = window.speechSynthesis.speak.mock.calls[1][0];
    fire(second.onstart);
    fire(first.onend);
    expect(statusText()).toBe('Falando');
    fire(second.onend);
    expect(statusText()).toBe('Standby');
  });

  test('tts.enabled false: a resposta aparece e nao e falada', async () => {
    replyFor = () => ({ ok: true, reply_text: 'Seu perfil: Pessoa Teste.', tts: { enabled: false, text: 'Seu perfil.' } });
    render(<VoiceAssistantPage />);
    sendTyped('meu perfil');
    await flush();

    expect(screen.getByText('Seu perfil: Pessoa Teste.')).toBeInTheDocument();
    expect(window.speechSynthesis.speak).not.toHaveBeenCalled();
  });

  test('sair: a despedida e falada ate o fim e o standby e avisado', async () => {
    replyFor = () => ({ ok: true, command: { key: 'exit' }, reply_text: 'Encerrando.', tts: { enabled: true, text: 'Encerrando.' } });
    render(<VoiceAssistantPage />);
    sendTyped('sair');
    await flush();

    expect(window.speechSynthesis.speak).toHaveBeenCalledTimes(1);
    expect(cancelOrders().some((order) => order > speakOrders()[0])).toBe(false);
    expect(standbyCalls()).toHaveLength(1);
  });

  test('pergunta pendente mostra Aguardando resposta ate o proximo comando ou o standby', async () => {
    replyFor = (content) => (content === 'criar equipe'
      ? { ok: true, reply_text: 'Qual é o nome da equipe?', conversation: { status: 'awaiting_params' } }
      : { ok: true, reply_text: 'Equipe criada.', conversation: { status: 'completed' } });
    render(<VoiceAssistantPage />);
    sendTyped('criar equipe');
    await flush();
    expect(statusText()).toBe('Aguardando resposta');

    sendTyped('Marketing');
    await flush();
    expect(statusText()).toBe('Standby');

    sendTyped('criar equipe');
    await flush();
    fireEvent.click(screen.getByTitle('Standby'));
    await flush();
    expect(statusText()).toBe('Standby');
  });

  test('pedido de confirmacao de escrita mostra Aguardando resposta ate confirmar, cancelar ou o standby', async () => {
    const summary = 'Confirme a operação: criar a equipe "Marketing". Nada foi alterado ainda. '
      + 'Para executar, diga "confirmar". Para desistir, diga "cancelar".';
    replyFor = (content) => {
      if (content === 'criar equipe marketing') {
        return { ok: true, reply_text: summary, conversation: { status: 'awaiting_confirmation', operation_id: 'op-1' } };
      }
      if (content === 'confirmar') {
        return { ok: true, reply_text: 'Confirmado. Operação concluída.', conversation: { status: 'completed' } };
      }
      return { ok: true, reply_text: 'Tudo bem, cancelei. Nada foi alterado.', conversation: { status: 'cancelled' } };
    };
    render(<VoiceAssistantPage />);
    sendTyped('criar equipe marketing');
    await flush();
    expect(screen.getByText(summary)).toBeInTheDocument();
    expect(statusText()).toBe('Aguardando resposta');

    sendTyped('confirmar');
    await flush();
    expect(statusText()).toBe('Standby');

    sendTyped('criar equipe marketing');
    await flush();
    expect(statusText()).toBe('Aguardando resposta');
    sendTyped('cancelar');
    await flush();
    expect(statusText()).toBe('Standby');

    sendTyped('criar equipe marketing');
    await flush();
    fireEvent.click(screen.getByTitle('Standby'));
    await flush();
    expect(statusText()).toBe('Standby');
    // O frontend so repassa as falas; quem decide e executa e o backend, uma mensagem por vez.
    expect(sentCommands()).toEqual(['criar equipe marketing', 'confirmar', 'criar equipe marketing', 'cancelar',
      'criar equipe marketing']);
  });

  test('standby durante o processamento: a resposta aparece, nao e falada e nada e reenviado', async () => {
    render(<VoiceAssistantPage />);
    sendTyped('meu perfil');
    fireEvent.click(screen.getByTitle('Standby'));
    await flush();
    expect(statusText()).toBe('Processando');
    expect(screen.getByRole('button', { name: 'Iniciar escuta' })).toBeDisabled();
    expect(standbyCalls()).toHaveLength(1);

    act(() => pendingReplies.shift()({ ok: true, reply_text: 'Seu perfil: Pessoa Teste.', tts: { enabled: true, text: 'Seu perfil.' } }));
    await flush();
    expect(screen.getByText('Seu perfil: Pessoa Teste.')).toBeInTheDocument();
    expect(window.speechSynthesis.speak).not.toHaveBeenCalled();
    expect(statusText()).toBe('Standby');
    expect(sentCommands()).toEqual(['meu perfil']);
  });

  test('sair da pagina com a resposta pendente: nada e falado depois', async () => {
    const { unmount } = render(<VoiceAssistantPage />);
    sendTyped('meu perfil');
    unmount();
    act(() => pendingReplies.shift()({ ok: true, reply_text: 'Seu perfil.', tts: { enabled: true, text: 'Seu perfil.' } }));
    await flush();

    expect(window.speechSynthesis.speak).not.toHaveBeenCalled();
  });
});

describe('Concluir x cancelar: identificacao para a pessoa', () => {
  const hint = () => document.querySelector('.voice-interaction-hint');
  const button = (name) => screen.getByRole('button', { name });

  test('sem escuta: microfone para iniciar, Standby com o proprio nome e nenhuma orientacao', () => {
    render(<VoiceAssistantPage />);

    expect(button('Iniciar escuta')).toHaveAttribute('title', 'Falar com o assistente');
    expect(button('Standby')).toHaveAttribute('title', 'Standby');
    expect(hint()).toBeNull();
  });

  test('durante a escuta: "Concluir fala" e "Cancelar escuta" no nome, no title e na orientacao visivel', () => {
    render(<VoiceAssistantPage />);
    fireEvent.click(button('Iniciar escuta'));
    expect(button('Cancelar escuta')).toBeInTheDocument();
    expect(hint()).toHaveTextContent('Abrindo o microfone: espere aparecer "Ouvindo — pode falar". "Cancelar escuta" descarta sem enviar.');

    fire(lastSession().onstart);
    fire(lastSession().onaudiostart);
    const conclude = button('Concluir fala');
    const cancel = button('Cancelar escuta');
    expect(conclude).toHaveAttribute('title', 'Concluir fala');
    expect(cancel).toHaveAttribute('title', 'Cancelar escuta');
    expect(hint()).toHaveTextContent(/concluir a fala e enviar o que o navegador confirmar/);
    expect(hint()).toHaveTextContent(/"Cancelar escuta" descarta sem enviar/);
    // Leitores de tela recebem a mesma orientacao nos dois botoes.
    expect(conclude).toHaveAttribute('aria-describedby', hint().id);
    expect(cancel).toHaveAttribute('aria-describedby', hint().id);
  });

  test('concluir e depois cancelar antes da confirmacao: nada e enviado', async () => {
    render(<VoiceAssistantPage />);
    const session = startListening();
    fire(session.onresult, resultEvent([['atribuir a 3', false]]));
    const late = capturedHandlers(session);
    clickConclude();
    expect(button('Concluindo fala')).toBeInTheDocument();
    expect(hint()).toHaveTextContent(/Aguardando o navegador confirmar a frase/);

    clickCancel();
    fire(late.result, resultEvent([['atribuir a 3 para mim', true]]));
    fire(late.end);
    await flush();

    expect(session.stop).toHaveBeenCalledTimes(1);
    expect(session.abort).toHaveBeenCalledTimes(1);
    expect(sentCommands()).toEqual([]);
    expect(button('Standby')).toBeInTheDocument();
    expect(hint()).toBeNull();
  });

  test('texto nao confirmado: aviso de que pode estar incompleto e envio so manual', async () => {
    render(<VoiceAssistantPage />);
    const session = startListening();
    fire(session.onresult, resultEvent([['atribuir a 1', false]]));
    fire(session.onend);
    await flush();

    expect(sentCommands()).toEqual([]);
    expect(screen.getByText(/pode estar incompleta. Nada foi enviado/)).toBeInTheDocument();
    expect(hint()).toHaveTextContent('Texto não confirmado pelo navegador: pode estar incompleto. Confira e corrija antes de tocar em Enviar.');
    expect(input()).toHaveAttribute('aria-describedby', hint().id);

    // Corrigir o texto tira o aviso; o envio continua dependendo do toque em Enviar.
    fireEvent.change(input(), { target: { value: 'atribuir a 11 para mim' } });
    expect(hint()).toBeNull();
    await flush();
    expect(sentCommands()).toEqual([]);
    clickSend();
    await flush();
    expect(sentCommands()).toEqual(['atribuir a 11 para mim']);
  });
});

describe('Fluxo normal simulado', () => {
  test('"meu perfil" e "listar equipes" por voz continuam funcionando', async () => {
    replyFor = (content) => ({
      'meu perfil': {
        ok: true,
        reply_text: 'Seu perfil: Pessoa Teste, conta de colaborador, e-mail pessoa@example.test.',
        tts: { enabled: true, language: 'pt-BR', text: 'Seu perfil: Pessoa Teste, conta de colaborador.' },
      },
      'listar equipes': {
        ok: true,
        reply_text: 'Você participa de 2 equipes: Equipe Alfa, Equipe Beta.',
        tts: { enabled: true, language: 'pt-BR', text: 'Você participa de 2 equipes: Equipe Alfa, Equipe Beta.' },
      },
    }[content]);
    render(<VoiceAssistantPage />);

    for (const phrase of ['meu perfil', 'listar equipes']) {
      const session = startListening();
      expect(statusText()).toBe('Ouvindo — pode falar');
      fire(session.onresult, resultEvent([[phrase, true]]));
      fire(session.onend);
      await flush();
    }

    expect(sentCommands()).toEqual(['meu perfil', 'listar equipes']);
    expect(requests.filter((r) => r.url === COMMAND_URL).every((r) => (
      r.body.channelId === 'voice-assistant' && r.body.conversationId.startsWith('voice-')
    ))).toBe(true);
    expect(screen.getByText(/Seu perfil: Pessoa Teste, conta de colaborador, e-mail/)).toBeInTheDocument();
    expect(screen.getByText('Você participa de 2 equipes: Equipe Alfa, Equipe Beta.')).toBeInTheDocument();
    expect(window.speechSynthesis.speak.mock.calls.map(([utterance]) => utterance.text)).toEqual([
      'Seu perfil: Pessoa Teste, conta de colaborador.',
      'Você participa de 2 equipes: Equipe Alfa, Equipe Beta.',
    ]);
    expect(statusText()).toBe('Standby');
    expect(input()).toHaveValue('');
  });
});

describe('Prontidao real do microfone: "Ouvindo" so com o audio chegando', () => {
  const hintText = () => document.querySelector('.voice-interaction-hint')?.textContent || '';
  const clickStart = () => fireEvent.click(screen.getByRole('button', { name: 'Iniciar escuta' }));
  // Relogio falso so nestes testes: o atraso entre onstart e onaudiostart chegou a 11 s em sessoes reais.
  const withFakeClock = async (run) => {
    vi.useFakeTimers();
    try {
      await run();
    } finally {
      vi.useRealTimers();
    }
  };
  const advance = (ms) => act(() => {
    vi.advanceTimersByTime(ms);
  });

  test('onstart imediato e audiostart segundos depois: Iniciando ate o audio, depois Ouvindo', async () => {
    await withFakeClock(async () => {
      render(<VoiceAssistantPage />);
      clickStart();
      const session = lastSession();
      fire(session.onstart);
      expect(statusText()).toBe('Iniciando');
      expect(screen.getByRole('button', { name: 'Iniciando escuta' })).toBeInTheDocument();
      expect(hintText()).toMatch(/espere aparecer "Ouvindo — pode falar"/);

      advance(3000);
      expect(statusText()).toBe('Iniciando');
      expect(hintText()).toMatch(/ainda está abrindo o microfone/);

      advance(3000); // 6 s depois do onstart, como nas sessoes reais mais lentas
      fire(session.onaudiostart);
      expect(statusText()).toBe('Ouvindo — pode falar');
      expect(screen.getByRole('button', { name: 'Concluir fala' })).toBeInTheDocument();
      expect(hintText()).toMatch(/concluir a fala/);

      // O prazo de abertura (12 s depois do onstart) nao derruba uma sessao que ja abriu o microfone. (Sem
      // nenhuma fala, a sessao fecha em NO_SPEECH_TIMEOUT_MS: coberto nos testes da escuta limitada.)
      advance(7000);
      expect(statusText()).toBe('Ouvindo — pode falar');
      fire(session.onresult, resultEvent([['meu perfil', true]]));
      fire(session.onend);
      expect(sentCommands()).toEqual(['meu perfil']);
      expect(session.abort).not.toHaveBeenCalled();
    });
  });

  test('clicar na estrela durante Iniciando nao conclui nem abre outra sessao', () => {
    render(<VoiceAssistantPage />);
    clickStart();
    const session = lastSession();
    fire(session.onstart);
    fireEvent.click(screen.getByRole('button', { name: 'Iniciando escuta' }));

    expect(session.stop).not.toHaveBeenCalled();
    expect(session.abort).not.toHaveBeenCalled();
    expect(FakeRecognition.instances).toHaveLength(1);
    expect(statusText()).toBe('Iniciando');
  });

  test('cancelar durante a inicializacao descarta, e eventos tardios dessa sessao nao mudam nada', async () => {
    render(<VoiceAssistantPage />);
    clickStart();
    const first = lastSession();
    fire(first.onstart);
    const late = { audio: first.onaudiostart, result: first.onresult, end: first.onend };
    fireEvent.click(screen.getByRole('button', { name: 'Cancelar escuta' }));
    expect(first.abort).toHaveBeenCalledTimes(1);
    expect(statusText()).toBe('Standby');

    // Nova sessao ainda iniciando: o audiostart atrasado da sessao cancelada nao a marca como pronta.
    clickStart();
    const second = lastSession();
    fire(second.onstart);
    fire(late.audio);
    fire(late.result, resultEvent([['atribuir a 1 para mim', true]]));
    fire(late.end);
    expect(statusText()).toBe('Iniciando');
    expect(sentCommands()).toEqual([]);

    fire(second.onaudiostart);
    fire(second.onresult, resultEvent([['meu perfil', true]]));
    fire(second.onend);
    await flush();
    expect(sentCommands()).toEqual(['meu perfil']);
  });

  test('sem audiostart: prazo encerra com aviso claro, nada enviado e microfone livre', async () => {
    await withFakeClock(async () => {
      render(<VoiceAssistantPage />);
      clickStart();
      const session = lastSession();
      const late = { result: session.onresult, end: session.onend };
      fire(session.onstart);
      advance(11999);
      expect(session.abort).not.toHaveBeenCalled();
      advance(1);

      expect(session.abort).toHaveBeenCalledTimes(1);
      expect(screen.getByText(/O navegador não abriu o microfone a tempo. Nada foi enviado/)).toBeInTheDocument();
      expect(statusText()).toBe('Standby');
      fire(late.result, resultEvent([['meu perfil', true]]));
      fire(late.end);
      expect(sentCommands()).toEqual([]);

      // Recuperacao: a proxima tentativa abre uma sessao nova normalmente.
      const next = startListening();
      fire(next.onresult, resultEvent([['meu perfil', true]]));
      fire(next.onend);
      expect(sentCommands()).toEqual(['meu perfil']);
    });
  });

  test('navegador encerra antes de abrir o microfone: aviso proprio e nada enviado', async () => {
    render(<VoiceAssistantPage />);
    clickStart();
    const session = lastSession();
    fire(session.onstart);
    fire(session.onend);
    await flush();

    expect(screen.getByText(/encerrou a escuta antes de abrir o microfone/)).toBeInTheDocument();
    expect(sentCommands()).toEqual([]);
    expect(statusText()).toBe('Standby');
  });

  test('fala ou resultado antes do audiostart tambem confirmam a captura', async () => {
    render(<VoiceAssistantPage />);
    clickStart();
    let session = lastSession();
    fire(session.onstart);
    fire(session.onspeechstart);
    expect(statusText()).toBe('Ouvindo — pode falar');
    fireEvent.click(screen.getByRole('button', { name: 'Cancelar escuta' }));

    clickStart();
    session = lastSession();
    fire(session.onstart);
    fire(session.onresult, resultEvent([['listar', false]]));
    expect(statusText()).toBe('Ouvindo — pode falar');
    fire(session.onresult, resultEvent([['listar equipes', true]]));
    fire(session.onend);
    await flush();
    expect(sentCommands()).toEqual(['listar equipes']);
  });

  test('navegador sem o evento audiostart: onstart vale como captura iniciada', async () => {
    FakeRecognition.withoutAudioStart = true;
    render(<VoiceAssistantPage />);
    clickStart();
    const session = lastSession();
    // Sem audiostart para esperar, o onstart ja libera a fala.
    fire(session.onstart);
    expect(statusText()).toBe('Ouvindo — pode falar');

    fire(session.onresult, resultEvent([['meu perfil', true]]));
    fire(session.onend);
    await flush();
    expect(sentCommands()).toEqual(['meu perfil']);
  });

  test('resultado final valido depois de atraso longo: um unico envio, mesmo com eventos repetidos', async () => {
    await withFakeClock(async () => {
      render(<VoiceAssistantPage />);
      clickStart();
      const session = lastSession();
      const late = { result: session.onresult, end: session.onend, audio: session.onaudiostart };
      fire(session.onstart);
      advance(10900); // atraso maximo medido: 11 s
      fire(session.onaudiostart);
      fire(session.onaudiostart);
      fire(session.onresult, resultEvent([['meu', false]]));
      fire(session.onresult, resultEvent([['meu perfil', true]]));
      fire(session.onend);
      fire(late.result, resultEvent([['meu perfil', true]]));
      fire(late.end);
      fire(late.audio);
      advance(5000);

      expect(sentCommands()).toEqual(['meu perfil']);
      expect(statusText()).toBe('Processando');
    });
  });
});

describe('Escuta limitada a uma fala: pausa nao corta, sem fala fecha, nada parcial e enviado', () => {
  const retryButton = () => screen.queryByRole('button', { name: 'Tentar de novo' });
  const withFakeClock = async (run) => {
    vi.useFakeTimers();
    try {
      await run();
    } finally {
      vi.useRealTimers();
    }
  };
  const advance = (ms) => act(() => {
    vi.advanceTimersByTime(ms);
  });

  test('pausa curta no meio da frase nao conclui; a pausa final conclui com stop e envia a frase inteira uma vez', async () => {
    await withFakeClock(async () => {
      render(<VoiceAssistantPage />);
      const session = startListening();
      fire(session.onresult, resultEvent([['mudar status da tarefa relatório final', true]]));
      advance(1500); // pausa para pensar: no modo nao continuo o navegador ja teria cortado aqui
      expect(session.stop).not.toHaveBeenCalled();
      fire(session.onresult, resultEvent([['mudar status da tarefa relatório final', true], ['para concluído', true]]));
      advance(1999);
      expect(session.stop).not.toHaveBeenCalled();
      advance(1);
      expect(session.stop).toHaveBeenCalledTimes(1);
      expect(session.abort).not.toHaveBeenCalled();
      expect(statusText()).toBe('Finalizando a fala');
      expect(sentCommands()).toEqual([]); // so depois do onend
      fire(session.onend);
      expect(sentCommands()).toEqual(['mudar status da tarefa relatório final para concluído']);
    });
  });

  test('pausa com so resultado parcial: conclui, mas nada e enviado e o texto fica para conferencia', async () => {
    await withFakeClock(async () => {
      render(<VoiceAssistantPage />);
      const session = startListening();
      fire(session.onresult, resultEvent([['criar tarefa relat', false]]));
      advance(2000);
      expect(session.stop).toHaveBeenCalledTimes(1);
      fire(session.onend);
      expect(sentCommands()).toEqual([]);
      expect(input()).toHaveValue('criar tarefa relat');
      expect(retryButton()).toBeInTheDocument();
    });
  });

  test('microfone aberto sem fala fecha sozinho, sem enviar; tentar de novo so com um toque', async () => {
    await withFakeClock(async () => {
      render(<VoiceAssistantPage />);
      const session = startListening();
      advance(7999);
      expect(session.abort).not.toHaveBeenCalled();
      advance(1);
      expect(session.abort).toHaveBeenCalledTimes(1);
      expect(sentCommands()).toEqual([]);
      expect(screen.getByText(/Não ouvi nenhuma fala/)).toBeInTheDocument();
      expect(statusText()).toBe('Standby');
      advance(60000); // nada reabre sozinho
      expect(FakeRecognition.instances).toHaveLength(1);
      fireEvent.click(retryButton());
      expect(FakeRecognition.instances).toHaveLength(2);
      expect(retryButton()).toBeNull();
    });
  });

  test('fala longa sem pausa: a duracao maxima conclui com stop (o microfone nunca fica aberto)', async () => {
    await withFakeClock(async () => {
      render(<VoiceAssistantPage />);
      const session = startListening();
      const words = [];
      for (let elapsed = 0; elapsed < 30000; elapsed += 1500) {
        words.push(`parte${elapsed}`);
        fire(session.onresult, resultEvent([[words.join(' '), false]]));
        advance(1500);
      }
      expect(session.stop).toHaveBeenCalledTimes(1);
      fire(session.onresult, resultEvent([[words.join(' '), true]]));
      fire(session.onend);
      expect(sentCommands()).toEqual([words.join(' ')]);
    });
  });

  test('trechos cumulativos repetidos (Chrome no Android) entram uma vez so', async () => {
    render(<VoiceAssistantPage />);
    const session = startListening();
    fire(session.onresult, resultEvent([['criar', true], ['criar tarefa', true], ['criar tarefa relatório', true]]));
    expect(input()).toHaveValue('criar tarefa relatório');
    fire(session.onend);
    await flush();
    expect(sentCommands()).toEqual(['criar tarefa relatório']);
  });

  test('final cumulativo com parcial repetido: o parcial pendente ainda impede o envio', async () => {
    render(<VoiceAssistantPage />);
    const session = startListening();
    fire(session.onresult, resultEvent([['criar tarefa', true], ['criar tarefa relatório', false]]));
    fire(session.onend);
    await flush();
    expect(sentCommands()).toEqual([]);
    expect(input()).toHaveValue('criar tarefa relatório');
  });

  test('tentar de novo aparece para falhas recuperaveis e nao para permissao negada', async () => {
    render(<VoiceAssistantPage />);
    let session = startListening();
    fire(session.onerror, { error: 'network' });
    await flush();
    expect(retryButton()).toBeInTheDocument();
    sendTyped('meu perfil'); // enviar outra coisa tira a oferta
    await flush();
    expect(retryButton()).toBeNull();
    act(() => pendingReplies.shift()?.({ ok: true, reply_text: 'Seu perfil.' }));
    await flush();

    session = startListening();
    fire(session.onerror, { error: 'not-allowed' });
    await flush();
    expect(screen.getByText(/microfone está bloqueado/)).toBeInTheDocument();
    expect(retryButton()).toBeNull();
  });

  test('cancelar a escuta desliga os prazos: nada conclui nem envia depois', async () => {
    await withFakeClock(async () => {
      render(<VoiceAssistantPage />);
      const session = startListening();
      fire(session.onresult, resultEvent([['minhas tarefas', true]]));
      fireEvent.click(screen.getByRole('button', { name: 'Cancelar escuta' }));
      advance(40000);
      expect(session.stop).not.toHaveBeenCalled();
      expect(session.abort).toHaveBeenCalledTimes(1);
      expect(sentCommands()).toEqual([]);
    });
  });
});
