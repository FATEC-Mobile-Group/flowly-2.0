// Central de notificacoes (PR #66): pesquisa, filtros, agrupamento, contador compartilhado (sidebar, sino e central),
// Socket.IO sem duplicatas, navegacao contextual e apresentacao segura dos alertas de moderacao.
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { API_ENDPOINTS } from '../../config/config';
import { authUtils } from '../../config/authUtils';
import NotificationsPage from './NotificationsPage';
import {
  apresentarAlerta,
  apresentarNotificacao,
  filtrarNotificacoes,
  grupoDaData,
  juntarPorId,
  removerPercentualDeRisco,
} from './notificationsUtils';
import { lerNaoLidas, receberNotificacao, redefinirNotificacoes, useNaoLidas } from '../../components/notifications/notificationStore';

const { apiGet, apiPut } = vi.hoisted(() => ({ apiGet: vi.fn(), apiPut: vi.fn() }));
vi.mock('../../config/apiClient', () => ({ __esModule: true, default: { get: apiGet, put: apiPut }, getFullApiUrl: (c) => c }));
vi.mock('../../components/layout/useFotoPerfil', () => ({ useFotoPerfil: () => ({ fotoUrl: '', aoFalharFoto: () => {} }) }));

const AGORA = new Date('2026-11-26T15:00:00.000Z');
const TAREFA = 'a'.repeat(24);
const EQUIPE = 'e'.repeat(24);
const INSIGHT = 'f'.repeat(24);
const PESSOA = 'c'.repeat(24);

const alerta = (id, scope, extra = {}) => ({
  _id: id, tipo: 'system', lida: false, origemId: INSIGHT, createdAt: '2026-11-26T10:00:00.000Z',
  metadata: { kind: 'team_insight_alert', equipeId: EQUIPE, insightId: INSIGHT, alertLevel: 'high', ...(scope ? { scope } : {}), ...extra.metadata },
  texto: extra.texto,
});

const listaPadrao = () => [
  { _id: 'n1', tipo: 'task', texto: 'Ana concluiu a tarefa "Relatório"', lida: false, metadata: { tarefaId: TAREFA }, createdAt: '2026-11-26T12:00:00.000Z' },
  { _id: 'n2', tipo: 'chat', texto: 'Bruno enviou uma mensagem na equipe Projeto', lida: true, metadata: { equipeId: EQUIPE }, createdAt: '2026-11-25T18:00:00.000Z' },
  { _id: 'n3', tipo: 'team', texto: 'Você foi adicionado à equipe Gama', lida: true, metadata: {}, createdAt: '2026-11-20T09:00:00.000Z' },
  alerta('n4', 'team', { texto: 'Alerta critico na equipe Gama: sinais de conflito ou tom negativo recorrente na conversa. Risco 87%.' }),
  alerta('n5', 'user', { texto: 'Alerta de comportamento na equipe Gama: Carla teve 3 mensagens bloqueadas nas últimas 24 horas.', metadata: { userId: PESSOA, alertLevel: 'medium' } }),
  alerta('n6', null, { texto: 'Alerta de comportamento na equipe Gama: Diego teve sinais de linguagem inadequada ou bloqueios recorrentes. Risco 66%.', metadata: { alertLevel: undefined } }),
  { _id: 'n7', tipo: 'system', texto: 'Meta de 100% das entregas atingida', lida: true, metadata: {}, createdAt: 'data-invalida' },
];

let respostas;
const responder = async (valor) => {
  const resultado = typeof valor === 'function' ? await valor() : valor;
  if (resultado instanceof Error) throw resultado;
  return { data: resultado };
};

function Destino() {
  const location = useLocation();
  return <p data-testid="destino">{`${location.pathname}${location.search}|${JSON.stringify(location.state ?? null)}`}</p>;
}

function ContadorExterno() {
  const naoLidas = useNaoLidas();
  return <p data-testid="contador-externo">{naoLidas === null ? 'desconhecido' : naoLidas}</p>;
}

const renderPage = () => render(
  <MemoryRouter initialEntries={['/notificacoes']}>
    <Routes>
      <Route path="/notificacoes" element={<><NotificationsPage /><ContadorExterno /></>} />
      <Route path="*" element={<Destino />} />
    </Routes>
  </MemoryRouter>,
);

const esperarPronto = () => screen.findByText(/^Exibindo \d+ de/);
const card = (texto) => screen.getByText(texto).closest('article');
const textos = () => [...document.querySelectorAll('.notification-text')].map((el) => el.textContent);
const pedidos = (url) => apiGet.mock.calls.filter(([pedido]) => pedido === url).length;

beforeEach(() => {
  redefinirNotificacoes();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(AGORA);
  localStorage.clear();
  respostas = { lista: listaPadrao(), count: { count: 4 } };
  apiGet.mockReset();
  apiPut.mockReset().mockResolvedValue({ data: {} });
  apiGet.mockImplementation(async (url) => {
    if (url === API_ENDPOINTS.NOTIFICATIONS) return responder(respostas.lista);
    if (url === API_ENDPOINTS.NOTIFICATIONS_COUNT) return responder(respostas.count);
    throw new Error(`URL inesperada: ${url}`);
  });
  vi.spyOn(authUtils, 'getUserType').mockReturnValue('admin');
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('utilitarios', () => {
  test('percentual de risco: so o trecho final "Risco N%." dos alertas sai; mensagens comuns ficam intactas', () => {
    expect(removerPercentualDeRisco('Alerta critico na equipe X: sinais de conflito. Risco 87%.')).toBe('Alerta critico na equipe X: sinais de conflito.');
    expect(removerPercentualDeRisco('Acompanhamento recomendado na equipe X: atrito. Risco 0%')).toBe('Acompanhamento recomendado na equipe X: atrito.');
    expect(removerPercentualDeRisco('Risco 50% na metade do texto, depois mais.')).toBe('Risco 50% na metade do texto, depois mais.');
    // Mensagem comum (nao alerta) nunca passa pela supressao.
    expect(apresentarNotificacao(listaPadrao()[6]).texto).toBe('Meta de 100% das entregas atingida');
  });

  test('alertas: escopo e gravidade textual pelos metadados; nomes so no individual', () => {
    const [, , , coletivo, individual, historico] = listaPadrao();
    expect(apresentarAlerta(coletivo)).toEqual({
      escopo: 'coletivo', rotuloEscopo: 'Coletivo', gravidade: { codigo: 'high', rotulo: 'Alto' },
      texto: 'Alerta critico na equipe Gama: sinais de conflito ou tom negativo recorrente na conversa.',
    });
    expect(apresentarAlerta(individual)).toMatchObject({ escopo: 'individual', gravidade: { rotulo: 'Moderado' } });
    expect(apresentarAlerta(individual).texto).toContain('Carla');
    const hist = apresentarAlerta(historico);
    expect(hist).toMatchObject({ escopo: 'historico', rotuloEscopo: 'Histórico sem escopo', gravidade: null });
    expect(hist.texto).toBe('Alerta de comportamento na equipe Gama: sinais de linguagem inadequada ou bloqueios recorrentes de um participante.');
    expect(hist.texto).not.toMatch(/Diego|%/);
    expect(apresentarAlerta(alerta('x', null, { texto: 'Formato desconhecido com Fulano' })).texto).not.toContain('Fulano');
    expect(apresentarAlerta(alerta('y', 'team', { texto: 'x', metadata: { alertLevel: 'low' } })).gravidade).toEqual({ codigo: 'low', rotulo: 'Atenção' });
    expect(apresentarAlerta(alerta('z', 'team', { texto: 'x', metadata: { alertLevel: 0.87 } })).gravidade).toBeNull();
  });

  test('datas, ordem, filtros, pesquisa e juncao sem duplicatas', () => {
    expect(grupoDaData('2026-11-26T12:00:00.000Z', '2026-11-26')).toBe('hoje');
    expect(grupoDaData('2026-11-25T18:00:00.000Z', '2026-11-26')).toBe('ontem');
    expect(grupoDaData('2026-11-20T09:00:00.000Z', '2026-11-26')).toBe('anteriores');
    expect(grupoDaData('invalida', '2026-11-26')).toBe('anteriores');
    const ids = (filtros) => filtrarNotificacoes(listaPadrao(), { busca: '', status: '', categoria: '', ...filtros }).map((n) => n._id);
    expect(ids({})).toEqual(['n1', 'n4', 'n5', 'n6', 'n2', 'n3', 'n7']);
    expect(ids({ status: 'nao_lidas' })).toEqual(['n1', 'n4', 'n5', 'n6']);
    expect(ids({ status: 'lidas' })).toEqual(['n2', 'n3', 'n7']);
    expect(ids({ categoria: 'alerta' })).toEqual(['n4', 'n5', 'n6']);
    expect(ids({ categoria: 'system' })).toEqual(['n7']);
    expect(ids({ busca: 'RELATORIO' })).toEqual(['n1']);
    // O texto suprimido nao volta pela pesquisa.
    expect(ids({ busca: 'Diego' })).toEqual([]);
    expect(ids({ busca: '87%' })).toEqual([]);
    expect(juntarPorId([{ _id: 'a', v: 1 }], [{ _id: 'a', v: 2 }, { _id: 'b' }, { semId: true }])).toEqual([{ _id: 'a', v: 1 }, { _id: 'b' }]);
  });
});

describe('central', () => {
  test('indicadores, grupos por data, cartoes de alerta seguros e categoria de alerta so para admin', async () => {
    renderPage();
    await esperarPronto();
    const resumo = screen.getByLabelText('Resumo das notificações');
    expect(resumo).toHaveTextContent('4não lidas');
    expect(resumo).toHaveTextContent('7notificações');
    expect(resumo).toHaveTextContent('3alertas de moderação');
    expect([...document.querySelectorAll('.notificacoes-grupo-titulo')].map((h) => h.textContent)).toEqual(['Hoje', 'Ontem', 'Anteriores']);
    expect(within(screen.getByRole('region', { name: 'Hoje' })).getAllByRole('article')).toHaveLength(4);

    const coletivo = card(/sinais de conflito ou tom negativo/);
    expect(coletivo).toHaveTextContent('Alerta coletivo');
    expect(coletivo).toHaveTextContent('Gravidade: Alto');
    expect(document.querySelector('main').textContent).not.toMatch(/Risco \d+%|Diego/);
    expect(card(/Carla teve 3 mensagens/)).toHaveTextContent('Alerta individual');
    expect(card(/bloqueios recorrentes de um participante/)).toHaveTextContent('Alerta histórico sem escopo');
    expect(card(/Meta de 100%/)).toHaveTextContent('Data indisponível');
    expect(screen.getByLabelText('Categoria')).toContainHTML('Alertas de moderação');
  });

  test('pesquisa e filtros locais, sem nova consulta', async () => {
    renderPage();
    await esperarPronto();
    fireEvent.change(screen.getByLabelText('Pesquisar'), { target: { value: 'equipe gama' } });
    expect(textos()).toHaveLength(4);
    fireEvent.change(screen.getByLabelText('Leitura'), { target: { value: 'lidas' } });
    expect(textos()).toEqual(['Você foi adicionado à equipe Gama']);
    fireEvent.click(screen.getByRole('button', { name: 'Limpar filtros' }));
    fireEvent.change(screen.getByLabelText('Categoria'), { target: { value: 'chat' } });
    expect(textos()).toEqual(['Bruno enviou uma mensagem na equipe Projeto']);
    fireEvent.change(screen.getByLabelText('Pesquisar'), { target: { value: 'inexistente' } });
    expect(screen.getByText('Nenhuma notificação corresponde à pesquisa ou aos filtros aplicados.')).toBeInTheDocument();
    expect(pedidos(API_ENDPOINTS.NOTIFICATIONS)).toBe(1);
  });

  test('marcar como lida desce o contador compartilhado (sidebar, sino e central) sem duplicar o PUT', async () => {
    vi.spyOn(authUtils, 'getUserId').mockReturnValue(PESSOA);
    renderPage(); // a propria central monta a Sidebar real (nao simulada neste arquivo)
    await esperarPronto();
    await waitFor(() => expect(screen.getByTestId('contador-externo')).toHaveTextContent('4'));
    expect(screen.getByRole('link', { name: 'Notificações (4 não lidas)' })).toBeInTheDocument();
    expect(document.querySelector('.notification-badge')).toHaveTextContent('4');
    // Sidebar e central montadas juntas: uma unica leitura do contador.
    expect(pedidos(API_ENDPOINTS.NOTIFICATIONS_COUNT)).toBe(1);

    const botao = within(card(/concluiu a tarefa/)).getByRole('button', { name: 'Marcar como lida' });
    await act(async () => {
      fireEvent.click(botao);
      fireEvent.click(botao);
    });
    expect(apiPut).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('contador-externo')).toHaveTextContent('3');
    expect(screen.getByRole('link', { name: 'Notificações (3 não lidas)' })).toBeInTheDocument();
    expect(document.querySelector('.notification-badge')).toHaveTextContent('3');
    expect(card(/concluiu a tarefa/)).toHaveClass('read');
  });

  test('marcar todas: um PUT mesmo com clique duplo, contadores zerados e botao desativado', async () => {
    renderPage();
    await esperarPronto();
    const botao = screen.getByRole('button', { name: 'Marcar todas como lidas' });
    await act(async () => {
      fireEvent.click(botao);
      fireEvent.click(botao);
    });
    expect(apiPut).toHaveBeenCalledTimes(1);
    expect(apiPut).toHaveBeenCalledWith(API_ENDPOINTS.NOTIFICATIONS_MARK_ALL_READ, {});
    expect(lerNaoLidas()).toBe(0);
    expect(document.querySelector('.notification-badge')).toBeNull();
    expect(document.querySelectorAll('article.unread')).toHaveLength(0);
    expect(screen.getByRole('button', { name: 'Marcar todas como lidas' })).toBeDisabled();
  });

  test('Socket.IO: nova notificacao entra no topo e soma 1; repeticoes e ids ja carregados sao ignorados', async () => {
    renderPage();
    await esperarPronto();
    await waitFor(() => expect(screen.getByTestId('contador-externo')).toHaveTextContent('4'));
    const nova = { _id: 'n9', tipo: 'task', texto: 'Nova tarefa atribuída a você', lida: false, metadata: { tarefaId: TAREFA }, createdAt: '2026-11-26T14:59:00.000Z' };
    await act(async () => {
      expect(receberNotificacao(nova)).toBe(true);
      expect(receberNotificacao({ ...nova })).toBe(false);
      expect(receberNotificacao(listaPadrao()[0])).toBe(false);
      expect(receberNotificacao({ tipo: 'task', texto: 'sem id' })).toBe(false);
    });
    expect(textos()[0]).toBe('Nova tarefa atribuída a você');
    expect(textos().filter((t) => t === 'Nova tarefa atribuída a você')).toHaveLength(1);
    expect(screen.getByTestId('contador-externo')).toHaveTextContent('5');
    expect(screen.getByText('Exibindo 8 de 8 notificações')).toBeInTheDocument();
  });

  test('notificacao recebida durante a carga nao duplica quando a lista chega', async () => {
    let liberar;
    respostas.lista = () => new Promise((resolve) => { liberar = resolve; });
    renderPage();
    const nova = listaPadrao()[0];
    await act(async () => { receberNotificacao(nova); });
    await act(async () => { liberar(listaPadrao()); });
    await esperarPronto();
    expect(textos().filter((t) => t === nova.texto)).toHaveLength(1);
  });

  test('navegacao: admin abre o alerta nos Insights com equipe, aba e ocorrencia', async () => {
    renderPage();
    await esperarPronto();
    fireEvent.click(within(card(/sinais de conflito ou tom negativo/)).getByRole('button', { name: 'Ver alerta' }));
    await waitFor(() => expect(screen.getByTestId('destino')).toHaveTextContent(`/admin/insights?equipe=${EQUIPE}&aba=alertas&ocorrencia=${INSIGHT}|null`));
    expect(apiPut).toHaveBeenCalledWith(API_ENDPOINTS.NOTIFICATIONS_MARK_READ('n4'), {});
  });

  test('colaborador: sem categoria nem destino administrativo; tarefa abre o Kanban', async () => {
    authUtils.getUserType.mockReturnValue('user');
    respostas.lista = [...listaPadrao().slice(0, 3), alerta('n4', 'team', { texto: 'Alerta critico na equipe Gama: x. Risco 10%.' })];
    renderPage();
    await esperarPronto();
    expect(screen.getByLabelText('Categoria')).not.toContainHTML('Alertas de moderação');
    expect(screen.queryByLabelText('Resumo das notificações')).not.toHaveTextContent('alertas');
    expect(screen.queryByRole('button', { name: 'Ver alerta' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Ver tarefa' }));
    await waitFor(() => expect(screen.getByTestId('destino')).toHaveTextContent(`/minhas-tarefas|{"abrirTarefaId":"${TAREFA}"}`));
  });

  test('estados: carregando, erro com nova tentativa, vazio e lista no limite de 100', async () => {
    respostas.lista = new Error('falha');
    const { unmount } = renderPage();
    expect(screen.getByRole('status')).toHaveTextContent('Carregando notificações...');
    expect(await screen.findByRole('alert')).toHaveTextContent('Erro ao carregar notificações.');
    expect(screen.queryByText('Nenhuma notificação no momento.')).toBeNull();
    respostas.lista = [];
    fireEvent.click(screen.getByRole('button', { name: 'Tentar novamente' }));
    expect(await screen.findByText('Nenhuma notificação no momento.')).toBeInTheDocument();
    unmount();

    respostas.lista = Array.from({ length: 100 }, (_, i) => ({ _id: `m${i}`, tipo: 'chat', texto: `Mensagem ${i}`, lida: true, metadata: {}, createdAt: '2026-11-20T09:00:00.000Z' }));
    respostas.count = { count: 130 };
    renderPage();
    await esperarPronto();
    expect(screen.getByLabelText('Resumo das notificações')).toHaveTextContent('130não lidas');
    expect(screen.getByLabelText('Resumo das notificações')).toHaveTextContent('100carregadas (as 100 mais recentes)');
    expect(screen.getByText(/Exibindo as 100 notificações mais recentes/)).toBeInTheDocument();
    // Ha nao lidas fora das carregadas: "marcar todas" continua disponivel.
    expect(screen.getByRole('button', { name: 'Marcar todas como lidas' })).toBeEnabled();
  });
});
