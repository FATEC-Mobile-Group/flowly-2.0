import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import App from '../App';
import { LOCAL_STORAGE_KEYS } from './config';

// D05: a URL decide o modo da tela de autenticacao. Renderiza o App real (BrowserRouter) na URL,
// como acontece num acesso direto ou F5, sem depender de navegacao anterior.

vi.mock('../components/backgrounds/LightRays', () => ({ __esModule: true, default: () => null }));
vi.mock('../components/text/CurvedLoop', () => ({ __esModule: true, default: () => null }));
vi.mock('./socketClient', () => ({
  __esModule: true,
  default: () => ({ on: vi.fn(), emit: vi.fn(), disconnect: vi.fn(), connected: false }),
}));
vi.mock('./apiClient', () => ({
  __esModule: true,
  default: { get: vi.fn(() => new Promise(() => {})), post: vi.fn(), put: vi.fn() },
  getFullApiUrl: (path) => path,
}));

const abrir = (url) => {
  window.history.pushState({}, '', url);
  return render(<App />);
};

const caminho = () => window.location.pathname;

// Cada modo e provado por heading, campo exclusivo e botao de envio, e pela ausencia dos do outro modo.
const esperarLogin = async () => {
  expect(await screen.findByRole('heading', { name: 'Bem-vindo(a) de volta!' })).toBeInTheDocument();
  expect(screen.getByPlaceholderText('Sua senha')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /^Entrar$/ })).toHaveAttribute('type', 'submit');
  expect(screen.queryByRole('heading', { name: 'Criar nova conta' })).not.toBeInTheDocument();
  expect(screen.queryByPlaceholderText('Seu nome completo')).not.toBeInTheDocument();
};

const esperarCadastro = async () => {
  expect(await screen.findByRole('heading', { name: 'Criar nova conta' })).toBeInTheDocument();
  expect(screen.getByPlaceholderText('Seu nome completo')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /^Criar conta$/ })).toHaveAttribute('type', 'submit');
  expect(screen.queryByRole('heading', { name: 'Bem-vindo(a) de volta!' })).not.toBeInTheDocument();
  expect(screen.queryByPlaceholderText('Sua senha')).not.toBeInTheDocument();
};

beforeEach(() => {
  localStorage.clear();
});

describe('D05 - acesso direto (deep link / F5)', () => {
  test('/ mostra login', async () => {
    abrir('/');
    await esperarLogin();
    expect(caminho()).toBe('/');
  });

  test('/register mostra cadastro e mantem a URL', async () => {
    abrir('/register');
    await esperarCadastro();
    expect(caminho()).toBe('/register');
  });

  test.each(['/REGISTER', '/register/'])('%s tambem mostra cadastro', async (url) => {
    abrir(url);
    await esperarCadastro();
  });

  test('/registrar (link de e-mail antigo) redireciona para /register com o cadastro', async () => {
    abrir('/registrar');
    await waitFor(() => expect(caminho()).toBe('/register'));
    await esperarCadastro();
  });

  test('/login continua chegando ao login em /', async () => {
    abrir('/login');
    await waitFor(() => expect(caminho()).toBe('/'));
    await esperarLogin();
  });

  test('rota desconhecida continua indo para o login', async () => {
    abrir('/nao-existe');
    await waitFor(() => expect(caminho()).toBe('/'));
    await esperarLogin();
  });

  test('/verificar-2fa continua abrindo a verificacao de e-mail', async () => {
    abrir('/verificar-2fa?email=pessoa%40flowly.test');
    expect(await screen.findByRole('heading', { name: 'Verificação de Email' })).toBeInTheDocument();
    expect(caminho()).toBe('/verificar-2fa');
    expect(screen.queryByRole('heading', { name: 'Criar nova conta' })).not.toBeInTheDocument();
  });

  test('rota protegida sem sessao continua indo para o login', async () => {
    abrir('/dashboard');
    await waitFor(() => expect(caminho()).toBe('/'));
    await esperarLogin();
  });

  test('usuario com sessao em /register continua vendo o cadastro (sem redirect novo)', async () => {
    localStorage.setItem(LOCAL_STORAGE_KEYS.TOKEN, 'token-de-teste');
    localStorage.setItem(LOCAL_STORAGE_KEYS.USER_TYPE, 'user');
    abrir('/register');
    await esperarCadastro();
    expect(caminho()).toBe('/register');
  });
});

describe('D05 - botoes da tela mudam a URL junto com o modo', () => {
  test('"Cadastre-se" leva a /register e "Faça login" volta a /', async () => {
    abrir('/');
    await esperarLogin();

    fireEvent.click(screen.getByRole('button', { name: 'Cadastre-se' }));
    await waitFor(() => expect(caminho()).toBe('/register'));
    await esperarCadastro();

    fireEvent.click(screen.getByRole('button', { name: 'Faça login' }));
    await waitFor(() => expect(caminho()).toBe('/'));
    await esperarLogin();
  });

  test('voltar no navegador depois de "Cadastre-se" mostra o login de novo', async () => {
    abrir('/');
    await esperarLogin();
    fireEvent.click(screen.getByRole('button', { name: 'Cadastre-se' }));
    await waitFor(() => expect(caminho()).toBe('/register'));
    await esperarCadastro();

    await act(async () => {
      window.history.back();
      await new Promise((resolve) => window.addEventListener('popstate', resolve, { once: true }));
    });
    await waitFor(() => expect(caminho()).toBe('/'));
    await esperarLogin();
  });
});
