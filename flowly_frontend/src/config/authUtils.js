/**
 * Utilitários de autenticação para o frontend
 */

import { LOCAL_STORAGE_KEYS, USER_TYPES } from './config';

export const authUtils = {
  /**
   * Verifica se o usuário está autenticado
   */
  isAuthenticated: () => {
    return !!localStorage.getItem(LOCAL_STORAGE_KEYS.TOKEN);
  },

  /**
   * Obtém o tipo de usuário
   */
  getUserType: () => {
    return localStorage.getItem(LOCAL_STORAGE_KEYS.USER_TYPE);
  },

  /**
   * Obtém o nome do usuário
   */
  getUserName: () => {
    return localStorage.getItem(LOCAL_STORAGE_KEYS.USER_NAME);
  },

  /**
   * Obtém o ID do usuário
   */
  getUserId: () => {
    return localStorage.getItem(LOCAL_STORAGE_KEYS.USER_ID);
  },

  /**
   * Obtém a foto de perfil
   */
  getUserPhoto: () => {
    return localStorage.getItem(LOCAL_STORAGE_KEYS.USER_PHOTO);
  },

  /**
   * Obtém o token armazenado
   */
  getToken: () => {
    return localStorage.getItem(LOCAL_STORAGE_KEYS.TOKEN);
  },

  /**
   * Verifica se o usuário é administrador
   */
  isAdmin: () => {
    return authUtils.getUserType() === USER_TYPES.ADMIN;
  },

  /**
   * Verifica se o usuário é comum de sistema
   */
  isUser: () => {
    return authUtils.getUserType() === USER_TYPES.USER;
  },

  /**
   * Salva dados de autenticação
   */
  saveAuthData: (token, user) => {
    localStorage.setItem(LOCAL_STORAGE_KEYS.TOKEN, token);
    localStorage.setItem(LOCAL_STORAGE_KEYS.USER_TYPE, user.tipo);
    localStorage.setItem(LOCAL_STORAGE_KEYS.USER_NAME, user.nome);
    if (user.id) {
      localStorage.setItem(LOCAL_STORAGE_KEYS.USER_ID, user.id);
    }
    localStorage.removeItem(LOCAL_STORAGE_KEYS.USER_PHOTO);
  },

  /**
   * Limpa os dados de autenticação (logout)
   */
  clearAuthData: () => {
    Object.values(LOCAL_STORAGE_KEYS).forEach((key) => {
      localStorage.removeItem(key);
    });
    sessionStorage.removeItem('flowly.profilePhotoSignedUrl');
  },
};

export default authUtils;
