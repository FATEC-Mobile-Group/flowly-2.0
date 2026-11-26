// Equipes do admin: pesquisa, ordenacao, filtro de criacao, estados, "Ver tarefas" e acoes preservadas.
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import DashboardAdmin from './DashboardAdmin';
import { API_ENDPOINTS } from '../../config/config';

const { apiGet, apiDelete } = vi.hoisted(() => ({ apiGet: vi.fn(), apiDelete: vi.fn() }));
vi.mock('../../config/apiClient', () => ({
  __esModule: true,
  default: { get: apiGet, delete: apiDelete },
  getFullApiUrl: (caminho) => caminho,
}));
vi.mock('../../components/layout/Sidebar', () => ({ __esModule: true, default: () => null }));

const oid = (n) => n.toString(16).padStart(24, '0');
const AGORA = new Date('2026-11-25T15:00:00.000Z');
const ADM = oid(1);
const OUTRO = oid(2);
const ANA = { _id: oid(11), nome: 'Ana Souza', email: 'ana@exemplo.com' };
const JOAO = { _id: oid(12), nome: 'João Ávila', email: 'joao@exemplo.com' };
const BRUNO = { _id: oid(13), nome: 'Bruno Lima', email: 'bruno@exemplo.com' };
const EQ_DEV = oid(101);
const EQ_QA = oid(102);
const EQ_ANTIGA = oid(103);
const EQ_SEM_DATA = oid(104);

const equipesPadrao = () => [
  { _id: EQ_ANTIGA, nome: 'Arquivo Antigo', createdAt: '2026-05-20T12:00:00.000Z', createdBy: OUTRO, membros: [{ _id: OUTRO, nome: 'Maria Gestora', email: 'maria@exemplo.com' }, ANA] },
  { _id: EQ_SEM_DATA, nome: 'Sem Data', createdBy: null, membros: [] },
  { _id: EQ_DEV, nome: 'Desenvolvimento', createdAt: '2026-11-24T12:00:00.000Z', createdBy: ADM, membros: [{ _id: ADM, nome: 'Admin Teste', email: 'admin@exemplo.com' }, ANA, JOAO] },
  { _id: EQ_QA, nome: 'Qualidade e Validação', createdAt: '2026-11-10T12:00:00.000Z', createdBy: ADM, membros: [{ _id: ADM, nome: 'Admin Teste', email: 'admin@exemplo.com' }, BRUNO] },
];

// GET /tarefas?resumo=1: Desenvolvimento com 2 tarefas, Qualidade com 1; Arquivo Antigo e Sem Data sem tarefas.
const tarefasPadrao = () => [
  { _id: 't1', equipe: { _id: EQ_DEV, nome: 'Desenvolvimento' }, status: 'pendente' },
  { _id: 't2', equipe: { _id: EQ_DEV, nome: 'Desenvolvimento' }, status: 'concluido' },
  { _id: 't3', equipe: EQ_QA, status: 'em_andamento' },
];

let respostas;
const responder = async (valor) => {
  const resultado = typeof valor === 'function' ? await valor() : valor;
  if (resultado instanceof Error) throw resultado;
  return { data: resultado };
};

function Sonda() {
  const location = useLocation();
  return <p data-testid="estado">{`${location.pathname}${location.search}|${JSON.stringify(location.state ?? null)}`}</p>;
}

const renderPage = (entrada = '/admin') => render(
  <MemoryRouter initialEntries={[entrada]}>
    <Routes>
      <Route path="/admin" element={<><DashboardAdmin /><Sonda /></>} />
      <Route path="*" element={<Sonda />} />
    </Routes>
  </MemoryRouter>,
);

const esperarPronto = () => screen.findByText(/^Exibindo \d+ de/);
const nomes = () => [...document.querySelectorAll('.team-item h3')].map((el) => el.textContent);
const cartao = (nome) => screen.getByRole('article', { name: `Equipe ${nome}` });
const estado = () => screen.getByTestId('estado').textContent;
const chamadas = () => apiGet.mock.calls.map(([url]) => url);
const escolher = (rotulo, valor) => fireEvent.change(screen.getByLabelText(rotulo), { target: { value: valor } });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(AGORA);
  localStorage.clear();
  localStorage.setItem('id', ADM);
  respostas = { equipes: equipesPadrao(), tarefas: tarefasPadrao() };
  apiGet.mockReset();
  apiDelete.mockReset();
  apiGet.mockImplementation(async (url) => {
    if (url === API_ENDPOINTS.EQUIPES) return responder(respostas.equipes);
    if (url === API_ENDPOINTS.TAREFAS) return responder(respostas.tarefas);
    throw new Error(`URL inesperada: ${url}`);
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('cards e estados', () => {
  test('mais recentes primeiro, data de criacao, criador e participantes', async () => {
    renderPage();
    await esperarPronto();
    expect(screen.getByText('Exibindo 4 de 4 equipes')).toBeInTheDocument();
    expect(nomes()).toEqual(['Desenvolvimento', 'Qualidade e Validação', 'Arquivo Antigo', 'Sem Data']);
    const dev = cartao('Desenvolvimento');
    expect(dev).toHaveTextContent('Criada em 24/11/2026');
    expect(dev).toHaveTextContent('Criada por você');
    expect(dev).toHaveTextContent('3 participantes');
    expect(within(dev).getByText('joao@exemplo.com')).toBeInTheDocument();
    expect(cartao('Arquivo Antigo')).toHaveTextContent('Criada por Maria Gestora');
    const semData = cartao('Sem Data');
    expect(semData).toHaveTextContent('Data de criação indisponível');
    expect(semData).not.toHaveTextContent('Criada por');
    expect(semData).toHaveTextContent('0 participantes');
    expect(semData).toHaveTextContent('Sem participantes nesta equipe.');
    expect(chamadas()).toEqual([API_ENDPOINTS.EQUIPES, API_ENDPOINTS.TAREFAS]);
  });

  test('erro de carregamento nao aparece como "nenhuma equipe"; tentar novamente recarrega', async () => {
    respostas.equipes = new Error('falha');
    const erro = vi.spyOn(console, 'error').mockImplementation(() => {});
    renderPage();
    expect(await screen.findByRole('alert')).toHaveTextContent('Não foi possível carregar as equipes.');
    expect(screen.queryByText('Nenhuma equipe criada ainda.')).toBeNull();
    respostas.equipes = equipesPadrao();
    fireEvent.click(screen.getByRole('button', { name: 'Tentar novamente' }));
    expect(await screen.findByText('Exibindo 4 de 4 equipes')).toBeInTheDocument();
    erro.mockRestore();
  });

  test('sem equipes cadastradas x nenhuma correspondencia', async () => {
    respostas.equipes = [];
    const { unmount } = renderPage();
    expect(await screen.findByText('Nenhuma equipe criada ainda.')).toBeInTheDocument();
    unmount();
    respostas.equipes = equipesPadrao();
    renderPage('/admin?q=inexistente');
    expect(await screen.findByText('Nenhuma equipe corresponde à pesquisa ou aos filtros aplicados.')).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole('button', { name: 'Limpar filtros' })[0]);
    expect(nomes()).toHaveLength(4);
    expect(estado()).toBe('/admin|null');
  });
});

describe('pesquisa, ordenacao e filtros', () => {
  test('pesquisa por nome, participante e e-mail, sem acento nem maiusculas', async () => {
    renderPage();
    await esperarPronto();
    const busca = screen.getByLabelText('Pesquisar');
    fireEvent.change(busca, { target: { value: 'VALIDACAO' } });
    await waitFor(() => expect(nomes()).toEqual(['Qualidade e Validação']));
    fireEvent.change(busca, { target: { value: 'joão' } });
    await waitFor(() => expect(nomes()).toEqual(['Desenvolvimento']));
    fireEvent.change(busca, { target: { value: 'ANA@EXEMPLO' } });
    await waitFor(() => expect(nomes()).toEqual(['Desenvolvimento', 'Arquivo Antigo']));
    expect(estado()).toBe('/admin?q=ANA%40EXEMPLO|null');
  });

  test('ordenacao por nome e por data, com datas ausentes no fim', async () => {
    renderPage();
    await esperarPronto();
    escolher('Ordenar por', 'nomeAZ');
    expect(nomes()).toEqual(['Arquivo Antigo', 'Desenvolvimento', 'Qualidade e Validação', 'Sem Data']);
    escolher('Ordenar por', 'nomeZA');
    expect(nomes()).toEqual(['Sem Data', 'Qualidade e Validação', 'Desenvolvimento', 'Arquivo Antigo']);
    escolher('Ordenar por', 'antigas');
    expect(nomes()).toEqual(['Arquivo Antigo', 'Qualidade e Validação', 'Desenvolvimento', 'Sem Data']);
    expect(estado()).toBe('/admin?ordem=antigas|null');
  });

  test('filtros de criacao, com aviso sobre equipes sem data', async () => {
    renderPage();
    await esperarPronto();
    escolher('Criação', '7dias');
    expect(nomes()).toEqual(['Desenvolvimento']);
    expect(screen.getByText('1 equipe sem data de criação não entra no filtro de criação.')).toBeInTheDocument();
    escolher('Criação', '30dias');
    expect(nomes()).toEqual(['Desenvolvimento', 'Qualidade e Validação']);
    escolher('Criação', 'mais30dias');
    expect(nomes()).toEqual(['Arquivo Antigo']);
    expect(estado()).toBe('/admin?criacao=mais30dias|null');
    expect(chamadas()).toEqual([API_ENDPOINTS.EQUIPES, API_ENDPOINTS.TAREFAS]);
  });

  test('filtros vindos da URL e valores invalidos ignorados com aviso', async () => {
    const { unmount } = renderPage('/admin?criacao=30dias&ordem=nomeAZ');
    await esperarPronto();
    expect(nomes()).toEqual(['Desenvolvimento', 'Qualidade e Validação']);
    unmount();
    renderPage('/admin?criacao=ontem&ordem=sorte');
    await esperarPronto();
    expect(screen.getByRole('status')).toHaveTextContent('Filtros ignorados por serem inválidos: data de criação, ordenação.');
    expect(screen.getByLabelText('Criação')).toHaveValue('');
    expect(screen.getByLabelText('Ordenar por')).toHaveValue('recentes');
    expect(nomes()).toHaveLength(4);
  });
});

describe('acoes', () => {
  test('"Ver tarefas" leva a /admin/tarefas com o id da equipe', async () => {
    renderPage();
    await esperarPronto();
    const link = screen.getByRole('link', { name: 'Ver tarefas da equipe Qualidade e Validação' });
    expect(link).toHaveAttribute('href', `/admin/tarefas?equipe=${EQ_QA}`);
    fireEvent.click(link);
    expect(estado()).toBe(`/admin/tarefas?equipe=${EQ_QA}|null`);
  });

  test('editar, abrir chat (so quem participa) e excluir com confirmacao continuam iguais', async () => {
    apiDelete.mockResolvedValue({});
    renderPage();
    await esperarPronto();
    expect(screen.getByRole('link', { name: 'Editar equipe Desenvolvimento' })).toHaveAttribute('href', `/admin/equipe/${EQ_DEV}`);
    expect(within(cartao('Arquivo Antigo')).queryByRole('link', { name: /Abrir chat/ })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Excluir equipe Sem Data' }));
    const dialogo = screen.getByRole('dialog');
    expect(dialogo).toHaveTextContent('Sem Data');
    fireEvent.click(within(dialogo).getByRole('button', { name: 'Excluir equipe' }));
    await waitFor(() => expect(screen.queryByRole('article', { name: 'Equipe Sem Data' })).toBeNull());
    expect(apiDelete).toHaveBeenCalledWith(API_ENDPOINTS.DELETE_EQUIPE(EQ_SEM_DATA));
    expect(screen.getByText('Exibindo 3 de 3 equipes')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('link', { name: 'Abrir chat da equipe Desenvolvimento' }));
    expect(estado()).toBe(`/admin/chats|{"equipeId":"${EQ_DEV}"}`);
  });

  test('Insights inteligentes: pagina propria (sem modal e sem consulta aqui), geral e por equipe', async () => {
    renderPage();
    await esperarPronto();
    expect(screen.queryByRole('button', { name: 'Insights IA' })).toBeNull();
    expect(screen.queryByText('Insights de PLN')).toBeNull();
    fireEvent.click(screen.getByRole('link', { name: 'Insights inteligentes' }));
    expect(estado()).toBe('/admin/insights|null');
    expect(apiGet).not.toHaveBeenCalledWith(API_ENDPOINTS.ADMIN_ASSISTANT_INSIGHTS, expect.anything());
    expect(chamadas()).toEqual([API_ENDPOINTS.EQUIPES, API_ENDPOINTS.TAREFAS]);
  });

  test('Ver insights de uma equipe leva o filtro da equipe', async () => {
    renderPage();
    await esperarPronto();
    fireEvent.click(within(cartao('Qualidade e Validação')).getByRole('link', { name: 'Ver insights da equipe Qualidade e Validação' }));
    expect(estado()).toBe(`/admin/insights?equipe=${EQ_QA}|null`);
  });
});

describe('PR #65: descricao, acoes e filtro por atividade', () => {
  test('descricao opcional aparece so quando preenchida (equipes antigas sem o campo continuam iguais)', async () => {
    respostas.equipes = equipesPadrao().map((equipe) => (equipe._id === EQ_DEV ? { ...equipe, descricao: '  Squad do aplicativo web  ' } : equipe));
    renderPage();
    await esperarPronto();
    expect(cartao('Desenvolvimento').querySelector('.team-item-descricao')).toHaveTextContent('Squad do aplicativo web');
    expect(cartao('Qualidade e Validação').querySelector('.team-item-descricao')).toBeNull();
    expect(cartao('Sem Data').querySelector('.team-item-descricao')).toBeNull();
  });

  test('acoes em grade com icones e rotulos; exclusao separada e vermelha; contagem de tarefas no cartao', async () => {
    renderPage();
    await esperarPronto();
    const dev = cartao('Desenvolvimento');
    const grade = dev.querySelector('.team-actions .acoes-equipe');
    const rotulos = [...grade.querySelectorAll('.acao-equipe')].map((acao) => [acao.className.replace('acao-equipe ', ''), acao.textContent]);
    expect(rotulos).toEqual([
      ['acao-equipe--tarefas', 'Ver tarefas'],
      ['acao-equipe--chat', 'Abrir chat'],
      ['acao-equipe--insights', 'Ver insights'],
      ['acao-equipe--editar', 'Editar'],
    ]);
    expect(grade.querySelectorAll('svg[aria-hidden="true"]')).toHaveLength(4);
    const excluir = within(dev).getByRole('button', { name: 'Excluir equipe Desenvolvimento' });
    expect(excluir).toHaveClass('acao-equipe--excluir');
    expect(grade.contains(excluir)).toBe(false);
    expect(dev).toHaveTextContent('2 tarefas');
    expect(cartao('Qualidade e Validação')).toHaveTextContent('1 tarefa');
    expect(cartao('Arquivo Antigo')).toHaveTextContent('Sem tarefas');
  });

  test('com e sem tarefas, na URL, combinado com a pesquisa; uma consulta de tarefas para todas as equipes', async () => {
    renderPage();
    await esperarPronto();
    escolher('Atividade', 'sem');
    expect(nomes()).toEqual(['Arquivo Antigo', 'Sem Data']);
    expect(estado()).toBe('/admin?atividade=sem|null');
    escolher('Atividade', 'com');
    expect(nomes()).toEqual(['Desenvolvimento', 'Qualidade e Validação']);
    fireEvent.change(screen.getByLabelText('Pesquisar'), { target: { value: 'bruno' } });
    await waitFor(() => expect(nomes()).toEqual(['Qualidade e Validação']));
    fireEvent.click(screen.getByRole('button', { name: 'Limpar filtros' }));
    expect(nomes()).toHaveLength(4);
    expect(chamadas()).toEqual([API_ENDPOINTS.EQUIPES, API_ENDPOINTS.TAREFAS]);
    expect(apiGet).toHaveBeenCalledWith(API_ENDPOINTS.TAREFAS, expect.objectContaining({ params: { resumo: 1 } }));
  });

  test('link do Painel Geral (?atividade=sem) abre a lista ja filtrada', async () => {
    renderPage('/admin?atividade=sem');
    await esperarPronto();
    expect(screen.getByLabelText('Atividade')).toHaveValue('sem');
    expect(nomes()).toEqual(['Arquivo Antigo', 'Sem Data']);
    expect(screen.getByText('Exibindo 2 de 4 equipes')).toBeInTheDocument();
  });

  test('tarefas indisponiveis: ninguem vira "sem tarefas"; o filtro nao e aplicado e isso e avisado', async () => {
    respostas.tarefas = new Error('falha');
    const erro = vi.spyOn(console, 'error').mockImplementation(() => {});
    renderPage('/admin?atividade=sem');
    await esperarPronto();
    await screen.findByText(/o filtro por atividade não foi aplicado/);
    expect(nomes()).toHaveLength(4);
    expect(screen.getByLabelText('Atividade')).toBeDisabled();
    expect(screen.queryByText('Sem tarefas')).toBeNull();
    expect(cartao('Desenvolvimento')).not.toHaveTextContent('2 tarefas');
    erro.mockRestore();
  });

  test('enquanto as tarefas carregam, o filtro da URL nao mostra uma lista sem filtro', async () => {
    let liberar;
    respostas.tarefas = () => new Promise((resolve) => { liberar = () => resolve(tarefasPadrao()); });
    renderPage('/admin?atividade=com');
    expect(await screen.findByText('Carregando as tarefas das equipes...')).toBeInTheDocument();
    expect(nomes()).toEqual([]);
    liberar();
    await esperarPronto();
    expect(nomes()).toEqual(['Desenvolvimento', 'Qualidade e Validação']);
  });
});
