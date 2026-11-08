import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import TarefasAdmin from './TarefasAdmin';

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

const TAREFA_ID = '507f1f77bcf86cd799439021';
const EQUIPE_ID = '507f1f77bcf86cd799439022';
const USER_ID = '507f1f77bcf86cd799439023';

const DETALHES_PATH = `/api/tarefas/${TAREFA_ID}/detalhes`;
const TAREFA_PATH = `/api/tarefas/${TAREFA_ID}`;
const CREATE_ROUTE = '/admin/criar-tarefa';
const EDIT_ROUTE = `/admin/editar-tarefa/${TAREFA_ID}`;

const DATA_FUTURA = '2099-12-31';

const EQUIPE = { _id: EQUIPE_ID, nome: 'Equipe Alfa' };
const USER = { _id: USER_ID, nome: 'Pessoa Responsavel' };

// Mesmo formato de GET /api/tarefas/:id/detalhes (equipe e user populados).
const TAREFA = {
  _id: TAREFA_ID,
  descricao: 'Preparar apresentacao',
  detalhes: 'Slides da banca',
  dataEntrega: `${DATA_FUTURA}T00:00:00.000Z`,
  tempoEstimado: 90,
  urgencia: 'alta',
  status: 'pendente',
  equipe: EQUIPE,
  user: USER,
  anexos: [],
  subtarefas: [],
};

const pathOf = (url) => new URL(url, 'http://localhost').pathname;

const notFound = () =>
  Object.assign(new Error('Request failed with status code 404'), {
    response: { status: 404, data: { success: false, error: 'Rota não encontrada' } },
  });

const respostaDetalhes = async () => ({
  data: { tarefa: TAREFA, comentarios: [], logs: [] },
});

// Espelha a API real: GET /api/tarefas/:id nao existe e responde 404.
const mockApi = ({ detalhes = respostaDetalhes } = {}) => {
  apiGet.mockImplementation(async (url) => {
    const path = pathOf(url);
    if (path === '/api/equipes') return { data: [EQUIPE] };
    if (path === `/api/equipes/${EQUIPE_ID}/membros`) return { data: [USER] };
    if (path === DETALHES_PATH) return detalhes();
    throw notFound();
  });
  apiPost.mockResolvedValue({ data: TAREFA });
  apiPut.mockResolvedValue({ data: TAREFA });
};

const renderAt = (route) =>
  render(
    <MemoryRouter initialEntries={[route]}>
      <Routes>
        <Route path="/admin/criar-tarefa" element={<TarefasAdmin />} />
        <Route path="/admin/editar-tarefa/:id" element={<TarefasAdmin />} />
        <Route path="/admin/tarefas" element={<div>Lista de tarefas</div>} />
      </Routes>
    </MemoryRouter>,
  );

const getFields = () => {
  const [urgencia, equipe, responsavel] = screen.getAllByRole('combobox');
  return {
    nome: screen.getByPlaceholderText('Nome da tarefa'),
    detalhes: screen.getByPlaceholderText('Descrição detalhada da tarefa'),
    data: document.querySelector('input[type="date"]'),
    tempo: screen.getByPlaceholderText('Tempo estimado (em minutos)'),
    urgencia,
    equipe,
    responsavel,
  };
};

const getRequestedPaths = () => apiGet.mock.calls.map(([url]) => pathOf(url));

const waitForTaskLoaded = () =>
  waitFor(() => {
    expect(getFields().nome).toHaveValue(TAREFA.descricao);
    expect(getFields().responsavel).toHaveValue(USER_ID);
  });

beforeEach(() => {
  apiGet.mockReset();
  apiPost.mockReset();
  apiPut.mockReset();
});

describe('TarefasAdmin: rota de edicao', () => {
  test('carrega a tarefa por GET /api/tarefas/:id/detalhes', async () => {
    mockApi();

    renderAt(EDIT_ROUTE);
    await waitForTaskLoaded();

    expect(getRequestedPaths()).toContain(DETALHES_PATH);
    expect(getRequestedPaths()).not.toContain(TAREFA_PATH);
  });

  test('preenche os campos com os dados da tarefa', async () => {
    mockApi();

    renderAt(EDIT_ROUTE);
    await waitForTaskLoaded();

    const fields = getFields();
    expect(fields.nome).toHaveValue(TAREFA.descricao);
    expect(fields.detalhes).toHaveValue(TAREFA.detalhes);
    expect(fields.data).toHaveValue(DATA_FUTURA);
    expect(fields.tempo).toHaveValue(TAREFA.tempoEstimado);
    expect(fields.urgencia).toHaveValue(TAREFA.urgencia);
    expect(fields.equipe).toHaveValue(EQUIPE_ID);
    expect(fields.responsavel).toHaveValue(USER_ID);
  });

  test('mantem titulo e botao de edicao, nunca o de criacao', async () => {
    mockApi();

    renderAt(EDIT_ROUTE);
    await waitForTaskLoaded();

    expect(screen.getByRole('heading', { name: 'Editar Tarefa' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Salvar Alterações' })).toBeEnabled();
    expect(screen.queryByRole('button', { name: 'Criar Tarefa' })).not.toBeInTheDocument();
  });

  test('ao enviar usa PUT /api/tarefas/:id e nunca POST', async () => {
    mockApi();

    renderAt(EDIT_ROUTE);
    await waitForTaskLoaded();

    fireEvent.change(getFields().nome, { target: { value: 'Apresentacao revisada' } });
    fireEvent.click(screen.getByRole('button', { name: 'Salvar Alterações' }));

    await waitFor(() => expect(apiPut).toHaveBeenCalledTimes(1));
    const [url, body] = apiPut.mock.calls[0];
    expect(pathOf(url)).toBe(TAREFA_PATH);
    expect(body).toEqual({
      descricao: 'Apresentacao revisada',
      detalhes: TAREFA.detalhes,
      dataEntrega: DATA_FUTURA,
      equipe: EQUIPE_ID,
      user: USER_ID,
      tempoEstimado: TAREFA.tempoEstimado,
      urgencia: TAREFA.urgencia,
    });
    expect(apiPost).not.toHaveBeenCalled();
  });

  test('continua em edicao depois de salvar: o segundo envio tambem usa PUT', async () => {
    mockApi();

    renderAt(EDIT_ROUTE);
    await waitForTaskLoaded();

    fireEvent.click(screen.getByRole('button', { name: 'Salvar Alterações' }));
    expect(await screen.findByText('Tarefa atualizada com sucesso!')).toBeInTheDocument();

    expect(getFields().nome).toHaveValue(TAREFA.descricao);
    expect(screen.queryByRole('button', { name: 'Criar Tarefa' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Salvar Alterações' }));

    await waitFor(() => expect(apiPut).toHaveBeenCalledTimes(2));
    expect(pathOf(apiPut.mock.calls[1][0])).toBe(TAREFA_PATH);
    expect(apiPost).not.toHaveBeenCalled();
  });

  test('se o carregamento falhar, mostra erro e nao vira criacao', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockApi({
      detalhes: async () => {
        throw notFound();
      },
    });

    renderAt(EDIT_ROUTE);

    expect(
      await screen.findByText(/Não foi possível carregar a tarefa para edição/),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Salvar Alterações' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Criar Tarefa' })).not.toBeInTheDocument();

    fireEvent.submit(document.querySelector('.form-tarefa'));

    expect(apiPost).not.toHaveBeenCalled();
    expect(apiPut).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });

  test('enquanto carrega, nao permite enviar', async () => {
    mockApi({ detalhes: () => new Promise(() => {}) });

    renderAt(EDIT_ROUTE);
    await waitFor(() => expect(getRequestedPaths()).toContain(DETALHES_PATH));

    expect(screen.getByRole('button', { name: 'Salvar Alterações' })).toBeDisabled();

    fireEvent.submit(document.querySelector('.form-tarefa'));

    expect(apiPost).not.toHaveBeenCalled();
    expect(apiPut).not.toHaveBeenCalled();
  });
});

describe('TarefasAdmin: rota de criacao', () => {
  test('comeca vazio, com botao de criacao e sem buscar tarefa', async () => {
    mockApi();

    renderAt(CREATE_ROUTE);
    await screen.findByRole('option', { name: EQUIPE.nome });

    const fields = getFields();
    expect(fields.nome).toHaveValue('');
    expect(fields.detalhes).toHaveValue('');
    expect(fields.data).toHaveValue('');
    expect(fields.tempo).toHaveValue(null);
    expect(fields.urgencia).toHaveValue('baixa');
    expect(fields.equipe).toHaveValue('');
    expect(fields.responsavel).toHaveValue('');
    expect(fields.responsavel).toBeDisabled();

    expect(screen.getByRole('heading', { name: 'Criar Nova Tarefa' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Criar Tarefa' })).toBeEnabled();
    expect(getRequestedPaths()).toEqual(['/api/equipes']);
  });

  test('ao enviar usa POST /api/tarefas, nunca PUT, e limpa o formulario', async () => {
    mockApi();

    renderAt(CREATE_ROUTE);
    await screen.findByRole('option', { name: EQUIPE.nome });

    const fields = getFields();
    fireEvent.change(fields.nome, { target: { value: 'Nova tarefa' } });
    fireEvent.change(fields.data, { target: { value: DATA_FUTURA } });
    fireEvent.change(fields.equipe, { target: { value: EQUIPE_ID } });
    fireEvent.click(screen.getByRole('button', { name: 'Criar Tarefa' }));

    await waitFor(() => expect(apiPost).toHaveBeenCalledTimes(1));
    const [url, body] = apiPost.mock.calls[0];
    expect(pathOf(url)).toBe('/api/tarefas');
    expect(body).toEqual({
      descricao: 'Nova tarefa',
      detalhes: '',
      dataEntrega: DATA_FUTURA,
      equipe: EQUIPE_ID,
      user: '',
      tempoEstimado: null,
      urgencia: 'baixa',
    });
    expect(apiPut).not.toHaveBeenCalled();

    expect(await screen.findByText('Tarefa criada com sucesso!')).toBeInTheDocument();
    expect(getFields().nome).toHaveValue('');
    expect(screen.getByRole('button', { name: 'Criar Tarefa' })).toBeEnabled();
  });
});
