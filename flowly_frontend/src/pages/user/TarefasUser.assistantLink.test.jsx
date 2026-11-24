// "Ver tarefa" do assistente: Minhas tarefas abre o detalhe so de uma tarefa da propria lista (vinda da API).
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { API_ENDPOINTS } from '../../config/config';
import TarefasUser from './TarefasUser';

const { apiGet } = vi.hoisted(() => ({ apiGet: vi.fn() }));

vi.mock('../../config/apiClient', () => ({ __esModule: true, default: { get: apiGet, put: vi.fn() } }));
vi.mock('../../components/layout/Sidebar', () => ({ __esModule: true, default: () => null }));
vi.mock('../../components/tarefas/TarefaModal', () => ({
  __esModule: true,
  default: ({ tarefaId }) => <div role="dialog" aria-label="Detalhe da tarefa">{tarefaId}</div>,
}));

const EQUIPE = { _id: 'e'.repeat(24), nome: 'Equipe Alfa' };
const MINHA = { _id: 'a'.repeat(24), descricao: 'Revisar relatório', status: 'pendente', equipe: EQUIPE };

function StateProbe() {
  const location = useLocation();
  return <p data-testid="estado">{JSON.stringify(location.state)}</p>;
}

const renderWithState = (state) => render(
  <MemoryRouter initialEntries={[{ pathname: '/minhas-tarefas', state }]}>
    <Routes>
      <Route path="/minhas-tarefas" element={<><TarefasUser /><StateProbe /></>} />
    </Routes>
  </MemoryRouter>,
);

beforeEach(() => {
  apiGet.mockReset();
  apiGet.mockImplementation(async (url) => {
    if (url === API_ENDPOINTS.TAREFAS_MINHAS) return { data: [MINHA] };
    if (url === API_ENDPOINTS.MINHAS_EQUIPES) return { data: [EQUIPE] };
    throw new Error(`rota inesperada ${url}`);
  });
});

test('abre o detalhe da tarefa pedida quando ela esta na lista do usuario e consome o pedido', async () => {
  renderWithState({ abrirTarefaId: MINHA._id });
  expect(await screen.findByRole('dialog', { name: 'Detalhe da tarefa' })).toHaveTextContent(MINHA._id);
  await waitFor(() => expect(screen.getByTestId('estado')).toHaveTextContent('null'));
});

test('id que nao esta na lista do usuario nao abre nada', async () => {
  renderWithState({ abrirTarefaId: 'b'.repeat(24) });
  await waitFor(() => expect(apiGet).toHaveBeenCalledWith(API_ENDPOINTS.TAREFAS_MINHAS));
  expect(await screen.findByText('Revisar relatório')).toBeInTheDocument();
  expect(screen.queryByRole('dialog', { name: 'Detalhe da tarefa' })).toBeNull();
});

test('sem pedido do assistente a tela continua igual', async () => {
  renderWithState(undefined);
  expect(await screen.findByText('Revisar relatório')).toBeInTheDocument();
  expect(screen.queryByRole('dialog', { name: 'Detalhe da tarefa' })).toBeNull();
});

test('id fora da lista ou malformado: aviso, nada abre e o pedido e consumido', async () => {
  for (const id of ['b'.repeat(24), '../admin']) {
    const { unmount } = renderWithState({ abrirTarefaId: id });
    expect(await screen.findByText('Atenção: a tarefa solicitada não está disponível na sua lista.')).toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: 'Detalhe da tarefa' })).toBeNull();
    await waitFor(() => expect(screen.getByTestId('estado')).toHaveTextContent('null'));
    unmount();
  }
});

test('abertura manual do detalhe continua funcionando', async () => {
  renderWithState(undefined);
  fireEvent.click(await screen.findByText('Revisar relatório'));
  expect(await screen.findByRole('dialog', { name: 'Detalhe da tarefa' })).toHaveTextContent(MINHA._id);
});
