import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FaPaperclip } from 'react-icons/fa';
import createSocketConnection from '../../config/socketClient';
import apiClient, { getFullApiUrl } from '../../config/apiClient';
import Sidebar from '../../components/layout/Sidebar';
import { authUtils } from '../../config/authUtils';
import { API_ENDPOINTS } from '../../config/config';
import { CHAT_SEND_TITLES, sendChatMessage } from '../../utils/chatSend';
import {
  CHAT_ATTACHMENT_ACCEPT,
  IMAGE_TYPES,
  buildAttachmentForm,
  describeChatUploadError,
  isAttachmentMessage,
  mergeMessages,
  newClientMessageId,
  uploadChatAttachment,
  validateChatFile,
} from '../../utils/chatAttachments';
import {
  AttachmentContent,
  AttachmentLightbox,
  ComposerAttachmentPreview,
} from '../../components/chat/ChatAttachment';
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

const WARNING_NOTICES = new Set(['uncertain', 'warning']);

const ChatsPage = () => {
  const [equipes, setEquipes] = useState([]);
  const [selectedEquipe, setSelectedEquipe] = useState(null);
  const [messages, setMessages] = useState([]);
  const [novaMensagem, setNovaMensagem] = useState('');
  const [loadingEquipes, setLoadingEquipes] = useState(true);
  const [loadingMensagens, setLoadingMensagens] = useState(false);
  const [erro, setErro] = useState('');
  const [sendNotice, setSendNotice] = useState(null);
  const [sending, setSending] = useState(false);
  // Anexo escolhido e ainda nao enviado: { file, localUrl } (localUrl so para imagem, gerada do arquivo local).
  const [draft, setDraft] = useState(null);
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState(null);
  const [lightbox, setLightbox] = useState(null);
  const [liveStatus, setLiveStatus] = useState('');

  const socketRef = useRef(null);
  const sendingRef = useRef(false);
  const endRef = useRef(null);
  const fileInputRef = useRef(null);
  const draftRef = useRef(null);
  const abortRef = useRef(null);
  const messagesRef = useRef([]);
  const selectedEquipeRef = useRef(null);
  // Ultima tentativa do anexo: repetir com o mesmo arquivo, legenda e equipe reaproveita o clientMessageId.
  const lastAttemptRef = useRef(null);
  const userId = authUtils.getUserId();

  messagesRef.current = messages;
  selectedEquipeRef.current = selectedEquipe;
  draftRef.current = draft;

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

    // Outra equipe: o anexo escolhido continua, mas como um envio novo (outro clientMessageId).
    lastAttemptRef.current = null;
    setLightbox(null);
    setMessages([]);

    const loadHistory = async () => {
      setLoadingMensagens(true);
      try {
        const res = await apiClient.get(`/equipes/${selectedEquipe}/messages`);
        // Mescla com o que ja chegou pelo socket enquanto o historico carregava, sem duplicar.
        setMessages((prev) => mergeMessages(res.data || [], prev));
      } catch (error) {
        setErro('Erro ao carregar mensagens do chat.');
      } finally {
        setLoadingMensagens(false);
      }
    };

    // Reconexao: o que chegou enquanto o socket estava fora vem pelo historico (?after=), sem duplicar.
    const syncAfterReconnect = async (equipeId) => {
      const last = [...messagesRef.current].reverse().find((message) => message?.createdAt);
      const after = last ? new Date(last.createdAt) : null;
      try {
        const res = await apiClient.get(`/equipes/${equipeId}/messages`, {
          params: after && !Number.isNaN(after.getTime()) ? { after: after.toISOString() } : undefined,
        });
        if (selectedEquipeRef.current === equipeId) {
          setMessages((prev) => mergeMessages(prev, res.data || []));
        }
      } catch (_error) {
        // Sem sincronizacao agora: a proxima reconexao ou a troca de equipe recarrega o historico.
      }
    };

    socketRef.current?.disconnect();

    const socket = createSocketConnection();
    socketRef.current = socket;
    let connectedBefore = false;

    socket.on('connect', () => {
      socket.emit('join_equipe', selectedEquipe);
      if (connectedBefore) syncAfterReconnect(selectedEquipe);
      connectedBefore = true;
    });

    socket.on('receive_message', (msg) => {
      setMessages((prev) => mergeMessages(prev, msg));
    });

    loadHistory();

    return () => {
      socket.disconnect();
    };
  }, [selectedEquipe]);

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  // Ao sair da pagina: cancela o envio em andamento e libera a miniatura local.
  useEffect(() => () => {
    abortRef.current?.abort();
    if (draftRef.current?.localUrl) URL.revokeObjectURL(draftRef.current.localUrl);
  }, []);

  const replaceDraft = useCallback((next) => {
    setDraft((current) => {
      if (current?.localUrl) URL.revokeObjectURL(current.localUrl);
      return next;
    });
    lastAttemptRef.current = null;
  }, []);

  const openFilePicker = () => {
    if (!selectedEquipe || uploading) return;
    fileInputRef.current?.click();
  };

  const onFileSelected = (event) => {
    const file = event.target.files?.[0];
    // Permite escolher o mesmo arquivo de novo depois de remove-lo.
    event.target.value = '';
    if (!file) return; // selecao cancelada: nada muda (texto e anexo anterior ficam)
    const problema = validateChatFile(file);
    if (problema) {
      setSendNotice({ status: 'error', title: problema.title, message: problema.message });
      return;
    }
    setSendNotice(null);
    replaceDraft({ file, localUrl: IMAGE_TYPES.has(file.type) ? URL.createObjectURL(file) : null });
  };

  const removeDraft = () => replaceDraft(null);

  const cancelUpload = () => abortRef.current?.abort();

  // Envio do anexo: um clientMessageId por envio; repetir o mesmo (falha, cancelamento) reaproveita o id.
  const sendAttachment = async () => {
    const equipeId = selectedEquipe;
    const { file } = draft;
    const legenda = novaMensagem.trim();
    const last = lastAttemptRef.current;
    const clientMessageId = last && last.file === file && last.legenda === legenda && last.equipeId === equipeId
      ? last.clientMessageId
      : newClientMessageId();
    lastAttemptRef.current = { clientMessageId, legenda, file, equipeId };

    const controller = new AbortController();
    abortRef.current = controller;
    sendingRef.current = true;
    setUploading(true);
    setProgress(0);
    setSendNotice(null);
    setLiveStatus(`Enviando ${file.name}.`);
    try {
      const res = await uploadChatAttachment({
        equipeId,
        form: buildAttachmentForm({ file, clientMessageId, legenda }),
        signal: controller.signal,
        onProgress: setProgress,
      });
      const message = res.data?.message;
      if (message && selectedEquipeRef.current === equipeId) {
        setMessages((prev) => mergeMessages(prev, message));
      }
      replaceDraft(null);
      setNovaMensagem('');
      setLiveStatus(`${file.name} enviado.`);
    } catch (error) {
      const aviso = describeChatUploadError(error);
      // 409: o id ja foi usado com outro conteudo; o proximo envio usa um id novo.
      if (error?.response?.status === 409) lastAttemptRef.current = null;
      setSendNotice({ status: aviso.kind, title: aviso.title, message: aviso.message });
      setLiveStatus(aviso.title);
    } finally {
      abortRef.current = null;
      sendingRef.current = false;
      setUploading(false);
      setProgress(null);
    }
  };

  // O texto so sai do campo quando o servidor confirma a gravacao; recusa ou falha mantem o rascunho.
  const handleSendMessage = async (event) => {
    event.preventDefault();
    if (!selectedEquipe || sendingRef.current) {
      return;
    }
    if (draft) {
      await sendAttachment();
      return;
    }
    const texto = novaMensagem.trim();
    if (!texto) {
      return;
    }

    sendingRef.current = true;
    setSending(true);
    setSendNotice(null);
    try {
      const result = await sendChatMessage(socketRef.current, { equipeId: selectedEquipe, texto });
      if (result.status === 'sent') {
        setNovaMensagem('');
      } else {
        setSendNotice({ status: result.status, message: result.message });
      }
    } finally {
      sendingRef.current = false;
      setSending(false);
    }
  };

  useEffect(() => {
    if (!sendNotice) return undefined;
    const timeout = setTimeout(() => setSendNotice(null), 8000);
    return () => clearTimeout(timeout);
  }, [sendNotice]);

  const showAttachmentNotice = useCallback((aviso) => {
    setSendNotice({ status: aviso.kind, title: aviso.title, message: aviso.message });
  }, []);

  const closeLightbox = useCallback(() => setLightbox(null), []);

  const busy = sending || uploading;

  return (
    <div className="chats-page">
      <Sidebar />

      <main className="chats-content">
        {sendNotice && (
          <div
            className={`chat-blocked-popup page ${WARNING_NOTICES.has(sendNotice.status) ? 'warning' : ''}`}
            role="alert"
          >
            <strong>{sendNotice.title || CHAT_SEND_TITLES[sendNotice.status] || CHAT_SEND_TITLES.error}</strong>
            <span>{sendNotice.message}</span>
            <button type="button" onClick={() => setSendNotice(null)} aria-label="Fechar aviso">x</button>
          </div>
        )}

        <div className="chats-sr-only" aria-live="polite">{liveStatus}</div>

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
                        {isAttachmentMessage(msg) ? (
                          <div className="chat-bubble chat-bubble-attachment">
                            <AttachmentContent message={msg} onOpenImage={setLightbox} onError={showAttachmentNotice} />
                          </div>
                        ) : (
                          <div className="chat-bubble">{msg.texto}</div>
                        )}
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

            <div className="chats-composer">
              {draft && (
                <ComposerAttachmentPreview
                  draft={draft}
                  progress={progress}
                  uploading={uploading}
                  onRemove={removeDraft}
                  onReplace={openFilePicker}
                  onCancel={cancelUpload}
                />
              )}
              <form className="chats-input-row" onSubmit={handleSendMessage}>
                <input
                  ref={fileInputRef}
                  type="file"
                  className="chats-file-input"
                  accept={CHAT_ATTACHMENT_ACCEPT}
                  onChange={onFileSelected}
                  tabIndex={-1}
                  aria-hidden="true"
                  data-testid="chat-file-input"
                />
                <button
                  type="button"
                  className="chats-attach-button"
                  onClick={openFilePicker}
                  disabled={!selectedEquipe || uploading}
                  aria-label="Anexar arquivo (PNG, JPG ou PDF, até 10 MB)"
                  title="Anexar arquivo"
                >
                  <FaPaperclip aria-hidden="true" />
                </button>
                <input
                  type="text"
                  value={novaMensagem}
                  onChange={(event) => setNovaMensagem(event.target.value)}
                  placeholder={draft ? 'Adicione uma legenda (opcional)...' : 'Digite sua mensagem...'}
                  aria-label={draft ? 'Legenda do arquivo' : 'Mensagem'}
                  disabled={!selectedEquipe}
                  readOnly={busy}
                  maxLength={4000}
                />
                <button type="submit" disabled={!selectedEquipe || (!draft && !novaMensagem.trim()) || busy}>
                  {busy ? 'Enviando...' : 'Enviar'}
                </button>
              </form>
            </div>
          </section>
        </div>
      </main>

      {lightbox && <AttachmentLightbox image={lightbox} onClose={closeLightbox} />}
    </div>
  );
};

export default ChatsPage;
