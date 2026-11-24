import React, { useEffect, useMemo, useState } from 'react';
import apiClient, { getFullApiUrl } from '../../config/apiClient';
import { Link } from 'react-router-dom';
import Sidebar from '../../components/layout/Sidebar';
import { API_ENDPOINTS } from '../../config/config';
import '../../styles/pages/admin/DashboardAdmin.css';
import '../../styles/pages/user/EquipesUser.css';

function EquipesUser() {
  const [equipes, setEquipes] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const getInitials = (name = '?') =>
    name
      .trim()
      .split(/\s+/)
      .slice(0, 2)
      .map((part) => part[0])
      .join('')
      .toUpperCase();

  const renderAvatar = (membro) => {
    const photo = membro?.fotoPerfil;
    const name = membro?.nome || '?';

    return (
      <span className="equipe-user-member-avatar">
        {photo ? <img src={getFullApiUrl(photo)} alt="" /> : getInitials(name)}
      </span>
    );
  };

  useEffect(() => {
    const carregarEquipes = async () => {
      setLoading(true);
      setError('');

      try {
        const response = await apiClient.get(API_ENDPOINTS.MINHAS_EQUIPES);
        setEquipes(response.data);
      } catch (err) {
        setError('Nao foi possivel carregar suas equipes.');
      } finally {
        setLoading(false);
      }
    };

    carregarEquipes();
  }, []);

  const totalMembros = useMemo(
    () => equipes.reduce((total, equipe) => total + (equipe.membros?.length || 0), 0),
    [equipes]
  );

  return (
    <div className="admin-page equipes-user-page">
      <Sidebar />

      <main className="dashboard-user equipes-user-content">
        <header className="equipes-user-header">
          <h2>Minhas Equipes</h2>
          <p>Veja as equipes em que voce participa.</p>
        </header>

        <section className="equipes-user-metrics">
          <article className="equipes-user-metric">
            <span className="metric-label">Equipes vinculadas</span>
            <strong>{equipes.length}</strong>
          </article>
          <article className="equipes-user-metric">
            <span className="metric-label">Total de membros nas equipes</span>
            <strong>{totalMembros}</strong>
          </article>
        </section>

        {loading && <p>Carregando equipes...</p>}
        {!loading && error && <p className="equipes-user-error">{error}</p>}

        {!loading && !error && equipes.length === 0 && (
          <p>Voce ainda nao esta vinculado a nenhuma equipe.</p>
        )}

        {!loading && !error && equipes.length > 0 && (
          <section className="equipes-user-grid">
            {equipes.map((equipe) => (
              <article key={equipe._id} className="equipe-user-card">
                <div className="equipe-user-card-header">
                  <h3>{equipe.nome}</h3>
                  <Link
                    className="equipe-user-chat"
                    to="/chats"
                    state={{ equipeId: equipe._id }}
                    aria-label={`Abrir chat da equipe ${equipe.nome}`}
                  >
                    Abrir chat
                  </Link>
                </div>
                <p>
                  <strong>Membros:</strong> {equipe.membros?.length || 0}
                </p>
                <ul className="equipe-user-members-list">
                  {(equipe.membros || []).map((membro) => (
                    <li key={membro._id} className="equipe-user-member">
                      {renderAvatar(membro)}
                      <span>
                        <strong>{membro.nome}</strong>
                        {membro.email && <small>{membro.email}</small>}
                      </span>
                    </li>
                  ))}
                </ul>
              </article>
            ))}
          </section>
        )}
      </main>
    </div>
  );
}

export default EquipesUser;
