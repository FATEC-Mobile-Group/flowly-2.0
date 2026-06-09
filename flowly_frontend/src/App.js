import React, { useEffect, useState } from "react";
import { BrowserRouter as Router, Routes, Route, Navigate, useLocation } from "react-router-dom";
import { publicRoutes, adminRoutes, userRoutes } from "./config/routes";
import { authUtils } from "./config/authUtils";
import { ThemeProvider } from "./config/ThemeContext";
import createSocketConnection from "./config/socketClient";
import ThemeToggle from "./components/layout/ThemeToggle";
import FloatingTimer from "./components/timer/FloatingTimer";
import ColorBendsBackground from "./components/layout/ColorBendsBackground";
import MessageToastContainer from "./components/notifications/MessageToastContainer";
import "./styles/common/App.css";

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
      if (notification?.tipo !== 'chat') return;

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

  /**
   * Componente para renderizar rotas protegidas
   */
  const ProtectedRoute = ({ element, requiredRole }) => {
    const isAuthenticated = authUtils.isAuthenticated();
    const userType = authUtils.getUserType();

    if (!isAuthenticated) {
      return <Navigate to="/" replace />;
    }

    if (requiredRole && userType !== requiredRole) {
      return <Navigate to="/" replace />;
    }

    return (
      <>
        <ColorBendsBackground />
        <ThemeToggle />
        {element}
        <FloatingTimer />
      </>
    );
  };

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
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </>
  );
}

export default App;
