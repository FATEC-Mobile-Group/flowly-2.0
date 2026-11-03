import React, { useState, useEffect, useRef } from 'react';
import createSocketConnection from '../../config/socketClient';
import apiClient, { getFullApiUrl } from '../../config/apiClient';
import { authUtils } from '../../config/authUtils';
import { API_ENDPOINTS } from '../../config/config';
import '../../styles/components/ChatPanel.css';

const formatMessageTime = (dateStr) => {
  const date = dateStr ? new Date(dateStr) : new Date();
  if (isNaN(date.getTime())) return '';
  const day = String(date.getDate()).padStart(2, '0');
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const year = date.getFullYear();
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  return `${day}/${month}/${year} ${hours}:${minutes}`;
};

const ChatPanel = () => {
  const [isOpen, setIsOpen] = useState(false);
  const [equipes, setEquipes] = useState([]);
  const [selectedEquipe, setSelectedEquipe] = useState(null);
  const [messages, setMessages] = useState([]);
  const [novaMensagem, setNovaMensagem] = useState('');
  const [socket, setSocket] = useState(null);
  const [blockedPopup, setBlockedPopup] = useState('');

  const messagesEndRef = useRef(null);
  const userId = authUtils.getUserId();

  const getInitials = (name = 'Usuario') =>
    name
      .trim()
      .split(/\s+/)
      .slice(0, 2)
      .map((part) => part[0])
      .join('')
      .toUpperCase();

  const renderAvatar = (user) => {
    const photo = user?.fotoPerfil;
    const name = user?.nome || 'Usuario';

    return (
      <div className="message-avatar" aria-label={name}>
        {photo ? <img src={getFullApiUrl(photo)} alt="" /> : <span>{getInitials(name)}</span>}
      </div>
    );
  };

  useEffect(() => {
    const fetchEquipes = async () => {
      try {
        const res = await apiClient.get(API_ENDPOINTS.MINHAS_EQUIPES);
        setEquipes(res.data);
        if (res.data.length > 0) {
          setSelectedEquipe(res.data[0]._id);
        }
      } catch (err) {
        console.error('Erro ao carregar equipes para o chat', err);
      }
    };

    fetchEquipes();
  }, [userId]);

  useEffect(() => {
    if (!selectedEquipe) return;

    const newSocket = createSocketConnection();
    setSocket(newSocket);
    newSocket.emit('join_equipe', selectedEquipe);

    const fetchHistory = async () => {
      try {
        const res = await apiClient.get(`/equipes/${selectedEquipe}/messages`);
        setMessages(res.data);
      } catch (error) {
        console.error('Erro ao buscar historico de mensagens');
      }
    };

    fetchHistory();

    newSocket.on('receive_message', (msg) => {
      setMessages((prev) => [...prev, msg]);
    });

    newSocket.on('message_blocked', (payload) => {
      setBlockedPopup(payload?.message || 'Mensagem bloqueada.');
    });

    return () => {
      newSocket.disconnect();
    };
  }, [selectedEquipe]);

  useEffect(() => {
    if (messagesEndRef.current) {
      messagesEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages, isOpen]);

  const handleSendMessage = (e) => {
    e.preventDefault();
    if (!novaMensagem.trim() || !socket || !selectedEquipe) return;

    socket.emit('send_message', {
      equipeId: selectedEquipe,
      texto: novaMensagem,
    });

    setNovaMensagem('');
  };

  useEffect(() => {
    if (!blockedPopup) return undefined;
    const timeout = setTimeout(() => setBlockedPopup(''), 4500);
    return () => clearTimeout(timeout);
  }, [blockedPopup]);

  if (equipes.length === 0) return null;

  return (
    <div className={`chat-panel-container ${isOpen ? 'open' : ''}`}>
      {!isOpen && (
        <button className="chat-toggle-btn" onClick={() => setIsOpen(true)}>
          Chat da Equipe
        </button>
      )}

      {isOpen && (
        <div className="chat-window">
          {blockedPopup && (
            <div className="chat-blocked-popup" role="alert">
              <strong>Mensagem bloqueada</strong>
              <span>{blockedPopup}</span>
              <button type="button" onClick={() => setBlockedPopup('')} aria-label="Fechar aviso">x</button>
            </div>
          )}
          <div className="chat-header">
            <select
              value={selectedEquipe}
              onChange={(e) => setSelectedEquipe(e.target.value)}
              className="chat-equipe-select"
            >
              {equipes.map((eq) => (
                <option key={eq._id} value={eq._id}>{eq.nome}</option>
              ))}
            </select>
            <button className="close-btn" onClick={() => setIsOpen(false)}>x</button>
          </div>

          <div className="chat-messages">
            {messages.map((msg, index) => {
              const isMine = msg.user && msg.user._id === userId;
              const userName = msg.user?.nome || 'Usuario';

              return (
                <div key={msg._id || index} className={`message-wrapper ${isMine ? 'mine' : 'theirs'}`}>
                  {!isMine && renderAvatar(msg.user)}
                  <div className="message-stack">
                    {!isMine && <span className="message-author">{userName}</span>}
                    <div className="message-bubble">
                      {msg.texto}
                    </div>
                    <span className="message-time">
                      {formatMessageTime(msg.createdAt)}
                    </span>
                  </div>
                  {isMine && renderAvatar(msg.user)}
                </div>
              );
            })}
            <div ref={messagesEndRef} />
          </div>

          <form className="chat-input-form" onSubmit={handleSendMessage}>
            <input
              type="text"
              placeholder="Digite sua mensagem..."
              value={novaMensagem}
              onChange={(e) => setNovaMensagem(e.target.value)}
            />
            <button type="submit">Enviar</button>
          </form>
        </div>
      )}
    </div>
  );
};

export default ChatPanel;
