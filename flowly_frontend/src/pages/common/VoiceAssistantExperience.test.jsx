// Experiencia do assistente: historico, baloes, rolagem, estado inicial, resultados de consulta (campo query) e
// navegacao para Minhas tarefas. fetch, SpeechRecognition e speechSynthesis simulados; rede real bloqueada.
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { API_ENDPOINTS } from '../../config/config';
import { authUtils } from '../../config/authUtils';
import { parseAssistantQuery, splitReplyText } from '../../utils/assistantQuery';

vi.mock('../../components/layout/Sidebar', () => ({ __esModule: true, default: () => null }));
vi.setConfig({ testTimeout: 20000, hookTimeout: 30000 });

class FakeRecognition {
  static instances = [];

  constructor() {
    this.start = vi.fn();
    this.stop = vi.fn();
    this.abort = vi.fn();
    FakeRecognition.instances.push(this);
  }
}

const COMMAND_URL = API_ENDPOINTS.ASSISTANT_COMMAND;
const STANDBY_URL = API_ENDPOINTS.ASSISTANT_STANDBY;
const TODAY = '2026-11-25';
const id = (n) => `${'f'.repeat(21)}${String(n).padStart(3, '0')}`;
let requests = [];
let replyFor = () => null;
let pendingReplies = [];

const jsonResponse = (payload) => ({ json: () => Promise.resolve(payload) });
const sentCommands = () => requests.filter((r) => r.url === COMMAND_URL).map((r) => r.body.content);

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
  FakeRecognition.instances = [];
  requests = [];
  pendingReplies = [];
  replyFor = () => null;
  vi.spyOn(authUtils, 'getUserType').mockReturnValue('user');
  window.speechSynthesis = { speak: vi.fn(), cancel: vi.fn() };
  global.fetch = vi.fn((url, init) => {
    if (url !== COMMAND_URL && url !== STANDBY_URL) return Promise.reject(new Error(`rede real bloqueada: ${url}`));
    requests.push({ url, body: init?.body ? JSON.parse(init.body) : {} });
    if (url === STANDBY_URL) return Promise.resolve(jsonResponse({ ok: true, status: 'standby' }));
    const payload = replyFor(JSON.parse(init.body).content);
    if (payload instanceof Error) return Promise.reject(payload);
    if (payload) return Promise.resolve(jsonResponse(payload));
    return new Promise((resolve) => {
      pendingReplies.push((reply) => resolve(jsonResponse(reply)));
    });
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

const flush = () => act(async () => {
  await new Promise((resolve) => setTimeout(resolve, 0));
});

const history = () => screen.getByRole('log', { name: 'Conversa com o assistente' });
const sendTyped = async (text) => {
  fireEvent.change(screen.getByRole('textbox'), { target: { value: text } });
  fireEvent.click(screen.getByTitle('Enviar comando'));
  await flush();
};

function LocationProbe() {
  const location = useLocation();
  return <p data-testid="destino">{`${location.pathname}|${location.state?.abrirTarefaId || ''}`}</p>;
}

const renderInRouter = () => render(
  <MemoryRouter initialEntries={['/assistente']}>
    <Routes>
      <Route path="/assistente" element={<VoiceAssistantPage />} />
      <Route path="/minhas-tarefas" element={<LocationProbe />} />
    </Routes>
  </MemoryRouter>,
);

const task = (n, titulo, extra = {}) => ({
  id: id(n), titulo, status: 'pendente', dataEntrega: TODAY, urgencia: 'baixa', equipe: 'Equipe Alfa', ...extra,
});

const todayReply = {
  ok: true,
  command: { key: 'tasks_today' },
  conversation: { status: 'browsing_tasks' },
  reply_text: 'Você tem 2 tarefas para hoje. 1 está em andamento e 1 ainda não foi iniciada. A mais urgente é Revisar relatório (vence hoje). '
    + '1. Revisar relatório, não iniciada, vence hoje, urgência alta, equipe Equipe Alfa; '
    + '2. Preparar apresentação, em andamento, vence hoje, urgência média, equipe Equipe Alfa. '
    + 'Você pode pedir detalhes de uma delas pelo número.',
  tts: { enabled: false, text: 'fala' },
  query: {
    type: 'today', today: TODAY, timezone: 'America/Sao_Paulo', range: { from: TODAY, to: TODAY }, total: 2,
    tasks: [
      task(1, 'Revisar relatório', { urgencia: 'alta' }),
      task(2, 'Preparar apresentação', { status: 'em_andamento', urgencia: 'media' }),
    ],
  },
};

describe('historico e baloes', () => {
  test('mensagens do usuario e do assistente com papeis distintos e texto longo preservado', async () => {
    const longo = `Linha 1\nLinha 2 ${'palavra-muito-comprida-sem-espaco'.repeat(8)}`;
    replyFor = () => ({ ok: true, reply_text: longo, tts: { enabled: false } });
    render(<VoiceAssistantPage />);
    await sendTyped('minhas tarefas');

    const user = history().querySelector('.voice-message.user');
    const assistant = [...history().querySelectorAll('.voice-message.assistant')].at(-1);
    expect(within(user).getByText('Você')).toBeInTheDocument();
    expect(user).toHaveTextContent('minhas tarefas');
    expect(assistant.querySelector('.voice-message-text').textContent).toBe(longo);
  });

  test('resposta antiga sem reply_text nem query continua aparecendo', async () => {
    replyFor = () => ({ ok: true, message: 'Ação concluída com sucesso.' });
    render(<VoiceAssistantPage />);
    await sendTyped('meu perfil');
    expect(screen.getByText('Ação concluída com sucesso.')).toBeInTheDocument();
    expect(document.querySelector('.voice-query')).toBeNull();
  });

  test('carregando mostra o indicador na conversa; falha da API vira mensagem de erro sem perder o historico', async () => {
    render(<VoiceAssistantPage />);
    await sendTyped('minhas tarefas');
    expect(document.querySelector('.voice-typing')).not.toBeNull();
    await act(async () => pendingReplies.shift()({ ok: false, reply_text: 'Você não tem permissão para esse comando.' }));
    expect(document.querySelector('.voice-typing')).toBeNull();
    expect(screen.getByText('Você não tem permissão para esse comando.').closest('article')).toHaveClass('error');

    replyFor = () => new Error('offline');
    await sendTyped('de novo');
    expect(screen.getByText('Não consegui falar com a API do assistente.')).toBeInTheDocument();
    expect(screen.getByText('minhas tarefas')).toBeInTheDocument();
  });

  test('controles de voz e de texto continuam no rodape', () => {
    render(<VoiceAssistantPage />);
    expect(screen.getByRole('button', { name: 'Iniciar escuta' })).toBeEnabled();
    expect(screen.getByTitle('Enviar comando')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Standby' })).toBeInTheDocument();
  });
});

describe('estado inicial', () => {
  test('sem conversa: sugestoes para o perfil user, enviadas pelo mesmo fluxo do texto', async () => {
    replyFor = () => todayReply;
    render(<VoiceAssistantPage />);
    expect(document.querySelector('.voice-assistant-shell')).toHaveClass('is-empty');
    const sugestoes = screen.getByRole('group', { name: 'Sugestões de perguntas' });
    fireEvent.click(within(sugestoes).getByRole('button', { name: 'Minhas tarefas de hoje' }));
    await flush();

    expect(sentCommands()).toEqual(['Minhas tarefas de hoje']);
    expect(document.querySelector('.voice-assistant-shell')).toHaveClass('has-conversation');
    // As sugestoes iniciais saem; depois de uma consulta das proprias tarefas ficam so as de outros periodos.
    expect(screen.queryByRole('button', { name: 'Minhas tarefas de hoje' })).toBeNull();
    const contexto = screen.getByRole('group', { name: 'Sugestões de perguntas' });
    expect(within(contexto).getAllByRole('button').map((b) => b.textContent)).toEqual(['E hoje?', 'E amanhã?', 'E as atrasadas?']);
  });

  test('admin recebe so sugestoes de consultas do proprio perfil (nunca as do colaborador)', () => {
    authUtils.getUserType.mockReturnValue('admin');
    render(<VoiceAssistantPage />);
    const sugestoes = screen.getByRole('group', { name: 'Sugestões de perguntas' });
    expect(within(sugestoes).getAllByRole('button').map((b) => b.textContent)).toEqual(['Listar tarefas', 'Listar equipes', 'Meu perfil']);
    expect(screen.queryByRole('button', { name: 'Minhas tarefas de hoje' })).toBeNull();
  });
});

describe('resultados de consulta (query)', () => {
  test('lista compacta com dados reais, introducao sem repetir a lista e links para Minhas tarefas', async () => {
    replyFor = () => todayReply;
    renderInRouter();
    await sendTyped('O que tenho para hoje?');

    const list = screen.getByRole('list', { name: 'Tarefas encontradas: 2' });
    const items = within(list).getAllByRole('listitem');
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveTextContent('Revisar relatório');
    expect(items[0]).toHaveTextContent('Vence hoje');
    expect(items[0]).toHaveTextContent('Não iniciada');
    expect(items[0]).toHaveTextContent('Prioridade Alta');
    expect(items[1]).toHaveTextContent('Em andamento');
    const message = list.closest('article');
    expect(message.querySelector('.voice-message-text').textContent)
      .toBe('Você tem 2 tarefas para hoje. 1 está em andamento e 1 ainda não foi iniciada. A mais urgente é Revisar relatório (vence hoje).');
    expect(message).not.toHaveTextContent('1. Revisar relatório, não iniciada');
    expect(within(message).getByText('Você pode pedir detalhes de uma delas pelo número.')).toBeInTheDocument();

    fireEvent.click(within(items[0]).getByRole('link', { name: 'Ver tarefa Revisar relatório' }));
    expect(screen.getByTestId('destino')).toHaveTextContent(`/minhas-tarefas|${id(1)}`);
  });

  test('atrasada recebe indicador; muitas tarefas mostram 5, "mostrar mais" e o total informado', async () => {
    const tasks = Array.from({ length: 8 }, (_, i) => task(i + 1, `Tarefa ${i + 1}`, { dataEntrega: '2026-11-20' }));
    replyFor = () => ({
      ok: true,
      reply_text: 'Você tem 12 tarefas atrasadas. 1. Tarefa 1, não iniciada; 2. Tarefa 2. Você pode pedir detalhes de uma delas pelo número.',
      query: { type: 'overdue', today: TODAY, total: 12, tasks },
    });
    renderInRouter();
    await sendTyped('tarefas atrasadas');

    const list = screen.getByRole('list', { name: 'Tarefas encontradas: 12' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(5);
    expect(within(list).getAllByRole('listitem')[0]).toHaveClass('overdue');
    expect(within(list).getAllByRole('listitem')[0]).toHaveTextContent('Atrasada · Venceu há 5 dias');
    expect(screen.getByText('Mostrando 8 de 12 tarefas.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Mostrar mais 3' }));
    expect(within(list).getAllByRole('listitem')).toHaveLength(8);
    expect(screen.getByRole('link', { name: 'Abrir Minhas tarefas' })).toHaveAttribute('href', '/minhas-tarefas');
  });

  test('zero tarefas: so o texto, sem lista vazia', async () => {
    replyFor = () => ({
      ok: true,
      reply_text: 'Você não tem tarefas previstas para hoje.',
      query: { type: 'today', today: TODAY, total: 0, tasks: [] },
    });
    renderInRouter();
    await sendTyped('tarefas de hoje');
    expect(screen.getByText('Você não tem tarefas previstas para hoje.')).toBeInTheDocument();
    expect(screen.queryByRole('list', { name: /Tarefas encontradas/ })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Abrir Minhas tarefas' })).toBeNull();
  });

  test('resumo: indicadores so quando a lista esta completa; texto inteiro mantido', async () => {
    const reply = {
      ok: true,
      reply_text: 'Hoje você tem 1 tarefa: Revisar. 1 tarefa atrasada. Prioridade sugerida: Revisar (urgência alta, vence hoje).',
      query: {
        type: 'summary', today: TODAY, total: 3,
        tasks: [task(1, 'Antiga', { dataEntrega: '2026-11-20' }), task(2, 'Revisar'), task(3, 'Sexta', { dataEntrega: '2026-11-27' })],
      },
    };
    replyFor = () => reply;
    renderInRouter();
    await sendTyped('Como está meu dia?');
    const counts = screen.getByRole('list', { name: 'Resumo das tarefas' });
    expect(counts).toHaveTextContent('1 atrasadas');
    expect(counts).toHaveTextContent('1 para hoje');
    expect(counts).toHaveTextContent('1 nos próximos 7 dias');
    expect(screen.getByText(reply.reply_text)).toBeInTheDocument();

    replyFor = () => ({ ...reply, query: { ...reply.query, total: 9 } });
    await sendTyped('resumo de novo');
    expect(screen.getAllByRole('list', { name: 'Resumo das tarefas' })).toHaveLength(1);
  });

  test('query invalida, incompleta ou de resposta com erro e ignorada', async () => {
    const invalids = [
      { type: 'desconhecido', today: TODAY, tasks: [task(1, 'X')] },
      { type: 'today', today: '25/11/2026', tasks: [task(1, 'X')] },
      { type: 'today', today: TODAY, tasks: 'lista' },
      'texto',
    ];
    render(<VoiceAssistantPage />);
    for (const query of invalids) {
      replyFor = () => ({ ok: true, reply_text: 'Resposta comum.', query });
      // eslint-disable-next-line no-await-in-loop
      await sendTyped('consulta');
    }
    replyFor = () => ({ ok: false, reply_text: 'Falhou.', query: todayReply.query });
    await sendTyped('consulta');
    expect(document.querySelector('.voice-query')).toBeNull();
    expect(screen.getAllByText('Resposta comum.')).toHaveLength(4);
  });

  test('sem identificador confiavel ou fora do roteador: nenhum link de tarefa', async () => {
    replyFor = () => ({
      ok: true,
      reply_text: 'Você tem 2 tarefas para hoje. 1. A; 2. B.',
      query: { type: 'today', today: TODAY, total: 2, tasks: [task(1, 'A', { id: '../admin' }), task(2, 'B', { id: undefined })] },
    });
    renderInRouter();
    await sendTyped('hoje');
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
    expect(screen.queryByRole('link', { name: /Ver tarefa/ })).toBeNull();
  });

  test('pagina sem roteador (laboratorio, testes antigos) mostra os cartoes sem links', async () => {
    replyFor = () => todayReply;
    render(<VoiceAssistantPage />);
    await sendTyped('hoje');
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
    expect(screen.queryByRole('link')).toBeNull();
  });
});

describe('rolagem do historico', () => {
  const metrics = (el, { scrollHeight, clientHeight }) => {
    Object.defineProperty(el, 'scrollHeight', { configurable: true, get: () => scrollHeight });
    Object.defineProperty(el, 'clientHeight', { configurable: true, get: () => clientHeight });
  };

  test('acompanha o fim quando a pessoa esta nele; lendo o historico, so oferece voltar ao mais recente', async () => {
    replyFor = () => ({ ok: true, reply_text: 'Resposta.' });
    render(<VoiceAssistantPage />);
    const log = history();
    metrics(log, { scrollHeight: 1000, clientHeight: 400 });

    await sendTyped('primeira');
    expect(log.scrollTop).toBe(1000);

    // A pessoa sobe para ler; a proxima resposta nao puxa a tela.
    log.scrollTop = 100;
    fireEvent.scroll(log);
    replyFor = () => null;
    await sendTyped('segunda'); // a mensagem da propria pessoa sempre leva ao fim
    expect(log.scrollTop).toBe(1000);
    log.scrollTop = 100;
    fireEvent.scroll(log);
    metrics(log, { scrollHeight: 1300, clientHeight: 400 });
    await act(async () => pendingReplies.shift()({ ok: true, reply_text: 'Resposta longa.' }));
    expect(log.scrollTop).toBe(100);
    const jump = screen.getByRole('button', { name: 'Ir para a mensagem mais recente' });

    fireEvent.click(jump);
    expect(log.scrollTop).toBe(1300);
    expect(screen.queryByRole('button', { name: 'Ir para a mensagem mais recente' })).toBeNull();
  });
});

describe('utilitarios do query', () => {
  test('parse descarta itens sem titulo e corrige total menor que a lista', () => {
    const parsed = parseAssistantQuery({
      type: 'week', today: TODAY, total: 1,
      tasks: [task(1, 'A'), { id: id(2) }, task(3, 'C', { dataEntrega: '2026-02-30', urgencia: 'urgentissima' })],
    });
    expect(parsed.total).toBe(2);
    expect(parsed.tasks.map((t) => t.titulo)).toEqual(['A', 'C']);
    expect(parsed.tasks[1]).toMatchObject({ dataEntrega: null, urgencia: null });
    expect(parseAssistantQuery(null)).toBeNull();
  });

  test('splitReplyText so separa quando ha lista numerada', () => {
    expect(splitReplyText('Você não tem tarefas.')).toEqual({ intro: 'Você não tem tarefas.', hint: '', listed: false });
    expect(splitReplyText('Você tem 1 tarefa. 1. A, vence hoje. Você pode pedir detalhes de uma delas pelo número.'))
      .toEqual({ intro: 'Você tem 1 tarefa.', hint: 'Você pode pedir detalhes de uma delas pelo número.', listed: true });
  });
});
