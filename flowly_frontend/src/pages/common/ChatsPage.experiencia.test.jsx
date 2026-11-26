// Chat (PR #67): pesquisa de equipes e de mensagens, separadores por data, agrupamento, paginacao (limit/before),
// isolamento entre equipes em trocas rapidas, Enter/Shift+Enter/IME, rascunho por conversa, reconexao, anexo com
// nova tentativa e sino com o contador compartilhado das notificacoes.
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import ChatsPage from './ChatsPage';
import { API_ENDPOINTS, LOCAL_STORAGE_KEYS } from '../../config/config';
import { redefinirNotificacoes } from '../../components/notifications/notificationStore';
import {
  buscarMensagens,
  filtrarEquipesDoChat,
  montarLinhaDoTempo,
  rotuloDoDia,
  trechosDestacados,
} from './chatsUtils';

const { apiGet, createSocket } = vi.hoisted(() => ({ apiGet: vi.fn(), createSocket: vi.fn() }));
vi.mock('../../config/apiClient', () => ({ __esModule: true, default: { get: apiGet }, getFullApiUrl: (p) => `http://api.test${p}` }));
vi.mock('../../config/socketClient', () => ({ __esModule: true, default: createSocket }));
vi.mock('../../components/layout/Sidebar', () => ({ __esModule: true, default: () => null }));

const ME = { _id: '507f1f77bcf86cd799439011', nome: 'Ana Souza', fotoPerfil: '' };
const BRUNO = { _id: '507f1f77bcf86cd799439012', nome: 'Bruno Lima', fotoPerfil: '' };
const ALFA = '507f1f77bcf86cd799439013';
const BETA = '507f1f77bcf86cd799439014';
const AGORA = new Date('2026-11-26T15:00:00.000Z');

const createFakeSocket = () => {
  const handlers = {};
  const socket = {
    connected: true,
    on: vi.fn((event, handler) => { handlers[event] = [...(handlers[event] || []), handler]; }),
    off: vi.fn((event, handler) => { handlers[event] = (handlers[event] || []).filter((h) => h !== handler); }),
    emit: vi.fn(),
    disconnect: vi.fn(),
    trigger: (event, ...args) => (handlers[event] || []).forEach((handler) => handler(...args)),
    sendCount: () => socket.emit.mock.calls.filter(([event]) => event === 'send_message').length,
    lastAck: () => socket.emit.mock.calls.filter(([event]) => event === 'send_message').at(-1)?.[2],
  };
  socket.timeout = vi.fn(() => ({ emit: socket.emit }));
  return socket;
};

let seq = 0;
const msg = (texto, user, createdAt, extra = {}) => {
  seq += 1;
  return { _id: `m${String(seq).padStart(23, '0')}`, texto, user, createdAt, equipe: ALFA, ...extra };
};

let respostas;
let sockets;
const responder = async (valor) => {
  const resultado = typeof valor === 'function' ? await valor() : valor;
  if (resultado instanceof Error) throw resultado;
  return { data: resultado };
};

const equipesPadrao = () => [
  { _id: ALFA, nome: 'Equipe Alfa', membros: [ME, BRUNO] },
  { _id: BETA, nome: 'Projeto Beta', membros: [ME] },
];

const renderPage = () => render(<MemoryRouter initialEntries={['/chats']}><ChatsPage /></MemoryRouter>);
const textos = () => [...document.querySelectorAll('.chat-bubble')].map((el) => el.textContent);
const campo = () => screen.getByRole('textbox', { name: 'Mensagem' });
const pedidosHistorico = () => apiGet.mock.calls.filter(([url]) => url.includes('/messages'));

beforeAll(() => { Element.prototype.scrollIntoView = vi.fn(); });
afterAll(() => { delete Element.prototype.scrollIntoView; });

beforeEach(() => {
  seq = 0;
  redefinirNotificacoes();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(AGORA);
  localStorage.clear();
  localStorage.setItem(LOCAL_STORAGE_KEYS.USER_ID, ME._id);
  sockets = [];
  createSocket.mockReset();
  createSocket.mockImplementation(() => {
    const socket = createFakeSocket();
    sockets.push(socket);
    return socket;
  });
  respostas = {
    equipes: equipesPadrao(),
    count: { count: 2 },
    historico: {
      [ALFA]: [
        msg('Reunião às 9h amanhã', BRUNO, '2026-11-24T12:00:00.000Z'),
        msg('Combinado, levo o relatório', ME, '2026-11-25T13:00:00.000Z'),
        msg('Ótimo trabalho na apresentação', BRUNO, '2026-11-26T12:00:00.000Z'),
        msg('Vou revisar o relatorio final', BRUNO, '2026-11-26T12:02:00.000Z'),
      ],
      [BETA]: [msg('mensagem da Beta', ME, '2026-11-26T11:00:00.000Z', { equipe: BETA })],
    },
  };
  apiGet.mockReset();
  apiGet.mockImplementation(async (url, options) => {
    if (url === API_ENDPOINTS.MINHAS_EQUIPES) return responder(respostas.equipes);
    if (url === API_ENDPOINTS.NOTIFICATIONS_COUNT) return responder(respostas.count);
    const equipe = url.match(/\/equipes\/([0-9a-f]{24})\/messages/)?.[1];
    if (equipe) {
      const valor = typeof respostas.historico[equipe] === 'function'
        ? respostas.historico[equipe](options)
        : respostas.historico[equipe];
      return responder(valor);
    }
    return { data: {} };
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('utilitarios', () => {
  test('rotulos de dia, agrupamento de mensagens consecutivas e destaque sem acento', () => {
    expect(rotuloDoDia('2026-11-26T12:00:00.000Z', '2026-11-26')).toBe('Hoje');
    expect(rotuloDoDia('2026-11-25T12:00:00.000Z', '2026-11-26')).toBe('Ontem');
    expect(rotuloDoDia('2026-11-20T12:00:00.000Z', '2026-11-26')).toBe('20/11/2026');
    expect(rotuloDoDia('x', '2026-11-26')).toBe('Data indisponível');

    const lista = respostas.historico[ALFA];
    const itens = montarLinhaDoTempo(lista, '2026-11-26');
    expect(itens.filter((i) => i.tipo === 'dia').map((i) => i.rotulo)).toEqual(['24/11/2026', 'Ontem', 'Hoje']);
    const ultimas = itens.filter((i) => i.tipo === 'mensagem').slice(-2);
    expect(ultimas.map((i) => [i.inicioDoBloco, i.fimDoBloco])).toEqual([[true, false], [false, true]]);

    expect(trechosDestacados('Ótimo RELATÓRIO', 'relatorio otimo')).toEqual([
      { texto: 'Ótimo', destaque: true }, { texto: ' ', destaque: false }, { texto: 'RELATÓRIO', destaque: true },
    ]);
    expect(buscarMensagens(lista, 'RELATORIO')).toEqual([lista[1]._id, lista[3]._id]);
    expect(buscarMensagens(lista, '   ')).toEqual([]);
    expect(filtrarEquipesDoChat(equipesPadrao(), 'beta').map((e) => e._id)).toEqual([BETA]);
  });
});

describe('pagina do chat', () => {
  test('lista de equipes com pesquisa, selecao destacada, participantes e sino com o contador compartilhado', async () => {
    renderPage();
    await screen.findByText('Vou revisar o relatorio final');
    const alfa = screen.getByRole('button', { name: /Equipe Alfa/ });
    expect(alfa).toHaveAttribute('aria-current', 'true');
    fireEvent.change(screen.getByRole('searchbox', { name: 'Pesquisar equipe' }), { target: { value: 'BETA' } });
    expect(screen.queryByRole('button', { name: /Equipe Alfa/ })).toBeNull();
    expect(screen.getByRole('button', { name: /Projeto Beta/ })).toBeInTheDocument();
    fireEvent.change(screen.getByRole('searchbox', { name: 'Pesquisar equipe' }), { target: { value: 'zzz' } });
    expect(screen.getByText('Nenhuma equipe encontrada.')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '2 participantes' }));
    expect(within(screen.getByRole('list', { name: 'Participantes da equipe' })).getByText('Bruno Lima')).toBeInTheDocument();
    await waitFor(() => expect(document.querySelector('.notification-badge')).toHaveTextContent('2'));
  });

  test('separadores Hoje/Ontem/data, horario e mensagens consecutivas do mesmo participante agrupadas', async () => {
    renderPage();
    await screen.findByText('Vou revisar o relatorio final');
    expect(screen.getAllByRole('separator').map((s) => s.textContent)).toEqual(['24/11/2026', 'Ontem', 'Hoje']);
    const ultima = screen.getByText('Vou revisar o relatorio final').closest('.chat-message-row');
    const anterior = screen.getByText('Ótimo trabalho na apresentação').closest('.chat-message-row');
    expect(ultima).toHaveClass('continuacao');
    expect(within(ultima).queryByText('Bruno Lima')).toBeNull();
    expect(within(anterior).getByText('Bruno Lima')).toBeInTheDocument();
    // Horario so no fim do bloco, com a data completa no title.
    expect(anterior.querySelector('time')).toBeNull();
    expect(ultima.querySelector('time')).toHaveAttribute('title', expect.stringMatching(/26\/11\/2026/));
  });

  test('pesquisa nas mensagens carregadas: destaca, navega, avisa o alcance e nao esconde nada', async () => {
    renderPage();
    await screen.findByText('Vou revisar o relatorio final');
    fireEvent.click(screen.getByRole('button', { name: 'Pesquisar nas mensagens' }));
    const busca = screen.getByRole('searchbox', { name: 'Pesquisar nas mensagens carregadas' });
    fireEvent.change(busca, { target: { value: 'RELATORIO' } });

    expect(screen.getByText('1 de 2')).toBeInTheDocument();
    expect(screen.getByText(/A pesquisa abrange apenas as 4 mensagens carregadas/)).toBeInTheDocument();
    expect([...document.querySelectorAll('mark.chat-destaque')].map((m) => m.textContent)).toEqual(['relatório', 'relatorio']);
    expect(textos()).toHaveLength(4);
    expect(document.querySelector('.is-resultado-atual')).toHaveTextContent('Combinado, levo o relatório');

    fireEvent.click(screen.getByRole('button', { name: 'Próximo resultado' }));
    expect(screen.getByText('2 de 2')).toBeInTheDocument();
    expect(document.querySelector('.is-resultado-atual')).toHaveTextContent('Vou revisar o relatorio final');
    fireEvent.keyDown(busca, { key: 'Enter' });
    expect(screen.getByText('1 de 2')).toBeInTheDocument();
    fireEvent.change(busca, { target: { value: 'inexistente' } });
    expect(screen.getByText('Nenhum resultado')).toBeInTheDocument();
    fireEvent.keyDown(busca, { key: 'Escape' });
    expect(screen.queryByRole('searchbox', { name: 'Pesquisar nas mensagens carregadas' })).toBeNull();
    expect(document.querySelector('mark')).toBeNull();
  });

  test('paginacao: ultimas 50 com limit, anteriores com before da mais antiga, ordem cronologica e sem duplicar', async () => {
    const recentes = Array.from({ length: 50 }, (_, i) => msg(`recente ${i}`, BRUNO, new Date(Date.UTC(2026, 10, 26, 10, i)).toISOString()));
    const antigas = Array.from({ length: 3 }, (_, i) => msg(`antiga ${i}`, ME, new Date(Date.UTC(2026, 10, 25, 9, i)).toISOString()));
    respostas.historico[ALFA] = (options) => (options?.params?.before ? [...antigas, recentes[0]] : recentes);
    renderPage();
    await screen.findByText('recente 49');
    expect(pedidosHistorico()[0][1]).toEqual({ params: { limit: 50 } });

    fireEvent.click(screen.getByRole('button', { name: 'Carregar mensagens anteriores' }));
    await screen.findByText('antiga 0');
    expect(pedidosHistorico()[1][1]).toEqual({ params: { limit: 50, before: recentes[0].createdAt } });
    const lista = textos();
    expect(lista.slice(0, 4)).toEqual(['antiga 0', 'antiga 1', 'antiga 2', 'recente 0']);
    expect(lista.filter((t) => t === 'recente 0')).toHaveLength(1);
    expect(lista).toHaveLength(53);
    // Pagina menor que o limite: nao ha mais anteriores para pedir.
    expect(screen.queryByRole('button', { name: 'Carregar mensagens anteriores' })).toBeNull();
  });

  test('troca rapida de equipe: historico atrasado e socket da equipe anterior nao entram na nova conversa', async () => {
    let liberarAlfa;
    respostas.historico[ALFA] = () => new Promise((resolve) => { liberarAlfa = resolve; });
    renderPage();
    await waitFor(() => expect(pedidosHistorico()).toHaveLength(1));
    const socketAlfa = sockets[0];
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Projeto Beta/ })); });
    await screen.findByText('mensagem da Beta');

    await act(async () => { liberarAlfa([msg('atrasada da Alfa', BRUNO, '2026-11-26T12:00:00.000Z')]); });
    await act(async () => { socketAlfa.trigger('receive_message', msg('socket antigo da Alfa', BRUNO, '2026-11-26T12:05:00.000Z')); });
    // Mesmo no socket atual, mensagem marcada com outra equipe e descartada.
    await act(async () => { sockets[1].trigger('receive_message', msg('outra equipe no socket novo', BRUNO, '2026-11-26T12:06:00.000Z')); });
    await act(async () => { sockets[1].trigger('receive_message', msg('nova da Beta', BRUNO, '2026-11-26T12:07:00.000Z', { equipe: BETA })); });

    expect(textos()).toEqual(['mensagem da Beta', 'nova da Beta']);
  });

  test('Socket.IO: a mesma mensagem repetida aparece uma vez', async () => {
    renderPage();
    await screen.findByText('Vou revisar o relatorio final');
    const nova = msg('chegou agora', BRUNO, '2026-11-26T14:00:00.000Z');
    await act(async () => {
      sockets[0].trigger('receive_message', nova);
      sockets[0].trigger('receive_message', { ...nova });
    });
    expect(textos().filter((t) => t === 'chegou agora')).toHaveLength(1);
  });

  test('Enter envia, Shift+Enter e composicao (IME) nao enviam; vazio nao envia', async () => {
    renderPage();
    await screen.findByText('Vou revisar o relatorio final');
    const socket = sockets[0];
    fireEvent.keyDown(campo(), { key: 'Enter' });
    expect(socket.sendCount()).toBe(0);
    fireEvent.change(campo(), { target: { value: 'linha 1' } });
    fireEvent.keyDown(campo(), { key: 'Enter', shiftKey: true });
    fireEvent.keyDown(campo(), { key: 'Enter', isComposing: true });
    fireEvent.keyDown(campo(), { key: 'Enter', keyCode: 229 });
    expect(socket.sendCount()).toBe(0);
    await act(async () => { fireEvent.keyDown(campo(), { key: 'Enter' }); });
    expect(socket.sendCount()).toBe(1);
    expect(socket.emit).toHaveBeenCalledWith('send_message', { equipeId: ALFA, texto: 'linha 1' }, expect.any(Function));
    // Enter repetido durante o envio nao gera outro envio.
    await act(async () => { fireEvent.keyDown(campo(), { key: 'Enter' }); });
    expect(socket.sendCount()).toBe(1);
    await act(async () => socket.lastAck()(null, { ok: true, messageId: 'x' }));
    expect(campo()).toHaveValue('');
  });

  test('mensagem bloqueada nao aparece como enviada e o texto continua para correcao', async () => {
    renderPage();
    await screen.findByText('Vou revisar o relatorio final');
    fireEvent.change(campo(), { target: { value: 'texto ofensivo' } });
    await act(async () => { fireEvent.keyDown(campo(), { key: 'Enter' }); });
    await act(async () => sockets[0].lastAck()(null, { ok: false, blocked: true, message: 'Parece conter um insulto.' }));
    expect(within(screen.getByRole('alert')).getByText('Mensagem bloqueada')).toBeInTheDocument();
    expect(campo()).toHaveValue('texto ofensivo');
    expect(textos()).not.toContain('texto ofensivo');
  });

  test('rascunho por conversa em memoria (sem localStorage)', async () => {
    renderPage();
    await screen.findByText('Vou revisar o relatorio final');
    fireEvent.change(campo(), { target: { value: 'rascunho privado da Alfa' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Projeto Beta/ })); });
    expect(campo()).toHaveValue('');
    fireEvent.change(campo(), { target: { value: 'rascunho da Beta' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Equipe Alfa/ })); });
    expect(campo()).toHaveValue('rascunho privado da Alfa');
    expect(JSON.stringify({ ...localStorage })).not.toContain('rascunho');
  });

  test('reconexao: aviso so depois de uma queda real do socket e some ao reconectar', async () => {
    renderPage();
    await screen.findByText('Vou revisar o relatorio final');
    const socket = sockets[0];
    expect(screen.queryByText(/Tentando reconectar/)).toBeNull();
    await act(async () => { socket.trigger('connect'); });
    await act(async () => { socket.trigger('disconnect'); });
    expect(screen.getByText(/Tentando reconectar/)).toBeInTheDocument();
    await act(async () => { socket.trigger('connect'); });
    expect(screen.queryByText(/Tentando reconectar/)).toBeNull();
  });

  test('estados: erro de historico com nova tentativa; equipe sem mensagens', async () => {
    respostas.historico[ALFA] = new Error('falha');
    renderPage();
    expect(await screen.findByText('Erro ao carregar mensagens do chat.')).toBeInTheDocument();
    respostas.historico[ALFA] = [];
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Tentar novamente' })); });
    expect(await screen.findByText('Nenhuma mensagem ainda. Comece a conversa.')).toBeInTheDocument();
  });

  test('anexo de imagem: tipo e tamanho; falha temporaria oferece nova tentativa e a URL local e liberada', async () => {
    const anexoPath = (id, inline) => `/api/equipes/${ALFA}/mensagens/${id}/anexo${inline ? '?disposition=inline' : ''}`;
    const id = 'bbbbbbbbbbbbbbbbbbbbbbb1';
    respostas.historico[ALFA] = [{
      _id: id, tipo: 'anexo', texto: '', createdAt: '2026-11-26T12:00:00.000Z', user: BRUNO, equipe: ALFA,
      anexo: { nomeOriginal: 'tela.png', mimetype: 'image/png', size: 2048, downloadUrl: anexoPath(id), previewUrl: anexoPath(id, true) },
    }];
    URL.createObjectURL = vi.fn(() => 'blob:tela');
    URL.revokeObjectURL = vi.fn();
    let falhas = 1;
    const base = apiGet.getMockImplementation();
    apiGet.mockImplementation(async (url, options) => {
      if (url.includes('/anexo')) {
        if (falhas > 0) {
          falhas -= 1;
          throw Object.assign(new Error('HTTP 503'), { response: { status: 503, data: new Blob() } });
        }
        return { data: new Blob(['x'], { type: 'image/png' }) };
      }
      return base(url, options);
    });
    const { unmount } = renderPage();
    expect(await screen.findByText('Não foi possível acessar o arquivo agora. Tente novamente em instantes.')).toBeInTheDocument();
    expect(screen.getByText('PNG')).toBeInTheDocument();
    expect(screen.getByText('2 KB')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Tentar carregar tela.png novamente' }));
    expect(await screen.findByRole('img', { name: 'tela.png' })).toHaveAttribute('src', 'blob:tela');
    unmount();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:tela');
  });
});
