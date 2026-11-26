import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  FaArrowDown, FaBell, FaChevronDown, FaChevronUp, FaPaperclip, FaSearch, FaTimes, FaUsers,
} from 'react-icons/fa';
import { Link, useInRouterContext, useLocation, useNavigate } from 'react-router-dom';
import createSocketConnection from '../../config/socketClient';
import apiClient, { getFullApiUrl } from '../../config/apiClient';
import Sidebar from '../../components/layout/Sidebar';
import { useFotoPerfil } from '../../components/layout/useFotoPerfil';
import { useNaoLidas } from '../../components/notifications/notificationStore';
import { authUtils } from '../../config/authUtils';
import { API_ENDPOINTS } from '../../config/config';
import { CHAT_SEND_TITLES, sendChatMessage } from '../../utils/chatSend';
import { validObjectId } from '../../utils/navigationRequests';
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
import { chaveDiaLocal } from '../dashboard/painelGeralUtils';
import {
  LIMITE_PAGINA_MENSAGENS,
  buscarMensagens,
  chaveDaMensagem,
  filtrarEquipesDoChat,
  formatarDataHora,
  formatarHora,
  idDaEquipeDaMensagem,
  idDoAutor,
  montarLinhaDoTempo,
  trechosDestacados,
} from './chatsUtils';
import '../../styles/pages/dashboard/DashboardGeral.css';
import '../../styles/pages/common/ChatsPage.css';

const WARNING_NOTICES = new Set(['uncertain', 'warning']);
// Distancia do fim (px) em que a conversa ainda conta como "no fim": mensagem nova rola sozinha.
const PERTO_DO_FIM_PX = 120;
const ALTURA_MAXIMA_CAMPO_PX = 160;

const getInitials = (name = 'Usuario') =>
  String(name || 'Usuario')
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0])
    .join('')
    .toUpperCase();

const TextoDestacado = ({ texto, busca }) => (
  trechosDestacados(texto, busca).map((trecho, indice) => (trecho.destaque
    // eslint-disable-next-line react/no-array-index-key
    ? <mark key={indice} className="chat-destaque">{trecho.texto}</mark>
    // eslint-disable-next-line react/no-array-index-key
    : <React.Fragment key={indice}>{trecho.texto}</React.Fragment>))
);

// requestedEquipeId: equipe pedida por outra tela (notificacao, Minhas Equipes) via state do React Router.
// So e atendida se estiver nas equipes autorizadas carregadas da API, uma unica vez (depois vale a escolha manual).
const ChatsPageContent = ({ requestedEquipeId = null, onRequestHandled }) => {
  const [equipes, setEquipes] = useState([]);
  const [selectedEquipe, setSelectedEquipe] = useState(null);
  const [messages, setMessages] = useState([]);
  const [novaMensagem, setNovaMensagem] = useState('');
  const [loadingEquipes, setLoadingEquipes] = useState(true);
  const [erroEquipes, setErroEquipes] = useState(false);
  const [loadingMensagens, setLoadingMensagens] = useState(false);
  const [erroMensagens, setErroMensagens] = useState(false);
  const [tentativaHistorico, setTentativaHistorico] = useState(0);
  const [temAnteriores, setTemAnteriores] = useState(false);
  const [carregandoAnteriores, setCarregandoAnteriores] = useState(false);
  const [erroAnteriores, setErroAnteriores] = useState(false);
  const [sendNotice, setSendNotice] = useState(null);
  const [sending, setSending] = useState(false);
  // Anexo escolhido e ainda nao enviado: { file, localUrl } (localUrl so para imagem, gerada do arquivo local).
  const [draft, setDraft] = useState(null);
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState(null);
  const [lightbox, setLightbox] = useState(null);
  const [liveStatus, setLiveStatus] = useState('');
  const [buscaEquipes, setBuscaEquipes] = useState('');
  const [buscaAberta, setBuscaAberta] = useState(false);
  const [buscaMensagens, setBuscaMensagens] = useState('');
  const [indiceResultado, setIndiceResultado] = useState(0);
  const [participantesAbertos, setParticipantesAbertos] = useState(false);
  const [longeDoFim, setLongeDoFim] = useState(false);
  const [temNovas, setTemNovas] = useState(false);
  // Estado real do socket desta conversa: so "reconectando" e exibido (depois de uma queda).
  const [conexao, setConexao] = useState('conectando');

  const socketRef = useRef(null);
  const sendingRef = useRef(false);
  const endRef = useRef(null);
  const listRef = useRef(null);
  const textareaRef = useRef(null);
  const fileInputRef = useRef(null);
  const draftRef = useRef(null);
  const abortRef = useRef(null);
  const messagesRef = useRef([]);
  const selectedEquipeRef = useRef(null);
  const novaMensagemRef = useRef('');
  // Rascunhos de texto por equipe, so em memoria enquanto a pagina esta aberta (nunca no localStorage).
  const rascunhosRef = useRef(new Map());
  const carregandoAnterioresRef = useRef(false);
  // Pedido de "anteriores": posicao da rolagem antes de inserir no topo, para nao deslocar a leitura.
  const ancoraAnterioresRef = useRef(null);
  const ultimaChaveRef = useRef(null);
  const rolarParaFimRef = useRef(true);
  const pertoDoFimRef = useRef(true);
  // Ultima tentativa do anexo: repetir com o mesmo arquivo, legenda e equipe reaproveita o clientMessageId.
  const lastAttemptRef = useRef(null);
  const requestedEquipeRef = useRef(
    requestedEquipeId == null ? null : (validObjectId(String(requestedEquipeId)) || 'invalida'),
  );
  const userId = authUtils.getUserId();
  const emRoteador = useInRouterContext();
  const naoLidas = useNaoLidas() ?? 0;
  const { fotoUrl, aoFalharFoto } = useFotoPerfil();
  const nomeUsuario = localStorage.getItem('nome') || 'Usuário';

  messagesRef.current = messages;
  selectedEquipeRef.current = selectedEquipe;
  draftRef.current = draft;
  novaMensagemRef.current = novaMensagem;

  // URLs de foto que ja falharam (assinatura expirada, arquivo ausente): as linhas com a mesma URL
  // passam direto para as iniciais, sem nova requisicao. So o carregamento seguinte do historico traz URLs novas.
  const [fotosComFalha, setFotosComFalha] = useState(() => new Set());
  const marcarFotoComFalha = useCallback((src) => {
    setFotosComFalha((prev) => (prev.has(src) ? prev : new Set(prev).add(src)));
  }, []);

  const renderAvatar = (user, className = 'chat-avatar', ocultoParaLeitor = false) => {
    const photo = typeof user?.fotoPerfil === 'string' ? user.fotoPerfil.trim() : '';
    const name = user?.nome || 'Usuario';
    const src = photo ? getFullApiUrl(photo) : '';
    const usarFoto = src && !fotosComFalha.has(src);

    return (
      <div className={className} aria-label={name} aria-hidden={ocultoParaLeitor || undefined} title={name}>
        {usarFoto
          ? <img src={src} alt="" onError={() => marcarFotoComFalha(src)} />
          : <span>{getInitials(name)}</span>}
      </div>
    );
  };

  const equipeAtiva = useMemo(
    () => equipes.find((equipe) => equipe._id === selectedEquipe) || null,
    [equipes, selectedEquipe],
  );

  const fetchEquipes = useCallback(async () => {
    try {
      setLoadingEquipes(true);
      setErroEquipes(false);
      const res = await apiClient.get(API_ENDPOINTS.MINHAS_EQUIPES);
      const lista = Array.isArray(res.data) ? res.data : [];
      setEquipes(lista);
      const pedida = requestedEquipeRef.current;
      requestedEquipeRef.current = null;
      const autorizada = pedida ? lista.find((equipe) => equipe._id === pedida) : null;
      if (autorizada) {
        setSelectedEquipe(autorizada._id);
      } else if (lista.length > 0) {
        setSelectedEquipe((atual) => (atual && lista.some((equipe) => equipe._id === atual) ? atual : lista[0]._id));
      }
      if (pedida && !autorizada) {
        setSendNotice({
          status: 'warning',
          title: 'Conversa indisponível',
          message: 'A equipe solicitada não está entre as suas conversas.',
        });
      }
      if (pedida) onRequestHandled?.();
    } catch (err) {
      setErroEquipes(true);
      requestedEquipeRef.current = null;
    } finally {
      setLoadingEquipes(false);
    }
  }, [onRequestHandled]);

  useEffect(() => {
    fetchEquipes();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Troca de conversa: guarda o rascunho da atual e traz o da escolhida (texto digitado nunca vai para outra equipe).
  const selecionarEquipe = (equipeId) => {
    if (equipeId === selectedEquipeRef.current) return;
    const atual = selectedEquipeRef.current;
    if (atual) {
      if (novaMensagemRef.current) rascunhosRef.current.set(atual, novaMensagemRef.current);
      else rascunhosRef.current.delete(atual);
    }
    setNovaMensagem(rascunhosRef.current.get(equipeId) || '');
    setSelectedEquipe(equipeId);
  };

  useEffect(() => {
    if (!selectedEquipe) {
      return undefined;
    }
    const equipeId = selectedEquipe;
    // Tudo o que chega depois da troca (historico atrasado, socket antigo) e descartado por este marcador.
    let ativo = true;

    // Outra equipe: o anexo escolhido continua, mas como um envio novo (outro clientMessageId).
    lastAttemptRef.current = null;
    setLightbox(null);
    setMessages([]);
    setTemAnteriores(false);
    setErroAnteriores(false);
    setErroMensagens(false);
    setBuscaMensagens('');
    setIndiceResultado(0);
    setParticipantesAbertos(false);
    setTemNovas(false);
    setLongeDoFim(false);
    setConexao('conectando');
    ultimaChaveRef.current = null;
    rolarParaFimRef.current = true;
    pertoDoFimRef.current = true;
    ancoraAnterioresRef.current = null;

    // Ultimas mensagens (paginacao do backend: limit). As anteriores vem sob demanda (before).
    const loadHistory = async () => {
      setLoadingMensagens(true);
      try {
        const res = await apiClient.get(`/equipes/${equipeId}/messages`, { params: { limit: LIMITE_PAGINA_MENSAGENS } });
        if (!ativo) return;
        const lista = Array.isArray(res.data) ? res.data : [];
        // Mescla com o que ja chegou pelo socket enquanto o historico carregava, sem duplicar.
        setMessages((prev) => mergeMessages(lista, prev));
        setTemAnteriores(lista.length >= LIMITE_PAGINA_MENSAGENS);
      } catch (error) {
        if (ativo) setErroMensagens(true);
      } finally {
        if (ativo) setLoadingMensagens(false);
      }
    };

    // Reconexao: o que chegou enquanto o socket estava fora vem pelo historico (?after=), sem duplicar.
    const syncAfterReconnect = async () => {
      const last = [...messagesRef.current].reverse().find((message) => message?.createdAt);
      const after = last ? new Date(last.createdAt) : null;
      try {
        const res = await apiClient.get(`/equipes/${equipeId}/messages`, {
          params: after && !Number.isNaN(after.getTime()) ? { after: after.toISOString() } : undefined,
        });
        if (ativo && selectedEquipeRef.current === equipeId) {
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
      if (!ativo) return;
      socket.emit('join_equipe', equipeId);
      if (connectedBefore) syncAfterReconnect();
      connectedBefore = true;
      setConexao('conectado');
    });

    socket.on('disconnect', () => {
      if (ativo && connectedBefore) setConexao('reconectando');
    });

    socket.on('receive_message', (msg) => {
      if (!ativo) return;
      // Mensagem de outra equipe (sala antiga durante a troca) nunca entra nesta conversa.
      const equipeDaMensagem = idDaEquipeDaMensagem(msg);
      if (equipeDaMensagem && equipeDaMensagem !== String(equipeId)) return;
      setMessages((prev) => mergeMessages(prev, msg));
    });

    loadHistory();

    return () => {
      ativo = false;
      socket.disconnect();
    };
  }, [selectedEquipe, tentativaHistorico]);

  // Mensagens antigas: uma pagina por vez, pela mais antiga carregada (before). Sem rolar a leitura.
  const carregarAnteriores = async () => {
    if (carregandoAnterioresRef.current || !temAnteriores) return;
    const equipeId = selectedEquipe;
    const primeira = messagesRef.current.find((message) => Number.isFinite(new Date(message?.createdAt).getTime()));
    if (!equipeId || !primeira) return;
    carregandoAnterioresRef.current = true;
    setCarregandoAnteriores(true);
    setErroAnteriores(false);
    try {
      const res = await apiClient.get(`/equipes/${equipeId}/messages`, {
        params: { limit: LIMITE_PAGINA_MENSAGENS, before: new Date(primeira.createdAt).toISOString() },
      });
      if (selectedEquipeRef.current !== equipeId) return;
      const pagina = Array.isArray(res.data) ? res.data : [];
      const lista = listRef.current;
      ancoraAnterioresRef.current = lista ? { altura: lista.scrollHeight, topo: lista.scrollTop } : null;
      setMessages((prev) => mergeMessages(pagina, prev));
      setTemAnteriores(pagina.length >= LIMITE_PAGINA_MENSAGENS);
    } catch (_error) {
      if (selectedEquipeRef.current === equipeId) setErroAnteriores(true);
    } finally {
      carregandoAnterioresRef.current = false;
      setCarregandoAnteriores(false);
    }
  };

  const rolarParaFim = useCallback(() => {
    endRef.current?.scrollIntoView?.({ block: 'end' });
    pertoDoFimRef.current = true;
    setLongeDoFim(false);
    setTemNovas(false);
  }, []);

  // Rolagem: anteriores mantem a posicao; mensagem nova so rola se a pessoa estiver no fim (ou se for dela).
  useLayoutEffect(() => {
    const lista = listRef.current;
    if (ancoraAnterioresRef.current && lista) {
      const { altura, topo } = ancoraAnterioresRef.current;
      lista.scrollTop = lista.scrollHeight - altura + topo;
      ancoraAnterioresRef.current = null;
      return;
    }
    const ultima = messages[messages.length - 1];
    const chave = ultima ? chaveDaMensagem(ultima, messages.length - 1) : null;
    if (chave === ultimaChaveRef.current) return;
    const anterior = ultimaChaveRef.current;
    ultimaChaveRef.current = chave;
    if (!chave) return;
    if (rolarParaFimRef.current || pertoDoFimRef.current || idDoAutor(ultima) === String(userId)) {
      rolarParaFimRef.current = false;
      rolarParaFim();
    } else if (anterior !== null) {
      setTemNovas(true);
    }
  }, [messages, rolarParaFim, userId]);

  const aoRolar = () => {
    const lista = listRef.current;
    if (!lista) return;
    const perto = lista.scrollHeight - lista.scrollTop - lista.clientHeight <= PERTO_DO_FIM_PX;
    pertoDoFimRef.current = perto;
    setLongeDoFim(!perto);
    if (perto) setTemNovas(false);
  };

  // Campo com altura automatica, ate o limite (depois rola por dentro).
  useLayoutEffect(() => {
    const campo = textareaRef.current;
    if (!campo) return;
    campo.style.height = 'auto';
    campo.style.height = `${Math.min(campo.scrollHeight, ALTURA_MAXIMA_CAMPO_PX)}px`;
  }, [novaMensagem]);

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

  // Texto enviado com sucesso: sai do campo so se a conversa ainda for a mesma; senao, sai do rascunho dela.
  const limparTextoEnviado = (equipeId, texto) => {
    if (selectedEquipeRef.current === equipeId) setNovaMensagem('');
    else if ((rascunhosRef.current.get(equipeId) || '').trim() === texto) rascunhosRef.current.delete(equipeId);
  };

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
      limparTextoEnviado(equipeId, legenda);
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
    event?.preventDefault?.();
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
    const equipeId = selectedEquipe;

    sendingRef.current = true;
    setSending(true);
    setSendNotice(null);
    setLiveStatus('Enviando mensagem.');
    try {
      const result = await sendChatMessage(socketRef.current, { equipeId, texto });
      if (result.status === 'sent') {
        limparTextoEnviado(equipeId, texto);
        setLiveStatus('Mensagem enviada.');
      } else {
        // Bloqueada ou falha: nada aparece como enviado e o texto continua com a equipe em que foi escrito.
        setSendNotice({ status: result.status, message: result.message });
        setLiveStatus(CHAT_SEND_TITLES[result.status] || CHAT_SEND_TITLES.error);
      }
    } finally {
      sendingRef.current = false;
      setSending(false);
    }
  };

  // Enter envia; Shift+Enter quebra a linha; durante a composicao (IME) o Enter confirma a palavra.
  const aoTeclarNoCampo = (event) => {
    if (event.key !== 'Enter' || event.shiftKey) return;
    if (event.nativeEvent?.isComposing || event.keyCode === 229) return;
    event.preventDefault();
    handleSendMessage();
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

  // Pesquisa nas mensagens carregadas: destaca e navega, sem esconder nada da conversa.
  const resultados = useMemo(() => buscarMensagens(messages, buscaMensagens), [messages, buscaMensagens]);
  const indiceSeguro = resultados.length ? Math.min(indiceResultado, resultados.length - 1) : 0;
  const resultadoAtual = resultados.length ? resultados[indiceSeguro] : null;

  useEffect(() => {
    if (!resultadoAtual) return;
    const alvo = listRef.current?.querySelector(`[data-chave="${resultadoAtual}"]`);
    alvo?.scrollIntoView?.({ block: 'center' });
  }, [resultadoAtual]);

  const irParaResultado = (passo) => {
    if (!resultados.length) return;
    setIndiceResultado((atual) => (Math.min(atual, resultados.length - 1) + passo + resultados.length) % resultados.length);
  };

  const fecharBusca = () => {
    setBuscaAberta(false);
    setBuscaMensagens('');
    setIndiceResultado(0);
  };

  const aoTeclarNaBusca = (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      irParaResultado(event.shiftKey ? -1 : 1);
    } else if (event.key === 'Escape') {
      fecharBusca();
    }
  };

  const busy = sending || uploading;
  const hoje = chaveDiaLocal(new Date());
  const linhaDoTempo = useMemo(() => montarLinhaDoTempo(messages, hoje), [messages, hoje]);
  const equipesVisiveis = useMemo(() => filtrarEquipesDoChat(equipes, buscaEquipes), [equipes, buscaEquipes]);
  const membros = Array.isArray(equipeAtiva?.membros) ? equipeAtiva.membros.filter((membro) => membro && typeof membro === 'object') : [];
  const totalMembros = Array.isArray(equipeAtiva?.membros) ? equipeAtiva.membros.length : 0;
  const buscando = buscaMensagens.trim() !== '';
  let posicaoMensagem = -1;

  return (
    <div className="chats-page">
      <Sidebar />

      <main className="chats-content chats-pagina">
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

        <header className="chats-header">
          <div className="chats-header-titulo">
            <h2>Chats</h2>
            <p>Converse com os membros das equipes em um lugar unificado.</p>
          </div>
          <div className="header-profile">
            {/* Fora de um roteador (testes antigos) o sino vira um link comum. */}
            {emRoteador ? (
              <Link to="/notificacoes" className="notification-bell" aria-label="Ver notificações">
                <FaBell />
                {naoLidas > 0 && <span className="notification-badge">{naoLidas}</span>}
              </Link>
            ) : (
              <a href="/notificacoes" className="notification-bell" aria-label="Ver notificações">
                <FaBell />
                {naoLidas > 0 && <span className="notification-badge">{naoLidas}</span>}
              </a>
            )}
            <div className="profile-info">
              <div className="avatar">
                {fotoUrl ? (
                  <img src={fotoUrl} alt="Foto de perfil" className="avatar-img" onError={aoFalharFoto} />
                ) : (
                  nomeUsuario.charAt(0).toUpperCase()
                )}
              </div>
              <span>{nomeUsuario}</span>
            </div>
          </div>
        </header>

        <div className="chats-layout">
          <aside className="chats-teams-panel" aria-label="Conversas">
            <div className="chats-teams-topo">
              <h3>Equipes</h3>
              {!loadingEquipes && !erroEquipes && equipes.length > 0 && (
                <span className="chats-contagem">{equipes.length}</span>
              )}
            </div>
            {equipes.length > 1 && (
              <label className="chats-busca-equipes">
                <FaSearch aria-hidden="true" />
                <span className="chats-sr-only">Pesquisar equipe</span>
                <input
                  type="search"
                  value={buscaEquipes}
                  onChange={(event) => setBuscaEquipes(event.target.value)}
                  placeholder="Pesquisar equipe"
                  maxLength={200}
                  autoComplete="off"
                />
              </label>
            )}
            {loadingEquipes ? (
              <p className="chats-estado" role="status">Carregando equipes...</p>
            ) : erroEquipes ? (
              <div className="chats-estado chats-estado--erro" role="alert">
                <p>Erro ao carregar equipes de chat.</p>
                <button type="button" className="chats-botao-secundario" onClick={fetchEquipes}>Tentar novamente</button>
              </div>
            ) : equipes.length === 0 ? (
              <p className="chats-estado">Nenhuma equipe disponivel para chat. Quando você entrar em uma equipe, a conversa aparece aqui.</p>
            ) : equipesVisiveis.length === 0 ? (
              <p className="chats-estado">Nenhuma equipe encontrada.</p>
            ) : (
              <ul className="chats-team-list">
                {equipesVisiveis.map((equipe) => {
                  const ativa = equipe._id === selectedEquipe;
                  const participantes = Array.isArray(equipe.membros) ? equipe.membros : [];
                  return (
                    <li key={equipe._id}>
                      <button
                        type="button"
                        onClick={() => selecionarEquipe(equipe._id)}
                        className={ativa ? 'active' : ''}
                        aria-current={ativa ? 'true' : undefined}
                      >
                        <span className="chats-team-icone" aria-hidden="true">{getInitials(equipe.nome || 'Equipe')}</span>
                        <span className="chats-team-texto">
                          <strong>{equipe.nome}</strong>
                          <span>{participantes.length} membros</span>
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </aside>

          <section className="chats-messages-panel" aria-label={equipeAtiva ? `Conversa da equipe ${equipeAtiva.nome}` : 'Conversa'}>
            <header className="chats-room-header">
              <div className="chats-room-titulo">
                <h3>{equipeAtiva?.nome || 'Selecione uma equipe'}</h3>
                {equipeAtiva && (
                  <button
                    type="button"
                    className="chats-room-participantes"
                    onClick={() => setParticipantesAbertos((aberto) => !aberto)}
                    aria-expanded={participantesAbertos}
                  >
                    <FaUsers aria-hidden="true" />
                    <span>{`${totalMembros} ${totalMembros === 1 ? 'participante' : 'participantes'}`}</span>
                    {participantesAbertos ? <FaChevronUp aria-hidden="true" /> : <FaChevronDown aria-hidden="true" />}
                  </button>
                )}
              </div>
              {equipeAtiva && (
                <button
                  type="button"
                  className={`chats-icone-botao ${buscaAberta ? 'is-ativo' : ''}`}
                  onClick={() => (buscaAberta ? fecharBusca() : setBuscaAberta(true))}
                  aria-label={buscaAberta ? 'Fechar pesquisa nas mensagens' : 'Pesquisar nas mensagens'}
                  aria-expanded={buscaAberta}
                >
                  {buscaAberta ? <FaTimes aria-hidden="true" /> : <FaSearch aria-hidden="true" />}
                </button>
              )}
            </header>

            {participantesAbertos && membros.length > 0 && (
              <ul className="chats-participantes" aria-label="Participantes da equipe">
                {membros.map((membro) => (
                  <li key={membro._id || membro.nome}>
                    {renderAvatar(membro, 'chat-membro-avatar', true)}
                    <span>{membro.nome || 'Participante'}</span>
                  </li>
                ))}
              </ul>
            )}

            {buscaAberta && (
              <div className="chats-busca-mensagens" role="search">
                <label className="chats-busca-campo">
                  <FaSearch aria-hidden="true" />
                  <span className="chats-sr-only">Pesquisar nas mensagens carregadas</span>
                  <input
                    type="search"
                    value={buscaMensagens}
                    onChange={(event) => { setBuscaMensagens(event.target.value); setIndiceResultado(0); }}
                    onKeyDown={aoTeclarNaBusca}
                    placeholder="Pesquisar nas mensagens"
                    maxLength={200}
                    autoComplete="off"
                    // eslint-disable-next-line jsx-a11y/no-autofocus
                    autoFocus
                  />
                </label>
                <span className="chats-busca-contagem" aria-live="polite">
                  {buscando ? (resultados.length ? `${indiceSeguro + 1} de ${resultados.length}` : 'Nenhum resultado') : ''}
                </span>
                <button type="button" className="chats-icone-botao" onClick={() => irParaResultado(-1)} disabled={!resultados.length} aria-label="Resultado anterior">
                  <FaChevronUp aria-hidden="true" />
                </button>
                <button type="button" className="chats-icone-botao" onClick={() => irParaResultado(1)} disabled={!resultados.length} aria-label="Próximo resultado">
                  <FaChevronDown aria-hidden="true" />
                </button>
                <p className="chats-busca-nota">
                  {`A pesquisa abrange apenas as ${messages.length} mensagens carregadas.`}
                  {temAnteriores ? ' Carregue mensagens anteriores para pesquisar mais.' : ''}
                </p>
              </div>
            )}

            {conexao === 'reconectando' && (
              <p className="chats-conexao" role="status">Conexão com o chat interrompida. Tentando reconectar…</p>
            )}

            <div className="chats-messages-area">
              <div className="chats-messages-list" ref={listRef} onScroll={aoRolar}>
                {temAnteriores && !loadingMensagens && (
                  <div className="chats-anteriores">
                    <button type="button" className="chats-botao-secundario" onClick={carregarAnteriores} disabled={carregandoAnteriores}>
                      {carregandoAnteriores ? 'Carregando mensagens anteriores...' : 'Carregar mensagens anteriores'}
                    </button>
                    {erroAnteriores && <span role="alert">Não foi possível carregar as mensagens anteriores.</span>}
                  </div>
                )}
                {!selectedEquipe && !loadingEquipes ? (
                  <p className="chats-estado">Selecione uma equipe para ver a conversa.</p>
                ) : loadingMensagens && messages.length === 0 ? (
                  <p className="chats-estado" role="status">Carregando mensagens...</p>
                ) : erroMensagens && messages.length === 0 ? (
                  <div className="chats-estado chats-estado--erro" role="alert">
                    <p>Erro ao carregar mensagens do chat.</p>
                    <button type="button" className="chats-botao-secundario" onClick={() => setTentativaHistorico((n) => n + 1)}>
                      Tentar novamente
                    </button>
                  </div>
                ) : messages.length === 0 ? (
                  <p className="chats-estado chats-estado--vazio">Nenhuma mensagem ainda. Comece a conversa.</p>
                ) : (
                  linhaDoTempo.map((item) => {
                    if (item.tipo === 'dia') {
                      return (
                        <div key={item.chave} className="chats-separador-dia" role="separator" aria-label={item.rotulo}>
                          <span>{item.rotulo}</span>
                        </div>
                      );
                    }
                    posicaoMensagem += 1;
                    const msg = item.mensagem;
                    const chave = chaveDaMensagem(msg, posicaoMensagem);
                    const isMine = idDoAutor(msg) !== null && idDoAutor(msg) === String(userId);
                    const userName = msg.user?.nome || 'Usuario';
                    const continuacao = !item.inicioDoBloco;
                    const classes = [
                      'chat-message-row',
                      isMine ? 'mine' : 'theirs',
                      continuacao ? 'continuacao' : '',
                      item.fimDoBloco ? 'fim-do-bloco' : '',
                      buscando && resultados.includes(chave) ? 'is-resultado' : '',
                      chave === resultadoAtual ? 'is-resultado-atual' : '',
                    ].filter(Boolean).join(' ');

                    return (
                      <div key={chave} className={classes} data-chave={chave}>
                        {!isMine && renderAvatar(msg.user, 'chat-avatar', continuacao)}
                        <div className="chat-message-stack">
                          {!isMine && !continuacao && <span className="chat-author">{userName}</span>}
                          {isAttachmentMessage(msg) ? (
                            <div className="chat-bubble chat-bubble-attachment">
                              <AttachmentContent message={msg} onOpenImage={setLightbox} onError={showAttachmentNotice} />
                            </div>
                          ) : (
                            <div className="chat-bubble">
                              {buscando ? <TextoDestacado texto={msg.texto} busca={buscaMensagens} /> : msg.texto}
                            </div>
                          )}
                          {item.fimDoBloco && (
                            <time className="chat-message-time" dateTime={msg.createdAt || undefined} title={formatarDataHora(msg.createdAt)}>
                              {formatarHora(msg.createdAt)}
                            </time>
                          )}
                        </div>
                        {isMine && renderAvatar(msg.user, 'chat-avatar', continuacao)}
                      </div>
                    );
                  })
                )}
                <div ref={endRef} />
              </div>
              {(longeDoFim || temNovas) && messages.length > 0 && (
                <button type="button" className={`chats-ir-fim ${temNovas ? 'tem-novas' : ''}`} onClick={rolarParaFim}>
                  <FaArrowDown aria-hidden="true" />
                  <span>{temNovas ? 'Novas mensagens' : 'Ir para as mais recentes'}</span>
                </button>
              )}
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
                <textarea
                  ref={textareaRef}
                  rows={1}
                  value={novaMensagem}
                  onChange={(event) => setNovaMensagem(event.target.value)}
                  onKeyDown={aoTeclarNoCampo}
                  placeholder={draft ? 'Adicione uma legenda (opcional)...' : 'Digite sua mensagem...'}
                  aria-label={draft ? 'Legenda do arquivo' : 'Mensagem'}
                  aria-describedby="chats-dica-envio"
                  disabled={!selectedEquipe}
                  readOnly={busy}
                  maxLength={4000}
                />
                <button type="submit" disabled={!selectedEquipe || (!draft && !novaMensagem.trim()) || busy}>
                  {busy ? 'Enviando...' : 'Enviar'}
                </button>
              </form>
              <p id="chats-dica-envio" className="chats-dica">Enter envia · Shift+Enter quebra a linha</p>
            </div>
          </section>
        </div>
      </main>

      {lightbox && <AttachmentLightbox image={lightbox} onClose={closeLightbox} />}
    </div>
  );
};

function ChatsPageInRouter() {
  const location = useLocation();
  const navigate = useNavigate();
  const requested = location.state?.equipeId ?? null;
  // Consome o pedido: voltar ou recarregar nao repete a selecao.
  const handled = useCallback(() => {
    navigate(location.pathname, { replace: true, state: null });
  }, [navigate, location.pathname]);
  return <ChatsPageContent requestedEquipeId={requested} onRequestHandled={handled} />;
}

// Fora de um roteador (testes antigos), a pagina funciona como antes, sem pedido de equipe.
const ChatsPage = () => (useInRouterContext() ? <ChatsPageInRouter /> : <ChatsPageContent />);

export default ChatsPage;
