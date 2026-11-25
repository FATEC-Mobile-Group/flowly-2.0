// Equipes -> chat (colaborador e admin) e Painel Geral -> tarefa: links com o pedido no state do React Router.
import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { authUtils } from '../../config/authUtils';
import EquipesUser from './EquipesUser';
import DashboardAdmin from '../admin/DashboardAdmin';
import ListaEntregas from '../dashboard/ListaEntregas';

const { apiGet } = vi.hoisted(() => ({ apiGet: vi.fn() }));
vi.mock('../../config/apiClient', () => ({ __esModule: true, default: { get: apiGet }, getFullApiUrl: (p) => p }));
vi.mock('../../components/layout/Sidebar', () => ({ __esModule: true, default: () => null }));

const ME = 'd'.repeat(24);
const ALFA = 'e'.repeat(24);
const BETA = 'f'.repeat(24);

function Destino() {
  const location = useLocation();
  return <p data-testid="destino">{`${location.pathname}|${JSON.stringify(location.state)}`}</p>;
}

const renderAt = (path, element) => render(
  <MemoryRouter initialEntries={[path]}>
    <Routes>
      <Route path={path} element={element} />
      {['/chats', '/admin/chats', '/admin/tarefas'].map((p) => <Route key={p} path={p} element={<Destino />} />)}
    </Routes>
  </MemoryRouter>,
);

beforeEach(() => {
  apiGet.mockReset();
  vi.spyOn(authUtils, 'getUserId').mockReturnValue(ME);
});

afterEach(() => vi.restoreAllMocks());

test('Minhas Equipes: cada equipe abre o proprio chat', async () => {
  apiGet.mockResolvedValue({ data: [{ _id: ALFA, nome: 'Projeto Integrador', membros: [{ _id: ME, nome: 'Eu' }] }] });
  renderAt('/equipes', <EquipesUser />);
  fireEvent.click(await screen.findByRole('link', { name: 'Abrir chat da equipe Projeto Integrador' }));
  expect(screen.getByTestId('destino')).toHaveTextContent(`/chats|{"equipeId":"${ALFA}"}`);
});

test('Equipes do admin: Abrir chat so nas equipes em que ele participa (as unicas no chat dele)', async () => {
  apiGet.mockResolvedValue({ data: [
    { _id: ALFA, nome: 'Alfa', membros: [{ _id: ME, nome: 'Eu' }] },
    { _id: BETA, nome: 'Beta', membros: [{ _id: 'c'.repeat(24), nome: 'Outra pessoa' }] },
  ] });
  renderAt('/admin', <DashboardAdmin />);
  expect(await screen.findByRole('link', { name: 'Abrir chat da equipe Alfa' })).toBeInTheDocument();
  expect(screen.queryByRole('link', { name: 'Abrir chat da equipe Beta' })).toBeNull();
  fireEvent.click(screen.getByRole('link', { name: 'Abrir chat da equipe Alfa' }));
  expect(screen.getByTestId('destino')).toHaveTextContent(`/admin/chats|{"equipeId":"${ALFA}"}`);
});

test('Painel Geral: Ver detalhes so para itens com id confiavel', () => {
  const itens = [
    { id: 'a'.repeat(24), abrivel: true, descricao: 'Revisar', equipe: 'Alfa', dia: '2026-11-20', data: '20/11/2026', prazo: 'Venceu há 3 dias', atrasada: true, venceHoje: false },
    { id: 'sem-id-1', abrivel: false, descricao: 'Sem id', equipe: 'Beta', dia: '2026-11-25', data: '25/11/2026', prazo: 'Vence hoje', atrasada: false, venceHoje: true },
  ];
  renderAt('/admin/geral', (
    <ListaEntregas
      titulo="Entregas atrasadas"
      subtitulo="Não concluídas"
      tipo="atrasadas"
      itens={itens}
      total={2}
      equipeId=""
      destino={{ prazo: 'atrasadas' }}
      vazio="Nenhuma"
      rotuloTotal="Ver todas"
    />
  ));
  const lista = screen.getByRole('list');
  expect(within(lista).getAllByRole('link')).toHaveLength(1);
  fireEvent.click(screen.getByRole('link', { name: 'Ver detalhes de Revisar' }));
  expect(screen.getByTestId('destino')).toHaveTextContent(`/admin/tarefas|{"abrirTarefaId":"${'a'.repeat(24)}"}`);
});
