const DEFAULT_API_BASE_URL = 'https://flowly-api-backend-646126851973.southamerica-east1.run.app/api';

const isLocalHost =
  typeof window !== 'undefined' &&
  ['localhost', '127.0.0.1'].includes(window.location.hostname);

const API_BASE_URL =
  (process.env.REACT_APP_API_URL || '').trim() ||
  (isLocalHost ? 'http://localhost:5000/api' : DEFAULT_API_BASE_URL);

const DEFAULT_ASSISTANT_URL = 'https://flowly-assistente-voz-646126851973.southamerica-east1.run.app';
const ASSISTANT_ENV_URL = (process.env.REACT_APP_ASSISTANT_URL || '').trim().replace(/\/+$/, '');
const ASSISTANT_BASE_URL =
  (isLocalHost && (!ASSISTANT_ENV_URL || ASSISTANT_ENV_URL === 'http://localhost:5000')
    ? 'http://localhost:8080'
    : ASSISTANT_ENV_URL) ||
  (isLocalHost ? 'http://localhost:8080' : DEFAULT_ASSISTANT_URL);

export const API_ENDPOINTS = {
  LOGIN: `${API_BASE_URL}/auth/login`,
  REGISTER: `${API_BASE_URL}/auth/registrar`,
  SEND_2FA: `${API_BASE_URL}/auth/2fa/enviar-codigo`,
  VALIDATE_2FA_CODE: `${API_BASE_URL}/auth/2fa/validar-codigo`,
  VALIDATE_2FA_TOKEN: `${API_BASE_URL}/auth/2fa/validar-token`,
  SEND_PASSWORD_RESET: `${API_BASE_URL}/auth/recuperar-senha/enviar-codigo`,
  VALIDATE_PASSWORD_RESET_CODE: `${API_BASE_URL}/auth/recuperar-senha/validar-codigo`,
  RESET_PASSWORD: `${API_BASE_URL}/auth/recuperar-senha/redefinir`,
  LIST_USERS: `${API_BASE_URL}/users`,

  TAREFAS: `${API_BASE_URL}/tarefas`,
  TAREFAS_BY_ID: (id) => `${API_BASE_URL}/tarefas/${id}`,
  CREATE_TAREFA: `${API_BASE_URL}/tarefas`,
  UPDATE_TAREFA: (id) => `${API_BASE_URL}/tarefas/${id}`,
  DELETE_TAREFA: (id) => `${API_BASE_URL}/tarefas/${id}`,
  TAREFAS_MINHAS: `${API_BASE_URL}/tarefas/minhas`,

  EQUIPES: `${API_BASE_URL}/equipes`,
  MINHAS_EQUIPES: `${API_BASE_URL}/equipes/minhas`,
  EQUIPES_BY_ID: (id) => `${API_BASE_URL}/equipes/${id}`,
  CREATE_EQUIPE: `${API_BASE_URL}/equipes`,
  UPDATE_EQUIPE: (id) => `${API_BASE_URL}/equipes/${id}`,
  DELETE_EQUIPE: (id) => `${API_BASE_URL}/equipes/${id}`,
  EQUIPE_MEMBROS: (id) => `${API_BASE_URL}/equipes/${id}/membros`,

  ADMIN: `${API_BASE_URL}/admin`,
  ADMIN_ASSISTANT_INSIGHTS: `${API_BASE_URL}/admin/assistant-insights`,

  NOTIFICATIONS: `${API_BASE_URL}/notificacoes`,
  NOTIFICATIONS_COUNT: `${API_BASE_URL}/notificacoes/count`,
  NOTIFICATIONS_MARK_ALL_READ: `${API_BASE_URL}/notificacoes/mark-all-read`,
  NOTIFICATIONS_MARK_READ: (id) => `${API_BASE_URL}/notificacoes/${id}/read`,

  USERS: `${API_BASE_URL}/users`,
  USER_ME: `${API_BASE_URL}/users/me`,
  USER_ME_PASSWORD: `${API_BASE_URL}/users/me/password`,

  FACE_ENROLL: `${API_BASE_URL}/face/enroll`,
  FACE_VERIFY: `${API_BASE_URL}/face/verify`,
  FACE_SKIP_ENROLLMENT: `${API_BASE_URL}/face/skip-enrollment`,
  FACE_ENROLL_PROFILE: `${API_BASE_URL}/face/enroll-profile`,
  FACE_STATUS: `${API_BASE_URL}/face/status`,
  FACE_HEALTH: `${API_BASE_URL}/face/health`,

  ASSISTANT_HEALTH: `${ASSISTANT_BASE_URL}/health`,
  ASSISTANT_COMMAND: `${ASSISTANT_BASE_URL}/api/v1/messages`,
  ASSISTANT_STANDBY: `${ASSISTANT_BASE_URL}/standby`,
};

export const LOCAL_STORAGE_KEYS = {
  TOKEN: 'token',
  USER_TYPE: 'tipo',
  USER_NAME: 'nome',
  USER_ID: 'id',
  USER_PHOTO: 'fotoPerfil',
};

export const USER_TYPES = {
  ADMIN: 'admin',
  USER: 'user',
};

const config = {
  API_ENDPOINTS,
  LOCAL_STORAGE_KEYS,
  USER_TYPES,
};

export default config;
