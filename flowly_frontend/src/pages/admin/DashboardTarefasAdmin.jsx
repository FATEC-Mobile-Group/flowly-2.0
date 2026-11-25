import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import apiClient from "../../config/apiClient";
import { API_ENDPOINTS } from "../../config/config";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { validObjectId } from "../../utils/navigationRequests";
import { chaveDiaLocal, diaDaEntrega, formatarTempo } from "../dashboard/painelGeralUtils";
import {
  ATRIBUICAO_BACKLOG,
  ATRIBUICAO_SEM_RESPONSAVEL,
  FILTROS_CRIACAO,
  FILTROS_PRAZO,
  FILTROS_TAREFAS_PADRAO,
  ORDENS_TAREFAS,
  STATUS_TAREFA,
  URGENCIAS,
  backlogDisponivel,
  filtrarTarefas,
  formatarPrazo,
  formatarDataCriacao,
  idDaEquipeDaTarefa,
  instanteValido,
  lerFiltrosTarefas,
  opcoesDeEquipe,
  opcoesDeResponsavel,
  rotuloStatus,
  rotuloUrgencia,
  semResponsavel,
  serializarFiltrosTarefas,
  situacaoPrazo,
  tarefasComFiltroAtivo,
} from "./adminFiltrosUtils";
import { useFiltrosNaUrl } from "./useFiltrosNaUrl";
import { CampoBusca, CampoSelect, plural } from "./FiltrosAdmin";
import "../../styles/pages/admin/DashboardAdmin.css";
import Sidebar from "../../components/layout/Sidebar";
import ConfirmDialog from "../../components/common/ConfirmDialog";

export const CHAVE_VISUALIZACAO_TAREFAS = "flowly:admin-tarefas:visualizacao";

// Preferencia so deste navegador; sem acesso ao armazenamento, a lista compacta continua sendo o padrao.
const lerVisualizacao = () => {
  try {
    return localStorage.getItem(CHAVE_VISUALIZACAO_TAREFAS) === "cards" ? "cards" : "lista";
  } catch {
    return "lista";
  }
};

const gravarVisualizacao = (valor) => {
  try {
    localStorage.setItem(CHAVE_VISUALIZACAO_TAREFAS, valor);
  } catch {
    // Sem armazenamento: a escolha vale so ate sair da pagina.
  }
};

const nomeResponsavel = (tarefa) => {
  if (semResponsavel(tarefa)) return "Sem responsável";
  return tarefa.user?.nome || "Responsável sem nome";
};

function DashboardTarefasAdmin() {
  const [tarefas, setTarefas] = useState([]);
  const [equipes, setEquipes] = useState([]);
  const [estado, setEstado] = useState("carregando");
  const [tentativa, setTentativa] = useState(0);
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [deleteLoading, setDeleteLoading] = useState(false);
  const [visualizacao, setVisualizacao] = useState(lerVisualizacao);
  const [expandidas, setExpandidas] = useState(() => new Set());
  const navigate = useNavigate();
  const location = useLocation();
  // Pedido de outra tela (Painel Geral, notificacao, assistente): destaca a tarefa so se ela estiver na lista
  // carregada da API. Os filtros ativos nao escondem a tarefa pedida: ela aparece fixada acima da lista.
  const tarefaPedida = location.state?.abrirTarefaId;
  const [destacada, setDestacada] = useState(null);
  const [avisoPedido, setAvisoPedido] = useState("");
  const cartoesRef = useRef({});

  // Tarefas e equipes uma vez por carregamento. Equipes so alimentam o filtro (inclusive equipes ainda sem tarefas);
  // se falharem, o filtro usa as equipes que aparecem nas tarefas. Filtrar, ordenar e trocar a visualizacao
  // trabalham sobre estes dados, sem nova consulta.
  useEffect(() => {
    let ativo = true;
    setEstado("carregando");
    Promise.allSettled([apiClient.get(API_ENDPOINTS.TAREFAS), apiClient.get(API_ENDPOINTS.EQUIPES)]).then(
      ([respostaTarefas, respostaEquipes]) => {
        if (!ativo) return;
        const listaEquipes = respostaEquipes.status === "fulfilled" ? respostaEquipes.value?.data : null;
        setEquipes(Array.isArray(listaEquipes) ? listaEquipes : []);
        const listaTarefas = respostaTarefas.status === "fulfilled" ? respostaTarefas.value?.data : null;
        if (Array.isArray(listaTarefas)) {
          setTarefas(listaTarefas);
          setEstado("pronto");
        } else {
          console.error("Erro ao carregar tarefas", respostaTarefas.reason?.message || "resposta inesperada");
          setEstado("erro");
        }
      },
    );
    return () => {
      ativo = false;
    };
  }, [tentativa]);

  const pronto = estado === "pronto";
  const equipesDisponiveis = useMemo(() => opcoesDeEquipe(equipes, tarefas), [equipes, tarefas]);
  const responsaveisDisponiveis = useMemo(() => opcoesDeResponsavel(tarefas), [tarefas]);
  const contexto = useMemo(() => (pronto ? {
    equipes: new Set(equipesDisponiveis.map((equipe) => equipe.id)),
    responsaveis: new Set(responsaveisDisponiveis.map((responsavel) => responsavel.id)),
  } : null), [pronto, equipesDisponiveis, responsaveisDisponiveis]);

  const { filtros, invalidos, busca, setBusca, aplicar, limpar } = useFiltrosNaUrl({
    ler: lerFiltrosTarefas,
    serializar: serializarFiltrosTarefas,
    padrao: FILTROS_TAREFAS_PADRAO,
    contexto,
  });

  const hoje = chaveDiaLocal();
  const nomesEquipes = useMemo(
    () => new Map(equipesDisponiveis.map((equipe) => [equipe.id, equipe.nome])),
    [equipesDisponiveis],
  );
  const visiveis = useMemo(
    () => filtrarTarefas(tarefas, filtros, { hoje, agora: Date.now(), nomesEquipes }),
    [tarefas, filtros, hoje, nomesEquipes],
  );
  const filtroAtivo = tarefasComFiltroAtivo(filtros) || busca.trim() !== "";
  const temSemPrazo = useMemo(() => tarefas.some((tarefa) => diaDaEntrega(tarefa?.dataEntrega) === null), [tarefas]);
  const semDataCriacao = filtros.criacao
    ? tarefas.filter((tarefa) => instanteValido(tarefa?.createdAt) === null).length
    : 0;
  const opcoesPrazo = FILTROS_PRAZO.filter(
    (opcao) => opcao.valor !== "semPrazo" || temSemPrazo || filtros.prazo === "semPrazo",
  );

  const handleDelete = async () => {
    if (!deleteTarget) return;

    setDeleteLoading(true);
    try {
      await apiClient.delete(API_ENDPOINTS.DELETE_TAREFA(deleteTarget._id));
      setTarefas((atuais) => atuais.filter((tarefa) => tarefa._id !== deleteTarget._id));
      setDeleteTarget(null);
    } catch (err) {
      console.error("Erro ao excluir tarefa", err);
    } finally {
      setDeleteLoading(false);
    }
  };

  // Atende o pedido so com a lista carregada. Com erro de carregamento o pedido fica guardado para a nova tentativa.
  // Ao consumir o state, mantem os filtros da URL.
  useEffect(() => {
    if (tarefaPedida == null || estado !== "pronto") return;
    const id = validObjectId(String(tarefaPedida));
    if (id && tarefas.some((tarefa) => String(tarefa._id) === id)) {
      setDestacada(id);
      // Abre os detalhes uma unica vez: o pedido e consumido abaixo, entao fechar depois nao reabre.
      setExpandidas((atuais) => (atuais.has(id) ? atuais : new Set(atuais).add(id)));
      setAvisoPedido("");
    } else {
      setAvisoPedido("A tarefa solicitada não está disponível nesta lista.");
    }
    navigate({ pathname: location.pathname, search: location.search }, { replace: true, state: null });
  }, [tarefaPedida, estado, tarefas, navigate, location.pathname, location.search]);

  const tarefaDestacada = destacada ? tarefas.find((tarefa) => String(tarefa._id) === destacada) : null;
  const destacadaOculta = Boolean(tarefaDestacada) && !visiveis.some((tarefa) => String(tarefa._id) === destacada);

  useEffect(() => {
    const cartao = destacada ? cartoesRef.current[destacada] : null;
    if (!cartao) return;
    cartao.scrollIntoView?.({ block: "center" });
    cartao.focus?.({ preventScroll: true });
  }, [destacada]);

  const handleEdit = (tarefaId) => {
    navigate(`/admin/editar-tarefa/${tarefaId}`);
  };

  const escolherVisualizacao = (valor) => {
    setVisualizacao(valor);
    gravarVisualizacao(valor);
  };

  const alternarDetalhes = useCallback((id) => {
    setExpandidas((atuais) => {
      const proximas = new Set(atuais);
      if (proximas.has(id)) proximas.delete(id);
      else proximas.add(id);
      return proximas;
    });
  }, []);

  const registrar = (id) => (elemento) => {
    cartoesRef.current[id] = elemento;
  };

  const atributosDestaque = (id) => ({
    ref: registrar(id),
    tabIndex: destacada === id ? -1 : undefined,
    "aria-current": destacada === id ? "true" : undefined,
  });

  const renderStatus = (tarefa) => (
    <span className={`task-status task-status-${String(tarefa.status || "").toLowerCase()}`}>
      {rotuloStatus(tarefa.status)}
    </span>
  );

  const renderUrgencia = (tarefa) => (
    <span className={`urgencia-badge urgencia-${tarefa.urgencia || "indefinida"}`}>
      {rotuloUrgencia(tarefa.urgencia)}
    </span>
  );

  const renderPrazo = (tarefa) => {
    const situacao = situacaoPrazo(tarefa, hoje);
    return (
      <span className="prazo-celula">
        <span>{formatarPrazo(tarefa)}</span>
        {situacao === "atrasada" && <span className="prazo-tag prazo-atrasada">Atrasada</span>}
        {situacao === "hoje" && <span className="prazo-tag prazo-hoje">Vence hoje</span>}
      </span>
    );
  };

  const renderResponsavel = (tarefa) => (
    <span className="responsavel-celula">
      <span>{nomeResponsavel(tarefa)}</span>
      {backlogDisponivel(tarefa) && <span className="backlog-tag">Backlog disponível</span>}
    </span>
  );

  const renderAcoes = (tarefa) => (
    <div className="actions task-actions">
      <button
        type="button"
        className="btn-edit"
        onClick={() => handleEdit(tarefa._id)}
        aria-label={`Editar tarefa ${tarefa.descricao || ""}`.trim()}
      >
        Editar
      </button>
      <button
        type="button"
        className="btn-delete"
        onClick={() => setDeleteTarget(tarefa)}
        aria-label={`Excluir tarefa ${tarefa.descricao || ""}`.trim()}
      >
        Excluir
      </button>
    </div>
  );

  const renderCartao = (tarefa) => {
    const id = String(tarefa._id);
    return (
      <div
        key={id}
        {...atributosDestaque(id)}
        className={`task-item task-urgency-${tarefa.urgencia}${destacada === id ? " is-destacada" : ""}`}
      >
        <div className="task-item-header">
          <div>
            <h3>{tarefa.descricao || "Tarefa sem título"}</h3>
            <span className="task-subtitle">
              {tarefa.equipe?.nome || nomesEquipes.get(idDaEquipeDaTarefa(tarefa)) || "Sem equipe definida"}
            </span>
          </div>
          {renderStatus(tarefa)}
        </div>

        <div className="task-meta-grid">
          <div className="task-meta-card">
            <span className="task-meta-label">Entrega</span>
            <span className="task-meta-value">{renderPrazo(tarefa)}</span>
          </div>
          <div className="task-meta-card">
            <span className="task-meta-label">Responsável</span>
            <span className="task-meta-value">{renderResponsavel(tarefa)}</span>
          </div>
          <div className="task-meta-card">
            <span className="task-meta-label">Urgência</span>
            <span className="task-meta-value">{renderUrgencia(tarefa)}</span>
          </div>
          {tarefa.tempoEstimado ? (
            <div className="task-meta-card">
              <span className="task-meta-label">Tempo estimado</span>
              <span className="task-meta-value">{tarefa.tempoEstimado} min</span>
            </div>
          ) : null}
        </div>

        {tarefa.detalhes && <p className="task-details">{tarefa.detalhes}</p>}

        {renderAcoes(tarefa)}
      </div>
    );
  };

  const renderLinha = (tarefa) => {
    const id = String(tarefa._id);
    const aberta = expandidas.has(id);
    const idDetalhes = `tarefa-detalhes-${id}`;
    return (
      <tr
        key={id}
        {...atributosDestaque(id)}
        className={`task-row task-urgency-${tarefa.urgencia}${destacada === id ? " is-destacada" : ""}`}
      >
        <td data-label="Tarefa" className="task-row-titulo">
          <span className="task-row-nome">{tarefa.descricao || "Tarefa sem título"}</span>
          <button
            type="button"
            className="task-row-detalhes-btn"
            aria-expanded={aberta}
            aria-controls={idDetalhes}
            onClick={() => alternarDetalhes(id)}
          >
            {aberta ? "Ocultar detalhes" : "Ver detalhes"}
          </button>
          {aberta && (
            <div id={idDetalhes} className="task-row-detalhes">
              <p>{tarefa.detalhes || "Sem detalhes cadastrados."}</p>
              <p className="task-row-detalhes-meta">
                <span>
                  {instanteValido(tarefa.createdAt) === null
                    ? "Data de criação indisponível"
                    : `Criada em ${formatarDataCriacao(tarefa.createdAt)}`}
                </span>
                {Number(tarefa.tempoGasto) > 0 && <span>{`Tempo registrado: ${formatarTempo(tarefa.tempoGasto)}`}</span>}
              </p>
            </div>
          )}
        </td>
        <td data-label="Equipe">
          {tarefa.equipe?.nome || nomesEquipes.get(idDaEquipeDaTarefa(tarefa)) || "Sem equipe definida"}
        </td>
        <td data-label="Responsável">{renderResponsavel(tarefa)}</td>
        <td data-label="Status">{renderStatus(tarefa)}</td>
        <td data-label="Urgência">{renderUrgencia(tarefa)}</td>
        <td data-label="Prazo">{renderPrazo(tarefa)}</td>
        <td data-label="Estimado">{tarefa.tempoEstimado ? `${tarefa.tempoEstimado} min` : "—"}</td>
        <td data-label="Ações" className="task-row-acoes">{renderAcoes(tarefa)}</td>
      </tr>
    );
  };

  const renderConteudo = () => {
    if (estado === "carregando") {
      return <p className="tasks-feedback">Carregando tarefas...</p>;
    }
    if (estado === "erro") {
      return (
        <div className="tasks-feedback admin-erro" role="alert">
          <p>Não foi possível carregar as tarefas. Verifique a conexão e tente novamente.</p>
          <button type="button" className="admin-botao-secundario" onClick={() => setTentativa((n) => n + 1)}>
            Tentar novamente
          </button>
        </div>
      );
    }
    if (tarefas.length === 0) {
      return <p className="tasks-feedback">Nenhuma tarefa cadastrada ainda.</p>;
    }
    if (visiveis.length === 0) {
      const equipeSemTarefas = filtros.equipe
        && !tarefas.some((tarefa) => idDaEquipeDaTarefa(tarefa) === filtros.equipe);
      return (
        <div className="tasks-feedback admin-vazio">
          <p>
            {equipeSemTarefas
              ? "Esta equipe ainda não possui tarefas."
              : "Nenhuma tarefa corresponde aos filtros aplicados."}
          </p>
          <button type="button" className="admin-botao-secundario" onClick={limpar}>
            Limpar filtros
          </button>
        </div>
      );
    }
    if (visualizacao === "cards") {
      return <div className="tasks-list">{visiveis.map(renderCartao)}</div>;
    }
    return (
      <div className="tasks-table-wrapper">
        <table className="tasks-table">
          <caption className="admin-sr-only">Tarefas filtradas</caption>
          <thead>
            <tr>
              <th scope="col">Tarefa</th>
              <th scope="col">Equipe</th>
              <th scope="col">Responsável</th>
              <th scope="col">Status</th>
              <th scope="col">Urgência</th>
              <th scope="col">Prazo</th>
              <th scope="col">Estimado</th>
              <th scope="col" className="task-row-acoes">Ações</th>
            </tr>
          </thead>
          <tbody>{visiveis.map(renderLinha)}</tbody>
        </table>
      </div>
    );
  };

  return (
    <div className="admin-page">
      <Sidebar />

      <main className="dashboard-container admin-gestao">
        <div className="dashboard-topbar admin-cabecalho">
          <div>
            <h2 className="dashboard-title">Tarefas</h2>
            <p className="admin-subtitulo">Pesquise, filtre e acompanhe as tarefas das suas equipes.</p>
          </div>
          <div className="dashboard-actions">
            <Link to="/admin/criar-tarefa" className="btn-create">
              Criar nova tarefa
            </Link>
          </div>
        </div>

        <section className="admin-filtros" aria-label="Pesquisa e filtros de tarefas">
          <CampoBusca
            id="tarefas-busca"
            valor={busca}
            onChange={setBusca}
            placeholder="Título, detalhes, equipe ou responsável"
            disabled={!pronto}
          />
          <div className="admin-filtros-grade">
            <CampoSelect
              id="tarefas-equipe"
              rotulo="Equipe"
              valor={filtros.equipe}
              disabled={!pronto}
              opcoes={[{ valor: "", rotulo: "Todas as equipes" }, ...equipesDisponiveis.map((e) => ({ valor: e.id, rotulo: e.nome }))]}
              onChange={(valor) => aplicar({ equipe: valor })}
            />
            <CampoSelect
              id="tarefas-responsavel"
              rotulo="Responsável"
              valor={filtros.atribuicao}
              disabled={!pronto}
              opcoes={[
                { valor: "", rotulo: "Todos" },
                { valor: ATRIBUICAO_SEM_RESPONSAVEL, rotulo: "Sem responsável (qualquer status)" },
                { valor: ATRIBUICAO_BACKLOG, rotulo: "Backlog disponível (pendente, sem responsável)" },
              ]}
              onChange={(valor) => aplicar({ atribuicao: valor })}
            >
              {responsaveisDisponiveis.length > 0 && (
                <optgroup label="Responsáveis">
                  {responsaveisDisponiveis.map((responsavel) => (
                    <option key={responsavel.id} value={responsavel.id}>{responsavel.nome}</option>
                  ))}
                </optgroup>
              )}
            </CampoSelect>
            <CampoSelect
              id="tarefas-status"
              rotulo="Status"
              valor={filtros.status}
              disabled={!pronto}
              opcoes={[{ valor: "", rotulo: "Todos" }, ...STATUS_TAREFA]}
              onChange={(valor) => aplicar({ status: valor })}
            />
            <CampoSelect
              id="tarefas-urgencia"
              rotulo="Urgência"
              valor={filtros.urgencia}
              disabled={!pronto}
              opcoes={[{ valor: "", rotulo: "Todas" }, ...URGENCIAS]}
              onChange={(valor) => aplicar({ urgencia: valor })}
            />
            <CampoSelect
              id="tarefas-prazo"
              rotulo="Prazo"
              valor={filtros.prazo}
              disabled={!pronto}
              opcoes={opcoesPrazo}
              onChange={(valor) => aplicar({ prazo: valor })}
            />
            <CampoSelect
              id="tarefas-criacao"
              rotulo="Criação"
              valor={filtros.criacao}
              disabled={!pronto}
              opcoes={FILTROS_CRIACAO}
              onChange={(valor) => aplicar({ criacao: valor })}
            />
            <CampoSelect
              id="tarefas-ordem"
              rotulo="Ordenar por"
              valor={filtros.ordem}
              disabled={!pronto}
              opcoes={ORDENS_TAREFAS}
              onChange={(valor) => aplicar({ ordem: valor })}
            />
          </div>
          <div className="admin-filtros-rodape">
            <p className="admin-contagem" aria-live="polite">
              {pronto ? `Exibindo ${visiveis.length} de ${plural(tarefas.length, "tarefa", "tarefas")}` : ""}
            </p>
            {filtroAtivo && pronto && (
              <button type="button" className="admin-botao-secundario" onClick={limpar}>
                Limpar filtros
              </button>
            )}
            <div className="admin-visualizacao" role="group" aria-label="Modo de visualização">
              <button
                type="button"
                aria-pressed={visualizacao === "lista"}
                className={visualizacao === "lista" ? "ativo" : ""}
                onClick={() => escolherVisualizacao("lista")}
              >
                Lista
              </button>
              <button
                type="button"
                aria-pressed={visualizacao === "cards"}
                className={visualizacao === "cards" ? "ativo" : ""}
                onClick={() => escolherVisualizacao("cards")}
              >
                Cards
              </button>
            </div>
          </div>
          {pronto && semDataCriacao > 0 && (
            <p className="admin-nota">
              {`${plural(semDataCriacao, "tarefa sem data de criação não entra", "tarefas sem data de criação não entram")} no filtro de criação.`}
            </p>
          )}
        </section>

        {pronto && invalidos.length > 0 && (
          <p className="tasks-feedback admin-aviso" role="status">
            {`Filtros ignorados por serem inválidos ou indisponíveis: ${invalidos.join(", ")}.`}
          </p>
        )}
        {avisoPedido && <p className="tasks-feedback admin-aviso" role="status">{avisoPedido}</p>}

        {destacadaOculta && (
          <section className="tarefa-fixada" aria-label="Tarefa solicitada">
            <div className="tarefa-fixada-aviso">
              <p>A tarefa solicitada não corresponde aos filtros ativos e está exibida aqui separadamente.</p>
              <div className="tarefa-fixada-acoes">
                <button type="button" className="admin-botao-secundario" onClick={limpar}>
                  Limpar filtros
                </button>
                <button type="button" className="admin-botao-secundario" onClick={() => setDestacada(null)}>
                  Fechar destaque
                </button>
              </div>
            </div>
            <div className="tasks-list tasks-list-fixada">{renderCartao(tarefaDestacada)}</div>
          </section>
        )}

        <div className="admin-resultados">{renderConteudo()}</div>
      </main>
      <ConfirmDialog
        open={!!deleteTarget}
        title="Excluir tarefa?"
        message={`A tarefa "${deleteTarget?.descricao || ""}" sera excluida permanentemente. Esta acao nao pode ser desfeita.`}
        confirmLabel="Excluir tarefa"
        loading={deleteLoading}
        onConfirm={handleDelete}
        onCancel={() => !deleteLoading && setDeleteTarget(null)}
      />
    </div>
  );
}

export default DashboardTarefasAdmin;
