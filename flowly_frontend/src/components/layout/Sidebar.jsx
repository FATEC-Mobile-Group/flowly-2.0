import React, { useState, useEffect } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import {
  FaChartPie, FaUsers, FaTasks, FaSignOutAlt,
  FaBars, FaTimes, FaPlus, FaClipboardList, FaHome, FaInbox, FaComments, FaBell
} from 'react-icons/fa';
import { authUtils } from '../../config/authUtils';
import '../../styles/components/Sidebar.css';

const Sidebar = () => {
  const [expanded, setExpanded] = useState(true);
  const [mobileOpen, setMobileOpen] = useState(false);
  const location = useLocation();
  const navigate = useNavigate();

  const userType = authUtils.getUserType();
  const isAdmin = userType === 'admin';
  const userName = localStorage.getItem('nome') || 'Usuário';
  const userPhoto = localStorage.getItem('fotoPerfil') || '';
  const apiPublicBase = process.env.REACT_APP_API_PUBLIC_URL || 'http://localhost:5000';
  const userPhotoUrl = userPhoto
    ? userPhoto.startsWith('http')
      ? userPhoto
      : `${apiPublicBase}${userPhoto}`
    : '';

  // Close mobile menu on route change
  useEffect(() => {
    setMobileOpen(false);
  }, [location.pathname]);

  // Close mobile menu on resize
  useEffect(() => {
    const handleResize = () => {
      if (window.innerWidth > 768) {
        setMobileOpen(false);
      }
    };
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  const logout = () => {
    authUtils.clearAuthData();
    navigate('/');
  };

  const isActive = (path) => {
    // Mapa de rotas relacionadas para evitar que parent paths ativem eroneamente
    const relatedRoutes = {
      '/admin': ['/admin', '/admin/equipe/', '/admin/criar-equipe'],
      '/admin/geral': ['/admin/geral'],
      '/admin/chats': ['/admin/chats'],
      '/admin/tarefas': ['/admin/tarefas', '/admin/criar-tarefa', '/admin/editar-tarefa/'],
      '/notificacoes': ['/notificacoes'],
      '/dashboard': ['/dashboard'],
      '/minhas-tarefas': ['/minhas-tarefas'],
      '/backlog': ['/backlog', '/backlog/'],
      '/equipes': ['/equipes'],
      '/chats': ['/chats'],
    };

    const routes = relatedRoutes[path] || [path];
    
    return routes.some(route => {
      if (route.endsWith('/')) {
        return location.pathname.startsWith(route) || location.pathname === route.slice(0, -1);
      }
      return location.pathname === route || location.pathname.startsWith(`${route}/`);
    });
  };

  const adminMenuItems = [
    { path: '/admin/geral', icon: <FaChartPie />, label: 'Painel Geral' },
    { path: '/admin', icon: <FaUsers />, label: 'Equipes' },
    { path: '/admin/chats', icon: <FaComments />, label: 'Chats' },
    { path: '/notificacoes', icon: <FaBell />, label: 'Notificações' },
    { path: '/admin/criar-equipe', icon: <FaPlus />, label: 'Nova Equipe' },
    { path: '/admin/tarefas', icon: <FaClipboardList />, label: 'Tarefas' },
    { path: '/admin/criar-tarefa', icon: <FaPlus />, label: 'Nova Tarefa' },
  ];

  const userMenuItems = [
    { path: '/dashboard', icon: <FaHome />, label: 'Meu Painel' },
    { path: '/minhas-tarefas', icon: <FaTasks />, label: 'Kanban Board' },
    { path: '/backlog', icon: <FaInbox />, label: 'Backlog' },
    { path: '/chats', icon: <FaComments />, label: 'Chats' },
    { path: '/notificacoes', icon: <FaBell />, label: 'Notificações' },
    { path: '/equipes', icon: <FaUsers />, label: 'Minhas Equipes' },
  ];

  const menuItems = isAdmin ? adminMenuItems : userMenuItems;

  return (
    <>
      {/* Hamburger Button (mobile) */}
      <button
        className="sidebar-hamburger"
        onClick={() => setMobileOpen(!mobileOpen)}
        aria-label="Menu"
      >
        {mobileOpen ? <FaTimes /> : <FaBars />}
      </button>

      {/* Overlay (mobile) */}
      {mobileOpen && (
        <div className="sidebar-overlay" onClick={() => setMobileOpen(false)} />
      )}

      <aside className={`sidebar ${expanded ? 'expanded' : 'collapsed'} ${mobileOpen ? 'mobile-open' : ''}`}>        
        {/* Logo & Toggle */}
        <div className="sidebar-top">
          <div className="sidebar-brand">
            <div className="sidebar-logo">F</div>
            {expanded && <span className="sidebar-brand-text">Flowly</span>}
          </div>
          <button
            className="sidebar-toggle"
            onClick={() => setExpanded(!expanded)}
            aria-label={expanded ? 'Recolher menu' : 'Expandir menu'}
          >
            <FaBars />
          </button>
        </div>

        {/* Navigation */}
        <nav className="sidebar-nav">
          <div className="sidebar-section-label">
            {expanded && (isAdmin ? 'ADMINISTRAÇÃO' : 'NAVEGAÇÃO')}
          </div>
          <ul className="sidebar-menu">
            {menuItems.map((item) => (
              <li key={item.path}>
                <Link
                  to={item.path}
                  className={`sidebar-link ${isActive(item.path) ? 'active' : ''}`}
                  title={item.label}
                >
                  <span className="sidebar-link-icon">{item.icon}</span>
                  {expanded && <span className="sidebar-link-text">{item.label}</span>}
                </Link>
              </li>
            ))}
          </ul>
        </nav>

        {/* Bottom Section */}
        <div className="sidebar-footer">
          {/* User Info */}
          <button
            type="button"
            className="sidebar-user"
            onClick={() => navigate('/perfil')}
            title="Meu Perfil"
          >
            <div className="sidebar-user-avatar">
              {userPhotoUrl ? (
                <img src={userPhotoUrl} alt="Foto de perfil" className="sidebar-user-avatar-img" />
              ) : (
                userName.charAt(0).toUpperCase()
              )}
            </div>
            {expanded && (
              <div className="sidebar-user-info">
                <span className="sidebar-user-name">{userName}</span>
                <span className="sidebar-user-role">{isAdmin ? 'Administrador' : 'Colaborador'}</span>
              </div>
            )}
          </button>

          <button
            onClick={logout}
            className="sidebar-logout"
            title="Sair"
          >
            <span className="sidebar-link-icon"><FaSignOutAlt /></span>
            {expanded && <span className="sidebar-link-text">Sair</span>}
          </button>
        </div>
      </aside>
    </>
  );
};

export default Sidebar;
