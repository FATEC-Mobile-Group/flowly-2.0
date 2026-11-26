import React, { useEffect, useState } from "react";
import { BrowserRouter as Router, Routes, Route, Navigate, useLocation } from "react-router-dom";
import { publicRoutes, adminRoutes, userRoutes } from "./config/routes";
import { authUtils } from "./config/authUtils";
import { USER_TYPES } from "./config/config";
import { ThemeProvider, useTheme } from "./config/ThemeContext";
import { lerPreferencias, usePreferencias } from "./config/preferencias";
import createSocketConnection from "./config/socketClient";
import ThemeToggle from "./components/layout/ThemeToggle";
import FloatingTimer from "./components/timer/FloatingTimer";
import ColorBendsBackground from "./components/layout/ColorBendsBackground";
import MessageToastContainer from "./components/notifications/MessageToastContainer";
import { receberNotificacao } from "./components/notifications/notificationStore";
import "./styles/common/App.css";

// Home de cada papel. Sem sessao, ou com papel desconhecido, vai para o login (rota publica, sem loop).
const homeDoUsuario = () => {
  if (!authUtils.isAuthenticated()) return "/";
  const userType = authUtils.getUserType();
  if (userType === USER_TYPES.ADMIN) return "/admin";
  if (userType === USER_TYPES.USER) return "/dashboard";
  return "/";
};

/**
 * Componente para renderizar rotas protegidas.
 * Fica fora do AppContent: definido la dentro, virava um tipo novo a cada render (ex.: toast de chat)
 * e o React remontava a pagina inteira.
 */
const ProtectedRoute = ({ element, requiredRole }) => {
  const isAuthenticated = authUtils.isAuthenticated();
  const userType = authUtils.getUserType();
  const userId = authUtils.getUserId();
  const { sincronizarConta } = useTheme();
  const { fundoAnimado } = usePreferencias();

  // Login de outra conta sem recarregar: aparencia (tema e paleta) da conta atual.
  useEffect(() => {
    if (isAuthenticated) sincronizarConta();
  }, [isAuthenticated, userId, sincronizarConta]);

  if (!isAuthenticated) {
    return <Navigate to="/" replace />;
  }

  // Papel errado mantem a sessao e leva para a home do papel real.
  if (requiredRole && userType !== requiredRole) {
    return <Navigate to={homeDoUsuario()} replace />;
  }

  return (
    <>
      {/* Fundo animado desligado: o componente sai da arvore (as animacoes param) e fica um fundo estatico com as
          cores do tema. Mesma posicao no fragmento: a pagina, o seletor e o timer nao sao remontados. */}
      {fundoAnimado ? <ColorBendsBackground /> : <div className="fundo-estatico" aria-hidden="true" data-testid="fundo-estatico" />}
      <ThemeToggle />
      {element}
      {/* O timer usa /tarefas/minhas, exclusivo de user; admin nao tem tarefas e receberia 403. */}
      {userType === USER_TYPES.USER && <FloatingTimer />}
    </>
  );
};

function App() {
  return (
    <ThemeProvider>
      <Router>
        <AppContent />
      </Router>
    </ThemeProvider>
  );
}

function AppContent() {
  const [messageToasts, setMessageToasts] = useState([]);
  const location = useLocation();

  useEffect(() => {
    const token = authUtils.getToken();
    const userId = authUtils.getUserId();

    if (!token) {
      setMessageToasts([]);
      return undefined;
    }

    if (!userId) {
      return undefined;
    }

    const socket = createSocketConnection();
    const joinUserRoom = () => {
      socket.emit('join_user', userId);
    };

    socket.on('connect', joinUserRoom);

    if (socket.connected) {
      joinUserRoom();
    }

    socket.on('notification_created', (notification) => {
      // Contador compartilhado e central; repeticao do mesmo _id (reconexao) nao conta nem gera outro aviso.
      if (!receberNotificacao(notification)) return;
      if (notification?.tipo !== 'chat') return;
      // Preferencia "Avisos de novas mensagens": so o toast deixa de aparecer; contador e central seguem acima.
      if (!lerPreferencias().toastsMensagens) return;

      const toastId = notification._id || `${Date.now()}-${Math.random()}`;
      setMessageToasts((current) => [...current, { ...notification, toastId }].slice(-4));

      setTimeout(() => {
        setMessageToasts((current) => current.filter((toast) => toast.toastId !== toastId));
      }, 2000);
    });

    return () => {
      socket.disconnect();
    };
  }, [location.pathname]);

  return (
    <>
      <MessageToastContainer toasts={messageToasts} />
      <Routes>
        {/* Rotas públicas */}
        {publicRoutes.map((route) => (
          <Route key={route.path} path={route.path} element={route.element} />
        ))}

        {/* Rotas protegidas de admin */}
        {adminRoutes.map((route) => (
          <Route
            key={route.path}
            path={route.path}
            element={
              <ProtectedRoute
                element={route.element}
                requiredRole={route.requiredRole}
              />
            }
          />
        ))}

        {/* Rotas protegidas de usuário comum */}
        {userRoutes.map((route) => (
          <Route
            key={route.path}
            path={route.path}
            element={
              <ProtectedRoute
                element={route.element}
                requiredRole={route.requiredRole}
              />
            }
          />
        ))}

        {/* Rota padrão para URLs não encontradas */}
        <Route path="*" element={<Navigate to={homeDoUsuario()} replace />} />
      </Routes>
    </>
  );
}

export default App;
