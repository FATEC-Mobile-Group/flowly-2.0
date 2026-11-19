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

  constructor() {
    this.start = vi.fn(() => {
      if (FakeRecognition.startError) throw FakeRecognition.startError;
    });
    this.stop = vi.fn();
    this.abort = vi.fn();
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

function startListening() {
  fireEvent.click(screen.getByRole('button', { name: 'Iniciar escuta' }));
  const session = lastSession();
  fire(session.onstart);
  return session;
}

function capturedHandlers(session) {
  return { result: session.onresult, error: session.onerror, end: session.onend };
}

describe('R1: resultado provisorio nunca vira comando', () => {
  test('provisorio seguido de erro: zero envios e o texto parcial sai do campo', async () => {
    render(<VoiceAssistantPage />);
    const session = startListening();
    fire(session.onresult, resultEvent([['atribuir a 1', false]]));
    expect(input()).toHaveValue('atribuir a 1');
    fire(session.onerror, { error: 'network' });
    fire(session.onend);
    await flush();

    expect(sentCommands()).toEqual([]);
    expect(input()).toHaveValue('');
    expect(screen.getByText(/Não consegui ouvir agora/)).toBeInTheDocument();
    expect(screen.getByText('Standby')).toBeInTheDocument();
  });

  test('provisorio seguido de fim sem resultado final: zero envios', async () => {
    render(<VoiceAssistantPage />);
    const session = startListening();
    fire(session.onresult, resultEvent([['meu per', false]]));
    fire(session.onend);
    await flush();

    expect(sentCommands()).toEqual([]);
    expect(input()).toHaveValue('');
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

  test('resultado final seguido de erro nao envia', async () => {
    render(<VoiceAssistantPage />);
    const session = startListening();
    fire(session.onresult, resultEvent([['meu perfil', true]]));
    fire(session.onerror, { error: 'network' });
    fire(session.onend);
    await flush();

    expect(sentCommands()).toEqual([]);
  });
});

describe('R2: cancelar descarta a captura', () => {
  test('parar no microfone aborta a sessao e eventos tardios nao enviam', async () => {
    render(<VoiceAssistantPage />);
    const session = startListening();
    fire(session.onresult, resultEvent([['minhas tare', false]]));
    const late = capturedHandlers(session);

    fireEvent.click(screen.getByRole('button', { name: 'Parar escuta' }));
    // O navegador ainda pode entregar o que ouviu e encerrar depois do cancelamento.
    fire(late.result, resultEvent([['minhas tarefas', true]]));
    fire(late.end);
    fire(session.onresult, resultEvent([['minhas tarefas', true]]));
    fire(session.onend);
    await flush();

    expect(session.abort).toHaveBeenCalledTimes(1);
    expect(sentCommands()).toEqual([]);
    expect(input()).toHaveValue('');
    expect(standbyCalls()).toHaveLength(1);
    expect(standbyCalls()[0].body.conversationId).toMatch(/^voice-/);
    expect(screen.getByText('Standby')).toBeInTheDocument();
  });

  test('botao Standby durante a escuta tambem descarta a captura', async () => {
    render(<VoiceAssistantPage />);
    const session = startListening();
    const late = capturedHandlers(session);
    fireEvent.click(screen.getByTitle('Standby'));
    fire(late.result, resultEvent([['meu perfil', true]]));
    fire(late.end);
    await flush();

    expect(session.abort).toHaveBeenCalledTimes(1);
    expect(sentCommands()).toEqual([]);
    expect(standbyCalls()).toHaveLength(1);
  });

  test('erro tardio de uma sessao cancelada nao gera mensagem', async () => {
    render(<VoiceAssistantPage />);
    const session = startListening();
    const late = capturedHandlers(session);
    fireEvent.click(screen.getByRole('button', { name: 'Parar escuta' }));
    fire(late.error, { error: 'aborted' });
    fire(late.end);
    await flush();

    expect(screen.queryByText(/Não consegui ouvir agora/)).not.toBeInTheDocument();
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
});

describe('R3: no maximo um envio por sessao', () => {
  test('texto digitado enviado durante a escuta: um envio e a captura e cancelada', async () => {
    render(<VoiceAssistantPage />);
    fireEvent.change(input(), { target: { value: 'listar equipes' } });
    const session = startListening();
    const late = capturedHandlers(session);

    // A escuta ainda nao entregou nada: o campo tem o texto digitado, que pode ser enviado.
    fireEvent.click(screen.getByTitle('Enviar comando'));
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
    fireEvent.submit(screen.getByTitle('Enviar comando').closest('form'));
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
  const clickSend = () => fireEvent.click(screen.getByTitle('Enviar comando'));
  const pressEnter = () => fireEvent.submit(screen.getByTitle('Enviar comando').closest('form'));

  test('resultado provisorio seguido de Enviar: zero chamadas', async () => {
    render(<VoiceAssistantPage />);
    const session = startListening();
    fire(session.onresult, resultEvent([['atribuir a 1', false]]));
    expect(input()).toHaveValue('atribuir a 1');
    clickSend();
    pressEnter();
    await flush();

    expect(sentCommands()).toEqual([]);
    expect(session.abort).not.toHaveBeenCalled();
    // A sessao termina sem resultado final: continua sem envio e o parcial sai do campo.
    fire(session.onend);
    await flush();
    expect(sentCommands()).toEqual([]);
    expect(input()).toHaveValue('');
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

describe('R5: inicio e encerramento', () => {
  test('clique duplo no microfone cria uma unica sessao', () => {
    render(<VoiceAssistantPage />);
    const mic = screen.getByRole('button', { name: 'Iniciar escuta' });
    fireEvent.click(mic);
    fireEvent.click(mic);

    expect(FakeRecognition.instances).toHaveLength(1);
    expect(lastSession().start).toHaveBeenCalledTimes(1);
  });

  test('erro sincrono no start mostra aviso e permite tentar de novo', async () => {
    FakeRecognition.startError = new Error('InvalidStateError');
    render(<VoiceAssistantPage />);
    fireEvent.click(screen.getByRole('button', { name: 'Iniciar escuta' }));
    await flush();

    expect(screen.getByText(/Não consegui ouvir agora/)).toBeInTheDocument();
    expect(screen.getByText('Standby')).toBeInTheDocument();
    expect(sentCommands()).toEqual([]);

    FakeRecognition.startError = null;
    const session = startListening();
    fire(session.onresult, resultEvent([['meu perfil', true]]));
    fire(session.onend);
    await flush();
    expect(FakeRecognition.instances).toHaveLength(2);
    expect(sentCommands()).toEqual(['meu perfil']);
  });

  test('configuracao preservada: pt-BR, sem modo continuo e com resultados provisorios', () => {
    render(<VoiceAssistantPage />);
    const session = startListening();

    expect(session.lang).toBe('pt-BR');
    expect(session.continuous).toBe(false);
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

    fireEvent.click(screen.getByTitle('Enviar comando'));
    await flush();
    expect(sentCommands()).toEqual(['listar equipes']);
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
      expect(screen.getByText('Ouvindo')).toBeInTheDocument();
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
    expect(screen.getByText('Standby')).toBeInTheDocument();
    expect(input()).toHaveValue('');
  });
});
