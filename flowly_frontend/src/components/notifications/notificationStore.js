// Estado compartilhado das notificacoes: contador de nao lidas (sidebar, sino dos cabecalhos e central) e as
// notificacoes recebidas em tempo real pelo Socket.IO (App.jsx). Sem polling: o contador e lido da API ao montar
// quem o exibe (pedidos simultaneos viram um so) e depois ajustado pelos eventos locais e pelo socket.
import { useEffect, useSyncExternalStore } from 'react';
import apiClient from '../../config/apiClient';
import { API_ENDPOINTS } from '../../config/config';

const LIMITE_IDS_VISTOS = 500;

let naoLidas = null; // null = ainda desconhecido (nada de zero inventado)
let leituraEmAndamento = null;
let versaoLocal = 0; // muda a cada ajuste local; resposta da API pedida antes de um ajuste nao o desfaz
const ouvintesContador = new Set();
const ouvintesNovas = new Set();
const idsVistos = new Set();

const avisarContador = () => ouvintesContador.forEach((ouvinte) => ouvinte());

const gravar = (valor) => {
  if (valor === naoLidas) return;
  naoLidas = valor;
  avisarContador();
};

export const lerNaoLidas = () => naoLidas;

export function definirNaoLidas(valor) {
  versaoLocal += 1;
  gravar(Number.isInteger(valor) && valor >= 0 ? valor : null);
}

// So ajusta um valor conhecido: sem a contagem da API, um +1/-1 isolado nao vira total.
export function ajustarNaoLidas(delta) {
  versaoLocal += 1;
  if (naoLidas === null) return;
  gravar(Math.max(0, naoLidas + delta));
}

// GET /notificacoes/count. Chamadas simultaneas (sidebar + cabecalho) dividem a mesma requisicao.
export function atualizarNaoLidas() {
  if (leituraEmAndamento) return leituraEmAndamento;
  const versao = versaoLocal;
  const leitura = apiClient.get(API_ENDPOINTS.NOTIFICATIONS_COUNT)
    .then((res) => {
      const count = res?.data?.count;
      if (!Number.isInteger(count) || count < 0) return;
      // Um ajuste local (lida, todas lidas, nova pelo socket) durante a leitura vale mais que a resposta antiga,
      // exceto quando ainda nao havia valor nenhum.
      if (versao === versaoLocal || naoLidas === null) gravar(count);
    })
    .catch(() => {
      // Sem contagem: fica o valor atual (ou nenhum); sessao invalida segue o interceptor global.
    })
    .finally(() => {
      if (leituraEmAndamento === leitura) leituraEmAndamento = null;
    });
  leituraEmAndamento = leitura;
  return leitura;
}

const idDe = (notificacao) => (notificacao && notificacao._id != null ? String(notificacao._id) : null);

// Ids ja conhecidos (carregados pela central) nao contam de novo se o socket os repetir.
export function registrarIdsConhecidos(notificacoes) {
  (Array.isArray(notificacoes) ? notificacoes : []).forEach((notificacao) => {
    const id = idDe(notificacao);
    if (id) idsVistos.add(id);
  });
  while (idsVistos.size > LIMITE_IDS_VISTOS) idsVistos.delete(idsVistos.values().next().value);
}

// Evento notification_created. Retorna false para duplicatas (mesmo _id ja recebido ou carregado) e dados invalidos.
export function receberNotificacao(notificacao) {
  const id = idDe(notificacao);
  if (!id || idsVistos.has(id)) return false;
  registrarIdsConhecidos([notificacao]);
  if (!notificacao.lida) ajustarNaoLidas(1);
  ouvintesNovas.forEach((ouvinte) => ouvinte(notificacao));
  return true;
}

export function ouvirNovasNotificacoes(ouvinte) {
  ouvintesNovas.add(ouvinte);
  return () => ouvintesNovas.delete(ouvinte);
}

const inscrever = (ouvinte) => {
  ouvintesContador.add(ouvinte);
  return () => ouvintesContador.delete(ouvinte);
};

// Contador de nao lidas para exibir (null enquanto desconhecido). Le a API ao montar.
export function useNaoLidas() {
  const valor = useSyncExternalStore(inscrever, lerNaoLidas, lerNaoLidas);
  useEffect(() => {
    atualizarNaoLidas();
  }, []);
  return valor;
}

// So para testes: volta ao estado inicial entre casos.
export function redefinirNotificacoes() {
  naoLidas = null;
  leituraEmAndamento = null;
  versaoLocal = 0;
  idsVistos.clear();
  avisarContador();
}
