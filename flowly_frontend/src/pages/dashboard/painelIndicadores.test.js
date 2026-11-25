// Regras do Painel Geral (PR #63): indicadores, participantes unicos, entregas, pontos de atencao e links.
import {
  calcularPainel,
  contarParticipantes,
  distribuicaoStatus,
  linkTarefas,
  listarAtrasadas,
  listarPontosAtencao,
  listarProximosSeteDias,
  periodoProximosSeteDias,
  DESTINOS,
} from './painelIndicadores';
import { filtrarTarefas, lerFiltrosTarefas } from '../admin/adminFiltrosUtils';

const HOJE = '2026-11-17';
const entrega = (dia) => `${dia}T00:00:00.000Z`;
let seq = 0;
const tarefa = (status, dia, extra = {}) => ({
  _id: (seq += 1).toString(16).padStart(24, '0'),
  descricao: `Tarefa ${seq}`,
  status,
  dataEntrega: dia === null ? null : entrega(dia),
  equipe: { _id: 'e1', nome: 'Alfa' },
  user: null,
  tempoGasto: 0,
  ...extra,
});
const ANA = { _id: 'u1', nome: 'Ana' };

describe('participantes unicos', () => {
  test('deduplica por id entre equipes e exclui administradores quando todos trazem o tipo', () => {
    const equipes = [
      { membros: [{ _id: 'adm', tipo: 'admin' }, { _id: 'u1', tipo: 'user' }, { _id: 'u2', tipo: 'user' }] },
      { membros: [{ _id: 'adm', tipo: 'admin' }, { _id: 'u1', tipo: 'user' }] },
      { membros: [] },
    ];
    expect(contarParticipantes(equipes)).toEqual({ modo: 'colaboradores', total: 2, participantes: 3 });
  });

  test('algum participante sem tipo (ou so com o id): conta participantes, sem adivinhar quem e admin', () => {
    expect(contarParticipantes([{ membros: [{ _id: 'adm', nome: 'Admin' }, { _id: 'u1', tipo: 'user' }] }]))
      .toEqual({ modo: 'participantes', total: 2, participantes: 2 });
    expect(contarParticipantes([{ membros: ['u1', 'u2'] }, { membros: ['u2'] }]))
      .toEqual({ modo: 'participantes', total: 2, participantes: 2 });
  });

  test('o mesmo id com tipo em uma equipe e sem em outra usa o tipo conhecido', () => {
    expect(contarParticipantes([{ membros: ['u1'] }, { membros: [{ _id: 'u1', tipo: 'user' }] }]))
      .toEqual({ modo: 'colaboradores', total: 1, participantes: 1 });
  });

  test('sem equipes ou membros malformados: zero, sem erro', () => {
    expect(contarParticipantes([])).toEqual({ modo: 'colaboradores', total: 0, participantes: 0 });
    expect(contarParticipantes([{ membros: null }, null, { membros: [null, '', { nome: 'sem id' }] }]))
      .toEqual({ modo: 'colaboradores', total: 0, participantes: 0 });
  });
});

describe('indicadores', () => {
  const tarefas = () => [
    tarefa('pendente', '2026-11-10'), // atrasada + sem responsavel + backlog (sobrepostos)
    tarefa('pendente', '2026-11-17', { user: ANA }), // vence hoje: nao atrasada
    tarefa('em_andamento', '2026-11-18'), // sem responsavel, fora do backlog
    tarefa('concluido', '2026-10-01'), // concluida vencida: nunca atrasada
    tarefa('concluido', null, { user: ANA }),
    tarefa('pendente', null, { dataEntrega: 'amanha' }), // prazo invalido: sem prazo, mas no backlog
    tarefa('arquivada', '2026-11-20', { user: ANA }), // status desconhecido
  ];

  test('contagens exatas e recortes sobrepostos sem soma', () => {
    const ind = calcularPainel([{ _id: 'e1', nome: 'Alfa', membros: [] }, { _id: 'e2', nome: 'Vazia', membros: [] }], tarefas(), HOJE);
    expect(ind).toMatchObject({
      equipes: 2,
      equipesComTarefas: 1,
      equipesSemTarefas: 1,
      totalTarefas: 7,
      concluidas: 2,
      emAberto: 5,
      percentualConcluido: 29,
      pendentes: 3,
      emAndamento: 1,
      statusDesconhecido: 1,
      atrasadas: 1,
      semResponsavel: 4, // inclui a concluida vencida sem responsavel; backlog so pendentes
      backlog: 2,
      vencemHoje: 1,
      proximos7: 3, // hoje (pendente), 18 (em andamento) e 20 (status desconhecido nao e concluida)
    });
  });

  test('sem tarefas: zeros reais e percentual sem divisao por zero', () => {
    const ind = calcularPainel([], [], HOJE);
    expect(ind).toMatchObject({ totalTarefas: 0, percentualConcluido: 0, backlog: 0, tempoFormatado: '0min' });
    expect(distribuicaoStatus(ind).map((i) => i.percentual)).toEqual([0, 0, 0]);
  });

  test('distribuicao: tres status oficiais com percentual sobre o total', () => {
    const ind = calcularPainel([], tarefas(), HOJE);
    expect(distribuicaoStatus(ind).map(({ chave, valor, percentual }) => [chave, valor, percentual]))
      .toEqual([['pendente', 3, 43], ['em_andamento', 1, 14], ['concluido', 2, 29]]);
  });

  test('cada indicador conta o mesmo recorte que o link abre na pagina de tarefas (regras do PR #62)', () => {
    const lista = tarefas();
    const ind = calcularPainel([], lista, HOJE);
    const naPagina = (destino) => {
      const url = new URL(linkTarefas('', destino), 'http://x');
      const { filtros } = lerFiltrosTarefas(url.searchParams, null);
      return filtrarTarefas(lista, filtros, { hoje: HOJE, agora: Date.parse('2026-11-17T13:00:00Z') }).length;
    };
    expect(naPagina(DESTINOS.concluidas)).toBe(ind.concluidas);
    expect(naPagina(DESTINOS.pendentes)).toBe(ind.pendentes);
    expect(naPagina(DESTINOS.emAndamento)).toBe(ind.emAndamento);
    expect(naPagina(DESTINOS.atrasadas)).toBe(ind.atrasadas);
    expect(naPagina(DESTINOS.semResponsavel)).toBe(ind.semResponsavel);
    expect(naPagina(DESTINOS.backlog)).toBe(ind.backlog);
    expect(naPagina(DESTINOS.vencemHoje)).toBe(ind.vencemHoje);
    expect(naPagina(DESTINOS.proximos7)).toBe(ind.proximos7);
    expect(naPagina(DESTINOS.todas)).toBe(ind.totalTarefas);
  });
});

describe('entregas', () => {
  test('atrasadas: nao concluidas antes de hoje, mais antigas primeiro, limite e total', () => {
    const lista = [
      tarefa('pendente', '2026-11-16', { descricao: 'Ontem' }),
      tarefa('em_andamento', '2026-05-01', { descricao: 'Maio' }),
      tarefa('concluido', '2026-04-01', { descricao: 'Concluida' }),
      tarefa('pendente', '2026-11-17', { descricao: 'Hoje' }),
      tarefa('pendente', null, { descricao: 'Sem prazo' }),
    ];
    const { total, itens } = listarAtrasadas(lista, HOJE, 1);
    expect(total).toBe(2);
    expect(itens.map((i) => [i.descricao, i.diasAtraso, i.prazo])).toEqual([['Maio', 200, 'Venceu há 200 dias']]);
  });

  test('proximos 7 dias: de hoje ate hoje + 7 inclusive, mesma regra do filtro prazo=7dias', () => {
    const lista = ['2026-11-16', '2026-11-17', '2026-11-24', '2026-11-25'].map((dia) => tarefa('pendente', dia, { descricao: dia }));
    lista.push(tarefa('concluido', '2026-11-18', { descricao: 'concluida' }));
    const { total, itens } = listarProximosSeteDias(lista, HOJE);
    expect(total).toBe(2);
    expect(itens.map((i) => [i.descricao, i.venceHoje, i.atrasada])).toEqual([['2026-11-17', true, false], ['2026-11-24', false, false]]);
  });

  test('America/Sao_Paulo: meia-noite UTC continua no dia gravado; o "hoje" e o dia civil local', () => {
    // 23:30 de 24/11 em Sao Paulo = 02:30 UTC de 25/11: o "hoje" de quem olha e 24.
    const hojeSaoPaulo = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' })
      .format(Date.parse('2026-11-25T02:30:00.000Z'));
    expect(hojeSaoPaulo).toBe('2026-11-24');
    const lista = [tarefa('pendente', '2026-11-24', { descricao: 'Do dia 24' })];
    expect(listarAtrasadas(lista, hojeSaoPaulo).total).toBe(0);
    expect(listarProximosSeteDias(lista, hojeSaoPaulo).itens[0]).toMatchObject({ data: '24/11/2026', venceHoje: true });
  });

  test('id nao confiavel nao gera "Ver detalhes"; dados ausentes nao sao inventados', () => {
    const { itens } = listarProximosSeteDias([{ status: 'pendente', dataEntrega: entrega('2026-11-18') }], HOJE);
    expect(itens[0]).toMatchObject({ abrivel: false, descricao: 'Tarefa sem descrição', equipe: 'Equipe não informada' });
  });

  test('periodo dos proximos 7 dias atravessa o mes corretamente', () => {
    expect(periodoProximosSeteDias('2026-11-28')).toEqual({ inicio: '28/11/2026', fim: '05/12/2026' });
    expect(periodoProximosSeteDias('2026-12-30')).toEqual({ inicio: '30/12/2026', fim: '06/01/2027' });
  });
});

describe('links e pontos de atencao', () => {
  test('linkTarefas segue o contrato do PR #62 e preserva a equipe selecionada', () => {
    const EQ = 'a'.repeat(24);
    expect(linkTarefas('', DESTINOS.todas)).toBe('/admin/tarefas');
    expect(linkTarefas(EQ, DESTINOS.concluidas)).toBe(`/admin/tarefas?equipe=${EQ}&status=concluido`);
    expect(linkTarefas(EQ, DESTINOS.backlog)).toBe(`/admin/tarefas?equipe=${EQ}&backlog=1`);
    expect(linkTarefas('', DESTINOS.semResponsavel)).toBe('/admin/tarefas?semResponsavel=1');
    expect(linkTarefas('', DESTINOS.proximos7)).toBe('/admin/tarefas?prazo=7dias');
    expect(linkTarefas('', DESTINOS.vencemHoje)).toBe('/admin/tarefas?prazo=hoje');
  });

  test('pontos de atencao: so os que existem; sem responsavel com o total real e a parte do backlog no texto', () => {
    const base = { atrasadas: 0, vencemHoje: 0, backlog: 0, semResponsavel: 0, equipesSemTarefas: 0 };
    expect(listarPontosAtencao(base)).toEqual([]);
    const pontos = listarPontosAtencao({ ...base, backlog: 3, semResponsavel: 5, equipesSemTarefas: 1 }, { filtrando: true });
    expect(pontos.map((p) => [p.chave, p.texto])).toEqual([
      ['semResponsavel', '5 tarefas sem responsável, sendo 3 disponíveis no backlog'],
      ['equipesSemTarefas', 'Esta equipe ainda não tem tarefas'],
    ]);
    expect(listarPontosAtencao({ ...base, semResponsavel: 1 })[0].texto).toBe('1 tarefa sem responsável');
    expect(listarPontosAtencao({ ...base, semResponsavel: 2, backlog: 1 })[0].texto)
      .toBe('2 tarefas sem responsável, sendo 1 disponível no backlog');
  });

  test('a quantidade de cada ponto de atencao e a mesma que a lista filtrada do link mostra', () => {
    const lista = [
      tarefa('pendente', '2026-11-10'), // atrasada, sem responsavel, backlog
      tarefa('pendente', '2026-11-17'), // vence hoje, sem responsavel, backlog
      tarefa('em_andamento', '2026-11-12'), // atrasada, sem responsavel (fora do backlog)
      tarefa('concluido', '2026-11-01'), // sem responsavel (fora do backlog), nao atrasada
      tarefa(null, '2026-11-20'), // status null: sem responsavel, fora do backlog
      tarefa('pendente', '2026-11-17', { user: ANA }), // vence hoje, com responsavel
    ];
    const ind = calcularPainel([], lista, HOJE);
    const pontos = listarPontosAtencao(ind);
    const naPagina = (destino) => {
      const url = new URL(linkTarefas('', destino), 'http://x');
      const { filtros } = lerFiltrosTarefas(url.searchParams, null);
      return filtrarTarefas(lista, filtros, { hoje: HOJE, agora: Date.parse('2026-11-17T13:00:00Z') }).length;
    };
    expect(pontos.map((p) => p.chave)).toEqual(['atrasadas', 'vencemHoje', 'semResponsavel']);
    pontos.forEach((ponto) => expect(naPagina(ponto.destino)).toBe(ponto.quantidade));
    expect(pontos.find((p) => p.chave === 'semResponsavel').texto).toBe('5 tarefas sem responsável, sendo 2 disponíveis no backlog');
  });
});
