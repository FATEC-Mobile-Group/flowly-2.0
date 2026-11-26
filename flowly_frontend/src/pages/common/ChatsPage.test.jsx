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
  const socket = {
    connected: true,
    on: vi.fn((event, handler) => {
      handlers[event] = [...(handlers[event] || []), handler];
    }),
    off: vi.fn((event, handler) => {
      handlers[event] = (handlers[event] || []).filter((item) => item !== handler);
    }),
    emit: vi.fn(),
    disconnect: vi.fn(),
    trigger: (event, ...args) => (handlers[event] || []).forEach((handler) => handler(...args)),
    // Callback de ACK do ultimo send_message emitido.
    lastAck: () => socket.emit.mock.calls.filter(([event]) => event === 'send_message').at(-1)?.[2],
    sendCount: () => socket.emit.mock.calls.filter(([event]) => event === 'send_message').length,
  };
  socket.timeout = vi.fn(() => ({ emit: socket.emit }));
  return socket;
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
      expect(apiGet).toHaveBeenCalledWith(expect.stringContaining('/messages'), { params: { limit: 50 } });
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
    expect(socket.emit).toHaveBeenNthCalledWith(
      2,
      'send_message',
      { equipeId: EQUIPE_ID, texto: 'Nova mensagem' },
      expect.any(Function),
    );

    const outgoing = JSON.stringify({
      requests: apiGet.mock.calls,
      socketConnection: createSocket.mock.calls,
      socketEvents: socket.emit.mock.calls,
    });
    expect(outgoing).not.toContain('userId');
    expect(outgoing).not.toContain(CURRENT_USER_ID);
  });

  describe('envio com confirmacao do servidor', () => {
    const openChat = async () => {
      mockChatApi([MY_MESSAGE]);
      render(<ChatsPage />);
      await screen.findByText(MY_MESSAGE.texto);
    };
    const input = () => screen.getByPlaceholderText('Digite sua mensagem...');
    const type = (value) => fireEvent.change(input(), { target: { value } });
    const send = () => fireEvent.click(screen.getByRole('button', { name: /Enviar|Enviando/ }));

    test('limpa o campo somente depois da confirmacao do servidor', async () => {
      await openChat();
      type('Bom dia, equipe');
      send();

      expect(socket.sendCount()).toBe(1);
      expect(input()).toHaveValue('Bom dia, equipe');
      expect(screen.getByRole('button', { name: 'Enviando...' })).toBeDisabled();

      await act(async () => {
        socket.lastAck()(null, { ok: true, messageId: 'm1' });
      });

      expect(input()).toHaveValue('');
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });

    test('mensagem bloqueada mantem o texto, explica o motivo e permite corrigir e reenviar', async () => {
      await openChat();
      type('texto recusado');
      send();

      await act(async () => {
        socket.lastAck()(null, {
          ok: false,
          blocked: true,
          reason: 'unsafe_content',
          message: 'Sua mensagem não foi enviada porque parece conter um insulto.',
        });
      });

      expect(input()).toHaveValue('texto recusado');
      const alert = screen.getByRole('alert');
      expect(within(alert).getByText('Mensagem bloqueada')).toBeInTheDocument();
      expect(within(alert).getByText(/parece conter um insulto/)).toBeInTheDocument();

      type('texto corrigido');
      send();
      expect(socket.sendCount()).toBe(2);
      expect(socket.emit.mock.calls.at(-1)[1]).toEqual({ equipeId: EQUIPE_ID, texto: 'texto corrigido' });
    });

    test('nao envia de novo enquanto o primeiro envio esta pendente', async () => {
      await openChat();
      type('Bom dia');
      send();
      fireEvent.submit(input().closest('form'));
      send();

      expect(socket.sendCount()).toBe(1);
    });

    test('sem resposta do servidor mantem o texto, avisa e nao reenvia sozinho', async () => {
      await openChat();
      type('Bom dia');
      send();

      await act(async () => {
        socket.lastAck()(new Error('operation has timed out'));
      });

      expect(input()).toHaveValue('Bom dia');
      expect(within(screen.getByRole('alert')).getByText('Envio não confirmado')).toBeInTheDocument();
      expect(socket.sendCount()).toBe(1);
      expect(screen.getByRole('button', { name: 'Enviar' })).toBeEnabled();
    });

    test('falha temporaria do servidor mantem o texto e informa o erro', async () => {
      await openChat();
      type('Bom dia');
      send();

      await act(async () => {
        socket.lastAck()(null, { ok: false, blocked: false, reason: 'send_failed', message: 'Não foi possível enviar a mensagem agora.' });
      });

      expect(input()).toHaveValue('Bom dia');
      expect(within(screen.getByRole('alert')).getByText('Mensagem não enviada')).toBeInTheDocument();
    });

    test('queda da conexao durante o envio vira resultado incerto', async () => {
      await openChat();
      type('Bom dia');
      send();

      await act(async () => {
        socket.trigger('disconnect');
      });

      expect(input()).toHaveValue('Bom dia');
      expect(within(screen.getByRole('alert')).getByText('Envio não confirmado')).toBeInTheDocument();
      expect(socket.sendCount()).toBe(1);
    });

    test('desconectado nao emite e mantem o texto', async () => {
      await openChat();
      socket.connected = false;
      type('Bom dia');
      await act(async () => {
        send();
      });

      expect(socket.sendCount()).toBe(0);
      expect(input()).toHaveValue('Bom dia');
      expect(within(screen.getByRole('alert')).getByText(/Sem conexão/)).toBeInTheDocument();
    });

    // Igual ao socket.io-client: disconnect() emite 'disconnect' e descarta os ACKs pendentes.
    const disconnectLikeRealClient = (fake) => {
      fake.disconnect.mockImplementation(() => {
        if (!fake.connected) return;
        fake.connected = false;
        fake.trigger('disconnect', 'io client disconnect');
      });
    };

    // Rascunho por conversa (PR #67): o texto da Alfa fica com a Alfa; a Beta abre com o rascunho dela.
    test('trocar de equipe durante o envio nao apaga o rascunho nem envia na outra equipe', async () => {
      const OTHER_EQUIPE_ID = '507f1f77bcf86cd799439014';
      const secondSocket = createFakeSocket();
      createSocket.mockReset();
      createSocket.mockReturnValueOnce(socket).mockReturnValue(secondSocket);
      disconnectLikeRealClient(socket);
      apiGet.mockImplementation(async (url) => (url.includes('/messages')
        ? { data: [] }
        : {
          data: [
            { _id: EQUIPE_ID, nome: 'Equipe Alfa', membros: [] },
            { _id: OTHER_EQUIPE_ID, nome: 'Equipe Beta', membros: [] },
          ],
        }));
      render(<ChatsPage />);
      await screen.findByText(/Nenhuma mensagem ainda/);

      type('mensagem da Alfa');
      send();
      expect(socket.sendCount()).toBe(1);
      const lateAck = socket.lastAck();

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: /Equipe Beta/ }));
      });

      expect(socket.disconnect).toHaveBeenCalled();
      // O texto nao vai para a conversa errada: a Beta abre vazia.
      expect(input()).toHaveValue('');
      expect(within(screen.getByRole('alert')).getByText('Envio não confirmado')).toBeInTheDocument();
      expect(secondSocket.sendCount()).toBe(0);

      // Novo rascunho na Beta: um ACK atrasado da Alfa nao pode apaga-lo.
      type('rascunho da Beta');
      await act(async () => {
        lateAck(null, { ok: true, messageId: 'm-atrasada' });
      });
      expect(input()).toHaveValue('rascunho da Beta');
      expect(secondSocket.sendCount()).toBe(0);

      // Voltando para a Alfa, o texto que nao teve confirmacao continua la; a Beta guarda o dela.
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: /Equipe Alfa/ }));
      });
      expect(input()).toHaveValue('mensagem da Alfa');
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: /Equipe Beta/ }));
      });
      expect(input()).toHaveValue('rascunho da Beta');
    });

    test('ACK que chega depois do prazo nao apaga um rascunho novo', async () => {
      await openChat();
      type('primeira tentativa');
      send();
      const ack = socket.lastAck();

      await act(async () => {
        ack(new Error('operation has timed out'));
      });
      type('rascunho novo');
      await act(async () => {
        ack(null, { ok: true, messageId: 'm1' });
      });

      expect(input()).toHaveValue('rascunho novo');
      expect(socket.sendCount()).toBe(1);
    });

    test('desmontar durante o envio nao gera erro nem atualizacao de estado', async () => {
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        disconnectLikeRealClient(socket);
        mockChatApi([MY_MESSAGE]);
        const { unmount } = render(<ChatsPage />);
        await screen.findByText(MY_MESSAGE.texto);
        type('Bom dia');
        send();
        const ack = socket.lastAck();

        await act(async () => {
          unmount();
        });
        await act(async () => {
          ack(null, { ok: true, messageId: 'm1' });
        });

        expect(socket.disconnect).toHaveBeenCalled();
        expect(socket.off).toHaveBeenCalledWith('disconnect', expect.any(Function));
        expect(socket.off).toHaveBeenCalledWith('message_blocked', expect.any(Function));
        expect(consoleError).not.toHaveBeenCalled();
      } finally {
        consoleError.mockRestore();
      }
    });

    test('servidor sem ACK: message_blocked ainda encerra o envio como bloqueado', async () => {
      await openChat();
      type('texto recusado');
      send();

      await act(async () => {
        socket.trigger('message_blocked', { reason: 'unsafe_content', message: 'Mensagem bloqueada por seguranca.' });
      });

      expect(input()).toHaveValue('texto recusado');
      expect(within(screen.getByRole('alert')).getByText('Mensagem bloqueada')).toBeInTheDocument();
    });
  });
});
