import { compararEquipes, montarRankingEquipes, percentualConcluido } from './rankingEquipesUtils';

const equipe = (id, nome = `Equipe ${id}`) => ({ _id: id, nome });

let sequencia = 0;
const tarefa = (equipeId, status) => ({
  _id: `t${(sequencia += 1)}`,
  status,
  equipe: equipeId === null ? null : { _id: equipeId, nome: 'populada' },
});

// n tarefas da equipe com cada status: { c: concluidas, a: em andamento, p: pendentes }
const tarefasDe = (equipeId, { c = 0, a = 0, p = 0 } = {}) => [
  ...Array.from({ length: c }, () => tarefa(equipeId, 'concluido')),
  ...Array.from({ length: a }, () => tarefa(equipeId, 'em_andamento')),
  ...Array.from({ length: p }, () => tarefa(equipeId, 'pendente')),
];

const nomes = (lista) => lista.map((item) => item.nome);

describe('montarRankingEquipes', () => {
  test('nenhuma equipe (ou resposta ausente) gera ranking vazio', () => {
    for (const [equipes, tarefas] of [[[], []], [undefined, undefined], [null, null]]) {
      expect(montarRankingEquipes(equipes, tarefas)).toEqual({
        comTarefas: [],
        semTarefas: [],
        totalEquipes: 0,
        haConcluidas: false,
      });
    }
  });

  test('uma equipe: conta as tarefas por status', () => {
    const ranking = montarRankingEquipes([equipe('a', 'Alfa')], tarefasDe('a', { c: 2, a: 1, p: 3 }));

    expect(ranking.comTarefas).toEqual([
      { id: 'a', nome: 'Alfa', total: 6, concluidas: 2, emAndamento: 1, pendentes: 3 },
    ]);
    expect(ranking.semTarefas).toEqual([]);
    expect(ranking.totalEquipes).toBe(1);
    expect(ranking.haConcluidas).toBe(true);
  });

  test('ordena primeiro pelo numero de tarefas concluidas', () => {
    const ranking = montarRankingEquipes(
      [equipe('a', 'Alfa'), equipe('b', 'Beta'), equipe('c', 'Gama')],
      [...tarefasDe('a', { c: 1, p: 1 }), ...tarefasDe('b', { c: 3, p: 9 }), ...tarefasDe('c', { c: 2 })],
    );

    expect(nomes(ranking.comTarefas)).toEqual(['Beta', 'Gama', 'Alfa']);
  });

  // Os nomes estao em ordem alfabetica contraria a esperada: so o criterio certo produz esta ordem.
  test('empates: taxa de conclusao, depois volume, depois em andamento', () => {
    const equipes = [
      equipe('1', 'Alfa'), // 0 de 1
      equipe('2', 'Charlie'), // 2 de 4
      equipe('3', 'Delta'), // 2 de 2
      equipe('4', 'Echo'), // 1 de 1
      equipe('5', 'Yankee'), // 0 de 3, nenhuma em andamento
      equipe('6', 'Zulu'), // 0 de 3, duas em andamento
    ];
    const tarefas = [
      ...tarefasDe('1', { p: 1 }),
      ...tarefasDe('2', { c: 2, p: 2 }),
      ...tarefasDe('3', { c: 2 }),
      ...tarefasDe('4', { c: 1 }),
      ...tarefasDe('5', { p: 3 }),
      ...tarefasDe('6', { a: 2, p: 1 }),
    ];

    const ordem = nomes(montarRankingEquipes(equipes, tarefas).comTarefas);

    expect(ordem).toEqual([
      'Delta', // 2 concluidas, 100%
      'Charlie', // 2 concluidas, 50%: mais concluidas vence taxa maior (Echo tem 100%)
      'Echo', // 1 concluida
      'Zulu', // 0 de 3, empata com Yankee no volume e tem mais em andamento
      'Yankee', // 0 de 3
      'Alfa', // 0 de 1: menos volume
    ]);
  });

  test('empate completo usa o nome em portugues (acentos, maiusculas, numeros) e o id por ultimo', () => {
    const equipes = [
      equipe('z', 'alfa'),
      equipe('y', 'Equipe 10'),
      equipe('x', 'Ágil'),
      equipe('w', 'Equipe 2'),
      equipe('v', 'Mesmo nome'),
      equipe('u', 'Mesmo nome'),
    ];
    const tarefas = equipes.flatMap(({ _id }) => tarefasDe(_id, { c: 1 }));

    const ranking = montarRankingEquipes(equipes, tarefas).comTarefas;

    expect(nomes(ranking)).toEqual(['Ágil', 'alfa', 'Equipe 2', 'Equipe 10', 'Mesmo nome', 'Mesmo nome']);
    expect(ranking.slice(-2).map((item) => item.id)).toEqual(['u', 'v']);
  });

  test('a ordem nao depende da ordem em que a API devolve as equipes e as tarefas', () => {
    const equipes = ['a', 'b', 'c', 'd', 'e'].map((id) => equipe(id));
    const tarefas = [
      ...tarefasDe('a', { p: 2 }),
      ...tarefasDe('b', { c: 1, p: 1 }),
      ...tarefasDe('c', { a: 2 }),
      ...tarefasDe('d', { c: 1, p: 1 }),
      ...tarefasDe('e', { p: 1 }),
    ];

    const direta = montarRankingEquipes(equipes, tarefas);
    const invertida = montarRankingEquipes([...equipes].reverse(), [...tarefas].reverse());

    expect(invertida).toEqual(direta);
  });

  test('nenhuma tarefa concluida: sinaliza e ordena pelo volume de tarefas', () => {
    const ranking = montarRankingEquipes(
      [equipe('a', 'Antiga'), equipe('b', 'Beta'), equipe('c', 'Gama'), equipe('d', 'Delta')],
      [
        ...tarefasDe('a', { p: 1 }),
        ...tarefasDe('b', { a: 1, p: 2 }),
        ...tarefasDe('c', { p: 3 }),
        ...tarefasDe('d', { a: 2 }),
      ],
    );

    expect(ranking.haConcluidas).toBe(false);
    expect(nomes(ranking.comTarefas)).toEqual(['Beta', 'Gama', 'Delta', 'Antiga']);
  });

  test('equipes sem tarefas ficam fora do ranking, separadas e em ordem alfabetica', () => {
    const ranking = montarRankingEquipes(
      [equipe('a', 'Zulu'), equipe('b', 'Com tarefa'), equipe('c', 'Bravo'), equipe('d', 'Échos')],
      tarefasDe('b', { p: 1 }),
    );

    expect(nomes(ranking.comTarefas)).toEqual(['Com tarefa']);
    expect(nomes(ranking.semTarefas)).toEqual(['Bravo', 'Échos', 'Zulu']);
    expect(ranking.semTarefas.every((item) => item.total === 0)).toBe(true);
    expect(ranking.totalEquipes).toBe(4);
  });

  test('quatorze equipes: todas entram, nas listas com e sem tarefas', () => {
    const equipes = Array.from({ length: 14 }, (_, i) => equipe(`e${i}`, `Equipe ${i + 1}`));
    const tarefas = equipes.slice(0, 9).flatMap(({ _id }, i) => tarefasDe(_id, { c: i % 3, p: 1 }));

    const ranking = montarRankingEquipes(equipes, tarefas);

    expect(ranking.totalEquipes).toBe(14);
    expect(ranking.comTarefas).toHaveLength(9);
    expect(ranking.semTarefas).toHaveLength(5);
    const ids = [...ranking.comTarefas, ...ranking.semTarefas].map((item) => item.id);
    expect(new Set(ids).size).toBe(14);
  });

  test('tarefa sem equipe, de equipe desconhecida ou com status fora do enum nao quebra a contagem', () => {
    const ranking = montarRankingEquipes(
      [equipe('a', 'Alfa')],
      [
        tarefa(null, 'concluido'),
        { _id: 'sem-campo', status: 'concluido' },
        tarefa('outra', 'concluido'),
        tarefa('a', 'arquivada'),
        tarefa('a', 'concluido'),
        null,
      ],
    );

    expect(ranking.comTarefas).toEqual([
      { id: 'a', nome: 'Alfa', total: 2, concluidas: 1, emAndamento: 0, pendentes: 0 },
    ]);
  });

  test('equipe sem nome ou sem _id continua listada', () => {
    const ranking = montarRankingEquipes([{ _id: 'a' }, { nome: 'Sem id' }], []);

    expect(ranking.semTarefas.map(({ id, nome }) => ({ id, nome }))).toEqual([
      { id: 'a', nome: 'Equipe sem nome' },
      { id: 'sem-id-1', nome: 'Sem id' },
    ]);
  });
});

describe('percentualConcluido', () => {
  test('arredonda e trata equipe sem tarefas', () => {
    expect(percentualConcluido({ concluidas: 1, total: 3 })).toBe(33);
    expect(percentualConcluido({ concluidas: 2, total: 3 })).toBe(67);
    expect(percentualConcluido({ concluidas: 4, total: 4 })).toBe(100);
    expect(percentualConcluido({ concluidas: 0, total: 0 })).toBe(0);
  });
});

describe('compararEquipes', () => {
  test('e uma ordem total: nunca devolve 0 para equipes diferentes', () => {
    const a = { id: 'a', nome: 'Igual', total: 1, concluidas: 0, emAndamento: 0, pendentes: 1 };
    const b = { ...a, id: 'b' };

    expect(compararEquipes(a, b)).toBeLessThan(0);
    expect(compararEquipes(b, a)).toBeGreaterThan(0);
  });
});
