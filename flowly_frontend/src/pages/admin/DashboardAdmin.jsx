import React, { useState, useEffect } from "react";
import axios from "axios";
import { Link } from "react-router-dom";
import "../../styles/pages/admin/DashboardAdmin.css"; 
import Sidebar from "../../components/layout/Sidebar";

function DashboardAdmin() {
  const [equipes, setEquipes] = useState([]);
  const [loading, setLoading] = useState(true);
  const [adminNome, setAdminNome] = useState("");

  useEffect(() => {
    const nomeSalvo = localStorage.getItem("nome");
      if (nomeSalvo) setAdminNome(nomeSalvo);
    const fetchEquipes = async () => {
      try {
        const res = await axios.get("http://localhost:5000/api/equipes", {
          headers: {
            Authorization: `Bearer ${localStorage.getItem("token")}`,
          },
        });
        setEquipes(res.data);
        setLoading(false);
      } catch (err) {
        console.error("Erro ao carregar equipes", err);
        setLoading(false);
      }
    };

    fetchEquipes();
  }, []);

  const handleDelete = async (id) => {
    try {
      await axios.delete(`http://localhost:5000/api/equipes/${id}`, {
        headers: {
          Authorization: `Bearer ${localStorage.getItem("token")}`,
        },
      });
      setEquipes(equipes.filter((equipe) => equipe._id !== id));
    } catch (err) {
      console.error("Erro ao excluir equipe", err);
    }
  };

  return (
    <div className="admin-page">
      <Sidebar />

      <main className="dashboard-container">
        {adminNome && <h3 className="boas-vindas">Bem-vindo(a), {adminNome}!</h3>}
        <div className="dashboard-topbar">
          <h2 className="dashboard-title">Equipes</h2>
          <div className="dashboard-actions">
            <Link to="/admin/criar-equipe" className="btn-create">
              Criar nova equipe
            </Link>
          </div>
        </div>

        <div className="metrics">
          <div className="metric">
            <span className="metric-title">Número de Equipes:</span>
            <span className="metric-value">{equipes.length}</span>
          </div>
        </div>

        <div className="teams-list">
          {loading ? (
            <p className="teams-feedback">Carregando equipes...</p>
          ) : equipes.length === 0 ? (
            <p className="teams-feedback">Nenhuma equipe criada ainda.</p>
          ) : (
            equipes.map((equipe) => (
              <div key={equipe._id} className="team-item">
                <div className="team-item-header">
                  <h3>{equipe.nome}</h3>
                  <span className="team-badge">
                    {equipe.membros?.length || 0} membro{(equipe.membros?.length || 0) === 1 ? "" : "s"}
                  </span>
                </div>

                <div className="team-members">
                  <h4>Participantes</h4>
                  {equipe.membros && equipe.membros.length > 0 ? (
                    <div className="team-members-grid">
                      {equipe.membros.map((membro) => (
                        <div key={membro._id} className="team-member-card">
                          <span className="team-member-avatar">
                            {(membro.nome || "?").trim().charAt(0).toUpperCase()}
                          </span>
                          <div className="team-member-info">
                            <span className="team-member-name">{membro.nome}</span>
                            <span className="team-member-email">{membro.email || "Sem email"}</span>
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="team-members-empty">Sem participantes nesta equipe.</p>
                  )}
                </div>

                <div className="actions">
                  <Link to={`/admin/equipe/${equipe._id}`} className="btn-edit">
                    Editar
                  </Link>
                  <button
                    className="btn-delete"
                    onClick={() => handleDelete(equipe._id)}
                  >
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

export default DashboardAdmin;
