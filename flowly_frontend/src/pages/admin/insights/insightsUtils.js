// Insights inteligentes (/admin/insights): contrato da URL, leitura defensiva da resposta da API e rotulos.
//
// URL (a fonte da verdade dos filtros globais e da aba; valores padrao nao aparecem):
//   equipe=<id de 24 hex>   equipe consultada (o backend confere se esta no escopo do administrador)
//   periodo=7|14|30         ultimos N dias civis em America/Sao_Paulo, incluindo hoje (padrao 7)
//   aba=geral|equipes|moderacao|alertas   (padrao geral; trocar de aba nao consulta a API)
//   ocorrencia=<id>         alerta aberto a partir de uma notificacao
// Valores invalidos sao ignorados (e avisados) e saem da URL na proxima alteracao.
//
// API: GET /admin/assistant-insights?versao=2&periodo=...&equipe=...&ocorrencia=...
// So uma resposta com `versao: 2` e tratada como dados do periodo. Um backend anterior ignora os parametros e
// devolve o resumo antigo (sem periodo): ele vira o modo "legado", identificado na tela.
import { insightsRoute, validObjectId } from '../../../utils/navigationRequests';

export const ABAS = [
  { valor: 'geral', rotulo: 'Visão geral' },
  { valor: 'equipes', rotulo: 'Equipes' },
  { valor: 'moderacao', rotulo: 'Moderação' },
  { valor: 'alertas', rotulo: 'Alertas' },
];
const VALORES_ABAS = ABAS.map((aba) => aba.valor);

export const PERIODOS = [
  { valor: 7, rotulo: 'Últimos 7 dias' },
  { valor: 14, rotulo: 'Últimos 14 dias' },
  { valor: 30, rotulo: 'Últimos 30 dias' },
];
const VALORES_PERIODOS = PERIODOS.map((periodo) => periodo.valor);

export const FILTROS_INSIGHTS_PADRAO = { equipe: '', periodo: 7, aba: 'geral', ocorrencia: '' };

export function lerFiltrosInsights(params) {
  const filtros = { ...FILTROS_INSIGHTS_PADRAO };
  const invalidos = [];
  const ler = (nome) => {
    const valor = params.get(nome);
    return valor === null ? null : valor.trim();
  };

  const equipe = ler('equipe');
  if (equipe) {
    if (validObjectId(equipe)) filtros.equipe = equipe.toLowerCase();
    else invalidos.push('equipe');
  }
  const periodo = ler('periodo');
  if (periodo) {
    const numero = /^\d+$/.test(periodo) ? Number(periodo) : NaN;
    if (VALORES_PERIODOS.includes(numero)) filtros.periodo = numero;
    else invalidos.push('período');
  }
  const aba = ler('aba');
  if (aba) {
    if (VALORES_ABAS.includes(aba)) filtros.aba = aba;
    else invalidos.push('aba');
  }
  const ocorrencia = ler('ocorrencia');
  if (ocorrencia) {
    if (validObjectId(ocorrencia)) filtros.ocorrencia = ocorrencia.toLowerCase();
    else invalidos.push('ocorrência');
  }
  return { filtros, invalidos };
}

export function serializarFiltrosInsights(filtros) {
  const params = new URLSearchParams();
  if (filtros.equipe) params.set('equipe', filtros.equipe);
  if (filtros.periodo && filtros.periodo !== FILTROS_INSIGHTS_PADRAO.periodo) params.set('periodo', String(filtros.periodo));
  if (filtros.aba && filtros.aba !== FILTROS_INSIGHTS_PADRAO.aba) params.set('aba', filtros.aba);
  if (filtros.ocorrencia) params.set('ocorrencia', filtros.ocorrencia);
  return params;
}

export const linkInsights = (filtros = {}) => insightsRoute(filtros);

// Chave da consulta: a aba nao entra (trocar de aba nao consulta a API).
export const chaveDaConsulta = ({ equipe, periodo, ocorrencia }) => `${equipe || ''}|${periodo}|${ocorrencia || ''}`;

export const parametrosDaConsulta = ({ equipe, periodo, ocorrencia }) => ({
  versao: 2,
  periodo,
  ...(equipe ? { equipe } : {}),
  ...(ocorrencia ? { ocorrencia } : {}),
});

// ---------------------------------------------------------------------------------------------------------------
// Leitura defensiva: um campo ausente ou malformado vira null (exibido como "indisponivel"), nunca zero.
// ---------------------------------------------------------------------------------------------------------------
const numero = (valor) => (Number.isInteger(valor) && valor >= 0 ? valor : null);
const texto = (valor) => (typeof valor === 'string' && valor.trim() ? valor.trim() : null);
const objeto = (valor) => (valor && typeof valor === 'object' && !Array.isArray(valor) ? valor : null);
const lista = (valor) => (Array.isArray(valor) ? valor : null);

const CAMPOS_CONTAGEM = ['registros', 'chat', 'bloqueadas', 'ajuda', 'assistente', 'origemDesconhecida', 'indiciosSpam', 'sinaisColetivos'];
const CAMPOS_ALERTAS = ['individuais', 'coletivos', 'historicos', 'semVinculo', 'total'];

const lerContagem = (fonte, campos) => Object.fromEntries(campos.map((campo) => [campo, numero(fonte?.[campo])]));

const lerEquipe = (valor) => {
  const equipe = objeto(valor);
  const id = validObjectId(String(equipe?.id ?? ''));
  return id ? { id: id.toLowerCase(), nome: texto(equipe.nome) || 'Equipe sem nome', participa: equipe.participa === true } : null;
};

const lerRotulado = (valor) => {
  const item = objeto(valor);
  return item ? { codigo: typeof item.codigo === 'string' ? item.codigo : null, rotulo: texto(item.rotulo) || 'Não registrada' } : { codigo: null, rotulo: 'Não registrada' };
};

const lerAlerta = (valor) => {
  const item = objeto(valor);
  if (!item) return null;
  const escopo = ['individual', 'coletivo', 'historico'].includes(item.escopo) ? item.escopo : 'historico';
  // Sem o campo (versao anterior desta resposta), o vinculo nao e presumido confiavel.
  const vinculo = ['confiavel', 'divergente', 'ausente'].includes(item.vinculo) ? item.vinculo : 'ausente';
  // Pessoa so em alerta individual com vinculo confiavel, mesmo que a resposta traga outra coisa.
  const colaborador = escopo === 'individual' && vinculo === 'confiavel' && objeto(item.colaborador) && texto(item.colaborador.nome)
    ? { nome: texto(item.colaborador.nome) }
    : null;
  return {
    id: vinculo === 'confiavel' ? validObjectId(String(item.id ?? '')) : null,
    vinculo,
    data: texto(item.data),
    equipe: lerEquipe(item.equipe),
    escopo,
    gravidade: lerRotulado(item.gravidade),
    categoria: lerRotulado(item.categoria),
    ocorrencias: numero(item.ocorrencias) || null,
    motivos: (lista(item.motivos) || []).map(texto).filter(Boolean),
    colaborador,
  };
};

const lerSerie = (valor, tamanho) => {
  const serie = lista(valor);
  if (!serie || serie.length !== tamanho) return null;
  const numeros = serie.map(numero);
  return numeros.every((n) => n !== null) ? numeros : null;
};

const lerEvolucao = (valor) => {
  const evolucao = objeto(valor);
  const dias = lista(evolucao?.dias);
  if (!dias || dias.length === 0 || !dias.every((dia) => /^\d{4}-\d{2}-\d{2}$/.test(dia))) return null;
  const series = objeto(evolucao.series) || {};
  return {
    dias,
    series: Object.fromEntries(['chat', 'bloqueadas', 'ajuda', 'assistente'].map((nome) => [nome, lerSerie(series[nome], dias.length)])),
  };
};

const lerRecomendacao = (valor) => {
  const item = objeto(valor);
  if (!item || !texto(item.evidencia)) return null;
  const destino = objeto(item.destino);
  return {
    chave: texto(item.chave) || texto(item.evidencia),
    tipo: texto(item.tipo) || 'outro',
    situacao: texto(item.situacao),
    evidencia: texto(item.evidencia),
    acao: texto(item.acao),
    quantidade: numero(item.quantidade),
    equipe: lerEquipe(item.equipe),
    destino: destino && VALORES_ABAS.includes(destino.aba)
      ? { aba: destino.aba, equipe: validObjectId(String(destino.equipe ?? '')) || '' }
      : null,
  };
};

export function normalizarInsightsV2(bruto) {
  const dados = objeto(bruto);
  const periodo = objeto(dados?.periodo);
  if (!dados || !VALORES_PERIODOS.includes(periodo?.dias) || !texto(periodo.primeiroDia) || !texto(periodo.ultimoDia)) return null;

  const equipes = lista(dados.equipes)?.map(lerEquipe).filter(Boolean) ?? null;
  const totais = objeto(dados.totais);
  const moderacao = objeto(dados.moderacao);
  const alertas = objeto(dados.alertas);
  const limites = objeto(dados.limites) || {};
  const ocorrencia = objeto(dados.ocorrenciaSolicitada);

  return {
    periodo: { dias: periodo.dias, primeiroDia: periodo.primeiroDia, ultimoDia: periodo.ultimoDia },
    filtroEquipe: validObjectId(String(objeto(dados.filtros)?.equipe ?? ''))?.toLowerCase() || '',
    filtroPeriodo: objeto(dados.filtros)?.periodo ?? null,
    equipeIndisponivel: Boolean(objeto(dados.equipeSolicitada) && dados.equipeSolicitada.disponivel === false),
    equipes,
    totais: totais
      ? {
        ...lerContagem(totais, CAMPOS_CONTAGEM),
        equipesComRegistros: numero(totais.equipesComRegistros),
        equipesComAlertas: numero(totais.equipesComAlertas),
        alertas: lerContagem(objeto(totais.alertas), CAMPOS_ALERTAS),
      }
      : null,
    evolucao: lerEvolucao(dados.evolucao),
    porEquipe: lista(dados.porEquipe)
      ?.map((item) => {
        const equipe = lerEquipe(item?.equipe);
        if (!equipe) return null;
        const moderacaoEquipe = objeto(item.moderacao) || {};
        return {
          equipe,
          ...lerContagem(item, CAMPOS_CONTAGEM),
          alertas: lerContagem(objeto(item.alertas), CAMPOS_ALERTAS),
          moderacao: Object.fromEntries(Object.entries(moderacaoEquipe).map(([codigo, total]) => [codigo, numero(total)])),
          // null: assuntos indisponiveis nesta resposta (diferente de nenhum assunto reconhecido).
          assuntos: lista(item.assuntos)
            ?.map((assunto) => (texto(assunto?.rotulo) && numero(assunto?.total) ? { codigo: assunto.codigo, rotulo: texto(assunto.rotulo), total: assunto.total } : null))
            .filter(Boolean) ?? null,
        };
      })
      .filter(Boolean) ?? null,
    moderacao: moderacao
      ? {
        total: numero(moderacao.total),
        indiciosSpam: numero(moderacao.indiciosSpam),
        porCategoria: lista(moderacao.porCategoria)
          ?.map((item) => (texto(item?.rotulo) && numero(item?.total) !== null ? { codigo: item.codigo, rotulo: texto(item.rotulo), total: item.total } : null))
          .filter(Boolean) ?? null,
        recentes: lista(moderacao.recentes)
          ?.map((item) => (objeto(item) && texto(item.data)
            ? { id: texto(item.id), data: item.data, equipe: lerEquipe(item.equipe), categoria: lerRotulado(item.categoria), gravidade: lerRotulado(item.gravidade), grave: item.grave === true }
            : null))
          .filter(Boolean) ?? null,
      }
      : null,
    alertas: alertas && lista(alertas.itens)
      ? { total: numero(alertas.total), itens: alertas.itens.map(lerAlerta).filter(Boolean) }
      : null,
    limites: {
      registrosParciais: limites.registrosParciais === true,
      assuntosParciais: limites.assuntosParciais === true,
      alertasParciais: limites.alertasParciais === true,
    },
    ocorrencia: ocorrencia && ['no_periodo', 'fora_do_periodo', 'indisponivel'].includes(ocorrencia.status)
      ? { id: validObjectId(String(ocorrencia.id ?? '')), status: ocorrencia.status, item: ocorrencia.item ? lerAlerta(ocorrencia.item) : null }
      : null,
    recomendacoes: lista(dados.recomendacoes)?.map(lerRecomendacao).filter(Boolean) ?? null,
  };
}

// Resumo antigo: so o que tem janela conhecida. Texto de mensagens, ranking de pessoas e percentuais de risco
// da resposta antiga nao sao usados.
export function normalizarInsightsLegado(bruto) {
  const dados = objeto(bruto);
  if (!dados) return null;
  const totalMessages = numero(dados.totalMessages);
  const equipes = lista(dados.chatSummaries) || lista(dados.byTeam);
  if (totalMessages === null && !equipes) return null;
  return {
    totalRegistros: totalMessages,
    janelaChatDias: numero(dados.chatWindowDays),
    equipes: equipes
      ?.map((item) => {
        const id = validObjectId(String(item?.channelId ?? ''));
        return id ? { id: id.toLowerCase(), nome: texto(item.teamName) || 'Equipe sem nome', mensagens: numero(item.totalMessages) } : null;
      })
      .filter(Boolean)
      .sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR', { sensitivity: 'base' })) ?? null,
  };
}

// { modo: 'v2', dados } | { modo: 'legado', dados } | { modo: 'invalida' }
export function interpretarResposta(corpo) {
  const resposta = objeto(corpo);
  if (!resposta || resposta.success === false) return { modo: 'invalida' };
  if (resposta.versao === 2 || resposta.insights?.versao === 2) {
    const dados = normalizarInsightsV2(resposta.insights);
    return dados ? { modo: 'v2', dados } : { modo: 'invalida' };
  }
  const legado = normalizarInsightsLegado(resposta.insights);
  return legado ? { modo: 'legado', dados: legado } : { modo: 'invalida' };
}

// ---------------------------------------------------------------------------------------------------------------
// Formatacao
// ---------------------------------------------------------------------------------------------------------------
const FUSO = 'America/Sao_Paulo';
const formatadorDataHora = new Intl.DateTimeFormat('pt-BR', {
  timeZone: FUSO, day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
});
const formatadorData = new Intl.DateTimeFormat('pt-BR', { timeZone: FUSO, day: '2-digit', month: '2-digit', year: 'numeric' });

export const formatarDataHora = (iso) => {
  const data = iso ? new Date(iso) : null;
  return data && !Number.isNaN(data.getTime()) ? formatadorDataHora.format(data).replace(',', ' às') : 'Data indisponível';
};

export const formatarData = (iso) => {
  const data = iso ? new Date(iso) : null;
  return data && !Number.isNaN(data.getTime()) ? formatadorData.format(data) : 'Data indisponível';
};

// '2026-11-19' -> '19/11' (dia civil ja calculado no fuso pelo backend).
export const formatarDia = (dia) => {
  const [, mes, d] = String(dia).split('-');
  return d && mes ? `${d}/${mes}` : String(dia);
};

export const descreverPeriodo = (periodo) => (periodo
  ? `${PERIODOS.find((item) => item.valor === periodo.dias)?.rotulo || `Últimos ${periodo.dias} dias`} (${formatarDia(periodo.primeiroDia)} a ${formatarDia(periodo.ultimoDia)})`
  : '');

export const ESCOPOS_ALERTA = {
  individual: 'Individual',
  coletivo: 'Coletivo',
  historico: 'Histórico sem escopo',
};

export const GRAVIDADES = [
  { valor: 'low', rotulo: 'Atenção' },
  { valor: 'medium', rotulo: 'Moderado' },
  { valor: 'high', rotulo: 'Alto' },
];

export const formatarQuantidade = (valor) => (valor === null || valor === undefined ? '—' : valor.toLocaleString('pt-BR'));
