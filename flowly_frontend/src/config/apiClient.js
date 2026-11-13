import axios from 'axios';
import { authUtils } from './authUtils';

const isLocalHost =
  typeof window !== 'undefined' &&
  ['localhost', '127.0.0.1'].includes(window.location.hostname);

const normalizePublicApiUrl = (url = '') =>
  url.trim().replace(/\/+$/, '').replace(/\/api$/, '');

const API_BASE_URL =
  (import.meta.env.VITE_API_URL || '').trim() ||
  (isLocalHost ? 'http://localhost:5000/api' : '');

if (!API_BASE_URL) {
  throw new Error('VITE_API_URL precisa ser configurada para o frontend de producao.');
}

const API_PUBLIC_URL =
  normalizePublicApiUrl(import.meta.env.VITE_API_PUBLIC_URL || '') ||
  normalizePublicApiUrl(API_BASE_URL) ||
  (isLocalHost ? 'http://localhost:5000' : '');

const apiClient = axios.create({
  baseURL: API_BASE_URL,
  timeout: 30000,
});

const LOGIN_ROUTE = '/';

// So o 401 de uma requisicao que levou o JWT ainda guardado indica sessao invalida.
// Login, 2FA, face pre-login e requisicoes de um token antigo seguem como erro comum.
const sentCurrentToken = (config) => {
  const token = authUtils.getToken();
  return Boolean(token) && config?.headers?.Authorization === `Bearer ${token}`;
};

apiClient.interceptors.request.use(
  (config) => {
    const token = authUtils.getToken();
    // skipAuthToken: fluxos pre-login nao usam o JWT, mesmo que haja um token antigo guardado.
    if (token && !config.skipAuthToken) {
      config.headers.Authorization = `Bearer ${token}`;
    }
    return config;
  },
  (error) => Promise.reject(error)
);

apiClient.interceptors.response.use(
  (response) => response,
  (error) => {
    if (error.response?.status === 401 && sentCurrentToken(error.config)) {
      authUtils.clearAuthData();
      if (window.location.pathname !== LOGIN_ROUTE) {
        window.location.href = LOGIN_ROUTE;
      }
    }
    return Promise.reject(error);
  }
);

export const getFullApiUrl = (path = '') => {
  if (path.startsWith('http')) {
    return path;
  }
  return `${API_PUBLIC_URL}${path}`;
};

export const getApiPublicUrl = () => API_PUBLIC_URL;

export const getApiBaseUrl = () => API_BASE_URL;

export const FACE_API_TIMEOUT_MS = 120000;

export default apiClient;
