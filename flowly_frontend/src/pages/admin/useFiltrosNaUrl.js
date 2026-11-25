import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';

export const ATRASO_BUSCA_MS = 300;

// Filtros guardados nos query parameters. A URL e a fonte da verdade: recarregar, voltar e avancar e links de
// outras telas aplicam os filtros. Cada escolha (select, limpar) cria uma entrada no historico; a busca digitada
// so vai para a URL depois de uma pausa e substitui a entrada atual, sem uma entrada por caractere.
// ler(params, contexto) devolve { filtros, invalidos }; serializar(filtros) devolve URLSearchParams.
// Valores invalidos ficam fora de `filtros` e saem da URL na proxima alteracao.
export function useFiltrosNaUrl({ ler, serializar, padrao, contexto = null, atrasoBusca = ATRASO_BUSCA_MS }) {
  const [searchParams, setSearchParams] = useSearchParams();
  const { filtros, invalidos } = useMemo(() => ler(searchParams, contexto), [ler, searchParams, contexto]);
  const buscaUrl = filtros.busca;

  const [busca, setBusca] = useState(buscaUrl);
  // A URL mudou por fora (voltar/avancar, link, limpar): a caixa de busca acompanha. A propria gravacao da busca
  // (sem espacos nas pontas) nao reescreve o que a pessoa esta digitando.
  const [buscaUrlVista, setBuscaUrlVista] = useState(buscaUrl);
  if (buscaUrl !== buscaUrlVista) {
    setBuscaUrlVista(buscaUrl);
    if (buscaUrl !== busca.trim()) setBusca(buscaUrl);
  }

  // Sempre a versao mais recente: o temporizador da busca e as acoes nao gravam filtros antigos por cima de novos.
  const atual = useRef({ filtros, busca, setSearchParams });
  useLayoutEffect(() => {
    atual.current = { filtros, busca, setSearchParams };
  });

  useEffect(() => {
    const alvo = busca.trim();
    if (alvo === buscaUrl) return undefined;
    const temporizador = setTimeout(() => {
      const { filtros: filtrosAtuais, setSearchParams: gravar } = atual.current;
      gravar(serializar({ ...filtrosAtuais, busca: alvo }), { replace: true, preventScrollReset: true });
    }, atrasoBusca);
    return () => clearTimeout(temporizador);
  }, [busca, buscaUrl, atrasoBusca, serializar]);

  // Leva junto a busca ainda nao gravada, para uma escolha feita durante a digitacao nao perder o texto.
  const aplicar = useCallback((mudancas, { replace = false } = {}) => {
    const { filtros: filtrosAtuais, busca: digitada, setSearchParams: gravar } = atual.current;
    gravar(serializar({ ...filtrosAtuais, busca: digitada.trim(), ...mudancas }), { replace, preventScrollReset: true });
  }, [serializar]);

  const limpar = useCallback(() => {
    const { filtros: filtrosAtuais, setSearchParams: gravar } = atual.current;
    setBusca('');
    // A ordenacao nao e um filtro: continua como estava.
    gravar(serializar({ ...padrao, ordem: filtrosAtuais.ordem }), { preventScrollReset: true });
  }, [padrao, serializar]);

  return { filtros, invalidos, busca, setBusca, aplicar, limpar, searchParams };
}
