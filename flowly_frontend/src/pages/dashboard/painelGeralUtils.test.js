import {
  calcularIndicadores,
  chaveDiaLocal,
  contarPorStatus,
  descreverPrazo,
  diaDaEntrega,
  diferencaEmDias,
  estaAtrasada,
  filtrarPorEquipe,
  formatarDataEntrega,
  formatarDia,
  formatarTempo,
  listarProximasEntregas,
  ordenarEquipesPorNome,
} from './painelGeralUtils';

// Como a API devolve dataEntrega: o formulario manda so a data e o Mongo guarda meia-noite UTC.
const entrega = (dia) => `${dia}T00:00:00.000Z`;

let sequencia = 0;
const tarefa = (equipeId, status, extra = {}) => ({
  _id: `t${(sequencia += 1)}`,
  descricao: `Tarefa ${sequencia}`,
  status,
  tempoGasto: 0,
  dataEntrega: entrega('2026-12-31'),
  equipe: equipeId === null ? null : { _id: equipeId, nome: `Equipe ${equipeId}` },
  ...extra,
});

describe('chaveDiaLocal: o "hoje" e o dia civil de quem olha o painel', () => {
  test('usa a data local, do primeiro ao ultimo minuto do dia', () => {
    expect(chaveDiaLocal(new Date(2026, 10, 17, 0, 0, 0))).toBe('2026-11-17');
    expect(chaveDiaLocal(new Date(2026, 10, 17, 23, 59, 59))).toBe('2026-11-17');
    expect(chaveDiaLocal(new Date(2026, 0, 5, 12))).toBe('2026-01-05');
  });
});

describe('diaDaEntrega: o dia gravado, sem deslocamento de fuso', () => {
  test('meia-noite UTC continua no mesmo dia em qualquer fuso (getDate() local erraria no Brasil)', () => {
    expect(diaDaEntrega('2026-11-17T00:00:00.000Z')).toBe('2026-11-17');
    expect(diaDaEntrega('2026-01-01T00:00:00.000Z')).toBe('2026-01-01');
    expect(diaDaEntrega('2026-11-17')).toBe('2026-11-17');
    expect(diaDaEntrega(' 2026-11-17T00:00:00Z ')).toBe('2026-11-17');
  });

  test('aceita Date e horario dentro do dia UTC', () => {
    expect(diaDaEntrega(new Date(Date.UTC(2026, 10, 17)))).toBe('2026-11-17');
    expect(diaDaEntrega('2026-11-17T15:30:00.000Z')).toBe('2026-11-17');
  });

  test('valores ausentes ou invalidos nao viram data', () => {
    for (const valor of [null, undefined, '', 'amanha', '17/11/2026', '2026-02-30', '2026-13-01', 1763337600000, {}, new Date('x')]) {
      expect(diaDaEntrega(valor)).toBeNull();
    }
  });
});

describe('diferencaEmDias e formatarDia', () => {
  test('conta dias de calendario, inclusive em virada de mes, ano e ano bissexto', () => {
    expect(diferencaEmDias('2026-11-17', '2026-11-17')).toBe(0);
    expect(diferencaEmDias('2026-11-17', '2026-11-18')).toBe(1);
    expect(diferencaEmDias('2026-11-17', '2026-11-14')).toBe(-3);
    expect(diferencaEmDias('2026-02-28', '2026-03-01')).toBe(1);
    expect(diferencaEmDias('2028-02-28', '2028-03-01')).toBe(2);
    expect(diferencaEmDias('2026-12-31', '2027-01-01')).toBe(1);
  });

  test('formata AAAA-MM-DD como DD/MM/AAAA sem passar por Date', () => {
    expect(formatarDia('2026-11-07')).toBe('07/11/2026');
  });
});

describe('estaAtrasada: ontem, hoje e amanha', () => {
  const hoje = '2026-11-17';

  test('nao concluida com entrega ontem esta atrasada; hoje e amanha ainda nao', () => {
    expect(estaAtrasada(tarefa('a', 'pendente', { dataEntrega: entrega('2026-11-16') }), hoje)).toBe(true);
    expect(estaAtrasada(tarefa('a', 'em_andamento', { dataEntrega: entrega('2026-11-16') }), hoje)).toBe(true);
    expect(estaAtrasada(tarefa('a', 'pendente', { dataEntrega: entrega('2026-11-17') }), hoje)).toBe(false);
    expect(estaAtrasada(tarefa('a', 'pendente', { dataEntrega: entrega('2026-11-18') }), hoje)).toBe(false);
  });

  test('o "hoje" vem do relogio local: 00:05 e 23:55 do dia 17 dao o mesmo resultado', () => {
    const vencidaOntem = tarefa('a', 'pendente', { dataEntrega: entrega('2026-11-16') });
    const venceHoje = tarefa('a', 'pendente', { dataEntrega: entrega('2026-11-17') });
    for (const agora of [new Date(2026, 10, 17, 0, 5), new Date(2026, 10, 17, 23, 55)]) {
      const dia = chaveDiaLocal(agora);
      expect(estaAtrasada(vencidaOntem, dia)).toBe(true);
      expect(estaAtrasada(venceHoje, dia)).toBe(false);
    }
    // Um minuto depois da meia-noite local, a de hoje passa a estar atrasada.
    expect(estaAtrasada(venceHoje, chaveDiaLocal(new Date(2026, 10, 18, 0, 1)))).toBe(true);
  });

  test('concluida nunca esta atrasada; sem data valida tambem nao', () => {
    expect(estaAtrasada(tarefa('a', 'concluido', { dataEntrega: entrega('2026-01-01') }), hoje)).toBe(false);
    expect(estaAtrasada(tarefa('a', 'pendente', { dataEntrega: null }), hoje)).toBe(false);
    expect(estaAtrasada(tarefa('a', 'pendente', { dataEntrega: 'invalida' }), hoje)).toBe(false);
    expect(estaAtrasada(null, hoje)).toBe(false);
  });
});

describe('descreverPrazo', () => {
  test('textos relativos ao dia local', () => {
    const hoje = '2026-11-17';
    expect(descreverPrazo('2026-11-14', hoje)).toBe('Venceu há 3 dias');
    expect(descreverPrazo('2026-11-16', hoje)).toBe('Venceu ontem');
    expect(descreverPrazo('2026-11-17', hoje)).toBe('Vence hoje');
    expect(descreverPrazo('2026-11-18', hoje)).toBe('Vence amanhã');
    expect(descreverPrazo('2026-11-22', hoje)).toBe('Vence em 5 dias');
  });
});

describe('formatarTempo', () => {
  test('horas e minutos, como no exemplo 646 = 10h 46min', () => {
    expect(formatarTempo(646)).toBe('10h 46min');
    expect(formatarTempo(0)).toBe('0min');
    expect(formatarTempo(45)).toBe('45min');
    expect(formatarTempo(60)).toBe('1h');
    expect(formatarTempo(61)).toBe('1h 1min');
    expect(formatarTempo(1500)).toBe('25h');
    expect(formatarTempo('90')).toBe('1h 30min');
  });

  test('arredonda para o minuto e trata valores invalidos como zero', () => {
    expect(formatarTempo(59.6)).toBe('1h');
    expect(formatarTempo(10.4)).toBe('10min');
    for (const valor of [-5, NaN, undefined, null, 'abc', Infinity]) {
      expect(formatarTempo(valor)).toBe('0min');
    }
  });
});

describe('filtrarPorEquipe', () => {
  const equipes = [{ _id: 'a', nome: 'Alfa' }, { _id: 'b', nome: 'Beta' }, { _id: 'c', nome: 'Sem tarefas' }];
  const tarefas = [tarefa('a', 'pendente'), tarefa('b', 'concluido'), tarefa('b', 'pendente'), tarefa(null, 'pendente'), tarefa('x', 'pendente')];

  test('sem selecao: todas as equipes e todas as tarefas carregadas', () => {
    const resultado = filtrarPorEquipe(equipes, tarefas, '');
    expect(resultado).toEqual({ equipeId: '', equipes, tarefas });
  });

  test('equipe selecionada: so ela e as tarefas dela', () => {
    const resultado = filtrarPorEquipe(equipes, tarefas, 'b');
    expect(resultado.equipeId).toBe('b');
    expect(resultado.equipes).toEqual([equipes[1]]);
    expect(resultado.tarefas.map((t) => t.status)).toEqual(['concluido', 'pendente']);
  });

  test('equipe sem tarefas: lista de tarefas vazia', () => {
    expect(filtrarPorEquipe(equipes, tarefas, 'c').tarefas).toEqual([]);
  });

  test('id fora do escopo da API (ou que sumiu apos atualizar) volta para todas', () => {
    for (const id of ['x', 'inexistente', 'null', 'undefined']) {
      const resultado = filtrarPorEquipe(equipes, tarefas, id);
      expect(resultado.equipeId).toBe('');
      expect(resultado.tarefas).toBe(tarefas);
    }
  });

  test('ids numericos ou ObjectId sao comparados como texto', () => {
    expect(filtrarPorEquipe([{ _id: 7, nome: 'Sete' }], [tarefa(7, 'pendente')], '7').tarefas).toHaveLength(1);
  });
});

describe('calcularIndicadores', () => {
  const hoje = '2026-11-17';
  const equipes = [{ _id: 'a' }, { _id: 'b' }, { _id: 'c' }];
  const tarefas = [
    tarefa('a', 'concluido', { tempoGasto: 120, dataEntrega: entrega('2026-11-01') }),
    tarefa('a', 'pendente', { tempoGasto: 6, dataEntrega: entrega('2026-11-16') }),
    tarefa('b', 'em_andamento', { tempoGasto: 500, dataEntrega: entrega('2026-11-10') }),
    tarefa('b', 'pendente', { tempoGasto: undefined, dataEntrega: entrega('2026-11-17') }),
    tarefa('b', 'pendente', { tempoGasto: 20, dataEntrega: entrega('2026-11-18') }),
  ];

  test('total, concluidas e tempo seguem exatamente as formulas anteriores do painel', () => {
    const ind = calcularIndicadores(equipes, tarefas, hoje);

    expect(ind.totalTarefas).toBe(tarefas.length);
    expect(ind.concluidas).toBe(tarefas.filter((t) => t.status === 'concluido').length);
    expect(ind.tempoMinutos).toBe(tarefas.reduce((acc, t) => acc + (t.tempoGasto || 0), 0));
    expect(ind.tempoMinutos).toBe(646);
    expect(ind.tempoFormatado).toBe('10h 46min');
  });

  test('atrasadas, em aberto, percentual e equipes com tarefas', () => {
    expect(calcularIndicadores(equipes, tarefas, hoje)).toMatchObject({
      equipes: 3,
      equipesComTarefas: 2,
      emAberto: 4,
      percentualConcluido: 20,
      atrasadas: 2, // 16/11 pendente e 10/11 em andamento; a concluida de 01/11 nao conta
    });
  });

  test('percentual de conclusao arredondado (1 de 3 = 33%, 2 de 3 = 67%)', () => {
    const tres = (concluidas) => [0, 1, 2].map((i) => tarefa('a', i < concluidas ? 'concluido' : 'pendente'));
    expect(calcularIndicadores(equipes, tres(1), hoje).percentualConcluido).toBe(33);
    expect(calcularIndicadores(equipes, tres(2), hoje).percentualConcluido).toBe(67);
  });

  test('sem tarefas: zeros reais, sem divisao por zero', () => {
    expect(calcularIndicadores([], [], hoje)).toMatchObject({
      equipes: 0, totalTarefas: 0, concluidas: 0, emAberto: 0, percentualConcluido: 0, atrasadas: 0, tempoFormatado: '0min',
    });
  });
});

test('contarPorStatus conta pendente, em andamento e concluido', () => {
  expect(contarPorStatus([tarefa('a', 'pendente'), tarefa('a', 'pendente'), tarefa('a', 'concluido'), tarefa('a', 'arquivada')]))
    .toEqual([2, 0, 1]);
});

describe('listarProximasEntregas', () => {
  const hoje = '2026-11-17';

  test('ate 5 nao concluidas, da entrega mais antiga para a mais distante, com atrasadas marcadas', () => {
    const tarefas = [
      tarefa('a', 'pendente', { descricao: 'Daqui a 10 dias', dataEntrega: entrega('2026-11-27') }),
      tarefa('a', 'concluido', { descricao: 'Concluida vencida', dataEntrega: entrega('2026-11-01') }),
      tarefa('a', 'pendente', { descricao: 'Amanha', dataEntrega: entrega('2026-11-18') }),
      tarefa('b', 'em_andamento', { descricao: 'Ontem', dataEntrega: entrega('2026-11-16') }),
      tarefa('a', 'pendente', { descricao: 'Sem prazo', dataEntrega: null }),
      tarefa('b', 'pendente', { descricao: 'Hoje B', dataEntrega: entrega('2026-11-17') }),
      tarefa('b', 'pendente', { descricao: 'Hoje A', dataEntrega: entrega('2026-11-17') }),
      tarefa('a', 'pendente', { descricao: 'Semana que vem', dataEntrega: entrega('2026-11-24') }),
      tarefa('a', 'pendente', { descricao: 'Ha muito tempo', dataEntrega: entrega('2026-10-01') }),
    ];

    const { itens, total } = listarProximasEntregas(tarefas, hoje);

    expect(total).toBe(7);
    expect(itens.map((i) => i.descricao)).toEqual(['Ha muito tempo', 'Ontem', 'Hoje A', 'Hoje B', 'Amanha']);
    expect(itens.map((i) => [i.data, i.prazo, i.atrasada, i.venceHoje])).toEqual([
      ['01/10/2026', 'Venceu há 47 dias', true, false],
      ['16/11/2026', 'Venceu ontem', true, false],
      ['17/11/2026', 'Vence hoje', false, true],
      ['17/11/2026', 'Vence hoje', false, true],
      ['18/11/2026', 'Vence amanhã', false, false],
    ]);
    expect(itens[1].equipe).toBe('Equipe b');
  });

  test('nao inventa dados: descricao e equipe ausentes aparecem como nao informadas', () => {
    const { itens } = listarProximasEntregas(
      [{ _id: 'x', status: 'pendente', dataEntrega: entrega('2026-11-20') }],
      hoje,
    );
    expect(itens[0]).toMatchObject({ id: 'x', descricao: 'Tarefa sem descrição', equipe: 'Equipe não informada' });
  });

  test('sem tarefas elegiveis: lista vazia', () => {
    expect(listarProximasEntregas([tarefa('a', 'concluido')], hoje)).toEqual({ itens: [], total: 0 });
    expect(listarProximasEntregas([], hoje)).toEqual({ itens: [], total: 0 });
  });

  test('limite configuravel', () => {
    const tarefas = ['2026-11-20', '2026-11-21', '2026-11-22'].map((dia) => tarefa('a', 'pendente', { dataEntrega: entrega(dia) }));
    expect(listarProximasEntregas(tarefas, hoje, 2).itens).toHaveLength(2);
  });
});

test('ordenarEquipesPorNome usa a ordem do portugues e nao altera a lista original', () => {
  const equipes = [{ _id: '1', nome: 'beta' }, { _id: '2', nome: 'Ágil' }, { _id: '3', nome: 'Equipe 10' }, { _id: '4', nome: 'Equipe 2' }];
  expect(ordenarEquipesPorNome(equipes).map((e) => e.nome)).toEqual(['Ágil', 'beta', 'Equipe 2', 'Equipe 10']);
  expect(equipes[0].nome).toBe('beta');
});

describe('formatarDataEntrega', () => {
  test('dia gravado em dd/mm/aaaa; sem data valida, o texto informado', () => {
    expect(formatarDataEntrega('2026-11-24T00:00:00.000Z')).toBe('24/11/2026');
    expect(formatarDataEntrega('2026-11-24')).toBe('24/11/2026');
    expect(formatarDataEntrega('2026-12-31T00:00:00.000Z')).toBe('31/12/2026');
    expect(formatarDataEntrega(null)).toBe('Sem prazo');
    expect(formatarDataEntrega('ontem', 'Não definido')).toBe('Não definido');
  });
});
