/**
 * Configurações da aplicação frontend
 */

const API_BASE_URL = process.env.REACT_APP_API_URL || 'http://localhost:5000/api';

export const API_ENDPOINTS = {
  // Auth
  LOGIN: `${API_BASE_URL}/auth/login`,
  REGISTER: `${API_BASE_URL}/auth/registrar`,
  LIST_USERS: `${API_BASE_URL}/users`,

  // Tarefas
  TAREFAS: `${API_BASE_URL}/tarefas`,
  TAREFAS_BY_ID: (id) => `${API_BASE_URL}/tarefas/${id}`,
  CREATE_TAREFA: `${API_BASE_URL}/tarefas`,
  UPDATE_TAREFA: (id) => `${API_BASE_URL}/tarefas/${id}`,
  DELETE_TAREFA: (id) => `${API_BASE_URL}/tarefas/${id}`,

  // Equipes
  EQUIPES: `${API_BASE_URL}/equipes`,
  MINHAS_EQUIPES: `${API_BASE_URL}/equipes/minhas`,
  EQUIPES_BY_ID: (id) => `${API_BASE_URL}/equipes/${id}`,
  CREATE_EQUIPE: `${API_BASE_URL}/equipes`,
  UPDATE_EQUIPE: (id) => `${API_BASE_URL}/equipes/${id}`,
  DELETE_EQUIPE: (id) => `${API_BASE_URL}/equipes/${id}`,
  EQUIPE_MEMBROS: (id) => `${API_BASE_URL}/equipes/${id}/membros`,

  // Admin
  ADMIN: `${API_BASE_URL}/admin`,

  // Notificações
  NOTIFICATIONS: `${API_BASE_URL}/notificacoes`,
  NOTIFICATIONS_COUNT: `${API_BASE_URL}/notificacoes/count`,
  NOTIFICATIONS_MARK_ALL_READ: `${API_BASE_URL}/notificacoes/mark-all-read`,
  NOTIFICATIONS_MARK_READ: (id) => `${API_BASE_URL}/notificacoes/${id}/read`,

  // Users
  USERS: `${API_BASE_URL}/users`,
  USER_ME: `${API_BASE_URL}/users/me`,
  USER_ME_PASSWORD: `${API_BASE_URL}/users/me/password`,
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

export default {
  API_ENDPOINTS,
  LOCAL_STORAGE_KEYS,
  USER_TYPES,
};
