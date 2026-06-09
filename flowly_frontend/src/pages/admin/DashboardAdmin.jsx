import React, { useState, useEffect } from "react";
import apiClient, { getFullApiUrl } from "../../config/apiClient";
import { API_ENDPOINTS } from "../../config/config";
import { Link } from "react-router-dom";
import "../../styles/pages/admin/DashboardAdmin.css";
import Sidebar from "../../components/layout/Sidebar";
import ConfirmDialog from "../../components/common/ConfirmDialog";

function DashboardAdmin() {
  const [equipes, setEquipes] = useState([]);
  const [loading, setLoading] = useState(true);
  const [adminNome, setAdminNome] = useState("");
  const [insightsOpen, setInsightsOpen] = useState(false);
  const [insightsTab, setInsightsTab] = useState("resumo");
  const [insights, setInsights] = useState(null);
  const [insightsLoading, setInsightsLoading] = useState(false);
  const [insightsError, setInsightsError] = useState("");
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [deleteLoading, setDeleteLoading] = useState(false);

  const getInitials = (name = "?") =>
    name
      .trim()
      .split(/\s+/)
      .slice(0, 2)
      .map((part) => part[0])
      .join("")
      .toUpperCase();

  const renderAvatar = (membro) => {
    const photo = membro?.fotoPerfil;
    const name = membro?.nome || "?";

    return (
      <span className="team-member-avatar">
        {photo ? <img src={getFullApiUrl(photo)} alt="" /> : getInitials(name)}
      </span>
    );
  };

  useEffect(() => {
    const nomeSalvo = localStorage.getItem("nome");
    if (nomeSalvo) setAdminNome(nomeSalvo);
    const fetchEquipes = async () => {
      try {
        const res = await apiClient.get(API_ENDPOINTS.EQUIPES);
        setEquipes(res.data);
        setLoading(false);
      } catch (err) {
        console.error("Erro ao carregar equipes", err);
        setLoading(false);
      }
    };

    fetchEquipes();
  }, []);

  const handleDelete = async () => {
    if (!deleteTarget) return;

    setDeleteLoading(true);
    try {
      await apiClient.delete(API_ENDPOINTS.DELETE_EQUIPE(deleteTarget._id));
      setEquipes(equipes.filter((equipe) => equipe._id !== deleteTarget._id));
      setDeleteTarget(null);
    } catch (err) {
      console.error("Erro ao excluir equipe", err);
    } finally {
      setDeleteLoading(false);
    }
  };

  const fetchAssistantInsights = async () => {
    setInsightsOpen(true);
    setInsightsLoading(true);
    setInsightsError("");

    try {
      const res = await apiClient.get(API_ENDPOINTS.ADMIN_ASSISTANT_INSIGHTS);
      setInsights(res.data?.insights || null);
    } catch (err) {
      console.error("Erro ao carregar insights do assistente", err);
      setInsightsError("Não foi possível carregar os insights agora.");
    } finally {
      setInsightsLoading(false);
    }
  };

  const recentInsights = insights?.recent || [];
  const chatSummaries = insights?.chatSummaries || insights?.byTeam || [];
  const badActors = insights?.badActors || [];

  return (
    <div className="admin-page">
      <Sidebar />

      <main className="dashboard-container">
        {adminNome && <h3 className="boas-vindas">Bem-vindo(a), {adminNome}!</h3>}
        <div className="dashboard-topbar">
          <h2 className="dashboard-title">Equipes</h2>
          <div className="dashboard-actions">
            <button type="button" className="btn-create" onClick={fetchAssistantInsights}>
              Insights IA
            </button>
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
                          {renderAvatar(membro)}
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
                    onClick={() => setDeleteTarget(equipe)}
                  >
                    Excluir
                  </button>
                </div>
              </div>
            ))
          )}
        </div>
      </main>

      {insightsOpen && (
        <div className="insights-modal-overlay" onClick={() => setInsightsOpen(false)}>
          <section className="insights-modal" onClick={(event) => event.stopPropagation()}>
            <div className="insights-modal-header">
              <div>
                <span className="insights-kicker">Assistente de voz</span>
                <h3>Insights de PLN</h3>
              </div>
              <button type="button" className="insights-close" onClick={() => setInsightsOpen(false)}>
                Fechar
              </button>
            </div>

            <div className="insights-tabs">
              {[
                ["resumo", "Resumo"],
                ["chats", "Chats"],
                ["topicos", "Tópicos"],
                ["equipes", "Equipes"],
                ["alertas", "Alertas"],
              ].filter(([key]) => key !== "topicos").map(([key, label]) => (
                <button
                  key={key}
                  type="button"
                  className={insightsTab === key ? "active" : ""}
                  onClick={() => setInsightsTab(key)}
                >
                  {label}
                </button>
              ))}
            </div>

            {insightsLoading ? (
              <p className="insights-feedback">Carregando insights...</p>
            ) : insightsError ? (
              <p className="insights-feedback error">{insightsError}</p>
            ) : (
              <div className="insights-content">
                {insightsTab === "resumo" && (
                  <>
                    <div className="insights-grid">
                      <div className="insight-card">
                        <span>Total de mensagens</span>
                        <strong>{insights?.totalMessages || 0}</strong>
                      </div>
                      <div className="insight-card">
                        <span>Alertas de spam</span>
                        <strong>{insights?.spamAlerts || 0}</strong>
                      </div>
                      <div className="insight-card">
                        <span>Tópico principal</span>
                        <strong>{insights?.topTopics?.[0]?.topic || "Sem dados"}</strong>
                      </div>
                    </div>
                    <div className="insight-suggestions">
                      <h4>Sugestões gerais</h4>
                      {(insights?.suggestions || []).map((suggestion) => (
                        <p key={suggestion}>{suggestion}</p>
                      ))}
                    </div>
                  </>
                )}

                {insightsTab === "chats" && (
                  <div className="team-insights-list">
                    {chatSummaries.length === 0 ? (
                      <p className="insights-feedback">Nenhum assunto de chat nos ultimos dias.</p>
                    ) : (
                      chatSummaries.map((team) => (
                        <article key={team.channelId} className="team-insight-card">
                          <div className="team-insight-header">
                            <div>
                              <span>Ultimos {insights?.chatWindowDays || 7} dias</span>
                              <h4>{team.teamName}</h4>
                            </div>
                            <strong>{team.totalMessages} msg</strong>
                          </div>
                          <div className="team-insight-topics">
                            {(team.topTopics || []).length === 0 ? (
                              <span>Sem topicos recorrentes</span>
                            ) : (
                              team.topTopics.map((topic) => (
                                <span key={topic.topic}>{topic.topic} · {topic.count}</span>
                              ))
                            )}
                          </div>
                          <div className="insight-suggestions compact">
                            {(team.suggestions || []).map((suggestion) => (
                              <p key={suggestion}>{suggestion}</p>
                            ))}
                          </div>
                        </article>
                      ))
                    )}
                  </div>
                )}

                {insightsTab === "topicos" && (
                  <div className="insights-list">
                    {(insights?.topTopics || []).length === 0 ? (
                      <p className="insights-feedback">Nenhum tópico minerado ainda.</p>
                    ) : (
                      insights.topTopics.map((item) => (
                        <div key={item.topic} className="insight-row">
                          <span>{item.topic}</span>
                          <strong>{item.count}</strong>
                        </div>
                      ))
                    )}
                  </div>
                )}

                {insightsTab === "equipes" && (
                  <div className="team-insights-list">
                    {(insights?.byTeam || []).length === 0 ? (
                      <p className="insights-feedback">Nenhum insight por equipe disponível ainda.</p>
                    ) : (
                      insights.byTeam.map((team) => (
                        <article key={team.channelId} className="team-insight-card">
                          <div className="team-insight-header">
                            <div>
                              <span>Equipe</span>
                              <h4>{team.teamName}</h4>
                            </div>
                            <strong>{team.totalMessages} msg</strong>
                          </div>
                          <div className="team-insight-metrics">
                            <span>Positivo: {team.sentiments?.positivo || 0}</span>
                            <span>Neutro: {team.sentiments?.neutro || 0}</span>
                            <span>Negativo: {team.sentiments?.negativo || 0}</span>
                            <span>Spam: {team.spamAlerts || 0}</span>
                          </div>
                          <div className="team-insight-topics">
                            {(team.topTopics || []).map((topic) => (
                              <span key={topic.topic}>{topic.topic} · {topic.count}</span>
                            ))}
                          </div>
                          <div className="insight-suggestions compact">
                            {(team.suggestions || []).map((suggestion) => (
                              <p key={suggestion}>{suggestion}</p>
                            ))}
                          </div>
                        </article>
                      ))
                    )}
                  </div>
                )}

                {insightsTab === "alertas" && (
                  <div className="insights-list">
                    {badActors.length > 0 && (
                      <>
                        {badActors.map((actor) => (
                          <div key={`${actor.channelId}-${actor.userId}`} className="insight-message spam">
                            <div>
                              <strong>{actor.userName}</strong>
                              <span>{actor.teamName} · {actor.count} ocorrências</span>
                            </div>
                            <p>{actor.recommendation}</p>
                            <p>Risco: {Math.round((actor.conflictRisk || 0) * 100)}%</p>
                          </div>
                        ))}
                      </>
                    )}
                    {recentInsights.length === 0 ? (
                      badActors.length === 0 && <p className="insights-feedback">Nenhum alerta importante detectado.</p>
                    ) : (
                      recentInsights.map((item) => (
                        <div key={item._id} className={`insight-message ${item.spamAlert || item.alertLevel === "high" ? "spam" : ""}`}>
                          <div>
                            <strong>{item.alertLevel || item.sentiment}</strong>
                            <span>{item.channelId} · {new Date(item.createdAt).toLocaleString()}</span>
                          </div>
                          <p>{item.content}</p>
                          {item.recommendation && <p>{item.recommendation}</p>}
                        </div>
                      ))
                    )}
                  </div>
                )}
              </div>
            )}
          </section>
        </div>
      )}
      <ConfirmDialog
        open={!!deleteTarget}
        title="Excluir equipe?"
        message={`A equipe "${deleteTarget?.nome || ""}" sera excluida permanentemente. Esta acao nao pode ser desfeita.`}
        confirmLabel="Excluir equipe"
        loading={deleteLoading}
        onConfirm={handleDelete}
        onCancel={() => !deleteLoading && setDeleteTarget(null)}
      />
    </div>
  );
}

export default DashboardAdmin;
