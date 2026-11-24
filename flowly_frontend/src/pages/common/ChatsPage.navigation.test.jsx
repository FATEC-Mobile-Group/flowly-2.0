// Chat aberto a partir de outra tela: a equipe pedida via state so e selecionada se estiver entre as autorizadas.
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { LOCAL_STORAGE_KEYS } from '../../config/config';
import ChatsPage from './ChatsPage';

const { apiGet, createSocket } = vi.hoisted(() => ({ apiGet: vi.fn(), createSocket: vi.fn() }));
vi.mock('../../config/apiClient', () => ({ __esModule: true, default: { get: apiGet }, getFullApiUrl: (p) => p }));
vi.mock('../../config/socketClient', () => ({ __esModule: true, default: createSocket }));
vi.mock('../../components/layout/Sidebar', () => ({ __esModule: true, default: () => null }));

const ME = '507f1f77bcf86cd799439011';
const ALFA = '507f1f77bcf86cd799439013';
const BETA = '507f1f77bcf86cd799439014';
const ALHEIA = '507f1f77bcf86cd799439099';

const fakeSocket = () => {
  const socket = { connected: true, on: vi.fn(), off: vi.fn(), emit: vi.fn(), disconnect: vi.fn() };
  socket.timeout = vi.fn(() => ({ emit: socket.emit }));
  return socket;
};

function Estado() {
  const location = useLocation();
  return <p data-testid="estado">{JSON.stringify(location.state)}</p>;
}

const renderChat = (state) => render(
  <MemoryRouter initialEntries={[{ pathname: '/chats', state }]}>
    <Routes>
      <Route path="/chats" element={<><ChatsPage /><Estado /></>} />
    </Routes>
  </MemoryRouter>,
);

const messagesUrls = () => apiGet.mock.calls.map(([url]) => url).filter((url) => url.includes('/messages'));
const activeTeam = () => document.querySelector('.chats-team-list .active, li button.active')?.textContent || '';

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
});

beforeEach(() => {
  localStorage.setItem(LOCAL_STORAGE_KEYS.USER_ID, ME);
  apiGet.mockReset();
  createSocket.mockReset();
  createSocket.mockImplementation(fakeSocket);
  apiGet.mockImplementation(async (url) => {
    if (url.includes(`/equipes/${ALFA}/messages`)) return { data: [{ _id: 'm1', texto: 'mensagem da Alfa', user: { _id: ME, nome: 'Eu' } }] };
    if (url.includes(`/equipes/${BETA}/messages`)) return { data: [{ _id: 'm2', texto: 'mensagem da Beta', user: { _id: ME, nome: 'Eu' } }] };
    if (url.includes('/messages')) return { data: [] };
    return { data: [{ _id: ALFA, nome: 'Equipe Alfa', membros: [] }, { _id: BETA, nome: 'Projeto Integrador', membros: [] }] };
  });
});

afterEach(() => localStorage.clear());

test('equipe autorizada pedida pela navegacao e aberta e o pedido e consumido', async () => {
  renderChat({ equipeId: BETA });
  expect(await screen.findByText('mensagem da Beta')).toBeInTheDocument();
  expect(activeTeam()).toContain('Projeto Integrador');
  expect(messagesUrls()).toEqual([`/equipes/${BETA}/messages`]); // nada da equipe padrao foi carregado
  await waitFor(() => expect(screen.getByTestId('estado')).toHaveTextContent('null'));
});

test('equipe fora das autorizadas: nada e revelado, fica a selecao padrao e um aviso', async () => {
  renderChat({ equipeId: ALHEIA });
  expect(await screen.findByText('mensagem da Alfa')).toBeInTheDocument();
  expect(screen.getByRole('alert')).toHaveTextContent('A equipe solicitada não está entre as suas conversas.');
  expect(messagesUrls()).toEqual([`/equipes/${ALFA}/messages`]);
  expect(apiGet.mock.calls.some(([url]) => url.includes(ALHEIA))).toBe(false);
});

test('id malformado tambem nao seleciona nada fora da lista', async () => {
  renderChat({ equipeId: '../admin' });
  expect(await screen.findByText('mensagem da Alfa')).toBeInTheDocument();
  expect(screen.getByRole('alert')).toHaveTextContent('Conversa indisponível');
});

test('sem pedido de navegacao a pagina continua com a primeira equipe e sem aviso', async () => {
  renderChat(undefined);
  expect(await screen.findByText('mensagem da Alfa')).toBeInTheDocument();
  expect(screen.queryByRole('alert')).toBeNull();
});

test('troca manual depois da selecao inicial vale normalmente', async () => {
  renderChat({ equipeId: BETA });
  await screen.findByText('mensagem da Beta');
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: /Equipe Alfa/ }));
  });
  expect(await screen.findByText('mensagem da Alfa')).toBeInTheDocument();
  expect(activeTeam()).toContain('Equipe Alfa');
});
