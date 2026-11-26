// Preferencias de interface por usuario (PR #68). So escolhas nao sensiveis, no localStorage, numa chave por conta:
// "flowly-preferences:<id>". A aparencia (tema e paleta) continua no ThemeContext (chave "flowly-appearance:<id>").
// Nada aqui guarda mensagens, rascunhos, tokens ou dados biometricos.
import { useSyncExternalStore } from 'react';

const PREFIXO = 'flowly-preferences';

export const PREFERENCIAS_PADRAO = Object.freeze({
  fundoAnimado: true,
  sidebarRecolhida: false,
  toastsMensagens: true,
  enviarComEnter: true,
  // Voz do assistente (PR #69): 'tecnologica' (Microsoft Daniel, quando existir no navegador) ou 'original'.
  vozAssistente: 'tecnologica',
});

const CHAVES = Object.keys(PREFERENCIAS_PADRAO);
// Preferencias de escolha (texto): so os valores listados valem; o resto sao interruptores (booleanos).
const OPCOES = Object.freeze({ vozAssistente: ['tecnologica', 'original'] });

const valorValido = (chave, valor) => (OPCOES[chave] ? OPCOES[chave].includes(valor) : typeof valor === 'boolean');

// Mesma identificacao da aparencia: id da conta (ou o nome, ou "guest" sem sessao).
export const chaveDasPreferencias = () => {
  const userId = localStorage.getItem('id');
  const userName = localStorage.getItem('nome');
  return `${PREFIXO}:${userId || userName || 'guest'}`;
};

// Valor ausente, corrompido ou de outro tipo: o padrao daquela preferencia.
export function normalizarPreferencias(valor) {
  const origem = valor && typeof valor === 'object' && !Array.isArray(valor) ? valor : {};
  return Object.freeze(Object.fromEntries(CHAVES.map((chave) => [
    chave,
    valorValido(chave, origem[chave]) ? origem[chave] : PREFERENCIAS_PADRAO[chave],
  ])));
}

const lerDoArmazenamento = (chave) => {
  try {
    return normalizarPreferencias(JSON.parse(localStorage.getItem(chave) || 'null'));
  } catch (_erro) {
    return normalizarPreferencias(null);
  }
};

// Cache por chave: a mesma conta devolve o mesmo objeto (useSyncExternalStore) e outra conta e lida de novo.
let cache = { chave: null, valor: PREFERENCIAS_PADRAO };
const ouvintes = new Set();
const avisar = () => ouvintes.forEach((ouvinte) => ouvinte());

export function lerPreferencias() {
  const chave = chaveDasPreferencias();
  if (cache.chave !== chave) cache = { chave, valor: lerDoArmazenamento(chave) };
  return cache.valor;
}

export function definirPreferencia(nome, valor) {
  if (!CHAVES.includes(nome) || !valorValido(nome, valor)) return;
  const chave = chaveDasPreferencias();
  const proximo = normalizarPreferencias({ ...lerPreferencias(), [nome]: valor });
  cache = { chave, valor: proximo };
  try {
    localStorage.setItem(chave, JSON.stringify(proximo));
  } catch (_erro) {
    // Sem armazenamento (modo privado, cota): a escolha vale ate recarregar a pagina.
  }
  avisar();
}

// Restaurar padroes: so as preferencias desta conta (interface e aparencia); nada da conta ou dos dados.
export function restaurarPreferencias() {
  const chave = chaveDasPreferencias();
  cache = { chave, valor: normalizarPreferencias(null) };
  try {
    localStorage.removeItem(chave);
  } catch (_erro) {
    // Ignora: o padrao ja vale em memoria.
  }
  avisar();
}

const inscrever = (ouvinte) => {
  ouvintes.add(ouvinte);
  // Outra aba da mesma conta mudou as preferencias: relê.
  const aoMudarArmazenamento = (evento) => {
    if (evento.key === null || evento.key === cache.chave) {
      cache = { chave: null, valor: PREFERENCIAS_PADRAO };
      ouvinte();
    }
  };
  window.addEventListener('storage', aoMudarArmazenamento);
  return () => {
    ouvintes.delete(ouvinte);
    window.removeEventListener('storage', aoMudarArmazenamento);
  };
};

export const usePreferencias = () => useSyncExternalStore(inscrever, lerPreferencias, lerPreferencias);

// So para testes.
export function redefinirCacheDePreferencias() {
  cache = { chave: null, valor: PREFERENCIAS_PADRAO };
  avisar();
}
