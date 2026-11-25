// Tarefas do admin: pesquisa, filtros na URL, lista/cards, estados e o pedido abrirTarefaId com filtros ativos.
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import DashboardTarefasAdmin, { CHAVE_VISUALIZACAO_TAREFAS } from './DashboardTarefasAdmin';
import { API_ENDPOINTS } from '../../config/config';

const { apiGet, apiDelete } = vi.hoisted(() => ({ apiGet: vi.fn(), apiDelete: vi.fn() }));
vi.mock('../../config/apiClient', () => ({ __esModule: true, default: { get: apiGet, delete: apiDelete } }));
vi.mock('../../components/layout/Sidebar', () => ({ __esModule: true, default: () => null }));

const oid = (n) => n.toString(16).padStart(24, '0');
const AGORA = new Date('2026-11-25T15:00:00.000Z');
const EQ_DEV = oid(1);
const EQ_QA = oid(2);
const EQ_VAZIA = oid(9);
const ANA = oid(11);
const BRUNO = oid(12);

const tarefasPadrao = () => [
  { _id: oid(101), descricao: 'Corrigir login', detalhes: 'Erro no token', status: 'pendente', urgencia: 'alta', tempoEstimado: 90, dataEntrega: '2026-11-24T00:00:00.000Z', createdAt: '2026-11-24T10:00:00.000Z', equipe: { _id: EQ_DEV, nome: 'Desenvolvimento' }, user: { _id: ANA, nome: 'Ana Souza' } },
  { _id: oid(102), descricao: 'Revisão de código', status: 'em_andamento', urgencia: 'media', tempoGasto: 125, dataEntrega: '2026-11-25T00:00:00.000Z', createdAt: '2026-11-20T10:00:00.000Z', equipe: { _id: EQ_DEV, nome: 'Desenvolvimento' }, user: { _id: BRUNO, nome: 'Bruno Lima' } },
  { _id: oid(103), descricao: 'Testes de regressão', status: 'pendente', urgencia: 'alta', dataEntrega: '2026-11-28T00:00:00.000Z', createdAt: '2026-11-23T10:00:00.000Z', equipe: { _id: EQ_QA, nome: 'Qualidade' }, user: null },
  { _id: oid(104), descricao: 'Relatório final', status: 'em_andamento', urgencia: 'baixa', dataEntrega: '2026-12-20T00:00:00.000Z', createdAt: '2026-10-01T10:00:00.000Z', equipe: { _id: EQ_QA, nome: 'Qualidade' }, user: null },
  { _id: oid(105), descricao: 'Documentação antiga', status: 'concluido', urgencia: 'baixa', dataEntrega: '2026-05-01T00:00:00.000Z', createdAt: '2026-05-01T10:00:00.000Z', equipe: { _id: EQ_DEV, nome: 'Desenvolvimento' }, user: { _id: ANA, nome: 'Ana Souza' } },
  { _id: oid(106), descricao: 'Ajustar layout', status: 'pendente', urgencia: 'baixa', dataEntrega: null, equipe: { _id: EQ_QA, nome: 'Qualidade' }, user: { _id: BRUNO, nome: 'Bruno Lima' } },
];
const equipesPadrao = () => [
  { _id: EQ_DEV, nome: 'Desenvolvimento' },
  { _id: EQ_QA, nome: 'Qualidade' },
  { _id: EQ_VAZIA, nome: 'Equipe Vazia' },
];

let respostas;
const responder = async (valor) => {
  const resultado = typeof valor === 'function' ? await valor() : valor;
  if (resultado instanceof Error) throw resultado;
  return { data: resultado };
};

function Sonda() {
  const location = useLocation();
  const navigate = useNavigate();
  return (
    <>
      <p data-testid="estado">{`${location.pathname}${location.search}|${JSON.stringify(location.state ?? null)}`}</p>
      <button type="button" onClick={() => navigate(-1)}>voltar-historico</button>
      <button type="button" onClick={() => navigate(1)}>avancar-historico</button>
    </>
  );
}

const renderPage = (entrada = '/admin/tarefas', anteriores = []) => render(
  <MemoryRouter initialEntries={[...anteriores, entrada]} initialIndex={anteriores.length}>
    <Routes>
      <Route path="/admin/tarefas" element={<><DashboardTarefasAdmin /><Sonda /></>} />
      <Route path="*" element={<Sonda />} />
    </Routes>
  </MemoryRouter>,
);

const esperarPronto = () => screen.findByText(/^Exibindo \d+ de/);
const titulos = () => [...document.querySelectorAll('.task-row-nome, .tasks-list:not(.tasks-list-fixada) .task-item h3')]
  .map((el) => el.textContent);
const estado = () => screen.getByTestId('estado').textContent;
const escolher = (rotulo, valor) => fireEvent.change(screen.getByLabelText(rotulo), { target: { value: valor } });
const linhaDe = (titulo) => screen.getByText(titulo).closest('.task-row, .task-item');

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(AGORA);
  localStorage.clear();
  respostas = { tarefas: tarefasPadrao(), equipes: equipesPadrao() };
  apiGet.mockReset();
  apiDelete.mockReset();
  apiGet.mockImplementation(async (url) => {
    if (url === API_ENDPOINTS.TAREFAS) return responder(respostas.tarefas);
    if (url === API_ENDPOINTS.EQUIPES) return responder(respostas.equipes);
    throw new Error(`URL inesperada: ${url}`);
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('carregamento e estados', () => {
  test('lista compacta por padrao, mais recentes primeiro, contagem e rotulos em portugues', async () => {
    renderPage();
    await esperarPronto();
    expect(screen.getByRole('table')).toBeInTheDocument();
    expect(screen.getByText('Exibindo 6 de 6 tarefas')).toBeInTheDocument();
    expect(titulos()).toEqual(['Corrigir login', 'Testes de regressão', 'Revisão de código', 'Relatório final', 'Documentação antiga', 'Ajustar layout']);
    expect(within(linhaDe('Revisão de código')).getByText('Em andamento')).toBeInTheDocument();
    expect(within(linhaDe('Documentação antiga')).getByText('Concluída')).toBeInTheDocument();
    expect(within(linhaDe('Revisão de código')).getByText('Média')).toBeInTheDocument();
    expect(within(linhaDe('Corrigir login')).getByText('90 min')).toBeInTheDocument();
    expect(apiGet).toHaveBeenCalledTimes(2);
  });

  test('prazos: atrasada, vence hoje, concluida vencida sem destaque e data gravada sem deslocamento de fuso', async () => {
    renderPage();
    await esperarPronto();
    const atrasada = linhaDe('Corrigir login');
    expect(atrasada).toHaveTextContent('24/11/2026');
    expect(within(atrasada).getByText('Atrasada')).toBeInTheDocument();
    const hoje = linhaDe('Revisão de código');
    expect(hoje).toHaveTextContent('25/11/2026');
    expect(within(hoje).getByText('Vence hoje')).toBeInTheDocument();
    expect(within(hoje).queryByText('Atrasada')).toBeNull();
    const concluida = linhaDe('Documentação antiga');
    expect(concluida).toHaveTextContent('01/05/2026');
    expect(within(concluida).queryByText('Atrasada')).toBeNull();
    expect(linhaDe('Ajustar layout')).toHaveTextContent('Sem prazo');
  });

  test('sem responsavel x backlog disponivel na exibicao', async () => {
    renderPage();
    await esperarPronto();
    expect(within(linhaDe('Testes de regressão')).getByText('Backlog disponível')).toBeInTheDocument();
    const emAndamento = linhaDe('Relatório final');
    expect(within(emAndamento).getByText('Sem responsável')).toBeInTheDocument();
    expect(within(emAndamento).queryByText('Backlog disponível')).toBeNull();
  });

  test('carregando: mensagem propria e filtros desabilitados', async () => {
    respostas.tarefas = () => new Promise(() => {});
    renderPage();
    expect(screen.getByText('Carregando tarefas...')).toBeInTheDocument();
    expect(screen.getByLabelText('Status')).toBeDisabled();
    expect(screen.queryByText('Nenhuma tarefa cadastrada ainda.')).toBeNull();
  });

  test('erro de carregamento nao vira lista vazia; tentar novamente recarrega', async () => {
    respostas.tarefas = new Error('falha de rede');
    const erro = vi.spyOn(console, 'error').mockImplementation(() => {});
    renderPage();
    expect(await screen.findByRole('alert')).toHaveTextContent('Não foi possível carregar as tarefas.');
    expect(screen.queryByText('Nenhuma tarefa cadastrada ainda.')).toBeNull();
    expect(screen.queryByText('Nenhuma tarefa corresponde aos filtros aplicados.')).toBeNull();
    respostas.tarefas = tarefasPadrao();
    fireEvent.click(screen.getByRole('button', { name: 'Tentar novamente' }));
    expect(await screen.findByText('Exibindo 6 de 6 tarefas')).toBeInTheDocument();
    erro.mockRestore();
  });

  test('sem tarefas cadastradas x nenhuma correspondencia', async () => {
    respostas.tarefas = [];
    const { unmount } = renderPage();
    expect(await screen.findByText('Nenhuma tarefa cadastrada ainda.')).toBeInTheDocument();
    unmount();
    respostas.tarefas = tarefasPadrao();
    renderPage('/admin/tarefas?q=inexistente');
    expect(await screen.findByText('Nenhuma tarefa corresponde aos filtros aplicados.')).toBeInTheDocument();
    expect(screen.getByText('Exibindo 0 de 6 tarefas')).toBeInTheDocument();
  });
});

describe('pesquisa e filtros', () => {
  test('pesquisa por titulo (sem acento), equipe e responsavel', async () => {
    renderPage();
    await esperarPronto();
    const busca = screen.getByLabelText('Pesquisar');
    fireEvent.change(busca, { target: { value: 'REVISAO' } });
    await waitFor(() => expect(titulos()).toEqual(['Revisão de código']));
    fireEvent.change(busca, { target: { value: 'qualidade' } });
    await waitFor(() => expect(titulos()).toEqual(['Testes de regressão', 'Relatório final', 'Ajustar layout']));
    fireEvent.change(busca, { target: { value: 'bruno' } });
    await waitFor(() => expect(titulos()).toEqual(['Revisão de código', 'Ajustar layout']));
    expect(estado()).toBe('/admin/tarefas?q=bruno|null');
  });

  test('filtros combinados pela URL: equipe + status + urgencia + prazo', async () => {
    renderPage(`/admin/tarefas?equipe=${EQ_DEV}&status=pendente&urgencia=alta&prazo=atrasadas`);
    await esperarPronto();
    expect(titulos()).toEqual(['Corrigir login']);
    expect(screen.getByLabelText('Equipe')).toHaveValue(EQ_DEV);
    expect(screen.getByLabelText('Status')).toHaveValue('pendente');
    expect(screen.getByLabelText('Urgência')).toHaveValue('alta');
    expect(screen.getByLabelText('Prazo')).toHaveValue('atrasadas');
    expect(screen.getByText('Exibindo 1 de 6 tarefas')).toBeInTheDocument();
  });

  test('status oficiais apenas e filtros escolhidos na tela gravam a URL', async () => {
    renderPage();
    await esperarPronto();
    const opcoesStatus = [...screen.getByLabelText('Status').options].map((opcao) => opcao.value);
    expect(opcoesStatus).toEqual(['', 'pendente', 'em_andamento', 'concluido']);
    escolher('Status', 'em_andamento');
    escolher('Urgência', 'baixa');
    expect(titulos()).toEqual(['Relatório final']);
    expect(estado()).toBe('/admin/tarefas?status=em_andamento&urgencia=baixa|null');
    escolher('Ordenar por', 'urgenciaMaior');
    expect(estado()).toBe('/admin/tarefas?status=em_andamento&urgencia=baixa&ordem=urgenciaMaior|null');
  });

  test('sem responsavel (qualquer status) x backlog disponivel', async () => {
    renderPage('/admin/tarefas?semResponsavel=1');
    await esperarPronto();
    expect(titulos()).toEqual(['Testes de regressão', 'Relatório final']);
    escolher('Responsável', 'backlog');
    expect(titulos()).toEqual(['Testes de regressão']);
    expect(estado()).toBe('/admin/tarefas?backlog=1|null');
    escolher('Responsável', ANA);
    expect(titulos()).toEqual(['Corrigir login', 'Documentação antiga']);
  });

  test('ordenacao por urgencia, prazo e criacao', async () => {
    renderPage('/admin/tarefas?ordem=urgenciaMaior');
    await esperarPronto();
    expect(titulos()).toEqual(['Corrigir login', 'Testes de regressão', 'Revisão de código', 'Documentação antiga', 'Relatório final', 'Ajustar layout']);
    escolher('Ordenar por', 'prazoProximo');
    expect(titulos()).toEqual(['Documentação antiga', 'Corrigir login', 'Revisão de código', 'Testes de regressão', 'Relatório final', 'Ajustar layout']);
    escolher('Ordenar por', 'antigas');
    expect(titulos()).toEqual(['Documentação antiga', 'Relatório final', 'Revisão de código', 'Testes de regressão', 'Corrigir login', 'Ajustar layout']);
  });

  test('limpar filtros zera os filtros e atualiza a URL, mantendo a ordenacao', async () => {
    renderPage('/admin/tarefas?q=login&status=pendente&ordem=nome');
    await esperarPronto();
    expect(titulos()).toEqual(['Corrigir login']);
    fireEvent.click(screen.getByRole('button', { name: 'Limpar filtros' }));
    expect(titulos()).toHaveLength(6);
    expect(screen.getByLabelText('Pesquisar')).toHaveValue('');
    expect(screen.getByLabelText('Status')).toHaveValue('');
    expect(estado()).toBe('/admin/tarefas?ordem=nome|null');
    expect(screen.queryByRole('button', { name: 'Limpar filtros' })).toBeNull();
  });

  test('filtros, ordenacao, pesquisa e visualizacao nao geram novas consultas', async () => {
    renderPage();
    await esperarPronto();
    expect(apiGet).toHaveBeenCalledTimes(2);
    escolher('Status', 'pendente');
    escolher('Prazo', '7dias');
    escolher('Criação', '30dias');
    escolher('Ordenar por', 'nome');
    fireEvent.change(screen.getByLabelText('Pesquisar'), { target: { value: 'testes' } });
    await waitFor(() => expect(estado()).toContain('q=testes'));
    fireEvent.click(screen.getByRole('button', { name: 'Cards' }));
    fireEvent.click(screen.getByRole('button', { name: 'Lista' }));
    expect(titulos()).toEqual(['Testes de regressão']);
    expect(apiGet).toHaveBeenCalledTimes(2);
  });
});

describe('URL: recarregar, voltar/avancar e parametros invalidos', () => {
  test('recarregar mantem os filtros', async () => {
    const { unmount } = renderPage();
    await esperarPronto();
    escolher('Equipe', EQ_QA);
    escolher('Status', 'pendente');
    const url = estado().split('|')[0];
    expect(url).toBe(`/admin/tarefas?equipe=${EQ_QA}&status=pendente`);
    unmount();
    renderPage(url);
    await esperarPronto();
    expect(titulos()).toEqual(['Testes de regressão', 'Ajustar layout']);
    expect(screen.getByLabelText('Equipe')).toHaveValue(EQ_QA);
  });

  test('voltar e avancar do navegador restauram os filtros sem nova consulta', async () => {
    renderPage();
    await esperarPronto();
    escolher('Status', 'concluido');
    expect(titulos()).toEqual(['Documentação antiga']);
    fireEvent.click(screen.getByText('voltar-historico'));
    await waitFor(() => expect(estado()).toBe('/admin/tarefas|null'));
    expect(screen.getByLabelText('Status')).toHaveValue('');
    expect(titulos()).toHaveLength(6);
    fireEvent.click(screen.getByText('avancar-historico'));
    await waitFor(() => expect(screen.getByLabelText('Status')).toHaveValue('concluido'));
    expect(titulos()).toEqual(['Documentação antiga']);
    expect(apiGet).toHaveBeenCalledTimes(2);
  });

  test('digitar na pesquisa nao cria uma entrada no historico por caractere', async () => {
    renderPage('/admin/tarefas', ['/anterior']);
    await esperarPronto();
    const busca = screen.getByLabelText('Pesquisar');
    ['a', 'an', 'ana'].forEach((valor) => fireEvent.change(busca, { target: { value: valor } }));
    await waitFor(() => expect(estado()).toBe('/admin/tarefas?q=ana|null'));
    fireEvent.click(screen.getByText('voltar-historico'));
    await waitFor(() => expect(estado()).toBe('/anterior|null'));
  });

  test('equipe desconhecida e valores invalidos sao ignorados com aviso, sem selecao enganosa', async () => {
    renderPage(`/admin/tarefas?equipe=${oid(99)}&status=pausada&urgencia=alta`);
    await esperarPronto();
    expect(screen.getByRole('status')).toHaveTextContent('Filtros ignorados por serem inválidos ou indisponíveis: equipe, status.');
    expect(screen.getByLabelText('Equipe')).toHaveValue('');
    expect(screen.getByLabelText('Status')).toHaveValue('');
    expect(titulos()).toEqual(['Corrigir login', 'Testes de regressão']);
    escolher('Prazo', '7dias');
    expect(estado()).toBe('/admin/tarefas?urgencia=alta&prazo=7dias|null');
    expect(screen.queryByRole('status')).toBeNull();
  });

  test('equipe autorizada sem tarefas: mensagem propria, equipe selecionada', async () => {
    renderPage(`/admin/tarefas?equipe=${EQ_VAZIA}`);
    expect(await screen.findByText('Esta equipe ainda não possui tarefas.')).toBeInTheDocument();
    expect(screen.getByLabelText('Equipe')).toHaveValue(EQ_VAZIA);
    expect(screen.queryByRole('status')).toBeNull();
  });

  test('falha so em GET /equipes: o filtro usa as equipes das tarefas', async () => {
    respostas.equipes = new Error('indisponivel');
    renderPage(`/admin/tarefas?equipe=${EQ_DEV}`);
    await esperarPronto();
    expect(titulos()).toEqual(['Corrigir login', 'Revisão de código', 'Documentação antiga']);
    expect(screen.getByLabelText('Equipe')).toHaveValue(EQ_DEV);
  });
});

describe('lista e cards', () => {
  test('alternancia preserva os dados, salva a preferencia e Ver detalhes abre a descricao', async () => {
    const { unmount } = renderPage();
    await esperarPronto();
    expect(screen.getByRole('button', { name: 'Lista' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.queryByText('Erro no token')).toBeNull();
    const detalhes = within(linhaDe('Corrigir login')).getByRole('button', { name: 'Ver detalhes' });
    fireEvent.click(detalhes);
    expect(detalhes).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('Erro no token')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Cards' }));
    expect(screen.queryByRole('table')).toBeNull();
    expect(document.querySelectorAll('.tasks-list .task-item')).toHaveLength(6);
    expect(screen.getByText('Erro no token')).toBeInTheDocument();
    expect(localStorage.getItem(CHAVE_VISUALIZACAO_TAREFAS)).toBe('cards');
    unmount();

    renderPage();
    await esperarPronto();
    expect(screen.getByRole('button', { name: 'Cards' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.queryByRole('table')).toBeNull();
  });

  test('cabecalho "Ações" visivel e detalhes de tarefa sem descricao mostram as informacoes disponiveis', async () => {
    renderPage();
    await esperarPronto();
    expect(screen.getByRole('columnheader', { name: 'Ações' })).toBeVisible();
    const linha = linhaDe('Revisão de código');
    fireEvent.click(within(linha).getByRole('button', { name: 'Ver detalhes' }));
    expect(within(linha).getByText('Sem detalhes cadastrados.')).toBeInTheDocument();
    expect(within(linha).getByText('Criada em 20/11/2026')).toBeInTheDocument();
    expect(within(linha).getByText('Tempo registrado: 2h 5min')).toBeInTheDocument();
    fireEvent.click(within(linha).getByRole('button', { name: 'Ocultar detalhes' }));
    expect(within(linha).queryByText('Sem detalhes cadastrados.')).toBeNull();
  });

  test.each(['lista', 'cards'])('editar e excluir com confirmacao continuam funcionando (%s)', async (modo) => {
    localStorage.setItem(CHAVE_VISUALIZACAO_TAREFAS, modo);
    apiDelete.mockResolvedValue({});
    renderPage();
    await esperarPronto();
    fireEvent.click(screen.getByRole('button', { name: 'Excluir tarefa Relatório final' }));
    const dialogo = screen.getByRole('dialog');
    expect(dialogo).toHaveTextContent('Relatório final');
    fireEvent.click(within(dialogo).getByRole('button', { name: 'Excluir tarefa' }));
    await waitFor(() => expect(screen.queryByText('Relatório final')).toBeNull());
    expect(apiDelete).toHaveBeenCalledWith(API_ENDPOINTS.DELETE_TAREFA(oid(104)));
    expect(screen.getByText('Exibindo 5 de 5 tarefas')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Editar tarefa Corrigir login' }));
    expect(estado()).toBe(`/admin/editar-tarefa/${oid(101)}|null`);
  });
});

describe('abrirTarefaId (assistente, Painel Geral, notificacoes)', () => {
  test('tarefa autorizada escondida pelos filtros aparece fixada, com foco, e os filtros sao mantidos', async () => {
    renderPage({ pathname: '/admin/tarefas', search: '?status=concluido', state: { abrirTarefaId: oid(101) } });
    const regiao = await screen.findByRole('region', { name: 'Tarefa solicitada' });
    expect(regiao).toHaveTextContent('A tarefa solicitada não corresponde aos filtros ativos');
    const cartao = within(regiao).getByText('Corrigir login').closest('.task-item');
    expect(cartao).toHaveClass('is-destacada');
    expect(within(cartao).getByText('Erro no token')).toBeInTheDocument();
    await waitFor(() => expect(cartao).toHaveFocus());
    expect(titulos()).toEqual(['Documentação antiga']);
    await waitFor(() => expect(estado()).toBe('/admin/tarefas?status=concluido|null'));

    fireEvent.click(within(regiao).getByRole('button', { name: 'Limpar filtros' }));
    expect(screen.queryByRole('region', { name: 'Tarefa solicitada' })).toBeNull();
    const linha = linhaDe('Corrigir login');
    expect(linha).toHaveClass('is-destacada');
    // Na lista, a tarefa pedida ja chega com os detalhes abertos.
    expect(within(linha).getByRole('button', { name: 'Ocultar detalhes' })).toHaveAttribute('aria-expanded', 'true');
    expect(within(linha).getByText('Erro no token')).toBeInTheDocument();
    expect(titulos()).toHaveLength(6);
  });

  test('lista: a tarefa pedida abre os detalhes, recebe destaque e foco sem segundo clique', async () => {
    renderPage({ pathname: '/admin/tarefas', state: { abrirTarefaId: oid(101) } });
    await esperarPronto();
    const linha = linhaDe('Corrigir login');
    await waitFor(() => expect(linha).toHaveClass('is-destacada'));
    expect(within(linha).getByRole('button', { name: 'Ocultar detalhes' })).toHaveAttribute('aria-expanded', 'true');
    expect(within(linha).getByText('Erro no token')).toBeInTheDocument();
    expect(within(linha).getByText('Criada em 24/11/2026')).toBeInTheDocument();
    await waitFor(() => expect(linha).toHaveFocus());
    // So a tarefa pedida abre.
    expect(within(linhaDe('Revisão de código')).getByRole('button', { name: 'Ver detalhes' })).toHaveAttribute('aria-expanded', 'false');
    await waitFor(() => expect(estado()).toBe('/admin/tarefas|null'));
  });

  test('cards: a tarefa pedida aparece destacada com as informacoes visiveis', async () => {
    localStorage.setItem(CHAVE_VISUALIZACAO_TAREFAS, 'cards');
    renderPage({ pathname: '/admin/tarefas', search: '?status=pendente', state: { abrirTarefaId: oid(101) } });
    await esperarPronto();
    const cartao = linhaDe('Corrigir login');
    await waitFor(() => expect(cartao).toHaveClass('is-destacada'));
    expect(cartao).toHaveClass('task-item');
    expect(within(cartao).getByText('Erro no token')).toBeInTheDocument();
    expect(within(cartao).getByText('Ana Souza')).toBeInTheDocument();
    expect(cartao).toHaveTextContent('24/11/2026');
    await waitFor(() => expect(cartao).toHaveFocus());
    await waitFor(() => expect(estado()).toBe('/admin/tarefas?status=pendente|null'));
  });

  test('fechar os detalhes da tarefa pedida nao reabre depois que o pedido foi consumido', async () => {
    renderPage({ pathname: '/admin/tarefas', search: '?ordem=nome', state: { abrirTarefaId: oid(101) } });
    await esperarPronto();
    const botao = await within(linhaDe('Corrigir login')).findByRole('button', { name: 'Ocultar detalhes' });
    await waitFor(() => expect(estado()).toBe('/admin/tarefas?ordem=nome|null'));
    fireEvent.click(botao);
    expect(screen.queryByText('Erro no token')).toBeNull();
    // Novos renders (filtro, ordenacao, troca de visualizacao) nao reabrem.
    escolher('Status', 'pendente');
    escolher('Ordenar por', 'recentes');
    expect(within(linhaDe('Corrigir login')).getByRole('button', { name: 'Ver detalhes' })).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('Erro no token')).toBeNull();
    expect(apiGet).toHaveBeenCalledTimes(2);
  });

  test('fechar destaque remove a tarefa fixada sem mexer nos filtros', async () => {
    renderPage({ pathname: '/admin/tarefas', search: '?status=concluido', state: { abrirTarefaId: oid(101) } });
    const regiao = await screen.findByRole('region', { name: 'Tarefa solicitada' });
    fireEvent.click(within(regiao).getByRole('button', { name: 'Fechar destaque' }));
    expect(screen.queryByRole('region', { name: 'Tarefa solicitada' })).toBeNull();
    expect(screen.getByLabelText('Status')).toHaveValue('concluido');
  });

  test('tarefa visivel com filtros: destaque direto na lista, sem bloco fixado', async () => {
    renderPage({ pathname: '/admin/tarefas', search: `?equipe=${EQ_DEV}`, state: { abrirTarefaId: oid(102) } });
    await esperarPronto();
    await waitFor(() => expect(linhaDe('Revisão de código')).toHaveClass('is-destacada'));
    expect(within(linhaDe('Revisão de código')).getByText('Sem detalhes cadastrados.')).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Tarefa solicitada' })).toBeNull();
    expect(screen.getByLabelText('Equipe')).toHaveValue(EQ_DEV);
  });

  test('recurso fora da lista autorizada: aviso, nada aberto, filtros preservados', async () => {
    renderPage({ pathname: '/admin/tarefas', search: '?status=pendente', state: { abrirTarefaId: oid(999) } });
    expect(await screen.findByRole('status')).toHaveTextContent('A tarefa solicitada não está disponível nesta lista.');
    expect(document.querySelector('.is-destacada')).toBeNull();
    expect(document.querySelector('[aria-expanded="true"]')).toBeNull();
    await waitFor(() => expect(estado()).toBe('/admin/tarefas?status=pendente|null'));
    expect(screen.getByLabelText('Status')).toHaveValue('pendente');
  });

  test('com erro de carregamento o pedido espera a nova tentativa', async () => {
    respostas.tarefas = new Error('falha');
    const erro = vi.spyOn(console, 'error').mockImplementation(() => {});
    renderPage({ pathname: '/admin/tarefas', state: { abrirTarefaId: oid(103) } });
    await screen.findByRole('alert');
    expect(screen.queryByText('A tarefa solicitada não está disponível nesta lista.')).toBeNull();
    respostas.tarefas = tarefasPadrao();
    fireEvent.click(screen.getByRole('button', { name: 'Tentar novamente' }));
    await waitFor(() => expect(linhaDe('Testes de regressão')).toHaveClass('is-destacada'));
    expect(within(linhaDe('Testes de regressão')).getByRole('button', { name: 'Ocultar detalhes' })).toHaveAttribute('aria-expanded', 'true');
    await waitFor(() => expect(estado()).toBe('/admin/tarefas|null'));
    erro.mockRestore();
  });
});
