import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import Sidebar from './Sidebar';
import apiClient from '../../config/apiClient';
import { API_ENDPOINTS, LOCAL_STORAGE_KEYS } from '../../config/config';

// D25: a foto vem assinada com token de 5 minutos. O Sidebar nao pode depender para sempre da URL
// guardada no login: renova ao montar e tenta renovar uma unica vez quando a imagem falha.

vi.mock('../../config/apiClient', () => ({
  __esModule: true,
  default: { get: vi.fn() },
  getFullApiUrl: (path = '') => (path.startsWith('http') ? path : `http://api.test${path}`),
}));

const FOTO_A = '/api/storage/files/Zm90by5wbmc?token=antigo';
const FOTO_B = '/api/storage/files/Zm90by5wbmc?token=novo';
const FOTO_C = '/api/storage/files/Zm90by5wbmc?token=outro';
const url = (path) => `http://api.test${path}`;

const pedidosMe = () => apiClient.get.mock.calls.filter(([pedido]) => pedido === API_ENDPOINTS.USER_ME);
const imagem = () => screen.queryByAltText('Foto de perfil');
const avatar = () => document.querySelector('.sidebar-user-avatar');

const sessao = ({ tipo = 'user', nome = 'Ana', foto = FOTO_A } = {}) => {
  localStorage.setItem(LOCAL_STORAGE_KEYS.TOKEN, 'token-de-teste');
  localStorage.setItem(LOCAL_STORAGE_KEYS.USER_TYPE, tipo);
  localStorage.setItem(LOCAL_STORAGE_KEYS.USER_NAME, nome);
  if (foto) localStorage.setItem(LOCAL_STORAGE_KEYS.USER_PHOTO, foto);
};

// Respostas de /users/me em ordem; a ultima se repete.
const respostasMe = (...fotos) => {
  let i = 0;
  apiClient.get.mockImplementation(async () => {
    const foto = fotos[Math.min(i, fotos.length - 1)];
    i += 1;
    if (foto instanceof Error) throw foto;
    return { data: { nome: 'Ana', fotoPerfil: foto } };
  });
};

const montar = () =>
  render(
    <MemoryRouter initialEntries={['/dashboard']}>
      <Sidebar />
    </MemoryRouter>,
  );

const esperarFoto = (path) => waitFor(() => expect(imagem()).toHaveAttribute('src', url(path)));
const esperarFallback = (inicial) =>
  waitFor(() => {
    expect(imagem()).toBeNull();
    expect(avatar()).toHaveTextContent(inicial);
  });
const deixarAssentar = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });

beforeEach(() => {
  localStorage.clear();
  apiClient.get.mockReset();
});

describe('D25 - renovacao ao montar (F5 / sessao longa)', () => {
  test('A: com URL velha no localStorage, busca /users/me uma vez e passa a usar a foto nova', async () => {
    sessao({ foto: FOTO_A });
    respostasMe(FOTO_B);
    montar();

    await esperarFoto(FOTO_B);
    expect(pedidosMe()).toHaveLength(1);
    expect(localStorage.getItem(LOCAL_STORAGE_KEYS.USER_PHOTO)).toBe(FOTO_B);
  });

  test('A: /users/me devolve a mesma foto valida e ela continua na tela', async () => {
    sessao({ foto: FOTO_A });
    respostasMe(FOTO_A);
    montar();

    await waitFor(() => expect(pedidosMe()).toHaveLength(1));
    await esperarFoto(FOTO_A);
  });
});

describe('D25 - renovacao no erro da imagem', () => {
  test('B: a foto falha, renova uma vez e troca para a nova', async () => {
    sessao({ foto: FOTO_A });
    respostasMe(FOTO_B, FOTO_C);
    montar();
    await esperarFoto(FOTO_B);

    fireEvent.error(imagem());

    await esperarFoto(FOTO_C);
    expect(pedidosMe()).toHaveLength(2);
  });

  test('C: a foto renovada tambem falha: fallback, sem novos pedidos', async () => {
    sessao({ foto: FOTO_A });
    respostasMe(FOTO_B, FOTO_C, FOTO_A);
    montar();
    await esperarFoto(FOTO_B);

    fireEvent.error(imagem());
    await esperarFoto(FOTO_C);
    fireEvent.error(imagem());

    await esperarFallback('A');
    await deixarAssentar();
    expect(pedidosMe()).toHaveLength(2);
  });

  test('C: arquivo que falha sempre (mesma URL de volta) nao entra em loop', async () => {
    sessao({ foto: FOTO_A });
    respostasMe(FOTO_A);
    montar();
    await waitFor(() => expect(pedidosMe()).toHaveLength(1));

    for (let tentativa = 0; tentativa < 5; tentativa += 1) {
      const img = imagem();
      if (img) fireEvent.error(img);
      await deixarAssentar();
    }

    await esperarFallback('A');
    expect(pedidosMe()).toHaveLength(2);
  });

  test('a URL velha falha antes da resposta do mount: espera a resposta, sem pedido extra', async () => {
    sessao({ foto: FOTO_A });
    let responder;
    apiClient.get.mockImplementation(() => new Promise((resolve) => { responder = resolve; }));
    montar();
    await waitFor(() => expect(pedidosMe()).toHaveLength(1));

    fireEvent.error(imagem());
    await esperarFallback('A');
    expect(pedidosMe()).toHaveLength(1);

    await act(async () => responder({ data: { fotoPerfil: FOTO_B } }));
    await esperarFoto(FOTO_B);
    expect(pedidosMe()).toHaveLength(1);
  });

  test('renovacao falha (rede/sessao): a foto quebrada vira fallback e nao repete', async () => {
    sessao({ foto: FOTO_A });
    respostasMe(new Error('falha de rede'));
    montar();
    await waitFor(() => expect(pedidosMe()).toHaveLength(1));
    await deixarAssentar();

    fireEvent.error(imagem());
    await waitFor(() => expect(pedidosMe()).toHaveLength(2));
    await esperarFallback('A');
    await deixarAssentar();
    expect(pedidosMe()).toHaveLength(2);
    // Falha da foto nao derruba a sessao; so o interceptor global decide sobre 401 (D03).
    expect(localStorage.getItem(LOCAL_STORAGE_KEYS.TOKEN)).toBe('token-de-teste');
  });
});

describe('D25 - estados preservados', () => {
  test('D: sem fotoPerfil mostra a inicial do nome, sem imagem', async () => {
    sessao({ nome: 'Bruno', foto: '' });
    respostasMe('');
    montar();

    await waitFor(() => expect(pedidosMe()).toHaveLength(1));
    await esperarFallback('B');
    expect(localStorage.getItem(LOCAL_STORAGE_KEYS.USER_PHOTO)).toBeNull();
  });

  test.each([
    ['admin', 'Admin Geral', '/api/storage/files/YWRtaW4?token=a'],
    ['user', 'Ana', '/api/storage/files/dXNlcg?token=u'],
  ])('E: %s ve a propria foto renovada', async (tipo, nome, foto) => {
    sessao({ tipo, nome, foto: FOTO_A });
    respostasMe(foto);
    montar();

    await esperarFoto(foto);
    expect(screen.getByText(nome)).toBeInTheDocument();
  });

  test('upload no perfil: a foto nova gravada no localStorage aparece no proximo render', async () => {
    sessao({ foto: FOTO_A });
    respostasMe(FOTO_A);
    const { rerender } = montar();
    await esperarFoto(FOTO_A);

    localStorage.setItem(LOCAL_STORAGE_KEYS.USER_PHOTO, FOTO_C);
    rerender(
      <MemoryRouter initialEntries={['/dashboard']}>
        <Sidebar />
      </MemoryRouter>,
    );

    await esperarFoto(FOTO_C);
  });
});
