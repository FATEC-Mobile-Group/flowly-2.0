// Descricao opcional no formulario de equipe (PR #65): criacao, edicao e equipes antigas sem o campo.
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import Equipes from './Equipes';
import { LIMITE_DESCRICAO_EQUIPE, montarDadosEquipe } from './equipeFormUtils';
import { API_ENDPOINTS } from '../../config/config';

const { apiGet, apiPut, apiPost } = vi.hoisted(() => ({ apiGet: vi.fn(), apiPut: vi.fn(), apiPost: vi.fn() }));
vi.mock('../../config/apiClient', () => ({
  __esModule: true,
  default: { get: apiGet, put: apiPut, post: apiPost, delete: vi.fn() },
  getFullApiUrl: (caminho) => caminho,
}));
vi.mock('../../components/layout/Sidebar', () => ({ __esModule: true, default: () => null }));

const EQ = 'e'.repeat(24);
const ADM = { _id: 'a'.repeat(24), nome: 'Admin', email: 'admin@exemplo.com' };
let equipe;

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('id', ADM._id);
  equipe = { _id: EQ, nome: 'Suporte', membros: [ADM] };
  apiGet.mockReset();
  apiPut.mockReset().mockResolvedValue({ data: {} });
  apiPost.mockReset().mockResolvedValue({ data: {} });
  apiGet.mockImplementation(async (url) => {
    if (url === API_ENDPOINTS.EQUIPES) return { data: [] };
    if (url === API_ENDPOINTS.EQUIPES_BY_ID(EQ)) return { data: equipe };
    throw new Error(`URL inesperada: ${url}`);
  });
});

const renderPage = (entrada) => render(
  <MemoryRouter initialEntries={[entrada]}>
    <Routes>
      <Route path="/admin/equipe/:id" element={<Equipes />} />
      <Route path="/admin/criar-equipe" element={<Equipes />} />
    </Routes>
  </MemoryRouter>,
);

describe('montarDadosEquipe', () => {
  test('criacao: descricao so com texto', () => {
    expect(montarDadosEquipe({ nome: 'A', membrosIds: ['1', '1'], descricao: '  ', editando: false })).toEqual({ nome: 'A', membros: ['1'] });
    expect(montarDadosEquipe({ nome: 'A', membrosIds: [], descricao: ' Dados ', editando: false })).toEqual({ nome: 'A', membros: [], descricao: 'Dados' });
  });

  test('edicao: so envia quando mudou (inclusive para remover)', () => {
    const base = { nome: 'A', membrosIds: [], editando: true };
    expect(montarDadosEquipe({ ...base, descricao: '', descricaoOriginal: '' })).not.toHaveProperty('descricao');
    expect(montarDadosEquipe({ ...base, descricao: 'Igual ', descricaoOriginal: 'Igual' })).not.toHaveProperty('descricao');
    expect(montarDadosEquipe({ ...base, descricao: 'Nova', descricaoOriginal: 'Antiga' }).descricao).toBe('Nova');
    expect(montarDadosEquipe({ ...base, descricao: '', descricaoOriginal: 'Antiga' }).descricao).toBe('');
  });
});

describe('formulario', () => {
  test('equipe antiga sem descricao: salvar sem mexer nao envia o campo', async () => {
    renderPage(`/admin/equipe/${EQ}`);
    await waitFor(() => expect(screen.getByLabelText('Nome da equipe')).toHaveValue('Suporte'));
    expect(screen.getByLabelText('Descrição (opcional)')).toHaveValue('');
    fireEvent.click(screen.getByRole('button', { name: 'Salvar Alterações' }));
    await waitFor(() => expect(apiPut).toHaveBeenCalledTimes(1));
    expect(apiPut.mock.calls[0][1]).toEqual({ nome: 'Suporte', membros: [ADM._id] });
  });

  test('edicao carrega a descricao atual, limita o tamanho e envia a nova', async () => {
    equipe.descricao = 'Atendimento';
    renderPage(`/admin/equipe/${EQ}`);
    const campo = await screen.findByDisplayValue('Atendimento');
    expect(campo).toHaveAttribute('maxLength', String(LIMITE_DESCRICAO_EQUIPE));
    expect(screen.getByText(`11/${LIMITE_DESCRICAO_EQUIPE} caracteres`)).toBeInTheDocument();
    fireEvent.change(campo, { target: { value: 'Atendimento ao cliente' } });
    fireEvent.click(screen.getByRole('button', { name: 'Salvar Alterações' }));
    await waitFor(() => expect(apiPut).toHaveBeenCalledTimes(1));
    expect(apiPut.mock.calls[0][1]).toEqual({ nome: 'Suporte', membros: [ADM._id], descricao: 'Atendimento ao cliente' });
  });

  test('criacao com descricao', async () => {
    renderPage('/admin/criar-equipe');
    fireEvent.change(screen.getByLabelText('Nome da equipe'), { target: { value: 'Dados' } });
    fireEvent.change(screen.getByLabelText('Descrição (opcional)'), { target: { value: 'Relatórios e painéis' } });
    fireEvent.click(screen.getByRole('button', { name: 'Criar Equipe' }));
    await waitFor(() => expect(apiPost).toHaveBeenCalledTimes(1));
    expect(apiPost.mock.calls[0][1]).toEqual({ nome: 'Dados', membros: [], descricao: 'Relatórios e painéis' });
  });
});
