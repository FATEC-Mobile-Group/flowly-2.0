import React, { useEffect, useState } from "react";
import axios from "axios";
import { Link, useNavigate } from "react-router-dom";
import { formatarStatus } from "../../config/statusUtils";
import "../../styles/pages/admin/DashboardAdmin.css";
import Sidebar from "../../components/layout/Sidebar";

function DashboardTarefasAdmin() {
  const [tarefas, setTarefas] = useState([]);
  const [loading, setLoading] = useState(true);
  const navigate = useNavigate();

  useEffect(() => {
    const fetchTarefas = async () => {
      try {
        const res = await axios.get("http://localhost:5000/api/tarefas", {
          headers: {
            Authorization: `Bearer ${localStorage.getItem("token")}`,
          },
        });
        setTarefas(res.data);
        setLoading(false);
      } catch (err) {
        console.error("Erro ao carregar tarefas", err);
        setLoading(false);
      }
    };

    fetchTarefas();
  }, []);

  const handleDelete = async (id) => {
    try {
      await axios.delete(`http://localhost:5000/api/tarefas/${id}`, {
        headers: {
          Authorization: `Bearer ${localStorage.getItem("token")}`,
        },
      });
      setTarefas(tarefas.filter((tarefa) => tarefa._id !== id));
    } catch (err) {
      console.error("Erro ao excluir tarefa", err);
    }
  };

  const handleEdit = (tarefaId) => {
    navigate(`/admin/editar-tarefa/${tarefaId}`);
  };

  return (
    <div className="admin-page">
      <Sidebar />

      <main className="dashboard-container">
        <h2 className="dashboard-title">Tarefas</h2>

        <div className="dashboard-actions">
          <Link to="/admin/criar-tarefa" className="btn-create">
            Criar nova tarefa
          </Link>
        </div>

        <div className="tasks-list">
          {loading ? (
            <p className="tasks-feedback">Carregando tarefas...</p>
          ) : tarefas.length === 0 ? (
            <p className="tasks-feedback">Nenhuma tarefa encontrada.</p>
          ) : (
            tarefas.map((tarefa) => (
              <div key={tarefa._id} className={`task-item task-urgency-${tarefa.urgencia}`}>
                <div className="task-item-header">
                  <div>
                    <h3>{tarefa.descricao}</h3>
                    <span className="task-subtitle">
                      {tarefa.equipe?.nome || "Sem equipe definida"}
                    </span>
                  </div>
                  <span className={`task-status task-status-${String(tarefa.status || "").toLowerCase()}`}>
                    {formatarStatus(tarefa.status)}
                  </span>
                </div>

                <div className="task-meta-grid">
                  <div className="task-meta-card">
                    <span className="task-meta-label">Entrega</span>
                    <span className="task-meta-value">
                      {new Date(tarefa.dataEntrega).toLocaleDateString()}
                    </span>
                  </div>
                  <div className="task-meta-card">
                    <span className="task-meta-label">Responsável</span>
                    <span className="task-meta-value">
                      {tarefa.user?.nome || "Sem responsável (Backlog)"}
                    </span>
                  </div>
                  <div className="task-meta-card">
                    <span className="task-meta-label">Urgência</span>
                    <span className="task-meta-value">
                      {String(tarefa.urgencia || "").charAt(0).toUpperCase() + String(tarefa.urgencia || "").slice(1)}
                    </span>
                  </div>
                  {tarefa.tempoEstimado && (
                    <div className="task-meta-card">
                      <span className="task-meta-label">Tempo estimado</span>
                      <span className="task-meta-value">{tarefa.tempoEstimado} min</span>
                    </div>
                  )}
                </div>

                {tarefa.detalhes && <p className="task-details">{tarefa.detalhes}</p>}

                <div className="actions task-actions">
                  <button type="button" className="btn-edit" onClick={() => handleEdit(tarefa._id)}>
                    Editar
                  </button>
                  <button type="button" className="btn-delete" onClick={() => handleDelete(tarefa._id)}>
                    Excluir
                  </button>
                </div>
              </div>
            ))
          )}
        </div>
      </main>
    </div>
  );
}

export default DashboardTarefasAdmin;
