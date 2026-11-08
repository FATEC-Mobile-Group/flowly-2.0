import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import ChatsPage from './ChatsPage';
import { LOCAL_STORAGE_KEYS } from '../../config/config';

const { apiGet, createSocket } = vi.hoisted(() => ({
  apiGet: vi.fn(),
  createSocket: vi.fn(),
}));

vi.mock('../../config/apiClient', () => ({
  __esModule: true,
  default: { get: apiGet },
  getFullApiUrl: (path) => path,
}));

vi.mock('../../config/socketClient', () => ({
  __esModule: true,
  default: createSocket,
}));

vi.mock('../../components/layout/Sidebar', () => ({
  __esModule: true,
  default: () => null,
}));

const CURRENT_USER_ID = '507f1f77bcf86cd799439011';
const OTHER_USER_ID = '507f1f77bcf86cd799439012';
const EQUIPE_ID = '507f1f77bcf86cd799439013';

const CURRENT_USER = { _id: CURRENT_USER_ID, nome: 'Usuario Atual', fotoPerfil: '' };
const OTHER_USER = { _id: OTHER_USER_ID, nome: 'Outra Pessoa', fotoPerfil: '' };

const MY_MESSAGE = {
  _id: 'mensagem-1',
  texto: 'Mensagem minha',
  createdAt: '2026-11-08T10:00:00.000Z',
  user: CURRENT_USER,
};

const OTHER_MESSAGE = {
  _id: 'mensagem-2',
  texto: 'Mensagem de outra pessoa',
  createdAt: '2026-11-08T10:01:00.000Z',
  user: OTHER_USER,
};

const createFakeSocket = () => {
  const handlers = {};
  return {
    on: vi.fn((event, handler) => {
      handlers[event] = handler;
    }),
    emit: vi.fn(),
    disconnect: vi.fn(),
    trigger: (event, ...args) => handlers[event]?.(...args),
  };
};

const mockChatApi = (messages) => {
  apiGet.mockImplementation(async (url) => {
    if (url.includes('/messages')) {
      return { data: messages };
    }
    return {
      data: [{ _id: EQUIPE_ID, nome: 'Equipe Alfa', membros: [CURRENT_USER, OTHER_USER] }],
    };
  });
};

const getMessageRow = (text) => screen.getByText(text).closest('.chat-message-row');

describe('ChatsPage: mensagens de uma equipe', () => {
  let socket;

  beforeAll(() => {
    // O jsdom nao implementa scrollIntoView, usado para rolar ate a ultima mensagem.
    Element.prototype.scrollIntoView = vi.fn();
  });

  afterAll(() => {
    delete Element.prototype.scrollIntoView;
  });

  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem(LOCAL_STORAGE_KEYS.USER_ID, CURRENT_USER_ID);

    apiGet.mockReset();
    createSocket.mockReset();
    socket = createFakeSocket();
    createSocket.mockReturnValue(socket);
  });

  afterEach(() => {
    localStorage.clear();
  });

  test('renderiza equipe com mensagens sem ReferenceError', async () => {
    mockChatApi([MY_MESSAGE, OTHER_MESSAGE]);

    render(<ChatsPage />);

    expect(await screen.findByText(MY_MESSAGE.texto)).toBeInTheDocument();
    expect(screen.getByText(OTHER_MESSAGE.texto)).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Chats' })).toBeInTheDocument();
  });

  test('apresenta a mensagem do usuario atual como minha', async () => {
    mockChatApi([MY_MESSAGE, OTHER_MESSAGE]);

    render(<ChatsPage />);
    await screen.findByText(MY_MESSAGE.texto);

    const row = getMessageRow(MY_MESSAGE.texto);
    expect(row).toHaveClass('mine');
    expect(row).not.toHaveClass('theirs');
    expect(within(row).queryByText(CURRENT_USER.nome)).not.toBeInTheDocument();
    expect(row.lastElementChild).toHaveClass('chat-avatar');
  });

  test('apresenta a mensagem de outro usuario como de outro participante', async () => {
    mockChatApi([MY_MESSAGE, OTHER_MESSAGE]);

    render(<ChatsPage />);
    await screen.findByText(OTHER_MESSAGE.texto);

    const row = getMessageRow(OTHER_MESSAGE.texto);
    expect(row).toHaveClass('theirs');
    expect(row).not.toHaveClass('mine');
    expect(within(row).getByText(OTHER_USER.nome)).toBeInTheDocument();
    expect(row.firstElementChild).toHaveClass('chat-avatar');
  });

  test('renderiza a primeira mensagem recebida por socket em equipe vazia', async () => {
    mockChatApi([]);

    render(<ChatsPage />);

    // Aguarda o historico terminar: so entao o socket esta pronto e a lista vazia e definitiva.
    await waitFor(() => {
      expect(apiGet).toHaveBeenCalledWith(expect.stringContaining('/messages'));
    });
    await act(async () => {
      await apiGet.mock.results.at(-1).value;
    });
    expect(screen.getByText(/Nenhuma mensagem ainda/)).toBeInTheDocument();

    act(() => {
      socket.trigger('receive_message', OTHER_MESSAGE);
    });

    expect(getMessageRow(OTHER_MESSAGE.texto)).toHaveClass('theirs');
  });

  test('nao envia userId em requisicoes nem em eventos do socket', async () => {
    mockChatApi([MY_MESSAGE, OTHER_MESSAGE]);

    render(<ChatsPage />);
    await screen.findByText(MY_MESSAGE.texto);

    act(() => {
      socket.trigger('connect');
    });
    fireEvent.change(screen.getByPlaceholderText('Digite sua mensagem...'), {
      target: { value: 'Nova mensagem' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Enviar' }));

    expect(socket.emit).toHaveBeenCalledTimes(2);
    expect(socket.emit).toHaveBeenNthCalledWith(1, 'join_equipe', EQUIPE_ID);
    expect(socket.emit).toHaveBeenNthCalledWith(2, 'send_message', {
      equipeId: EQUIPE_ID,
      texto: 'Nova mensagem',
    });

    const outgoing = JSON.stringify({
      requests: apiGet.mock.calls,
      socketConnection: createSocket.mock.calls,
      socketEvents: socket.emit.mock.calls,
    });
    expect(outgoing).not.toContain('userId');
    expect(outgoing).not.toContain(CURRENT_USER_ID);
  });
});
