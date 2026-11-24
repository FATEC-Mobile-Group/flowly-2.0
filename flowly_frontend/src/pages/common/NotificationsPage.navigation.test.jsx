// Notificacoes acionaveis: destino so com id valido, rota pelo perfil, marcar como lida sem duplicar e sem falso sucesso.
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { API_ENDPOINTS } from '../../config/config';
import { authUtils } from '../../config/authUtils';
import NotificationsPage from './NotificationsPage';
import { notificationTarget } from '../../utils/navigationRequests';

const { apiGet, apiPut } = vi.hoisted(() => ({ apiGet: vi.fn(), apiPut: vi.fn() }));
vi.mock('../../config/apiClient', () => ({ __esModule: true, default: { get: apiGet, put: apiPut } }));
vi.mock('../../components/layout/Sidebar', () => ({ __esModule: true, default: () => null }));

const TAREFA = 'a'.repeat(24);
const EQUIPE = 'e'.repeat(24);
const notifications = () => [
  { _id: 'n1', tipo: 'task', texto: 'Ana marcou a tarefa "Relatório" como concluída', lida: false, origemId: TAREFA,
    metadata: { tarefaId: TAREFA }, createdAt: '2026-11-23T12:00:00.000Z' },
  { _id: 'n2', tipo: 'chat', texto: 'Bruno enviou um arquivo no chat da equipe Projeto Integrador', lida: true,
    metadata: { equipeId: EQUIPE, equipeNome: 'Projeto Integrador' }, createdAt: '2026-11-23T12:01:00.000Z' },
  { _id: 'n3', tipo: 'system', texto: 'Insights do assistente prontos', lida: false, metadata: {}, createdAt: '2026-11-23T12:02:00.000Z' },
  { _id: 'n4', tipo: 'task', texto: 'Tarefa antiga sem referência', lida: false, metadata: { tarefaId: '123' }, createdAt: '2026-11-23T12:03:00.000Z' },
];

function Destino() {
  const location = useLocation();
  return <p data-testid="destino">{`${location.pathname}|${JSON.stringify(location.state)}`}</p>;
}

const renderPage = () => render(
  <MemoryRouter initialEntries={['/notificacoes']}>
    <Routes>
      <Route path="/notificacoes" element={<NotificationsPage />} />
      {['/minhas-tarefas', '/admin/tarefas', '/chats', '/admin/chats'].map((path) => (
        <Route key={path} path={path} element={<Destino />} />
      ))}
    </Routes>
  </MemoryRouter>,
);

const card = (text) => screen.getByText(text).closest('article');

beforeEach(() => {
  apiGet.mockReset();
  apiPut.mockReset();
  apiGet.mockResolvedValue({ data: notifications() });
  apiPut.mockResolvedValue({ data: { ok: true } });
  vi.spyOn(authUtils, 'getUserType').mockReturnValue('user');
});

afterEach(() => vi.restoreAllMocks());

test('rotulos em portugues e acoes so para notificacoes com destino confiavel', async () => {
  renderPage();
  await screen.findByText(/marcou a tarefa/);
  expect(within(card(/marcou a tarefa/)).getByText('Tarefa')).toBeInTheDocument();
  expect(within(card(/enviou um arquivo/)).getByText('Mensagem')).toBeInTheDocument();
  expect(within(card(/Insights/)).getByText('Sistema')).toBeInTheDocument();

  expect(within(card(/marcou a tarefa/)).getByRole('button', { name: 'Ver tarefa' })).toBeInTheDocument();
  expect(within(card(/enviou um arquivo/)).getByRole('button', { name: 'Abrir conversa' })).toBeInTheDocument();
  // Sistema e id malformado: legiveis, sem link falso, ainda podem ser marcadas como lidas.
  expect(within(card(/Insights/)).queryByRole('button', { name: /Ver tarefa|Abrir conversa/ })).toBeNull();
  expect(within(card(/sem referência/)).queryByRole('button', { name: /Ver tarefa/ })).toBeNull();
  expect(within(card(/sem referência/)).getByRole('button', { name: 'Marcar como lida' })).toBeInTheDocument();
});

test('colaborador: Ver tarefa marca como lida uma vez e abre Minhas tarefas com o pedido da tarefa', async () => {
  renderPage();
  const button = await screen.findByRole('button', { name: 'Ver tarefa' });
  await act(async () => {
    fireEvent.click(button);
    fireEvent.click(button);
  });
  expect(apiPut).toHaveBeenCalledTimes(1);
  expect(apiPut).toHaveBeenCalledWith(API_ENDPOINTS.NOTIFICATIONS_MARK_READ('n1'), {});
  expect(screen.getByTestId('destino')).toHaveTextContent(`/minhas-tarefas|{"abrirTarefaId":"${TAREFA}"}`);
});

test('notificacao ja lida abre a conversa sem nova escrita', async () => {
  renderPage();
  const abrir = await screen.findByRole('button', { name: 'Abrir conversa' });
  await act(async () => {
    fireEvent.click(abrir);
  });
  expect(apiPut).not.toHaveBeenCalled();
  expect(screen.getByTestId('destino')).toHaveTextContent(`/chats|{"equipeId":"${EQUIPE}"}`);
});

test('administrador usa as rotas administrativas', async () => {
  authUtils.getUserType.mockReturnValue('admin');
  renderPage();
  const ver = await screen.findByRole('button', { name: 'Ver tarefa' });
  await act(async () => {
    fireEvent.click(ver);
  });
  expect(screen.getByTestId('destino')).toHaveTextContent(`/admin/tarefas|{"abrirTarefaId":"${TAREFA}"}`);
  expect(notificationTarget(notifications()[1], 'admin')).toEqual({
    to: '/admin/chats', state: { equipeId: EQUIPE }, label: 'Abrir conversa',
  });
});

test('falha ao marcar como lida nao vira sucesso', async () => {
  apiPut.mockRejectedValue(new Error('500'));
  renderPage();
  await screen.findByText(/Insights/);
  const item = card(/Insights/);
  await act(async () => {
    fireEvent.click(within(item).getByRole('button', { name: 'Marcar como lida' }));
  });
  expect(screen.getByText('Erro ao marcar notificação como lida.')).toBeInTheDocument();
  expect(item).toHaveClass('unread');
  expect(within(item).getByRole('button', { name: 'Marcar como lida' })).toBeInTheDocument();
});

test('marcar como lida e marcar todas continuam funcionando', async () => {
  renderPage();
  await screen.findByText(/Insights/);
  const item = card(/Insights/);
  await act(async () => {
    fireEvent.click(within(item).getByRole('button', { name: 'Marcar como lida' }));
  });
  expect(item).toHaveClass('read');
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Marcar todas como lidas' }));
  });
  expect(apiPut).toHaveBeenLastCalledWith(API_ENDPOINTS.NOTIFICATIONS_MARK_ALL_READ, {});
  expect(document.querySelectorAll('.notification-card.unread')).toHaveLength(0);
});

test('destino calculado so com ids no formato do Mongo', () => {
  expect(notificationTarget({ tipo: 'task', origemId: TAREFA, metadata: {} }, 'user')?.state).toEqual({ abrirTarefaId: TAREFA });
  expect(notificationTarget({ tipo: 'chat', metadata: { equipeId: '../admin' } }, 'user')).toBeNull();
  expect(notificationTarget({ tipo: 'team', metadata: { equipeId: EQUIPE } }, 'user')).toBeNull();
  expect(notificationTarget(null, 'user')).toBeNull();
});
