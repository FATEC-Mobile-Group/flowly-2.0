import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import TarefasAdmin from './TarefasAdmin';

// D31: a data de entrega e uma data civil (YYYY-MM-DD). Em America/Sao_Paulo, new Date('YYYY-MM-DD')
// vira 21:00 do dia anterior, e "hoje" era rejeitado. Na edicao, data atrasada sem mudanca deve salvar.
process.env.TZ = 'America/Sao_Paulo';

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

const TAREFA_ID = '507f1f77bcf86cd799439041';
const EQUIPE = { _id: '507f1f77bcf86cd799439042', nome: 'Equipe Alfa' };
const ANA = { _id: 'u1', nome: 'Ana', tipo: 'user' };
const ERRO_DATA = 'A data de entrega não pode ser anterior à data de hoje.';

const ONTEM = '2026-11-08';
const HOJE = '2026-11-09';
const AMANHA = '2026-11-10';
const ATRASADA = '2026-11-01';
const OUTRA_PASSADA = '2026-11-05';
const FUTURA = '2026-12-15';

const pathOf = (url) => new URL(url, 'http://localhost').pathname;

// Relogio local de Sao Paulo; 22:30 local ja e o dia 10 em UTC.
const fixarRelogio = (hora, minuto = 0) => vi.setSystemTime(new Date(2026, 10, 9, hora, minuto));

const mockApi = ({ dataEntrega = FUTURA } = {}) => {
  apiGet.mockImplementation(async (url) => {
    const path = pathOf(url);
    if (path === '/api/equipes') return { data: [EQUIPE] };
    if (path === `/api/equipes/${EQUIPE._id}/membros`) return { data: [ANA] };
    if (path === `/api/tarefas/${TAREFA_ID}/detalhes`) {
      return {
        data: {
          tarefa: {
            _id: TAREFA_ID,
            descricao: 'Tarefa existente',
            detalhes: 'Detalhes',
            dataEntrega: `${dataEntrega}T00:00:00.000Z`,
            urgencia: 'media',
            tempoEstimado: 30,
            equipe: EQUIPE,
            user: { _id: ANA._id, nome: ANA.nome },
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

const campoData = () => document.querySelector('input[type="date"]');
const campoNome = () => screen.getByPlaceholderText('Nome da tarefa');

const criarCom = async (data) => {
  renderAt('/admin/criar-tarefa');
  await screen.findByRole('option', { name: EQUIPE.nome });
  fireEvent.change(campoNome(), { target: { value: 'Nova tarefa' } });
  fireEvent.change(campoData(), { target: { value: data } });
  fireEvent.change(screen.getAllByRole('combobox')[1], { target: { value: EQUIPE._id } });
  fireEvent.click(screen.getByRole('button', { name: 'Criar Tarefa' }));
};

const abrirEdicao = async (dataEntrega) => {
  mockApi({ dataEntrega });
  renderAt(`/admin/editar-tarefa/${TAREFA_ID}`);
  await waitFor(() => expect(campoNome()).toHaveValue('Tarefa existente'));
};

const salvar = () => fireEvent.click(screen.getByRole('button', { name: 'Salvar Alterações' }));

const esperarSemEnvio = async () => {
  expect(await screen.findByText(ERRO_DATA)).toBeInTheDocument();
  expect(apiPost).not.toHaveBeenCalled();
  expect(apiPut).not.toHaveBeenCalled();
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  fixarRelogio(10);
  apiGet.mockReset();
  apiPost.mockReset();
  apiPut.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

test('o teste roda em America/Sao_Paulo (UTC-3), nao em UTC', () => {
  expect(new Date(2026, 10, 9).getTimezoneOffset()).toBe(180);
  expect(new Date(HOJE).getDate()).toBe(8);
});

describe('D31 timezone - criacao em 09/11 no fuso de Sao Paulo', () => {
  test.each([
    ['10:00 local', 10, 0],
    ['22:30 local (ja dia 10 em UTC)', 22, 30],
  ])('%s: ontem nao faz POST', async (_label, hora, minuto) => {
    fixarRelogio(hora, minuto);
    mockApi();
    await criarCom(ONTEM);
    await esperarSemEnvio();
  });

  test.each([
    ['hoje', HOJE, 10, 0],
    ['hoje', HOJE, 22, 30],
    ['amanha', AMANHA, 10, 0],
    ['amanha', AMANHA, 22, 30],
  ])('%s (%s) as %i:%i faz POST com a data civil', async (_label, data, hora, minuto) => {
    fixarRelogio(hora, minuto);
    mockApi();
    await criarCom(data);

    await waitFor(() => expect(apiPost).toHaveBeenCalledTimes(1));
    expect(apiPost.mock.calls[0][1]).toHaveProperty('dataEntrega', data);
    expect(screen.queryByText(ERRO_DATA)).not.toBeInTheDocument();
    expect(apiPut).not.toHaveBeenCalled();
  });
});

describe('D31 edicao - tarefa atrasada', () => {
  test('tarefa futura sem mudar a data: PUT', async () => {
    await abrirEdicao(FUTURA);
    fireEvent.change(campoNome(), { target: { value: 'Outro nome' } });
    salvar();

    await waitFor(() => expect(apiPut).toHaveBeenCalledTimes(1));
    expect(apiPut.mock.calls[0][1]).toMatchObject({ descricao: 'Outro nome', dataEntrega: FUTURA });
    expect(apiPost).not.toHaveBeenCalled();
  });

  test('carrega a data atrasada no campo sem alterar', async () => {
    await abrirEdicao(ATRASADA);
    expect(campoData()).toHaveValue(ATRASADA);
  });

  test.each([
    ['descricao', () => fireEvent.change(campoNome(), { target: { value: 'Nome novo' } }), { descricao: 'Nome novo' }],
    ['urgencia', () => fireEvent.change(screen.getAllByRole('combobox')[0], { target: { value: 'alta' } }), { urgencia: 'alta' }],
    ['tempo estimado', () => fireEvent.change(screen.getByPlaceholderText('Tempo estimado (em minutos)'), { target: { value: '45' } }), { tempoEstimado: 45 }],
  ])('atrasada, mudando so %s: PUT com a data antiga', async (_label, alterar, esperado) => {
    await abrirEdicao(ATRASADA);
    alterar();
    salvar();

    await waitFor(() => expect(apiPut).toHaveBeenCalledTimes(1));
    expect(apiPut.mock.calls[0][1]).toMatchObject({ ...esperado, dataEntrega: ATRASADA });
    expect(screen.queryByText(ERRO_DATA)).not.toBeInTheDocument();
    expect(apiPost).not.toHaveBeenCalled();
  });

  test('atrasada mudando para outra data passada: nao faz PUT nem POST', async () => {
    await abrirEdicao(ATRASADA);
    fireEvent.change(campoData(), { target: { value: OUTRA_PASSADA } });
    salvar();
    await esperarSemEnvio();
  });

  test('futura mudando para ontem: nao faz PUT nem POST', async () => {
    await abrirEdicao(FUTURA);
    fireEvent.change(campoData(), { target: { value: ONTEM } });
    salvar();
    await esperarSemEnvio();
  });

  test.each([
    ['hoje', HOJE, 10, 0],
    ['hoje', HOJE, 22, 30],
    ['futura', AMANHA, 10, 0],
  ])('atrasada mudando para %s (%s, %i:%i): PUT', async (_label, data, hora, minuto) => {
    fixarRelogio(hora, minuto);
    await abrirEdicao(ATRASADA);
    fireEvent.change(campoData(), { target: { value: data } });
    salvar();

    await waitFor(() => expect(apiPut).toHaveBeenCalledTimes(1));
    expect(apiPut.mock.calls[0][1]).toHaveProperty('dataEntrega', data);
    expect(apiPost).not.toHaveBeenCalled();
  });

  test('atrasada: muda para outra passada e volta para a original: PUT', async () => {
    await abrirEdicao(ATRASADA);
    fireEvent.change(campoData(), { target: { value: OUTRA_PASSADA } });
    fireEvent.change(campoData(), { target: { value: ATRASADA } });
    salvar();

    await waitFor(() => expect(apiPut).toHaveBeenCalledTimes(1));
    expect(apiPut.mock.calls[0][1]).toHaveProperty('dataEntrega', ATRASADA);
  });
});
