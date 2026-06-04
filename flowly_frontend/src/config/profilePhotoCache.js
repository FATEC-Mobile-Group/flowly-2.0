import apiClient from './apiClient';
import { API_ENDPOINTS } from './config';

const CACHE_KEY = 'flowly.profilePhotoSignedUrl';
const REFRESH_SKEW_MS = 60 * 1000;

const readCachedPhoto = () => {
  try {
    const cached = JSON.parse(sessionStorage.getItem(CACHE_KEY) || 'null');
    if (!cached?.url || !cached?.expiresAt) {
      return '';
    }

    const expiresAt = new Date(cached.expiresAt).getTime();
    if (Number.isNaN(expiresAt) || expiresAt <= Date.now() + REFRESH_SKEW_MS) {
      sessionStorage.removeItem(CACHE_KEY);
      return '';
    }

    return cached.url;
  } catch (error) {
    sessionStorage.removeItem(CACHE_KEY);
    return '';
  }
};

export const clearProfilePhotoCache = () => {
  sessionStorage.removeItem(CACHE_KEY);
};

export const getProfilePhotoUrl = async ({ forceRefresh = false } = {}) => {
  if (!forceRefresh) {
    const cachedUrl = readCachedPhoto();
    if (cachedUrl) {
      return cachedUrl;
    }
  }

  const response = await apiClient.get(API_ENDPOINTS.USER_ME_PHOTO_URL);
  const payload = response.data || {};

  if (!payload.url || !payload.expiresAt) {
    clearProfilePhotoCache();
    return '';
  }

  sessionStorage.setItem(CACHE_KEY, JSON.stringify({
    url: payload.url,
    expiresAt: payload.expiresAt,
  }));

  return payload.url;
};
