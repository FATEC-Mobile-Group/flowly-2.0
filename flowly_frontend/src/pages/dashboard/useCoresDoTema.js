import { useEffect, useState } from 'react';

// O canvas do Chart.js nao entende var(--...): as cores saem das variaveis do tema ja aplicadas no <html>.
// Valores padrao = tema escuro do App.css, usados se a variavel ainda nao existir (ex.: testes sem CSS global).
// claro: tema claro ativo (data-theme="light"), para escolher tons com contraste suficiente sobre fundo claro.
export const CORES_PADRAO = { texto: '#b0bec5', grade: 'rgba(255, 255, 255, 0.1)', claro: false };

export const lerCoresDoTema = () => {
  if (typeof window === 'undefined' || !document?.documentElement) return CORES_PADRAO;
  const estilo = window.getComputedStyle(document.documentElement);
  const ler = (nome, padrao) => estilo.getPropertyValue(nome).trim() || padrao;
  return {
    texto: ler('--text-secondary', CORES_PADRAO.texto),
    grade: ler('--border-color', CORES_PADRAO.grade),
    claro: document.documentElement.getAttribute('data-theme') === 'light',
  };
};

// O ThemeProvider troca data-theme/data-palette no <html> depois que os filhos renderizam;
// observar o atributo garante a leitura ja com o tema novo (e funciona sem provider).
export function useCoresDoTema() {
  const [cores, setCores] = useState(lerCoresDoTema);

  useEffect(() => {
    const atualizar = () => setCores((atuais) => {
      const novas = lerCoresDoTema();
      return novas.texto === atuais.texto && novas.grade === atuais.grade && novas.claro === atuais.claro
        ? atuais
        : novas;
    });
    atualizar();
    const observador = new MutationObserver(atualizar);
    observador.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme', 'data-palette'],
    });
    return () => observador.disconnect();
  }, []);

  return cores;
}
