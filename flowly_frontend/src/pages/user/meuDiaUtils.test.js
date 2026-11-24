// Meu Dia: grupos exclusivos, ordem, contadores e datas (dia civil gravado x "hoje" local), sem depender do relogio.
import { organizarMeuDia, JANELA_PROXIMAS_DIAS } from './meuDiaUtils';
import { chaveDiaLocal, formatarDataEntrega } from '../dashboard/painelGeralUtils';

const meiaNoiteUTC = (dia) => `${dia}T00:00:00.000Z`;
let seq = 0;
const tarefa = (dataEntrega, extra = {}) => ({
  _id: `t${(seq += 1)}`, descricao: `Tarefa ${seq}`, status: 'pendente', urgencia: 'baixa', dataEntrega, ...extra,
});
const nomes = (lista) => lista.map((e) => e.tarefa.descricao);

describe('organizarMeuDia', () => {
  const HOJE = '2026-11-25';

  test('classifica atrasada, hoje, proximos 7 dias (sem hoje), mais adiante, sem prazo e concluida', () => {
    const lista = [
      tarefa(meiaNoiteUTC('2026-11-24'), { descricao: 'Ontem' }),
      tarefa(meiaNoiteUTC('2026-11-25'), { descricao: 'Hoje' }),
      tarefa(meiaNoiteUTC('2026-11-26'), { descricao: 'Amanha' }),
      tarefa(meiaNoiteUTC('2026-12-02'), { descricao: 'Dia 7' }),
      tarefa(meiaNoiteUTC('2026-12-03'), { descricao: 'Dia 8' }),
      tarefa(undefined, { descricao: 'Sem prazo' }),
      tarefa('data-invalida', { descricao: 'Invalida' }),
      tarefa(meiaNoiteUTC('2026-11-20'), { descricao: 'Feita', status: 'concluido' }),
    ];
    const r = organizarMeuDia(lista, HOJE);
    expect(nomes(r.atrasadas)).toEqual(['Ontem']);
    expect(nomes(r.hoje)).toEqual(['Hoje']);
    expect(nomes(r.proximas)).toEqual(['Amanha', 'Dia 7']);
    expect(nomes(r.maisAdiante)).toEqual(['Dia 8']);
    expect(nomes(r.semPrazo)).toEqual(['Invalida', 'Sem prazo']);
    expect(nomes(r.concluidas)).toEqual(['Feita']);
    expect(r.indicadores).toEqual({ atrasadas: 1, hoje: 1, proximas: 2 });
    expect(r.pendentes).toBe(7);
    expect(JANELA_PROXIMAS_DIAS).toBe(7);
    // Cada tarefa uma unica vez; contadores = itens dos grupos.
    const ids = ['atrasadas', 'hoje', 'proximas', 'maisAdiante', 'semPrazo', 'concluidas'].flatMap((g) => r[g].map((e) => e.id));
    expect(new Set(ids).size).toBe(lista.length);
    expect(ids).toHaveLength(lista.length);
  });

  test('ordem: prazo mais antigo, depois urgencia, depois nome', () => {
    const lista = [
      tarefa(meiaNoiteUTC('2026-11-20'), { descricao: 'B baixa', urgencia: 'baixa' }),
      tarefa(meiaNoiteUTC('2026-11-20'), { descricao: 'A alta', urgencia: 'alta' }),
      tarefa(meiaNoiteUTC('2026-11-18'), { descricao: 'Mais antiga', urgencia: 'baixa' }),
      tarefa(meiaNoiteUTC('2026-11-25'), { descricao: 'Hoje media', urgencia: 'media' }),
      tarefa(meiaNoiteUTC('2026-11-25'), { descricao: 'Hoje alta', urgencia: 'alta' }),
    ];
    const r = organizarMeuDia(lista, HOJE);
    expect(nomes(r.atrasadas)).toEqual(['Mais antiga', 'A alta', 'B baixa']);
    expect(nomes(r.hoje)).toEqual(['Hoje alta', 'Hoje media']);
  });

  test('prazo relativo e data exibida no dia gravado', () => {
    const r = organizarMeuDia([tarefa(meiaNoiteUTC('2026-11-24')), tarefa('2026-11-26')], HOJE);
    expect(r.atrasadas[0]).toMatchObject({ data: '24/11/2026', prazo: 'Venceu ontem' });
    expect(r.proximas[0]).toMatchObject({ data: '26/11/2026', prazo: 'Vence amanhã' });
  });

  test('viradas de mes e de ano', () => {
    const r = organizarMeuDia([
      tarefa(meiaNoiteUTC('2026-12-31'), { descricao: 'Ultimo dia' }),
      tarefa(meiaNoiteUTC('2027-01-01'), { descricao: 'Ano novo' }),
      tarefa(meiaNoiteUTC('2027-01-07'), { descricao: 'Dia 7' }),
      tarefa(meiaNoiteUTC('2027-01-08'), { descricao: 'Dia 8' }),
    ], '2026-12-31');
    expect(nomes(r.hoje)).toEqual(['Ultimo dia']);
    expect(nomes(r.proximas)).toEqual(['Ano novo', 'Dia 7']);
    expect(nomes(r.maisAdiante)).toEqual(['Dia 8']);
    const fimDeMes = organizarMeuDia([tarefa(meiaNoiteUTC('2026-11-30')), tarefa(meiaNoiteUTC('2026-12-01'))], '2026-12-01');
    expect(fimDeMes.atrasadas[0].prazo).toBe('Venceu ontem');
    expect(fimDeMes.hoje).toHaveLength(1);
  });

  test('entrada invalida ou vazia nao quebra', () => {
    expect(organizarMeuDia(null, HOJE).total).toBe(0);
    expect(organizarMeuDia([null, 'x', tarefa(meiaNoiteUTC(HOJE))], HOJE).total).toBe(1);
  });
});

describe('datas de entrega no fuso brasileiro', () => {
  const tzOriginal = process.env.TZ;
  afterEach(() => {
    process.env.TZ = tzOriginal;
    vi.useRealTimers();
  });

  test('meia-noite UTC e AAAA-MM-DD mostram o dia gravado, nao o anterior', () => {
    process.env.TZ = 'America/Sao_Paulo';
    expect(new Date('2026-11-24T00:00:00.000Z').toLocaleDateString('pt-BR')).toBe('23/11/2026'); // o defeito antigo
    expect(formatarDataEntrega('2026-11-24T00:00:00.000Z')).toBe('24/11/2026');
    expect(formatarDataEntrega('2026-11-24')).toBe('24/11/2026');
    expect(formatarDataEntrega('2027-01-01T00:00:00.000Z')).toBe('01/01/2027');
    expect(formatarDataEntrega(undefined)).toBe('Sem prazo');
    expect(formatarDataEntrega('2026-02-30', 'Não definida')).toBe('Não definida');
  });

  test('"hoje" e o dia civil local: 23:30 em Brasilia ainda e o mesmo dia', () => {
    process.env.TZ = 'America/Sao_Paulo';
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-26T02:30:00.000Z')); // 25/11 23:30 em Brasilia
    const hoje = chaveDiaLocal();
    expect(hoje).toBe('2026-11-25');
    const r = organizarMeuDia([tarefa(meiaNoiteUTC('2026-11-25'), { descricao: 'Entrega de hoje' })], hoje);
    expect(nomes(r.hoje)).toEqual(['Entrega de hoje']);
    expect(r.atrasadas).toHaveLength(0);
  });
});
