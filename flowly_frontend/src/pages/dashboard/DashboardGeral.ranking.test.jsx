import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import DashboardGeral from './DashboardGeral';
import apiClient from '../../config/apiClient';
import { API_ENDPOINTS, LOCAL_STORAGE_KEYS } from '../../config/config';

// Painel Geral com a API simulada: ranking (top 5, ver todas, empates, sem tarefas) e a
// garantia de que indicadores e grafico continuam recebendo os mesmos dados.

vi.mock('../../config/apiClient', () => ({
  __esModule: true,
  default: { get: vi.fn() },
  getFullApiUrl: (path = '') => (path.startsWith('http') ? path : `http://api.test${path}`),
}));

// O jsdom nao tem canvas: o grafico vira um marcador e as props ficam registradas.
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

const equipe = (id, nome) => ({ _id: id, nome, membros: [] });

let sequencia = 0;
const tarefa = (equipeId, status, tempoGasto = 0) => ({
  _id: `t${(sequencia += 1)}`,
  descricao: `Tarefa ${sequencia}`,
  status,
  tempoGasto,
  equipe: { _id: equipeId, nome: 'populada' },
});

const tarefasDe = (equipeId, { c = 0, a = 0, p = 0 } = {}) => [
  ...Array.from({ length: c }, () => tarefa(equipeId, 'concluido')),
  ...Array.from({ length: a }, () => tarefa(equipeId, 'em_andamento')),
  ...Array.from({ length: p }, () => tarefa(equipeId, 'pendente')),
];

const respostasApi = ({ equipes = [], tarefas = [] }) => {
  apiClient.get.mockImplementation(async (pedido) => {
    if (pedido === API_ENDPOINTS.EQUIPES) return { data: equipes };
    if (pedido === API_ENDPOINTS.TAREFAS) return { data: tarefas };
    if (pedido === API_ENDPOINTS.NOTIFICATIONS_COUNT) return { data: { count: 0 } };
    if (pedido === API_ENDPOINTS.USER_ME) return { data: { nome: 'Chuckles', fotoPerfil: '' } };
    return { data: [] };
  });
};

const abrirPainel = async (dados) => {
  respostasApi(dados);
  render(
    <MemoryRouter initialEntries={['/admin/geral']}>
      <DashboardGeral />
    </MemoryRouter>,
  );
  await waitFor(() => {
    const pedidos = apiClient.get.mock.calls.map(([pedido]) => pedido);
    expect(pedidos).toEqual(expect.arrayContaining([API_ENDPOINTS.EQUIPES, API_ENDPOINTS.TAREFAS]));
  });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
};

const painelRanking = () => screen.getByRole('region', { name: /Ranking de Equipes|Atividade das Equipes/ });
const itensRanking = () => [...painelRanking().querySelectorAll('.ranking-list > li')];
const nomesRanking = () => itensRanking().map((li) => li.querySelector('.ranking-nome').textContent);
const botaoRanking = () => within(painelRanking()).queryByRole('button');
const indicador = (titulo) => screen.getByRole('heading', { name: titulo }).nextElementSibling.textContent;

const quatorzeEquipes = () => {
  const equipes = Array.from({ length: 14 }, (_, i) => equipe(`e${String(i + 1).padStart(2, '0')}`, `Equipe ${i + 1}`));
  // Concluidas crescendo com o indice: a ordem da API (mais antigas primeiro) e o inverso do ranking.
  const tarefas = equipes.flatMap(({ _id }, i) => tarefasDe(_id, { c: i, p: 1 }));
  return { equipes, tarefas };
};

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem(LOCAL_STORAGE_KEYS.TOKEN, 'token-de-teste');
  localStorage.setItem(LOCAL_STORAGE_KEYS.USER_TYPE, 'admin');
  localStorage.setItem(LOCAL_STORAGE_KEYS.USER_NAME, 'Chuckles');
  apiClient.get.mockReset();
  grafico.props = null;
});

describe('ranking do Painel Geral', () => {
  test('uma equipe: aparece com posicao, concluidas e percentual, sem botao de expandir', async () => {
    await abrirPainel({ equipes: [equipe('a', 'Alfa')], tarefas: tarefasDe('a', { c: 1, p: 2 }) });

    expect(within(painelRanking()).getByRole('heading', { name: 'Ranking de Equipes' })).toBeInTheDocument();
    expect(nomesRanking()).toEqual(['Alfa']);
    const [item] = itensRanking();
    expect(item.querySelector('.ranking-medal')).toHaveTextContent('1');
    expect(item).toHaveTextContent('1 concluída de 3');
    expect(item).toHaveTextContent('33%');
    expect(item.querySelector('.ranking-progresso > span')).toHaveStyle({ width: '33%' });
    expect(botaoRanking()).toBeNull();
  });

  test('quatorze equipes: mostra 5, expande para todas e recolhe de novo', async () => {
    await abrirPainel(quatorzeEquipes());

    expect(nomesRanking()).toEqual(['Equipe 14', 'Equipe 13', 'Equipe 12', 'Equipe 11', 'Equipe 10']);
    expect(botaoRanking()).toHaveTextContent('Ver todas (14)');
    expect(botaoRanking()).toHaveAttribute('aria-expanded', 'false');
    const conteudo = document.getElementById(botaoRanking().getAttribute('aria-controls'));
    expect(conteudo).not.toHaveClass('is-expanded');

    fireEvent.click(botaoRanking());

    expect(itensRanking()).toHaveLength(14);
    expect(nomesRanking().at(-1)).toBe('Equipe 1');
    expect(itensRanking().map((li) => li.querySelector('.ranking-medal').textContent))
      .toEqual(Array.from({ length: 14 }, (_, i) => String(i + 1)));
    expect(botaoRanking()).toHaveTextContent('Mostrar menos');
    expect(botaoRanking()).toHaveAttribute('aria-expanded', 'true');
    // A lista completa fica no conteudo com altura limitada (CSS), dentro do proprio cartao.
    expect(conteudo).toHaveClass('is-expanded');
    expect(conteudo).toContainElement(itensRanking()[13]);

    fireEvent.click(botaoRanking());

    expect(nomesRanking()).toEqual(['Equipe 14', 'Equipe 13', 'Equipe 12', 'Equipe 11', 'Equipe 10']);
    expect(botaoRanking()).toHaveTextContent('Ver todas (14)');
    expect(conteudo).not.toHaveClass('is-expanded');
  });

  test('nenhuma equipe: estado vazio, sem lista e sem botao', async () => {
    await abrirPainel({ equipes: [], tarefas: [] });

    expect(within(painelRanking()).getByText('Nenhuma equipe cadastrada.')).toBeInTheDocument();
    expect(itensRanking()).toHaveLength(0);
    expect(botaoRanking()).toBeNull();
  });

  test('nenhuma tarefa concluida: mostra a atividade das equipes, sem posicoes nem percentuais', async () => {
    const equipes = [equipe('a', 'Antiga'), equipe('b', 'Beta'), equipe('c', 'Gama')];
    const tarefas = [...tarefasDe('a', { p: 1 }), ...tarefasDe('b', { a: 1, p: 2 }), ...tarefasDe('c', { a: 2 })];
    await abrirPainel({ equipes, tarefas });

    const painel = painelRanking();
    expect(within(painel).getByRole('heading', { name: 'Atividade das Equipes' })).toBeInTheDocument();
    expect(within(painel).queryByRole('heading', { name: 'Ranking de Equipes' })).toBeNull();
    expect(painel).toHaveTextContent('Nenhuma tarefa concluída ainda');
    expect(painel.querySelector('ol')).toBeNull();
    expect(nomesRanking()).toEqual(['Beta', 'Gama', 'Antiga']);
    expect(itensRanking()[0]).toHaveTextContent('3 tarefas · 1 em andamento · 2 pendentes');
    expect(itensRanking()[2]).toHaveTextContent('1 tarefa · 0 em andamento · 1 pendente');
    expect(itensRanking().map((li) => li.querySelector('.ranking-medal').textContent)).toEqual(['B', 'G', 'A']);
    expect(painel).not.toHaveTextContent('%');
    expect(painel).not.toHaveTextContent('concluídas de');
  });

  test('empates no ranking seguem criterios fixos, nao a ordem da API', async () => {
    const equipes = [equipe('1', 'Alfa'), equipe('2', 'Charlie'), equipe('3', 'Delta'), equipe('4', 'Bravo')];
    const tarefas = [
      ...tarefasDe('1', { c: 1, p: 1 }), // 1 de 2
      ...tarefasDe('2', { c: 2, p: 2 }), // 2 de 4
      ...tarefasDe('3', { c: 2 }), // 2 de 2
      ...tarefasDe('4', { c: 1, p: 1 }), // 1 de 2, empate total com Alfa
    ];
    await abrirPainel({ equipes, tarefas });

    expect(nomesRanking()).toEqual(['Delta', 'Charlie', 'Alfa', 'Bravo']);
  });

  test('equipes sem tarefas: fora do ranking, resumidas e listadas ao expandir', async () => {
    const equipes = [
      equipe('a', 'Com tarefas A'),
      equipe('b', 'Zulu vazia'),
      equipe('c', 'Com tarefas B'),
      equipe('d', 'Bravo vazia'),
      equipe('e', 'Mike vazia'),
    ];
    const tarefas = [...tarefasDe('a', { c: 1 }), ...tarefasDe('c', { c: 2 })];
    await abrirPainel({ equipes, tarefas });

    const painel = painelRanking();
    expect(nomesRanking()).toEqual(['Com tarefas B', 'Com tarefas A']);
    expect(painel).toHaveTextContent('3 equipes sem tarefas');
    expect(painel).not.toHaveTextContent('Zulu vazia');
    expect(botaoRanking()).toHaveTextContent('Ver todas (5)');

    fireEvent.click(botaoRanking());

    const semTarefas = within(painel).getByRole('heading', { name: 'Sem tarefas' }).nextElementSibling;
    expect([...semTarefas.querySelectorAll('li')].map((li) => li.textContent))
      .toEqual(['Bravo vazia', 'Mike vazia', 'Zulu vazia']);
    expect(nomesRanking()).toEqual(['Com tarefas B', 'Com tarefas A']);
    expect(painel).not.toHaveTextContent('3 equipes sem tarefas');
  });

  test('uma unica equipe, sem tarefas: mostra o nome direto, sem "Ver todas (1)"', async () => {
    await abrirPainel({ equipes: [equipe('a', 'Alfa')], tarefas: [] });

    const painel = painelRanking();
    expect(painel.querySelector('.ranking-vazio')).toHaveTextContent('Alfa ainda não tem tarefas.');
    expect(botaoRanking()).toBeNull();
    expect(painel).not.toHaveTextContent('equipe sem tarefas');
    expect(painel.querySelector('.ranking-sem-tarefas')).toBeNull();
    expect(itensRanking()).toHaveLength(0);
  });

  test('uma equipe com tarefas e uma sem: a sem tarefas ja aparece, sem clique', async () => {
    await abrirPainel({
      equipes: [equipe('a', 'Alfa'), equipe('b', 'Beta vazia')],
      tarefas: tarefasDe('a', { c: 1 }),
    });

    const painel = painelRanking();
    expect(nomesRanking()).toEqual(['Alfa']);
    expect([...painel.querySelectorAll('.ranking-sem-tarefas li')].map((li) => li.textContent)).toEqual(['Beta vazia']);
    expect(botaoRanking()).toBeNull();
    expect(painel).not.toHaveTextContent('1 equipe sem tarefas');
  });

  test('varias equipes sem tarefas e nenhuma com tarefas: resumo e "Ver todas / Mostrar menos" continuam', async () => {
    await abrirPainel({ equipes: [equipe('a', 'Alfa'), equipe('b', 'Beta'), equipe('c', 'Gama')], tarefas: [] });

    const painel = painelRanking();
    expect(painel).toHaveTextContent('Nenhuma equipe tem tarefas ainda.');
    expect(painel).toHaveTextContent('3 equipes sem tarefas');
    expect(painel.querySelector('.ranking-sem-tarefas')).toBeNull();
    expect(botaoRanking()).toHaveTextContent('Ver todas (3)');

    fireEvent.click(botaoRanking());

    expect([...painel.querySelectorAll('.ranking-sem-tarefas li')].map((li) => li.textContent)).toEqual(['Alfa', 'Beta', 'Gama']);
    expect(botaoRanking()).toHaveTextContent('Mostrar menos');

    fireEvent.click(botaoRanking());
    expect(painel.querySelector('.ranking-sem-tarefas')).toBeNull();
  });

  test('seis equipes com tarefas e uma sem: o botao segue para o ranking e a sem tarefas aparece uma vez', async () => {
    const comTarefas = Array.from({ length: 6 }, (_, i) => equipe(`t${i}`, `Equipe ${i + 1}`));
    await abrirPainel({
      equipes: [...comTarefas, equipe('z', 'Zulu vazia')],
      tarefas: comTarefas.flatMap(({ _id }, i) => tarefasDe(_id, { c: 6 - i })),
    });

    const semTarefas = () => [...painelRanking().querySelectorAll('.ranking-sem-tarefas li')].map((li) => li.textContent);
    expect(itensRanking()).toHaveLength(5);
    expect(semTarefas()).toEqual(['Zulu vazia']);
    expect(painelRanking()).not.toHaveTextContent('1 equipe sem tarefas');
    expect(botaoRanking()).toHaveTextContent('Ver todas (7)');

    fireEvent.click(botaoRanking());

    expect(itensRanking()).toHaveLength(6);
    expect(semTarefas()).toEqual(['Zulu vazia']);
    expect(botaoRanking()).toHaveTextContent('Mostrar menos');
  });

  test('equipes com o mesmo nome continuam separadas, sem aviso de chave do React', async () => {
    const erros = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const equipes = Array.from({ length: 7 }, (_, i) => equipe(`id-${i}`, i < 2 ? 'Repetida' : `Equipe ${i}`));
      await abrirPainel({ equipes, tarefas: equipes.flatMap(({ _id }) => tarefasDe(_id, { c: 1 })) });
      fireEvent.click(botaoRanking());

      expect(nomesRanking().filter((nome) => nome === 'Repetida')).toHaveLength(2);
      expect(new Set(itensRanking().map((li) => li.dataset.equipeId)).size).toBe(7);
      const mensagens = erros.mock.calls.map((chamada) => chamada.map(String).join(' ')).join('\n');
      expect(mensagens).not.toMatch(/unique "key"|same key/);
    } finally {
      erros.mockRestore();
    }
  });
});

describe('indicadores e grafico preservados', () => {
  const dados = () => {
    const equipes = [equipe('a', 'Alfa'), equipe('b', 'Beta'), equipe('c', 'Gama')];
    const tarefas = [
      tarefa('a', 'concluido', 120),
      tarefa('a', 'pendente', 6),
      tarefa('b', 'em_andamento', 500),
      tarefa('b', 'pendente'),
      tarefa('b', 'pendente', 20),
    ];
    return { equipes, tarefas };
  };

  // Fase 2: "Equipes Operando" virou "Equipes Vinculadas" e o tempo passou de "646m" para horas e minutos;
  // os calculos (contagem de equipes, total, concluidas e soma do tempo) continuam os mesmos.
  test('os indicadores mantem os mesmos calculos', async () => {
    await abrirPainel(dados());

    expect(indicador('Equipes Vinculadas')).toBe('3');
    expect(indicador('Total de Tarefas')).toBe('5');
    expect(indicador('Tarefas Concluídas')).toBe('1');
    expect(indicador('Tempo Investido')).toBe('10h 46min');
  });

  test('o grafico recebe os mesmos dados, sem legenda e com altura controlada pelo conteiner', async () => {
    await abrirPainel(dados());

    expect(grafico.props.data).toEqual({
      labels: ['Pendente', 'Em Andamento', 'Concluído'],
      datasets: [{
        label: 'Quantidade de Tarefas',
        data: [3, 1, 1],
        backgroundColor: ['rgba(255, 51, 102, 0.8)', 'rgba(251, 192, 45, 0.8)', 'rgba(0, 212, 141, 0.8)'],
        borderRadius: 6,
      }],
    });
    expect(grafico.props.options).toMatchObject({
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: { y: { beginAtZero: true, ticks: { stepSize: 1 } } },
    });
    expect(screen.getByTestId('grafico-status').parentElement).toHaveClass('chart-area');
    expect(screen.getByRole('heading', { name: 'Visão Geral de Produtividade' })).toBeInTheDocument();
  });

  test('expandir o ranking nao altera os dados do grafico nem os indicadores', async () => {
    await abrirPainel(quatorzeEquipes());
    const antes = grafico.props.data;

    fireEvent.click(botaoRanking());

    expect(grafico.props.data).toEqual(antes);
    expect(indicador('Equipes Vinculadas')).toBe('14');
    expect(indicador('Total de Tarefas')).toBe(String(quatorzeEquipes().tarefas.length));
  });
});

// O jsdom nao calcula layout: estes testes travam no CSS a correcao da causa do espaco vazio
// (cartao esticado + conteudo centralizado + grafico com proporcao fixa). Conferido no navegador a parte.
describe('contrato de layout do Painel Geral (CSS)', () => {
  // Lido do disco (o URL global do jsdom nao serve para o fs); CRLF normalizado para o checkout no Windows.
  const estilos = readFileSync(join(import.meta.dirname, '../../styles/pages/dashboard/DashboardGeral.css'), 'utf8')
    .replace(/\r\n/g, '\n');
  const escapar = (texto) => texto.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Regra de nivel superior (fora de @media): o seletor comeca no inicio da linha.
  const regra = (seletor) => (estilos.match(new RegExp(`(?:^|\\n)${escapar(seletor)}\\s*\\{([^}]*)\\}`)) || [])[1] ?? null;
  const seletores = () => [...estilos.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{/g)]
    .map(([, s]) => s.trim())
    .filter((s) => !s.startsWith('@'))
    .flatMap((s) => s.split(',').map((parte) => parte.trim()));

  test('grafico e ranking em grade 2fr / 1fr, cada cartao com a propria altura', () => {
    const grade = regra('.dashboard-geral .dashboard-grid');

    expect(grade).toMatch(/display:\s*grid/);
    expect(grade).toMatch(/align-items:\s*start/);
    expect(grade).toMatch(/grid-template-columns:\s*minmax\(0,\s*2fr\)\s*minmax\(\d+px,\s*1fr\)/);
  });

  test('o grafico tem altura fixa no conteiner e o cartao nao centraliza o conteudo', () => {
    expect(regra('.dashboard-geral .chart-area')).toMatch(/height:\s*\d+px/);
    expect(regra('.dashboard-geral .big-chart')).not.toMatch(/justify-content:\s*center/);
    expect(estilos).not.toMatch(/(?:^|\n)\.big-chart\s*\{/);
  });

  test('a lista expandida rola dentro do cartao, com altura maxima', () => {
    const expandida = regra('.dashboard-geral .ranking-conteudo.is-expanded');

    expect(expandida).toMatch(/max-height:\s*\d+px/);
    expect(expandida).toMatch(/overflow-y:\s*auto/);
  });

  test('estilos novos ficam restritos ao Painel Geral; .dashboard-header compartilhada nao muda', () => {
    const novos = /cards-container|summary-card|dashboard-grid|big-chart|chart-area|painel-|ranking-|header-search|header-profile|profile-info|filtro-|botao-|kpi-|entrega|aviso-|girando|chart-vazio|card\.red/;
    const fora = seletores().filter((s) => novos.test(s) && !s.startsWith('.dashboard-geral '));
    // .header-profile/.profile-info ja existiam sem escopo e nao foram alterados (a busca .header-search saiu na Fase 2).
    expect(fora).toEqual(['.header-profile', '.profile-info']);

    expect(regra('.dashboard-header')).toBe(`
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 30px;
  padding-bottom: 20px;
  border-bottom: 1px solid var(--border-color);
`);
  });
});
