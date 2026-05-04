import React, { useEffect, useState } from 'react';
import axios from 'axios';
import Sidebar from '../../components/layout/Sidebar';
import { authUtils } from '../../config/authUtils';
import { API_ENDPOINTS } from '../../config/config';
import '../../styles/pages/common/NotificationsPage.css';

const NotificationsPage = () => {
  const [notifications, setNotifications] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const fetchNotifications = async () => {
    try {
      setLoading(true);
      const res = await axios.get(API_ENDPOINTS.NOTIFICATIONS, {
        headers: { Authorization: `Bearer ${authUtils.getToken()}` },
      });
      setNotifications(res.data || []);
    } catch (err) {
      setError('Erro ao carregar notificações.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchNotifications();
  }, []);

  const markAsRead = async (id) => {
    try {
      await axios.put(API_ENDPOINTS.NOTIFICATIONS_MARK_READ(id), {}, {
        headers: { Authorization: `Bearer ${authUtils.getToken()}` },
      });
      setNotifications((prev) => prev.map((item) => (item._id === id ? { ...item, lida: true } : item)));
    } catch (_) {
      setError('Erro ao marcar notificação como lida.');
    }
  };

  const markAllAsRead = async () => {
    try {
      await axios.put(API_ENDPOINTS.NOTIFICATIONS_MARK_ALL_READ, {}, {
        headers: { Authorization: `Bearer ${authUtils.getToken()}` },
      });
      setNotifications((prev) => prev.map((item) => ({ ...item, lida: true })));
    } catch (_) {
      setError('Erro ao marcar notificações como lidas.');
    }
  };

  return (
    <div className="admin-page">
      <Sidebar />

      <main className="notifications-page">
        <header className="notifications-header">
          <div>
            <h2>Notificações</h2>
            <p>Acompanhe as mensagens e atualizações importantes do Flowly.</p>
          </div>
          <button type="button" className="mark-all-btn" onClick={markAllAsRead}>
            Marcar todas como lidas
          </button>
        </header>

        {error && <div className="notifications-error">{error}</div>}

        {loading ? (
          <div className="notifications-empty">Carregando notificações...</div>
        ) : notifications.length === 0 ? (
          <div className="notifications-empty">Nenhuma notificação no momento.</div>
        ) : (
          <div className="notifications-list">
            {notifications.map((notification) => (
              <article key={notification._id} className={`notification-card ${notification.lida ? 'read' : 'unread'}`}>
                <div className="notification-card-top">
                  <span className={`notification-type type-${notification.tipo}`}>{notification.tipo}</span>
                  {!notification.lida && <span className="unread-dot" />}
                </div>
                <p className="notification-text">{notification.texto}</p>
                <div className="notification-footer">
                  <span>{new Date(notification.createdAt).toLocaleString()}</span>
                  {!notification.lida && (
                    <button type="button" className="read-btn" onClick={() => markAsRead(notification._id)}>
                      Marcar como lida
                    </button>
                  )}
                </div>
              </article>
            ))}
          </div>
        )}
      </main>
    </div>
  );
};

export default NotificationsPage;