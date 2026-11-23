import React, { useMemo, useState } from 'react';
import { Link, useInRouterContext } from 'react-router-dom';
import {
  STATUS_LABELS,
  URGENCY_LABELS,
  describeDeadline,
  isOverdue,
  splitReplyText,
  summaryCounts,
} from '../../utils/assistantQuery';

const COLLAPSED_LIMIT = 5;
const MY_TASKS_ROUTE = '/minhas-tarefas';

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
                {numbered && <span className="voice-query-index" aria-hidden="true">{index + 1}</span>}
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
                  </span>
                </div>
                {inRouter && task.id && (
                  <Link
                    className="voice-query-open"
                    to={MY_TASKS_ROUTE}
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

      {(hidden > 0 || missing > 0 || (inRouter && query.tasks.length > 0)) && (
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
          {inRouter && query.tasks.length > 0 && (
            <Link className="voice-query-all" to={MY_TASKS_ROUTE}>Abrir Minhas tarefas</Link>
          )}
        </div>
      )}

      {introOnly && hint && <p className="voice-query-hint">{hint}</p>}
    </div>
  );
}

export default AssistantQueryResults;
