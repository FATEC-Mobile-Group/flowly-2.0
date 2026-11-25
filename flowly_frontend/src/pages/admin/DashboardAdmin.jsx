import React, { useState, useEffect, useMemo } from "react";
import apiClient, { getFullApiUrl } from "../../config/apiClient";
import { API_ENDPOINTS } from "../../config/config";
import { Link } from "react-router-dom";
import "../../styles/pages/admin/DashboardAdmin.css";
import Sidebar from "../../components/layout/Sidebar";
import { authUtils } from "../../config/authUtils";
import ConfirmDialog from "../../components/common/ConfirmDialog";
import {
  FILTROS_EQUIPES_PADRAO,
  ORDENS_EQUIPES,
  equipesComFiltroAtivo,
  filtrarEquipes,
  formatarDataCriacao,
  instanteValido,
  lerFiltrosEquipes,
  serializarFiltrosEquipes,
} from "./adminFiltrosUtils";
import { useFiltrosNaUrl } from "./useFiltrosNaUrl";
import { CampoBusca, CampoSelect, plural } from "./FiltrosAdmin";

const CRIACAO_EQUIPES = [
  { valor: "", rotulo: "Todas" },
  { valor: "7dias", rotulo: "Criadas nos últimos 7 dias" },
  { valor: "30dias", rotulo: "Criadas nos últimos 30 dias" },
  { valor: "mais30dias", rotulo: "Criadas há mais de 30 dias" },
];

// Quem criou a equipe (createdBy): "você", ou o nome se o criador estiver entre os participantes carregados.
// Sem o dado, nada e exibido.
const descreverCriador = (equipe, usuarioId) => {
  const id = equipe?.createdBy?._id ?? equipe?.createdBy;
  if (id == null) return null;
  if (usuarioId && String(id) === String(usuarioId)) return "você";
  const membro = (equipe.membros || []).find((item) => String(item?._id) === String(id));
  return membro?.nome || null;
};

function DashboardAdmin() {
  const [equipes, setEquipes] = useState([]);
  const [estado, setEstado] = useState("carregando");
  const [tentativa, setTentativa] = useState(0);
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
  }, []);

  // Uma consulta por carregamento: pesquisa, filtro e ordenacao trabalham sobre a lista ja carregada.
  useEffect(() => {
    let ativo = true;
    setEstado("carregando");
    apiClient.get(API_ENDPOINTS.EQUIPES)
      .then((res) => {
        if (!ativo) return;
        if (!Array.isArray(res?.data)) throw new Error("resposta inesperada");
        setEquipes(res.data);
        setEstado("pronto");
      })
      .catch((err) => {
        if (!ativo) return;
        console.error("Erro ao carregar equipes", err?.message || err);
        setEstado("erro");
      });
    return () => {
      ativo = false;
    };
  }, [tentativa]);

  const { filtros, invalidos, busca, setBusca, aplicar, limpar } = useFiltrosNaUrl({
    ler: lerFiltrosEquipes,
    serializar: serializarFiltrosEquipes,
    padrao: FILTROS_EQUIPES_PADRAO,
  });
  const visiveis = useMemo(() => filtrarEquipes(equipes, filtros, Date.now()), [equipes, filtros]);
  const filtroAtivo = equipesComFiltroAtivo(filtros) || busca.trim() !== "";
  const semDataCriacao = filtros.criacao
    ? equipes.filter((equipe) => instanteValido(equipe?.createdAt) === null).length
    : 0;
  const pronto = estado === "pronto";
  const usuarioId = authUtils.getUserId();

  const handleDelete = async () => {
    if (!deleteTarget) return;

    setDeleteLoading(true);
    try {
      await apiClient.delete(API_ENDPOINTS.DELETE_EQUIPE(deleteTarget._id));
      setEquipes((atuais) => atuais.filter((equipe) => equipe._id !== deleteTarget._id));
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

      <main className="dashboard-container admin-gestao">
        {adminNome && <h3 className="boas-vindas">Bem-vindo(a), {adminNome}!</h3>}
        <div className="dashboard-topbar admin-cabecalho">
          <div>
            <h2 className="dashboard-title">Equipes</h2>
            <p className="admin-subtitulo">Encontre equipes, participantes e acesse as tarefas de cada uma.</p>
          </div>
          <div className="dashboard-actions">
            <button type="button" className="btn-create" onClick={fetchAssistantInsights}>
              Insights IA
            </button>
            <Link to="/admin/criar-equipe" className="btn-create">
              Criar nova equipe
            </Link>
          </div>
        </div>

        <section className="admin-filtros" aria-label="Pesquisa e filtros de equipes">
          <CampoBusca
            id="equipes-busca"
            valor={busca}
            onChange={setBusca}
            placeholder="Nome da equipe, participante ou e-mail"
            disabled={!pronto}
          />
          <div className="admin-filtros-grade admin-filtros-grade-curta">
            <CampoSelect
              id="equipes-criacao"
              rotulo="Criação"
              valor={filtros.criacao}
              disabled={!pronto}
              opcoes={CRIACAO_EQUIPES}
              onChange={(valor) => aplicar({ criacao: valor })}
            />
            <CampoSelect
              id="equipes-ordem"
              rotulo="Ordenar por"
              valor={filtros.ordem}
              disabled={!pronto}
              opcoes={ORDENS_EQUIPES}
              onChange={(valor) => aplicar({ ordem: valor })}
            />
          </div>
          <div className="admin-filtros-rodape">
            <p className="admin-contagem" aria-live="polite">
              {pronto ? `Exibindo ${visiveis.length} de ${plural(equipes.length, "equipe", "equipes")}` : ""}
            </p>
            {filtroAtivo && pronto && (
              <button type="button" className="admin-botao-secundario" onClick={limpar}>
                Limpar filtros
              </button>
            )}
          </div>
          {pronto && semDataCriacao > 0 && (
            <p className="admin-nota">
              {`${plural(semDataCriacao, "equipe sem data de criação não entra", "equipes sem data de criação não entram")} no filtro de criação.`}
            </p>
          )}
        </section>

        {pronto && invalidos.length > 0 && (
          <p className="teams-feedback admin-aviso" role="status">
            {`Filtros ignorados por serem inválidos: ${invalidos.join(", ")}.`}
          </p>
        )}

        <div className="teams-list">
          {estado === "carregando" ? (
            <p className="teams-feedback">Carregando equipes...</p>
          ) : estado === "erro" ? (
            <div className="teams-feedback admin-erro" role="alert">
              <p>Não foi possível carregar as equipes. Verifique a conexão e tente novamente.</p>
              <button type="button" className="admin-botao-secundario" onClick={() => setTentativa((n) => n + 1)}>
                Tentar novamente
              </button>
            </div>
          ) : equipes.length === 0 ? (
            <p className="teams-feedback">Nenhuma equipe criada ainda.</p>
          ) : visiveis.length === 0 ? (
            <div className="teams-feedback admin-vazio">
              <p>Nenhuma equipe corresponde à pesquisa ou aos filtros aplicados.</p>
              <button type="button" className="admin-botao-secundario" onClick={limpar}>
                Limpar filtros
              </button>
            </div>
          ) : (
            visiveis.map((equipe) => {
              const totalMembros = equipe.membros?.length || 0;
              const criador = descreverCriador(equipe, usuarioId);
              const participa = (equipe.membros || []).some(
                (membro) => String(membro?._id || membro) === String(usuarioId),
              );
              return (
                <article key={equipe._id} className="team-item" aria-label={`Equipe ${equipe.nome}`}>
                  <div className="team-item-header">
                    <div className="team-item-titulo">
                      <h3>{equipe.nome}</h3>
                      <p className="team-item-meta">
                        <span>
                          {instanteValido(equipe.createdAt) === null
                            ? "Data de criação indisponível"
                            : `Criada em ${formatarDataCriacao(equipe.createdAt)}`}
                        </span>
                        {criador && <span>{`Criada por ${criador}`}</span>}
                      </p>
                    </div>
                    <span className="team-badge">{plural(totalMembros, "participante", "participantes")}</span>
                  </div>

                  <div className="team-members">
                    <h4>Participantes</h4>
                    {totalMembros > 0 ? (
                      <ul className="team-members-grid">
                        {equipe.membros.map((membro) => (
                          <li key={membro._id} className="team-member-card">
                            {renderAvatar(membro)}
                            <div className="team-member-info">
                              <span className="team-member-name">{membro.nome}</span>
                              <span className="team-member-email" title={membro.email || undefined}>
                                {membro.email || "Sem email"}
                              </span>
                            </div>
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className="team-members-empty">Sem participantes nesta equipe.</p>
                    )}
                  </div>

                  <div className="actions team-actions">
                    <div className="team-actions-principais">
                      <Link
                        to={`/admin/tarefas?equipe=${encodeURIComponent(equipe._id)}`}
                        className="btn-edit btn-tarefas"
                        aria-label={`Ver tarefas da equipe ${equipe.nome}`}
                      >
                        Ver tarefas
                      </Link>
                      {participa && (
                        <Link
                          to="/admin/chats"
                          state={{ equipeId: equipe._id }}
                          className="btn-edit btn-chat"
                          aria-label={`Abrir chat da equipe ${equipe.nome}`}
                        >
                          Abrir chat
                        </Link>
                      )}
                      <Link
                        to={`/admin/equipe/${equipe._id}`}
                        className="btn-edit"
                        aria-label={`Editar equipe ${equipe.nome}`}
                      >
                        Editar
                      </Link>
                    </div>
                    <button
                      type="button"
                      className="btn-delete"
                      onClick={() => setDeleteTarget(equipe)}
                      aria-label={`Excluir equipe ${equipe.nome}`}
                    >
                      Excluir
                    </button>
                  </div>
                </article>
              );
            })
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
                ["chats", "Equipes"],
                ["alertas", "Alertas"],
              ].map(([key, label]) => (
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
                            <p><strong>Motivo:</strong> {actor.reasonText || "Acompanhamento preventivo"}</p>
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
                            <strong>{item.userName || "Usuario"}</strong>
                            <span>{item.teamName || item.channelId} · {new Date(item.createdAt).toLocaleString()}</span>
                          </div>
                          <p><strong>Nível:</strong> {item.alertLevelLabel || item.alertLevel || item.sentiment}</p>
                          <p><strong>Motivo:</strong> {item.reasonText || "Acompanhamento preventivo"}</p>
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
