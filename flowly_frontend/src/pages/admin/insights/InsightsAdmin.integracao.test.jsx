// Integracao dos Insights (PR #64): rota protegida, item do menu administrativo, atalho do Painel Geral e
// notificacoes de alerta de equipe abrindo a aba Alertas. Notificacoes de tarefa e chat continuam iguais.
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import App from '../../../App';
import Sidebar from '../../../components/layout/Sidebar';
import NotificationsPage from '../../common/NotificationsPage';
import DashboardGeral from '../../dashboard/DashboardGeral';
import apiClient from '../../../config/apiClient';
import { API_ENDPOINTS, LOCAL_STORAGE_KEYS } from '../../../config/config';
import { notificationTarget } from '../../../utils/navigationRequests';

vi.mock('../../../config/apiClient', () => ({
  __esModule: true,
  default: { get: vi.fn(), put: vi.fn(), post: vi.fn() },
  getFullApiUrl: (caminho = '') => caminho,
}));
vi.mock('../../../config/socketClient', () => ({
  __esModule: true,
  default: () => ({ on: vi.fn(), emit: vi.fn(), disconnect: vi.fn(), connected: false }),
}));
vi.mock('../../../components/layout/ColorBendsBackground', () => ({ __esModule: true, default: () => null }));
vi.mock('../../../components/timer/FloatingTimer', () => ({ __esModule: true, default: () => null }));
vi.mock('react-chartjs-2', () => ({ Doughnut: () => null, Line: () => null }));
vi.mock('../../../components/backgrounds/LightRays', () => ({ __esModule: true, default: () => null }));
vi.mock('../../../components/text/CurvedLoop', () => ({ __esModule: true, default: () => null }));

const oid = (n) => n.toString(16).padStart(24, '0');
const EQUIPE = oid(11);
const INSIGHT = oid(600);

const sessao = (tipo) => {
  localStorage.setItem(LOCAL_STORAGE_KEYS.TOKEN, 'token-de-teste');
  localStorage.setItem(LOCAL_STORAGE_KEYS.USER_TYPE, tipo);
  localStorage.setItem(LOCAL_STORAGE_KEYS.USER_NAME, tipo === 'admin' ? 'Admin Teste' : 'Ana');
  localStorage.setItem(LOCAL_STORAGE_KEYS.USER_ID, oid(1));
};

const pedidosInsights = () => apiClient.get.mock.calls.filter(([url]) => url === API_ENDPOINTS.ADMIN_ASSISTANT_INSIGHTS);

function Sonda() {
  const location = useLocation();
  return <p data-testid="local">{`${location.pathname}${location.search}|${JSON.stringify(location.state ?? null)}`}</p>;
}
const local = () => screen.getByTestId('local').textContent;

beforeEach(() => {
  localStorage.clear();
  apiClient.get.mockReset();
  apiClient.put.mockReset();
  apiClient.get.mockImplementation(() => new Promise(() => {}));
  apiClient.put.mockResolvedValue({ data: { ok: true } });
});

describe('rota /admin/insights', () => {
  const abrir = (url) => {
    window.history.pushState({}, '', url);
    return render(<App />);
  };

  test('administrador abre a pagina, que consulta o contrato novo', async () => {
    sessao('admin');
    abrir(`/admin/insights?equipe=${EQUIPE}&aba=alertas`);
    expect(await screen.findByRole('heading', { name: 'Insights inteligentes' })).toBeInTheDocument();
    expect(window.location.pathname).toBe('/admin/insights');
    expect(pedidosInsights()[0][1].params).toEqual({ versao: 2, periodo: 7, equipe: EQUIPE });
  });

  test('colaborador e levado para a propria home, sem consultar os Insights', async () => {
    sessao('user');
    abrir('/admin/insights');
    await act(async () => {});
    expect(window.location.pathname).toBe('/dashboard');
    expect(screen.queryByRole('heading', { name: 'Insights inteligentes' })).toBeNull();
    expect(pedidosInsights()).toHaveLength(0);
  });

  test('sem sessao volta ao login', async () => {
    abrir('/admin/insights');
    await act(async () => {});
    expect(window.location.pathname).toBe('/');
    expect(pedidosInsights()).toHaveLength(0);
  });
});

describe('menu lateral', () => {
  const renderMenu = (rota = '/admin/geral') => render(
    <MemoryRouter initialEntries={[rota]}>
      <Sidebar />
    </MemoryRouter>,
  );

  test('administrador: item Insights inteligentes, marcado como atual na pagina', () => {
    sessao('admin');
    renderMenu('/admin/insights');
    const item = screen.getByRole('link', { name: /Insights inteligentes/ });
    expect(item).toHaveAttribute('href', '/admin/insights');
    expect(item.className).toContain('active');
    expect(screen.getByRole('link', { name: /Painel Geral/ }).className).not.toContain('active');
  });

  test('colaborador: sem o item', () => {
    sessao('user');
    renderMenu('/dashboard');
    expect(screen.queryByRole('link', { name: /Insights/ })).toBeNull();
  });
});

describe('atalho no Painel Geral', () => {
  const equipe = (id, nome) => ({ _id: id, nome, membros: [] });
  const renderPainel = () => render(
    <MemoryRouter initialEntries={['/admin/geral']}>
      <Routes>
        <Route path="/admin/geral" element={<DashboardGeral />} />
        <Route path="*" element={<Sonda />} />
      </Routes>
    </MemoryRouter>,
  );

  test('leva a equipe selecionada e nao consulta os Insights no painel', async () => {
    sessao('admin');
    apiClient.get.mockImplementation(async (url) => {
      if (url === API_ENDPOINTS.EQUIPES) return { data: [equipe(oid(12), 'Beta'), equipe(EQUIPE, 'Alfa')] };
      if (url === API_ENDPOINTS.TAREFAS) return { data: [] };
      if (url === API_ENDPOINTS.NOTIFICATIONS_COUNT) return { data: { count: 0 } };
      if (url === API_ENDPOINTS.USER_ME) return { data: { nome: 'Admin Teste' } };
      throw new Error(`URL inesperada: ${url}`);
    });
    renderPainel();
    const principal = await screen.findByRole('main');
    const atalho = await within(principal).findByRole('link', { name: 'Insights inteligentes' });
    expect(atalho).toHaveAttribute('href', '/admin/insights');
    await screen.findByText('Mostrando todas as equipes');
    fireEvent.change(screen.getByLabelText('Equipe'), { target: { value: EQUIPE } });
    expect(within(principal).getByRole('link', { name: 'Insights inteligentes' })).toHaveAttribute('href', `/admin/insights?equipe=${EQUIPE}`);
    expect(pedidosInsights()).toHaveLength(0);
    fireEvent.click(within(principal).getByRole('link', { name: 'Insights inteligentes' }));
    expect(local()).toBe(`/admin/insights?equipe=${EQUIPE}|null`);
  });
});

describe('notificacoes de alerta de equipe', () => {
  const alertaEquipe = (campos = {}, metadata = {}) => ({
    _id: 'n-alerta', tipo: 'system', texto: 'Alerta de comportamento na equipe Alfa', lida: false, origemId: INSIGHT,
    metadata: { kind: 'team_insight_alert', scope: 'user', equipeId: EQUIPE, insightId: INSIGHT, ...metadata },
    createdAt: '2026-11-10T12:00:00.000Z',
    ...campos,
  });

  test('destino: aba Alertas da equipe com a ocorrencia, so para administrador e com ids validos', () => {
    expect(notificationTarget(alertaEquipe(), 'admin')).toEqual({
      to: `/admin/insights?equipe=${EQUIPE}&aba=alertas&ocorrencia=${INSIGHT}`, label: 'Ver alerta',
    });
    // Notificacao antiga sem insightId: usa o origemId (o mesmo registro).
    expect(notificationTarget(alertaEquipe({}, { insightId: undefined }), 'admin').to).toBe(`/admin/insights?equipe=${EQUIPE}&aba=alertas&ocorrencia=${INSIGHT}`);
    expect(notificationTarget(alertaEquipe({ origemId: null }, { insightId: 'x' }), 'admin').to).toBe(`/admin/insights?equipe=${EQUIPE}&aba=alertas`);
    expect(notificationTarget(alertaEquipe(), 'user')).toBeNull();
    expect(notificationTarget(alertaEquipe({}, { equipeId: '../admin' }), 'admin')).toBeNull();
    expect(notificationTarget(alertaEquipe({}, { kind: 'outro' }), 'admin')).toBeNull();
    expect(notificationTarget({ ...alertaEquipe(), tipo: 'team' }, 'admin')).toBeNull();
    expect(notificationTarget({ _id: 'n', tipo: 'system', metadata: {} }, 'admin')).toBeNull();
  });

  test('tarefa e chat mantem os destinos', () => {
    const tarefa = { tipo: 'task', origemId: oid(7), metadata: { tarefaId: oid(7) } };
    expect(notificationTarget(tarefa, 'admin')).toEqual({ to: '/admin/tarefas', state: { abrirTarefaId: oid(7) }, label: 'Ver tarefa' });
    expect(notificationTarget({ tipo: 'chat', metadata: { equipeId: EQUIPE } }, 'admin')).toEqual({ to: '/admin/chats', state: { equipeId: EQUIPE }, label: 'Abrir conversa' });
  });

  test('na central: Ver alerta marca como lida e abre os Insights', async () => {
    sessao('admin');
    apiClient.get.mockResolvedValue({ data: [alertaEquipe()] });
    render(
      <MemoryRouter initialEntries={['/notificacoes']}>
        <Routes>
          <Route path="/notificacoes" element={<NotificationsPage />} />
          <Route path="*" element={<Sonda />} />
        </Routes>
      </MemoryRouter>,
    );
    const cartao = (await screen.findByText('Alerta de comportamento na equipe Alfa')).closest('article');
    await act(async () => {
      fireEvent.click(within(cartao).getByRole('button', { name: 'Ver alerta' }));
    });
    expect(apiClient.put).toHaveBeenCalledWith(API_ENDPOINTS.NOTIFICATIONS_MARK_READ('n-alerta'), {});
    expect(local()).toBe(`/admin/insights?equipe=${EQUIPE}&aba=alertas&ocorrencia=${INSIGHT}|null`);
  });
});
