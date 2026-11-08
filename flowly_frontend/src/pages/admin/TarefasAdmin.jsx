import React, { useEffect, useState } from "react";
import apiClient from "../../config/apiClient";
import { API_ENDPOINTS } from "../../config/config";
import { Link, useLocation, useParams } from "react-router-dom";
import "../../styles/pages/admin/DashboardAdmin.css";
import "../../styles/pages/admin/TarefasAdmin.css";
import Sidebar from "../../components/layout/Sidebar";

function TarefasAdmin() {
  const [descricao, setDescricao] = useState("");
  const [detalhes, setDetalhes] = useState("");
  const [dataEntrega, setDataEntrega] = useState("");
  const [equipes, setEquipes] = useState([]);
  const [users, setUsers] = useState([]);
  const [equipeSelecionada, setEquipeSelecionada] = useState("");
  const [userSelecionado, setUserSelecionado] = useState("");
  const [mensagem, setMensagem] = useState("");
  const [tipoMensagem, setTipoMensagem] = useState("sucesso");
  const [idTarefaEditando, setIdTarefaEditando] = useState(null);
  const [tempoEstimado, setTempoEstimado] = useState("");
  const [urgencia, setUrgencia] = useState("baixa");
  const location = useLocation();
  const { id } = useParams();
  // O modo vem da rota: falhar ao carregar a tarefa nunca pode transformar edicao em criacao.
  const modoEdicao = Boolean(id);

  useEffect(() => {
    buscarEquipes();
  }, []);

  useEffect(() => {
    if (!id) return;

    const carregarTarefa = async () => {
      try {
        const res = await apiClient.get(`${API_ENDPOINTS.TAREFAS_BY_ID(id)}/detalhes`);

        const { tarefa } = res.data;
        setIdTarefaEditando(tarefa._id);
        setDescricao(tarefa.descricao || "");
        setDetalhes(tarefa.detalhes || "");
        setDataEntrega(tarefa.dataEntrega ? tarefa.dataEntrega.split("T")[0] : "");
        setEquipeSelecionada(tarefa.equipe?._id || "");
        setUserSelecionado(tarefa.user?._id || "");
        setTempoEstimado(tarefa.tempoEstimado || "");
        setUrgencia(tarefa.urgencia || "baixa");

        if (tarefa.equipe?._id) {
          buscarMembersDaEquipe(tarefa.equipe._id);
        }
      } catch (err) {
        console.error("Erro ao carregar tarefa para edição:", err);
        setTipoMensagem("erro");
        setMensagem("Não foi possível carregar a tarefa para edição. Volte à lista de tarefas e tente novamente.");
      }
    };

    carregarTarefa();
  }, [id]);

  const buscarEquipes = async () => {
    try {
      const res = await apiClient.get(API_ENDPOINTS.EQUIPES);
      setEquipes(res.data);
    } catch (err) {
      console.error("Erro ao buscar equipes:", err);
    }
  };

  const buscarMembersDaEquipe = async (equipeId) => {
    try {
      const res = await apiClient.get(API_ENDPOINTS.EQUIPE_MEMBROS(equipeId));
      setUsers(res.data);
    } catch (err) {
      console.error("Erro ao buscar membros da equipe:", err);
    }
  };

  const handleEquipeChange = (e) => {
    const equipeId = e.target.value;
    setEquipeSelecionada(equipeId);
    setUserSelecionado("");
    if (equipeId) {
      buscarMembersDaEquipe(equipeId);
    } else {
      setUsers([]);
    }
  };

  const atualizarTarefa = async () => {
    try {
      await apiClient.put(
        API_ENDPOINTS.UPDATE_TAREFA(idTarefaEditando),
        {
          descricao,
          detalhes,
          dataEntrega,
          equipe: equipeSelecionada,
          user: userSelecionado,
          tempoEstimado: parseInt(tempoEstimado) || null,
          urgencia,
        }
      );

      setTipoMensagem("sucesso");
      setMensagem("Tarefa atualizada com sucesso!");
      setTimeout(() => setMensagem(""), 3000);
    } catch (err) {
      console.error("Erro ao atualizar tarefa:", err);
    }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();

    // Sem a tarefa carregada nao ha o que salvar, e a rota de edicao nunca faz POST.
    if (modoEdicao && !idTarefaEditando) return;

    const hoje = new Date();
    const dataSelecionada = new Date(dataEntrega);
    hoje.setHours(0, 0, 0, 0);
    dataSelecionada.setHours(0, 0, 0, 0);

    if (dataSelecionada < hoje) {
      setTipoMensagem("erro");
      setMensagem("A data de entrega não pode ser anterior à data de hoje.");
      setTimeout(() => setMensagem(""), 3000);
      return;
    }

    try {
      if (modoEdicao) {
        await atualizarTarefa();
      } else {
        await apiClient.post(
          API_ENDPOINTS.CREATE_TAREFA,
          {
            descricao,
            detalhes,
            dataEntrega,
            equipe: equipeSelecionada,
            user: userSelecionado,
            tempoEstimado: parseInt(tempoEstimado) || null,
            urgencia,
          }
        );

        setDescricao("");
        setDetalhes("");
        setDataEntrega("");
        setEquipeSelecionada("");
        setUserSelecionado("");
        setTempoEstimado("");
        setUrgencia("baixa");
        setUsers([]);

        setTipoMensagem("sucesso");
        setMensagem("Tarefa criada com sucesso!");
        setTimeout(() => setMensagem(""), 3000);
      }
    } catch (err) {
      console.error("Erro ao salvar tarefa:", err);
    }
  };

  return (
    <div className="admin-page">
      <Sidebar />

      <main className="dashboard-container">
        <div className="dashboard-header">
          <h2 className="dashboard-title">
            {location.pathname === "/admin/criar-tarefa"
              ? "Criar Nova Tarefa"
              : location.pathname.includes("/admin/editar-tarefa/")
              ? "Editar Tarefa"
              : "Gerenciar Tarefas"}
          </h2>
          <Link to="/admin/tarefas" className="btn-back">
            ← Voltar ao Dashboard de Tarefas
          </Link>
        </div>

        <form className="form-tarefa" onSubmit={handleSubmit}>
          <input
            type="text"
            placeholder="Nome da tarefa"
            value={descricao}
            onChange={(e) => setDescricao(e.target.value)}
            required
          />

          <textarea
            placeholder="Descrição detalhada da tarefa"
            value={detalhes}
            onChange={(e) => setDetalhes(e.target.value)}
            rows={3}
            style={{ resize: "vertical" }}
          />

          <input
            type="date"
            value={dataEntrega}
            onChange={(e) => setDataEntrega(e.target.value)}
            required
          />

          <input
            type="number"
            placeholder="Tempo estimado (em minutos)"
            value={tempoEstimado}
            onChange={(e) => setTempoEstimado(e.target.value)}
            min="0"
          />

          <select value={urgencia} onChange={(e) => setUrgencia(e.target.value)} required>
            <option value="baixa">Urgência Baixa</option>
            <option value="media">Urgência Média</option>
            <option value="alta">Urgência Alta</option>
          </select>

          <select value={equipeSelecionada} onChange={handleEquipeChange} required>
            <option value="">Selecione uma equipe</option>
            {equipes.map((equipe) => (
              <option key={equipe._id} value={equipe._id}>
                {equipe.nome}
              </option>
            ))}
          </select>

          <select
            value={userSelecionado}
            onChange={(e) => setUserSelecionado(e.target.value)}
            disabled={!equipeSelecionada}
          >
            <option value="">Sem responsável (Backlog)</option>
            {users.map((user) => (
              <option key={user._id} value={user._id}>
                {user.nome}
              </option>
            ))}
          </select>

          <button type="submit" disabled={modoEdicao && !idTarefaEditando}>
            {modoEdicao ? "Salvar Alterações" : "Criar Tarefa"}
          </button>

          {mensagem && <div className={`mensagem ${tipoMensagem}`}>{mensagem}</div>}
        </form>
      </main>
    </div>
  );
}

export default TarefasAdmin;
