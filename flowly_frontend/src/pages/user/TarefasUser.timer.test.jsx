// Kanban: transicao confirmada do cronometro (ou do status) avisa o FloatingTimer pelo evento existente; falha nao avisa.
import { act, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { API_ENDPOINTS } from '../../config/config';
import TarefasUser from './TarefasUser';

const { apiGet, apiPut } = vi.hoisted(() => ({ apiGet: vi.fn(), apiPut: vi.fn() }));
vi.mock('../../config/apiClient', () => ({ __esModule: true, default: { get: apiGet, put: apiPut } }));
vi.mock('../../components/layout/Sidebar', () => ({ __esModule: true, default: () => null }));
vi.mock('../../components/tarefas/TarefaModal', () => ({ __esModule: true, default: () => null }));

const EQUIPE = { _id: 'e'.repeat(24), nome: 'Equipe Alfa' };
const ATIVA = {
  _id: 'a'.repeat(24), descricao: 'Desenvolvimento do Figma', status: 'em_andamento', equipe: EQUIPE,
  cronometroAtivo: true, tempoGasto: 8, tempoGastoSegundos: 503, ultimaAtualizacaoCronometro: '2026-11-25T15:00:00.000Z',
};
let eventos;
const contar = () => { eventos += 1; };

beforeEach(() => {
  eventos = 0;
  window.addEventListener('flowly:cronometro-atualizado', contar);
  apiGet.mockReset();
  apiPut.mockReset();
  apiGet.mockImplementation(async (url) => {
    if (url === API_ENDPOINTS.TAREFAS_MINHAS) return { data: [ATIVA] };
    if (url === API_ENDPOINTS.MINHAS_EQUIPES) return { data: [EQUIPE] };
    throw new Error(`rota inesperada ${url}`);
  });
});

afterEach(() => window.removeEventListener('flowly:cronometro-atualizado', contar));

const renderKanban = async () => {
  render(<MemoryRouter><TarefasUser /></MemoryRouter>);
  await screen.findByText('Desenvolvimento do Figma');
};

test('pausa confirmada no Kanban avisa o FloatingTimer uma vez', async () => {
  apiPut.mockResolvedValueOnce({ data: { tarefa: { ...ATIVA, cronometroAtivo: false, tempoGastoSegundos: 520 } } });
  await renderKanban();
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Pause Timer' }));
  });
  expect(apiPut).toHaveBeenCalledWith(`${API_ENDPOINTS.UPDATE_TAREFA(ATIVA._id)}/cronometro`, { acao: 'pausar' });
  expect(eventos).toBe(1);
});

test('falha no Kanban nao avisa nem mostra sucesso', async () => {
  apiPut.mockRejectedValueOnce(new Error('500'));
  await renderKanban();
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Pause Timer' }));
  });
  expect(eventos).toBe(0);
  expect(screen.getByText('Erro ao pausar cronômetro')).toBeInTheDocument();
});
