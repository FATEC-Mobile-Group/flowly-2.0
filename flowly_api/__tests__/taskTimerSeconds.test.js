// Cronometro com precisao de segundos: o acumulado preciso (tempoGastoSegundos) recebe os segundos inteiros de cada
// sessao; tempoGasto (minutos) e derivado dele; tarefa antiga (so tempoGasto) usa tempoGasto * 60 como base.
const {
  calcularPausa,
  calcularTransicaoCronometro,
  calcularTransicaoStatus,
  montarCondicao,
  montarUpdate,
} = require('../services/taskStateTransition');

const T0 = new Date('2026-11-23T15:00:00.000Z');
const depois = (segundos) => new Date(T0.getTime() + segundos * 1000);
const ativa = (extra = {}) => ({ _id: 't1', cronometroAtivo: true, ultimaAtualizacaoCronometro: T0, tempoGasto: 0, ...extra });

// Aplica o $set da transicao como o banco faria (para encadear sessoes).
const aplicar = (tarefa, transicao) => ({ ...tarefa, ...transicao.set });

describe('pausa com precisao de segundos', () => {
  test('tarefa antiga com so tempoGasto: base historica tempoGasto * 60, nada zerado', () => {
    const { set } = calcularPausa(ativa({ tempoGasto: 8 }), depois(23));
    expect(set).toMatchObject({ tempoGastoSegundos: 8 * 60 + 23, tempoGasto: 8, cronometroAtivo: false });
  });

  test('tempoGastoSegundos = 0 e zero legitimo (nao cai para o legado)', () => {
    const { set } = calcularPausa(ativa({ tempoGasto: 5, tempoGastoSegundos: 0 }), depois(30));
    expect(set).toMatchObject({ tempoGastoSegundos: 30, tempoGasto: 0 });
  });

  test('sessao de menos de um minuto nao se perde', () => {
    const { set, minutos, segundos } = calcularPausa(ativa(), depois(45));
    expect(set).toMatchObject({ tempoGastoSegundos: 45, tempoGasto: 0 });
    expect({ minutos, segundos }).toEqual({ minutos: 0, segundos: 45 });
  });

  test('2 min 23 s viram 143 s (antes: 2 min)', () => {
    expect(calcularPausa(ativa(), depois(143)).set).toMatchObject({ tempoGastoSegundos: 143, tempoGasto: 2 });
  });

  test('143 s + 97 s = 240 s = 4 min exatos; varias sessoes sem perda', () => {
    let tarefa = aplicar(ativa(), calcularPausa(ativa(), depois(143)));
    tarefa = aplicar(tarefa, calcularTransicaoCronometro(tarefa, 'iniciar', depois(500)));
    tarefa = aplicar(tarefa, calcularPausa(tarefa, depois(597)));
    expect(tarefa).toMatchObject({ tempoGastoSegundos: 240, tempoGasto: 4, cronometroAtivo: false });
    // Mais tres sessoes curtas de 25 s: 315 s.
    for (let i = 0; i < 3; i += 1) {
      const inicio = 1000 + i * 100;
      tarefa = aplicar(tarefa, calcularTransicaoCronometro(tarefa, 'iniciar', depois(inicio)));
      tarefa = aplicar(tarefa, calcularPausa(tarefa, depois(inicio + 25)));
    }
    expect(tarefa).toMatchObject({ tempoGastoSegundos: 315, tempoGasto: 5 });
  });

  test('criterio de aceitacao: 8 min 23 s, pausa, retoma 17 s = 8 min 40 s', () => {
    let tarefa = aplicar(ativa(), calcularPausa(ativa(), depois(503)));
    expect(tarefa.tempoGastoSegundos).toBe(503);
    tarefa = aplicar(tarefa, calcularTransicaoCronometro(tarefa, 'iniciar', depois(900)));
    expect(tarefa.tempoGastoSegundos).toBe(503); // iniciar preserva o acumulado e nao soma nada
    tarefa = aplicar(tarefa, calcularPausa(tarefa, depois(917)));
    expect(tarefa).toMatchObject({ tempoGastoSegundos: 520, tempoGasto: 8 });
  });

  test('pausa automatica por status usa o mesmo calculo preciso', () => {
    const transicao = calcularTransicaoStatus(ativa({ tempoGastoSegundos: 100 }), 'concluido', depois(83));
    expect(transicao.set).toMatchObject({ status: 'concluido', tempoGastoSegundos: 183, tempoGasto: 3, cronometroAtivo: false });
    expect(transicao.unset).toEqual(['ultimaAtualizacaoCronometro']);
    // em_andamento nao pausa nem soma.
    expect(calcularTransicaoStatus(ativa({ tempoGastoSegundos: 100 }), 'em_andamento', depois(83)).set).toEqual({ status: 'em_andamento' });
  });

  test('tempo excedido pela regra de sempre (minutos acumulados > estimado)', () => {
    expect(calcularPausa(ativa({ tempoEstimado: 2 }), depois(179)).set).toMatchObject({ tempoGasto: 2 }); // 2 min 59 s
    expect(calcularPausa(ativa({ tempoEstimado: 2 }), depois(179)).set.tempoExcedido).toBeUndefined();
    expect(calcularPausa(ativa({ tempoEstimado: 2 }), depois(180)).set).toMatchObject({ tempoGasto: 3, tempoExcedido: true });
    // Os segundos que sobram de uma sessao contam para o excedido da seguinte (antes eram descartados).
    expect(calcularPausa(ativa({ tempoEstimado: 2, tempoGastoSegundos: 150 }), depois(30)).set).toMatchObject({ tempoGasto: 3, tempoExcedido: true });
  });

  test('inicio no futuro dentro da tolerancia conta zero (nunca negativo); acumulado invalido e erro', () => {
    expect(calcularPausa(ativa({ tempoGastoSegundos: 50 }), new Date(T0.getTime() - 20000)).set.tempoGastoSegundos).toBe(50);
    expect(() => calcularPausa(ativa({ tempoGastoSegundos: -1 }), depois(10))).toThrow('Tempo gasto em segundos armazenado invalido');
    expect(() => calcularPausa(ativa({ tempoGastoSegundos: Number.NaN }), depois(10))).toThrow();
  });

  test('iniciar duplicado e pausar duplicado continuam recusados', () => {
    expect(calcularTransicaoCronometro(ativa(), 'iniciar', depois(1))).toEqual({ recusa: 'cronometro_ja_ativo' });
    expect(calcularTransicaoCronometro({ ...ativa(), cronometroAtivo: false }, 'pausar', depois(1))).toEqual({ recusa: 'cronometro_ja_pausado' });
  });
});

describe('gravacao condicional inclui o acumulado preciso', () => {
  test('condicao: valor lido ou ausente/nulo (null casa os dois no Mongo); update grava os dois campos', () => {
    expect(montarCondicao(ativa({ tempoGastoSegundos: 120 }), 'u1')).toMatchObject({ tempoGastoSegundos: 120, cronometroAtivo: true });
    expect(montarCondicao(ativa(), 'u1').tempoGastoSegundos).toBeNull();
    // Inativo: o acumulado nao afeta a transicao (iniciar), como os demais campos de tempo.
    expect(montarCondicao({ ...ativa(), cronometroAtivo: false }, 'u1')).not.toHaveProperty('tempoGastoSegundos');
    const tarefa = ativa({ tempoGasto: 1, tempoGastoSegundos: 70 });
    const update = montarUpdate(tarefa, calcularPausa(tarefa, depois(5)), depois(5));
    expect(update.$set).toMatchObject({ tempoGastoSegundos: 75, tempoGasto: 1, cronometroAtivo: false });
  });
});
