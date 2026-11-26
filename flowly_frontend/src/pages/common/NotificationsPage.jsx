import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  FaBell, FaCheckDouble, FaComments, FaExclamationCircle, FaExclamationTriangle, FaInfoCircle, FaSyncAlt, FaTasks, FaUsers,
} from 'react-icons/fa';
import apiClient from '../../config/apiClient';
import Sidebar from '../../components/layout/Sidebar';
import { useFotoPerfil } from '../../components/layout/useFotoPerfil';
import {
  ajustarNaoLidas,
  atualizarNaoLidas,
  definirNaoLidas,
  ouvirNovasNotificacoes,
  registrarIdsConhecidos,
  useNaoLidas,
} from '../../components/notifications/notificationStore';
import { API_ENDPOINTS } from '../../config/config';
import { authUtils } from '../../config/authUtils';
import { notificationTarget } from '../../utils/navigationRequests';
import { CampoBusca, CampoSelect, plural } from '../admin/FiltrosAdmin';
import { chaveDiaLocal } from '../dashboard/painelGeralUtils';
import {
  CATEGORIAS,
  CATEGORIA_ALERTA,
  FILTROS_PADRAO,
  LIMITE_LISTA_API,
  STATUS_LEITURA,
  agruparPorData,
  apresentarNotificacao,
  filtrarNotificacoes,
  formatarHorario,
  juntarPorId,
} from './notificationsUtils';
import '../../styles/pages/dashboard/DashboardGeral.css';
import '../../styles/pages/admin/DashboardAdmin.css';
import '../../styles/pages/common/NotificationsPage.css';

const ICONES = { task: FaTasks, chat: FaComments, team: FaUsers, system: FaInfoCircle };
const ICONES_ALERTA = { high: FaExclamationCircle, medium: FaExclamationTriangle, low: FaInfoCircle };

function CartaoNotificacao({ notification, userType, hoje, onOpen, onRead, marcando }) {
  const { categoria, titulo, texto, alerta } = apresentarNotificacao(notification);
  const target = notificationTarget(notification, userType);
  const Icone = alerta ? ICONES_ALERTA[alerta.gravidade?.codigo] || FaExclamationTriangle : ICONES[categoria] || FaInfoCircle;
  const lida = Boolean(notification.lida);
  return (
    <article
      className={`notification-card notificacao-card notificacao-card--${categoria} ${lida ? 'read' : 'unread'}`}
      data-gravidade={alerta?.gravidade?.codigo || undefined}
    >
      <span className="notificacao-icone" aria-hidden="true"><Icone /></span>
      <div className="notificacao-corpo">
        <div className="notification-card-top">
          <span className={`notification-type type-${notification.tipo}`}>{titulo}</span>
          {alerta?.gravidade && <span className="notificacao-selo notificacao-selo--gravidade">{`Gravidade: ${alerta.gravidade.rotulo}`}</span>}
          {!lida && <span className="unread-dot" role="img" aria-label="Não lida" />}
          <time className="notificacao-hora" dateTime={notification.createdAt || undefined}>{formatarHorario(notification.createdAt, hoje)}</time>
        </div>
        <p className="notification-text">{texto}</p>
        {(target || !lida) && (
          <div className="notification-actions">
            {target && (
              <button type="button" className="open-btn" onClick={() => onOpen(notification, target)}>
                {target.label}
              </button>
            )}
            {!lida && (
              <button type="button" className="read-btn" onClick={() => onRead(notification)} disabled={marcando}>
                Marcar como lida
              </button>
            )}
          </div>
        )}
      </div>
    </article>
  );
}

const NotificationsPage = () => {
  const [notifications, setNotifications] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [error, setError] = useState('');
  const [filtros, setFiltros] = useState(FILTROS_PADRAO);
  const [marcandoTodas, setMarcandoTodas] = useState(false);
  const [marcandoIds, setMarcandoIds] = useState(() => new Set());
  const navigate = useNavigate();
  // Uma marcacao por notificacao por vez (clique duplo em "Abrir" nao repete o PUT).
  const markingRef = useRef(new Set());
  const markingAllRef = useRef(false);
  const carregamento = useRef(null);
  // Recebidas pelo socket enquanto a lista carrega: entram junto com a resposta, sem duplicar.
  const recebidasDuranteCarga = useRef([]);
  const userType = authUtils.getUserType();
  const isAdmin = userType === 'admin';
  const naoLidasGlobal = useNaoLidas();
  const nome = localStorage.getItem('nome') || (isAdmin ? 'Admin Flowly' : 'Colaborador');
  const { fotoUrl, aoFalharFoto } = useFotoPerfil();

  const fetchNotifications = useCallback(async () => {
    carregamento.current?.abort();
    const controle = new AbortController();
    carregamento.current = controle;
    recebidasDuranteCarga.current = [];
    try {
      setLoading(true);
      setLoadError(false);
      const res = await apiClient.get(API_ENDPOINTS.NOTIFICATIONS, { signal: controle.signal });
      if (controle.signal.aborted) return;
      if (!Array.isArray(res?.data)) throw new Error('Resposta inesperada');
      registrarIdsConhecidos(res.data);
      setNotifications(juntarPorId(recebidasDuranteCarga.current, res.data));
    } catch (err) {
      if (controle.signal.aborted) return;
      setLoadError(true);
    } finally {
      if (carregamento.current === controle) {
        carregamento.current = null;
        setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    fetchNotifications();
    return () => carregamento.current?.abort();
  }, [fetchNotifications]);

  // Tempo real: o App recebe notification_created (ja sem duplicatas) e a central insere no topo.
  useEffect(() => ouvirNovasNotificacoes((nova) => {
    if (carregamento.current) recebidasDuranteCarga.current = [nova, ...recebidasDuranteCarga.current];
    setNotifications((prev) => juntarPorId([nova], prev));
  }), []);

  const atualizar = () => {
    setError('');
    fetchNotifications();
    atualizarNaoLidas();
  };

  const markAsRead = async (notification) => {
    const id = notification._id;
    if (markingRef.current.has(id)) return false;
    markingRef.current.add(id);
    setMarcandoIds((atual) => new Set(atual).add(id));
    try {
      await apiClient.put(API_ENDPOINTS.NOTIFICATIONS_MARK_READ(id), {});
      setNotifications((prev) => prev.map((item) => (item._id === id ? { ...item, lida: true } : item)));
      // So os botoes de notificacao nao lida chegam aqui (e um por vez): o contador compartilhado desce um.
      if (!notification.lida) ajustarNaoLidas(-1);
      return true;
    } catch (_) {
      setError('Erro ao marcar notificação como lida.');
      return false;
    } finally {
      markingRef.current.delete(id);
      setMarcandoIds((atual) => {
        const proximo = new Set(atual);
        proximo.delete(id);
        return proximo;
      });
    }
  };

  // Abrir: marca como lida pelo fluxo existente (falha nao vira sucesso: a notificacao continua nao lida) e navega.
  // O destino so atende o pedido se o recurso estiver na lista autorizada que ele carrega.
  const openNotification = async (notification, target) => {
    if (!notification.lida) await markAsRead(notification);
    navigate(target.to, { state: target.state });
  };

  const markAllAsRead = async () => {
    if (markingAllRef.current) return;
    markingAllRef.current = true;
    setMarcandoTodas(true);
    try {
      await apiClient.put(API_ENDPOINTS.NOTIFICATIONS_MARK_ALL_READ, {});
      setNotifications((prev) => prev.map((item) => ({ ...item, lida: true })));
      // A API marca todas do usuario (inclusive alem das 100 carregadas).
      definirNaoLidas(0);
    } catch (_) {
      setError('Erro ao marcar notificações como lidas.');
    } finally {
      markingAllRef.current = false;
      setMarcandoTodas(false);
    }
  };

  const hoje = chaveDiaLocal(new Date());
  const visiveis = useMemo(() => filtrarNotificacoes(notifications, filtros), [notifications, filtros]);
  const grupos = useMemo(() => agruparPorData(visiveis, hoje), [visiveis, hoje]);
  const naoLidasCarregadas = notifications.filter((n) => !n.lida).length;
  const alertasCarregados = notifications.filter((n) => apresentarNotificacao(n).categoria === CATEGORIA_ALERTA).length;
  const listaNoLimite = notifications.length >= LIMITE_LISTA_API;
  const naoLidas = naoLidasGlobal ?? naoLidasCarregadas;
  const filtroAtivo = Boolean(filtros.busca.trim() || filtros.status || filtros.categoria);
  const opcoesCategoria = [
    { valor: '', rotulo: 'Todas as categorias' },
    ...CATEGORIAS.filter((categoria) => !categoria.somenteAdmin || isAdmin),
  ];
  const pronto = !loading && !loadError;
  const alterar = (mudancas) => setFiltros((atuais) => ({ ...atuais, ...mudancas }));

  return (
    <div className="admin-page">
      <Sidebar />

      <main className="dashboard-geral notifications-page notificacoes-pagina">
        <header className="dashboard-header">
          <div className="painel-titulo">
            <h2>Notificações</h2>
            <p>Acompanhe as mensagens e atualizações importantes do Flowly.</p>
          </div>
          <div className="header-profile">
            <Link to="/notificacoes" className="notification-bell" aria-label="Ver notificações">
              <FaBell />
              {naoLidasGlobal > 0 && <span className="notification-badge">{naoLidasGlobal}</span>}
            </Link>
            <div className="profile-info">
              <div className="avatar">
                {fotoUrl ? (
                  <img src={fotoUrl} alt="Foto de perfil" className="avatar-img" onError={aoFalharFoto} />
                ) : (
                  nome.charAt(0).toUpperCase()
                )}
              </div>
              <span>{nome}</span>
            </div>
          </div>
        </header>

        {pronto && (
          <section className="notificacoes-indicadores" aria-label="Resumo das notificações">
            <div className="notificacoes-indicador">
              <strong>{naoLidas}</strong>
              <span>{naoLidasGlobal === null ? 'não lidas entre as carregadas' : `não ${naoLidas === 1 ? 'lida' : 'lidas'}`}</span>
            </div>
            <div className="notificacoes-indicador">
              <strong>{notifications.length}</strong>
              <span>{listaNoLimite ? `carregadas (as ${LIMITE_LISTA_API} mais recentes)` : notifications.length === 1 ? 'notificação' : 'notificações'}</span>
            </div>
            {isAdmin && (
              <div className="notificacoes-indicador notificacoes-indicador--alerta">
                <strong>{alertasCarregados}</strong>
                <span>{`${alertasCarregados === 1 ? 'alerta de moderação' : 'alertas de moderação'}${listaNoLimite ? ' entre as carregadas' : ''}`}</span>
              </div>
            )}
          </section>
        )}

        <div className="painel-filtros notificacoes-acoes">
          <button type="button" className="botao-atualizar" onClick={atualizar} disabled={loading}>
            <FaSyncAlt aria-hidden="true" className={loading ? 'girando' : undefined} />
            <span>{loading ? 'Atualizando…' : 'Atualizar'}</span>
          </button>
          <button
            type="button"
            className="mark-all-btn"
            onClick={markAllAsRead}
            disabled={marcandoTodas || !pronto || (naoLidasCarregadas === 0 && !(naoLidasGlobal > 0))}
          >
            <FaCheckDouble aria-hidden="true" />
            <span>{marcandoTodas ? 'Marcando…' : 'Marcar todas como lidas'}</span>
          </button>
        </div>

        {listaNoLimite && pronto && (
          <p className="aviso-filtro" role="status">
            {`Exibindo as ${LIMITE_LISTA_API} notificações mais recentes. O total de não lidas considera todas; pesquisa, filtros e alertas consideram só as carregadas.`}
          </p>
        )}
        {error && <div className="notifications-error" role="alert">{error}</div>}

        {loading && notifications.length === 0 ? (
          <p className="painel-status" role="status">Carregando notificações...</p>
        ) : loadError && notifications.length === 0 ? (
          <section className="glass-card painel-erro" role="alert">
            <h3>Erro ao carregar notificações.</h3>
            <p>Verifique a conexão e tente novamente.</p>
            <button type="button" className="botao-tentar" onClick={atualizar}>Tentar novamente</button>
          </section>
        ) : notifications.length === 0 ? (
          <section className="glass-card notificacoes-vazio">
            <FaBell aria-hidden="true" />
            <h3>Nenhuma notificação no momento.</h3>
            <p>Avisos de tarefas, mensagens e equipes aparecem aqui assim que chegarem.</p>
          </section>
        ) : (
          <>
            {loadError && (
              <p className="aviso-filtro" role="status">Não foi possível atualizar agora. A lista exibida pode estar desatualizada.</p>
            )}
            <section className="admin-filtros notificacoes-filtros" aria-label="Pesquisa e filtros de notificações">
              <CampoBusca
                id="notificacoes-busca"
                valor={filtros.busca}
                onChange={(valor) => alterar({ busca: valor })}
                placeholder="Conteúdo da notificação"
              />
              <div className="admin-filtros-grade notificacoes-filtros-grade">
                <CampoSelect id="notificacoes-status" rotulo="Leitura" valor={filtros.status} opcoes={STATUS_LEITURA} onChange={(valor) => alterar({ status: valor })} />
                <CampoSelect id="notificacoes-categoria" rotulo="Categoria" valor={filtros.categoria} opcoes={opcoesCategoria} onChange={(valor) => alterar({ categoria: valor })} />
              </div>
              <div className="admin-filtros-rodape">
                <p className="admin-contagem" aria-live="polite">{`Exibindo ${visiveis.length} de ${plural(notifications.length, 'notificação', 'notificações')}`}</p>
                {filtroAtivo && (
                  <button type="button" className="admin-botao-secundario" onClick={() => setFiltros(FILTROS_PADRAO)}>Limpar filtros</button>
                )}
              </div>
            </section>

            {grupos.length === 0 ? (
              <div className="teams-feedback admin-vazio">
                <p>Nenhuma notificação corresponde à pesquisa ou aos filtros aplicados.</p>
                <button type="button" className="admin-botao-secundario" onClick={() => setFiltros(FILTROS_PADRAO)}>Limpar filtros</button>
              </div>
            ) : (
              grupos.map((grupo) => (
                <section key={grupo.chave} className="notificacoes-grupo" aria-label={grupo.rotulo}>
                  <h3 className="notificacoes-grupo-titulo">{grupo.rotulo}</h3>
                  <div className="notifications-list">
                    {grupo.itens.map((notification) => (
                      <CartaoNotificacao
                        key={notification._id}
                        notification={notification}
                        userType={userType}
                        hoje={hoje}
                        onOpen={openNotification}
                        onRead={markAsRead}
                        marcando={marcandoIds.has(notification._id)}
                      />
                    ))}
                  </div>
                </section>
              ))
            )}
          </>
        )}
      </main>
    </div>
  );
};

export default NotificationsPage;
