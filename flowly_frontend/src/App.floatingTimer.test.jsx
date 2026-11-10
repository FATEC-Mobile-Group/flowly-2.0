import { act, render, screen, waitFor } from '@testing-library/react';
import App from './App';
import apiClient from './config/apiClient';
import { LOCAL_STORAGE_KEYS } from './config/config';

// D13: o FloatingTimer consulta /tarefas/minhas (so conta user na API). Admin nao deve montar o timer
// nem disparar a consulta, que sempre volta 403 para ele.

vi.mock('./components/backgrounds/LightRays', () => ({ __esModule: true, default: () => null }));
vi.mock('./components/text/CurvedLoop', () => ({ __esModule: true, default: () => null }));
vi.mock('./config/socketClient', () => ({
  __esModule: true,
  default: () => ({ on: vi.fn(), off: vi.fn(), emit: vi.fn(), disconnect: vi.fn(), connected: false }),
}));

const TAREFA_ATIVA = {
  _id: 't1',
  descricao: 'Revisar relatorio',
  user: 'user-1',
  cronometroAtivo: true,
  ultimaAtualizacaoCronometro: new Date().toISOString(),
  tempoGasto: 12,
};

// O timer pede '/tarefas/minhas'; as paginas ficam carregando para nao depender dos dados delas.
vi.mock('./config/apiClient', () => ({
  __esModule: true,
  default: {
    get: vi.fn((url) => (url === '/tarefas/minhas' ? Promise.resolve({ data: [TAREFA_ATIVA] }) : new Promise(() => {}))),
    post: vi.fn(() => new Promise(() => {})),
    put: vi.fn(() => new Promise(() => {})),
    delete: vi.fn(() => new Promise(() => {})),
  },
  getFullApiUrl: (path) => path,
}));

const chamadasMinhas = () => apiClient.get.mock.calls.filter(([url]) => String(url).endsWith('/tarefas/minhas'));
const chamadasDoTimer = () => apiClient.get.mock.calls.filter(([url]) => url === '/tarefas/minhas');
const chipDoTimer = () => document.querySelector('.floating-timer-container');

const entrarComo = (tipo) => {
  localStorage.setItem(LOCAL_STORAGE_KEYS.TOKEN, 'token-de-teste');
  localStorage.setItem(LOCAL_STORAGE_KEYS.USER_TYPE, tipo);
  localStorage.setItem(LOCAL_STORAGE_KEYS.USER_ID, `${tipo}-1`);
  localStorage.setItem(LOCAL_STORAGE_KEYS.USER_NAME, tipo === 'admin' ? 'Admin' : 'Pessoa');
};

const abrir = async (url) => {
  window.history.pushState({}, '', url);
  render(<App />);
  // Deixa os efeitos de montagem rodarem (o timer busca no mount, sem interacao).
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
};

beforeEach(() => {
  localStorage.clear();
  apiClient.get.mockClear();
});

describe('D13 - admin nao monta o FloatingTimer', () => {
  test.each(['/admin', '/admin/tarefas', '/perfil'])('admin em %s: nenhum pedido a /tarefas/minhas e nenhum timer', async (url) => {
    entrarComo('admin');
    await abrir(url);

    expect(window.location.pathname).toBe(url);
    expect(chamadasMinhas()).toHaveLength(0);
    expect(chipDoTimer()).toBeNull();
  });
});

describe('D13 - usuario comum continua com o FloatingTimer', () => {
  test.each(['/dashboard', '/minhas-tarefas', '/perfil'])('user em %s: o timer busca no mount e mostra a tarefa ativa', async (url) => {
    entrarComo('user');
    await abrir(url);

    expect(window.location.pathname).toBe(url);
    await waitFor(() => expect(chamadasDoTimer()).toHaveLength(1));
    expect(await screen.findByText('Revisar relatorio')).toBeInTheDocument();
    expect(chipDoTimer()).not.toBeNull();
    expect(screen.getByText(/^\d+ min$/)).toBeInTheDocument();
  });
});

describe('D13 - sem sessao', () => {
  // /perfil nao exige papel: so a checagem de sessao o protege.
  test.each(['/dashboard', '/admin', '/perfil'])('%s continua redirecionando para o login, sem timer', async (url) => {
    await abrir(url);

    await waitFor(() => expect(window.location.pathname).toBe('/'));
    expect(await screen.findByRole('heading', { name: 'Bem-vindo(a) de volta!' })).toBeInTheDocument();
    expect(chamadasMinhas()).toHaveLength(0);
    expect(chipDoTimer()).toBeNull();
  });
});
