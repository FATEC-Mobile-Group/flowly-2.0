import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import TarefasAdmin from './TarefasAdmin';

// D10: a API so aceita conta tipo 'user' como responsavel; a tela nao pode oferecer administradores.

const { apiGet, apiPost, apiPut } = vi.hoisted(() => ({
  apiGet: vi.fn(),
  apiPost: vi.fn(),
  apiPut: vi.fn(),
}));

vi.mock('../../config/apiClient', () => ({
  __esModule: true,
  default: { get: apiGet, post: apiPost, put: apiPut },
  getFullApiUrl: (path) => path,
}));

vi.mock('../../components/layout/Sidebar', () => ({
  __esModule: true,
  default: () => null,
}));

const TAREFA_ID = '507f1f77bcf86cd799439031';
const EQUIPE = { _id: '507f1f77bcf86cd799439032', nome: 'Equipe Alfa' };
const ANA = { _id: 'u1', nome: 'Ana', tipo: 'user' };
const ADMIN = { _id: 'a1', nome: 'Admin', tipo: 'admin' };
const DATA_FUTURA = '2099-12-31';

const pathOf = (url) => new URL(url, 'http://localhost').pathname;

const mockApi = ({ membros = [ANA, ADMIN], responsavel = ANA } = {}) => {
  apiGet.mockImplementation(async (url) => {
    const path = pathOf(url);
    if (path === '/api/equipes') return { data: [EQUIPE] };
    if (path === `/api/equipes/${EQUIPE._id}/membros`) return { data: membros };
    if (path === `/api/tarefas/${TAREFA_ID}/detalhes`) {
      return {
        data: {
          tarefa: {
            _id: TAREFA_ID,
            descricao: 'Tarefa existente',
            detalhes: '',
            dataEntrega: `${DATA_FUTURA}T00:00:00.000Z`,
            urgencia: 'baixa',
            equipe: EQUIPE,
            user: responsavel && { _id: responsavel._id, nome: responsavel.nome },
          },
          comentarios: [],
          logs: [],
        },
      };
    }
    throw new Error(`rota inesperada ${path}`);
  });
  apiPost.mockResolvedValue({ data: {} });
  apiPut.mockResolvedValue({ data: {} });
};

const renderAt = (route) =>
  render(
    <MemoryRouter initialEntries={[route]}>
      <Routes>
        <Route path="/admin/criar-tarefa" element={<TarefasAdmin />} />
        <Route path="/admin/editar-tarefa/:id" element={<TarefasAdmin />} />
      </Routes>
    </MemoryRouter>,
  );

const responsavelSelect = () => screen.getAllByRole('combobox')[2];
const opcoes = () =>
  within(responsavelSelect())
    .getAllByRole('option')
    .map((option) => ({ nome: option.textContent, disabled: option.disabled }));
const opcoesHabilitadas = () => opcoes().filter((opcao) => !opcao.disabled).map((opcao) => opcao.nome);

const abrirCriacaoComEquipe = async () => {
  renderAt('/admin/criar-tarefa');
  await screen.findByRole('option', { name: EQUIPE.nome });
  fireEvent.change(screen.getAllByRole('combobox')[1], { target: { value: EQUIPE._id } });
  await within(responsavelSelect()).findByRole('option', { name: ANA.nome });
};

const abrirEdicao = async () => {
  renderAt(`/admin/editar-tarefa/${TAREFA_ID}`);
  await within(responsavelSelect()).findByRole('option', { name: ANA.nome });
};

beforeEach(() => {
  apiGet.mockReset();
  apiPost.mockReset();
  apiPut.mockReset();
});

describe('D10 - seletor de responsavel', () => {
  test('criacao: mostra Ana e nao mostra Admin, mantendo o backlog', async () => {
    mockApi();
    await abrirCriacaoComEquipe();

    expect(opcoes()).toEqual([
      { nome: 'Sem responsável (Backlog)', disabled: false },
      { nome: 'Ana', disabled: false },
    ]);
    expect(within(responsavelSelect()).queryByRole('option', { name: 'Admin' })).not.toBeInTheDocument();
  });

  test('edicao: mostra Ana e nao oferece Admin', async () => {
    mockApi();
    await abrirEdicao();

    await waitFor(() => expect(responsavelSelect()).toHaveValue(ANA._id));
    expect(opcoesHabilitadas()).toEqual(['Sem responsável (Backlog)', 'Ana']);
    expect(within(responsavelSelect()).queryByRole('option', { name: /Admin/ })).not.toBeInTheDocument();
  });

  test('membro sem tipo (API antiga) continua aparecendo', async () => {
    mockApi({ membros: [{ _id: 'u2', nome: 'Bruno' }, ADMIN] });
    renderAt('/admin/criar-tarefa');
    await screen.findByRole('option', { name: EQUIPE.nome });
    fireEvent.change(screen.getAllByRole('combobox')[1], { target: { value: EQUIPE._id } });

    expect(await within(responsavelSelect()).findByRole('option', { name: 'Bruno' })).toBeInTheDocument();
    expect(opcoesHabilitadas()).toEqual(['Sem responsável (Backlog)', 'Bruno']);
  });

  test('criacao sem responsavel continua enviando backlog', async () => {
    mockApi();
    await abrirCriacaoComEquipe();
    fireEvent.change(screen.getByPlaceholderText('Nome da tarefa'), { target: { value: 'Nova' } });
    fireEvent.change(document.querySelector('input[type="date"]'), { target: { value: DATA_FUTURA } });
    fireEvent.click(screen.getByRole('button', { name: 'Criar Tarefa' }));

    await waitFor(() => expect(apiPost).toHaveBeenCalledTimes(1));
    expect(apiPost.mock.calls[0][1]).toHaveProperty('user', '');
  });

  test('tarefa legada com admin: valor atual aparece desabilitado e nao pode ser escolhido de novo', async () => {
    mockApi({ responsavel: ADMIN });
    await abrirEdicao();

    await waitFor(() => expect(responsavelSelect()).toHaveValue(ADMIN._id));
    expect(opcoes()).toEqual([
      { nome: 'Sem responsável (Backlog)', disabled: false },
      { nome: 'Ana', disabled: false },
      { nome: 'Admin', disabled: true },
    ]);

    fireEvent.change(responsavelSelect(), { target: { value: ANA._id } });
    expect(responsavelSelect()).toHaveValue(ANA._id);
    expect(opcoesHabilitadas()).not.toContain('Admin');
  });

  test('erro da API ao salvar aparece na tela', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockApi({ responsavel: ADMIN });
    apiPut.mockRejectedValue(Object.assign(new Error('400'), { response: { status: 400, data: { erro: 'User inválido' } } }));
    await abrirEdicao();
    await waitFor(() => expect(responsavelSelect()).toHaveValue(ADMIN._id));

    fireEvent.click(screen.getByRole('button', { name: 'Salvar Alterações' }));

    expect(await screen.findByText('User inválido')).toBeInTheDocument();
    expect(screen.queryByText('Tarefa atualizada com sucesso!')).not.toBeInTheDocument();
    consoleError.mockRestore();
  });

  test('erro da API ao criar aparece na tela', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockApi();
    apiPost.mockRejectedValue(Object.assign(new Error('400'), { response: { status: 400, data: { erro: 'Usuário não pertence à equipe selecionada' } } }));
    await abrirCriacaoComEquipe();
    fireEvent.change(screen.getByPlaceholderText('Nome da tarefa'), { target: { value: 'Nova' } });
    fireEvent.change(document.querySelector('input[type="date"]'), { target: { value: DATA_FUTURA } });
    fireEvent.click(screen.getByRole('button', { name: 'Criar Tarefa' }));

    expect(await screen.findByText('Usuário não pertence à equipe selecionada')).toBeInTheDocument();
    expect(screen.queryByText('Tarefa criada com sucesso!')).not.toBeInTheDocument();
    consoleError.mockRestore();
  });
});
