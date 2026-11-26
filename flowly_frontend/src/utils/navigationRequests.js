// Navegacao contextual entre telas (notificacao -> tarefa/chat, equipe -> chat, painel -> tarefa).
// O pedido viaja no state do React Router ({ abrirTarefaId } ou { equipeId }) e a tela de destino so o atende se o
// recurso estiver na lista que ela mesma carregou da API. Nada aqui autoriza nada: o perfil so escolhe a rota.

const OBJECT_ID_RE = /^[a-f\d]{24}$/i;

export const validObjectId = (value) => (typeof value === 'string' && OBJECT_ID_RE.test(value) ? value : null);

export const taskRouteFor = (userType) => (userType === 'admin' ? '/admin/tarefas' : '/minhas-tarefas');
export const chatRouteFor = (userType) => (userType === 'admin' ? '/admin/chats' : '/chats');

// /admin/insights com os filtros na URL (contrato em pages/admin/insights/insightsUtils.js). Padroes omitidos.
export const insightsRoute = ({ equipe, periodo, aba, ocorrencia } = {}) => {
  const params = new URLSearchParams();
  if (equipe) params.set('equipe', equipe);
  if (periodo && Number(periodo) !== 7) params.set('periodo', String(periodo));
  if (aba && aba !== 'geral') params.set('aba', aba);
  if (ocorrencia) params.set('ocorrencia', ocorrencia);
  const busca = params.toString();
  return busca ? `/admin/insights?${busca}` : '/admin/insights';
};

export const NOTIFICATION_TYPE_LABELS = {
  task: 'Tarefa',
  chat: 'Mensagem',
  team: 'Equipe',
  system: 'Sistema',
};

// Destino de uma notificacao, ou null quando nao ha recurso identificavel (sistema, dados ausentes ou malformados).
// Contrato do backend: task -> metadata.tarefaId (origemId e o mesmo id); chat -> metadata.equipeId;
// alerta de equipe (assistantInsightService, so para administradores) -> tipo system, metadata.kind
// 'team_insight_alert', metadata.equipeId e metadata.insightId (origemId e o mesmo id).
export function notificationTarget(notification, userType) {
  if (!notification || typeof notification !== 'object') return null;
  const metadata = notification.metadata && typeof notification.metadata === 'object' ? notification.metadata : {};
  if (notification.tipo === 'task') {
    const tarefaId = validObjectId(String(metadata.tarefaId ?? '')) || validObjectId(String(notification.origemId ?? ''));
    return tarefaId
      ? { to: taskRouteFor(userType), state: { abrirTarefaId: tarefaId }, label: 'Ver tarefa' }
      : null;
  }
  if (notification.tipo === 'chat') {
    const equipeId = validObjectId(String(metadata.equipeId ?? ''));
    return equipeId
      ? { to: chatRouteFor(userType), state: { equipeId }, label: 'Abrir conversa' }
      : null;
  }
  if (notification.tipo === 'system' && metadata.kind === 'team_insight_alert' && userType === 'admin') {
    const equipeId = validObjectId(String(metadata.equipeId ?? ''));
    if (!equipeId) return null;
    const ocorrencia = validObjectId(String(metadata.insightId ?? '')) || validObjectId(String(notification.origemId ?? ''));
    return { to: insightsRoute({ equipe: equipeId, aba: 'alertas', ocorrencia }), label: 'Ver alerta' };
  }
  return null;
}
