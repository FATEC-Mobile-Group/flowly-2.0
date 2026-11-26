// Insights inteligentes (PR #64): estados, filtros na URL, abas sem consulta, respostas fora de ordem, API antiga,
// respostas incompletas, graficos, recomendacoes, equipes, moderacao, alertas e alerta aberto por notificacao.
// API simulada (contrato versao 2 do backend), nenhum dado real.
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import InsightsAdmin, { AVISO_EQUIPE_INDISPONIVEL } from './InsightsAdmin';
import { AVISO_LEGADO } from './InsightsLegado';
import { API_ENDPOINTS } from '../../../config/config';

const { apiGet } = vi.hoisted(() => ({ apiGet: vi.fn() }));
vi.mock('../../../config/apiClient', () => ({
  __esModule: true,
  default: { get: apiGet },
  getFullApiUrl: (caminho = '') => caminho,
}));
vi.mock('../../../components/layout/Sidebar', () => ({ __esModule: true, default: () => null }));

const grafico = vi.hoisted(() => ({ chamadas: [] }));
vi.mock('react-chartjs-2', async () => {
  const { createElement } = await vi.importActual('react');
  return {
    Line: (props) => {
      grafico.chamadas.push(props);
      return createElement('div', { 'data-testid': 'grafico-linhas' });
    },
  };
});

const oid = (n) => n.toString(16).padStart(24, '0');
const ALFA = oid(11);
const BETA = oid(12);
const GAMA = oid(13);
const NOME_BETA = 'Beta Desenvolvimento de Sistemas Integrados da Fatec com Nome Muito Extenso';
const DIAS = ['2026-11-19', '2026-11-20', '2026-11-21', '2026-11-22', '2026-11-23', '2026-11-24', '2026-11-25'];

const periodo = (dias = 7) => ({
  dias, fusoHorario: 'America/Sao_Paulo', primeiroDia: dias === 7 ? '2026-11-19' : dias === 14 ? '2026-11-12' : '2026-10-27',
  ultimoDia: '2026-11-25', inicio: '2026-11-19T03:00:00.000Z', fim: '2026-11-25T15:00:00.000Z',
});
const contagem = (valores = {}) => ({
  registros: 0, chat: 0, bloqueadas: 0, ajuda: 0, assistente: 0, origemDesconhecida: 0, indiciosSpam: 0, sinaisColetivos: 0, ...valores,
});
const semAlertas = () => ({ individuais: 0, coletivos: 0, historicos: 0, total: 0 });
const semModeracao = () => ({ profanity: 0, insult: 0, threat: 0, hate: 0, sem_categoria: 0 });
const EQUIPES = [
  { id: ALFA, nome: 'Alfa', participa: true },
  { id: BETA, nome: NOME_BETA, participa: false },
  { id: GAMA, nome: 'Gama', participa: true },
];

const alerta = (n, campos = {}) => ({
  id: oid(500 + n),
  vinculo: 'confiavel',
  data: '2026-11-24T20:00:00.000Z',
  equipe: { id: ALFA, nome: 'Alfa' },
  escopo: 'coletivo',
  gravidade: { codigo: 'medium', rotulo: 'Moderado' },
  categoria: { codigo: 'apoio', rotulo: 'Necessidade de apoio' },
  ocorrencias: null,
  motivos: ['Pedidos de ajuda recorrentes na equipe'],
  colaborador: null,
  ...campos,
});
const ALERTAS = () => [
  alerta(1, {
    data: '2026-11-25T10:00:01.000Z', equipe: { id: BETA, nome: NOME_BETA }, escopo: 'individual', gravidade: { codigo: 'high', rotulo: 'Alto' },
    categoria: { codigo: 'hate', rotulo: 'Discurso de ódio ou discriminação' }, ocorrencias: 2,
    motivos: ['Mensagem bloqueada pela moderação', 'Bloqueio por discurso de ódio ou discriminação'], colaborador: { id: oid(3), nome: 'Bruno' },
  }),
  alerta(2, { data: '2026-11-25T02:30:01.000Z', categoria: { codigo: 'conflito', rotulo: 'Possível conflito na conversa' } }),
  alerta(3, {
    equipe: { id: BETA, nome: NOME_BETA }, escopo: 'historico', gravidade: { codigo: 'high', rotulo: 'Alto' },
    categoria: { codigo: 'historico', rotulo: 'Registro histórico sem classificação confiável' }, motivos: [],
  }),
  alerta(4, {
    data: '2026-11-23T13:00:01.000Z', escopo: 'individual', gravidade: { codigo: 'high', rotulo: 'Alto' },
    categoria: { codigo: 'threat', rotulo: 'Ameaça' }, ocorrencias: 1, colaborador: { id: oid(2), nome: 'Ana' },
  }),
];

const recomendacao = (tipo, equipe, quantidade, evidencia, aba) => ({
  chave: `${tipo}:${equipe.id}`, tipo, origem: 'regra_automatica', equipe, periodo: periodo(), quantidade,
  situacao: `Situação ${tipo}`, evidencia, acao: `Ação para ${tipo}.`, destino: { aba, equipe: equipe.id },
});

const insightsV2 = () => ({
  versao: 2,
  geradoEm: '2026-11-25T15:00:00.000Z',
  periodo: { ...periodo(), diasCalendario: DIAS },
  filtros: { equipe: null, periodo: 7 },
  equipeSolicitada: null,
  equipes: EQUIPES,
  limites: { registrosParciais: false, alertasParciais: false, alertasExibidos: 4, limiteAlertas: 100, limiteModeracaoRecentes: 20 },
  totais: {
    ...contagem({ registros: 13, chat: 5, bloqueadas: 5, ajuda: 2, assistente: 2, origemDesconhecida: 1, indiciosSpam: 1, sinaisColetivos: 1 }),
    equipesComRegistros: 2, equipesComAlertas: 2, alertas: { individuais: 2, coletivos: 1, historicos: 1, total: 4 },
  },
  evolucao: {
    dias: DIAS,
    series: { chat: [1, 1, 0, 0, 0, 3, 0], bloqueadas: [0, 0, 0, 1, 2, 1, 1], ajuda: [0, 0, 0, 0, 0, 2, 0], assistente: [0, 0, 1, 1, 0, 0, 0] },
  },
  porEquipe: [
    {
      equipe: EQUIPES[0], ...contagem({ registros: 10, chat: 4, bloqueadas: 3, ajuda: 2, assistente: 2, origemDesconhecida: 1, indiciosSpam: 1, sinaisColetivos: 1 }),
      moderacao: { ...semModeracao(), profanity: 1, threat: 1, sem_categoria: 1 }, alertas: { individuais: 1, coletivos: 1, historicos: 0, total: 2 },
      assuntos: [{ codigo: 'tarefas', rotulo: 'Tarefas', total: 2 }, { codigo: 'equipes', rotulo: 'Equipes', total: 1 }],
    },
    {
      equipe: EQUIPES[1], ...contagem({ registros: 3, chat: 1, bloqueadas: 2 }),
      moderacao: { ...semModeracao(), insult: 1, hate: 1 }, alertas: { individuais: 1, coletivos: 0, historicos: 1, total: 2 }, assuntos: [],
    },
    { equipe: EQUIPES[2], ...contagem(), moderacao: semModeracao(), alertas: semAlertas(), assuntos: [] },
  ],
  moderacao: {
    total: 5,
    indiciosSpam: 1,
    porCategoria: [
      { codigo: 'profanity', rotulo: 'Linguagem inadequada (palavrão)', total: 1 },
      { codigo: 'insult', rotulo: 'Ofensa direcionada (insulto)', total: 1 },
      { codigo: 'threat', rotulo: 'Ameaça', total: 1 },
      { codigo: 'hate', rotulo: 'Discurso de ódio ou discriminação', total: 1 },
      { codigo: 'sem_categoria', rotulo: 'Sem categoria registrada', total: 1 },
    ],
    recentes: [{
      id: oid(1014), data: '2026-11-25T10:00:00.000Z', equipe: { id: BETA, nome: NOME_BETA },
      categoria: { codigo: 'hate', rotulo: 'Discurso de ódio ou discriminação' }, grave: true, gravidade: { codigo: 'high', rotulo: 'Alto' },
    }],
  },
  alertas: { total: 4, itens: ALERTAS() },
  ocorrenciaSolicitada: null,
  recomendacoes: [
    recomendacao('moderacao_grave', EQUIPES[0], 1, 'Foi registrado 1 bloqueio por ameaça ou discurso de ódio nesta equipe.', 'alertas'),
    recomendacao('moderacao_grave', EQUIPES[1], 1, 'Foi registrado 1 bloqueio por ameaça ou discurso de ódio nesta equipe.', 'alertas'),
    recomendacao('alertas_individuais', EQUIPES[0], 1, 'Foi registrado 1 alerta individual no período.', 'alertas'),
    recomendacao('alertas_coletivos', EQUIPES[0], 1, 'Foi registrado 1 alerta coletivo no período.', 'alertas'),
    recomendacao('moderacao_recorrente', EQUIPES[0], 3, 'Foram registradas 3 ocorrências de moderação nesta equipe.', 'moderacao'),
    recomendacao('ajuda', EQUIPES[0], 2, 'Esta equipe apresentou 2 solicitações explícitas de ajuda no período.', 'equipes'),
  ],
});
const respostaV2 = (insights = insightsV2()) => ({ success: true, versao: 2, insights });
// Como o backend: periodo e equipe da resposta sao os da consulta (o fallback de equipe so com equipeSolicitada).
// `literal: true` desliga o ajuste, para os testes de resposta que nao corresponde a consulta.
const ajustarAoPedido = (corpo, params = {}) => {
  if (!corpo || corpo.versao !== 2 || corpo.literal || !corpo.insights?.periodo) return corpo;
  const insights = { ...corpo.insights };
  insights.periodo = { ...insights.periodo, ...periodo(params.periodo), diasCalendario: insights.periodo.diasCalendario };
  insights.filtros = { periodo: params.periodo, equipe: insights.equipeSolicitada ? null : params.equipe || null };
  return { ...corpo, insights };
};

// Cada resposta pode ser um valor, um Error (rejeita) ou uma funcao (recebe a config e devolve valor ou Promise).
let respostas;
const responder = async (valor, config) => {
  const resultado = typeof valor === 'function' ? await valor(config) : valor;
  if (resultado instanceof Error) throw resultado;
  return { data: resultado };
};
const adiado = () => {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};

const pedidos = () => apiGet.mock.calls.filter(([url]) => url === API_ENDPOINTS.ADMIN_ASSISTANT_INSIGHTS);
const parametros = () => pedidos().map(([, config]) => config.params);

function Sonda() {
  const location = useLocation();
  return <p data-testid="local">{`${location.pathname}${location.search}|${JSON.stringify(location.state ?? null)}`}</p>;
}

function Navegar() {
  const navigate = useNavigate();
  return (
    <>
      <button type="button" onClick={() => navigate('/admin/insights?periodo=14')}>ir para 14 dias</button>
      <button type="button" onClick={() => navigate('/admin/insights?periodo=30')}>ir para 30 dias</button>
    </>
  );
}

const renderPage = (entrada = '/admin/insights') => render(
  <MemoryRouter initialEntries={[entrada]}>
    <Routes>
      <Route path="/admin/insights" element={<><InsightsAdmin /><Sonda /><Navegar /></>} />
      <Route path="*" element={<Sonda />} />
    </Routes>
  </MemoryRouter>,
);
const local = () => screen.getByTestId('local').textContent;
const busca = () => new URLSearchParams(local().split('|')[0].split('?')[1] || '');
const esperarPronto = () => screen.findByText(/Todas as suas equipes|Equipe /, { selector: '.painel-escopo' });
const indicador = (chave) => document.querySelector(`[data-indicador="${chave}"]`);
const valorDe = (chave) => indicador(chave)?.querySelector('.kpi-valor')?.textContent;
const aba = (nome) => screen.getByRole('tab', { name: nome });
const painel = () => screen.getByRole('tabpanel');

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('nome', 'Admin Teste');
  grafico.chamadas = [];
  respostas = { insights: respostaV2(), notificacoes: { count: 3 } };
  apiGet.mockReset();
  apiGet.mockImplementation((url, config) => {
    if (url === API_ENDPOINTS.ADMIN_ASSISTANT_INSIGHTS) return responder(respostas.insights, config).then((res) => ({ data: ajustarAoPedido(res.data, config.params) }));
    if (url === API_ENDPOINTS.NOTIFICATIONS_COUNT) return responder(respostas.notificacoes, config);
    return Promise.reject(new Error(`URL inesperada: ${url}`));
  });
});

describe('carregamento, estados e contrato', () => {
  test('carregando sem zeros; depois os indicadores, com a origem dos registros', async () => {
    const pendente = adiado();
    respostas.insights = () => pendente.promise;
    renderPage();
    expect(screen.getByRole('heading', { name: 'Insights inteligentes' })).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Carregando Insights…');
    expect(document.querySelectorAll('.kpi-card')).toHaveLength(0);
    expect(screen.getByLabelText('Período')).toBeDisabled();

    await act(async () => pendente.resolve(respostaV2()));
    await esperarPronto();
    expect(valorDe('registros')).toBe('13');
    expect(valorDe('chat')).toBe('5');
    expect(valorDe('bloqueadas')).toBe('5');
    expect(valorDe('ajuda')).toBe('2');
    expect(valorDe('equipesComAlertas')).toBe('2 de 3');
    expect(valorDe('assistente')).toBe('2');
    expect(indicador('ajuda')).toHaveTextContent('Sinais de necessidade de ajuda');
    expect(indicador('ajuda')).toHaveTextContent('não confirma dificuldades');
    expect(screen.getByLabelText('Origem dos registros de comunicação'))
      .toHaveTextContent('Chat 5Moderação 5Assistente 2Origem desconhecida ou histórica 1');
    expect(screen.getByText('Todas as suas equipes · Últimos 7 dias (19/11 a 25/11)')).toBeInTheDocument();
    expect(parametros()).toEqual([{ versao: 2, periodo: 7 }]);
    expect(pedidos()[0][1].signal).toBeInstanceOf(AbortSignal);
    expect(screen.getByLabelText('Ver notificações')).toHaveTextContent('3');
  });

  test('erro de rede: mensagem, nenhum numero e tentar novamente', async () => {
    respostas.insights = new Error('Network Error');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    renderPage();
    expect(await screen.findByRole('alert')).toHaveTextContent('Não foi possível carregar os Insights.');
    expect(document.querySelectorAll('.kpi-card')).toHaveLength(0);
    respostas.insights = respostaV2();
    fireEvent.click(screen.getByRole('button', { name: 'Tentar novamente' }));
    await esperarPronto();
    expect(valorDe('registros')).toBe('13');
    expect(pedidos()).toHaveLength(2);
  });

  test('403 da API: acesso restrito, sem tentar de novo', async () => {
    respostas.insights = Object.assign(new Error('Forbidden'), { response: { status: 403 } });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    renderPage();
    expect(await screen.findByRole('alert')).toHaveTextContent('Você não tem permissão para ver estes Insights.');
    expect(screen.queryByRole('button', { name: 'Tentar novamente' })).toBeNull();
  });

  test('Atualizar consulta de novo; se falhar, os dados ficam com o aviso da falha', async () => {
    renderPage();
    await esperarPronto();
    respostas.insights = new Error('Network Error');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    fireEvent.click(screen.getByRole('button', { name: 'Atualizar' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/^Não foi possível atualizar\. Exibindo os dados carregados em /);
    expect(valorDe('registros')).toBe('13');
    expect(pedidos()).toHaveLength(2);
  });

  test('respostas fora de ordem: so a da consulta atual e aplicada, e a anterior e cancelada', async () => {
    renderPage();
    await esperarPronto();
    // Durante o carregamento os seletores ficam travados: a troca no meio da consulta vem pela URL
    // (voltar/avancar do navegador ou um link).
    const segunda = adiado();
    respostas.insights = () => segunda.promise;
    fireEvent.click(screen.getByRole('button', { name: 'ir para 14 dias' }));
    await waitFor(() => expect(pedidos()).toHaveLength(2));
    const terceira = adiado();
    respostas.insights = () => terceira.promise;
    fireEvent.click(screen.getByRole('button', { name: 'ir para 30 dias' }));
    await waitFor(() => expect(pedidos()).toHaveLength(3));
    expect(pedidos()[1][1].signal.aborted).toBe(true);
    expect(pedidos()[2][1].signal.aborted).toBe(false);

    const nova = insightsV2();
    nova.periodo = { ...periodo(30), diasCalendario: DIAS };
    nova.totais.registros = 99;
    await act(async () => terceira.resolve(respostaV2(nova)));
    const antiga = insightsV2();
    antiga.periodo = { ...periodo(14), diasCalendario: DIAS };
    antiga.totais.registros = 55;
    await act(async () => segunda.resolve(respostaV2(antiga)));
    expect(valorDe('registros')).toBe('99');
    expect(screen.getByText(/Últimos 30 dias/, { selector: '.painel-escopo' })).toBeInTheDocument();
    expect(parametros().map((item) => item.periodo)).toEqual([7, 14, 30]);
  });

  test('resposta incompleta: o que falta aparece como indisponivel, nunca como zero', async () => {
    const incompleta = insightsV2();
    delete incompleta.totais;
    delete incompleta.evolucao;
    delete incompleta.recomendacoes;
    respostas.insights = respostaV2(incompleta);
    renderPage();
    await esperarPronto();
    ['registros', 'chat', 'bloqueadas', 'ajuda', 'assistente'].forEach((chave) => expect(valorDe(chave)).toBe('—'));
    expect(screen.queryByLabelText('Origem dos registros de comunicação')).toBeNull();
    expect(screen.getByText('A evolução diária não está disponível nesta resposta da API.')).toBeInTheDocument();
    expect(screen.getByText('As recomendações não estão disponíveis nesta resposta da API.')).toBeInTheDocument();
    expect(grafico.chamadas).toHaveLength(0);
  });

  test('formato inesperado (versao 2 sem periodo): erro, sem numeros', async () => {
    respostas.insights = { success: true, versao: 2, insights: { totais: { registros: 3 } } };
    renderPage();
    expect(await screen.findByRole('alert')).toHaveTextContent('A API respondeu em um formato inesperado.');
    expect(document.querySelectorAll('.kpi-card')).toHaveLength(0);
  });
});

describe('API anterior (preview com o backend de producao antigo)', () => {
  const legado = () => ({
    success: true,
    insights: {
      totalMessages: 40,
      sentiments: { positivo: 1, neutro: 30, negativo: 9 },
      topTopics: [{ topic: 'chat', count: 30 }],
      spamAlerts: 7,
      criticalAlerts: 3,
      recent: [{ _id: 'r', content: 'texto bruto antigo', userName: 'Fulano Recente', conflictRisk: 0.8 }],
      byTeam: [{ channelId: ALFA, teamName: 'Alfa', totalMessages: 6 }, { channelId: BETA, teamName: 'Beta', totalMessages: 2 }],
      chatSummaries: [{ channelId: ALFA, teamName: 'Alfa', totalMessages: 6 }, { channelId: BETA, teamName: 'Beta', totalMessages: 2 }],
      chatWindowDays: 7,
      badActors: [{ userName: 'Fulano Reincidente', conflictRisk: 0.9, count: 4 }],
      behaviorWindowDays: 14,
      suggestions: ['Estimule feedbacks mais objetivos: muitas mensagens estão neutras e podem esconder dúvidas.'],
    },
  });

  test('modo legado identificado, sem filtro de periodo e sem dados fingidos', async () => {
    respostas.insights = legado();
    renderPage();
    expect(await screen.findByText(AVISO_LEGADO)).toBeInTheDocument();
    expect(screen.getByLabelText('Período')).toBeDisabled();
    expect(valorDe('legado-registros')).toBe('40');
    expect(indicador('legado-registros')).toHaveTextContent('Todo o histórico, todas as origens');
    expect(screen.getByText('Últimos 7 dias, janela fixa da API anterior')).toBeInTheDocument();
    expect(screen.queryByText(/Últimos 7 dias \(/)).toBeNull();
    const texto = document.body.textContent;
    ['texto bruto antigo', 'Fulano', 'esconder', '%'].forEach((proibido) => expect(texto).not.toContain(proibido));
    expect(screen.getByLabelText('Equipe')).not.toBeDisabled();

    fireEvent.click(aba('Moderação'));
    expect(painel()).toHaveTextContent('A moderação por categoria ainda não está disponível na API em uso.');
    fireEvent.click(aba('Alertas'));
    expect(painel()).toHaveTextContent('A lista de alertas ainda não está disponível na API em uso.');
    expect(pedidos()).toHaveLength(1);
  });

  test('equipe escolhida filtra a lista do resumo anterior', async () => {
    respostas.insights = legado();
    renderPage(`/admin/insights?equipe=${BETA}&aba=equipes`);
    await screen.findByText(AVISO_LEGADO);
    const itens = within(painel()).getAllByRole('listitem');
    expect(itens).toHaveLength(1);
    expect(itens[0]).toHaveTextContent('Beta2');
  });
});

describe('filtros na URL, abas e equipe', () => {
  test('a URL vira os parametros; trocar equipe e periodo consulta de novo; trocar de aba nao', async () => {
    const soAlfa = insightsV2();
    soAlfa.filtros.equipe = ALFA;
    soAlfa.porEquipe = soAlfa.porEquipe.slice(0, 1);
    respostas.insights = respostaV2(soAlfa);
    renderPage(`/admin/insights?equipe=${ALFA}&periodo=14&aba=equipes`);
    expect(await screen.findByText('Equipe', { selector: '.painel-escopo', exact: false })).toHaveTextContent('Equipe Alfa');
    expect(parametros()).toEqual([{ versao: 2, periodo: 14, equipe: ALFA }]);
    expect(aba('Equipes')).toHaveAttribute('aria-selected', 'true');

    fireEvent.click(aba('Moderação'));
    fireEvent.click(aba('Alertas'));
    fireEvent.click(aba('Visão geral'));
    expect(busca().get('aba')).toBeNull();
    expect(pedidos()).toHaveLength(1);

    respostas.insights = respostaV2();
    fireEvent.change(screen.getByLabelText('Período'), { target: { value: '30' } });
    await waitFor(() => expect(pedidos()).toHaveLength(2));
    expect(parametros()[1]).toEqual({ versao: 2, periodo: 30, equipe: ALFA });
    expect(busca().get('periodo')).toBe('30');

    await esperarPronto();
    fireEvent.change(screen.getByLabelText('Equipe'), { target: { value: '' } });
    await waitFor(() => expect(pedidos()).toHaveLength(3));
    expect(parametros()[2]).toEqual({ versao: 2, periodo: 30 });
    expect(busca().get('equipe')).toBeNull();
  });

  test('opcoes de equipe vem da propria resposta, em ordem, com nomes extensos', async () => {
    renderPage();
    await esperarPronto();
    const opcoes = within(screen.getByLabelText('Equipe')).getAllByRole('option').map((opcao) => opcao.textContent);
    expect(opcoes).toEqual(['Todas as equipes', 'Alfa', NOME_BETA, 'Gama']);
  });

  test('teclado nas abas: setas, Home e End', async () => {
    renderPage();
    await esperarPronto();
    aba('Visão geral').focus();
    fireEvent.keyDown(aba('Visão geral'), { key: 'ArrowRight' });
    expect(aba('Equipes')).toHaveAttribute('aria-selected', 'true');
    expect(aba('Equipes')).toHaveFocus();
    fireEvent.keyDown(aba('Equipes'), { key: 'End' });
    expect(aba('Alertas')).toHaveFocus();
    fireEvent.keyDown(aba('Alertas'), { key: 'ArrowRight' });
    expect(aba('Visão geral')).toHaveAttribute('aria-selected', 'true');
    fireEvent.keyDown(aba('Visão geral'), { key: 'ArrowLeft' });
    expect(aba('Alertas')).toHaveAttribute('aria-selected', 'true');
    fireEvent.keyDown(aba('Alertas'), { key: 'Home' });
    expect(aba('Visão geral')).toHaveFocus();
    expect(aba('Alertas')).toHaveAttribute('tabindex', '-1');
    expect(painel()).toHaveAttribute('aria-labelledby', aba('Visão geral').id);
    expect(pedidos()).toHaveLength(1);
  });

  test('equipe fora do escopo: aviso, URL sem a equipe e nenhuma consulta a mais', async () => {
    const todas = insightsV2();
    todas.equipeSolicitada = { id: oid(99), disponivel: false };
    respostas.insights = respostaV2(todas);
    renderPage(`/admin/insights?equipe=${oid(99)}&aba=alertas`);
    expect(await screen.findByText(AVISO_EQUIPE_INDISPONIVEL)).toBeInTheDocument();
    await waitFor(() => expect(busca().get('equipe')).toBeNull());
    expect(busca().get('aba')).toBe('alertas');
    expect(screen.getByLabelText('Equipe')).toHaveValue('');
    expect(pedidos()).toHaveLength(1);
    expect(parametros()[0]).toEqual({ versao: 2, periodo: 7, equipe: oid(99) });
  });

  test('parametros invalidos: ignorados, avisados e fora da consulta', async () => {
    renderPage('/admin/insights?equipe=xyz&periodo=9&aba=foo&ocorrencia=1');
    await esperarPronto();
    expect(screen.getByText('Filtros ignorados por serem inválidos: equipe, período, aba, ocorrência.')).toBeInTheDocument();
    expect(parametros()).toEqual([{ versao: 2, periodo: 7 }]);
    expect(aba('Visão geral')).toHaveAttribute('aria-selected', 'true');
  });
});

describe('visao geral: grafico e recomendacoes', () => {
  test('tres series distinguiveis alem da cor, legenda em texto e tabela por dia', async () => {
    renderPage();
    await esperarPronto();
    const { data, options } = grafico.chamadas.at(-1);
    expect(data.labels).toEqual(['19/11', '20/11', '21/11', '22/11', '23/11', '24/11', '25/11']);
    expect(data.datasets.map((serie) => serie.label)).toEqual(['Mensagens de chat analisadas', 'Mensagens bloqueadas', 'Sinais de necessidade de ajuda']);
    expect(data.datasets.map((serie) => serie.data)).toEqual([[1, 1, 0, 0, 0, 3, 0], [0, 0, 0, 1, 2, 1, 1], [0, 0, 0, 0, 0, 2, 0]]);
    expect(new Set(data.datasets.map((serie) => JSON.stringify(serie.borderDash))).size).toBe(3);
    expect(new Set(data.datasets.map((serie) => serie.pointStyle)).size).toBe(3);
    expect(options.plugins.legend.display).toBe(false);
    const legenda = [...document.querySelectorAll('.insights-legenda li')].map((item) => item.textContent);
    expect(legenda).toEqual(['Mensagens de chat analisadas5', 'Mensagens bloqueadas5', 'Sinais de necessidade de ajuda2']);
    expect(screen.getByText(/Os sinais de necessidade de ajuda são parte das mensagens de chat e vêm de análise textual automática/)).toBeInTheDocument();
    expect(within(document.querySelector('.insights-tabela tbody')).getAllByRole('row')).toHaveLength(7);
  });

  test('periodo sem registros: sem grafico vazio fingido, com os totais zerados da consulta', async () => {
    const vazio = insightsV2();
    vazio.evolucao.series = { chat: [0, 0, 0, 0, 0, 0, 0], bloqueadas: [0, 0, 0, 0, 0, 0, 0], ajuda: [0, 0, 0, 0, 0, 0, 0], assistente: [0, 0, 0, 0, 0, 0, 0] };
    respostas.insights = respostaV2(vazio);
    renderPage();
    await esperarPronto();
    expect(screen.getByText('Nenhum registro destas categorias no período.')).toBeInTheDocument();
    expect(grafico.chamadas).toHaveLength(0);
  });

  test('recomendacoes com situacao, evidencia, equipe, periodo e acao; prioritarias primeiro', async () => {
    renderPage();
    await esperarPronto();
    const lista = document.querySelector('.insights-recomendacoes');
    expect(within(lista).getAllByRole('listitem')).toHaveLength(4);
    const primeira = within(lista).getAllByRole('listitem')[0];
    expect(primeira).toHaveTextContent('Situação moderacao_grave');
    expect(primeira).toHaveTextContent('Foi registrado 1 bloqueio por ameaça ou discurso de ódio nesta equipe.');
    expect(primeira).toHaveTextContent('Equipe Alfa');
    expect(primeira).toHaveTextContent('Últimos 7 dias (19/11 a 25/11)');
    expect(primeira).toHaveTextContent('Ação sugerida: Ação para moderacao_grave.');
    expect(screen.getByText('Sinais automatizados a partir dos registros. Exigem avaliação humana.')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Mostrar todas as 6 recomendações' }));
    expect(within(lista).getAllByRole('listitem')).toHaveLength(6);
    fireEvent.click(within(within(lista).getAllByRole('listitem')[0]).getByRole('link', { name: 'Ver alertas' }));
    expect(busca().get('aba')).toBe('alertas');
    expect(busca().get('equipe')).toBe(ALFA);
  });

  test('sem sinais: a recomendacao honesta, sem equipe', async () => {
    const vazio = insightsV2();
    vazio.recomendacoes = [{
      chave: 'sem_sinais', tipo: 'sem_sinais', equipe: null, quantidade: 0, periodo: periodo(), destino: null,
      situacao: 'Nenhum sinal de acompanhamento',
      evidencia: 'Nenhum sinal de acompanhamento foi registrado no período selecionado.',
      acao: 'A ausência de registros não garante que não existam dificuldades: continue acompanhando as equipes.',
    }];
    respostas.insights = respostaV2(vazio);
    renderPage();
    await esperarPronto();
    const item = document.querySelector('.insights-recomendacao');
    expect(item).toHaveTextContent('Nenhum sinal de acompanhamento foi registrado no período selecionado.');
    expect(item).toHaveTextContent('Todas as equipes consultadas');
    expect(item).toHaveTextContent('não garante');
    expect(within(item).queryByRole('link')).toBeNull();
  });
});

describe('aba Equipes', () => {
  test('dados agregados por equipe, sem ranking, estados e atalhos', async () => {
    renderPage('/admin/insights?aba=equipes');
    await esperarPronto();
    const cartoes = within(painel()).getAllByRole('listitem', { name: /^Equipe / });
    expect(cartoes.map((cartao) => cartao.getAttribute('aria-label'))).toEqual(['Equipe Alfa', `Equipe ${NOME_BETA}`, 'Equipe Gama']);
    const alfa = cartoes[0];
    expect(alfa).toHaveTextContent('Registros10');
    expect(alfa).toHaveTextContent('Sinais de ajuda2');
    expect(screen.getByText(/não confirmam que houve dificuldade real/)).toBeInTheDocument();
    expect(alfa).toHaveTextContent('Tarefas · 2');
    expect(alfa).toHaveTextContent('Equipes · 1');
    expect(alfa).toHaveTextContent('1 individuais');
    expect(cartoes[2]).toHaveTextContent('Nenhum registro de comunicação no período.');
    expect(cartoes[2]).toHaveTextContent('não indica, por si só, baixa atividade');
    expect(screen.getByText(/os totais de assuntos podem se sobrepor/)).toBeInTheDocument();
    expect(painel().textContent).not.toMatch(/melhor|pior|ranking|produtiv/i);

    expect(within(cartoes[1]).queryByRole('link', { name: /Abrir chat/ })).toBeNull();
    fireEvent.click(within(alfa).getByRole('link', { name: 'Ver tarefas da equipe Alfa' }));
    expect(local()).toBe(`/admin/tarefas?equipe=${ALFA}|null`);
  });

  test('chat e insights da equipe', async () => {
    renderPage('/admin/insights?aba=equipes&periodo=14');
    await esperarPronto();
    fireEvent.click(screen.getByRole('link', { name: 'Abrir chat da equipe Gama' }));
    expect(local()).toBe(`/admin/chats|{"equipeId":"${GAMA}"}`);
  });

  test('acoes do cartao: compactas, com icone e as mesmas cores da gestao de Equipes (sem links sublinhados)', async () => {
    renderPage('/admin/insights?aba=equipes');
    await esperarPronto();
    const cartao = within(painel()).getByRole('listitem', { name: 'Equipe Gama' });
    const acoes = cartao.querySelector('.insights-equipe-acoes');
    expect(acoes).toHaveClass('acoes-equipe', 'acoes-equipe--compactas');
    expect(within(cartao).getByRole('link', { name: 'Ver insights da equipe Gama' })).toHaveClass('acao-equipe', 'acao-equipe--insights');
    expect(within(cartao).getByRole('link', { name: 'Ver tarefas da equipe Gama' })).toHaveClass('acao-equipe', 'acao-equipe--tarefas');
    expect(within(cartao).getByRole('link', { name: 'Abrir chat da equipe Gama' })).toHaveClass('acao-equipe', 'acao-equipe--chat');
    expect(cartao.querySelectorAll('.insights-equipe-acoes svg[aria-hidden="true"]')).toHaveLength(3);
    expect(cartao.querySelector('.insights-link')).toBeNull();
  });

  test('insights da equipe mantem o periodo e vai para a visao geral', async () => {
    renderPage('/admin/insights?aba=equipes&periodo=14');
    await esperarPronto();
    fireEvent.click(screen.getByRole('link', { name: 'Ver insights da equipe Alfa' }));
    expect(local()).toBe(`/admin/insights?equipe=${ALFA}&periodo=14|null`);
  });

  test('pesquisa e "somente com registros" sao locais', async () => {
    renderPage('/admin/insights?aba=equipes');
    await esperarPronto();
    fireEvent.change(screen.getByLabelText('Pesquisar equipe'), { target: { value: 'gam' } });
    expect(within(painel()).getAllByRole('listitem', { name: /^Equipe / })).toHaveLength(1);
    fireEvent.change(screen.getByLabelText('Pesquisar equipe'), { target: { value: '' } });
    fireEvent.click(screen.getByLabelText('Somente equipes com registros no período'));
    expect(within(painel()).getAllByRole('listitem', { name: /^Equipe / }).map((item) => item.getAttribute('aria-label')))
      .toEqual(['Equipe Alfa', `Equipe ${NOME_BETA}`]);
    expect(screen.getByText('Exibindo 2 de 3 equipes')).toBeInTheDocument();
    expect(pedidos()).toHaveLength(1);
  });
});

describe('aba Moderacao', () => {
  test('categorias reais, indicios de spam separados e recentes sem conteudo', async () => {
    renderPage('/admin/insights?aba=moderacao');
    await esperarPronto();
    expect(valorDe('bloqueios')).toBe('5');
    expect(valorDe('indiciosSpam')).toBe('1');
    expect(indicador('indiciosSpam')).toHaveTextContent('Não são bloqueios nem spam confirmado.');
    const categorias = [...document.querySelectorAll('.insights-barras li')].map((item) => item.querySelector('.insights-barra-rotulo').textContent);
    expect(categorias).toEqual([
      'Linguagem inadequada (palavrão)1 (20%)', 'Ofensa direcionada (insulto)1 (20%)', 'Ameaça1 (20%)',
      'Discurso de ódio ou discriminação1 (20%)', 'Sem categoria registrada1 (20%)',
    ]);
    expect(screen.getByText(/reúne bloqueios anteriores à classificação por categoria/)).toBeInTheDocument();
    const recentes = screen.getByRole('heading', { name: 'Ocorrências recentes' }).closest('section');
    expect(recentes).toHaveTextContent('Discurso de ódio ou discriminação');
    expect(recentes).toHaveTextContent('Gravidade: Alto');
    expect(recentes).toHaveTextContent('25/11/2026 às 07:00');
    const porEquipe = screen.getByRole('heading', { name: 'Bloqueios por equipe' }).closest('section');
    expect(within(porEquipe).getAllByRole('listitem')).toHaveLength(2);
    expect(porEquipe).toHaveTextContent('Ofensa direcionada (insulto): 1 · Discurso de ódio ou discriminação: 1');
    expect(grafico.chamadas.at(-1).data.datasets.map((serie) => serie.label)).toEqual(['Mensagens bloqueadas']);
  });
});

describe('aba Alertas', () => {
  test('individual com a pessoa; coletivo e historico sem pessoa; gravidade em texto; sem percentual', async () => {
    renderPage('/admin/insights?aba=alertas');
    await esperarPronto();
    const alertas = within(painel()).getAllByRole('article');
    expect(alertas).toHaveLength(4);
    const [odio, coletivo, historico, ameaca] = alertas;
    expect(odio).toHaveTextContent('Individual');
    expect(odio).toHaveTextContent('Gravidade: Alto');
    expect(odio).toHaveTextContent('ParticipanteBruno');
    expect(odio).toHaveTextContent('Bloqueios em 24 horas2 (da mesma pessoa nesta equipe, nas 24 horas até o alerta, incluindo o que o gerou)');
    expect(odio).not.toHaveTextContent('Colaborador');
    expect(odio).toHaveTextContent(`Equipe${NOME_BETA}`);
    expect(coletivo).toHaveTextContent('Coletivo');
    expect(coletivo).toHaveTextContent('Possível conflito na conversa');
    expect(coletivo).not.toHaveTextContent('Participante');
    expect(historico).toHaveTextContent('Histórico sem escopo');
    expect(historico).toHaveTextContent('Motivo registradoNão registrado');
    expect(historico).not.toHaveTextContent('Participante');
    expect(ameaca).toHaveTextContent('ParticipanteAna');
    expect(painel().textContent).not.toContain('%');
    expect(screen.getByLabelText('Alertas emitidos no período por escopo')).toHaveTextContent('2 individuais1 coletivos1 históricos sem escopo1 mensagens');
    expect(screen.getByText(/Sinais detectados na análise nem sempre geram alerta/)).toBeInTheDocument();
    expect(screen.getByText(/As contagens de alertas diferentes podem se sobrepor/)).toHaveTextContent('não some as ocorrências entre alertas');
  });

  test('filtros locais e paginacao de 10, sem consultar a API', async () => {
    const muitos = insightsV2();
    muitos.alertas = {
      total: 130,
      itens: Array.from({ length: 23 }, (_, i) => alerta(10 + i, {
        data: new Date(Date.UTC(2026, 10, 25, 14, 59 - i)).toISOString(),
        gravidade: i % 2 ? { codigo: 'high', rotulo: 'Alto' } : { codigo: 'medium', rotulo: 'Moderado' },
        escopo: i < 3 ? 'individual' : 'coletivo',
        colaborador: i < 3 ? { id: oid(2), nome: 'Ana' } : null,
      })),
    };
    respostas.insights = respostaV2(muitos);
    renderPage('/admin/insights?aba=alertas');
    await esperarPronto();
    expect(within(painel()).getAllByRole('article')).toHaveLength(10);
    expect(screen.getByText('Página 1 de 3')).toBeInTheDocument();
    expect(screen.getByText('Foram carregados os 23 alertas mais recentes de 130 no período.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Próxima' }));
    expect(screen.getByText('Página 2 de 3')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Anterior' })).not.toBeDisabled();

    fireEvent.change(screen.getByLabelText('Escopo'), { target: { value: 'individual' } });
    expect(within(painel()).getAllByRole('article')).toHaveLength(3);
    expect(screen.queryByText(/Página \d de/)).toBeNull();
    fireEvent.change(screen.getByLabelText('Gravidade'), { target: { value: 'high' } });
    expect(within(painel()).getAllByRole('article')).toHaveLength(1);
    expect(screen.getByText('1 de 23 alertas carregados')).toBeInTheDocument();
    // Categorias oferecidas: so as presentes nos alertas carregados.
    expect(within(screen.getByLabelText('Categoria')).getAllByRole('option').map((opcao) => opcao.textContent))
      .toEqual(['Todas', 'Necessidade de apoio']);
    fireEvent.change(screen.getByLabelText('Categoria'), { target: { value: 'apoio' } });
    expect(within(painel()).getAllByRole('article')).toHaveLength(1);
    fireEvent.change(screen.getByLabelText('Escopo'), { target: { value: 'historico' } });
    expect(screen.getByText('Nenhum alerta corresponde aos filtros.')).toBeInTheDocument();
    expect(pedidos()).toHaveLength(1);
  });

  test('sem alertas: estado informativo que nao promete ausencia de problemas', async () => {
    const vazio = insightsV2();
    vazio.alertas = { total: 0, itens: [] };
    respostas.insights = respostaV2(vazio);
    renderPage('/admin/insights?aba=alertas');
    await esperarPronto();
    expect(painel()).toHaveTextContent('Nenhum alerta emitido no período. A ausência de alertas não garante que não existam dificuldades.');
  });
});

describe('alerta aberto pela notificacao', () => {
  const comOcorrencia = (status, item) => {
    const dados = insightsV2();
    dados.filtros.equipe = ALFA;
    dados.ocorrenciaSolicitada = { id: oid(504), status, item };
    return respostaV2(dados);
  };

  test('no periodo: destacado na lista e fixado no topo', async () => {
    respostas.insights = comOcorrencia('no_periodo', ALERTAS()[3]);
    renderPage(`/admin/insights?equipe=${ALFA}&aba=alertas&ocorrencia=${oid(504)}`);
    await esperarPronto();
    expect(parametros()).toEqual([{ versao: 2, periodo: 7, equipe: ALFA, ocorrencia: oid(504) }]);
    expect(screen.getByRole('article', { name: 'Alerta aberto pela notificação' })).toHaveTextContent('Ameaça');
    expect(screen.getByText('Alerta da notificação, destacado na lista abaixo.')).toBeInTheDocument();
    expect(document.querySelectorAll(`.insights-alertas [data-alerta="${oid(504)}"].is-destacado`)).toHaveLength(1);
  });

  test('antiga, fora do periodo: informada com a data, sem fingir que esta no periodo', async () => {
    respostas.insights = comOcorrencia('fora_do_periodo', alerta(4, { data: '2026-11-10T12:00:00.000Z', escopo: 'individual', categoria: { codigo: 'recurrence', rotulo: 'Bloqueios recorrentes' }, colaborador: { nome: 'Ana' } }));
    renderPage(`/admin/insights?equipe=${ALFA}&aba=alertas&ocorrencia=${oid(504)}`);
    await esperarPronto();
    expect(screen.getByText('Alerta da notificação, de 10/11/2026: fora do período selecionado (últimos 7 dias (19/11 a 25/11)).')).toBeInTheDocument();
    expect(screen.getByRole('article', { name: 'Alerta aberto pela notificação' })).toHaveTextContent('Bloqueios recorrentes');
  });

  test('indisponivel (outra equipe ou nao autorizada): so o aviso', async () => {
    respostas.insights = comOcorrencia('indisponivel', null);
    renderPage(`/admin/insights?equipe=${ALFA}&aba=alertas&ocorrencia=${oid(504)}`);
    await esperarPronto();
    expect(screen.getByText(/O alerta indicado na notificação não está disponível/)).toBeInTheDocument();
    expect(screen.queryByRole('article', { name: 'Alerta aberto pela notificação' })).toBeNull();
  });

  test('trocar de equipe descarta a ocorrencia; trocar de periodo mantem', async () => {
    respostas.insights = comOcorrencia('no_periodo', ALERTAS()[3]);
    renderPage(`/admin/insights?equipe=${ALFA}&aba=alertas&ocorrencia=${oid(504)}`);
    await esperarPronto();
    fireEvent.change(screen.getByLabelText('Período'), { target: { value: '14' } });
    expect(busca().get('ocorrencia')).toBe(oid(504));
    await waitFor(() => expect(pedidos()).toHaveLength(2));
    await esperarPronto();
    fireEvent.change(screen.getByLabelText('Equipe'), { target: { value: GAMA } });
    expect(busca().get('ocorrencia')).toBeNull();
    expect(busca().get('aba')).toBe('alertas');
  });
});

// ----------------------------------------------------------------------------------------------------------------
// Ajustes apos revisao (PR #64)
// ----------------------------------------------------------------------------------------------------------------
describe('atualizacao: 401 e 403 tiram os dados; falha temporaria mantem', () => {
  const erroHttp = (status) => Object.assign(new Error(`HTTP ${status}`), { response: { status } });

  test.each([
    [401, 'Sua sessão expirou ou não é mais válida. Entre novamente para ver os Insights.', 'Entrar novamente'],
    [403, 'Você não tem permissão para ver estes Insights.', null],
  ])('%i numa atualizacao: dados removidos e fluxo de erro', async (status, mensagem, acao) => {
    renderPage();
    await esperarPronto();
    expect(valorDe('registros')).toBe('13');
    respostas.insights = erroHttp(status);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    fireEvent.click(screen.getByRole('button', { name: 'Atualizar' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(mensagem);
    expect(document.querySelectorAll('.kpi-card')).toHaveLength(0);
    expect(screen.queryByText(/Não foi possível atualizar/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Tentar novamente' })).toBeNull();
    if (acao) expect(screen.getByRole('link', { name: acao })).toHaveAttribute('href', '/');
  });

  test('503 numa atualizacao: dados mantidos, com aviso e data', async () => {
    renderPage();
    await esperarPronto();
    respostas.insights = erroHttp(503);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    fireEvent.click(screen.getByRole('button', { name: 'Atualizar' }));
    expect(await screen.findByText(/^Não foi possível atualizar\. Exibindo os dados carregados em \d{2}\/\d{2}\/\d{4} às \d{2}:\d{2}\.$/)).toBeInTheDocument();
    expect(valorDe('registros')).toBe('13');
  });
});

describe('a resposta precisa ser da consulta feita', () => {
  test.each([
    ['periodo diferente do pedido', (dados) => { dados.periodo = { ...periodo(14), diasCalendario: DIAS }; dados.filtros = { equipe: null, periodo: 14 }; }, ''],
    ['todas as equipes sem a indicacao de equipe indisponivel', (dados) => { dados.filtros = { equipe: null, periodo: 7 }; }, `?equipe=${ALFA}`],
    ['outra equipe no lugar da pedida', (dados) => { dados.filtros = { equipe: BETA, periodo: 7 }; }, `?equipe=${ALFA}`],
    ['equipe indisponivel indicada sem equipe pedida', (dados) => { dados.equipeSolicitada = { id: ALFA, disponivel: false }; }, ''],
  ])('%s: erro, sem numeros', async (_, alterar, busca) => {
    const dados = insightsV2();
    alterar(dados);
    respostas.insights = { ...respostaV2(dados), literal: true };
    renderPage(`/admin/insights${busca}`);
    expect(await screen.findByRole('alert')).toHaveTextContent('A API respondeu em um formato inesperado.');
    expect(document.querySelectorAll('.kpi-card')).toHaveLength(0);
  });
});

describe('equipe indisponivel na URL', () => {
  test('preserva a aba aberta durante a consulta e descarta a ocorrencia, sem nova consulta', async () => {
    const pendente = adiado();
    respostas.insights = () => pendente.promise;
    renderPage(`/admin/insights?equipe=${oid(99)}&ocorrencia=${oid(504)}`);
    await waitFor(() => expect(pedidos()).toHaveLength(1));
    fireEvent.click(aba('Alertas'));
    expect(busca().get('aba')).toBe('alertas');
    const todas = insightsV2();
    todas.equipeSolicitada = { id: oid(99), disponivel: false };
    todas.ocorrenciaSolicitada = { id: oid(504), status: 'indisponivel', item: null };
    await act(async () => pendente.resolve(respostaV2(todas)));
    expect(await screen.findByText(AVISO_EQUIPE_INDISPONIVEL)).toBeInTheDocument();
    await waitFor(() => expect(busca().get('equipe')).toBeNull());
    expect(busca().get('ocorrencia')).toBeNull();
    expect(busca().get('aba')).toBe('alertas');
    expect(aba('Alertas')).toHaveAttribute('aria-selected', 'true');
    expect(pedidos()).toHaveLength(1);
  });
});

describe('limites de agregacao', () => {
  const nulos = (campos) => Object.fromEntries(campos.map((campo) => [campo, null]));
  const CONTAGEM = ['registros', 'chat', 'bloqueadas', 'ajuda', 'assistente', 'origemDesconhecida', 'indiciosSpam', 'sinaisColetivos'];
  const registrosParciais = () => {
    const dados = insightsV2();
    dados.limites = { ...dados.limites, registrosParciais: true, recomendacoesIndisponiveis: true };
    dados.totais = { ...dados.totais, ...nulos(CONTAGEM), equipesComRegistros: null };
    dados.porEquipe = dados.porEquipe.map((item) => ({ ...item, ...nulos(CONTAGEM), moderacao: nulos(['profanity', 'insult', 'threat', 'hate', 'sem_categoria']) }));
    dados.evolucao = null;
    dados.moderacao = { ...dados.moderacao, total: null, porCategoria: null, indiciosSpam: null };
    dados.recomendacoes = null;
    return dados;
  };

  test('registros acima do limite: aviso em todas as abas e indicadores indisponiveis, nunca zero', async () => {
    respostas.insights = respostaV2(registrosParciais());
    renderPage();
    await esperarPronto();
    const aviso = document.querySelector('[data-limite="registros"]');
    expect(aviso).toHaveTextContent('passou do limite de agregação');
    expect(aviso).toHaveTextContent('Reduza o período ou escolha uma equipe.');
    ['registros', 'chat', 'bloqueadas', 'ajuda', 'assistente'].forEach((chave) => expect(valorDe(chave)).toBe('—'));
    expect(valorDe('equipesComAlertas')).toBe('2 de 3'); // alertas: resultado completo, continua
    expect(screen.getByText('A evolução diária não está disponível nesta resposta da API.')).toBeInTheDocument();
    expect(screen.getByText('As recomendações não estão disponíveis nesta resposta da API.')).toBeInTheDocument();
    expect(screen.queryByText(/Nenhum sinal de acompanhamento/)).toBeNull();

    fireEvent.click(aba('Equipes'));
    expect(document.querySelector('[data-limite="registros"]')).toBeInTheDocument();
    expect(screen.queryByText(/Nenhum registro de comunicação no período/)).toBeNull();
    const gama = screen.getByRole('listitem', { name: 'Equipe Gama' });
    expect(gama).toHaveTextContent('Registros—');

    fireEvent.click(aba('Moderação'));
    expect(valorDe('bloqueios')).toBe('—');
    expect(screen.queryByText('Nenhum bloqueio no período.')).toBeNull();
    expect(screen.queryByText('Nenhuma equipe com bloqueios no período.')).toBeNull();
    expect(screen.getAllByText(/não está disponível/).length).toBeGreaterThanOrEqual(2);
    // Ocorrencias recentes: lista propria, limite intencional, continua.
    expect(screen.getByRole('heading', { name: 'Ocorrências recentes' }).closest('section')).toHaveTextContent('Discurso de ódio ou discriminação');
    expect(pedidos()).toHaveLength(1);
  });

  test('alertas acima do limite: totais indisponiveis e lista dos mais recentes', async () => {
    const dados = insightsV2();
    dados.limites = { ...dados.limites, alertasParciais: true, recomendacoesIndisponiveis: true };
    dados.totais = { ...dados.totais, equipesComAlertas: null, alertas: nulos(['individuais', 'coletivos', 'historicos', 'semVinculo', 'total']) };
    dados.alertas = { total: null, itens: ALERTAS() };
    dados.recomendacoes = null;
    respostas.insights = respostaV2(dados);
    renderPage('/admin/insights?aba=alertas');
    await esperarPronto();
    expect(document.querySelector('[data-limite="alertas"]')).toHaveTextContent('Os totais de alertas e as recomendações ficaram indisponíveis');
    expect(screen.getByLabelText('Alertas emitidos no período por escopo')).toHaveTextContent('— individuais— coletivos— históricos sem escopo');
    expect(screen.getByText('Total do período indisponível. Exibindo os 4 alertas mais recentes.')).toBeInTheDocument();
    fireEvent.click(aba('Visão geral'));
    expect(valorDe('equipesComAlertas')).toBe('—');
    expect(valorDe('registros')).toBe('13');
  });

  test('assuntos acima do limite: so os assuntos ficam indisponiveis', async () => {
    const dados = insightsV2();
    dados.limites = { ...dados.limites, assuntosParciais: true };
    dados.porEquipe = dados.porEquipe.map((item) => ({ ...item, assuntos: null }));
    respostas.insights = respostaV2(dados);
    renderPage('/admin/insights?aba=equipes');
    await esperarPronto();
    expect(document.querySelector('[data-limite="assuntos"]')).toBeInTheDocument();
    expect(screen.getByRole('listitem', { name: 'Equipe Alfa' })).toHaveTextContent('Assuntos identificados:indisponíveis nesta consulta');
    expect(screen.getByRole('listitem', { name: 'Equipe Alfa' })).toHaveTextContent('Registros10');
  });
});

describe('vinculo do alerta com a ocorrencia', () => {
  test('sem vinculo confiavel: sem pessoa, mesmo que a resposta traga, e com o vinculo informado', async () => {
    const dados = insightsV2();
    dados.totais.alertas = { individuais: 2, coletivos: 0, historicos: 0, semVinculo: 2, total: 2 };
    dados.alertas = {
      total: 2,
      itens: [
        alerta(60, { id: null, vinculo: 'ausente', escopo: 'individual', colaborador: { id: oid(2), nome: 'Ana Indevida' } }),
        alerta(61, { id: null, vinculo: 'divergente', escopo: 'individual', colaborador: { id: oid(2), nome: 'Ana Indevida' } }),
      ],
    };
    respostas.insights = respostaV2(dados);
    renderPage('/admin/insights?aba=alertas');
    await esperarPronto();
    const [ausente, divergente] = within(painel()).getAllByRole('article');
    expect(ausente).toHaveTextContent('Vínculo com a ocorrênciaNão registrado');
    expect(divergente).toHaveTextContent('Vínculo com a ocorrênciaIdentificadores divergentes');
    expect(painel().textContent).not.toContain('Ana Indevida');
    expect(screen.getByLabelText('Alertas emitidos no período por escopo')).toHaveTextContent('2 sem vínculo confirmado com a ocorrência');
  });
});

describe('textos revisados', () => {
  test('origem explicada como campo registrado, sem prova de procedencia', async () => {
    renderPage();
    await esperarPronto();
    expect(screen.getByText(/não é uma prova autenticada de procedência/)).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/explícit/i);
  });

  test('legado: registros de chat e moderacao, e total historico de todas as equipes mesmo com equipe escolhida', async () => {
    respostas.insights = {
      success: true,
      insights: { totalMessages: 40, chatWindowDays: 7, byTeam: [{ channelId: ALFA, teamName: 'Alfa', totalMessages: 6 }] },
    };
    renderPage(`/admin/insights?equipe=${ALFA}`);
    await screen.findByText(AVISO_LEGADO);
    expect(screen.getByRole('heading', { name: 'Registros de chat e moderação por equipe' })).toBeInTheDocument();
    expect(indicador('legado-registros')).toHaveTextContent('todas as suas equipes (não filtrado pela equipe selecionada)');
    expect(screen.getByLabelText('Período')).toBeDisabled();
  });
});
