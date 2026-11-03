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

apiClient.interceptors.request.use(
  (config) => {
    const token = authUtils.getToken();
    if (token) {
      config.headers.Authorization = `Bearer ${token}`;
    }
    return config;
  },
  (error) => Promise.reject(error)
);

apiClient.interceptors.response.use(
  (response) => response,
  (error) => {
    if (error.response?.status === 401) {
      authUtils.clearAuthData();
      if (window.location.pathname !== '/login') {
        window.location.href = '/login';
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
