// Meu Painel / Meu Dia: indicadores so com dados da API, grupos, estados, erro com nova tentativa e detalhe pelo
// TarefaModal. API simulada; data controlada (25/11/2026 ao meio-dia em Brasilia).
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { API_ENDPOINTS } from '../../config/config';
import DashboardUser from './DashboardUser';

const { apiGet, apiPut } = vi.hoisted(() => ({ apiGet: vi.fn(), apiPut: vi.fn() }));
vi.mock('../../config/apiClient', () => ({ __esModule: true, default: { get: apiGet, put: apiPut } }));
vi.mock('../../components/layout/Sidebar', () => ({ __esModule: true, default: () => null }));
vi.mock('../../components/tarefas/TarefaModal', () => ({
  __esModule: true,
  default: ({ tarefaId, onClose }) => (
    <div role="dialog" aria-label="Detalhe da tarefa">
      {tarefaId}
      <button type="button" onClick={onClose}>Fechar detalhe</button>
    </div>
  ),
}));
vi.mock('jspdf', () => ({ __esModule: true, default: vi.fn() }));

const id = (c) => c.repeat(24);
const dia = (d) => `2026-11-${d}T00:00:00.000Z`;
const tarefas = [
  { _id: id('a'), descricao: 'Relatório atrasado', status: 'pendente', urgencia: 'alta', dataEntrega: dia('20'), equipe: { nome: 'Alfa' } },
  { _id: id('b'), descricao: 'Entrega de hoje', status: 'em_andamento', urgencia: 'media', dataEntrega: dia('25'), equipe: { nome: 'Beta' } },
  { _id: id('c'), descricao: 'Revisão de amanhã', status: 'pendente', urgencia: 'baixa', dataEntrega: dia('26'), equipe: { nome: 'Alfa' }, tempoEstimado: 60 },
  { _id: id('d'), descricao: 'Sem data', status: 'pendente', urgencia: 'baixa', equipe: { nome: 'Alfa' } },
  { _id: id('e'), descricao: 'Já concluída', status: 'concluido', urgencia: 'alta', dataEntrega: dia('19'), equipe: { nome: 'Alfa' } },
];

let tzOriginal;
let respostaTarefas;

beforeEach(() => {
  sessionStorage.clear(); // ancoras e diferenca de relogio medidas ficam por aba: cada teste comeca sem elas
  tzOriginal = process.env.TZ;
  process.env.TZ = 'America/Sao_Paulo';
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-25T15:00:00.000Z'));
  apiGet.mockReset();
  apiPut.mockReset();
  respostaTarefas = () => Promise.resolve({ data: tarefas });
  apiGet.mockImplementation((url) => {
    if (url === API_ENDPOINTS.TAREFAS_MINHAS) return respostaTarefas();
    if (url === API_ENDPOINTS.NOTIFICATIONS_COUNT) return Promise.resolve({ data: { count: 2 } });
    return Promise.reject(new Error(`rota inesperada ${url}`));
  });
});

afterEach(() => {
  vi.useRealTimers();
  process.env.TZ = tzOriginal;
});

const renderPage = () => render(<MemoryRouter><DashboardUser /></MemoryRouter>);
const indicador = (rotulo) => within(screen.getByRole('region', { name: 'Resumo do dia' }))
  .getByText(rotulo).closest('article').querySelector('strong');
const secao = (nome) => screen.getByRole('region', { name: nome });

test('indicadores e grupos com os dados da API; concluida fora das pendencias', async () => {
  renderPage();
  expect(await screen.findByText('Relatório atrasado')).toBeInTheDocument();
  expect(indicador('Atrasadas')).toHaveTextContent('1');
  expect(indicador('Hoje')).toHaveTextContent('1');
  expect(indicador('Próximas')).toHaveTextContent('1');

  expect(within(secao('Atrasadas (1)')).getByText('Relatório atrasado')).toBeInTheDocument();
  expect(within(secao('Atrasadas (1)')).getByText('Atrasada')).toBeInTheDocument();
  expect(within(secao('Para hoje (1)')).getByText('Entrega de hoje')).toBeInTheDocument();
  expect(within(secao('Próximos 7 dias (1)')).getByText('Revisão de amanhã')).toBeInTheDocument();
  expect(within(secao('Sem prazo definido (1)')).getByText('Sem data')).toBeInTheDocument();
  // Datas no dia gravado (nao no anterior) e prazo relativo.
  expect(within(secao('Atrasadas (1)')).getByText('20/11/2026')).toBeInTheDocument();
  expect(within(secao('Atrasadas (1)')).getByText('Venceu há 5 dias')).toBeInTheDocument();
  expect(within(secao('Para hoje (1)')).getByText('25/11/2026')).toBeInTheDocument();
  // Concluida so na secao recolhida.
  expect(screen.getByText('Concluídas (1)')).toBeInTheDocument();
  expect(screen.getByText('Já concluída').closest('details')).not.toBeNull();
  // Cronometro so quando ha tempo estimado (como antes); nenhuma escrita ao abrir o painel.
  expect(within(secao('Próximos 7 dias (1)')).getByRole('button', { name: 'Iniciar cronômetro' })).toBeInTheDocument();
  expect(apiPut).not.toHaveBeenCalled();
});

test('carregando: nenhum zero aparece como resultado', async () => {
  let liberar;
  respostaTarefas = () => new Promise((resolve) => { liberar = resolve; });
  renderPage();
  expect(screen.getByRole('status')).toHaveTextContent('Carregando suas tarefas');
  ['Atrasadas', 'Hoje', 'Próximas'].forEach((rotulo) => expect(indicador(rotulo)).toHaveTextContent('—'));
  await act(async () => liberar({ data: [] }));
  expect(screen.getByText('Você ainda não tem tarefas atribuídas.')).toBeInTheDocument();
  expect(indicador('Atrasadas')).toHaveTextContent('0');
});

test('falha da API: aviso, indicadores indisponiveis e nova tentativa sob demanda', async () => {
  respostaTarefas = () => Promise.reject(new Error('503'));
  renderPage();
  expect(await screen.findByRole('alert')).toHaveTextContent('Não foi possível carregar suas tarefas agora.');
  expect(indicador('Atrasadas')).toHaveTextContent('—');
  expect(screen.queryByText('Você ainda não tem tarefas atribuídas.')).toBeNull();
  const chamadas = apiGet.mock.calls.filter(([url]) => url === API_ENDPOINTS.TAREFAS_MINHAS).length;
  expect(chamadas).toBe(1); // sem repeticao automatica

  respostaTarefas = () => Promise.resolve({ data: tarefas });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Tentar novamente' }));
  });
  expect(await screen.findByText('Relatório atrasado')).toBeInTheDocument();
  expect(screen.queryByRole('alert')).toBeNull();
});

test('tudo concluido: mensagem tranquila, sem secoes de pendencias', async () => {
  respostaTarefas = () => Promise.resolve({ data: [tarefas[4]] });
  renderPage();
  expect(await screen.findByText('Tudo em dia: todas as suas tarefas estão concluídas.')).toBeInTheDocument();
  expect(screen.queryByRole('region', { name: /Atrasadas \(/ })).toBeNull();
});

test('sem atrasadas: aviso positivo e nenhuma secao de atrasadas', async () => {
  respostaTarefas = () => Promise.resolve({ data: [tarefas[1]] });
  renderPage();
  expect(await screen.findByText(/Nenhuma tarefa atrasada\./)).toBeInTheDocument();
  expect(screen.getByText(/Nenhuma entrega nos próximos 7 dias\./)).toBeInTheDocument();
  expect(screen.queryByRole('region', { name: /^Atrasadas/ })).toBeNull();
});

test('detalhes pelo TarefaModal: abre a tarefa da lista e fecha recarregando sem estado de carregamento', async () => {
  renderPage();
  fireEvent.click(await screen.findByRole('button', { name: 'Ver detalhes de Entrega de hoje' }));
  expect(screen.getByRole('dialog', { name: 'Detalhe da tarefa' })).toHaveTextContent(id('b'));
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Fechar detalhe' }));
  });
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(screen.queryByRole('status')).toBeNull();
  expect(apiGet.mock.calls.filter(([url]) => url === API_ENDPOINTS.TAREFAS_MINHAS)).toHaveLength(2);
});

test('tarefa sem id confiavel nao abre detalhe', async () => {
  respostaTarefas = () => Promise.resolve({ data: [{ descricao: 'Sem id', status: 'pendente', dataEntrega: dia('25') }] });
  renderPage();
  fireEvent.click(await screen.findByRole('button', { name: 'Ver detalhes de Sem id' }));
  expect(screen.queryByRole('dialog')).toBeNull();
});

describe('alterar status no Meu Dia', () => {
  // API simulada consistente: o PUT aceito muda o que o GET seguinte devolve (como o servidor real).
  let estado;
  beforeEach(() => {
    estado = tarefas.map((t) => ({ ...t }));
    respostaTarefas = () => Promise.resolve({ data: estado.map((t) => ({ ...t })) });
  });
  const aceitar = (resposta) => (url, body) => {
    const tarefaId = url.split('/')[2];
    estado = estado.map((t) => (t._id === tarefaId ? { ...t, status: body.status } : t));
    return Promise.resolve(resposta(tarefaId, body));
  };

  const abrirEditor = async (descricao) => {
    fireEvent.click(await screen.findByRole('button', { name: `Alterar status de ${descricao}` }));
    return screen.getByLabelText('Novo status');
  };

  test('abrir o seletor nao envia nada; confirmar envia { status } e atualiza grupos e indicadores', async () => {
    apiPut.mockImplementation(aceitar((tarefaId, body) => ({ data: { msg: 'ok', tarefa: { _id: tarefaId, status: body.status, cronometroAtivo: false } } })));
    renderPage();
    const seletor = await abrirEditor('Relatório atrasado');
    expect(apiPut).not.toHaveBeenCalled();
    fireEvent.change(seletor, { target: { value: 'concluido' } });
    expect(apiPut).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Salvar' }));
    });

    expect(apiPut).toHaveBeenCalledWith(`/tarefas/${id('a')}/status`, { status: 'concluido' });
    expect(screen.getByRole('status')).toHaveTextContent('Status de "Relatório atrasado" atualizado para Concluído.');
    expect(indicador('Atrasadas')).toHaveTextContent('0');
    expect(screen.queryByRole('region', { name: /^Atrasadas/ })).toBeNull();
    expect(screen.getByText('Concluídas (2)')).toBeInTheDocument();
    expect(screen.getByText('Relatório atrasado').closest('details')).not.toBeNull();
  });

  test('falha da API: erro no item, nada muda e nenhum sucesso aparece', async () => {
    apiPut.mockRejectedValue({ response: { status: 403, data: { erro: 'Você não pode alterar esta tarefa.' } } });
    renderPage();
    const seletor = await abrirEditor('Entrega de hoje');
    fireEvent.change(seletor, { target: { value: 'concluido' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Salvar' }));
    });
    expect(screen.getByRole('alert')).toHaveTextContent('Você não pode alterar esta tarefa.');
    expect(screen.queryByText(/atualizado para/)).toBeNull();
    expect(indicador('Hoje')).toHaveTextContent('1');
    expect(within(secao('Para hoje (1)')).getByText('Entrega de hoje')).toBeInTheDocument();
  });

  test('reabrir tarefa concluida a devolve ao grupo correspondente', async () => {
    apiPut.mockImplementation(aceitar((tarefaId, body) => ({ data: { tarefa: { _id: tarefaId, status: body.status } } })));
    renderPage();
    await screen.findByText('Concluídas (1)');
    const seletor = await abrirEditor('Já concluída');
    fireEvent.change(seletor, { target: { value: 'pendente' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Salvar' }));
    });
    expect(indicador('Atrasadas')).toHaveTextContent('2');
    expect(within(secao('Atrasadas (2)')).getByText('Já concluída')).toBeInTheDocument();
    expect(screen.queryByText(/Concluídas \(/)).toBeNull();
  });

  test('envio duplicado bloqueado enquanto salva; cancelar fecha sem enviar', async () => {
    let concluir;
    apiPut.mockImplementation(() => new Promise((resolve) => { concluir = resolve; }));
    renderPage();
    const seletor = await abrirEditor('Revisão de amanhã');
    fireEvent.change(seletor, { target: { value: 'em_andamento' } });
    const salvar = screen.getByRole('button', { name: 'Salvar' });
    await act(async () => {
      fireEvent.click(salvar);
      fireEvent.click(salvar);
      fireEvent.submit(salvar.closest('form'));
    });
    expect(apiPut).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Salvando...' })).toBeDisabled();
    await act(async () => concluir({ data: { tarefa: { _id: id('c'), status: 'em_andamento' } } }));

    fireEvent.click(await screen.findByRole('button', { name: 'Alterar status de Sem data' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }));
    expect(screen.queryByLabelText('Novo status')).toBeNull();
    expect(apiPut).toHaveBeenCalledTimes(1);
  });

  test('detalhes, PDF e cronometro continuam no item', async () => {
    renderPage();
    const item = (await screen.findByText('Revisão de amanhã')).closest('li');
    expect(within(item).getByRole('button', { name: 'Ver detalhes de Revisão de amanhã' })).toBeInTheDocument();
    expect(within(item).getByRole('button', { name: 'Baixar PDF de Revisão de amanhã' })).toBeInTheDocument();
    expect(within(item).getByRole('button', { name: 'Iniciar cronômetro' })).toBeInTheDocument();
    expect(within(item).getByRole('button', { name: 'Alterar status de Revisão de amanhã' })).toBeInTheDocument();
  });
});

describe('cronometro no Meu Dia', () => {
  // Navegador as 12:00:00 em Brasilia; servidor 21 s adiantado (o cenario do "-1h -1m -21s").
  const INICIO_SERVIDOR = '2026-11-25T15:00:21.000Z';
  const tempoNaTela = (descricao) => screen.getByText(descricao).closest('li').textContent.match(/Tempo gasto: ([^E]*?s)/)?.[1];

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    vi.setSystemTime(new Date('2026-11-25T15:00:00.000Z'));
  });

  const iniciarEsperando = async (resposta) => {
    apiPut.mockResolvedValueOnce(resposta);
    renderPage();
    await act(async () => {});
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Iniciar cronômetro' }));
    });
  };

  test('tarefa antiga iniciada agora: comeca em zero, conta pelo relogio local, preserva a equipe e avisa o FloatingTimer', async () => {
    const eventos = [];
    const ouvir = () => eventos.push('cronometro');
    window.addEventListener('flowly:cronometro-atualizado', ouvir);
    // Resposta da API sem equipe populada (so os campos do cronometro sao usados).
    await iniciarEsperando({ data: { tarefa: { _id: id('c'), cronometroAtivo: true, tempoGasto: 0, ultimaAtualizacaoCronometro: INICIO_SERVIDOR } } });
    window.removeEventListener('flowly:cronometro-atualizado', ouvir);

    expect(apiPut).toHaveBeenCalledWith(`/tarefas/${id('c')}/cronometro`, { acao: 'iniciar' });
    expect(tempoNaTela('Revisão de amanhã')).toBe('0h 0m 0s');
    await act(async () => { vi.advanceTimersByTime(5000); });
    expect(tempoNaTela('Revisão de amanhã')).toBe('0h 0m 5s');
    expect(screen.getByText('Revisão de amanhã').closest('li')).toHaveTextContent('Alfa');
    expect(screen.getByRole('button', { name: 'Pausar cronômetro' })).toBeInTheDocument();
    expect(eventos).toEqual(['cronometro']);
  });

  test('pausar: para de contar com o acumulado confirmado e retomar continua do acumulado', async () => {
    await iniciarEsperando({ data: { tarefa: { _id: id('c'), cronometroAtivo: true, tempoGasto: 0, ultimaAtualizacaoCronometro: INICIO_SERVIDOR } } });
    await act(async () => { vi.advanceTimersByTime(125000); });
    apiPut.mockResolvedValueOnce({ data: { tarefa: { _id: id('c'), cronometroAtivo: false, tempoGasto: 2, ultimaAtualizacaoCronometro: INICIO_SERVIDOR } } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Pausar cronômetro' }));
    });
    expect(screen.getByText('Revisão de amanhã').closest('li')).not.toHaveTextContent('Tempo gasto');
    await act(async () => { vi.advanceTimersByTime(60000); });
    expect(screen.getByRole('button', { name: 'Iniciar cronômetro' })).toBeInTheDocument();

    apiPut.mockResolvedValueOnce({ data: { tarefa: { _id: id('c'), cronometroAtivo: true, tempoGasto: 2, ultimaAtualizacaoCronometro: '2026-11-25T15:03:30.000Z' } } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Iniciar cronômetro' }));
    });
    expect(tempoNaTela('Revisão de amanhã')).toBe('0h 2m 0s');
    await act(async () => { vi.advanceTimersByTime(3000); });
    expect(tempoNaTela('Revisão de amanhã')).toBe('0h 2m 3s');
  });

  test('pagina recarregada com cronometro ativo mostra o tempo da sessao em andamento', async () => {
    respostaTarefas = () => Promise.resolve({ data: [{ ...tarefas[2], cronometroAtivo: true, tempoGasto: 10, ultimaAtualizacaoCronometro: '2026-11-25T14:58:00.000Z' }] });
    renderPage();
    await act(async () => {});
    expect(tempoNaTela('Revisão de amanhã')).toBe('0h 12m 0s');
  });

  test('servidor adiantado apos recarregar: nunca negativo', async () => {
    respostaTarefas = () => Promise.resolve({ data: [{ ...tarefas[2], cronometroAtivo: true, tempoGasto: 0, ultimaAtualizacaoCronometro: INICIO_SERVIDOR }] });
    renderPage();
    await act(async () => {});
    expect(tempoNaTela('Revisão de amanhã')).toBe('0h 0m 0s');
  });

  test('falha da API: aviso, nada muda e sem clique duplo', async () => {
    let falhar;
    apiPut.mockImplementationOnce(() => new Promise((_resolve, reject) => { falhar = reject; }));
    renderPage();
    await act(async () => {});
    const botao = screen.getByRole('button', { name: 'Iniciar cronômetro' });
    await act(async () => {
      fireEvent.click(botao);
      fireEvent.click(botao);
    });
    expect(apiPut).toHaveBeenCalledTimes(1);
    expect(botao).toBeDisabled();
    await act(async () => falhar(new Error('500')));
    expect(screen.getByRole('alert')).toHaveTextContent('Não foi possível iniciar o cronômetro agora. Nada foi alterado.');
    expect(screen.getByRole('button', { name: 'Iniciar cronômetro' })).toBeEnabled();
    expect(screen.getByText('Revisão de amanhã').closest('li')).not.toHaveTextContent('Tempo gasto');
  });
});

describe('etiqueta de urgencia', () => {
  test('Alta, Media e Baixa como etiquetas proprias (sem a barra global do Kanban)', async () => {
    renderPage();
    await screen.findByText('Relatório atrasado');
    const etiqueta = (descricao) => screen.getByText(descricao).closest('li').querySelector('.meu-dia-urgencia');
    expect(etiqueta('Relatório atrasado')).toHaveClass('meu-dia-urgencia-alta');
    expect(etiqueta('Relatório atrasado')).toHaveTextContent('Urgência Alta');
    expect(etiqueta('Entrega de hoje')).toHaveClass('meu-dia-urgencia-media');
    expect(etiqueta('Revisão de amanhã')).toHaveClass('meu-dia-urgencia-baixa');
    expect(document.querySelector('.meu-dia .urgencia-media, .meu-dia .urgencia-alta, .meu-dia .urgencia-baixa')).toBeNull();
  });
});

describe('cronometro com segundos persistidos', () => {
  const tempoNaTela = (descricao) => screen.getByText(descricao).closest('li').textContent.match(/Tempo gasto: ([^E]*?s)/)?.[1];

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    vi.setSystemTime(new Date('2026-11-25T15:00:00.000Z'));
  });

  test('8 min 23 s confirmados, retoma, +17 s = 8 min 40 s; pausa confirma 520 s; retomar parte de 8 min 40 s', async () => {
    respostaTarefas = () => Promise.resolve({ data: [{ ...tarefas[2], tempoGasto: 8, tempoGastoSegundos: 503 }] });
    renderPage();
    await act(async () => {});
    apiPut.mockResolvedValueOnce({ data: { tarefa: { _id: id('c'), cronometroAtivo: true, tempoGasto: 8, tempoGastoSegundos: 503, ultimaAtualizacaoCronometro: '2026-11-25T15:00:05.000Z' } } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Iniciar cronômetro' }));
    });
    expect(tempoNaTela('Revisão de amanhã')).toBe('0h 8m 23s');
    await act(async () => { vi.advanceTimersByTime(17000); });
    expect(tempoNaTela('Revisão de amanhã')).toBe('0h 8m 40s');

    apiPut.mockResolvedValueOnce({ data: { tarefa: { _id: id('c'), cronometroAtivo: false, tempoGasto: 8, tempoGastoSegundos: 520 } } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Pausar cronômetro' }));
    });
    apiPut.mockResolvedValueOnce({ data: { tarefa: { _id: id('c'), cronometroAtivo: true, tempoGasto: 8, tempoGastoSegundos: 520, ultimaAtualizacaoCronometro: '2026-11-25T15:01:00.000Z' } } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Iniciar cronômetro' }));
    });
    expect(tempoNaTela('Revisão de amanhã')).toBe('0h 8m 40s');
  });

  test('pagina recarregada com sessao ativa parte do acumulado preciso', async () => {
    respostaTarefas = () => Promise.resolve({ data: [{ ...tarefas[2], cronometroAtivo: true, tempoGasto: 8, tempoGastoSegundos: 503, ultimaAtualizacaoCronometro: '2026-11-25T14:59:43.000Z' }] });
    renderPage();
    await act(async () => {});
    expect(tempoNaTela('Revisão de amanhã')).toBe('0h 8m 40s');
  });

  test('resposta parcial sem o campo novo nao apaga o acumulado preciso nem a equipe', async () => {
    respostaTarefas = () => Promise.resolve({ data: [{ ...tarefas[2], tempoGasto: 8, tempoGastoSegundos: 503 }] });
    renderPage();
    await act(async () => {});
    apiPut.mockResolvedValueOnce({ data: { tarefa: { _id: id('c'), cronometroAtivo: true, ultimaAtualizacaoCronometro: '2026-11-25T15:00:00.000Z' } } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Iniciar cronômetro' }));
    });
    expect(tempoNaTela('Revisão de amanhã')).toBe('0h 8m 23s');
    expect(screen.getByText('Revisão de amanhã').closest('li')).toHaveTextContent('Alfa');
  });
});

describe('F5 com cronometro ativo: o contador continua avancando', () => {
  const tempoNaTela = (descricao) => screen.getByText(descricao).closest('li').textContent.match(/Tempo gasto: ([^E]*?s)/)?.[1];
  const putsCronometro = () => apiPut.mock.calls.filter(([url]) => url.endsWith('/cronometro'));

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    vi.setSystemTime(new Date('2026-11-25T15:00:00.000Z'));
  });

  const carregarAtiva = async (extra) => {
    respostaTarefas = () => Promise.resolve({ data: [{ ...tarefas[2], cronometroAtivo: true, tempoGasto: 8, tempoGastoSegundos: 503, ...extra }] });
    const view = renderPage();
    await act(async () => {});
    return view;
  };

  test('relogios iguais: mostra o total e avanca 5 s e depois mais 10 s, sem nenhum PUT', async () => {
    await carregarAtiva({ ultimaAtualizacaoCronometro: '2026-11-25T14:59:00.000Z' }); // sessao de 60 s
    expect(tempoNaTela('Revisão de amanhã')).toBe('0h 9m 23s');
    await act(async () => { vi.advanceTimersByTime(5000); });
    expect(tempoNaTela('Revisão de amanhã')).toBe('0h 9m 28s');
    await act(async () => { vi.advanceTimersByTime(10000); });
    expect(tempoNaTela('Revisão de amanhã')).toBe('0h 9m 38s');
    expect(putsCronometro()).toHaveLength(0);
  });

  test('servidor adiantado (inicio "no futuro" para o navegador): nunca negativo e avanca desde o carregamento', async () => {
    // A sessao comecou ha pouco no relogio do servidor, que esta 90 s a frente do navegador.
    await carregarAtiva({ ultimaAtualizacaoCronometro: '2026-11-25T15:01:00.000Z' });
    expect(tempoNaTela('Revisão de amanhã')).toBe('0h 8m 23s');
    await act(async () => { vi.advanceTimersByTime(5000); });
    expect(tempoNaTela('Revisão de amanhã')).toBe('0h 8m 28s');
    await act(async () => { vi.advanceTimersByTime(10000); });
    expect(tempoNaTela('Revisão de amanhã')).toBe('0h 8m 38s');
    expect(putsCronometro()).toHaveLength(0);
  });

  test('tarefa antiga so com tempoGasto, ativa ao carregar: avanca', async () => {
    await carregarAtiva({ tempoGastoSegundos: undefined, ultimaAtualizacaoCronometro: '2026-11-25T15:00:00.000Z' });
    expect(tempoNaTela('Revisão de amanhã')).toBe('0h 8m 0s');
    await act(async () => { vi.advanceTimersByTime(7000); });
    expect(tempoNaTela('Revisão de amanhã')).toBe('0h 8m 7s');
  });

  test('pausar depois do F5 para de contar com o acumulado confirmado; retomar continua dele', async () => {
    await carregarAtiva({ ultimaAtualizacaoCronometro: '2026-11-25T15:01:00.000Z' });
    await act(async () => { vi.advanceTimersByTime(17000); });
    apiPut.mockResolvedValueOnce({ data: { tarefa: { _id: id('c'), cronometroAtivo: false, tempoGasto: 8, tempoGastoSegundos: 520 } } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Pausar cronômetro' }));
    });
    expect(screen.getByRole('button', { name: 'Iniciar cronômetro' })).toBeInTheDocument();
    await act(async () => { vi.advanceTimersByTime(5000); });
    expect(screen.getByText('Revisão de amanhã').closest('li')).not.toHaveTextContent('Tempo gasto');
    apiPut.mockResolvedValueOnce({ data: { tarefa: { _id: id('c'), cronometroAtivo: true, tempoGasto: 8, tempoGastoSegundos: 520, ultimaAtualizacaoCronometro: '2026-11-25T15:02:30.000Z' } } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Iniciar cronômetro' }));
    });
    expect(tempoNaTela('Revisão de amanhã')).toBe('0h 8m 40s');
    await act(async () => { vi.advanceTimersByTime(3000); });
    expect(tempoNaTela('Revisão de amanhã')).toBe('0h 8m 43s');
  });

  test('sair e voltar ao Meu Dia: volta a mostrar a duracao atual e avancar; desmontar limpa o intervalo', async () => {
    const limpar = vi.spyOn(globalThis, 'clearInterval');
    const primeira = await carregarAtiva({ ultimaAtualizacaoCronometro: '2026-11-25T14:59:00.000Z' });
    await act(async () => { vi.advanceTimersByTime(4000); });
    primeira.unmount();
    expect(limpar).toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0); // nenhum intervalo sobrando
    await act(async () => { vi.advanceTimersByTime(30000); });
    await carregarAtiva({ ultimaAtualizacaoCronometro: '2026-11-25T14:59:00.000Z' });
    expect(tempoNaTela('Revisão de amanhã')).toBe('0h 9m 57s'); // 503 + 60 + 34
    await act(async () => { vi.advanceTimersByTime(3000); });
    expect(tempoNaTela('Revisão de amanhã')).toBe('0h 10m 0s');
    expect(vi.getTimerCount()).toBe(1); // um unico intervalo
  });

  test('recarregar a lista (fechar detalhe) nao zera nem pula o contador da sessao', async () => {
    await carregarAtiva({ ultimaAtualizacaoCronometro: '2026-11-25T15:01:00.000Z' });
    await act(async () => { vi.advanceTimersByTime(10000); });
    fireEvent.click(screen.getByRole('button', { name: 'Ver detalhes de Revisão de amanhã' }));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Fechar detalhe' }));
    });
    expect(tempoNaTela('Revisão de amanhã')).toBe('0h 8m 33s');
    await act(async () => { vi.advanceTimersByTime(2000); });
    expect(tempoNaTela('Revisão de amanhã')).toBe('0h 8m 35s');
  });
});

describe('StrictMode', () => {
  test('com efeitos montados duas vezes: um unico intervalo e o contador avanca', async () => {
    const { StrictMode } = await import('react');
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    vi.setSystemTime(new Date('2026-11-25T15:00:00.000Z'));
    respostaTarefas = () => Promise.resolve({ data: [{ ...tarefas[2], cronometroAtivo: true, tempoGasto: 8, tempoGastoSegundos: 503, ultimaAtualizacaoCronometro: '2026-11-25T15:01:00.000Z' }] });
    render(<StrictMode><MemoryRouter><DashboardUser /></MemoryRouter></StrictMode>);
    await act(async () => {});
    const tempo = () => screen.getByText('Revisão de amanhã').closest('li').textContent.match(/Tempo gasto: ([^E]*?s)/)?.[1];
    expect(tempo()).toBe('0h 8m 23s');
    await act(async () => { vi.advanceTimersByTime(4000); });
    expect(tempo()).toBe('0h 8m 27s');
    expect(vi.getTimerCount()).toBe(1);
    expect(apiPut).not.toHaveBeenCalled();
  });
});

describe('sincronizacao do relogio depois do F5', () => {
  const tempoNaTela = (descricao) => screen.getByText(descricao).closest('li').textContent.match(/Tempo gasto: ([^E]*?s)/)?.[1];

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    vi.setSystemTime(new Date('2026-11-25T15:00:00.000Z'));
  });

  const iniciarComServidor = async (deslocamentoMs) => {
    respostaTarefas = () => Promise.resolve({ data: [{ ...tarefas[2], tempoGasto: 8, tempoGastoSegundos: 503 }] });
    const view = renderPage();
    await act(async () => {});
    const inicioServidor = new Date(Date.now() + deslocamentoMs).toISOString();
    apiPut.mockResolvedValueOnce({ data: { tarefa: { _id: id('c'), cronometroAtivo: true, tempoGasto: 8, tempoGastoSegundos: 503, ultimaAtualizacaoCronometro: inicioServidor } } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Iniciar cronômetro' }));
    });
    return { view, inicioServidor };
  };

  test.each([
    ['navegador 20 s atrasado (servidor adiantado)', 20000],
    ['navegador 20 s adiantado (servidor atrasado)', -20000],
    ['relogios iguais', 0],
  ])('%s: o F5 nao perde nem ganha segundos da sessao iniciada nesta aba', async (_caso, deslocamento) => {
    const { view, inicioServidor } = await iniciarComServidor(deslocamento);
    await act(async () => { vi.advanceTimersByTime(30000); });
    expect(tempoNaTela('Revisão de amanhã')).toBe('0h 8m 53s');
    view.unmount(); // F5
    respostaTarefas = () => Promise.resolve({ data: [{ ...tarefas[2], cronometroAtivo: true, tempoGasto: 8, tempoGastoSegundos: 503, ultimaAtualizacaoCronometro: inicioServidor }] });
    renderPage();
    await act(async () => {});
    expect(tempoNaTela('Revisão de amanhã')).toBe('0h 8m 53s');
    await act(async () => { vi.advanceTimersByTime(5000); });
    expect(tempoNaTela('Revisão de amanhã')).toBe('0h 8m 58s');
  });

  test('sessao iniciada em outra aba: corrigida pela diferenca de relogio ja medida neste navegador', async () => {
    sessionStorage.setItem('flowly:relogio-offset', JSON.stringify({ offsetMs: 20000, incertezaMs: 150 }));
    // Servidor 20 s adiantado; a sessao comecou ha 60 s no relogio dele.
    respostaTarefas = () => Promise.resolve({ data: [{ ...tarefas[2], cronometroAtivo: true, tempoGasto: 8, tempoGastoSegundos: 503, ultimaAtualizacaoCronometro: '2026-11-25T14:59:20.000Z' }] });
    renderPage();
    await act(async () => {});
    expect(tempoNaTela('Revisão de amanhã')).toBe('0h 9m 23s'); // 503 + 60
  });

  test('sem referencia de horario (nem ancora nem diferenca medida): parte do que e mensuravel, nunca negativo', async () => {
    respostaTarefas = () => Promise.resolve({ data: [{ ...tarefas[2], cronometroAtivo: true, tempoGasto: 8, tempoGastoSegundos: 503, ultimaAtualizacaoCronometro: '2026-11-25T15:00:20.000Z' }] });
    renderPage();
    await act(async () => {});
    expect(tempoNaTela('Revisão de amanhã')).toBe('0h 8m 23s');
    await act(async () => { vi.advanceTimersByTime(2000); });
    expect(tempoNaTela('Revisão de amanhã')).toBe('0h 8m 25s');
  });

  test('callbacks atrasados: mostra o tempo decorrido (sem +1 por callback, sem deriva) e um so intervalo', async () => {
    respostaTarefas = () => Promise.resolve({ data: [{ ...tarefas[2], cronometroAtivo: true, tempoGasto: 8, tempoGastoSegundos: 503, ultimaAtualizacaoCronometro: '2026-11-25T15:00:00.000Z' }] });
    renderPage();
    await act(async () => {});
    vi.setSystemTime(new Date('2026-11-25T15:00:07.300Z')); // o navegador "dormiu" 7,3 s sem disparar callbacks
    await act(async () => { vi.advanceTimersByTime(250); });
    expect(tempoNaTela('Revisão de amanhã')).toBe('0h 8m 30s'); // 503 + 7 (o atraso aparece de uma vez, correto)
    expect(vi.getTimerCount()).toBe(1);
    expect(apiPut).not.toHaveBeenCalled();
  });

  test('pausa pendente na API: o acumulado exibido nao muda antes da confirmacao', async () => {
    respostaTarefas = () => Promise.resolve({ data: [{ ...tarefas[2], cronometroAtivo: true, tempoGasto: 8, tempoGastoSegundos: 503, ultimaAtualizacaoCronometro: '2026-11-25T15:00:00.000Z' }] });
    renderPage();
    await act(async () => {});
    let confirmar;
    apiPut.mockImplementationOnce(() => new Promise((resolve) => { confirmar = resolve; }));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Pausar cronômetro' }));
    });
    await act(async () => { vi.advanceTimersByTime(3000); });
    expect(tempoNaTela('Revisão de amanhã')).toBe('0h 8m 26s'); // continua contando ate a API confirmar
    await act(async () => confirmar({ data: { tarefa: { _id: id('c'), cronometroAtivo: false, tempoGasto: 8, tempoGastoSegundos: 506 } } }));
    expect(screen.getByRole('button', { name: 'Iniciar cronômetro' })).toBeInTheDocument();
  });
});
