// Backlog do colaborador (PR #65): datas civis iguais as da gestao administrativa, pesquisa, filtros, ordenacao e
// "Atribuir para mim" (sucesso, conflito 409, clique duplo), sobre a lista de GET /tarefas/backlog.
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import BacklogUser from './BacklogUser';
import BacklogTaskDetailUser from './BacklogTaskDetailUser';
import { filtrarBacklog, prazoDoBacklog, tarefasDisponiveis } from './backlogUtils';

const { apiGet, apiPut } = vi.hoisted(() => ({ apiGet: vi.fn(), apiPut: vi.fn() }));
vi.mock('../../config/apiClient', () => ({
  __esModule: true,
  default: { get: apiGet, put: apiPut },
  getFullApiUrl: (caminho) => caminho,
}));
vi.mock('../../components/layout/Sidebar', () => ({ __esModule: true, default: () => null }));
vi.mock('../../components/layout/useFotoPerfil', () => ({ useFotoPerfil: () => ({ fotoUrl: '', aoFalharFoto: () => {} }) }));

// No Brasil (UTC-3), new Date('2026-11-30T00:00:00.000Z').toLocaleDateString() da 29/11: e a divergencia corrigida.
const TZ_ORIGINAL = process.env.TZ;
process.env.TZ = 'America/Sao_Paulo';
afterAll(() => {
  process.env.TZ = TZ_ORIGINAL;
});

const AGORA = new Date('2026-11-25T15:00:00.000Z');
const ALFA = { _id: 'a'.repeat(24), nome: 'Alfa' };
const BETA = { _id: 'b'.repeat(24), nome: 'Beta' };

const tarefa = (id, descricao, extra) => ({
  _id: id.padStart(24, '0'),
  descricao,
  status: 'pendente',
  user: null,
  ...extra,
});

const backlogPadrao = () => [
  tarefa('1', 'Melhorar filtros de tarefas', { equipe: ALFA, urgencia: 'media', dataEntrega: '2026-11-30T00:00:00.000Z', createdAt: '2026-11-20T12:00:00.000Z' }),
  tarefa('2', 'Executar testes de acessibilidade', { equipe: BETA, urgencia: 'alta', dataEntrega: '2026-12-02T00:00:00.000Z', createdAt: '2026-11-24T12:00:00.000Z', detalhes: 'Leitor de tela e contraste' }),
  tarefa('3', 'Revisar documentação', { equipe: ALFA, urgencia: 'baixa', createdAt: '2026-11-22T12:00:00.000Z', detalhes: 'Atualizar o guia de instalação' }),
  tarefa('4', 'Corrigir login', { equipe: BETA, urgencia: 'alta', dataEntrega: '2026-11-24T00:00:00.000Z', createdAt: '2026-11-10T12:00:00.000Z' }),
  tarefa('6', 'Publicar release', { equipe: ALFA, urgencia: 'media', dataEntrega: '2026-11-25T00:00:00.000Z', createdAt: '2026-11-23T12:00:00.000Z' }),
  // Fora do recorte (em andamento ou com responsavel): nunca aparece, mesmo que uma resposta antiga a traga.
  tarefa('7', 'Em andamento sem responsável', { equipe: ALFA, status: 'em_andamento' }),
  tarefa('8', 'Já atribuída', { equipe: BETA, user: { _id: 'c'.repeat(24), nome: 'Ana' } }),
];

let respostas;
const responder = async (valor) => {
  const resultado = typeof valor === 'function' ? await valor() : valor;
  if (resultado instanceof Error) throw resultado;
  return { data: resultado };
};
const erroHttp = (status, erro) => Object.assign(new Error(`HTTP ${status}`), { response: { status, data: { erro } } });

function Sonda() {
  const location = useLocation();
  return <p data-testid="local">{location.pathname}</p>;
}

const renderPage = (entrada = '/backlog') => render(
  <MemoryRouter initialEntries={[entrada]}>
    <Routes>
      <Route path="/backlog" element={<><BacklogUser /><Sonda /></>} />
      <Route path="/backlog/:id" element={<><BacklogTaskDetailUser /><Sonda /></>} />
      <Route path="*" element={<Sonda />} />
    </Routes>
  </MemoryRouter>,
);

const esperarPronto = () => screen.findByText(/^Exibindo \d+ de/);
const titulos = () => [...document.querySelectorAll('.backlog-card h3')].map((el) => el.textContent);
const cartao = (titulo) => screen.getByRole('listitem', { name: `Tarefa ${titulo}` });
const escolher = (rotulo, valor) => fireEvent.change(screen.getByLabelText(rotulo), { target: { value: valor } });
const chamadasBacklog = () => apiGet.mock.calls.filter(([url]) => url === '/tarefas/backlog').length;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(AGORA);
  localStorage.clear();
  localStorage.setItem('nome', 'Bruno');
  respostas = { backlog: backlogPadrao(), detalhes: null };
  apiGet.mockReset();
  apiPut.mockReset();
  apiGet.mockImplementation(async (url) => {
    if (url === '/tarefas/backlog') return responder(respostas.backlog);
    if (url.endsWith('/notificacoes/count')) return { data: { count: 2 } };
    if (/^\/tarefas\/\w+\/detalhes$/.test(url)) return responder(respostas.detalhes);
    throw new Error(`URL inesperada: ${url}`);
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('utilitarios do backlog', () => {
  test('o prazo e o dia gravado (30/11 e 02/12), como na gestao administrativa, e nao o dia anterior', () => {
    const [filtros, acessibilidade] = backlogPadrao();
    expect(new Date(filtros.dataEntrega).toLocaleDateString('pt-BR')).toBe('29/11/2026');
    expect(prazoDoBacklog(filtros, '2026-11-25')).toEqual({ texto: '30/11/2026', situacao: 'futura', detalhe: 'Vence em 5 dias', dia: '2026-11-30' });
    expect(prazoDoBacklog(acessibilidade, '2026-11-25').texto).toBe('02/12/2026');
    expect(prazoDoBacklog({ dataEntrega: '2026-11-24T00:00:00.000Z' }, '2026-11-25')).toMatchObject({ situacao: 'atrasada', detalhe: 'Venceu ontem' });
    expect(prazoDoBacklog({ dataEntrega: '2026-11-25T00:00:00.000Z' }, '2026-11-25')).toMatchObject({ situacao: 'hoje', detalhe: 'Vence hoje' });
    expect(prazoDoBacklog({ dataEntrega: 'invalida' }, '2026-11-25')).toEqual({ texto: 'Sem prazo', situacao: 'sem', detalhe: null, dia: null });
  });

  test('so tarefas pendentes e sem responsavel', () => {
    expect(tarefasDisponiveis(backlogPadrao()).map((t) => t.descricao)).not.toContain('Já atribuída');
    expect(tarefasDisponiveis(backlogPadrao())).toHaveLength(5);
    expect(tarefasDisponiveis(null)).toEqual([]);
  });

  test('pesquisa so em titulo e descricao; filtros e ordenacoes', () => {
    const lista = tarefasDisponiveis(backlogPadrao());
    const nomes = (filtros) => filtrarBacklog(lista, { busca: '', equipe: '', urgencia: '', ordem: 'prazoProximo', ...filtros }).map((t) => t.descricao);
    expect(nomes({})).toEqual(['Corrigir login', 'Publicar release', 'Melhorar filtros de tarefas', 'Executar testes de acessibilidade', 'Revisar documentação']);
    expect(nomes({ ordem: 'urgenciaMaior' })).toEqual(['Corrigir login', 'Executar testes de acessibilidade', 'Publicar release', 'Melhorar filtros de tarefas', 'Revisar documentação']);
    expect(nomes({ ordem: 'recentes' })).toEqual(['Executar testes de acessibilidade', 'Publicar release', 'Revisar documentação', 'Melhorar filtros de tarefas', 'Corrigir login']);
    expect(nomes({ busca: 'GUIA instalacao' })).toEqual(['Revisar documentação']);
    expect(nomes({ busca: 'beta' })).toEqual([]);
    expect(nomes({ equipe: BETA._id })).toEqual(['Corrigir login', 'Executar testes de acessibilidade']);
    expect(nomes({ urgencia: 'media' })).toEqual(['Publicar release', 'Melhorar filtros de tarefas']);
    expect(nomes({ ordem: 'qualquer', urgencia: 'urgentissima' })).toHaveLength(5);
  });
});

describe('pagina do backlog', () => {
  test('cabecalho, contador, cartoes com equipe, urgencia e prazo corrigido', async () => {
    renderPage();
    await esperarPronto();
    expect(screen.getByRole('heading', { name: 'Backlog de tarefas', level: 2 })).toBeInTheDocument();
    expect(document.querySelector('.backlog-contador')).toHaveTextContent('5 tarefas disponíveis');
    expect(titulos()).toEqual(['Corrigir login', 'Publicar release', 'Melhorar filtros de tarefas', 'Executar testes de acessibilidade', 'Revisar documentação']);

    const filtros = cartao('Melhorar filtros de tarefas');
    expect(filtros).toHaveTextContent('Alfa');
    expect(filtros).toHaveTextContent('Urgência: Média');
    expect(filtros).toHaveTextContent('30/11/2026');
    expect(filtros).not.toHaveTextContent('29/11/2026');
    expect(filtros).toHaveTextContent('Vence em 5 dias');
    expect(cartao('Executar testes de acessibilidade')).toHaveTextContent('02/12/2026');
    expect(cartao('Executar testes de acessibilidade')).not.toHaveTextContent('01/12/2026');
    expect(cartao('Corrigir login').querySelector('.prazo-atrasada')).toHaveTextContent('Venceu ontem');
    expect(cartao('Publicar release').querySelector('.prazo-hoje')).toHaveTextContent('Vence hoje');
    expect(cartao('Revisar documentação')).toHaveTextContent('Sem prazo');
    expect(cartao('Corrigir login')).toHaveClass('backlog-card--alta');
    expect(within(cartao('Corrigir login')).getByRole('link', { name: 'Ver detalhes da tarefa Corrigir login' }))
      .toHaveAttribute('href', `/backlog/${'4'.padStart(24, '0')}`);
    expect(screen.queryByText('Já atribuída')).toBeNull();
    expect(screen.queryByText('Em andamento sem responsável')).toBeNull();
  });

  test('pesquisa, equipe, urgencia e ordenacao sao locais (sem nova consulta nem polling)', async () => {
    renderPage();
    await esperarPronto();
    fireEvent.change(screen.getByLabelText('Pesquisar'), { target: { value: 'contraste' } });
    expect(titulos()).toEqual(['Executar testes de acessibilidade']);
    fireEvent.change(screen.getByLabelText('Pesquisar'), { target: { value: '' } });
    escolher('Equipe', ALFA._id);
    expect(titulos()).toEqual(['Publicar release', 'Melhorar filtros de tarefas', 'Revisar documentação']);
    escolher('Urgência', 'baixa');
    expect(titulos()).toEqual(['Revisar documentação']);
    expect(screen.getByText('Exibindo 1 de 5 tarefas')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Limpar filtros' }));
    escolher('Ordenar por', 'urgenciaMaior');
    expect(titulos()[0]).toBe('Corrigir login');
    escolher('Ordenar por', 'recentes');
    expect(titulos()[0]).toBe('Executar testes de acessibilidade');
    escolher('Urgência', 'media');
    escolher('Equipe', BETA._id);
    expect(screen.getByText('Nenhuma tarefa corresponde à pesquisa ou aos filtros aplicados.')).toBeInTheDocument();
    expect(chamadasBacklog()).toBe(1);
  });

  test('atribuir para mim: tarefa sai da lista, lista e recarregada e o Kanban fica a um clique', async () => {
    apiPut.mockResolvedValue({ data: { msg: 'Tarefa atribuída com sucesso' } });
    renderPage();
    await esperarPronto();
    respostas.backlog = backlogPadrao().filter((t) => t.descricao !== 'Corrigir login');
    fireEvent.click(screen.getByRole('button', { name: 'Atribuir para mim a tarefa Corrigir login' }));

    expect(await screen.findByText('A tarefa "Corrigir login" agora está com você.')).toBeInTheDocument();
    expect(apiPut).toHaveBeenCalledTimes(1);
    expect(apiPut).toHaveBeenCalledWith(`/tarefas/${'4'.padStart(24, '0')}/atribuir-para-mim`, {});
    expect(titulos()).not.toContain('Corrigir login');
    await waitFor(() => expect(chamadasBacklog()).toBe(2));
    expect(document.querySelector('.backlog-contador')).toHaveTextContent('4 tarefas disponíveis');
    fireEvent.click(screen.getByRole('link', { name: 'Ver no Kanban' }));
    expect(screen.getByTestId('local')).toHaveTextContent('/minhas-tarefas');
  });

  test('clique duplo e outros cliques durante a operacao nao repetem a atribuicao', async () => {
    let concluir;
    apiPut.mockImplementation(() => new Promise((resolve) => { concluir = () => resolve({ data: {} }); }));
    renderPage();
    await esperarPronto();
    const botao = screen.getByRole('button', { name: 'Atribuir para mim a tarefa Corrigir login' });
    fireEvent.click(botao);
    fireEvent.click(botao);
    fireEvent.click(screen.getByRole('button', { name: 'Atribuir para mim a tarefa Publicar release' }));
    expect(apiPut).toHaveBeenCalledTimes(1);
    expect(botao).toBeDisabled();
    expect(botao).toHaveTextContent('Atribuindo…');
    expect(screen.getByRole('button', { name: 'Atribuir para mim a tarefa Publicar release' })).toBeDisabled();
    await act(async () => concluir());
    await screen.findByText('A tarefa "Corrigir login" agora está com você.');
    expect(apiPut).toHaveBeenCalledTimes(1);
  });

  test('conflito 409: mensagem da API, a tarefa nao fica oferecida e a lista e recarregada', async () => {
    apiPut.mockRejectedValue(erroHttp(409, 'Esta tarefa já possui responsável'));
    renderPage();
    await esperarPronto();
    respostas.backlog = backlogPadrao().filter((t) => t.descricao !== 'Publicar release');
    fireEvent.click(screen.getByRole('button', { name: 'Atribuir para mim a tarefa Publicar release' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Esta tarefa já possui responsável. A lista foi atualizada.');
    expect(titulos()).not.toContain('Publicar release');
    await waitFor(() => expect(chamadasBacklog()).toBe(2));
    expect(screen.queryByText(/agora está com você/)).toBeNull();
  });

  test('409 fora do backlog (mensagem com ponto final) e falha de rede', async () => {
    apiPut.mockRejectedValueOnce(erroHttp(409, 'Esta tarefa não está disponível no backlog: apenas tarefas pendentes e sem responsável podem ser assumidas.'));
    renderPage();
    await esperarPronto();
    fireEvent.click(screen.getByRole('button', { name: 'Atribuir para mim a tarefa Corrigir login' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('podem ser assumidas. A lista foi atualizada.');

    apiPut.mockRejectedValueOnce(new Error('Network Error'));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Atribuir para mim a tarefa Publicar release' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Atribuir para mim a tarefa Publicar release' }));
    expect(await screen.findByText('Não foi possível atribuir a tarefa agora. Verifique a conexão e tente novamente.')).toBeInTheDocument();
    // Falha temporaria: a tarefa continua disponivel para tentar de novo.
    expect(titulos()).toContain('Publicar release');
  });

  test('estados: carregando, erro (sem "nenhuma tarefa") com nova tentativa, vazio', async () => {
    const erro = vi.spyOn(console, 'error').mockImplementation(() => {});
    respostas.backlog = new Error('falha');
    const { unmount } = renderPage();
    expect(screen.getByRole('status')).toHaveTextContent('Carregando backlog…');
    expect(await screen.findByRole('alert')).toHaveTextContent('Não foi possível carregar o backlog.');
    expect(screen.queryByText('Nenhuma tarefa disponível no backlog.')).toBeNull();
    respostas.backlog = backlogPadrao();
    fireEvent.click(screen.getByRole('button', { name: 'Tentar novamente' }));
    await esperarPronto();
    unmount();

    respostas.backlog = [tarefa('9', 'Com responsável', { user: 'd'.repeat(24) })];
    renderPage();
    expect(await screen.findByText('Nenhuma tarefa disponível no backlog.')).toBeInTheDocument();
    expect(document.querySelector('.backlog-contador')).toHaveTextContent('0 tarefas disponíveis');
    erro.mockRestore();
  });

  test('falha ao atualizar mantem a lista atual com aviso', async () => {
    const erro = vi.spyOn(console, 'error').mockImplementation(() => {});
    renderPage();
    await esperarPronto();
    respostas.backlog = new Error('falha');
    fireEvent.click(screen.getByRole('button', { name: 'Atualizar' }));
    expect(await screen.findByText(/Não foi possível atualizar o backlog agora/)).toBeInTheDocument();
    expect(titulos()).toHaveLength(5);
    erro.mockRestore();
  });
});

describe('detalhe da tarefa do backlog', () => {
  const ID = '1'.padStart(24, '0');

  test('prazo corrigido, dados organizados e atribuicao com redirecionamento ao Kanban', async () => {
    respostas.detalhes = { tarefa: backlogPadrao()[0] };
    apiPut.mockResolvedValue({ data: {} });
    renderPage(`/backlog/${ID}`);
    const secao = await screen.findByRole('region', { name: 'Tarefa Melhorar filtros de tarefas' });
    expect(secao).toHaveTextContent('Prazo30/11/2026');
    expect(secao).not.toHaveTextContent('29/11/2026');
    expect(secao).toHaveTextContent('StatusPendente');
    expect(secao).toHaveTextContent('Responsável atualSem responsável');
    expect(secao).toHaveTextContent('Urgência: Média');

    const botao = screen.getByRole('button', { name: 'Atribuir para mim' });
    fireEvent.click(botao);
    fireEvent.click(botao);
    expect(await screen.findByText(/Tarefa atribuída para você com sucesso/)).toBeInTheDocument();
    expect(apiPut).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Tarefa atribuída' })).toBeDisabled();
    await waitFor(() => expect(screen.getByTestId('local')).toHaveTextContent('/minhas-tarefas'), { timeout: 3000 });
  });

  test('409: mostra o motivo e recarrega os dados, que explicam por que nao esta mais disponivel', async () => {
    respostas.detalhes = { tarefa: backlogPadrao()[0] };
    apiPut.mockRejectedValue(erroHttp(409, 'Esta tarefa já possui responsável'));
    renderPage(`/backlog/${ID}`);
    await screen.findByRole('region', { name: 'Tarefa Melhorar filtros de tarefas' });
    respostas.detalhes = { tarefa: { ...backlogPadrao()[0], user: { _id: 'c'.repeat(24), nome: 'Ana' } } };
    fireEvent.click(screen.getByRole('button', { name: 'Atribuir para mim' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Esta tarefa já possui responsável');
    expect(await screen.findByRole('button', { name: 'Tarefa já possui responsável' })).toBeDisabled();
    expect(screen.getByText('Ana')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('Esta tarefa já possui responsável');
  });

  test('tarefa que nao esta pendente nao oferece a atribuicao', async () => {
    respostas.detalhes = { tarefa: { ...backlogPadrao()[0], status: 'em_andamento' } };
    renderPage(`/backlog/${ID}`);
    expect(await screen.findByRole('button', { name: 'Indisponível no backlog' })).toBeDisabled();
  });
});
