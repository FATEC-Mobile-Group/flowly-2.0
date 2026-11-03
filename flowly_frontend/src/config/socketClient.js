import io from 'socket.io-client';
import { authUtils } from './authUtils';

const isLocalHost =
  typeof window !== 'undefined' &&
  ['localhost', '127.0.0.1'].includes(window.location.hostname);

const normalizePublicApiUrl = (url = '') =>
  url.trim().replace(/\/+$/, '').replace(/\/api$/, '');

const SOCKET_URL =
  normalizePublicApiUrl(import.meta.env.VITE_SOCKET_URL || '') ||
  normalizePublicApiUrl(import.meta.env.VITE_API_PUBLIC_URL || '') ||
  normalizePublicApiUrl(import.meta.env.VITE_API_URL || '') ||
  (isLocalHost ? 'http://localhost:5000' : '');

if (!SOCKET_URL) {
  throw new Error('VITE_SOCKET_URL precisa ser configurada para o frontend de producao.');
}

export const createSocketConnection = () => {
  const token = authUtils.getToken();

  const socket = io(SOCKET_URL, {
    auth: {
      token,
    },
    reconnection: true,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 5000,
    reconnectionAttempts: 5,
  });

  socket.on('connect', () => {
    console.log('Socket conectado:', socket.id);
  });

  socket.on('disconnect', () => {
    console.log('Socket desconectado');
  });

  socket.on('connect_error', (error) => {
    console.error('Erro ao conectar socket:', error);
  });

  return socket;
};

export const getSocketUrl = () => SOCKET_URL;

export default createSocketConnection;
