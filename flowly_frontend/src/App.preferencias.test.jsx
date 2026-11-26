// Preferencias aplicadas no App (PR #68): fundo animado desmontado de verdade (e trocado por um fundo estatico) sem
// remontar a pagina nem o socket; toasts de mensagens desligaveis sem afetar o contador; rota /preferencias
// protegida e aberta aos dois perfis; aparencia da conta certa depois de trocar de usuario.
import { act, render, screen, waitFor } from '@testing-library/react';
import App from './App';
import { LOCAL_STORAGE_KEYS } from './config/config';
import { definirPreferencia, redefinirCacheDePreferencias } from './config/preferencias';
import { atualizarNaoLidas, lerNaoLidas, redefinirNotificacoes } from './components/notifications/notificationStore';

const { handlers, sockets, montagens } = vi.hoisted(() => ({ handlers: {}, sockets: { criados: 0 }, montagens: { total: 0 } }));

vi.mock('./config/socketClient', () => ({
  __esModule: true,
  default: () => {
    sockets.criados += 1;
    return {
      on: vi.fn((evento, fn) => { handlers[evento] = fn; }),
      off: vi.fn(),
      emit: vi.fn(),
      disconnect: vi.fn(),
      connected: false,
    };
  },
}));
vi.mock('./config/apiClient', () => ({
  __esModule: true,
  default: { get: vi.fn(async () => ({ data: { count: 1 } })), post: vi.fn(), put: vi.fn() },
  getFullApiUrl: (path) => path,
}));
vi.mock('./components/layout/Sidebar', () => ({ __esModule: true, default: () => null }));

// Rotas de teste: uma pagina que conta montagens e a central de preferencias real, sem papel exigido.
// Sem JSX na factory (ela e icada antes dos imports do arquivo): React.createElement.
vi.mock('./config/routes', async () => {
  const React = await import('react');
  const { default: PreferenciasPage } = await import('./pages/common/PreferenciasPage');
  function Sonda() {
    React.useEffect(() => { montagens.total += 1; }, []);
    return React.createElement('p', { 'data-testid': 'sonda' }, 'pagina protegida');
  }
  return {
    publicRoutes: [{ path: '/', element: React.createElement('p', null, 'tela de login') }],
    adminRoutes: [],
    userRoutes: [
      { path: '/teste', element: React.createElement(Sonda) },
      { path: '/preferencias', element: React.createElement(PreferenciasPage) },
    ],
    allRoutes: [],
  };
});

const entrarComo = (tipo, id = `${tipo}-1`) => {
  localStorage.setItem(LOCAL_STORAGE_KEYS.TOKEN, 'token-de-teste');
  localStorage.setItem(LOCAL_STORAGE_KEYS.USER_TYPE, tipo);
  localStorage.setItem(LOCAL_STORAGE_KEYS.USER_ID, id);
  localStorage.setItem(LOCAL_STORAGE_KEYS.USER_NAME, 'Pessoa');
};
const abrir = (url) => {
  window.history.pushState({}, '', url);
  return render(<App />);
};
const notificar = (notificacao) => act(async () => { handlers.notification_created(notificacao); });

beforeEach(() => {
  localStorage.clear();
  redefinirCacheDePreferencias();
  redefinirNotificacoes();
  Object.keys(handlers).forEach((evento) => delete handlers[evento]);
  sockets.criados = 0;
  montagens.total = 0;
  document.documentElement.removeAttribute('data-theme');
  document.documentElement.removeAttribute('data-palette');
});

describe('fundo animado', () => {
  test('ligado por padrao; desligar desmonta o ColorBends e mostra o estatico, sem remontar pagina, seletor ou socket', async () => {
    entrarComo('admin');
    abrir('/teste');
    expect(await screen.findByTestId('sonda')).toBeInTheDocument();
    expect(document.querySelector('.color-bends-container')).not.toBeNull();
    expect(screen.queryByTestId('fundo-estatico')).toBeNull();
    const sonda = screen.getByTestId('sonda');
    const seletor = screen.getByTestId('theme-toggle');
    const socketsAntes = sockets.criados;

    await act(async () => { definirPreferencia('fundoAnimado', false); });
    expect(document.querySelector('.color-bends-container')).toBeNull();
    expect(document.querySelector('.xmb-field')).toBeNull();
    expect(screen.getByTestId('fundo-estatico')).toBeInTheDocument();
    expect(screen.getByTestId('sonda')).toBe(sonda);
    expect(screen.getByTestId('theme-toggle')).toBe(seletor);
    expect(montagens.total).toBe(1);
    expect(sockets.criados).toBe(socketsAntes);

    await act(async () => { definirPreferencia('fundoAnimado', true); });
    expect(document.querySelector('.color-bends-container')).not.toBeNull();
    expect(screen.queryByTestId('fundo-estatico')).toBeNull();
    expect(montagens.total).toBe(1);
  });

  test('preferencia salva por conta vale ao recarregar', async () => {
    entrarComo('user', 'u-7');
    localStorage.setItem('flowly-preferences:u-7', JSON.stringify({ fundoAnimado: false }));
    abrir('/teste');
    await screen.findByTestId('sonda');
    expect(screen.getByTestId('fundo-estatico')).toBeInTheDocument();
    expect(document.querySelector('.color-bends-container')).toBeNull();
  });
});

describe('avisos de novas mensagens', () => {
  test('desligados: sem toast, mas a notificacao conta no contador compartilhado; religados: toast volta', async () => {
    entrarComo('admin');
    abrir('/teste');
    await screen.findByTestId('sonda');
    // A Sidebar (simulada aqui) e os cabecalhos leem o contador ao montar: o mesmo pedido, feito direto.
    await act(async () => { await atualizarNaoLidas(); });
    expect(lerNaoLidas()).toBe(1);

    await act(async () => { definirPreferencia('toastsMensagens', false); });
    await notificar({ _id: 'n1', tipo: 'chat', texto: 'Mensagem silenciosa', lida: false });
    expect(screen.queryByText('Mensagem silenciosa')).toBeNull();
    expect(lerNaoLidas()).toBe(2);

    await act(async () => { definirPreferencia('toastsMensagens', true); });
    await notificar({ _id: 'n2', tipo: 'chat', texto: 'Mensagem com aviso', lida: false });
    expect(await screen.findByText('Mensagem com aviso')).toBeInTheDocument();
    expect(lerNaoLidas()).toBe(3);
  });
});

describe('rota /preferencias', () => {
  test.each(['admin', 'user'])('%s acessa a central', async (tipo) => {
    entrarComo(tipo);
    abrir('/preferencias');
    expect(await screen.findByRole('heading', { name: 'Preferências', level: 2 })).toBeInTheDocument();
  });

  test('sem sessao volta para o login', async () => {
    abrir('/preferencias');
    expect(await screen.findByText('tela de login')).toBeInTheDocument();
    expect(window.location.pathname).toBe('/');
  });

  test('a rota real esta nas rotas protegidas sem papel exigido', async () => {
    const reais = await vi.importActual('./config/routes');
    const rota = [...reais.adminRoutes, ...reais.userRoutes].find((item) => item.path === '/preferencias');
    expect(rota).toBeDefined();
    expect(rota.requiredRole).toBeUndefined();
    expect(reais.publicRoutes.some((item) => item.path === '/preferencias')).toBe(false);
  });
});

describe('troca de conta', () => {
  test('aparencia e preferencias seguem a conta da sessao, sem misturar contas', async () => {
    localStorage.setItem('flowly-appearance:a-1', JSON.stringify({ theme: 'light', palette: 'green' }));
    localStorage.setItem('flowly-preferences:b-1', JSON.stringify({ fundoAnimado: false }));
    entrarComo('admin', 'a-1');
    abrir('/teste');
    await screen.findByTestId('sonda');
    await waitFor(() => expect(document.documentElement.getAttribute('data-palette')).toBe('green'));
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
    expect(document.querySelector('.color-bends-container')).not.toBeNull();

    // Outra conta no mesmo navegador, sem recarregar a pagina (o App continua montado): ao navegar, a pagina
    // protegida le a aparencia e as preferencias da conta nova (padrao dark/purple).
    entrarComo('user', 'b-1');
    await act(async () => {
      window.history.pushState({}, '', '/preferencias');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    await screen.findByRole('heading', { name: 'Preferências', level: 2 });
    await waitFor(() => expect(document.documentElement.getAttribute('data-palette')).toBe('purple'));
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    expect(screen.getByTestId('fundo-estatico')).toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem('flowly-appearance:a-1'))).toEqual({ theme: 'light', palette: 'green' });
  });
});
