// Tarefas do admin abertas a partir de outra tela: destaca o cartao so se a tarefa estiver na lista da API.
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { fireEvent } from '@testing-library/react';
import DashboardTarefasAdmin from './DashboardTarefasAdmin';

const { apiGet, apiDelete } = vi.hoisted(() => ({ apiGet: vi.fn(), apiDelete: vi.fn() }));
vi.mock('../../config/apiClient', () => ({ __esModule: true, default: { get: apiGet, delete: apiDelete } }));
vi.mock('../../components/layout/Sidebar', () => ({ __esModule: true, default: () => null }));

const T1 = 'a'.repeat(24);
const T2 = 'b'.repeat(24);
const tarefas = [
  { _id: T1, descricao: 'Revisar relatório', status: 'pendente', urgencia: 'alta', dataEntrega: '2026-11-25T00:00:00.000Z', equipe: { nome: 'Alfa' } },
  { _id: T2, descricao: 'Planilha', status: 'em_andamento', urgencia: 'baixa', dataEntrega: '2026-11-26T00:00:00.000Z', equipe: { nome: 'Beta' } },
];

function Estado() {
  const location = useLocation();
  return <p data-testid="estado">{`${location.pathname}|${JSON.stringify(location.state)}`}</p>;
}

const renderPage = (state) => render(
  <MemoryRouter initialEntries={[{ pathname: '/admin/tarefas', state }]}>
    <Routes>
      <Route path="/admin/tarefas" element={<><DashboardTarefasAdmin /><Estado /></>} />
      <Route path="/admin/editar-tarefa/:id" element={<Estado />} />
    </Routes>
  </MemoryRouter>,
);

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
});

beforeEach(() => {
  apiGet.mockReset();
  apiDelete.mockReset();
  apiGet.mockResolvedValue({ data: tarefas });
});

test('tarefa da lista e destacada, recebe foco e o pedido e consumido', async () => {
  renderPage({ abrirTarefaId: T2 });
  const cartao = (await screen.findByText('Planilha')).closest('.task-item');
  await waitFor(() => expect(cartao).toHaveClass('is-destacada'));
  expect(cartao).toHaveAttribute('aria-current', 'true');
  expect(cartao).toHaveFocus();
  expect(screen.getByText('Revisar relatório').closest('.task-item')).not.toHaveClass('is-destacada');
  await waitFor(() => expect(screen.getByTestId('estado')).toHaveTextContent('/admin/tarefas|null'));
});

test.each([['inexistente', 'c'.repeat(24)], ['malformado', '../x']])('id %s: aviso e nenhum destaque', async (_caso, id) => {
  renderPage({ abrirTarefaId: id });
  expect(await screen.findByRole('status')).toHaveTextContent('A tarefa solicitada não está disponível nesta lista.');
  expect(document.querySelector('.is-destacada')).toBeNull();
});

test('sem pedido a lista continua igual e Editar segue para a rota de edicao', async () => {
  renderPage(undefined);
  await screen.findByText('Planilha');
  expect(screen.queryByRole('status')).toBeNull();
  fireEvent.click(screen.getAllByRole('button', { name: 'Editar' })[0]);
  expect(screen.getByTestId('estado')).toHaveTextContent(`/admin/editar-tarefa/${T1}|null`);
  expect(apiDelete).not.toHaveBeenCalled();
});
