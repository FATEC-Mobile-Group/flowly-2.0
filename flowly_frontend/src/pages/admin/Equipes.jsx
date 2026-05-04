import { useEffect, useState } from "react";
import { useParams, Link, useLocation, useNavigate } from "react-router-dom";
import axios from "axios";
import "../../styles/pages/admin/DashboardAdmin.css";
import "../../styles/pages/admin/Equipes.css";
import Sidebar from "../../components/layout/Sidebar";

export default function Equipes() {
  const [equipes, setEquipes] = useState([]);
  const [nome, setNome] = useState("");
  const [membros, setMembros] = useState([]); // Array de objetos completos
  const [users, setUsers] = useState([]);
  const [editandoId, setEditandoId] = useState(null);
  const [mensagemErro, setMensagemErro] = useState("");
  const [mensagemSucesso, setMensagemSucesso] = useState("");
  const { id } = useParams();
  const location = useLocation();
  const navigate = useNavigate();

  const token = localStorage.getItem("token");

  const [searchTerm, setSearchTerm] = useState("");
  const [searchResults, setSearchResults] = useState([]);
  const [showDropdown, setShowDropdown] = useState(false);
  const [searchTimeout, setSearchTimeout] = useState(null);



  useEffect(() => {
    carregarEquipes();
    carregarUsers();
  }, []);

  useEffect(() => {
  if (id) {
    const carregarEquipePorId = async () => {
      try {
        const res = await axios.get(`http://localhost:5000/api/equipes/${id}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
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
      const res = await axios.get("http://localhost:5000/api/equipes", {
        headers: { Authorization: `Bearer ${token}` },
      });
      setEquipes(res.data);
    } catch (err) {
      console.error("Erro ao buscar equipes", err);
    }
  };

  const carregarUsers = async () => {
    try {
      const res = await axios.get("http://localhost:5000/api/users", {
        headers: { Authorization: `Bearer ${token}` },
      });
      setUsers(res.data);
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
      const res = await axios.get(`http://localhost:5000/api/users/search?q=${encodeURIComponent(termo)}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
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
    setMembros((prev) => prev.filter((m) => m._id !== userId));
  };

  const criarOuEditarEquipe = async (e) => {
    e.preventDefault();

    try {
      // Extrair IDs antes de enviar
      const membrosIds = membros.map((m) => (typeof m === "string" ? m : m._id));
      const dados = { nome, membros: Array.from(new Set(membrosIds)) };

      if (editandoId) {
        await axios.put(`http://localhost:5000/api/equipes/${editandoId}`, dados, {
          headers: { Authorization: `Bearer ${token}` },
        });
        setMensagemSucesso("Equipe editada com sucesso!");
      } else {
        await axios.post("http://localhost:5000/api/equipes", dados, {
          headers: { Authorization: `Bearer ${token}` },
        });
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

  const excluirEquipe = async (id) => {
    try {
      await axios.delete(`http://localhost:5000/api/equipes/${id}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      carregarEquipes();
    } catch (err) {
      console.error("Erro ao excluir equipe", err);
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
                      <span className="search-avatar">
                        {(user.nome || "?").trim().charAt(0).toUpperCase()}
                      </span>
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
                  <span className="member-name">{m.nome} ({m.email})</span>
                  <button
                    type="button"
                    className="remove-chip"
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
                        <span className="equipe-member-avatar">
                          {(membro.nome || "?").trim().charAt(0).toUpperCase()}
                        </span>
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
                    onClick={() => excluirEquipe(equipe._id)}
                  >
                    Excluir
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </main>
    </div>
  );
}