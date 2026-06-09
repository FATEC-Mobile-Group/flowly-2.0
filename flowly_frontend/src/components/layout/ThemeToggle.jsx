import React, { useEffect, useRef, useState } from 'react';
import { useTheme } from '../../config/ThemeContext';
import { FaCheck, FaMoon, FaSun, FaPalette } from 'react-icons/fa';
import '../../styles/components/ThemeToggle.css';

const ThemeToggle = () => {
  const { theme, palette, palettes, setTheme, setPalette } = useTheme();
  const [open, setOpen] = useState(false);
  const menuRef = useRef(null);

  useEffect(() => {
    const closeOnOutsideClick = (event) => {
      if (menuRef.current && !menuRef.current.contains(event.target)) {
        setOpen(false);
      }
    };

    document.addEventListener('mousedown', closeOnOutsideClick);
    return () => document.removeEventListener('mousedown', closeOnOutsideClick);
  }, []);

  return (
    <div className="appearance-picker" ref={menuRef}>
      <button
        type="button"
        className="appearance-trigger"
        onClick={() => setOpen((current) => !current)}
        aria-label="Configurar aparência"
        aria-expanded={open}
        data-testid="theme-toggle"
        title="Aparência"
      >
        <FaPalette />
      </button>

      {open && (
        <div className="appearance-menu">
          <div className="appearance-menu-section">
            <span className="appearance-label">Tema</span>
            <div className="appearance-segment">
              <button
                type="button"
                className={theme === 'dark' ? 'selected' : ''}
                onClick={() => setTheme('dark')}
              >
                <FaMoon />
                Escuro
              </button>
              <button
                type="button"
                className={theme === 'light' ? 'selected' : ''}
                onClick={() => setTheme('light')}
              >
                <FaSun />
                Claro
              </button>
            </div>
          </div>

          <div className="appearance-menu-section">
            <span className="appearance-label">Paleta</span>
            <div className="appearance-palette-list">
              {palettes.map((item) => (
                <button
                  type="button"
                  key={item.id}
                  className={palette === item.id ? 'selected' : ''}
                  onClick={() => setPalette(item.id)}
                >
                  <span className="appearance-swatch" style={{ '--swatch-color': item.color }} />
                  <span>{item.label}</span>
                  {palette === item.id && <FaCheck className="appearance-check" />}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default ThemeToggle;
