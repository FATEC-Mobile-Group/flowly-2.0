import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { Chart } from 'chart.js';
import DashboardGeral from './DashboardGeral';
import apiClient from '../../config/apiClient';
import { API_ENDPOINTS, LOCAL_STORAGE_KEYS } from '../../config/config';

// Fase 2 do Painel Geral: carregamento/erro/retry, filtro por equipe, proximas entregas,
// indicadores novos, tema do grafico e sino. A API e simulada e a data do sistema e fixa.

vi.mock('../../config/apiClient', () => ({
  __esModule: true,
  default: { get: vi.fn() },
  getFullApiUrl: (path = '') => (path.startsWith('http') ? path : `http://api.test${path}`),
}));

const grafico = vi.hoisted(() => ({ props: null }));
vi.mock('react-chartjs-2', async () => {
  const { createElement } = await vi.importActual('react');
  return {
    Bar: (props) => {
      grafico.props = props;
      return createElement('div', { 'data-testid': 'grafico-status' });
    },
  };
});

// 17/11/2026 as 10h no horario local. As entregas vem como a API devolve: meia-noite UTC.
const AGORA = new Date(2026, 10, 17, 10, 0, 0);
const entrega = (dia) => `${dia}T00:00:00.000Z`;

const equipe = (id, nome) => ({ _id: id, nome, membros: [] });
const tarefa = (id, equipeId, status, dia, tempoGasto = 0, descricao = `Tarefa ${id}`) => ({
  _id: id,
  descricao,
  status,
  tempoGasto,
  dataEntrega: entrega(dia),
  equipe: { _id: equipeId, nome: { a: 'Alfa', b: 'Beta', c: 'Gama sem tarefas' }[equipeId] || equipeId },
});

const dadosPadrao = () => ({
  equipes: [equipe('b', 'Beta'), equipe('c', 'Gama sem tarefas'), equipe('a', 'Alfa')],
  tarefas: [
    tarefa('a1', 'a', 'concluido', '2026-11-10', 120),
    tarefa('a2', 'a', 'pendente', '2026-11-16', 6),
    tarefa('b1', 'b', 'em_andamento', '2026-11-17', 500),
    tarefa('b2', 'b', 'pendente', '2026-11-18', 0),
    tarefa('b3', 'b', 'pendente', '2026-11-25', 20),
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

const pedidos = (url) => apiClient.get.mock.calls.filter(([pedido]) => pedido === url).length;
const kpi = (chave) => document.querySelector(`[data-indicador="${chave}"]`);
const valor = (chave) => kpi(chave).querySelector('.kpi-valor').textContent;
const detalhe = (chave) => kpi(chave).querySelector('.kpi-detalhe').textContent;
const valores = () => ['equipes', 'tarefas', 'concluidas', 'atrasadas', 'tempo'].map(valor);
const seletor = () => screen.getByLabelText('Equipe');
const escolher = (id) => fireEvent.change(seletor(), { target: { value: id } });
const painelRanking = () => screen.getByRole('region', { name: /Ranking de Equipes|Atividade das Equipes/ });
const nomesRanking = () => [...painelRanking().querySelectorAll('.ranking-nome')].map((n) => n.textContent);
const painelEntregas = () => screen.getByRole('region', { name: 'Próximas entregas' });
const entregas = () => [...painelEntregas().querySelectorAll('.entrega-item')];
const descricoesEntregas = () => entregas().map((li) => li.querySelector('.entrega-descricao').textContent);
const deixarAssentar = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)); });

const abrir = () => render(
  <MemoryRouter initialEntries={['/admin/geral']}>
    <DashboardGeral />
  </MemoryRouter>,
);
const esperarPronto = () => screen.findByRole('heading', { name: 'Visão Geral de Produtividade' });
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
  document.documentElement.style.removeProperty('--text-secondary');
  document.documentElement.style.removeProperty('--border-color');
});

describe('carregamento, erro e nova tentativa', () => {
  test('enquanto equipes e tarefas carregam, nenhum zero aparece como resultado', async () => {
    const equipesAdiadas = adiado();
    const tarefasAdiadas = adiado();
    responder({ equipes: () => equipesAdiadas.promise, tarefas: () => tarefasAdiadas.promise });
    abrir();

    await waitFor(() => expect(pedidos(API_ENDPOINTS.TAREFAS)).toBe(1));
    expect(valores()).toEqual(['—', '—', '—', '—', '—']);
    expect(screen.getByRole('region', { name: 'Indicadores' })).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByRole('status')).toHaveTextContent('Carregando dados do painel…');
    expect(seletor()).toBeDisabled();
    expect(screen.queryByRole('heading', { name: 'Visão Geral de Produtividade' })).toBeNull();
    expect(document.body.textContent).not.toMatch(/\b0m\b|0min/);

    const dados = dadosPadrao();
    await act(async () => {
      equipesAdiadas.resolve(dados.equipes);
      tarefasAdiadas.resolve(dados.tarefas);
    });

    await esperarPronto();
    expect(valores()).toEqual(['3', '5', '1', '1', '10h 46min']);
    expect(seletor()).toBeEnabled();
  });

  test('falha nas tarefas: avisa, nao mostra indicadores e "Tentar novamente" busca de novo, sem loop', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    responder({ ...dadosPadrao(), tarefas: new Error('Network Error') });
    abrir();

    const alerta = await screen.findByRole('alert');
    expect(alerta).toHaveTextContent('Não foi possível carregar os dados do painel.');
    expect(document.querySelector('.kpi-valor')).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Visão Geral de Produtividade' })).toBeNull();

    await deixarAssentar();
    expect(pedidos(API_ENDPOINTS.EQUIPES)).toBe(1);
    expect(pedidos(API_ENDPOINTS.TAREFAS)).toBe(1);

    responder(dadosPadrao());
    fireEvent.click(within(alerta).getByRole('button', { name: 'Tentar novamente' }));

    await esperarPronto();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(valores()).toEqual(['3', '5', '1', '1', '10h 46min']);
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
    expect(valores()).toEqual(['3', '5', '1', '1', '10h 46min']);
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
    // A resposta tardia (cancelada) nao vira erro do painel nem dispara nova busca.
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
    expect(valores()).toEqual(['3', '5', '1', '1', '10h 46min']);

    const novas = [...dadosPadrao().tarefas, tarefa('a3', 'a', 'pendente', '2026-11-20', 30)];
    await act(async () => { tarefasAdiadas.resolve(novas); });

    await waitFor(() => expect(valor('tarefas')).toBe('6'));
    expect(valor('tempo')).toBe('11h 16min');
    expect(screen.getByRole('button', { name: /Atualizar/ })).toBeEnabled();
  });
});

describe('indicadores', () => {
  test('cinco indicadores com rotulos, valores e detalhes', async () => {
    await abrirPronto();

    const cartoes = [...document.querySelectorAll('[data-indicador]')].map((cartao) => [
      cartao.querySelector('h3').textContent,
      cartao.querySelector('.kpi-valor').textContent,
      cartao.querySelector('.kpi-detalhe').textContent,
    ]);
    expect(cartoes).toEqual([
      ['Equipes Vinculadas', '3', '2 com tarefas'],
      ['Total de Tarefas', '5', '4 em aberto'],
      ['Tarefas Concluídas', '1', '20% do total'],
      ['Tarefas Atrasadas', '1', 'prazo vencido'],
      ['Tempo Investido', '10h 46min', '646 min registrados'],
    ]);
    expect(screen.queryByText('Equipes Operando')).toBeNull();
  });

  test('nenhuma equipe: zeros reais depois de carregar e estados vazios em cada painel', async () => {
    await abrirPronto({ equipes: [], tarefas: [] });

    expect(valores()).toEqual(['0', '0', '0', '0', '0min']);
    expect(screen.getByText('Nenhuma tarefa nas suas equipes.')).toBeInTheDocument();
    expect(screen.queryByTestId('grafico-status')).toBeNull();
    expect(within(painelEntregas()).getByText('Nenhuma tarefa em aberto.')).toBeInTheDocument();
    expect(within(painelRanking()).getByText('Nenhuma equipe cadastrada.')).toBeInTheDocument();
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
  });

  test('escolher uma equipe atualiza indicadores, grafico, ranking e entregas juntos, sem nova requisicao', async () => {
    await abrirPronto();
    const antes = apiClient.get.mock.calls.length;

    escolher('b');

    expect(seletor()).toHaveValue('b');
    expect(valores()).toEqual(['1', '3', '0', '0', '8h 40min']);
    expect(detalhe('equipes')).toBe('de 3 vinculadas');
    expect(grafico.props.data.datasets[0].data).toEqual([2, 1, 0]);
    expect(nomesRanking()).toEqual(['Beta']);
    expect(descricoesEntregas()).toEqual(['Tarefa b1', 'Tarefa b2', 'Tarefa b3']);

    escolher('a');

    expect(valores()).toEqual(['1', '2', '1', '1', '2h 6min']);
    expect(grafico.props.data.datasets[0].data).toEqual([1, 0, 1]);
    expect(nomesRanking()).toEqual(['Alfa']);
    expect(descricoesEntregas()).toEqual(['Tarefa a2']);

    escolher('');

    expect(valores()).toEqual(['3', '5', '1', '1', '10h 46min']);
    expect(grafico.props.data.datasets[0].data).toEqual([3, 1, 1]);
    expect(nomesRanking()).toEqual(['Alfa', 'Beta']);
    expect(apiClient.get.mock.calls.length).toBe(antes);
  });

  test('equipe sem tarefas: zeros reais e estados vazios, sem grafico', async () => {
    await abrirPronto();

    escolher('c');

    expect(valores()).toEqual(['1', '0', '0', '0', '0min']);
    expect(screen.getByText('Esta equipe ainda não tem tarefas.')).toBeInTheDocument();
    expect(screen.queryByTestId('grafico-status')).toBeNull();
    expect(within(painelEntregas()).getByText('Nenhuma tarefa em aberto nesta equipe.')).toBeInTheDocument();
    // Ranking: o nome da equipe direto, sem "Ver todas (1)" nem resumo de equipes sem tarefas.
    expect(painelRanking().querySelector('.ranking-vazio')).toHaveTextContent('Gama sem tarefas ainda não tem tarefas.');
    expect(within(painelRanking()).queryByRole('button')).toBeNull();
    expect(painelRanking()).not.toHaveTextContent('equipe sem tarefas');
  });

  test('valor fora do escopo da API e ignorado: continua mostrando todas as equipes', async () => {
    await abrirPronto();

    escolher('equipe-de-outro-admin');

    expect(seletor()).toHaveValue('');
    expect(valores()).toEqual(['3', '5', '1', '1', '10h 46min']);
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
    expect(valores()).toEqual(['2', '2', '1', '1', '2h 6min']);

    escolher('a');
    expect(screen.queryByText(/não está mais disponível/)).toBeNull();
  });
});

describe('proximas entregas', () => {
  const tarefasDeEntrega = () => [
    tarefa('t1', 'b', 'pendente', '2026-11-30', 0, 'Relatório final'),
    tarefa('t2', 'a', 'concluido', '2026-11-01', 0, 'Concluída antiga'),
    tarefa('t3', 'a', 'em_andamento', '2026-11-16', 0, 'Revisar API'),
    tarefa('t4', 'b', 'pendente', '2026-11-18', 0, 'Testes do app'),
    tarefa('t5', 'a', 'pendente', '2026-11-17', 0, 'Deploy de homologação'),
    tarefa('t6', 'b', 'pendente', '2026-11-12', 0, 'Corrigir login'),
    tarefa('t7', 'a', 'pendente', '2026-11-21', 0, 'Documentação'),
    tarefa('t8', 'b', 'pendente', '2026-12-05', 0, 'Apresentação'),
  ];

  test('ate 5 nao concluidas por prazo, atrasadas marcadas e datas sem deslocamento de fuso', async () => {
    await abrirPronto({ equipes: [equipe('a', 'Alfa'), equipe('b', 'Beta')], tarefas: tarefasDeEntrega() });

    const linhas = entregas().map((li) => ({
      descricao: li.querySelector('.entrega-descricao').textContent,
      equipe: li.querySelector('.entrega-equipe').textContent,
      data: li.querySelector('time').textContent,
      dia: li.querySelector('time').getAttribute('datetime'),
      prazo: li.querySelector('.entrega-relativo').textContent,
      selo: li.querySelector('.entrega-selo')?.textContent ?? null,
    }));
    expect(linhas).toEqual([
      { descricao: 'Corrigir login', equipe: 'Beta', data: '12/11/2026', dia: '2026-11-12', prazo: 'Venceu há 5 dias', selo: 'Atrasada' },
      { descricao: 'Revisar API', equipe: 'Alfa', data: '16/11/2026', dia: '2026-11-16', prazo: 'Venceu ontem', selo: 'Atrasada' },
      { descricao: 'Deploy de homologação', equipe: 'Alfa', data: '17/11/2026', dia: '2026-11-17', prazo: 'Vence hoje', selo: null },
      { descricao: 'Testes do app', equipe: 'Beta', data: '18/11/2026', dia: '2026-11-18', prazo: 'Vence amanhã', selo: null },
      { descricao: 'Documentação', equipe: 'Alfa', data: '21/11/2026', dia: '2026-11-21', prazo: 'Vence em 4 dias', selo: null },
    ]);
    expect(entregas()[0]).toHaveClass('is-atrasada');
    expect(entregas()[2]).toHaveClass('is-hoje');
    expect(entregas()[2]).not.toHaveClass('is-atrasada');

    const resumo = painelEntregas().querySelector('.entregas-resumo');
    expect(resumo).toHaveTextContent('Mostrando 5 de 7 tarefas não concluídas.');
    expect(within(resumo).getByRole('link', { name: 'Ver tarefas' })).toHaveAttribute('href', '/admin/tarefas');
    expect(valor('atrasadas')).toBe('2');
  });

  test('so tarefas concluidas: estado vazio, sem resumo', async () => {
    await abrirPronto({ equipes: [equipe('a', 'Alfa')], tarefas: [tarefa('t1', 'a', 'concluido', '2026-11-16')] });

    expect(within(painelEntregas()).getByText('Nenhuma tarefa em aberto.')).toBeInTheDocument();
    expect(painelEntregas().querySelector('.entregas-resumo')).toBeNull();
    expect(valor('atrasadas')).toBe('0');
  });
});

describe('tema, sino e limpeza', () => {
  test('eixos do grafico usam as variaveis do tema e acompanham a troca de tema', async () => {
    await abrirPronto();

    const { x, y } = grafico.props.options.scales;
    expect([x.ticks.color, y.ticks.color, y.title.color]).toEqual(['#b0bec5', '#b0bec5', '#b0bec5']);
    expect(x.ticks.color).not.toBe('#fff');

    act(() => {
      document.documentElement.style.setProperty('--text-secondary', 'rgb(90, 97, 117)');
      document.documentElement.style.setProperty('--border-color', 'rgba(0, 0, 0, 0.1)');
      document.documentElement.setAttribute('data-theme', 'light');
    });

    await waitFor(() => expect(grafico.props.options.scales.x.ticks.color).toBe('rgb(90, 97, 117)'));
    const escalas = grafico.props.options.scales;
    expect([escalas.y.ticks.color, escalas.y.title.color]).toEqual(['rgb(90, 97, 117)', 'rgb(90, 97, 117)']);
    expect([escalas.x.grid.color, escalas.y.grid.color]).toEqual(['rgba(0, 0, 0, 0.1)', 'rgba(0, 0, 0, 0.1)']);
  });

  test('sino sem cor fixa: usa as classes do tema e mostra o contador', async () => {
    await abrirPronto({ ...dadosPadrao(), notificacoes: { count: 3 } });

    const sino = screen.getByRole('link', { name: 'Ver notificações' });
    expect(sino).toHaveClass('notification-bell');
    expect(sino).not.toHaveAttribute('style');
    await waitFor(() => expect(sino.querySelector('.notification-badge')).toHaveTextContent('3'));
    expect(sino.querySelector('.notification-badge')).not.toHaveAttribute('style');
  });

  test('busca inoperante removida e Chart.js so com o necessario (sem Arc nem Legend)', async () => {
    await abrirPronto();

    expect(screen.queryByPlaceholderText('Pesquisar painéis...')).toBeNull();
    expect(Chart.registry.elements.get('bar')).toBeDefined();
    expect(Chart.registry.elements.get('arc')).toBeUndefined();
    expect(Chart.registry.plugins.get('legend')).toBeUndefined();
    expect(grafico.props.options.plugins.legend).toEqual({ display: false });
  });
});
