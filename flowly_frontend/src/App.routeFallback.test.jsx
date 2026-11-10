import { act, render, screen } from '@testing-library/react';
import App from './App';
import apiClient from './config/apiClient';
import { LOCAL_STORAGE_KEYS } from './config/config';

// D26: com sessao valida, rota inexistente ou de outro papel leva a home do papel real
// (admin -> /admin, user -> /dashboard), sem logout e sem loop. Sem sessao continua indo para /.

vi.mock('./components/backgrounds/LightRays', () => ({ __esModule: true, default: () => null }));
vi.mock('./components/text/CurvedLoop', () => ({ __esModule: true, default: () => null }));
vi.mock('./config/socketClient', () => ({
  __esModule: true,
  default: () => ({ on: vi.fn(), off: vi.fn(), emit: vi.fn(), disconnect: vi.fn(), connected: false }),
}));
vi.mock('./config/apiClient', () => ({
  __esModule: true,
  default: {
    get: vi.fn((url) => (url === '/tarefas/minhas' ? Promise.resolve({ data: [] }) : new Promise(() => {}))),
    post: vi.fn(() => new Promise(() => {})),
    put: vi.fn(() => new Promise(() => {})),
    delete: vi.fn(() => new Promise(() => {})),
  },
  getFullApiUrl: (path) => path,
}));

const LOGIN = 'Bem-vindo(a) de volta!';

const entrarComo = (tipo) => {
  localStorage.setItem(LOCAL_STORAGE_KEYS.TOKEN, 'token-de-teste');
  if (tipo) localStorage.setItem(LOCAL_STORAGE_KEYS.USER_TYPE, tipo);
  localStorage.setItem(LOCAL_STORAGE_KEYS.USER_ID, `${tipo || 'sem-tipo'}-1`);
  localStorage.setItem(LOCAL_STORAGE_KEYS.USER_NAME, 'Pessoa');
};

let replaces;

const abrir = async (url) => {
  window.history.pushState({}, '', url);
  replaces = vi.spyOn(window.history, 'replaceState');
  render(<App />);
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
};

// replaceState com URL = redirecionamento (o BrowserRouter tambem chama sem URL ao iniciar).
const navegacoes = () => replaces.mock.calls.filter((call) => call.length > 2).map((call) => call[2]);

// Destino exato, sem loop (poucos redirects, todos para o destino) e sem login quando ha sessao.
const esperarDestino = (destino, { login }) => {
  expect(window.location.pathname).toBe(destino);
  expect(navegacoes().length).toBeGreaterThan(0);
  expect(navegacoes().length).toBeLessThanOrEqual(2);
  expect(navegacoes().every((url) => url === destino)).toBe(true);
  if (login) {
    expect(screen.getByRole('heading', { name: LOGIN })).toBeInTheDocument();
  } else {
    expect(screen.queryByRole('heading', { name: LOGIN })).not.toBeInTheDocument();
  }
};

const sessaoIntacta = (tipo) => {
  expect(localStorage.getItem(LOCAL_STORAGE_KEYS.TOKEN)).toBe('token-de-teste');
  expect(localStorage.getItem(LOCAL_STORAGE_KEYS.USER_TYPE)).toBe(tipo);
  expect(localStorage.getItem(LOCAL_STORAGE_KEYS.USER_ID)).toBe(`${tipo}-1`);
};

beforeEach(() => {
  localStorage.clear();
  apiClient.get.mockClear();
});

afterEach(() => {
  replaces?.mockRestore();
});

describe('D26 - anonimo continua indo para o login', () => {
  test.each(['/nao-existe', '/admin', '/dashboard'])('%s -> /', async (url) => {
    await abrir(url);
    esperarDestino('/', { login: true });
  });
});

describe('D26 - admin autenticado vai para /admin', () => {
  test.each(['/nao-existe', '/dashboard', '/minhas-tarefas', '/backlog'])('%s -> /admin, sessao intacta', async (url) => {
    entrarComo('admin');
    await abrir(url);
    esperarDestino('/admin', { login: false });
    sessaoIntacta('admin');
  });
});

describe('D26 - user autenticado vai para /dashboard', () => {
  test.each(['/nao-existe', '/admin', '/admin/tarefas', '/admin/criar-tarefa'])('%s -> /dashboard, sessao intacta', async (url) => {
    entrarComo('user');
    await abrir(url);
    esperarDestino('/dashboard', { login: false });
    sessaoIntacta('user');
  });
});

describe('D26 - rotas validas e compartilhadas nao mudam', () => {
  test.each([
    ['admin', '/admin'],
    ['admin', '/admin/tarefas'],
    ['admin', '/perfil'],
    ['user', '/dashboard'],
    ['user', '/minhas-tarefas'],
    ['user', '/perfil'],
  ])('%s em %s continua na mesma URL', async (tipo, url) => {
    entrarComo(tipo);
    await abrir(url);
    expect(window.location.pathname).toBe(url);
    expect(navegacoes()).toEqual([]);
    expect(screen.queryByRole('heading', { name: LOGIN })).not.toBeInTheDocument();
  });

  test.each([
    ['admin', '/'],
    ['user', '/register'],
  ])('%s com sessao em %s continua vendo a pagina publica (D05)', async (tipo, url) => {
    entrarComo(tipo);
    await abrir(url);
    expect(window.location.pathname).toBe(url);
    expect(navegacoes()).toEqual([]);
  });
});

describe('D26 - papel ausente ou desconhecido', () => {
  test.each([
    ['desconhecido', 'hacker'],
    ['ausente', null],
  ])('papel %s: rota inexistente e rota protegida vao para / sem loop', async (_label, tipo) => {
    entrarComo(tipo);
    await abrir('/nao-existe');
    esperarDestino('/', { login: true });
  });

  test('papel desconhecido em rota de user vai para / sem loop', async () => {
    entrarComo('hacker');
    await abrir('/dashboard');
    esperarDestino('/', { login: true });
  });
});

describe('D26 + D13 - timer depois do redirecionamento', () => {
  const pedidosDoTimer = () => apiClient.get.mock.calls.filter(([url]) => url === '/tarefas/minhas');

  test('admin redirecionado para /admin nao monta o timer', async () => {
    entrarComo('admin');
    await abrir('/nao-existe');
    expect(window.location.pathname).toBe('/admin');
    expect(pedidosDoTimer()).toHaveLength(0);
  });

  test('user redirecionado para /dashboard monta o timer', async () => {
    entrarComo('user');
    await abrir('/admin');
    expect(window.location.pathname).toBe('/dashboard');
    expect(pedidosDoTimer()).toHaveLength(1);
  });
});
