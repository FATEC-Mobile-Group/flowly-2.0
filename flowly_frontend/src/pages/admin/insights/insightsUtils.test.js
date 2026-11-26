// Contrato da URL dos Insights e leitura defensiva das respostas (versao 2, legado e formatos inesperados).
import {
  FILTROS_INSIGHTS_PADRAO,
  chaveDaConsulta,
  descreverPeriodo,
  formatarDataHora,
  interpretarResposta,
  lerFiltrosInsights,
  linkInsights,
  parametrosDaConsulta,
  serializarFiltrosInsights,
} from './insightsUtils';

const oid = (n) => n.toString(16).padStart(24, '0');
const ler = (busca) => lerFiltrosInsights(new URLSearchParams(busca));

describe('URL', () => {
  test('padrao sem parametros', () => {
    expect(ler('')).toEqual({ filtros: FILTROS_INSIGHTS_PADRAO, invalidos: [] });
  });

  test('valores validos, com id normalizado em minusculas', () => {
    expect(ler(`equipe=${oid(171).toUpperCase()}&periodo=30&aba=alertas&ocorrencia=${oid(5)}`)).toEqual({
      filtros: { equipe: oid(171), periodo: 30, aba: 'alertas', ocorrencia: oid(5) },
      invalidos: [],
    });
  });

  test.each([
    ['equipe=123', ['equipe']],
    ['equipe=<script>', ['equipe']],
    ['periodo=10', ['período']],
    ['periodo=7.5', ['período']],
    ['periodo=-7', ['período']],
    ['aba=resumo', ['aba']],
    ['ocorrencia=abc', ['ocorrência']],
  ])('%s e ignorado e avisado', (busca, invalidos) => {
    const lido = ler(busca);
    expect(lido.invalidos).toEqual(invalidos);
    expect(lido.filtros).toEqual(FILTROS_INSIGHTS_PADRAO);
  });

  test('serializacao omite padroes e volta ao mesmo filtro', () => {
    expect(serializarFiltrosInsights(FILTROS_INSIGHTS_PADRAO).toString()).toBe('');
    const filtros = { equipe: oid(1), periodo: 14, aba: 'moderacao', ocorrencia: '' };
    const params = serializarFiltrosInsights(filtros);
    expect(params.toString()).toBe(`equipe=${oid(1)}&periodo=14&aba=moderacao`);
    expect(lerFiltrosInsights(params).filtros).toEqual(filtros);
    expect(linkInsights({ equipe: oid(1), aba: 'alertas', ocorrencia: oid(2) })).toBe(`/admin/insights?equipe=${oid(1)}&aba=alertas&ocorrencia=${oid(2)}`);
    expect(linkInsights()).toBe('/admin/insights');
  });

  test('a aba nao faz parte da consulta', () => {
    const base = { equipe: oid(1), periodo: 7, ocorrencia: '' };
    expect(chaveDaConsulta({ ...base, aba: 'geral' })).toBe(chaveDaConsulta({ ...base, aba: 'alertas' }));
    expect(chaveDaConsulta({ ...base, periodo: 14 })).not.toBe(chaveDaConsulta(base));
    expect(parametrosDaConsulta({ ...base, aba: 'alertas' })).toEqual({ versao: 2, periodo: 7, equipe: oid(1) });
  });
});

describe('interpretarResposta', () => {
  const v2 = (insights) => ({ success: true, versao: 2, insights: { periodo: { dias: 7, primeiroDia: '2026-11-19', ultimoDia: '2026-11-25' }, ...insights } });

  test('versao 2 minima: secoes ausentes ficam null, nao zero', () => {
    const { modo, dados } = interpretarResposta(v2({}));
    expect(modo).toBe('v2');
    expect(dados).toMatchObject({ totais: null, evolucao: null, porEquipe: null, moderacao: null, alertas: null, recomendacoes: null, equipes: null });
  });

  test('numeros invalidos viram null; serie de tamanho errado e descartada', () => {
    const { dados } = interpretarResposta(v2({
      totais: { registros: '13', chat: -1, bloqueadas: 2.5, ajuda: 2, alertas: { total: 1 } },
      evolucao: { dias: ['2026-11-24', '2026-11-25'], series: { chat: [1, 2], bloqueadas: [1], ajuda: [1, 'x'] } },
    }));
    expect(dados.totais).toMatchObject({ registros: null, chat: null, bloqueadas: null, ajuda: 2, alertas: { total: 1, individuais: null } });
    expect(dados.evolucao.series).toEqual({ chat: [1, 2], bloqueadas: null, ajuda: null, assistente: null });
  });

  test('equipe com id invalido e descartada; pessoa so em alerta individual', () => {
    const { dados } = interpretarResposta(v2({
      equipes: [{ id: oid(1), nome: 'Alfa', participa: true }, { id: 'x', nome: 'Invalida' }],
      alertas: {
        total: 2,
        itens: [
          { id: oid(9), escopo: 'coletivo', colaborador: { nome: 'Não deve aparecer' }, gravidade: { codigo: 'medium', rotulo: 'Moderado' } },
          { id: oid(8), escopo: 'outro', motivos: ['Motivo', 3] },
        ],
      },
    }));
    expect(dados.equipes).toEqual([{ id: oid(1), nome: 'Alfa', participa: true }]);
    expect(dados.alertas.itens[0].colaborador).toBeNull();
    expect(dados.alertas.itens[1]).toMatchObject({ escopo: 'historico', motivos: ['Motivo'], gravidade: { codigo: null, rotulo: 'Não registrada' } });
  });

  test('resposta antiga: modo legado so com o que tem janela conhecida', () => {
    const { modo, dados } = interpretarResposta({
      success: true,
      insights: {
        totalMessages: 40, chatWindowDays: 7, spamAlerts: 9,
        byTeam: [{ channelId: oid(2), teamName: 'Beta', totalMessages: 3 }, { channelId: 'web', teamName: 'Canal Web', totalMessages: 5 }],
        recent: [{ content: 'texto' }], badActors: [{ userName: 'Fulano' }], suggestions: ['x'],
      },
    });
    expect(modo).toBe('legado');
    expect(dados).toEqual({ totalRegistros: 40, janelaChatDias: 7, equipes: [{ id: oid(2), nome: 'Beta', mensagens: 3 }] });
  });

  test.each([
    [null],
    ['texto'],
    [{ success: false, erro: 'x' }],
    [{ success: true, versao: 2, insights: { totais: {} } }],
    [{ success: true, versao: 2, insights: { periodo: { dias: 9, primeiroDia: 'a', ultimoDia: 'b' } } }],
    [{ success: true, insights: {} }],
  ])('formato inesperado: %o', (corpo) => {
    expect(interpretarResposta(corpo)).toEqual({ modo: 'invalida' });
  });
});

describe('formatacao no fuso de Sao Paulo', () => {
  test('data e periodo', () => {
    expect(formatarDataHora('2026-11-25T02:30:00.000Z')).toBe('24/11/2026 às 23:30');
    expect(formatarDataHora('invalida')).toBe('Data indisponível');
    expect(descreverPeriodo({ dias: 14, primeiroDia: '2026-11-12', ultimoDia: '2026-11-25' })).toBe('Últimos 14 dias (12/11 a 25/11)');
  });
});
