import React, { useMemo, useState } from 'react';
import { Link, useInRouterContext } from 'react-router-dom';
import { authUtils } from '../../config/authUtils';
import { taskRouteFor } from '../../utils/navigationRequests';
import {
  STATUS_LABELS,
  URGENCY_LABELS,
  describeDeadline,
  isOverdue,
  splitReplyText,
  summaryCounts,
  taskRouteForQuery,
} from '../../utils/assistantQuery';

const COLLAPSED_LIMIT = 5;
const ALL_TASKS_LABELS = { '/minhas-tarefas': 'Abrir Minhas tarefas', '/admin/tarefas': 'Abrir Tarefas' };

// Resultado de uma consulta de tarefas dentro da mensagem do assistente: introducao do reply_text, indicadores do
// resumo (quando completos), lista compacta e navegacao para Minhas tarefas. So dados reais da resposta; apenas
// navegacao (nenhuma acao de escrita).
function AssistantQueryResults({ query, replyText }) {
  const inRouter = useInRouterContext();
  const [expanded, setExpanded] = useState(false);
  const { intro, hint, listed } = useMemo(() => splitReplyText(replyText), [replyText]);
  const counts = summaryCounts(query);
  const numbered = query.type !== 'summary'; // a numeracao e a mesma que a fala usa para "detalhes da 1"
  const tasks = expanded ? query.tasks : query.tasks.slice(0, COLLAPSED_LIMIT);
  const hidden = query.tasks.length - tasks.length;
  const missing = query.total - query.tasks.length;
  // So encurta o texto quando a lista realmente vai aparecer nos cartoes.
  const introOnly = listed && query.tasks.length > 0;
  // Rota que ja abre a tarefa pelo ID; sem rota segura (backlog), so os dados.
  const userType = authUtils.getUserType();
  // "Mais urgentes" vem da lista aberta, que pode ser do backlog (colaborador) ou a listagem geral (admin): rota do
  // perfil, e para o colaborador so com responsavel (as listas dele so tem as proprias tarefas ou o backlog sem dono).
  const route = inRouter ? (query.type === 'urgent' ? taskRouteFor(userType) : taskRouteForQuery(query.type)) : null;
  const linkable = (task) => Boolean(route && task.id)
    && (query.type !== 'urgent' || userType === 'admin' || Boolean(task.responsavel));
  const showOwner = query.type === 'list_tasks' || query.type === 'backlog';

  return (
    <div className="voice-query">
      {/* Sem lista no texto (resumo, vazio) ou sem itens validos: o texto inteiro continua sendo a resposta. */}
      <p className="voice-message-text">{introOnly ? intro : replyText}</p>

      {counts && (
        <ul className="voice-query-counts" aria-label="Resumo das tarefas">
          <li className={counts.overdue ? 'alert' : ''}><strong>{counts.overdue}</strong> atrasadas</li>
          <li><strong>{counts.today}</strong> para hoje</li>
          <li><strong>{counts.upcoming}</strong> nos próximos 7 dias</li>
        </ul>
      )}

      {query.tasks.length > 0 && (
        <ol className="voice-query-list" aria-label={`Tarefas encontradas: ${query.total}`}>
          {tasks.map((task, index) => {
            const overdue = isOverdue(task, query.today);
            return (
              <li key={task.id || `${task.titulo}-${index}`} className={`voice-query-item ${overdue ? 'overdue' : ''}`}>
                {numbered && <span className="voice-query-index" aria-hidden="true">{task.position || index + 1}</span>}
                <div className="voice-query-body">
                  <span className="voice-query-title">{task.titulo}</span>
                  <span className="voice-query-meta">
                    <span className={`voice-query-chip deadline ${overdue ? 'overdue' : ''}`}>
                      {overdue ? `Atrasada · ${describeDeadline(task, query.today)}` : describeDeadline(task, query.today)}
                    </span>
                    <span className={`voice-query-chip status ${task.status}`}>
                      {STATUS_LABELS[task.status] || task.status.replace(/_/g, ' ')}
                    </span>
                    {task.urgencia && (
                      <span className={`voice-query-chip urgency ${task.urgencia}`}>
                        Prioridade {URGENCY_LABELS[task.urgencia]}
                      </span>
                    )}
                    {task.equipe && <span className="voice-query-chip team">{task.equipe}</span>}
                    {showOwner && (
                      <span className="voice-query-chip owner">{task.responsavel || 'Sem responsável'}</span>
                    )}
                  </span>
                </div>
                {linkable(task) && (
                  <Link
                    className="voice-query-open"
                    to={route}
                    state={{ abrirTarefaId: task.id }}
                    aria-label={`Ver tarefa ${task.titulo}`}
                  >
                    Ver tarefa
                  </Link>
                )}
              </li>
            );
          })}
        </ol>
      )}

      {(hidden > 0 || missing > 0 || (route && query.tasks.length > 0)) && (
        <div className="voice-query-footer">
          {hidden > 0 && (
            <button type="button" className="voice-query-more" onClick={() => setExpanded(true)}>
              Mostrar mais {hidden}
            </button>
          )}
          {missing > 0 && (
            <span className="voice-query-note">
              Mostrando {query.tasks.length} de {query.total} tarefas.
            </span>
          )}
          {route && query.tasks.length > 0 && (
            <Link className="voice-query-all" to={route}>{ALL_TASKS_LABELS[route]}</Link>
          )}
        </div>
      )}

      {introOnly && hint && <p className="voice-query-hint">{hint}</p>}
    </div>
  );
}

export default AssistantQueryResults;
