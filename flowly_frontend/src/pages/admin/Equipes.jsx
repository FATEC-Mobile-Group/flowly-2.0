import { useEffect, useState } from "react";
import { useParams, Link, useLocation } from "react-router-dom";
import apiClient, { getFullApiUrl } from "../../config/apiClient";
import { API_ENDPOINTS } from "../../config/config";
import "../../styles/pages/admin/DashboardAdmin.css";
import "../../styles/pages/admin/Equipes.css";
import Sidebar from "../../components/layout/Sidebar";
import ConfirmDialog from "../../components/common/ConfirmDialog";

export default function Equipes() {
  const [equipes, setEquipes] = useState([]);
  const [nome, setNome] = useState("");
  const [membros, setMembros] = useState([]); // Array de objetos completos
  const [editandoId, setEditandoId] = useState(null);
  const [mensagemErro, setMensagemErro] = useState("");
  const [mensagemSucesso, setMensagemSucesso] = useState("");
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [deleteLoading, setDeleteLoading] = useState(false);
  const { id } = useParams();
  const location = useLocation();
  const currentUserId = localStorage.getItem("id");

  const [searchTerm, setSearchTerm] = useState("");
  const [searchResults, setSearchResults] = useState([]);
  const [showDropdown, setShowDropdown] = useState(false);
  const [searchTimeout, setSearchTimeout] = useState(null);

  const getInitials = (name = "?") =>
    name
      .trim()
      .split(/\s+/)
      .slice(0, 2)
      .map((part) => part[0])
      .join("")
      .toUpperCase();

  const renderUserAvatar = (user, className) => {
    const photo = user?.fotoPerfil;
    const name = user?.nome || "?";

    return (
      <span className={className}>
        {photo ? (
          <img src={getFullApiUrl(photo)} alt="" />
        ) : (
          getInitials(name)
        )}
      </span>
    );
  };

  useEffect(() => {
    carregarEquipes();
    carregarUsers();
  }, []);

  useEffect(() => {
  if (id) {
    const carregarEquipePorId = async () => {
      try {
        const res = await apiClient.get(API_ENDPOINTS.EQUIPES_BY_ID(id));
        const equipe = res.data;
        setNome(equipe.nome);
        setMembros(equipe.membros);
        setEditandoId(equipe._id);
      } catch (err) {
        console.error("Erro ao carregar equipe para edição", err);
      }
    };

    carregarEquipePorId();
  }
}, [id]);


  const carregarEquipes = async () => {
    try {
      const res = await apiClient.get(API_ENDPOINTS.EQUIPES);
      setEquipes(res.data);
    } catch (err) {
      console.error("Erro ao buscar equipes", err);
    }
  };

  const carregarUsers = async () => {
    try {
      await apiClient.get(API_ENDPOINTS.USERS);
    } catch (err) {
      console.error("Erro ao buscar usuários", err);
    }
  };

  // Busca usuários por termo (endpoint: GET /api/users/search?q=termo)
  const buscarUsuarios = async (termo) => {
    if (!termo || termo.trim() === "") {
      setSearchResults([]);
      setShowDropdown(false);
      return;
    }

    try {
      const res = await apiClient.get(`/users/search?q=${encodeURIComponent(termo)}`);
      // Excluir admins e já selecionados
      const resultados = res.data.filter((u) => u.tipo !== "admin" && !membros.find((m) => m._id === u._id));
      setSearchResults(resultados);
      setShowDropdown(resultados.length > 0);
    } catch (err) {
      console.error("Erro ao buscar usuários por termo", err);
      setSearchResults([]);
      setShowDropdown(false);
    }
  };

  // Gerencia debounce e chama buscarUsuarios
  const handleSearchChange = (value) => {
    setSearchTerm(value);

    if (searchTimeout) clearTimeout(searchTimeout);

    const timeout = setTimeout(() => {
      buscarUsuarios(value);
    }, 300);

    setSearchTimeout(timeout);
  };

  // Adiciona um usuário (objeto) aos membros selecionados
  const adicionarMembro = (usuario) => {
    if (!usuario) return;
    setMembros((prev) => {
      if (prev.find((m) => m._id === usuario._id)) return prev;
      return [...prev, usuario];
    });
    setSearchTerm("");
    setSearchResults([]);
    setShowDropdown(false);
  };

  // Remove membro por ID
  const removerMembro = (userId) => {
    if (String(userId) === String(currentUserId)) return;
    setMembros((prev) => prev.filter((m) => m._id !== userId));
  };

  const criarOuEditarEquipe = async (e) => {
    e.preventDefault();

    try {
      // Extrair IDs antes de enviar
      const membrosIds = membros.map((m) => (typeof m === "string" ? m : m._id));
      const dados = { nome, membros: Array.from(new Set(membrosIds)) };

      if (editandoId) {
        await apiClient.put(API_ENDPOINTS.UPDATE_EQUIPE(editandoId), dados);
        setMensagemSucesso("Equipe editada com sucesso!");
      } else {
        await apiClient.post(API_ENDPOINTS.CREATE_EQUIPE, dados);
        setMensagemSucesso("Equipe criada com sucesso!");
      }

      setNome("");
      setMembros([]);
      setEditandoId(null);
      carregarEquipes();
    } catch (err) {
      setMensagemErro(
        "Erro ao salvar equipe: " +
          (err.response?.data?.erro || err.response?.data?.detalhe || err.message)
      );
    }
  };

  const excluirEquipe = async () => {
    if (!deleteTarget) return;

    setDeleteLoading(true);
    try {
      await apiClient.delete(API_ENDPOINTS.DELETE_EQUIPE(deleteTarget._id));
      setDeleteTarget(null);
      carregarEquipes();
    } catch (err) {
      console.error("Erro ao excluir equipe", err);
    } finally {
      setDeleteLoading(false);
    }
  };

  const editarEquipe = (equipe) => {
    setNome(equipe.nome);
    setMembros(equipe.membros);
    setEditandoId(equipe._id);
  };

  return (
    <div className="admin-page">
      <Sidebar />

      <main className="dashboard-container">
        <div className="dashboard-header">
          <h2 className="dashboard-title">
            {location.pathname === '/admin/criar-equipe' ? 'Criar Nova Equipe' : 
             location.pathname.includes('/admin/equipe/') ? 'Editar Equipe' : 
             'Gerenciar Equipes'}
          </h2>
          {location.pathname !== '/admin' && (
            <Link to="/admin" className="btn-back">
              ← Voltar ao Dashboard
            </Link>
          )}
        </div>

        <form onSubmit={criarOuEditarEquipe} className="form">
          <input
            type="text"
            className="input"
            placeholder="Nome da equipe"
            value={nome}
            onChange={(e) => setNome(e.target.value)}
            required
          />

          <label className="label">Selecionar membros:</label>
          <div className="user-search">
            <input
              type="text"
              className="input"
              placeholder="Buscar usuários..."
              value={searchTerm}
              onChange={(e) => handleSearchChange(e.target.value)}
              onFocus={() => { if (searchResults.length) setShowDropdown(true); }}
            />

            {showDropdown && searchResults.length > 0 && (
              <div className="search-dropdown">
                {searchResults.map((user) => (
                  <div key={user._id} className="search-item">
                    <div className="search-item-info">
                      {renderUserAvatar(user, "search-avatar")}
                      <div>
                        <div className="search-item-main">{user.nome}</div>
                        <div className="search-item-email">{user.email}</div>
                      </div>
                    </div>
                    <button
                      type="button"
                      className="add-btn"
                      onClick={() => adicionarMembro(user)}
                    >
                      + Adicionar
                    </button>
                  </div>
                ))}
              </div>
            )}

            <div className="selected-members">
              {membros.map((m) => (
                <div key={m._id} className="member-chip">
                  {renderUserAvatar(m, "member-chip-avatar")}
                  <span className="member-name">
                    {m.nome} ({m.email}){String(m._id) === String(currentUserId) ? " - responsavel" : ""}
                  </span>
                  <button
                    type="button"
                    className={`remove-chip ${String(m._id) === String(currentUserId) ? "disabled" : ""}`}
                    disabled={String(m._id) === String(currentUserId)}
                    onClick={() => removerMembro(m._id)}
                    aria-label={`Remover ${m.nome}`}
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          </div>

          <button type="submit" className="btn">
            {editandoId ? "Salvar Alterações" : "Criar Equipe"}
          </button>
        </form>

        {mensagemSucesso && <p className="success-message">{mensagemSucesso}</p>}
        {mensagemErro && <p className="error-message">{mensagemErro}</p>}

        {location.pathname === '/admin' && (
          <div className="equipes-list">
            {equipes.length === 0 && (
              <div className="equipes-empty">
                Nenhuma equipe cadastrada ainda.
              </div>
            )}
            {equipes.map((equipe) => (
              <div className="equipe-card" key={equipe._id}>
                <div className="equipe-card-header">
                  <h3>{equipe.nome}</h3>
                  <span className="members-count">
                    {equipe.membros?.length || 0} membro{(equipe.membros?.length || 0) === 1 ? "" : "s"}
                  </span>
                </div>

                <div className="equipe-members-list">
                  {equipe.membros?.length ? (
                    equipe.membros.map((membro) => (
                      <div key={membro._id} className="equipe-member-item" title={membro.email || ""}>
                        {renderUserAvatar(membro, "equipe-member-avatar")}
                        <div className="equipe-member-texts">
                          <span className="equipe-member-name">{membro.nome}</span>
                          <span className="equipe-member-email">{membro.email || "Sem email"}</span>
                        </div>
                      </div>
                    ))
                  ) : (
                    <p className="sem-membros">Sem membros nesta equipe.</p>
                  )}
                </div>

                <div className="buttons">
                  <button className="edit-btn" onClick={() => editarEquipe(equipe)}>
                    Editar
                  </button>
                  <button
                    className="delete-btn"
                    onClick={() => setDeleteTarget(equipe)}
                  >
                    Excluir
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </main>
      <ConfirmDialog
        open={!!deleteTarget}
        title="Excluir equipe?"
        message={`A equipe "${deleteTarget?.nome || ""}" sera excluida permanentemente. Esta acao nao pode ser desfeita.`}
        confirmLabel="Excluir equipe"
        loading={deleteLoading}
        onConfirm={excluirEquipe}
        onCancel={() => !deleteLoading && setDeleteTarget(null)}
      />
    </div>
  );
}
