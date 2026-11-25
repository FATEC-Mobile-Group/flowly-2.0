// Regras do Painel Geral reformulado (PR #63), sobre os dados ja carregados (GET /equipes e GET /tarefas).
// Reaproveita as regras do PR #62 (filtros da pagina de tarefas) para que cada indicador conte exatamente o mesmo
// recorte que o link correspondente abre em /admin/tarefas. Nada aqui consulta a API.
import {
  calcularIndicadores,
  descreverPrazo,
  diaDaEntrega,
  diferencaEmDias,
  estaAtrasada,
  formatarDia,
  idDaEquipe,
} from './painelGeralUtils';
import {
  ATRIBUICAO_BACKLOG,
  ATRIBUICAO_SEM_RESPONSAVEL,
  FILTROS_TAREFAS_PADRAO,
  backlogDisponivel,
  correspondePrazo,
  semResponsavel,
  serializarFiltrosTarefas,
} from '../admin/adminFiltrosUtils';
import { validObjectId } from '../../utils/navigationRequests';

export const LIMITE_ENTREGAS = 5;
export const STATUS_OFICIAIS = ['pendente', 'em_andamento', 'concluido'];

const nomes = new Intl.Collator('pt-BR', { sensitivity: 'base', numeric: true });

// ------------------------------------------------------------------------------------------------------------
// Links para a gestao de tarefas, com o contrato de URL do PR #62. Equipe selecionada vai junto.

export function linkTarefas(equipeId, filtros = {}) {
  const params = serializarFiltrosTarefas({ ...FILTROS_TAREFAS_PADRAO, equipe: equipeId || '', ...filtros });
  const consulta = params.toString();
  return consulta ? `/admin/tarefas?${consulta}` : '/admin/tarefas';
}

export const DESTINOS = {
  todas: {},
  concluidas: { status: 'concluido' },
  pendentes: { status: 'pendente' },
  emAndamento: { status: 'em_andamento' },
  atrasadas: { prazo: 'atrasadas' },
  semResponsavel: { atribuicao: ATRIBUICAO_SEM_RESPONSAVEL },
  backlog: { atribuicao: ATRIBUICAO_BACKLOG },
  vencemHoje: { prazo: 'hoje' },
  proximos7: { prazo: '7dias' },
};

// ------------------------------------------------------------------------------------------------------------
// Participantes unicos. Deduplica por id entre equipes. So exclui administradores quando TODOS os participantes
// trazem o tipo (API com o campo aditivo); sem isso, conta participantes (pode incluir administradores) e diz isso.

const idDoMembro = (membro) => {
  const id = membro && typeof membro === 'object' ? membro._id : membro;
  return id == null || id === '' ? null : String(id);
};

export function contarParticipantes(equipes) {
  const tipos = new Map();
  (Array.isArray(equipes) ? equipes : []).forEach((equipe) => {
    (Array.isArray(equipe?.membros) ? equipe.membros : []).forEach((membro) => {
      const id = idDoMembro(membro);
      if (!id) return;
      const tipo = membro && typeof membro === 'object' ? membro.tipo : undefined;
      if (!tipos.has(id) || (tipo && !tipos.get(id))) tipos.set(id, tipo);
    });
  });
  const lista = [...tipos.values()];
  const tipoConfiavel = lista.every((tipo) => tipo === 'user' || tipo === 'admin');
  if (tipoConfiavel) {
    return { modo: 'colaboradores', total: lista.filter((tipo) => tipo === 'user').length, participantes: tipos.size };
  }
  return { modo: 'participantes', total: tipos.size, participantes: tipos.size };
}

// ------------------------------------------------------------------------------------------------------------
// Indicadores. Recortes sobrepostos (atrasada, sem responsavel, backlog) nunca sao somados entre si.

export function calcularPainel(equipes, tarefas, hoje) {
  const listaEquipes = Array.isArray(equipes) ? equipes : [];
  const listaTarefas = (Array.isArray(tarefas) ? tarefas : []).filter(Boolean);
  const base = calcularIndicadores(listaEquipes, listaTarefas, hoje);
  const contar = (regra) => listaTarefas.filter(regra).length;

  const pendentes = contar((t) => t.status === 'pendente');
  const emAndamento = contar((t) => t.status === 'em_andamento');
  return {
    ...base,
    pendentes,
    emAndamento,
    // Status fora dos tres oficiais: contam no total, mas nao entram em nenhuma fatia do grafico.
    statusDesconhecido: base.totalTarefas - pendentes - emAndamento - base.concluidas,
    equipesSemTarefas: base.equipes - base.equipesComTarefas,
    semResponsavel: contar(semResponsavel),
    backlog: contar(backlogDisponivel),
    vencemHoje: contar((t) => correspondePrazo(t, 'hoje', hoje)),
    proximos7: contar((t) => correspondePrazo(t, '7dias', hoje)),
    participantes: contarParticipantes(listaEquipes),
  };
}

// Distribuicao por status oficial; percentuais sobre o total de tarefas (inclusive status desconhecido).
export function distribuicaoStatus(indicadores) {
  const total = indicadores.totalTarefas;
  const percentual = (valor) => (total > 0 ? Math.round((valor / total) * 100) : 0);
  return [
    { chave: 'pendente', rotulo: 'Pendente', valor: indicadores.pendentes, destino: DESTINOS.pendentes },
    { chave: 'em_andamento', rotulo: 'Em andamento', valor: indicadores.emAndamento, destino: DESTINOS.emAndamento },
    { chave: 'concluido', rotulo: 'Concluída', valor: indicadores.concluidas, destino: DESTINOS.concluidas },
  ].map((item) => ({ ...item, percentual: percentual(item.valor) }));
}

// ------------------------------------------------------------------------------------------------------------
// Entregas: atrasadas (mais antigas primeiro) e proximos 7 dias (mesma regra do filtro prazo=7dias: de hoje ate
// hoje + 7, inclusive, so nao concluidas). Prazo ausente ou invalido nao entra em nenhuma das duas.

const paraItem = (tarefa, indice, hoje) => {
  const dia = diaDaEntrega(tarefa.dataEntrega);
  const equipeId = idDaEquipe(tarefa.equipe);
  return {
    id: tarefa._id != null ? String(tarefa._id) : `sem-id-${indice}`,
    abrivel: Boolean(validObjectId(tarefa._id != null ? String(tarefa._id) : '')),
    descricao: tarefa.descricao || 'Tarefa sem descrição',
    equipe: tarefa.equipe?.nome || 'Equipe não informada',
    equipeId,
    dia,
    data: formatarDia(dia),
    prazo: descreverPrazo(dia, hoje),
    diasAtraso: Math.max(0, -diferencaEmDias(hoje, dia)),
    atrasada: dia < hoje,
    venceHoje: dia === hoje,
  };
};

const ordenarPorPrazo = (a, b) => (a.dia < b.dia ? -1 : a.dia > b.dia ? 1 : 0)
  || nomes.compare(a.descricao, b.descricao)
  || a.id.localeCompare(b.id);

function selecionarEntregas(tarefas, hoje, regra, limite) {
  const itens = (Array.isArray(tarefas) ? tarefas : [])
    .filter(Boolean)
    .map((tarefa, indice) => ({ tarefa, indice }))
    .filter(({ tarefa }) => regra(tarefa) && diaDaEntrega(tarefa.dataEntrega) !== null)
    .map(({ tarefa, indice }) => paraItem(tarefa, indice, hoje))
    .sort(ordenarPorPrazo);
  return { total: itens.length, itens: itens.slice(0, limite) };
}

export const listarAtrasadas = (tarefas, hoje, limite = LIMITE_ENTREGAS) =>
  selecionarEntregas(tarefas, hoje, (tarefa) => estaAtrasada(tarefa, hoje), limite);

export const listarProximosSeteDias = (tarefas, hoje, limite = LIMITE_ENTREGAS) =>
  selecionarEntregas(tarefas, hoje, (tarefa) => correspondePrazo(tarefa, '7dias', hoje), limite);

export const periodoProximosSeteDias = (hoje) => {
  const [ano, mes, dia] = hoje.split('-').map(Number);
  const fim = new Date(Date.UTC(ano, mes - 1, dia + 7)).toISOString().slice(0, 10);
  return { inicio: formatarDia(hoje), fim: formatarDia(fim) };
};

// ------------------------------------------------------------------------------------------------------------
// Pontos de atencao: so fatos calculaveis que pedem acao administrativa, e so quando existem.

const plural = (n, singular, pluralTexto) => `${n} ${n === 1 ? singular : pluralTexto}`;

export function listarPontosAtencao(indicadores, { filtrando = false } = {}) {
  const pontos = [];
  if (indicadores.atrasadas > 0) {
    pontos.push({
      chave: 'atrasadas',
      quantidade: indicadores.atrasadas,
      tom: 'perigo',
      texto: `${plural(indicadores.atrasadas, 'tarefa atrasada', 'tarefas atrasadas')} (não concluídas, prazo vencido)`,
      destino: DESTINOS.atrasadas,
    });
  }
  if (indicadores.vencemHoje > 0) {
    pontos.push({
      chave: 'vencemHoje',
      quantidade: indicadores.vencemHoje,
      tom: 'alerta',
      texto: `${plural(indicadores.vencemHoje, 'tarefa vence', 'tarefas vencem')} hoje`,
      destino: DESTINOS.vencemHoje,
    });
  }
  // Sem responsavel: o total real, o mesmo que o link (semResponsavel=1) abre; quantas dessas estao no backlog vai
  // no proprio texto, em vez de um segundo alerta. O backlog continua com o indicador e o link proprios.
  if (indicadores.semResponsavel > 0) {
    const noBacklog = indicadores.backlog > 0
      ? `, sendo ${indicadores.backlog} ${indicadores.backlog === 1 ? 'disponível' : 'disponíveis'} no backlog`
      : '';
    pontos.push({
      chave: 'semResponsavel',
      quantidade: indicadores.semResponsavel,
      tom: 'alerta',
      texto: `${plural(indicadores.semResponsavel, 'tarefa sem responsável', 'tarefas sem responsável')}${noBacklog}`,
      destino: DESTINOS.semResponsavel,
    });
  }
  if (indicadores.equipesSemTarefas > 0) {
    pontos.push({
      chave: 'equipesSemTarefas',
      quantidade: indicadores.equipesSemTarefas,
      tom: 'neutro',
      texto: filtrando
        ? 'Esta equipe ainda não tem tarefas'
        : `${plural(indicadores.equipesSemTarefas, 'equipe sem tarefas', 'equipes sem tarefas')}`,
      equipes: true,
    });
  }
  return pontos;
}
