import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import ChatsPage from './ChatsPage';
import { LOCAL_STORAGE_KEYS } from '../../config/config';

// Avatares do chat (URL assinada com prazo curto) e complementos do seletor de arquivos.
// HTTP e socket simulados; o jsdom nao baixa imagens, entao o erro de carregamento e disparado a mao.

const { apiGet, apiPost, createSocket } = vi.hoisted(() => ({
  apiGet: vi.fn(),
  apiPost: vi.fn(),
  createSocket: vi.fn(),
}));

vi.mock('../../config/apiClient', () => ({
  __esModule: true,
  default: { get: apiGet, post: apiPost },
  getFullApiUrl: (path) => (path.startsWith('http') ? path : `http://api.test${path}`),
}));
vi.mock('../../config/socketClient', () => ({ __esModule: true, default: createSocket }));
vi.mock('../../components/layout/Sidebar', () => ({ __esModule: true, default: () => null }));

const EQUIPE_ID = '507f1f77bcf86cd799439013';
const OUTRA_EQUIPE_ID = '507f1f77bcf86cd799439014';
const foto = (n) => `/api/storage/files/Zm90b3M${n}?token=assinado-${n}`;
const ME = { _id: '507f1f77bcf86cd799439011', nome: 'Ana Souza', fotoPerfil: foto(1) };
const BRUNO = { _id: '507f1f77bcf86cd799439012', nome: 'Bruno Lima', fotoPerfil: foto(2) };
const CARLA = { _id: '507f1f77bcf86cd799439015', nome: 'Carla Dias', fotoPerfil: foto(3) };

const msg = (id, user, texto, minuto) => ({
  _id: id.padEnd(24, '0'), texto, user, createdAt: `2026-11-20T10:${String(minuto).padStart(2, '0')}:00.000Z`,
});

const createFakeSocket = () => {
  const handlers = {};
  const socket = {
    connected: true,
    on: vi.fn((event, handler) => { handlers[event] = [...(handlers[event] || []), handler]; }),
    off: vi.fn(),
    emit: vi.fn(),
    disconnect: vi.fn(),
    trigger: (event, ...args) => (handlers[event] || []).forEach((handler) => handler(...args)),
  };
  socket.timeout = vi.fn(() => ({ emit: socket.emit }));
  return socket;
};

describe('ChatsPage: avatares', () => {
  let socket;
  let historicos;

  beforeAll(() => { Element.prototype.scrollIntoView = vi.fn(); });
  afterAll(() => { delete Element.prototype.scrollIntoView; });

  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem(LOCAL_STORAGE_KEYS.USER_ID, ME._id);
    apiGet.mockReset();
    apiPost.mockReset();
    socket = createFakeSocket();
    createSocket.mockReset();
    createSocket.mockReturnValue(socket);
    historicos = {
      [EQUIPE_ID]: [
        msg('a1', BRUNO, 'primeira do Bruno', 0),
        msg('a2', BRUNO, 'segunda do Bruno', 1),
        msg('a3', CARLA, 'oi da Carla', 2),
        msg('a4', ME, 'minha mensagem', 3),
      ],
      [OUTRA_EQUIPE_ID]: [msg('b1', BRUNO, 'Bruno na Beta', 0)],
    };
    apiGet.mockImplementation(async (url) => {
      const equipe = url.match(/\/equipes\/([0-9a-f]{24})\/messages/)?.[1];
      if (equipe) return { data: historicos[equipe] };
      return { data: [{ _id: EQUIPE_ID, nome: 'Equipe Alfa', membros: [ME, BRUNO, CARLA] }, { _id: OUTRA_EQUIPE_ID, nome: 'Equipe Beta', membros: [ME, BRUNO] }] };
    });
  });

  afterEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  const abrirChat = async () => {
    const view = render(<ChatsPage />);
    await screen.findByText('primeira do Bruno');
    return view;
  };
  const avatares = (nome) => screen.getAllByLabelText(nome).filter((el) => el.classList.contains('chat-avatar'));
  const imgs = (src) => [...document.querySelectorAll('.chat-avatar img')].filter((img) => img.getAttribute('src') === src);
  const falhar = (src) => imgs(src).forEach((img) => fireEvent.error(img));

  test('foto valida: imagem com a URL assinada completa, sem iniciais', async () => {
    await abrirChat();
    const [primeiro] = avatares('Bruno Lima');
    expect(primeiro.querySelector('img')).toHaveAttribute('src', `http://api.test${foto(2)}`);
    expect(primeiro).not.toHaveTextContent('BL');
  });

  test.each([
    ['sem foto', ''],
    ['foto nula', null],
    ['URL so com espacos', '   '],
    ['valor que nao e texto', { url: 'x' }],
  ])('%s: mostra as iniciais e nao cria imagem', async (_caso, fotoPerfil) => {
    historicos[EQUIPE_ID] = [msg('c1', { ...BRUNO, fotoPerfil }, 'primeira do Bruno', 0)];
    await abrirChat();
    const [avatar] = avatares('Bruno Lima');
    expect(avatar.querySelector('img')).toBeNull();
    expect(avatar).toHaveTextContent('BL');
  });

  test('erro de carregamento (ex.: assinatura expirada): troca pelas iniciais e mantem a identidade', async () => {
    await abrirChat();
    falhar(`http://api.test${foto(3)}`);
    const [avatar] = avatares('Carla Dias');
    expect(avatar.querySelector('img')).toBeNull();
    expect(avatar).toHaveTextContent('CD');
    expect(avatar).toHaveAttribute('aria-label', 'Carla Dias');
    expect(screen.getByText('oi da Carla')).toBeInTheDocument();
  });

  test('varias mensagens do mesmo usuario: uma falha vale para todas as linhas com a mesma URL', async () => {
    await abrirChat();
    const src = `http://api.test${foto(2)}`;
    expect(imgs(src)).toHaveLength(2);

    fireEvent.error(imgs(src)[0]);

    expect(imgs(src)).toHaveLength(0); // a segunda linha nao tenta de novo
    avatares('Bruno Lima').forEach((avatar) => expect(avatar).toHaveTextContent('BL'));
    // Outras pessoas nao sao afetadas.
    expect(imgs(`http://api.test${foto(3)}`)).toHaveLength(1);
    expect(imgs(`http://api.test${foto(1)}`)).toHaveLength(1);
  });

  test('sem loop: a URL que falhou nao volta a ser usada em novas renderizacoes nem recarrega o historico', async () => {
    await abrirChat();
    const chamadas = apiGet.mock.calls.length;
    const src = `http://api.test${foto(2)}`;
    falhar(src);

    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'texto novo' } }); // re-renderiza
    act(() => socket.trigger('receive_message', msg('a5', CARLA, 'outra da Carla', 5)));

    expect(imgs(src)).toHaveLength(0);
    expect(apiGet.mock.calls.length).toBe(chamadas);
  });

  test('mensagem nova com URL nova do mesmo usuario tenta uma vez; se falhar, iniciais', async () => {
    await abrirChat();
    falhar(`http://api.test${foto(2)}`);
    const nova = `http://api.test${foto(9)}`;

    act(() => socket.trigger('receive_message', msg('a6', { ...BRUNO, fotoPerfil: foto(9) }, 'Bruno de novo', 6)));
    await screen.findByText('Bruno de novo');
    expect(imgs(nova)).toHaveLength(1);

    falhar(nova);
    expect(imgs(nova)).toHaveLength(0);
    expect(avatares('Bruno Lima')).toHaveLength(3);
    avatares('Bruno Lima').forEach((avatar) => expect(avatar).toHaveTextContent('BL'));
  });

  test('URL externa (http) e usada como veio; se falhar, iniciais', async () => {
    const externa = 'https://storage.example.test/legado.png';
    historicos[EQUIPE_ID] = [msg('d1', { ...BRUNO, fotoPerfil: externa }, 'primeira do Bruno', 0)];
    await abrirChat();
    expect(imgs(externa)).toHaveLength(1);
    falhar(externa);
    expect(avatares('Bruno Lima')[0]).toHaveTextContent('BL');
  });

  test('troca de conversa: a nova equipe mostra as fotos dela; mensagens nao se duplicam', async () => {
    historicos[OUTRA_EQUIPE_ID] = [msg('b1', { ...BRUNO, fotoPerfil: foto(7) }, 'Bruno na Beta', 0)];
    await abrirChat();
    falhar(`http://api.test${foto(2)}`);

    fireEvent.click(screen.getByText('Equipe Beta'));
    await screen.findByText('Bruno na Beta');

    expect(screen.queryByText('primeira do Bruno')).not.toBeInTheDocument();
    expect(screen.getAllByText('Bruno na Beta')).toHaveLength(1);
    expect(imgs(`http://api.test${foto(7)}`)).toHaveLength(1);
  });

  test('desmontar depois de uma falha nao gera erro no console', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const view = await abrirChat();
    falhar(`http://api.test${foto(3)}`);
    view.unmount();
    expect(consoleError).not.toHaveBeenCalled();
  });

  test('mensagem propria tambem cai para as iniciais', async () => {
    await abrirChat();
    falhar(`http://api.test${foto(1)}`);
    const [avatar] = avatares('Ana Souza');
    expect(avatar.closest('.chat-message-row')).toHaveClass('mine');
    expect(avatar).toHaveTextContent('AS');
  });
});

describe('ChatsPage: seletor de arquivos (complementos)', () => {
  let socket;

  beforeAll(() => { Element.prototype.scrollIntoView = vi.fn(); });
  afterAll(() => { delete Element.prototype.scrollIntoView; });

  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem(LOCAL_STORAGE_KEYS.USER_ID, ME._id);
    apiGet.mockReset();
    apiPost.mockReset();
    socket = createFakeSocket();
    createSocket.mockReset();
    createSocket.mockReturnValue(socket);
    apiGet.mockImplementation(async (url) => {
      if (url.includes('/messages')) return { data: [msg('a1', BRUNO, 'primeira do Bruno', 0)] };
      return { data: [{ _id: EQUIPE_ID, nome: 'Equipe Alfa', membros: [ME, BRUNO] }] };
    });
    URL.createObjectURL = vi.fn(() => 'blob:flowly-1');
    URL.revokeObjectURL = vi.fn();
  });

  afterEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  const abrirChat = async () => {
    render(<ChatsPage />);
    await screen.findByText('primeira do Bruno');
  };
  const inputArquivo = () => screen.getByTestId('chat-file-input');
  const botaoAnexar = () => screen.getByRole('button', { name: /Anexar arquivo/ });
  const pdf = (nome = 'ata.pdf') => new File(['x'], nome, { type: 'application/pdf' });

  test('selecao unica: o input nao aceita varios arquivos e so o primeiro vira rascunho', async () => {
    await abrirChat();
    expect(inputArquivo()).not.toHaveAttribute('multiple');

    fireEvent.change(inputArquivo(), { target: { files: [pdf('um.pdf'), pdf('dois.pdf')] } });

    expect(screen.getByText('um.pdf')).toBeInTheDocument();
    expect(screen.queryByText('dois.pdf')).not.toBeInTheDocument();
  });

  test('o mesmo arquivo pode ser escolhido de novo depois de removido (valor do input limpo)', async () => {
    await abrirChat();
    const file = pdf();
    fireEvent.change(inputArquivo(), { target: { files: [file] } });
    expect(inputArquivo().value).toBe('');

    fireEvent.click(screen.getByRole('button', { name: 'Remover arquivo selecionado' }));
    fireEvent.change(inputArquivo(), { target: { files: [file] } });

    expect(screen.getByText('ata.pdf')).toBeInTheDocument();
  });

  test('cada clique pede uma abertura so; durante o envio o botao fica bloqueado', async () => {
    await abrirChat();
    const clickSpy = vi.spyOn(inputArquivo(), 'click');
    fireEvent.click(botaoAnexar());
    expect(clickSpy).toHaveBeenCalledTimes(1);

    let concluir;
    apiPost.mockImplementation(() => new Promise((resolve) => { concluir = resolve; }));
    fireEvent.change(inputArquivo(), { target: { files: [pdf()] } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /^(Enviar|Enviando\.\.\.)$/ })); });

    expect(botaoAnexar()).toBeDisabled();
    fireEvent.click(botaoAnexar());
    expect(clickSpy).toHaveBeenCalledTimes(1);

    await act(async () => { concluir({ data: { message: null } }); });
    await waitFor(() => expect(botaoAnexar()).not.toBeDisabled());
  });

  test('sem equipe selecionada o seletor nao abre', async () => {
    apiGet.mockImplementation(async () => ({ data: [] }));
    render(<ChatsPage />);
    await waitFor(() => expect(apiGet).toHaveBeenCalled());
    const clickSpy = vi.spyOn(inputArquivo(), 'click');

    expect(botaoAnexar()).toBeDisabled();
    fireEvent.click(botaoAnexar());
    expect(clickSpy).not.toHaveBeenCalled();
  });
});
