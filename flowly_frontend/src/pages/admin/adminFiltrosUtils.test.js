// Regras de pesquisa, filtros, ordenacao e parametros de URL das paginas administrativas.
import {
  ATRIBUICAO_BACKLOG,
  ATRIBUICAO_SEM_RESPONSAVEL,
  FILTROS_TAREFAS_PADRAO,
  contarTarefasPorEquipe,
  correspondeAtividade,
  correspondeBusca,
  equipesComFiltroAtivo,
  correspondeCriacao,
  correspondePrazo,
  filtrarEquipes,
  filtrarTarefas,
  formatarDataCriacao,
  formatarPrazo,
  lerFiltrosEquipes,
  lerFiltrosTarefas,
  normalizarBusca,
  opcoesDeEquipe,
  opcoesDeResponsavel,
  rotuloStatus,
  rotuloUrgencia,
  serializarFiltrosEquipes,
  serializarFiltrosTarefas,
  situacaoPrazo,
} from './adminFiltrosUtils';

const oid = (n) => n.toString(16).padStart(24, '0');
const AGORA = Date.parse('2026-11-25T15:00:00.000Z');
const HOJE = '2026-11-25';
const DIA = 24 * 60 * 60 * 1000;
const ids = (lista) => lista.map((item) => item._id);
const tarefasPadrao = (mudancas) => ({ ...FILTROS_TAREFAS_PADRAO, ...mudancas });

describe('busca textual', () => {
  test('ignora maiusculas, acentos e espacos extras', () => {
    expect(normalizarBusca('  Revisão   de CÓDIGO ')).toBe('revisao de codigo');
    expect(correspondeBusca(['Revisão de código'], 'REVISAO')).toBe(true);
    expect(correspondeBusca(['João Ávila'], 'joao avila')).toBe(true);
  });

  test('cada termo precisa aparecer em algum campo; busca vazia aceita tudo', () => {
    expect(correspondeBusca(['Corrigir login', 'Desenvolvimento'], 'login desenv')).toBe(true);
    expect(correspondeBusca(['Corrigir login', 'Desenvolvimento'], 'login qualidade')).toBe(false);
    expect(correspondeBusca([null, undefined], '')).toBe(true);
    expect(correspondeBusca([null, undefined], 'x')).toBe(false);
  });
});

describe('data de criacao (createdAt)', () => {
  test('limites explicitos por instante: 7 e 30 dias inclusivos, "mais de 30" estrito', () => {
    const exatamente7 = new Date(AGORA - 7 * DIA).toISOString();
    const umMsAntes7 = new Date(AGORA - 7 * DIA - 1).toISOString();
    expect(correspondeCriacao(exatamente7, '7dias', AGORA)).toBe(true);
    expect(correspondeCriacao(umMsAntes7, '7dias', AGORA)).toBe(false);
    expect(correspondeCriacao(umMsAntes7, '30dias', AGORA)).toBe(true);
    const exatamente30 = new Date(AGORA - 30 * DIA).toISOString();
    expect(correspondeCriacao(exatamente30, '30dias', AGORA)).toBe(true);
    expect(correspondeCriacao(exatamente30, 'mais30dias', AGORA)).toBe(false);
    expect(correspondeCriacao(new Date(AGORA - 30 * DIA - 1).toISOString(), 'mais30dias', AGORA)).toBe(true);
  });

  test('sem data ou data invalida: so aparece em "Todas"', () => {
    [undefined, null, '', 'ontem', '2026-13-40T00:00:00Z'].forEach((valor) => {
      expect(correspondeCriacao(valor, '', AGORA)).toBe(true);
      ['7dias', '30dias', 'mais30dias'].forEach((filtro) => expect(correspondeCriacao(valor, filtro, AGORA)).toBe(false));
    });
  });

  test('formatacao no fuso de quem olha: 01:30 UTC do dia 25 e dia 24 em America/Sao_Paulo', () => {
    expect(formatarDataCriacao('2026-11-25T01:30:00.000Z', undefined, 'America/Sao_Paulo')).toBe('24/11/2026');
    expect(formatarDataCriacao('2026-11-25T03:00:00.000Z', undefined, 'America/Sao_Paulo')).toBe('25/11/2026');
    expect(formatarDataCriacao(undefined)).toBe('Data de criação indisponível');
    expect(formatarDataCriacao('invalida', 'sem data')).toBe('sem data');
  });
});

describe('equipes', () => {
  const equipes = [
    { _id: oid(1), nome: 'Desenvolvimento', createdAt: '2026-11-24T12:00:00.000Z', membros: [{ _id: oid(11), nome: 'Ana Souza', email: 'ana@exemplo.com' }] },
    { _id: oid(2), nome: 'Qualidade e Validação', createdAt: '2026-11-10T12:00:00.000Z', membros: [{ _id: oid(12), nome: 'João Ávila', email: 'joao@exemplo.com' }] },
    { _id: oid(3), nome: 'arquivo', createdAt: '2026-05-01T12:00:00.000Z', membros: [] },
    { _id: oid(4), nome: 'Sem Data', membros: [] },
    { _id: oid(5), nome: 'Beta', createdAt: '2026-11-24T12:00:00.000Z', membros: [] },
  ];
  const filtrar = (mudancas) => ids(filtrarEquipes(equipes, { busca: '', criacao: '', ordem: 'recentes', ...mudancas }, AGORA));

  test('pesquisa por nome, participante e e-mail, sem acento', () => {
    expect(filtrar({ busca: 'validacao' })).toEqual([oid(2)]);
    expect(filtrar({ busca: 'joão' })).toEqual([oid(2)]);
    expect(filtrar({ busca: 'ANA@EXEMPLO' })).toEqual([oid(1)]);
    expect(filtrar({ busca: 'ninguem' })).toEqual([]);
  });

  test('ordenacao por data com desempate pelo nome; sem data sempre no fim', () => {
    expect(filtrar({ ordem: 'recentes' })).toEqual([oid(5), oid(1), oid(2), oid(3), oid(4)]);
    expect(filtrar({ ordem: 'antigas' })).toEqual([oid(3), oid(2), oid(5), oid(1), oid(4)]);
  });

  test('ordenacao por nome sem diferenca de maiusculas', () => {
    expect(filtrar({ ordem: 'nomeAZ' })).toEqual([oid(3), oid(5), oid(1), oid(2), oid(4)]);
    expect(filtrar({ ordem: 'nomeZA' })).toEqual([oid(4), oid(2), oid(1), oid(5), oid(3)]);
  });

  test('filtros de criacao', () => {
    expect(filtrar({ criacao: '7dias' })).toEqual([oid(5), oid(1)]);
    expect(filtrar({ criacao: '30dias' })).toEqual([oid(5), oid(1), oid(2)]);
    expect(filtrar({ criacao: 'mais30dias' })).toEqual([oid(3)]);
  });

  test('parametros: validos sao lidos, invalidos ignorados e o padrao some da URL', () => {
    const lido = lerFiltrosEquipes(new URLSearchParams('q=%20dev%20&criacao=7dias&ordem=nomeZA'));
    expect(lido).toEqual({ filtros: { busca: 'dev', criacao: '7dias', atividade: '', ordem: 'nomeZA' }, invalidos: [] });
    const invalido = lerFiltrosEquipes(new URLSearchParams('criacao=ontem&atividade=talvez&ordem=aleatoria'));
    expect(invalido.filtros).toEqual({ busca: '', criacao: '', atividade: '', ordem: 'recentes' });
    expect(invalido.invalidos).toEqual(['data de criação', 'atividade', 'ordenação']);
    expect(serializarFiltrosEquipes({ busca: '', criacao: '', ordem: 'recentes' }).toString()).toBe('');
    expect(serializarFiltrosEquipes({ busca: 'ana', criacao: '30dias', ordem: 'antigas' }).toString())
      .toBe('q=ana&criacao=30dias&ordem=antigas');
    expect(lerFiltrosEquipes(new URLSearchParams('atividade=sem')).filtros.atividade).toBe('sem');
    expect(serializarFiltrosEquipes({ busca: '', criacao: '', atividade: 'com', ordem: 'recentes' }).toString()).toBe('atividade=com');
  });

  test('pesquisa tambem pela descricao opcional (equipes antigas sem o campo continuam aparecendo)', () => {
    const comDescricao = [...equipes, { _id: oid(6), nome: 'Suporte', descricao: 'Atendimento ao cliente', membros: [] }];
    expect(ids(filtrarEquipes(comDescricao, { busca: 'atendimento', criacao: '', ordem: 'recentes' }, AGORA))).toEqual([oid(6)]);
    expect(filtrarEquipes(comDescricao, { busca: '', criacao: '', ordem: 'recentes' }, AGORA)).toHaveLength(6);
  });
});

describe('equipes por atividade (com ou sem tarefas)', () => {
  const equipes = [
    { _id: oid(1), nome: 'Alfa', membros: [] },
    { _id: oid(2), nome: 'Beta', membros: [] },
    { _id: oid(3), nome: 'Gama', membros: [] },
  ];
  const tarefas = [
    { _id: 't1', equipe: { _id: oid(1), nome: 'Alfa' } },
    { _id: 't2', equipe: oid(1) },
    { _id: 't3', equipe: { _id: oid(3) } },
    { _id: 't4', equipe: null },
  ];
  const filtrar = (atividade, contagem) =>
    ids(filtrarEquipes(equipes, { busca: '', criacao: '', atividade, ordem: 'nomeAZ' }, AGORA, contagem));

  test('conta as tarefas por equipe, com equipe populada ou so o id', () => {
    const contagem = contarTarefasPorEquipe(tarefas);
    expect([...contagem]).toEqual([[oid(1), 2], [oid(3), 1]]);
  });

  test('com tarefas, sem tarefas e todas', () => {
    const contagem = contarTarefasPorEquipe(tarefas);
    expect(filtrar('com', contagem)).toEqual([oid(1), oid(3)]);
    expect(filtrar('sem', contagem)).toEqual([oid(2)]);
    expect(filtrar('', contagem)).toEqual([oid(1), oid(2), oid(3)]);
  });

  test('lista sem tarefas e diferente de dados indisponiveis: indisponivel nao classifica ninguem como sem tarefas', () => {
    expect(filtrar('sem', contarTarefasPorEquipe([]))).toEqual([oid(1), oid(2), oid(3)]);
    expect(contarTarefasPorEquipe(undefined)).toBeNull();
    expect(contarTarefasPorEquipe({ erro: 'x' })).toBeNull();
    expect(filtrar('sem', null)).toEqual([oid(1), oid(2), oid(3)]);
    expect(filtrar('com', null)).toEqual([oid(1), oid(2), oid(3)]);
    expect(correspondeAtividade(equipes[1], 'sem', null)).toBe(true);
  });

  test('o filtro conta como ativo (Limpar filtros aparece)', () => {
    expect(equipesComFiltroAtivo({ busca: '', criacao: '', atividade: 'sem' })).toBe(true);
    expect(equipesComFiltroAtivo({ busca: '', criacao: '', atividade: '' })).toBe(false);
  });
});

describe('prazo das tarefas', () => {
  const tarefa = (dataEntrega, status = 'pendente') => ({ dataEntrega, status });

  test('vence hoje nao esta atrasada; ontem esta; concluida vencida nunca esta atrasada', () => {
    expect(correspondePrazo(tarefa('2026-11-25T00:00:00.000Z'), 'hoje', HOJE)).toBe(true);
    expect(correspondePrazo(tarefa('2026-11-25T00:00:00.000Z'), 'atrasadas', HOJE)).toBe(false);
    expect(correspondePrazo(tarefa('2026-11-24T00:00:00.000Z'), 'atrasadas', HOJE)).toBe(true);
    expect(correspondePrazo(tarefa('2026-11-24T00:00:00.000Z', 'concluido'), 'atrasadas', HOJE)).toBe(false);
    expect(situacaoPrazo(tarefa('2026-11-24T00:00:00.000Z', 'concluido'), HOJE)).toBeNull();
    expect(situacaoPrazo(tarefa('2026-11-24T00:00:00.000Z'), HOJE)).toBe('atrasada');
    expect(situacaoPrazo(tarefa('2026-11-25T00:00:00.000Z'), HOJE)).toBe('hoje');
  });

  test('proximos 7 e 30 dias incluem hoje e o ultimo dia; passado e concluidas ficam fora', () => {
    expect(correspondePrazo(tarefa('2026-11-25T00:00:00.000Z'), '7dias', HOJE)).toBe(true);
    expect(correspondePrazo(tarefa('2026-12-02T00:00:00.000Z'), '7dias', HOJE)).toBe(true);
    expect(correspondePrazo(tarefa('2026-12-03T00:00:00.000Z'), '7dias', HOJE)).toBe(false);
    expect(correspondePrazo(tarefa('2026-12-25T00:00:00.000Z'), '30dias', HOJE)).toBe(true);
    expect(correspondePrazo(tarefa('2026-12-26T00:00:00.000Z'), '30dias', HOJE)).toBe(false);
    expect(correspondePrazo(tarefa('2026-11-24T00:00:00.000Z'), '7dias', HOJE)).toBe(false);
    expect(correspondePrazo(tarefa('2026-11-26T00:00:00.000Z', 'concluido'), '7dias', HOJE)).toBe(false);
  });

  test('datas ausentes ou invalidas: so em "Sem prazo", sem calculo errado', () => {
    [undefined, null, '', 'amanha', '2026-02-30T00:00:00.000Z', 12345].forEach((valor) => {
      expect(correspondePrazo(tarefa(valor), 'semPrazo', HOJE)).toBe(true);
      ['atrasadas', 'hoje', '7dias', '30dias'].forEach((filtro) => expect(correspondePrazo(tarefa(valor), filtro, HOJE)).toBe(false));
      expect(situacaoPrazo(tarefa(valor), HOJE)).toBeNull();
      expect(formatarPrazo(tarefa(valor))).toBe('Sem prazo');
    });
  });

  test('America/Sao_Paulo: meia-noite UTC mantem o dia gravado e o "hoje" e o dia civil local', () => {
    // 23:30 do dia 24 em Sao Paulo (02:30 UTC do dia 25): o "hoje" de quem olha e 24.
    const instante = Date.parse('2026-11-25T02:30:00.000Z');
    const partes = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' })
      .format(instante);
    expect(partes).toBe('2026-11-24');
    const gravadaDia24 = tarefa('2026-11-24T00:00:00.000Z');
    expect(formatarPrazo(gravadaDia24)).toBe('24/11/2026');
    expect(correspondePrazo(gravadaDia24, 'hoje', partes)).toBe(true);
    expect(correspondePrazo(gravadaDia24, 'atrasadas', partes)).toBe(false);
    // Data com horario de Sao Paulo (-03:00) tambem e lida pelo dia escrito, sem converter para UTC.
    expect(formatarPrazo(tarefa('2026-11-24T21:00:00-03:00'))).toBe('24/11/2026');
  });
});

describe('tarefas: filtros combinados e ordenacao', () => {
  const EQ_DEV = oid(1);
  const EQ_QA = oid(2);
  const ANA = oid(11);
  const BRUNO = oid(12);
  const tarefas = [
    { _id: oid(101), descricao: 'Corrigir login', detalhes: 'Erro no token', status: 'pendente', urgencia: 'alta', dataEntrega: '2026-11-24T00:00:00.000Z', createdAt: '2026-11-24T10:00:00.000Z', equipe: { _id: EQ_DEV, nome: 'Desenvolvimento' }, user: { _id: ANA, nome: 'Ana Souza' } },
    { _id: oid(102), descricao: 'Revisão de código', status: 'em_andamento', urgencia: 'media', dataEntrega: '2026-11-25T00:00:00.000Z', createdAt: '2026-11-20T10:00:00.000Z', equipe: { _id: EQ_DEV, nome: 'Desenvolvimento' }, user: { _id: BRUNO, nome: 'Bruno Lima' } },
    { _id: oid(103), descricao: 'Testes de regressão', status: 'pendente', urgencia: 'alta', dataEntrega: '2026-11-28T00:00:00.000Z', createdAt: '2026-11-23T10:00:00.000Z', equipe: { _id: EQ_QA, nome: 'Qualidade' }, user: null },
    { _id: oid(104), descricao: 'Relatório final', status: 'em_andamento', urgencia: 'baixa', dataEntrega: '2026-12-20T00:00:00.000Z', createdAt: '2026-10-01T10:00:00.000Z', equipe: { _id: EQ_QA, nome: 'Qualidade' } },
    { _id: oid(105), descricao: 'Documentação antiga', status: 'concluido', urgencia: 'baixa', dataEntrega: '2026-05-01T00:00:00.000Z', createdAt: '2026-05-01T10:00:00.000Z', equipe: { _id: EQ_DEV, nome: 'Desenvolvimento' }, user: { _id: ANA, nome: 'Ana Souza' } },
    { _id: oid(106), descricao: 'Ajustar layout', status: 'pendente', urgencia: 'urgentissima', dataEntrega: null, equipe: { _id: EQ_QA, nome: 'Qualidade' }, user: { _id: BRUNO, nome: 'Bruno Lima' } },
  ];
  const filtrar = (mudancas) => ids(filtrarTarefas(tarefas, tarefasPadrao(mudancas), { hoje: HOJE, agora: AGORA }));

  test('pesquisa por titulo, detalhes, equipe e responsavel', () => {
    expect(filtrar({ busca: 'revisao' })).toEqual([oid(102)]);
    expect(filtrar({ busca: 'REGRESSÃO' })).toEqual([oid(103)]);
    expect(filtrar({ busca: 'token' })).toEqual([oid(101)]);
    expect(filtrar({ busca: 'qualidade' })).toEqual([oid(103), oid(104), oid(106)]);
    expect(filtrar({ busca: 'bruno' })).toEqual([oid(102), oid(106)]);
  });

  test('filtros combinados: equipe + status + urgencia + prazo', () => {
    expect(filtrar({ equipe: EQ_DEV, status: 'pendente', urgencia: 'alta', prazo: 'atrasadas' })).toEqual([oid(101)]);
    expect(filtrar({ equipe: EQ_DEV, status: 'pendente', urgencia: 'alta', prazo: '7dias' })).toEqual([]);
    expect(filtrar({ status: 'concluido' })).toEqual([oid(105)]);
    expect(filtrar({ urgencia: 'baixa' })).toEqual([oid(104), oid(105)]);
    expect(filtrar({ prazo: 'hoje' })).toEqual([oid(102)]);
    expect(filtrar({ prazo: 'semPrazo' })).toEqual([oid(106)]);
    expect(filtrar({ criacao: '7dias' })).toEqual([oid(101), oid(103), oid(102)]);
    expect(filtrar({ criacao: 'mais30dias' })).toEqual([oid(104), oid(105)]);
  });

  test('sem responsavel (qualquer status) x backlog disponivel (pendente e sem responsavel)', () => {
    expect(filtrar({ atribuicao: ATRIBUICAO_SEM_RESPONSAVEL })).toEqual([oid(103), oid(104)]);
    expect(filtrar({ atribuicao: ATRIBUICAO_BACKLOG })).toEqual([oid(103)]);
    expect(filtrar({ atribuicao: ANA })).toEqual([oid(101), oid(105)]);
  });

  test('ordenacao por urgencia explicita (alta > media > baixa), valor desconhecido no fim', () => {
    expect(filtrar({ ordem: 'urgenciaMaior' })).toEqual([oid(101), oid(103), oid(102), oid(105), oid(104), oid(106)]);
    expect(filtrar({ ordem: 'urgenciaMenor' })).toEqual([oid(105), oid(104), oid(102), oid(101), oid(103), oid(106)]);
  });

  test('ordenacao por criacao e prazo; datas ausentes no fim nas duas direcoes', () => {
    expect(filtrar({ ordem: 'recentes' })).toEqual([oid(101), oid(103), oid(102), oid(104), oid(105), oid(106)]);
    expect(filtrar({ ordem: 'antigas' })).toEqual([oid(105), oid(104), oid(102), oid(103), oid(101), oid(106)]);
    expect(filtrar({ ordem: 'prazoProximo' })).toEqual([oid(105), oid(101), oid(102), oid(103), oid(104), oid(106)]);
    expect(filtrar({ ordem: 'prazoDistante' })).toEqual([oid(104), oid(103), oid(102), oid(101), oid(105), oid(106)]);
    expect(filtrar({ ordem: 'nome' })).toEqual([oid(106), oid(101), oid(105), oid(104), oid(102), oid(103)]);
  });

  test('rotulos em portugues; equipe e responsavel vem das listas carregadas', () => {
    expect(rotuloStatus('em_andamento')).toBe('Em andamento');
    expect(rotuloStatus('concluido')).toBe('Concluída');
    expect(rotuloUrgencia('media')).toBe('Média');
    expect(rotuloUrgencia('urgentissima')).toBe('Não informada');
    expect(opcoesDeResponsavel(tarefas)).toEqual([{ id: ANA, nome: 'Ana Souza' }, { id: BRUNO, nome: 'Bruno Lima' }]);
    expect(opcoesDeEquipe([{ _id: oid(9), nome: 'Equipe Vazia' }], tarefas).map((e) => e.nome))
      .toEqual(['Desenvolvimento', 'Equipe Vazia', 'Qualidade']);
  });
});

describe('parametros de URL das tarefas', () => {
  const contexto = { equipes: new Set([oid(1)]), responsaveis: new Set([oid(11)]) };
  const ler = (texto, ctx = contexto) => lerFiltrosTarefas(new URLSearchParams(texto), ctx);

  test('contrato documentado e ida e volta sem perda', () => {
    const texto = `q=login&equipe=${oid(1)}&responsavel=${oid(11)}&status=pendente&urgencia=alta&prazo=7dias&criacao=30dias&ordem=urgenciaMaior`;
    const { filtros, invalidos } = ler(texto);
    expect(invalidos).toEqual([]);
    expect(serializarFiltrosTarefas(filtros).toString()).toBe(texto);
    expect(ler('semResponsavel=1').filtros.atribuicao).toBe(ATRIBUICAO_SEM_RESPONSAVEL);
    expect(ler('backlog=1').filtros.atribuicao).toBe(ATRIBUICAO_BACKLOG);
    expect(serializarFiltrosTarefas(ler('status=pendente&semResponsavel=1').filtros).toString()).toBe('semResponsavel=1&status=pendente');
    expect(serializarFiltrosTarefas(FILTROS_TAREFAS_PADRAO).toString()).toBe('');
  });

  test('ids desconhecidos ou malformados sao ignorados e informados; nada de status inventado', () => {
    const { filtros, invalidos } = ler(`equipe=${oid(99)}&responsavel=../x&status=pausada&urgencia=altissima&prazo=ontem&ordem=sorte&criacao=x`);
    expect(filtros).toEqual(FILTROS_TAREFAS_PADRAO);
    expect(invalidos).toEqual(['equipe', 'responsável', 'status', 'urgência', 'prazo', 'data de criação', 'ordenação']);
  });

  test('enquanto carrega, ids com formato valido ficam provisorios e nada e marcado como invalido', () => {
    const { filtros, invalidos } = ler(`equipe=${oid(99)}`, null);
    expect(filtros.equipe).toBe(oid(99));
    expect(invalidos).toEqual([]);
  });

  test('escolhas de atribuicao conflitantes: backlog > sem responsavel > responsavel', () => {
    expect(ler(`responsavel=${oid(11)}&semResponsavel=1`)).toMatchObject({ filtros: { atribuicao: 'sem' }, invalidos: ['responsável'] });
    expect(ler('semResponsavel=1&backlog=1').filtros.atribuicao).toBe('backlog');
    expect(ler('semResponsavel=sim').invalidos).toEqual(['sem responsável']);
    expect(ler('backlog=0').invalidos).toEqual(['backlog']);
  });
});
