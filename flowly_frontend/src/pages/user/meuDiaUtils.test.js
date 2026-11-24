// Meu Dia: grupos exclusivos, ordem, contadores e datas (dia civil gravado x "hoje" local), sem depender do relogio.
import {
  organizarMeuDia, JANELA_PROXIMAS_DIAS, acumuladoEmSegundos, ancoraDaSessao, ancoraNaCarga, formatarDuracao,
  lerAncoraSalva, lerOffsetRelogio, manterAncoras, medirInicio, removerAncora, salvarAncora, segundosDoCronometro,
} from './meuDiaUtils';
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

describe('cronometro: sessao nunca negativa e independente da idade da tarefa', () => {
  const INICIO_SERVIDOR = '2026-11-23T15:00:21.000Z'; // relogio do servidor 21 s adiantado
  const AGORA_NAVEGADOR = Date.parse('2026-11-23T15:00:00.000Z');

  test('reproduz o defeito: -21 s formatado com Math.floor virava "-1h -1m -21s"', () => {
    const antigo = (s) => `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m ${s % 60}s`;
    expect(antigo(0 + (AGORA_NAVEGADOR - Date.parse(INICIO_SERVIDOR)) / 1000)).toBe('-1h -1m -21s');
  });

  test('tarefa antiga (criada ha meses) iniciada agora: a sessao comeca em zero', () => {
    const tarefa = { createdAt: '2026-06-01T12:00:00.000Z', dataEntrega: '2026-06-20T00:00:00.000Z',
      cronometroAtivo: true, tempoGasto: 0, ultimaAtualizacaoCronometro: INICIO_SERVIDOR };
    // Sem ancora (diferenca de relogios nao mensuravel): piso zero, nunca negativo.
    expect(segundosDoCronometro(tarefa, AGORA_NAVEGADOR)).toBe(0);
    // Com ancora local (inicio confirmado por este painel): mede so no relogio do navegador.
    const ancora = { inicioServidor: Date.parse(INICIO_SERVIDOR), inicioLocal: AGORA_NAVEGADOR };
    expect(segundosDoCronometro(tarefa, AGORA_NAVEGADOR + 5000, ancora)).toBe(5);
    expect(segundosDoCronometro(tarefa, AGORA_NAVEGADOR + 3725000, ancora)).toBe(3725);
  });

  test('acumulado preservado, pausada nao conta, horario UTC valido e invalido', () => {
    const ativa = { cronometroAtivo: true, tempoGasto: 61, ultimaAtualizacaoCronometro: '2026-11-23T15:00:00.000Z' };
    expect(segundosDoCronometro(ativa, Date.parse('2026-11-23T15:02:30.000Z'))).toBe(61 * 60 + 150);
    expect(segundosDoCronometro({ ...ativa, cronometroAtivo: false }, Date.parse('2026-11-23T18:00:00.000Z'))).toBe(61 * 60);
    expect(segundosDoCronometro({ ...ativa, ultimaAtualizacaoCronometro: 'x' }, AGORA_NAVEGADOR)).toBe(61 * 60);
    // Ancora de uma sessao anterior nao vale para a sessao nova.
    const velha = { inicioServidor: Date.parse('2026-11-22T10:00:00.000Z'), inicioLocal: 0 };
    expect(segundosDoCronometro(ativa, Date.parse('2026-11-23T15:00:10.000Z'), velha)).toBe(61 * 60 + 10);
  });

  test('formatarDuracao nunca mostra negativo', () => {
    expect(formatarDuracao(3725)).toBe('1h 2m 5s');
    expect(formatarDuracao(-21)).toBe('0h 0m 0s');
    expect(formatarDuracao(undefined)).toBe('0h 0m 0s');
  });
});

describe('acumulado preciso (tempoGastoSegundos) com recuo para o legado', () => {
  test('preciso quando enviado (zero e legitimo); tarefa antiga usa tempoGasto * 60', () => {
    expect(acumuladoEmSegundos({ tempoGasto: 8, tempoGastoSegundos: 503 })).toBe(503);
    expect(acumuladoEmSegundos({ tempoGasto: 8, tempoGastoSegundos: 0 })).toBe(0);
    expect(acumuladoEmSegundos({ tempoGasto: 8 })).toBe(480);
    expect(acumuladoEmSegundos({ tempoGasto: 8, tempoGastoSegundos: -5 })).toBe(480);
    expect(acumuladoEmSegundos({})).toBe(0);
  });

  test('criterio de aceitacao: 8 min 23 s confirmados + 17 s de sessao = 8 min 40 s', () => {
    const tarefa = { cronometroAtivo: true, tempoGasto: 8, tempoGastoSegundos: 503, ultimaAtualizacaoCronometro: '2026-11-23T15:00:00.000Z' };
    expect(formatarDuracao(segundosDoCronometro(tarefa, Date.parse('2026-11-23T15:00:17.000Z')))).toBe('0h 8m 40s');
    expect(formatarDuracao(segundosDoCronometro({ ...tarefa, cronometroAtivo: false, tempoGastoSegundos: 520 }, Date.now()))).toBe('0h 8m 40s');
  });
});

describe('ancoraNaCarga (sessao que ja chega ativa da API)', () => {
  const agora = Date.parse('2026-11-25T15:00:00.000Z');
  test('parte da sessao medivel e nunca negativa; segue o relogio local depois', () => {
    const ativa = { cronometroAtivo: true, tempoGastoSegundos: 503, ultimaAtualizacaoCronometro: '2026-11-25T14:59:00.000Z' };
    const ancora = ancoraNaCarga(ativa, agora);
    expect(segundosDoCronometro(ativa, agora, ancora)).toBe(563);
    expect(segundosDoCronometro(ativa, agora + 5000, ancora)).toBe(568);
    const adiantada = { ...ativa, ultimaAtualizacaoCronometro: '2026-11-25T15:01:30.000Z' };
    const ancoraAdiantada = ancoraNaCarga(adiantada, agora);
    expect(segundosDoCronometro(adiantada, agora, ancoraAdiantada)).toBe(503);
    expect(segundosDoCronometro(adiantada, agora + 5000, ancoraAdiantada)).toBe(508); // antes: 503 parado
    expect(segundosDoCronometro(adiantada, agora + 5000)).toBe(503); // sem ancora: o defeito reproduzido
  });

  test('pausada ou inicio invalido: sem ancora', () => {
    expect(ancoraNaCarga({ cronometroAtivo: false, ultimaAtualizacaoCronometro: '2026-11-25T14:59:00.000Z' }, agora)).toBeNull();
    expect(ancoraNaCarga({ cronometroAtivo: true, ultimaAtualizacaoCronometro: 'x' }, agora)).toBeNull();
  });
});

describe('sincronizacao: ancoras salvas na aba e diferenca de relogio medida no inicio', () => {
  beforeEach(() => sessionStorage.clear());
  const T = Date.parse('2026-11-25T15:00:00.000Z');

  test('medirInicio: meio do caminho como inicio local e diferenca de relogio com latencia', () => {
    // PUT enviado em T, resposta em T + 400 ms; o servidor (20 s adiantado) gravou o inicio no meio: T + 200 + 20 s.
    const ancora = medirInicio(T + 20200, T, T + 400);
    expect(ancora).toEqual({ inicioServidor: T + 20200, inicioLocal: T + 200 });
    expect(lerOffsetRelogio()).toBe(20000);
  });

  test('medicao com incerteza grande (resposta muito lenta) nao vira diferenca de relogio', () => {
    medirInicio(T + 20000, T, T + 20000);
    expect(lerOffsetRelogio()).toBeNull();
  });

  test('ancoraDaSessao: prefere a salva da mesma sessao; outra sessao usa a carga corrigida pela diferenca', () => {
    const tarefa = { _id: 't1', cronometroAtivo: true, ultimaAtualizacaoCronometro: new Date(T + 20000).toISOString() };
    salvarAncora('t1', { inicioServidor: T + 20000, inicioLocal: T });
    expect(ancoraDaSessao(tarefa, T + 30000)).toEqual({ inicioServidor: T + 20000, inicioLocal: T });
    const outra = { ...tarefa, ultimaAtualizacaoCronometro: new Date(T + 80000).toISOString() };
    medirInicio(T + 20000, T, T); // diferenca medida: servidor 20 s adiantado
    // Carga em T + 90 s (servidor T + 110 s): a sessao comecou ha 30 s no relogio do servidor.
    expect(segundosDoCronometro({ ...outra, tempoGastoSegundos: 0 }, T + 90000, ancoraDaSessao(outra, T + 90000))).toBe(30);
  });

  test('manterAncoras e removerAncora limpam sessoes encerradas', () => {
    salvarAncora('a', { inicioServidor: 1, inicioLocal: 1 });
    salvarAncora('b', { inicioServidor: 2, inicioLocal: 2 });
    manterAncoras(new Set(['b']));
    expect(lerAncoraSalva({ _id: 'a', ultimaAtualizacaoCronometro: new Date(1).toISOString() })).toBeNull();
    removerAncora('b');
    expect(lerAncoraSalva({ _id: 'b', ultimaAtualizacaoCronometro: new Date(2).toISOString() })).toBeNull();
  });
});
