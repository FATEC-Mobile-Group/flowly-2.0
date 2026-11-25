// Integracao visual do assistente: cartoes das listagens de selecao, detalhes estruturados da tarefa, navegacao pelo
// ID, sugestoes por perfil e contexto, indicador "Conversa pausada" e Manifest. fetch e voz simulados.
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { API_ENDPOINTS } from '../../config/config';
import { authUtils } from '../../config/authUtils';
import AssistantQueryResults from '../../components/assistant/AssistantQueryResults';
import AssistantTaskDetails from '../../components/assistant/AssistantTaskDetails';
import {
  describeDeadline, parseAssistantQuery, parseAssistantTask, splitReplyText, taskRouteForQuery,
} from '../../utils/assistantQuery';

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
const TODAY = '2026-12-05';
const id = (n) => `${'a'.repeat(21)}${String(n).padStart(3, '0')}`;
const item = (n, extra = {}) => ({
  id: id(n), titulo: `Tarefa ${n}`, status: 'pendente', dataEntrega: '2026-12-10', urgencia: 'alta', equipe: 'Equipe Alfa',
  responsavel: 'Caio', ...extra,
});
const listing = (type, tasks, total = tasks.length) => ({ type, today: TODAY, timezone: 'America/Sao_Paulo', range: null, total, tasks });
const DETAIL = {
  id: id(1), titulo: 'Criar tela de cadastro', status: 'concluido', dataEntrega: '2026-06-25', urgencia: 'alta',
  equipe: 'Null Pointers Anônimos', responsavel: 'Tubinho', descricao: 'Desenvolver formulário de cadastro de usuários.',
  today: TODAY, atribuidaAoUsuario: true,
};
let requests = [];
let replyFor = () => null;

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
  replyFor = () => null;
  vi.spyOn(authUtils, 'getUserType').mockReturnValue('user');
  window.speechSynthesis = { speak: vi.fn(), cancel: vi.fn() };
  global.fetch = vi.fn((url, init) => {
    if (url !== COMMAND_URL && url !== STANDBY_URL) return Promise.reject(new Error(`rede real bloqueada: ${url}`));
    requests.push({ url, body: init?.body ? JSON.parse(init.body) : {} });
    if (url === STANDBY_URL) return Promise.resolve(jsonResponse({ ok: true }));
    const payload = replyFor(JSON.parse(init.body).content);
    return payload ? Promise.resolve(jsonResponse(payload)) : new Promise(() => {});
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

const flush = () => act(async () => {
  await new Promise((resolve) => setTimeout(resolve, 0));
});
const sendTyped = async (text) => {
  fireEvent.change(screen.getByRole('textbox'), { target: { value: text } });
  fireEvent.click(screen.getByTitle('Enviar comando'));
  await flush();
};
const suggestionTexts = () => {
  const group = screen.queryByRole('group', { name: 'Sugestões de perguntas' });
  return group ? within(group).getAllByRole('button').map((b) => b.textContent) : [];
};

// Destino da navegacao: mostra a rota e o ID recebido em state.abrirTarefaId.
function Destination() {
  const location = useLocation();
  return <p data-testid="destino">{`${location.pathname}|${location.state?.abrirTarefaId || ''}`}</p>;
}
const inRouter = (ui) => render(
  <MemoryRouter initialEntries={['/assistente']}>
    <Routes>
      <Route path="/assistente" element={ui} />
      <Route path="/minhas-tarefas" element={<Destination />} />
      <Route path="/admin/tarefas" element={<Destination />} />
    </Routes>
  </MemoryRouter>,
);

describe('metadados das respostas', () => {
  test('listagens de selecao sao aceitas; formato invalido cai no texto', () => {
    for (const type of ['my_tasks', 'backlog', 'list_tasks', 'urgent']) {
      expect(parseAssistantQuery(listing(type, [item(1)]))?.type).toBe(type);
    }
    expect(parseAssistantQuery(listing('outro', [item(1)]))).toBeNull();
    expect(parseAssistantQuery({ type: 'my_tasks', tasks: [item(1)] })).toBeNull(); // sem today
    const parsed = parseAssistantQuery(listing('my_tasks', [item(1), { titulo: '' }, { ...item(2), id: 'x' }]));
    expect(parsed.tasks.map((t) => t.id)).toEqual([id(1), null]); // sem titulo sai; ID invalido nao vira link
  });

  test('detalhes: tarefa valida, incompleta ou invalida', () => {
    expect(parseAssistantTask(DETAIL)).toMatchObject({ titulo: 'Criar tela de cadastro', responsavel: 'Tubinho' });
    expect(parseAssistantTask({ titulo: 'Sem dados' })).toMatchObject({ dataEntrega: null, urgencia: null, equipe: null,
      responsavel: null, descricao: null, today: null });
    expect(parseAssistantTask({ id: id(1) })).toBeNull();
    expect(parseAssistantTask('x')).toBeNull();
  });

  test('prazo: concluida nunca "venceu", aberta vencida e sem prazo', () => {
    expect(describeDeadline({ status: 'concluido', dataEntrega: '2026-06-25' }, TODAY)).toBe('Prazo era 25/06');
    expect(describeDeadline({ status: 'pendente', dataEntrega: '2026-12-01' }, TODAY)).toBe('Venceu há 4 dias');
    expect(describeDeadline({ status: 'pendente', dataEntrega: null }, TODAY)).toBe('Sem prazo');
    expect(describeDeadline({ status: 'pendente', dataEntrega: '2026-12-10' }, null)).toBe('Prazo 10/12');
  });

  test('intro das listagens sem o "Opções para seleção:" e rotas por tipo', () => {
    expect(splitReplyText('Encontrei 2 tarefas. Opções para seleção: 1. A; 2. B. Você pode pedir detalhes, atribuir uma tarefa para você ou cancelar.'))
      .toMatchObject({ intro: 'Encontrei 2 tarefas.', listed: true });
    expect([taskRouteForQuery('my_tasks'), taskRouteForQuery('list_tasks'), taskRouteForQuery('backlog')])
      .toEqual(['/minhas-tarefas', '/admin/tarefas', null]);
  });
});

describe('cartoes das listagens', () => {
  test('minhas tarefas: mesma ordem e numeracao do assistente, titulos duplicados abrem pelo ID certo', () => {
    const tasks = [item(1, { titulo: 'Revisar' }), item(2, { titulo: 'Revisar' }), item(3)];
    inRouter(<AssistantQueryResults query={parseAssistantQuery(listing('my_tasks', tasks, 12))}
      replyText="Encontrei 12 tarefas. Opções para seleção: 1. Revisar; 2. Revisar; 3. Tarefa 3." />);
    expect(screen.getByText('Encontrei 12 tarefas.')).toBeInTheDocument();
    const rows = screen.getAllByRole('listitem');
    expect(rows.map((row) => row.querySelector('.voice-query-index').textContent)).toEqual(['1', '2', '3']);
    expect(screen.getByText('Mostrando 3 de 12 tarefas.')).toBeInTheDocument();
    fireEvent.click(within(rows[1]).getByRole('link', { name: 'Ver tarefa Revisar' }));
    expect(screen.getByTestId('destino')).toHaveTextContent(`/minhas-tarefas|${id(2)}`);
  });

  test('concluida, atrasada e sem prazo aparecem corretamente', () => {
    const tasks = [
      item(1, { status: 'concluido', dataEntrega: '2026-06-25' }), item(2, { dataEntrega: '2026-12-01' }),
      item(3, { dataEntrega: null }),
    ];
    inRouter(<AssistantQueryResults query={parseAssistantQuery(listing('my_tasks', tasks))} replyText="Encontrei 3 tarefas." />);
    const rows = screen.getAllByRole('listitem');
    expect(rows[0]).not.toHaveClass('overdue');
    expect(rows[0]).toHaveTextContent('Prazo era 25/06');
    expect(rows[0]).not.toHaveTextContent(/Venceu|Atrasada/);
    expect(rows[1]).toHaveClass('overdue');
    expect(rows[1]).toHaveTextContent('Atrasada · Venceu há 4 dias');
    expect(rows[2]).toHaveTextContent('Sem prazo');
  });

  test('backlog: dados sem link (sem rota segura); listagem do admin abre em /admin/tarefas', () => {
    const { unmount } = inRouter(<AssistantQueryResults
      query={parseAssistantQuery(listing('backlog', [item(1, { responsavel: null })]))} replyText="Encontrei 1 tarefa." />);
    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.getByText('Sem responsável')).toBeInTheDocument();
    unmount();
    inRouter(<AssistantQueryResults query={parseAssistantQuery(listing('list_tasks', [item(4, { responsavel: 'Ana' })]))}
      replyText="Encontrei 1 tarefa." />);
    expect(screen.getByText('Ana')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('link', { name: 'Ver tarefa Tarefa 4' }));
    expect(screen.getByTestId('destino')).toHaveTextContent(`/admin/tarefas|${id(4)}`);
  });
});

describe('detalhes da tarefa', () => {
  test('titulo em destaque, status, campos separados e descricao em bloco proprio', () => {
    inRouter(<AssistantTaskDetails task={parseAssistantTask(DETAIL)}
      replyText="Tarefa Criar tela de cadastro, status concluida. Você pode pedir outra tarefa, atribuir para você ou cancelar." />);
    expect(screen.getByRole('heading', { name: 'Criar tela de cadastro' })).toBeInTheDocument();
    expect(screen.getByText('Concluída')).toBeInTheDocument();
    const field = (label) => screen.getByText(label, { selector: 'dt' }).nextElementSibling.textContent;
    expect([field('Prazo'), field('Urgência'), field('Equipe'), field('Responsável')])
      .toEqual(['Prazo era 25/06', 'Alta', 'Null Pointers Anônimos', 'Tubinho']);
    expect(within(screen.getByRole('region', { name: 'Descrição' })).getByText(DETAIL.descricao)).toBeInTheDocument();
    expect(screen.getByText('Você pode pedir outra tarefa, atribuir para você ou cancelar.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('link', { name: 'Ver tarefa Criar tela de cadastro' }));
    expect(screen.getByTestId('destino')).toHaveTextContent(`/minhas-tarefas|${id(1)}`);
  });

  test('dados ausentes ficam como ausentes; sem responsavel o colaborador nao recebe link; admin vai para /admin/tarefas', () => {
    const sparse = parseAssistantTask({ id: id(9), titulo: 'Sem dados' });
    const { unmount } = inRouter(<AssistantTaskDetails task={sparse} replyText="" />);
    expect(screen.getAllByText('Não informada')).toHaveLength(2);
    expect(screen.getByText('Sem responsável')).toBeInTheDocument();
    expect(screen.getByText('Sem prazo')).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Descrição' })).toBeNull();
    expect(screen.queryByRole('link')).toBeNull();
    unmount();
    authUtils.getUserType.mockReturnValue('admin');
    inRouter(<AssistantTaskDetails task={sparse} replyText="" />);
    fireEvent.click(screen.getByRole('link', { name: 'Ver tarefa Sem dados' }));
    expect(screen.getByTestId('destino')).toHaveTextContent(`/admin/tarefas|${id(9)}`);
  });
});

describe('pagina: respostas estruturadas e sugestoes', () => {
  const detailsReply = { ok: true, reply_text: 'Tarefa Criar tela de cadastro, status concluida.', task: DETAIL,
    command: { key: 'task_details' }, conversation: { status: 'browsing_tasks' } };

  test('detalhes viram o cartao; sem metadados (ou invalidos) continua o texto', async () => {
    replyFor = (content) => (content === 'detalhes da primeira' ? detailsReply
      : { ok: true, reply_text: 'Texto antigo sem metadados.', task: { titulo: '' } });
    inRouter(<VoiceAssistantPage />);
    await sendTyped('detalhes da primeira');
    expect(screen.getByRole('heading', { name: 'Criar tela de cadastro' })).toBeInTheDocument();
    await sendTyped('outra coisa');
    expect(screen.getByText('Texto antigo sem metadados.')).toBeInTheDocument();
  });

  test('sugestoes do contexto: perguntas sobre a tarefa depois dos detalhes, sem ligar o microfone', async () => {
    replyFor = (content) => (content === 'detalhes da primeira' ? detailsReply
      : { ok: true, reply_text: 'Tarefa Criar tela de cadastro: prazo 25/06/2026.', command: { key: 'task_details' } });
    inRouter(<VoiceAssistantPage />);
    await sendTyped('detalhes da primeira');
    expect(suggestionTexts()).toEqual(['Qual é o prazo?', 'Qual é a urgência?', 'Quem é o responsável?', 'Qual é o status?']);
    fireEvent.click(screen.getByRole('button', { name: 'Qual é o prazo?' }));
    await flush();
    expect(sentCommands()).toEqual(['detalhes da primeira', 'Qual é o prazo?']);
    expect(FakeRecognition.instances).toHaveLength(0);
  });

  test('periodos so depois das proprias tarefas (nunca depois do backlog)', async () => {
    replyFor = (content) => ({ ok: true, reply_text: 'Encontrei 1 tarefa.',
      query: listing(content === 'backlog' ? 'backlog' : 'my_tasks', [item(1)]), conversation: { status: 'browsing_tasks' } });
    inRouter(<VoiceAssistantPage />);
    await sendTyped('minhas tarefas');
    expect(suggestionTexts()).toEqual(['E hoje?', 'E amanhã?', 'E as atrasadas?']);
    await sendTyped('backlog');
    expect(suggestionTexts()).toEqual([]);
  });

  test('confirmacao de escrita na tela: nenhuma sugestao que possa interferir', async () => {
    replyFor = () => ({ ok: true, reply_text: 'Confirme: atribuir a tarefa.', task: DETAIL,
      conversation: { status: 'awaiting_confirmation', operation_id: 'op-1', summary: 'atribuir a tarefa', expires_in: 120 } });
    inRouter(<VoiceAssistantPage />);
    await sendTyped('atribuir a primeira para mim');
    expect(screen.getByText('Confirme a operação')).toBeInTheDocument();
    expect(suggestionTexts()).toEqual([]);
  });

  test('resposta com erro nao oferece sugestoes de continuacao', async () => {
    replyFor = () => ({ ok: false, reply_text: 'Não consegui consultar.', error: 'api_error', task: DETAIL });
    inRouter(<VoiceAssistantPage />);
    await sendTyped('detalhes da primeira');
    expect(screen.queryByRole('heading', { name: 'Criar tela de cadastro' })).toBeNull();
    expect(suggestionTexts()).toEqual([]);
  });
});

describe('indicador e Manifest', () => {
  const root = join(import.meta.dirname, '../../..');

  test('"Conversa pausada": bolinha cinza preenchida, sem tracejado nem animacao', () => {
    const css = readFileSync(join(root, 'src/styles/pages/common/VoiceAssistantPage.css'), 'utf8').replace(/\r\n/g, '\n');
    const rule = css.match(/\.voice-status\.paused span \{([^}]*)\}/)[1];
    expect(rule).toMatch(/background: #8aa0b6;/);
    expect(rule).not.toMatch(/dashed|animation|transparent/);
  });

  test('todos os icones do Manifest existem, com tipo e tamanho coerentes', () => {
    const manifest = JSON.parse(readFileSync(join(root, 'public/manifest.json'), 'utf8'));
    expect(manifest.short_name).toBe('Flowly');
    for (const icon of manifest.icons) {
      const file = join(root, 'public', icon.src);
      expect(existsSync(file)).toBe(true);
      const bytes = readFileSync(file);
      if (icon.type === 'image/png') {
        expect(bytes.subarray(1, 4).toString()).toBe('PNG');
        expect(`${bytes.readUInt32BE(16)}x${bytes.readUInt32BE(20)}`).toBe(icon.sizes);
      } else {
        expect(icon.type).toBe('image/x-icon');
        const size = (byte) => byte || 256;
        expect(`${size(bytes[6])}x${size(bytes[7])}`).toBe(icon.sizes);
      }
    }
    const html = readFileSync(join(root, 'index.html'), 'utf8');
    const touch = html.match(/rel="apple-touch-icon" href="\/([^"]+)"/)[1];
    expect(existsSync(join(root, 'public', touch))).toBe(true);
  });
});

describe('revisao: destino do link, numeracao e compatibilidade', () => {
  test('tarefa atribuida a outro colaborador (ou sem a comprovacao do assistente) nao ganha link de Minhas tarefas', () => {
    for (const flags of [{ atribuidaAoUsuario: false }, { atribuidaAoUsuario: undefined }]) {
      const { unmount } = inRouter(<AssistantTaskDetails task={parseAssistantTask({ ...DETAIL, ...flags, responsavel: 'Outra pessoa' })} replyText="" />);
      expect(screen.getByText('Outra pessoa')).toBeInTheDocument();
      expect(screen.queryByRole('link')).toBeNull();
      unmount();
    }
  });

  test('item invalido no meio nao renumera os seguintes', () => {
    const query = parseAssistantQuery(listing('my_tasks', [item(1), { ...item(2), titulo: '' }, item(3)]));
    inRouter(<AssistantQueryResults query={query} replyText="Encontrei 3 tarefas." />);
    const rows = screen.getAllByRole('listitem');
    expect(rows.map((row) => row.querySelector('.voice-query-index').textContent)).toEqual(['1', '3']);
    expect(rows[1]).toHaveTextContent('Tarefa 3');
  });

  test('mais urgentes: colaborador so tem link nas tarefas com responsavel; admin vai para /admin/tarefas', () => {
    const query = parseAssistantQuery(listing('urgent', [item(1), item(2, { responsavel: null })]));
    const { unmount } = inRouter(<AssistantQueryResults query={query} replyText="As 2 tarefas mais urgentes da lista:" />);
    expect(screen.getAllByRole('link', { name: /Ver tarefa/ })).toHaveLength(1);
    unmount();
    authUtils.getUserType.mockReturnValue('admin');
    inRouter(<AssistantQueryResults query={query} replyText="As 2 tarefas mais urgentes da lista:" />);
    fireEvent.click(screen.getByRole('link', { name: 'Ver tarefa Tarefa 2' }));
    expect(screen.getByTestId('destino')).toHaveTextContent(`/admin/tarefas|${id(2)}`);
  });

  test('resposta ligada a uma operacao fica em texto: nenhum aviso some atras de um cartao', async () => {
    const warning = 'Não foi possível confirmar se a alteração foi feita. Confira no Flowly antes de repetir.';
    replyFor = () => ({ ok: true, reply_text: warning, task: DETAIL, query: listing('my_tasks', [item(1)]),
      conversation: { status: 'retry_pending', operation_id: 'op-1', summary: 'atribuir a tarefa' } });
    inRouter(<VoiceAssistantPage />);
    await sendTyped('confirmar');
    expect(screen.getByText(warning)).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Criar tela de cadastro' })).toBeNull();
    expect(document.querySelector('.voice-query-list')).toBeNull();
  });

  test('Python sem os metadados novos (producao atual): listagem e detalhes continuam em texto', async () => {
    replyFor = (content) => ({ ok: true, reply_text: content === 'minhas tarefas'
      ? 'Encontrei 2 tarefas. Opções para seleção: 1. A; 2. B. Você pode pedir detalhes, atribuir uma tarefa para você ou cancelar.'
      : 'Tarefa A, status pendente. Você pode pedir outra tarefa, atribuir para você ou cancelar.',
    command: { key: content === 'minhas tarefas' ? 'my_tasks' : 'task_details' }, conversation: { status: 'browsing_tasks' } });
    inRouter(<VoiceAssistantPage />);
    await sendTyped('minhas tarefas');
    expect(screen.getByText(/Encontrei 2 tarefas\. Opções para seleção: 1\. A; 2\. B\./)).toBeInTheDocument();
    await sendTyped('detalhes da primeira');
    expect(screen.getByText(/Tarefa A, status pendente\./)).toBeInTheDocument();
    expect(suggestionTexts()).toEqual(['Qual é o prazo?', 'Qual é a urgência?', 'Quem é o responsável?', 'Qual é o status?']);
  });
});
