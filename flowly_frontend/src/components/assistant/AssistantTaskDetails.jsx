import React from 'react';
import { Link, useInRouterContext } from 'react-router-dom';
import { authUtils } from '../../config/authUtils';
import { taskRouteFor } from '../../utils/navigationRequests';
import { STATUS_LABELS, URGENCY_LABELS, describeDeadline, isOverdue } from '../../utils/assistantQuery';

// Convite que o assistente acrescenta aos detalhes no fluxo de selecao (texto fixo, nao dados da tarefa).
const SELECTION_HINT = 'Você pode pedir outra tarefa, atribuir para você ou cancelar.';

// Detalhes de uma tarefa na conversa: titulo em destaque, status, campos separados e descricao em bloco proprio.
// So dados reais do campo `task` da resposta; "Ver tarefa" so navega (nenhuma escrita) e so onde a rota ja abre a
// tarefa pelo ID: admin em /admin/tarefas; colaborador em Minhas tarefas so quando o assistente comprovou que a
// tarefa e dele (atribuidaAoUsuario). Ter responsavel nao basta: pode ser outra pessoa da equipe.
function AssistantTaskDetails({ task, replyText }) {
  const inRouter = useInRouterContext();
  const userType = authUtils.getUserType();
  const route = inRouter && task.id && (userType === 'admin' || task.atribuidaAoUsuario) ? taskRouteFor(userType) : null;
  const overdue = Boolean(task.today) && isOverdue(task, task.today);
  const deadline = describeDeadline(task, task.today);
  const hint = String(replyText || '').includes(SELECTION_HINT) ? SELECTION_HINT : '';

  return (
    <div className="voice-task-details">
      <div className="voice-task-header">
        <h3 className="voice-task-title">{task.titulo}</h3>
        <span className={`voice-query-chip status ${task.status}`}>
          {STATUS_LABELS[task.status] || task.status.replace(/_/g, ' ')}
        </span>
      </div>
      <dl className="voice-task-fields">
        <div>
          <dt>Prazo</dt>
          <dd className={overdue ? 'overdue' : ''}>{overdue ? `Atrasada · ${deadline}` : deadline}</dd>
        </div>
        <div>
          <dt>Urgência</dt>
          <dd>{task.urgencia ? URGENCY_LABELS[task.urgencia] : 'Não informada'}</dd>
        </div>
        <div>
          <dt>Equipe</dt>
          <dd>{task.equipe || 'Não informada'}</dd>
        </div>
        <div>
          <dt>Responsável</dt>
          <dd>{task.responsavel || 'Sem responsável'}</dd>
        </div>
      </dl>
      {task.descricao && (
        <section className="voice-task-description" aria-label="Descrição">
          <h4>Descrição</h4>
          <p>{task.descricao}</p>
        </section>
      )}
      {(hint || route) && (
        <div className="voice-task-footer">
          {hint && <p className="voice-query-hint">{hint}</p>}
          {route && (
            <Link
              className="voice-query-open"
              to={route}
              state={{ abrirTarefaId: task.id }}
              aria-label={`Ver tarefa ${task.titulo}`}
            >
              Ver tarefa
            </Link>
          )}
        </div>
      )}
    </div>
  );
}

export default AssistantTaskDetails;
