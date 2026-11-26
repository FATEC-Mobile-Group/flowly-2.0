import React, { useState, useEffect, useMemo } from "react";
import apiClient, { getFullApiUrl } from "../../config/apiClient";
import { API_ENDPOINTS } from "../../config/config";
import { Link } from "react-router-dom";
import { FaComments, FaEdit, FaLightbulb, FaTasks, FaTrashAlt } from "react-icons/fa";
import "../../styles/pages/admin/DashboardAdmin.css";
import "../../styles/components/AcoesEquipe.css";
import Sidebar from "../../components/layout/Sidebar";
import { authUtils } from "../../config/authUtils";
import ConfirmDialog from "../../components/common/ConfirmDialog";
import {
  FILTROS_ATIVIDADE,
  FILTROS_EQUIPES_PADRAO,
  ORDENS_EQUIPES,
  contarTarefasPorEquipe,
  equipesComFiltroAtivo,
  filtrarEquipes,
  formatarDataCriacao,
  instanteValido,
  lerFiltrosEquipes,
  serializarFiltrosEquipes,
} from "./adminFiltrosUtils";
import { useFiltrosNaUrl } from "./useFiltrosNaUrl";
import { CampoBusca, CampoSelect, plural } from "./FiltrosAdmin";
import { insightsRoute, validObjectId } from "../../utils/navigationRequests";

const CRIACAO_EQUIPES = [
  { valor: "", rotulo: "Todas" },
  { valor: "7dias", rotulo: "Criadas nos últimos 7 dias" },
  { valor: "30dias", rotulo: "Criadas nos últimos 30 dias" },
  { valor: "mais30dias", rotulo: "Criadas há mais de 30 dias" },
];

// Mesmos dados resumidos do Painel Geral: uma consulta para todas as equipes, sem URLs assinadas de anexos.
const PARAMETROS_TAREFAS = { resumo: 1 };
const AVISO_ATIVIDADE_INDISPONIVEL =
  "Não foi possível carregar as tarefas: o filtro por atividade não foi aplicado e as contagens de tarefas não são exibidas.";

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
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [deleteLoading, setDeleteLoading] = useState(false);
  // Tarefas por equipe (Map) so com a lista carregada; null enquanto carrega ou se falhar.
  const [tarefasPorEquipe, setTarefasPorEquipe] = useState(null);
  const [estadoTarefas, setEstadoTarefas] = useState("carregando");

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

  // Independente das equipes: se falhar, a pagina segue e so o filtro por atividade fica indisponivel.
  useEffect(() => {
    const controle = new AbortController();
    setEstadoTarefas("carregando");
    apiClient.get(API_ENDPOINTS.TAREFAS, { signal: controle.signal, params: PARAMETROS_TAREFAS })
      .then((res) => {
        if (controle.signal.aborted) return;
        const contagem = contarTarefasPorEquipe(res?.data);
        if (!contagem) throw new Error("resposta inesperada");
        setTarefasPorEquipe(contagem);
        setEstadoTarefas("pronto");
      })
      .catch((err) => {
        if (controle.signal.aborted) return;
        console.error("Erro ao carregar tarefas das equipes", err?.message || err);
        setTarefasPorEquipe(null);
        setEstadoTarefas("erro");
      });
    return () => controle.abort();
  }, [tentativa]);

  const { filtros, invalidos, busca, setBusca, aplicar, limpar } = useFiltrosNaUrl({
    ler: lerFiltrosEquipes,
    serializar: serializarFiltrosEquipes,
    padrao: FILTROS_EQUIPES_PADRAO,
  });
  const visiveis = useMemo(
    () => filtrarEquipes(equipes, filtros, Date.now(), tarefasPorEquipe),
    [equipes, filtros, tarefasPorEquipe],
  );
  const filtroAtivo = equipesComFiltroAtivo(filtros) || busca.trim() !== "";
  const semDataCriacao = filtros.criacao
    ? equipes.filter((equipe) => instanteValido(equipe?.createdAt) === null).length
    : 0;
  const pronto = estado === "pronto";
  const tarefasProntas = estadoTarefas === "pronto";
  // Com o filtro de atividade na URL, a lista espera as tarefas: nada de mostrar todas e depois "pular".
  const aguardandoAtividade = Boolean(filtros.atividade) && estadoTarefas === "carregando";
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
            <Link to="/admin/insights" className="btn-create">
              Insights inteligentes
            </Link>
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
              id="equipes-atividade"
              rotulo="Atividade"
              valor={filtros.atividade}
              disabled={!pronto || !tarefasProntas}
              opcoes={FILTROS_ATIVIDADE}
              onChange={(valor) => aplicar({ atividade: valor })}
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
              {pronto && !aguardandoAtividade ? `Exibindo ${visiveis.length} de ${plural(equipes.length, "equipe", "equipes")}` : ""}
            </p>
            {filtroAtivo && pronto && (
              <button type="button" className="admin-botao-secundario" onClick={limpar}>
                Limpar filtros
              </button>
            )}
          </div>
          {pronto && estadoTarefas === "erro" && (
            <p className="admin-nota" role="status">{AVISO_ATIVIDADE_INDISPONIVEL}</p>
          )}
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
          ) : aguardandoAtividade ? (
            <p className="teams-feedback">Carregando as tarefas das equipes...</p>
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
              const totalTarefas = tarefasProntas ? tarefasPorEquipe.get(String(equipe._id)) || 0 : null;
              const descricao = typeof equipe.descricao === "string" ? equipe.descricao.trim() : "";
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
                        {totalTarefas !== null && (
                          <span>{totalTarefas === 0 ? "Sem tarefas" : plural(totalTarefas, "tarefa", "tarefas")}</span>
                        )}
                      </p>
                    </div>
                    <span className="team-badge">{plural(totalMembros, "participante", "participantes")}</span>
                  </div>

                  {descricao && <p className="team-item-descricao" title={descricao}>{descricao}</p>}

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

                  <div className="team-actions">
                    <div className="acoes-equipe">
                      <Link
                        to={`/admin/tarefas?equipe=${encodeURIComponent(equipe._id)}`}
                        className="acao-equipe acao-equipe--tarefas"
                        aria-label={`Ver tarefas da equipe ${equipe.nome}`}
                      >
                        <FaTasks aria-hidden="true" />
                        <span>Ver tarefas</span>
                      </Link>
                      {participa && (
                        <Link
                          to="/admin/chats"
                          state={{ equipeId: equipe._id }}
                          className="acao-equipe acao-equipe--chat"
                          aria-label={`Abrir chat da equipe ${equipe.nome}`}
                        >
                          <FaComments aria-hidden="true" />
                          <span>Abrir chat</span>
                        </Link>
                      )}
                      <Link
                        to={insightsRoute({ equipe: validObjectId(String(equipe._id ?? "")) || "" })}
                        className="acao-equipe acao-equipe--insights"
                        aria-label={`Ver insights da equipe ${equipe.nome}`}
                      >
                        <FaLightbulb aria-hidden="true" />
                        <span>Ver insights</span>
                      </Link>
                      <Link
                        to={`/admin/equipe/${equipe._id}`}
                        className="acao-equipe acao-equipe--editar"
                        aria-label={`Editar equipe ${equipe.nome}`}
                      >
                        <FaEdit aria-hidden="true" />
                        <span>Editar</span>
                      </Link>
                    </div>
                    <button
                      type="button"
                      className="acao-equipe acao-equipe--excluir"
                      onClick={() => setDeleteTarget(equipe)}
                      aria-label={`Excluir equipe ${equipe.nome}`}
                    >
                      <FaTrashAlt aria-hidden="true" />
                      <span>Excluir equipe</span>
                    </button>
                  </div>
                </article>
              );
            })
          )}
        </div>
      </main>

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
