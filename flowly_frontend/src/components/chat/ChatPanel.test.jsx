import { act, fireEvent, render, screen, within } from '@testing-library/react';
import ChatPanel from './ChatPanel';
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

const USER_ID = '507f1f77bcf86cd799439011';
const EQUIPE_ID = '507f1f77bcf86cd799439013';

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
    sendCalls: () => socket.emit.mock.calls.filter(([event]) => event === 'send_message'),
  };
  socket.timeout = vi.fn(() => ({ emit: socket.emit }));
  return socket;
};

describe('ChatPanel: envio com confirmacao do servidor', () => {
  let socket;

  beforeAll(() => {
    Element.prototype.scrollIntoView = vi.fn();
  });

  afterAll(() => {
    delete Element.prototype.scrollIntoView;
  });

  beforeEach(() => {
    localStorage.setItem(LOCAL_STORAGE_KEYS.USER_ID, USER_ID);
    apiGet.mockReset();
    apiGet.mockImplementation(async (url) => (url.includes('/messages')
      ? { data: [] }
      : { data: [{ _id: EQUIPE_ID, nome: 'Equipe Alfa', membros: [] }] }));
    socket = createFakeSocket();
    createSocket.mockReset();
    createSocket.mockReturnValue(socket);
  });

  afterEach(() => {
    localStorage.clear();
  });

  const openAndType = async (text) => {
    render(<ChatPanel />);
    fireEvent.click(await screen.findByRole('button', { name: 'Chat da Equipe' }));
    fireEvent.change(screen.getByPlaceholderText('Digite sua mensagem...'), { target: { value: text } });
    fireEvent.click(screen.getByRole('button', { name: 'Enviar' }));
  };

  test('mensagem bloqueada mantem o texto e mostra o motivo', async () => {
    await openAndType('texto recusado');

    expect(socket.sendCalls()).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Enviando...' })).toBeDisabled();

    await act(async () => {
      socket.sendCalls()[0][2](null, { ok: false, blocked: true, message: 'Parece conter uma ameaça.' });
    });

    expect(screen.getByPlaceholderText('Digite sua mensagem...')).toHaveValue('texto recusado');
    const alert = screen.getByRole('alert');
    expect(within(alert).getByText('Mensagem bloqueada')).toBeInTheDocument();
    expect(within(alert).getByText('Parece conter uma ameaça.')).toBeInTheDocument();
  });

  test('confirmacao do servidor limpa o campo', async () => {
    await openAndType('Bom dia');

    await act(async () => {
      socket.sendCalls()[0][2](null, { ok: true, messageId: 'm1' });
    });

    expect(screen.getByPlaceholderText('Digite sua mensagem...')).toHaveValue('');
  });
});
