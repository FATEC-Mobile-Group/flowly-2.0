// Backlog do colaborador: pesquisa, filtros e ordenacao sobre a lista ja carregada (GET /tarefas/backlog).
// Reaproveita as regras da gestao de tarefas (PR #62) e as datas civis do Painel Geral (PR #63): o prazo exibido e o
// dia gravado, o mesmo que a gestao administrativa mostra. Nada aqui consulta a API nem decide quem pode assumir.
import {
  URGENCIAS,
  backlogDisponivel,
  compararNomes,
  correspondeBusca,
  filtrarTarefas,
  idDaEquipeDaTarefa,
} from '../admin/adminFiltrosUtils';
import { descreverPrazo, diaDaEntrega, formatarDataEntrega } from '../dashboard/painelGeralUtils';

export const ORDENS_BACKLOG = [
  { valor: 'prazoProximo', rotulo: 'Prazo mais próximo' },
  { valor: 'urgenciaMaior', rotulo: 'Maior prioridade' },
  { valor: 'recentes', rotulo: 'Criadas mais recentemente' },
];
export const ORDEM_PADRAO_BACKLOG = 'prazoProximo';
export const FILTROS_BACKLOG_PADRAO = { busca: '', equipe: '', urgencia: '', ordem: ORDEM_PADRAO_BACKLOG };
export const URGENCIAS_BACKLOG = URGENCIAS;

// So o recorte que pode ser assumido (pendente e sem responsavel), como a API ja devolve: uma resposta antiga ou
// atrasada nunca oferece "Atribuir para mim" para uma tarefa que nao e elegivel.
export const tarefasDisponiveis = (tarefas) => (Array.isArray(tarefas) ? tarefas.filter((t) => t && backlogDisponivel(t)) : []);

// Equipes do filtro: as que aparecem nas tarefas disponiveis, por id, em ordem alfabetica.
export function equipesDoBacklog(tarefas) {
  const equipes = new Map();
  tarefas.forEach((tarefa) => {
    const id = idDaEquipeDaTarefa(tarefa);
    if (id && !equipes.has(id)) equipes.set(id, tarefa.equipe?.nome || 'Equipe sem nome');
  });
  return [...equipes].map(([id, nome]) => ({ id, nome })).sort((a, b) => compararNomes(a.nome, b.nome) || a.id.localeCompare(b.id));
}

// Pesquisa so no titulo (descricao) e na descricao (detalhes); equipe que nao esta mais na lista e ignorada.
export function filtrarBacklog(tarefas, filtros) {
  const ordem = ORDENS_BACKLOG.some((opcao) => opcao.valor === filtros.ordem) ? filtros.ordem : ORDEM_PADRAO_BACKLOG;
  const urgencia = URGENCIAS.some((opcao) => opcao.valor === filtros.urgencia) ? filtros.urgencia : '';
  return filtrarTarefas(tarefas, { busca: '', equipe: filtros.equipe || '', atribuicao: '', status: '', urgencia, prazo: '', criacao: '', ordem })
    .filter((tarefa) => correspondeBusca([tarefa.descricao, tarefa.detalhes], filtros.busca));
}

export const backlogComFiltroAtivo = (filtros) => Boolean(filtros.busca.trim() || filtros.equipe || filtros.urgencia);

// Prazo para exibicao: data civil gravada (dd/mm/aaaa) e a situacao em relacao a hoje (dia local de quem olha).
export function prazoDoBacklog(tarefa, hoje) {
  const dia = diaDaEntrega(tarefa?.dataEntrega);
  if (!dia) return { texto: 'Sem prazo', situacao: 'sem', detalhe: null, dia: null };
  const situacao = dia < hoje ? 'atrasada' : dia === hoje ? 'hoje' : 'futura';
  return { texto: formatarDataEntrega(tarefa.dataEntrega), situacao, detalhe: descreverPrazo(dia, hoje), dia };
}
