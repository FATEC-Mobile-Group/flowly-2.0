import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { Chart } from 'chart.js';
import DashboardGeral from './DashboardGeral';
import { CORES_STATUS, CORES_STATUS_CLARO } from './DistribuicaoTarefas';
import apiClient from '../../config/apiClient';
import { API_ENDPOINTS, LOCAL_STORAGE_KEYS } from '../../config/config';

// Painel Geral (PR #63): carregamento/erro/retry, indicadores e seus links, filtro por equipe, distribuicao,
// entregas atrasadas x proximos 7 dias, pontos de atencao, tema e sino. API simulada e data do sistema fixa.

vi.mock('../../config/apiClient', () => ({
  __esModule: true,
  default: { get: vi.fn() },
  getFullApiUrl: (path = '') => (path.startsWith('http') ? path : `http://api.test${path}`),
}));

const grafico = vi.hoisted(() => ({ props: null }));
vi.mock('react-chartjs-2', async () => {
  const { createElement } = await vi.importActual('react');
  return {
    Doughnut: (props) => {
      grafico.props = props;
      return createElement('div', { 'data-testid': 'grafico-status' });
    },
  };
});

// 17/11/2026 as 10h no horario local. As entregas vem como a API devolve: meia-noite UTC.
const AGORA = new Date(2026, 10, 17, 10, 0, 0);
const entrega = (dia) => `${dia}T00:00:00.000Z`;

const ADMIN = { _id: 'u-admin', nome: 'Admin', tipo: 'admin' };
const ANA = { _id: 'u-ana', nome: 'Ana', tipo: 'user' };
const BRUNO = { _id: 'u-bruno', nome: 'Bruno', tipo: 'user' };

const equipe = (id, nome, membros = []) => ({ _id: id, nome, membros });
const NOMES = { a: 'Alfa', b: 'Beta', c: 'Gama sem tarefas' };
const tarefa = (id, equipeId, status, dia, { tempoGasto = 0, descricao = `Tarefa ${id}`, user = null } = {}) => ({
  _id: id,
  descricao,
  status,
  tempoGasto,
  user,
  dataEntrega: dia === null ? null : entrega(dia),
  equipe: { _id: equipeId, nome: NOMES[equipeId] || equipeId },
});

const dadosPadrao = () => ({
  equipes: [equipe('b', 'Beta', [ADMIN, BRUNO, ANA]), equipe('c', 'Gama sem tarefas'), equipe('a', 'Alfa', [ADMIN, ANA])],
  tarefas: [
    tarefa('a1', 'a', 'concluido', '2026-11-10', { tempoGasto: 120, user: ANA }),
    tarefa('a2', 'a', 'pendente', '2026-11-16', { tempoGasto: 6 }), // atrasada e no backlog
    tarefa('b1', 'b', 'em_andamento', '2026-11-17', { tempoGasto: 500, user: BRUNO }), // vence hoje
    tarefa('b2', 'b', 'pendente', '2026-11-18'), // proximos 7 dias e no backlog
    tarefa('b3', 'b', 'pendente', '2026-11-25', { tempoGasto: 20, user: ANA }), // 8 dias: fora dos proximos 7
  ],
});

// Cada resposta pode ser um valor, um Error (rejeita) ou uma funcao que devolve uma Promise (controle manual).
let respostas;
const responder = (novas) => {
  respostas = { notificacoes: { count: 0 }, ...novas };
};

const adiado = () => {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};

const CHAVES = {
  [API_ENDPOINTS.EQUIPES]: 'equipes',
  [API_ENDPOINTS.TAREFAS]: 'tarefas',
  [API_ENDPOINTS.NOTIFICATIONS_COUNT]: 'notificacoes',
};

const INDICADORES = ['equipes', 'tarefas', 'concluidas', 'emAndamento', 'pendentes', 'atrasadas', 'semResponsavel', 'backlog', 'participantes', 'tempo'];
const pedidos = (url) => apiClient.get.mock.calls.filter(([pedido]) => pedido === url).length;
const kpi = (chave) => document.querySelector(`[data-indicador="${chave}"]`);
const valor = (chave) => kpi(chave).querySelector('.kpi-valor').textContent;
const detalhe = (chave) => kpi(chave).querySelector('.kpi-detalhe').textContent;
const valores = () => INDICADORES.map(valor);
const seletor = () => screen.getByLabelText('Equipe');
const escolher = (id) => fireEvent.change(seletor(), { target: { value: id } });
const painel = (nome) => screen.getByRole('region', { name: nome });
const nomesProgresso = () => [...painel('Progresso das equipes').querySelectorAll('.ranking-nome')].map((n) => n.textContent);
const itensDe = (nome) => [...painel(nome).querySelectorAll('.entrega-item')];
const descricoes = (nome) => itensDe(nome).map((li) => li.querySelector('.entrega-descricao').textContent);
const deixarAssentar = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)); });

function Sonda() {
  const location = useLocation();
  return <p data-testid="local">{`${location.pathname}${location.search}|${JSON.stringify(location.state ?? null)}`}</p>;
}

const abrir = () => render(
  <MemoryRouter initialEntries={['/admin/geral']}>
    <DashboardGeral />
    <Sonda />
  </MemoryRouter>,
);
const esperarPronto = () => screen.findByRole('heading', { name: 'Distribuição das tarefas' });
const abrirPronto = async (dados = dadosPadrao()) => {
  responder(dados);
  const resultado = abrir();
  await esperarPronto();
  return resultado;
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(AGORA);
  localStorage.clear();
  localStorage.setItem(LOCAL_STORAGE_KEYS.TOKEN, 'token-de-teste');
  localStorage.setItem(LOCAL_STORAGE_KEYS.USER_TYPE, 'admin');
  localStorage.setItem(LOCAL_STORAGE_KEYS.USER_NAME, 'Chuckles');
  grafico.props = null;
  apiClient.get.mockReset();
  apiClient.get.mockImplementation(async (url, opcoes) => {
    if (url === API_ENDPOINTS.USER_ME) return { data: { nome: 'Chuckles', fotoPerfil: '' } };
    const chave = CHAVES[url];
    if (!chave) return { data: [] };
    const resposta = typeof respostas[chave] === 'function' ? await respostas[chave](opcoes) : respostas[chave];
    if (resposta instanceof Error) throw resposta;
    return { data: resposta };
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  document.documentElement.removeAttribute('data-theme');
});

describe('carregamento, erro e nova tentativa', () => {
  test('enquanto equipes e tarefas carregam, nenhum zero aparece como resultado e nenhum cartao vira link', async () => {
    const equipesAdiadas = adiado();
    const tarefasAdiadas = adiado();
    responder({ equipes: () => equipesAdiadas.promise, tarefas: () => tarefasAdiadas.promise });
    abrir();

    await waitFor(() => expect(pedidos(API_ENDPOINTS.TAREFAS)).toBe(1));
    expect(valores()).toEqual(Array(10).fill('—'));
    expect(screen.getByRole('region', { name: 'Indicadores' })).toHaveAttribute('aria-busy', 'true');
    expect(within(screen.getByRole('region', { name: 'Indicadores' })).queryAllByRole('link')).toHaveLength(0);
    expect(screen.getByRole('status')).toHaveTextContent('Carregando dados do painel…');
    expect(seletor()).toBeDisabled();
    expect(screen.queryByRole('heading', { name: 'Distribuição das tarefas' })).toBeNull();
    expect(document.body.textContent).not.toMatch(/\b0m\b|0min/);

    const dados = dadosPadrao();
    await act(async () => {
      equipesAdiadas.resolve(dados.equipes);
      tarefasAdiadas.resolve(dados.tarefas);
    });

    await esperarPronto();
    expect(valores()).toEqual(['3', '5', '1', '1', '3', '1', '2', '2', '2', '10h 46min']);
    expect(seletor()).toBeEnabled();
  });

  test('falha nas tarefas: avisa, nao mostra indicadores e "Tentar novamente" busca de novo, sem loop', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    responder({ ...dadosPadrao(), tarefas: new Error('Network Error') });
    abrir();

    const alerta = await screen.findByRole('alert');
    expect(alerta).toHaveTextContent('Não foi possível carregar os dados do painel.');
    expect(document.querySelector('.kpi-valor')).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Distribuição das tarefas' })).toBeNull();

    await deixarAssentar();
    expect(pedidos(API_ENDPOINTS.EQUIPES)).toBe(1);
    expect(pedidos(API_ENDPOINTS.TAREFAS)).toBe(1);

    responder(dadosPadrao());
    fireEvent.click(within(alerta).getByRole('button', { name: 'Tentar novamente' }));

    await esperarPronto();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(valor('tarefas')).toBe('5');
    expect(pedidos(API_ENDPOINTS.EQUIPES)).toBe(2);
    expect(pedidos(API_ENDPOINTS.TAREFAS)).toBe(2);
  });

  test('falha nas equipes e resposta que nao e lista tambem viram erro', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    for (const problema of [{ equipes: new Error('500') }, { equipes: { erro: 'inesperado' } }, { tarefas: null }]) {
      responder({ ...dadosPadrao(), ...problema });
      const { unmount } = abrir();
      expect(await screen.findByRole('alert')).toHaveTextContent('Não foi possível carregar os dados do painel.');
      unmount();
    }
  });

  test('falha no contador de notificacoes nao impede o painel', async () => {
    const erros = vi.spyOn(console, 'error').mockImplementation(() => {});
    await abrirPronto({ ...dadosPadrao(), notificacoes: new Error('500') });

    expect(screen.queryByRole('alert')).toBeNull();
    expect(valor('tarefas')).toBe('5');
    expect(document.querySelector('.notification-badge')).toBeNull();
    expect(erros).toHaveBeenCalledWith('Erro ao buscar notificações:', expect.any(Error));
  });

  test('desmontar no meio do carregamento cancela os pedidos e nada e atualizado depois', async () => {
    const erros = vi.spyOn(console, 'error').mockImplementation(() => {});
    const equipesAdiadas = adiado();
    responder({ ...dadosPadrao(), equipes: () => equipesAdiadas.promise });
    const { unmount } = abrir();
    await waitFor(() => expect(pedidos(API_ENDPOINTS.EQUIPES)).toBe(1));

    const sinais = apiClient.get.mock.calls.map(([, opcoes]) => opcoes?.signal).filter(Boolean);
    expect(sinais.length).toBeGreaterThanOrEqual(3); // equipes, tarefas e notificacoes
    unmount();
    expect(sinais.every((sinal) => sinal.aborted)).toBe(true);

    await act(async () => { equipesAdiadas.reject(new Error('cancelado')); });
    await deixarAssentar();
    expect(erros).not.toHaveBeenCalledWith('Erro ao carregar o Painel Geral:', expect.anything());
    expect(pedidos(API_ENDPOINTS.EQUIPES)).toBe(1);
  });

  test('"Atualizar" mantem os numeros reais durante a busca e aplica os dados novos', async () => {
    await abrirPronto();
    const tarefasAdiadas = adiado();
    respostas.tarefas = () => tarefasAdiadas.promise;

    fireEvent.click(screen.getByRole('button', { name: /Atualizar/ }));

    const botao = screen.getByRole('button', { name: /Atualizando/ });
    expect(botao).toBeDisabled();
    expect(valor('tarefas')).toBe('5');

    const novas = [...dadosPadrao().tarefas, tarefa('a3', 'a', 'pendente', '2026-11-20', { tempoGasto: 30 })];
    await act(async () => { tarefasAdiadas.resolve(novas); });

    await waitFor(() => expect(valor('tarefas')).toBe('6'));
    expect(valor('tempo')).toBe('11h 16min');
    expect(valor('backlog')).toBe('3');
    expect(screen.getByRole('button', { name: /Atualizar/ })).toBeEnabled();
  });
});

describe('consulta resumida de tarefas', () => {
  test('pede GET /tarefas com resumo=1 (parametro aditivo) e mantem o sinal de cancelamento', async () => {
    await abrirPronto();
    const chamada = apiClient.get.mock.calls.find(([url]) => url === API_ENDPOINTS.TAREFAS);
    expect(chamada[1]).toMatchObject({ params: { resumo: 1 } });
    expect(chamada[1].signal).toBeInstanceOf(AbortSignal);
  });

  test('backend antigo (resposta completa, com anexos e detalhes): mesmos indicadores', async () => {
    const dados = dadosPadrao();
    dados.tarefas = dados.tarefas.map((t) => ({
      ...t,
      detalhes: 'texto longo',
      anexos: [{ nome: 'a.pdf', url: 'https://storage.test/a.pdf?X-Goog-Signature=x' }],
      subtarefas: [{ descricao: 'sub' }],
      urgencia: 'alta',
    }));
    await abrirPronto(dados);
    expect(valores()).toEqual(['3', '5', '1', '1', '3', '1', '2', '2', '2', '10h 46min']);
  });
});

describe('indicadores', () => {
  test('dez indicadores com rotulos, valores e detalhes', async () => {
    await abrirPronto();

    const cartoes = [...document.querySelectorAll('[data-indicador]')].map((cartao) => [
      cartao.querySelector('h3').textContent,
      cartao.querySelector('.kpi-valor').textContent,
      cartao.querySelector('.kpi-detalhe').textContent,
    ]);
    expect(cartoes).toEqual([
      ['Equipes vinculadas', '3', '2 com tarefas · 1 sem tarefas'],
      ['Total de tarefas', '5', '4 em aberto'],
      ['Concluídas', '1', '20% do total'],
      ['Em andamento', '1', 'status em andamento'],
      ['Pendentes', '3', 'ainda não iniciadas'],
      ['Atrasadas', '1', 'não concluídas, prazo vencido'],
      ['Sem responsável', '2', 'qualquer status'],
      ['Backlog disponível', '2', 'pendentes e sem responsável'],
      ['Colaboradores únicos', '2', 'sem repetir entre equipes; 1 administrador fora da conta'],
      ['Tempo registrado', '10h 46min', 'acumulado nas tarefas'],
    ]);
  });

  test('cada indicador com destino abre a lista filtrada do PR #62; tempo e colaboradores nao sao links', async () => {
    await abrirPronto();

    const destinos = Object.fromEntries(INDICADORES.map((chave) => [chave, kpi(chave).getAttribute('href')]));
    expect(destinos).toEqual({
      equipes: '/admin',
      tarefas: '/admin/tarefas',
      concluidas: '/admin/tarefas?status=concluido',
      emAndamento: '/admin/tarefas?status=em_andamento',
      pendentes: '/admin/tarefas?status=pendente',
      atrasadas: '/admin/tarefas?prazo=atrasadas',
      semResponsavel: '/admin/tarefas?semResponsavel=1',
      backlog: '/admin/tarefas?backlog=1',
      participantes: null,
      tempo: null,
    });
    expect(kpi('equipes')).toHaveTextContent('Ver todas as equipes');
    expect(kpi('tempo').tagName).toBe('DIV');

    fireEvent.click(kpi('backlog'));
    expect(screen.getByTestId('local')).toHaveTextContent('/admin/tarefas?backlog=1|null');
  });

  test('com equipe selecionada, os links levam a equipe junto (contrato da URL de tarefas)', async () => {
    await abrirPronto();
    escolher('b');

    expect(kpi('concluidas')).toHaveAttribute('href', '/admin/tarefas?equipe=b&status=concluido');
    expect(kpi('backlog')).toHaveAttribute('href', '/admin/tarefas?equipe=b&backlog=1');
    expect(kpi('tarefas')).toHaveAttribute('href', '/admin/tarefas?equipe=b');
    expect(kpi('equipes')).toHaveAttribute('href', '/admin'); // relacao completa, dito no cartao
    expect(screen.getByText(/Mostrando a equipe/)).toHaveTextContent('Mostrando a equipe Beta');
  });

  test('participantes sem tipo (backend anterior): "Participantes únicos", deduplicados e incluindo administradores', async () => {
    const dados = dadosPadrao();
    dados.equipes = dados.equipes.map((e) => ({ ...e, membros: e.membros.map(({ _id, nome }) => ({ _id, nome })) }));
    await abrirPronto(dados);

    expect(kpi('participantes').querySelector('h3')).toHaveTextContent('Participantes únicos');
    expect(valor('participantes')).toBe('3'); // admin, Ana e Bruno, sem repetir Ana e o admin
    expect(detalhe('participantes')).toBe('sem repetir; pode incluir administradores');
  });

  test('nenhuma equipe: zeros reais depois de carregar e estados vazios em cada secao', async () => {
    await abrirPronto({ equipes: [], tarefas: [] });

    expect(valores()).toEqual(['0', '0', '0', '0', '0', '0', '0', '0', '0', '0min']);
    expect(detalhe('concluidas')).toBe('0% do total');
    expect(within(painel('Distribuição das tarefas')).getByText('Nenhuma tarefa nas suas equipes.')).toBeInTheDocument();
    expect(screen.queryByTestId('grafico-status')).toBeNull();
    expect(within(painel('Entregas atrasadas')).getByText('Nenhuma tarefa atrasada.')).toBeInTheDocument();
    expect(within(painel('Próximas entregas')).getByText('Nenhuma entrega nos próximos 7 dias.')).toBeInTheDocument();
    expect(within(painel('Progresso das equipes')).getByText('Nenhuma equipe cadastrada.')).toBeInTheDocument();
    expect(within(painel('Pontos de atenção')).getByText('Nenhum ponto de atenção no momento.')).toBeInTheDocument();
  });
});

describe('filtro por equipe', () => {
  test('oferece "Todas as equipes" e as equipes da API em ordem alfabetica', async () => {
    // A tarefa de "x" veio na lista de tarefas, mas "x" nao esta entre as equipes do admin.
    const dados = dadosPadrao();
    dados.tarefas.push(tarefa('x1', 'x', 'pendente', '2026-11-30'));
    await abrirPronto(dados);

    const opcoes = [...seletor().options].map((opcao) => [opcao.value, opcao.textContent]);
    expect(opcoes).toEqual([['', 'Todas as equipes'], ['a', 'Alfa'], ['b', 'Beta'], ['c', 'Gama sem tarefas']]);
    expect(seletor()).toHaveValue('');
    expect(screen.getByText('Mostrando todas as equipes')).toBeInTheDocument();
  });

  test('escolher uma equipe atualiza indicadores, grafico, progresso e entregas juntos, sem nova requisicao', async () => {
    await abrirPronto();
    const antes = apiClient.get.mock.calls.length;

    escolher('b');

    expect(seletor()).toHaveValue('b');
    expect(valores()).toEqual(['1', '3', '0', '1', '2', '0', '1', '1', '2', '8h 40min']);
    expect(detalhe('equipes')).toBe('de 3 vinculadas');
    expect(grafico.props.data.datasets[0].data).toEqual([2, 1, 0]);
    expect(nomesProgresso()).toEqual(['Beta']);
    expect(descricoes('Entregas atrasadas')).toEqual([]);
    expect(descricoes('Próximas entregas')).toEqual(['Tarefa b1', 'Tarefa b2']);

    escolher('a');

    expect(valores()).toEqual(['1', '2', '1', '0', '1', '1', '1', '1', '1', '2h 6min']);
    expect(grafico.props.data.datasets[0].data).toEqual([1, 0, 1]);
    expect(nomesProgresso()).toEqual(['Alfa']);
    expect(descricoes('Entregas atrasadas')).toEqual(['Tarefa a2']);

    escolher('');

    expect(valores()).toEqual(['3', '5', '1', '1', '3', '1', '2', '2', '2', '10h 46min']);
    expect(grafico.props.data.datasets[0].data).toEqual([3, 1, 1]);
    expect(nomesProgresso()).toEqual(['Alfa', 'Beta']);
    expect(apiClient.get.mock.calls.length).toBe(antes);
  });

  test('equipe sem tarefas: zeros reais, estados vazios e o ponto de atencao da equipe, sem grafico', async () => {
    await abrirPronto();

    escolher('c');

    expect(valores()).toEqual(['1', '0', '0', '0', '0', '0', '0', '0', '0', '0min']);
    expect(screen.getByText('Esta equipe ainda não tem tarefas.')).toBeInTheDocument();
    expect(screen.queryByTestId('grafico-status')).toBeNull();
    expect(within(painel('Entregas atrasadas')).getByText('Nenhuma tarefa atrasada nesta equipe.')).toBeInTheDocument();
    const progresso = painel('Progresso das equipes');
    expect(progresso.querySelector('.ranking-vazio')).toHaveTextContent('Gama sem tarefas: sem tarefas.');
    expect(within(progresso).queryByRole('button')).toBeNull();
    expect(within(painel('Pontos de atenção')).getByText('Esta equipe ainda não tem tarefas')).toBeInTheDocument();
  });

  test('valor fora do escopo da API e ignorado: continua mostrando todas as equipes', async () => {
    await abrirPronto();

    escolher('equipe-de-outro-admin');

    expect(seletor()).toHaveValue('');
    expect(valor('tarefas')).toBe('5');
    expect(kpi('concluidas')).toHaveAttribute('href', '/admin/tarefas?status=concluido');
  });

  test('equipe escolhida que some depois de atualizar volta para "Todas" e avisa', async () => {
    await abrirPronto();
    escolher('b');
    expect(valor('tarefas')).toBe('3');

    const dados = dadosPadrao();
    responder({ equipes: dados.equipes.filter((e) => e._id !== 'b'), tarefas: dados.tarefas.filter((t) => t.equipe._id !== 'b') });
    fireEvent.click(screen.getByRole('button', { name: /Atualizar/ }));

    expect(await screen.findByText('A equipe selecionada não está mais disponível. Mostrando todas as equipes.')).toBeInTheDocument();
    expect(seletor()).toHaveValue('');
    expect(valor('equipes')).toBe('2');
    expect(valor('tarefas')).toBe('2');
    expect(kpi('concluidas')).toHaveAttribute('href', '/admin/tarefas?status=concluido');

    escolher('a');
    expect(screen.queryByText(/não está mais disponível/)).toBeNull();
  });
});

describe('distribuicao das tarefas', () => {
  test('rosca com os tres status oficiais, total no centro e legenda clicavel com percentuais', async () => {
    await abrirPronto();

    expect(grafico.props.data.labels).toEqual(['Pendente', 'Em andamento', 'Concluída']);
    expect(grafico.props.data.datasets[0].backgroundColor).toEqual([CORES_STATUS.pendente, CORES_STATUS.em_andamento, CORES_STATUS.concluido]);
    expect(grafico.props.options).toMatchObject({ maintainAspectRatio: false, animation: false, plugins: { legend: { display: false } } });
    const secao = painel('Distribuição das tarefas');
    expect(secao.querySelector('.distribuicao-centro')).toHaveTextContent('5tarefas');
    const legenda = within(secao).getByRole('list', { name: 'Tarefas por status' });
    expect(within(legenda).getAllByRole('link').map((link) => [link.textContent, link.getAttribute('href')])).toEqual([
      ['Pendente360%', '/admin/tarefas?status=pendente'],
      ['Em andamento120%', '/admin/tarefas?status=em_andamento'],
      ['Concluída120%', '/admin/tarefas?status=concluido'],
    ]);
    expect(within(legenda).getByRole('link', { name: /^Pendente: 3 tarefas, 60% do total/ })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Visão Geral de Produtividade' })).toBeNull();
  });

  test('status inesperado: conta no total, nao vira fatia e e informado', async () => {
    const dados = dadosPadrao();
    dados.tarefas.push(tarefa('z1', 'a', 'arquivada', '2026-11-30'));
    await abrirPronto(dados);

    expect(valor('tarefas')).toBe('6');
    expect(grafico.props.data.datasets[0].data).toEqual([3, 1, 1]);
    expect(painel('Distribuição das tarefas')).toHaveTextContent('1 tarefa tem status fora dos três oficiais');
  });

  test('tema claro: tons mais escuros nas fatias e acompanha a troca de tema', async () => {
    await abrirPronto();
    act(() => { document.documentElement.setAttribute('data-theme', 'light'); });
    await waitFor(() => expect(grafico.props.data.datasets[0].backgroundColor)
      .toEqual([CORES_STATUS_CLARO.pendente, CORES_STATUS_CLARO.em_andamento, CORES_STATUS_CLARO.concluido]));
  });
});

describe('entregas atrasadas x proximas entregas', () => {
  const tarefasDeEntrega = () => [
    tarefa('t1', 'b', 'pendente', '2026-11-30', { descricao: 'Relatório final' }),
    tarefa('t2', 'a', 'concluido', '2026-11-01', { descricao: 'Concluída antiga' }),
    tarefa('t3', 'a', 'em_andamento', '2026-11-16', { descricao: 'Revisar API' }),
    tarefa('t4', 'b', 'pendente', '2026-11-18', { descricao: 'Testes do app' }),
    tarefa('t5', 'a', 'pendente', '2026-11-17', { descricao: 'Deploy de homologação' }),
    tarefa('t6', 'b', 'pendente', '2026-11-12', { descricao: 'Corrigir login' }),
    tarefa('t7', 'a', 'pendente', '2026-11-21', { descricao: 'Documentação' }),
    tarefa('t8', 'b', 'pendente', '2026-12-05', { descricao: 'Apresentação' }),
    tarefa('t9', 'a', 'pendente', '2026-11-24', { descricao: 'Ultimo dia da janela' }),
    tarefa('t10', 'a', 'pendente', '2026-11-25', { descricao: 'Um dia depois da janela' }),
    { ...tarefa('t11', 'a', 'pendente', null, { descricao: 'Sem prazo' }) },
    { ...tarefa('t12', 'a', 'pendente', null, { descricao: 'Prazo invalido' }), dataEntrega: 'amanha' },
    tarefa('t13', 'b', 'pendente', '2026-05-01', { descricao: 'Antiga 1' }),
    tarefa('t14', 'b', 'em_andamento', '2026-05-02', { descricao: 'Antiga 2' }),
    tarefa('t15', 'a', 'pendente', '2026-05-03', { descricao: 'Antiga 3' }),
    tarefa('t16', 'a', 'pendente', '2026-05-04', { descricao: 'Antiga 4' }),
  ];
  const linhas = (nome) => itensDe(nome).map((li) => ({
    descricao: li.querySelector('.entrega-descricao').textContent,
    equipe: li.querySelector('.entrega-equipe').textContent,
    data: li.querySelector('time').textContent,
    dia: li.querySelector('time').getAttribute('datetime'),
    prazo: li.querySelector('.entrega-relativo').textContent,
    selo: li.querySelector('.entrega-selo')?.textContent ?? null,
  }));

  test('atrasadas: so nao concluidas antes de hoje, mais antigas primeiro, ate 5, com total e lista completa', async () => {
    await abrirPronto({ equipes: [equipe('a', 'Alfa'), equipe('b', 'Beta')], tarefas: tarefasDeEntrega() });

    expect(linhas('Entregas atrasadas')).toEqual([
      { descricao: 'Antiga 1', equipe: 'Beta', data: '01/05/2026', dia: '2026-05-01', prazo: 'Venceu há 200 dias', selo: null },
      { descricao: 'Antiga 2', equipe: 'Beta', data: '02/05/2026', dia: '2026-05-02', prazo: 'Venceu há 199 dias', selo: null },
      { descricao: 'Antiga 3', equipe: 'Alfa', data: '03/05/2026', dia: '2026-05-03', prazo: 'Venceu há 198 dias', selo: null },
      { descricao: 'Antiga 4', equipe: 'Alfa', data: '04/05/2026', dia: '2026-05-04', prazo: 'Venceu há 197 dias', selo: null },
      { descricao: 'Corrigir login', equipe: 'Beta', data: '12/11/2026', dia: '2026-11-12', prazo: 'Venceu há 5 dias', selo: null },
    ]);
    const secao = painel('Entregas atrasadas');
    expect(secao.querySelector('.entregas-total')).toHaveTextContent('6');
    expect(secao.querySelector('.entregas-resumo')).toHaveTextContent('Mostrando 5 de 6.');
    expect(within(secao).getByRole('link', { name: 'Ver todas as atrasadas' })).toHaveAttribute('href', '/admin/tarefas?prazo=atrasadas');
    expect(valor('atrasadas')).toBe('6');
  });

  test('proximas: de hoje ate hoje + 7 (inclusive), sem atrasadas, concluidas ou prazos invalidos; hoje destacado', async () => {
    await abrirPronto({ equipes: [equipe('a', 'Alfa'), equipe('b', 'Beta')], tarefas: tarefasDeEntrega() });

    expect(linhas('Próximas entregas')).toEqual([
      { descricao: 'Deploy de homologação', equipe: 'Alfa', data: '17/11/2026', dia: '2026-11-17', prazo: 'Vence hoje', selo: 'Hoje' },
      { descricao: 'Testes do app', equipe: 'Beta', data: '18/11/2026', dia: '2026-11-18', prazo: 'Vence amanhã', selo: null },
      { descricao: 'Documentação', equipe: 'Alfa', data: '21/11/2026', dia: '2026-11-21', prazo: 'Vence em 4 dias', selo: null },
      { descricao: 'Ultimo dia da janela', equipe: 'Alfa', data: '24/11/2026', dia: '2026-11-24', prazo: 'Vence em 7 dias', selo: null },
    ]);
    const secao = painel('Próximas entregas');
    expect(itensDe('Próximas entregas')[0]).toHaveClass('is-hoje');
    expect(secao).toHaveTextContent('de hoje (17/11/2026) até 24/11/2026');
    expect(secao.querySelector('.entregas-total')).toHaveTextContent('4');
    expect(secao.querySelector('.entregas-resumo')).not.toHaveTextContent('Mostrando');
    expect(within(secao).getByRole('link', { name: 'Ver entregas dos próximos 7 dias' })).toHaveAttribute('href', '/admin/tarefas?prazo=7dias');
    expect(secao).not.toHaveTextContent('Um dia depois da janela');
    expect(secao).not.toHaveTextContent('Revisar API');
  });

  test('"Ver detalhes" abre a tarefa pelo state abrirTarefaId, levando a equipe selecionada na URL', async () => {
    const ID = 'a'.repeat(24);
    const dados = { equipes: [equipe('a', 'Alfa')], tarefas: [{ ...tarefa(ID, 'a', 'pendente', '2026-11-18'), descricao: 'Abrir esta' }] };
    await abrirPronto(dados);

    fireEvent.click(within(painel('Próximas entregas')).getByRole('link', { name: 'Ver detalhes de Abrir esta' }));
    expect(screen.getByTestId('local')).toHaveTextContent(`/admin/tarefas|{"abrirTarefaId":"${ID}"}`);
  });

  test('com equipe selecionada, "Ver detalhes" e "Ver todas" preservam a equipe', async () => {
    const ID = 'b'.repeat(24);
    await abrirPronto({
      equipes: [equipe('a', 'Alfa'), equipe('b', 'Beta')],
      tarefas: [{ ...tarefa(ID, 'b', 'pendente', '2026-11-10'), descricao: 'Atrasada da Beta' }, tarefa('x', 'a', 'pendente', '2026-11-10')],
    });
    escolher('b');

    const secao = painel('Entregas atrasadas');
    expect(within(secao).getByRole('link', { name: 'Ver todas as atrasadas' })).toHaveAttribute('href', '/admin/tarefas?equipe=b&prazo=atrasadas');
    fireEvent.click(within(secao).getByRole('link', { name: 'Ver detalhes de Atrasada da Beta' }));
    expect(screen.getByTestId('local')).toHaveTextContent(`/admin/tarefas?equipe=b|{"abrirTarefaId":"${ID}"}`);
  });

  test('so tarefas concluidas: secoes vazias, sem resumo', async () => {
    await abrirPronto({ equipes: [equipe('a', 'Alfa')], tarefas: [tarefa('t1', 'a', 'concluido', '2026-11-16')] });

    expect(within(painel('Entregas atrasadas')).getByText('Nenhuma tarefa atrasada.')).toBeInTheDocument();
    expect(painel('Entregas atrasadas').querySelector('.entregas-resumo')).toBeNull();
    expect(valor('atrasadas')).toBe('0');
  });
});

describe('pontos de atencao', () => {
  test('so fatos calculados que existem, com o link da lista filtrada e a mesma contagem do link', async () => {
    const dados = dadosPadrao();
    // Mais uma sem responsavel, fora do backlog (em andamento).
    dados.tarefas.push(tarefa('b4', 'b', 'em_andamento', '2026-12-10'));
    await abrirPronto(dados);

    const itens = [...painel('Pontos de atenção').querySelectorAll('.atencao-item')].map((li) => [
      li.dataset.ponto,
      li.querySelector('.atencao-texto').textContent,
      li.querySelector('a').getAttribute('href'),
    ]);
    expect(itens).toEqual([
      ['atrasadas', '1 tarefa atrasada (não concluídas, prazo vencido)', '/admin/tarefas?prazo=atrasadas'],
      ['vencemHoje', '1 tarefa vence hoje', '/admin/tarefas?prazo=hoje'],
      ['semResponsavel', '3 tarefas sem responsável, sendo 2 disponíveis no backlog', '/admin/tarefas?semResponsavel=1'],
      ['equipesSemTarefas', '1 equipe sem tarefas', '/admin'],
    ]);
    // O total do ponto e o mesmo do indicador "Sem responsável", cujo link e o mesmo semResponsavel=1.
    expect(valor('semResponsavel')).toBe('3');
    expect(valor('backlog')).toBe('2');
  });
});

describe('sino e Chart.js', () => {
  test('sino sem cor fixa: usa as classes do tema e mostra o contador', async () => {
    await abrirPronto({ ...dadosPadrao(), notificacoes: { count: 3 } });

    const sino = screen.getByRole('link', { name: 'Ver notificações' });
    expect(sino).toHaveClass('notification-bell');
    expect(sino).not.toHaveAttribute('style');
    await waitFor(() => expect(sino.querySelector('.notification-badge')).toHaveTextContent('3'));
    expect(sino.querySelector('.notification-badge')).not.toHaveAttribute('style');
  });

  test('cabecalho com titulo e Chart.js so com o necessario para a rosca (arco e tooltip, sem Legend)', async () => {
    await abrirPronto();

    expect(screen.getByRole('heading', { name: 'Painel Geral', level: 2 })).toBeInTheDocument();
    expect(screen.queryByPlaceholderText('Pesquisar painéis...')).toBeNull();
    expect(Chart.registry.elements.get('arc')).toBeDefined();
    expect(Chart.registry.plugins.get('tooltip')).toBeDefined();
    expect(Chart.registry.plugins.get('legend')).toBeUndefined();
  });
});
