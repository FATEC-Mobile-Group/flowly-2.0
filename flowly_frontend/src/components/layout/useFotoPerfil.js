import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import apiClient, { getFullApiUrl } from '../../config/apiClient';
import { API_ENDPOINTS, LOCAL_STORAGE_KEYS } from '../../config/config';

// A foto vem com token de 5 minutos. O localStorage e so cache: a URL e renovada ao montar e,
// se a imagem falhar, uma unica vez por montagem. Uma URL que ja falhou nao volta a ser exibida.
// Quem usa o hook (Sidebar, cabecalho do painel) divide a mesma renovacao: componentes montados
// juntos fazem um unico /users/me e todos passam a mostrar a URL nova.

const ouvintes = new Set();
let renovacaoEmAndamento = null;

const lerFotoEmCache = () => localStorage.getItem(LOCAL_STORAGE_KEYS.USER_PHOTO) || '';

const inscrever = (ouvinte) => {
  ouvintes.add(ouvinte);
  return () => ouvintes.delete(ouvinte);
};

const buscarFotoAtual = async () => {
  try {
    const res = await apiClient.get(API_ENDPOINTS.USER_ME);
    const fotoAtual = res.data?.fotoPerfil || '';
    if (fotoAtual) {
      localStorage.setItem(LOCAL_STORAGE_KEYS.USER_PHOTO, fotoAtual);
    } else {
      localStorage.removeItem(LOCAL_STORAGE_KEYS.USER_PHOTO);
    }
    ouvintes.forEach((ouvinte) => ouvinte());
  } catch {
    // Sem renovacao fica a foto em cache ou a inicial; sessao invalida segue o interceptor global.
  }
};

const renovarFotoPerfil = () => {
  if (renovacaoEmAndamento) return renovacaoEmAndamento;

  const renovacao = buscarFotoAtual().finally(() => {
    if (renovacaoEmAndamento === renovacao) renovacaoEmAndamento = null;
  });
  renovacaoEmAndamento = renovacao;
  return renovacao;
};

export const useFotoPerfil = () => {
  const foto = useSyncExternalStore(inscrever, lerFotoEmCache);
  const [fotoQuebrada, setFotoQuebrada] = useState('');
  const renovouNoErroRef = useRef(false);

  useEffect(() => {
    renovarFotoPerfil();
  }, []);

  const aoFalharFoto = () => {
    setFotoQuebrada(foto);
    if (renovacaoEmAndamento || renovouNoErroRef.current) return;
    renovouNoErroRef.current = true;
    renovarFotoPerfil();
  };

  return {
    fotoUrl: foto && foto !== fotoQuebrada ? getFullApiUrl(foto) : '',
    aoFalharFoto,
  };
};
