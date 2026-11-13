import React, { useEffect, useMemo, useRef, useState } from 'react';
import createSocketConnection from '../../config/socketClient';
import apiClient, { getFullApiUrl } from '../../config/apiClient';
import Sidebar from '../../components/layout/Sidebar';
import { authUtils } from '../../config/authUtils';
import { API_ENDPOINTS } from '../../config/config';
import '../../styles/pages/common/ChatsPage.css';

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

const ChatsPage = () => {
  const [equipes, setEquipes] = useState([]);
  const [selectedEquipe, setSelectedEquipe] = useState(null);
  const [messages, setMessages] = useState([]);
  const [novaMensagem, setNovaMensagem] = useState('');
  const [loadingEquipes, setLoadingEquipes] = useState(true);
  const [loadingMensagens, setLoadingMensagens] = useState(false);
  const [erro, setErro] = useState('');
  const [blockedPopup, setBlockedPopup] = useState('');

  const socketRef = useRef(null);
  const endRef = useRef(null);
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
      <div className="chat-avatar" aria-label={name}>
        {photo ? <img src={getFullApiUrl(photo)} alt="" /> : <span>{getInitials(name)}</span>}
      </div>
    );
  };

  const scrollToBottom = () => {
    if (endRef.current) {
      endRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  };

  const equipeAtiva = useMemo(
    () => equipes.find((equipe) => equipe._id === selectedEquipe) || null,
    [equipes, selectedEquipe],
  );

  useEffect(() => {
    const fetchEquipes = async () => {
      try {
        setLoadingEquipes(true);
        const res = await apiClient.get(API_ENDPOINTS.MINHAS_EQUIPES);
        setEquipes(res.data || []);
        if ((res.data || []).length > 0) {
          setSelectedEquipe(res.data[0]._id);
        }
      } catch (err) {
        setErro('Erro ao carregar equipes de chat.');
      } finally {
        setLoadingEquipes(false);
      }
    };

    fetchEquipes();
  }, []);

  useEffect(() => {
    if (!selectedEquipe) {
      return;
    }

    const loadHistory = async () => {
      setLoadingMensagens(true);
      try {
        const res = await apiClient.get(`/equipes/${selectedEquipe}/messages`);
        setMessages(res.data || []);
      } catch (error) {
        setErro('Erro ao carregar mensagens do chat.');
      } finally {
        setLoadingMensagens(false);
      }
    };

    socketRef.current?.disconnect();

    const socket = createSocketConnection();
    socketRef.current = socket;

    socket.on('connect', () => {
      socket.emit('join_equipe', selectedEquipe);
    });

    socket.on('receive_message', (msg) => {
      setMessages((prev) => [...prev, msg]);
    });

    socket.on('message_blocked', (payload) => {
      setBlockedPopup(payload?.message || 'Mensagem bloqueada.');
    });

    loadHistory();

    return () => {
      socket.disconnect();
    };
  }, [selectedEquipe]);

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  const handleSendMessage = (event) => {
    event.preventDefault();
    const texto = novaMensagem.trim();
    if (!texto || !selectedEquipe || !socketRef.current) {
      return;
    }

    socketRef.current.emit('send_message', {
      equipeId: selectedEquipe,
      texto,
    });

    setNovaMensagem('');
  };

  useEffect(() => {
    if (!blockedPopup) return undefined;
    const timeout = setTimeout(() => setBlockedPopup(''), 4500);
    return () => clearTimeout(timeout);
  }, [blockedPopup]);

  return (
    <div className="chats-page">
      <Sidebar />

      <main className="chats-content">
        {blockedPopup && (
          <div className="chat-blocked-popup page" role="alert">
            <strong>Mensagem bloqueada</strong>
            <span>{blockedPopup}</span>
            <button type="button" onClick={() => setBlockedPopup('')} aria-label="Fechar aviso">x</button>
          </div>
        )}

        <div className="chats-header">
          <h2>Chats</h2>
          <p>Converse com os membros das equipes em um lugar unificado.</p>
        </div>

        {erro && <div className="mensagem erro">{erro}</div>}

        <div className="chats-layout">
          <aside className="chats-teams-panel">
            <h3>Equipes</h3>
            {loadingEquipes ? (
              <p>Carregando equipes...</p>
            ) : equipes.length === 0 ? (
              <p>Nenhuma equipe disponivel para chat.</p>
            ) : (
              <ul className="chats-team-list">
                {equipes.map((equipe) => (
                  <li key={equipe._id}>
                    <button
                      type="button"
                      onClick={() => setSelectedEquipe(equipe._id)}
                      className={equipe._id === selectedEquipe ? 'active' : ''}
                    >
                      <strong>{equipe.nome}</strong>
                      <span>{equipe.membros?.length || 0} membros</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </aside>

          <section className="chats-messages-panel">
            <header className="chats-room-header">
              <h3>{equipeAtiva?.nome || 'Selecione uma equipe'}</h3>
            </header>

            <div className="chats-messages-list">
              {loadingMensagens ? (
                <p>Carregando mensagens...</p>
              ) : messages.length === 0 ? (
                <p>Nenhuma mensagem ainda. Comece a conversa.</p>
              ) : (
                messages.map((msg, index) => {
                  const isMine = msg.user && msg.user._id === userId;
                  const userName = msg.user?.nome || 'Usuario';

                  return (
                    <div key={`${msg._id || 'msg'}-${index}`} className={`chat-message-row ${isMine ? 'mine' : 'theirs'}`}>
                      {!isMine && renderAvatar(msg.user)}
                      <div className="chat-message-stack">
                        {!isMine && <span className="chat-author">{userName}</span>}
                        <div className="chat-bubble">{msg.texto}</div>
                        <span className="chat-message-time">
                          {formatMessageTime(msg.createdAt)}
                        </span>
                      </div>
                      {isMine && renderAvatar(msg.user)}
                    </div>
                  );
                })
              )}
              <div ref={endRef} />
            </div>

            <form className="chats-input-row" onSubmit={handleSendMessage}>
              <input
                type="text"
                value={novaMensagem}
                onChange={(event) => setNovaMensagem(event.target.value)}
                placeholder="Digite sua mensagem..."
                disabled={!selectedEquipe}
              />
              <button type="submit" disabled={!selectedEquipe || !novaMensagem.trim()}>
                Enviar
              </button>
            </form>
          </section>
        </div>
      </main>
    </div>
  );
};

export default ChatsPage;
