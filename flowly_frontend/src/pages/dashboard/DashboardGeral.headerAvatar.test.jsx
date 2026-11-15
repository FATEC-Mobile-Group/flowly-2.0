import { act, fireEvent, render, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import DashboardGeral from './DashboardGeral';
import apiClient from '../../config/apiClient';
import { API_ENDPOINTS, LOCAL_STORAGE_KEYS } from '../../config/config';

// O avatar do cabecalho usa a mesma foto do Sidebar. A URL vem assinada com token de 5 minutos,
// entao precisa da mesma renovacao, sem pedir /users/me a mais nem entrar em loop.

vi.mock('../../config/apiClient', () => ({
  __esModule: true,
  default: { get: vi.fn() },
  getFullApiUrl: (path = '') => (path.startsWith('http') ? path : `http://api.test${path}`),
}));

// O grafico nao faz parte do teste e o jsdom nao tem canvas.
vi.mock('react-chartjs-2', () => ({ Bar: () => null }));

const FOTO_A = '/api/storage/files/Zm90by5wbmc?token=antigo';
const FOTO_B = '/api/storage/files/Zm90by5wbmc?token=novo';
const FOTO_C = '/api/storage/files/Zm90by5wbmc?token=outro';
const url = (path) => `http://api.test${path}`;

const pedidosMe = () => apiClient.get.mock.calls.filter(([pedido]) => pedido === API_ENDPOINTS.USER_ME);
const avatarCabecalho = () => document.querySelector('.profile-info .avatar');
const fotoCabecalho = () => avatarCabecalho()?.querySelector('img') || null;
const fotoSidebar = () => document.querySelector('.sidebar-user-avatar img');

const sessao = ({ nome = 'Gabriel Teste', foto = FOTO_A } = {}) => {
  localStorage.setItem(LOCAL_STORAGE_KEYS.TOKEN, 'token-de-teste');
  localStorage.setItem(LOCAL_STORAGE_KEYS.USER_TYPE, 'admin');
  localStorage.setItem(LOCAL_STORAGE_KEYS.USER_NAME, nome);
  if (foto) localStorage.setItem(LOCAL_STORAGE_KEYS.USER_PHOTO, foto);
};

// Respostas de /users/me em ordem (a ultima se repete); os demais endpoints do painel vem vazios.
const respostasMe = (...fotos) => {
  let i = 0;
  apiClient.get.mockImplementation(async (pedido) => {
    if (pedido === API_ENDPOINTS.NOTIFICATIONS_COUNT) return { data: { count: 0 } };
    if (pedido !== API_ENDPOINTS.USER_ME) return { data: [] };
    const foto = fotos[Math.min(i, fotos.length - 1)];
    i += 1;
    if (foto instanceof Error) throw foto;
    return { data: { nome: 'Gabriel Teste', fotoPerfil: foto } };
  });
};

const pagina = () => (
  <MemoryRouter initialEntries={['/admin/geral']}>
    <DashboardGeral />
  </MemoryRouter>
);

const esperarFotoCabecalho = (path) =>
  waitFor(() => expect(fotoCabecalho()).toHaveAttribute('src', url(path)));
const esperarInicial = (inicial) =>
  waitFor(() => {
    expect(fotoCabecalho()).toBeNull();
    expect(avatarCabecalho()).toHaveTextContent(new RegExp(`^${inicial}$`));
  });
const deixarAssentar = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });

beforeEach(() => {
  localStorage.clear();
  apiClient.get.mockReset();
});

describe('avatar do cabecalho do Painel Geral', () => {
  test('mostra a foto renovada, a mesma do Sidebar, com um unico /users/me', async () => {
    sessao({ foto: FOTO_A });
    respostasMe(FOTO_B);
    render(pagina());

    await esperarFotoCabecalho(FOTO_B);
    expect(fotoCabecalho()).toHaveClass('avatar-img');
    expect(fotoCabecalho()).toHaveAttribute('alt', 'Foto de perfil');
    expect(fotoSidebar()).toHaveAttribute('src', url(FOTO_B));

    await deixarAssentar();
    expect(pedidosMe()).toHaveLength(1);
  });

  test('sem foto cadastrada mostra a inicial do nome', async () => {
    sessao({ nome: 'Gabriel Teste', foto: '' });
    respostasMe('');
    render(pagina());

    await waitFor(() => expect(pedidosMe()).toHaveLength(1));
    await esperarInicial('G');
  });

  test('a foto falha: renova uma vez e troca para a nova', async () => {
    sessao({ foto: FOTO_A });
    respostasMe(FOTO_B, FOTO_C);
    render(pagina());
    await esperarFotoCabecalho(FOTO_B);

    fireEvent.error(fotoCabecalho());

    await esperarFotoCabecalho(FOTO_C);
    expect(pedidosMe()).toHaveLength(2);
  });

  test('a foto renovada tambem falha: inicial, sem novos pedidos', async () => {
    sessao({ foto: FOTO_A });
    respostasMe(FOTO_B, FOTO_C, FOTO_A);
    render(pagina());
    await esperarFotoCabecalho(FOTO_B);

    fireEvent.error(fotoCabecalho());
    await esperarFotoCabecalho(FOTO_C);
    fireEvent.error(fotoCabecalho());

    await esperarInicial('G');
    await deixarAssentar();
    expect(pedidosMe()).toHaveLength(2);
  });

  test('arquivo que falha sempre (mesma URL de volta) nao entra em loop', async () => {
    sessao({ foto: FOTO_A });
    respostasMe(FOTO_A);
    render(pagina());
    await waitFor(() => expect(pedidosMe()).toHaveLength(1));

    for (let tentativa = 0; tentativa < 5; tentativa += 1) {
      const img = fotoCabecalho();
      if (img) fireEvent.error(img);
      await deixarAssentar();
    }

    await esperarInicial('G');
    expect(pedidosMe()).toHaveLength(2);
  });

  test('renovacao falha (rede/sessao): a foto quebrada vira inicial e nao repete', async () => {
    sessao({ foto: FOTO_A });
    respostasMe(new Error('falha de rede'));
    render(pagina());
    await waitFor(() => expect(pedidosMe()).toHaveLength(1));
    await deixarAssentar();
    expect(fotoCabecalho()).toHaveAttribute('src', url(FOTO_A));

    fireEvent.error(fotoCabecalho());
    await waitFor(() => expect(pedidosMe()).toHaveLength(2));
    await esperarInicial('G');
    await deixarAssentar();
    expect(pedidosMe()).toHaveLength(2);
    expect(localStorage.getItem(LOCAL_STORAGE_KEYS.TOKEN)).toBe('token-de-teste');
  });

  test('ao voltar para o painel (nova montagem) a foto continua, com uma renovacao por montagem', async () => {
    sessao({ foto: FOTO_A });
    respostasMe(FOTO_B, FOTO_C);
    const { unmount } = render(pagina());
    await esperarFotoCabecalho(FOTO_B);
    await deixarAssentar();
    unmount();

    render(pagina());
    expect(fotoCabecalho()).toHaveAttribute('src', url(FOTO_B));
    await esperarFotoCabecalho(FOTO_C);
    await deixarAssentar();
    expect(pedidosMe()).toHaveLength(2);
  });
});
