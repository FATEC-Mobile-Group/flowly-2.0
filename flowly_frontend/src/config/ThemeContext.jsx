import React, { createContext, useContext, useState, useEffect } from 'react';

const ThemeContext = createContext();

const LEGACY_THEME_KEY = 'flowly-theme';
const STORAGE_PREFIX = 'flowly-appearance';

export const palettes = [
  { id: 'purple', label: 'Roxo', color: '#7e57c2' },
  { id: 'blue', label: 'Azul', color: '#2F3CF5' },
  { id: 'cyan', label: 'Ciano', color: '#2FF5F2' },
  { id: 'green', label: 'Verde', color: '#00971C' },
];

const getUserAppearanceKey = () => {
  const userId = localStorage.getItem('id');
  const userName = localStorage.getItem('nome');
  return `${STORAGE_PREFIX}:${userId || userName || 'guest'}`;
};

const normalizeAppearance = (value) => {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const theme = value.theme === 'light' || value.theme === 'dark' ? value.theme : 'dark';
  const palette = palettes.some((item) => item.id === value.palette) ? value.palette : 'purple';
  return { theme, palette };
};

const readAppearance = () => {
  let parsedUserValue = null;
  try {
    parsedUserValue = JSON.parse(localStorage.getItem(getUserAppearanceKey()) || 'null');
  } catch (error) {
    parsedUserValue = null;
  }

  const userValue = normalizeAppearance(parsedUserValue);
  if (userValue) {
    return userValue;
  }

  const legacyTheme = localStorage.getItem(LEGACY_THEME_KEY);
  return {
    theme: legacyTheme === 'light' || legacyTheme === 'dark' ? legacyTheme : 'dark',
    palette: 'purple',
  };
};

export function ThemeProvider({ children }) {
  const [appearance, setAppearance] = useState(readAppearance);
  const { theme, palette } = appearance;

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    document.documentElement.setAttribute('data-palette', palette);
    localStorage.setItem(getUserAppearanceKey(), JSON.stringify({ theme, palette }));
  }, [theme, palette]);

  const toggleTheme = () => {
    setAppearance((prev) => ({
      ...prev,
      theme: prev.theme === 'dark' ? 'light' : 'dark',
    }));
  };

  const setTheme = (nextTheme) => {
    if (nextTheme !== 'light' && nextTheme !== 'dark') return;
    setAppearance((prev) => ({ ...prev, theme: nextTheme }));
  };

  const setPalette = (nextPalette) => {
    if (!palettes.some((item) => item.id === nextPalette)) return;
    setAppearance((prev) => ({ ...prev, palette: nextPalette }));
  };

  return (
    <ThemeContext.Provider value={{ theme, palette, palettes, toggleTheme, setTheme, setPalette }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  const context = useContext(ThemeContext);
  if (!context) {
    throw new Error('useTheme must be used within a ThemeProvider');
  }
  return context;
}

export default ThemeContext;
