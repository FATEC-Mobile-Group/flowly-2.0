import { AxiosError } from 'axios';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import apiClient from './apiClient';
import { authUtils } from './authUtils';
import { API_ENDPOINTS, LOCAL_STORAGE_KEYS } from './config';
import AuthPage from '../pages/auth/AuthPage';
import Verify from '../pages/auth/Verify';
import FaceAuthStep from '../components/face/FaceAuthStep';

vi.mock('../components/backgrounds/LightRays', () => ({
  __esModule: true,
  default: () => null,
}));

vi.mock('../components/text/CurvedLoop', () => ({
  __esModule: true,
  default: () => null,
}));

vi.mock('../components/face/FaceCapture', () => ({
  __esModule: true,
  default: ({ onCapture }) => (
    <button type="button" onClick={() => onCapture('data:image/jpeg;base64,AAAA')}>
      Simular captura
    </button>
  ),
}));

const TOKEN_ATUAL = 'TOKEN_ATUAL';
const TOKEN_ANTIGO = 'TOKEN_ANTIGO';
const TOKEN_NOVO = 'TOKEN_NOVO';
const TOKEN_FACIAL = 'TOKEN_FACIAL';
const LOGIN_ROUTE = '/';

const USER = { id: 'usuario-1', tipo: 'user', nome: 'Usuario Teste', fotoPerfil: 'foto.jpg' };

let requests;
let navigations;

const buildFailure = (config, status, data) => {
  const response = { status, statusText: String(status), data, headers: {}, config };
  return new AxiosError(
    `Request failed with status code ${status}`,
    AxiosError.ERR_BAD_REQUEST,
    config,
    null,
    response,
  );
};

// Usa o axios real: so a camada de rede e simulada.
const mockResponse = (status, data = {}, duringRequest) => {
  apiClient.defaults.adapter = async (config) => {
    requests.push(config);
    duringRequest?.(config);
    if (status >= 400) throw buildFailure(config, status, data);
    return { status, statusText: 'OK', data, headers: {}, config };
  };
};

const mockRoutes = (routes) => {
  apiClient.defaults.adapter = async (config) => {
    requests.push(config);
    const route = Object.keys(routes).find((url) => config.url.startsWith(url));
    const [status, data] = routes[route];
    if (status >= 400) throw buildFailure(config, status, data);
    return { status, statusText: 'OK', data, headers: {}, config };
  };
};

const stubLocation = (pathname) => {
  vi.stubGlobal('location', {
    pathname,
    hostname: 'localhost',
    origin: 'http://localhost',
    search: '',
    get href() {
      return `http://localhost${pathname}`;
    },
    set href(value) {
      navigations.push(value);
    },
  });
};

const startSession = (token = TOKEN_ATUAL) => authUtils.saveAuthData(token, USER);

const expectSessionKept = (token = TOKEN_ATUAL) => {
  expect(localStorage.getItem(LOCAL_STORAGE_KEYS.TOKEN)).toBe(token);
  expect(localStorage.getItem(LOCAL_STORAGE_KEYS.USER_TYPE)).toBe(USER.tipo);
  expect(localStorage.getItem(LOCAL_STORAGE_KEYS.USER_ID)).toBe(USER.id);
  expect(navigations).toEqual([]);
};

const expectSessionCleared = () => {
  Object.values(LOCAL_STORAGE_KEYS).forEach((key) => {
    expect(localStorage.getItem(key)).toBeNull();
  });
};

const sentAuthorization = (index = 0) => requests[index].headers.Authorization;

beforeEach(() => {
  requests = [];
  navigations = [];
  localStorage.clear();
  stubLocation('/dashboard');
});

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe('interceptor 401: sessao principal', () => {
  test('A: 401 com o JWT atual encerra a sessao, vai para o login e rejeita com o erro original', async () => {
    startSession();
    mockResponse(401, { success: false, error: 'Token inválido' });

    const failure = await apiClient.get('/tarefas/minhas').catch((error) => error);

    expect(sentAuthorization()).toBe(`Bearer ${TOKEN_ATUAL}`);
    expectSessionCleared();
    expect(navigations).toEqual([LOGIN_ROUTE]);
    expect(failure).toBeInstanceOf(AxiosError);
    expect(failure.response.status).toBe(401);
    expect(failure.response.data).toEqual({ success: false, error: 'Token inválido' });
  });

  test('A: ja na rota de login, encerra a sessao sem recarregar a pagina', async () => {
    stubLocation(LOGIN_ROUTE);
    startSession();
    mockResponse(401);

    await apiClient.get('/users/me').catch(() => {});

    expectSessionCleared();
    expect(navigations).toEqual([]);
  });

  test('A: varios 401 simultaneos redirecionam uma unica vez', async () => {
    startSession();
    mockResponse(401);

    await Promise.allSettled([
      apiClient.get('/tarefas/minhas'),
      apiClient.get('/equipes/minhas'),
      apiClient.get('/notificacoes/count'),
    ]);

    expectSessionCleared();
    expect(navigations).toEqual([LOGIN_ROUTE]);
  });

  test('B: 401 sem Authorization e sem sessao nao redireciona e propaga o erro', async () => {
    mockResponse(401, { erro: 'Credenciais inválidas' });

    const failure = await apiClient.post('/auth/login', {}).catch((error) => error);

    expect(sentAuthorization()).toBeUndefined();
    expect(navigations).toEqual([]);
    expect(failure.response.status).toBe(401);
    expect(failure.response.data).toEqual({ erro: 'Credenciais inválidas' });
  });

  test('B: chamada pre-login nao envia o JWT guardado e nao encerra a sessao', async () => {
    startSession();
    mockResponse(401, { erro: 'Credenciais inválidas' });

    const failure = await apiClient
      .post('/auth/login', {}, { skipAuthToken: true })
      .catch((error) => error);

    expect(sentAuthorization()).toBeUndefined();
    expectSessionKept();
    expect(failure.response.status).toBe(401);
  });

  test('C: 401 com token facial temporario no Authorization nao encerra a sessao principal', async () => {
    startSession();
    mockResponse(401, { erro: 'Token de sessão facial inválido.' }, (config) => {
      config.headers.Authorization = `Bearer ${TOKEN_FACIAL}`;
    });

    const failure = await apiClient.post('/face/verify', {}).catch((error) => error);

    expect(sentAuthorization()).toBe(`Bearer ${TOKEN_FACIAL}`);
    expectSessionKept();
    expect(failure.response.status).toBe(401);
  });

  test('D: 401 de requisicao antiga nao derruba a sessao criada depois', async () => {
    startSession(TOKEN_ANTIGO);
    mockResponse(401, {}, () => {
      startSession(TOKEN_NOVO);
    });

    const failure = await apiClient.get('/tarefas/minhas').catch((error) => error);

    expect(sentAuthorization()).toBe(`Bearer ${TOKEN_ANTIGO}`);
    expectSessionKept(TOKEN_NOVO);
    expect(failure.response.status).toBe(401);
  });

  test('D: 401 que chega depois do logout nao redireciona de novo', async () => {
    startSession();
    mockResponse(401, {}, () => {
      authUtils.clearAuthData();
    });

    await apiClient.get('/tarefas/minhas').catch(() => {});

    expect(navigations).toEqual([]);
  });

  test.each([400, 403, 404, 409, 422, 429, 500, 503])(
    'E: erro %i com o JWT atual nao interfere na sessao',
    async (status) => {
      startSession();
      mockResponse(status);

      const failure = await apiClient.get('/tarefas/minhas').catch((error) => error);

      expectSessionKept();
      expect(failure.response.status).toBe(status);
    },
  );

  test('E: erro de rede, sem resposta, nao interfere na sessao', async () => {
    startSession();
    apiClient.defaults.adapter = async (config) => {
      throw new AxiosError('Network Error', AxiosError.ERR_NETWORK, config);
    };

    const failure = await apiClient.get('/tarefas/minhas').catch((error) => error);

    expectSessionKept();
    expect(failure.code).toBe(AxiosError.ERR_NETWORK);
  });

  test('chamadas autenticadas continuam enviando o JWT principal', async () => {
    startSession();
    mockResponse(200, []);

    await apiClient.get('/tarefas/minhas');

    expect(sentAuthorization()).toBe(`Bearer ${TOKEN_ATUAL}`);
    expectSessionKept();
  });
});

// Cenario real: JWT vencido continua guardado, porque abrir a tela de login nao o apaga.
describe('fluxos pre-login com token antigo guardado', () => {
  beforeEach(() => {
    stubLocation(LOGIN_ROUTE);
    startSession();
  });

  const renderAt = (element, route = '/') =>
    render(<MemoryRouter initialEntries={[route]}>{element}</MemoryRouter>);

  const expectPreLoginFailureHandled = () => {
    expect(requests.at(-1).headers.Authorization).toBeUndefined();
    expectSessionKept();
  };

  test('login com senha errada mostra a mensagem e mantem a tela', async () => {
    mockRoutes({ [API_ENDPOINTS.LOGIN]: [401, { erro: 'Credenciais inválidas' }] });
    renderAt(<AuthPage />);

    fireEvent.change(screen.getByPlaceholderText('Seu email'), { target: { value: 'a@b.com' } });
    fireEvent.change(screen.getByPlaceholderText('Sua senha'), { target: { value: 'senha-errada' } });
    fireEvent.click(screen.getByRole('button', { name: 'Entrar' }));

    expect(await screen.findByText('Credenciais inválidas')).toBeInTheDocument();
    expectPreLoginFailureHandled();
  });

  const startRecovery = async () => {
    renderAt(<AuthPage />);
    fireEvent.click(screen.getByRole('button', { name: 'Esqueci minha senha' }));
    fireEvent.change(screen.getByPlaceholderText('Seu email'), { target: { value: 'a@b.com' } });
    fireEvent.click(screen.getByRole('button', { name: 'Enviar codigo' }));
    fireEvent.change(await screen.findByPlaceholderText('Codigo de 6 digitos'), {
      target: { value: '123456' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Validar codigo' }));
  };

  test('recuperacao de senha com codigo errado mostra a mensagem', async () => {
    mockRoutes({
      [API_ENDPOINTS.SEND_PASSWORD_RESET]: [200, {}],
      [API_ENDPOINTS.VALIDATE_PASSWORD_RESET_CODE]: [401, { message: 'Codigo invalido ou expirado.' }],
    });

    await startRecovery();

    expect(await screen.findByText('Codigo invalido ou expirado.')).toBeInTheDocument();
    expectPreLoginFailureHandled();
  });

  test('redefinicao de senha com codigo recusado mostra a mensagem', async () => {
    mockRoutes({
      [API_ENDPOINTS.SEND_PASSWORD_RESET]: [200, {}],
      [API_ENDPOINTS.VALIDATE_PASSWORD_RESET_CODE]: [200, { message: 'Codigo validado.' }],
      [API_ENDPOINTS.RESET_PASSWORD]: [401, { message: 'Codigo invalido ou expirado.' }],
    });

    await startRecovery();
    fireEvent.change(await screen.findByPlaceholderText('Nova senha'), {
      target: { value: 'Senha@123' },
    });
    fireEvent.change(screen.getByPlaceholderText('Confirmar nova senha'), {
      target: { value: 'Senha@123' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Redefinir senha' }));

    expect(await screen.findByText('Codigo invalido ou expirado.')).toBeInTheDocument();
    expectPreLoginFailureHandled();
  });

  test('verificacao de e-mail com codigo errado mostra a mensagem', async () => {
    mockRoutes({ [API_ENDPOINTS.VALIDATE_2FA_CODE]: [401, { message: 'Codigo incorreto.' }] });
    renderAt(<Verify />, '/verificar-2fa?email=a%40b.com');

    fireEvent.change(screen.getByPlaceholderText('Código de verificação'), {
      target: { value: '000000' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Verificar código' }));

    expect(await screen.findByText('Codigo incorreto.')).toBeInTheDocument();
    expectPreLoginFailureHandled();
  });

  test('verificacao de e-mail por link invalido mostra a mensagem', async () => {
    mockRoutes({ [API_ENDPOINTS.VALIDATE_2FA_TOKEN]: [401, { message: 'Link recusado.' }] });
    renderAt(<Verify />, '/verificar-2fa?token=abc');

    expect(await screen.findByText('Link recusado.')).toBeInTheDocument();
    expectPreLoginFailureHandled();
  });

  test('rosto sem correspondencia mostra a mensagem e continua na verificacao', async () => {
    mockRoutes({
      [API_ENDPOINTS.FACE_VERIFY]: [401, { erro: 'Rosto não reconhecido. Tente outra foto.' }],
    });
    renderAt(<FaceAuthStep mode="verify" faceSessionToken={TOKEN_FACIAL} user={USER} onComplete={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: 'Simular captura' }));
    fireEvent.click(screen.getByRole('button', { name: 'Verificar e entrar' }));

    expect(await screen.findByText(/Rosto não reconhecido/)).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Verificação facial' })).toBeInTheDocument();
    expectPreLoginFailureHandled();
  });

  test('pular cadastro facial com token temporario invalido mostra a mensagem', async () => {
    mockRoutes({
      [API_ENDPOINTS.FACE_SKIP_ENROLLMENT]: [401, { erro: 'Token de sessão facial inválido.' }],
    });
    renderAt(<FaceAuthStep mode="enroll" faceSessionToken={TOKEN_FACIAL} user={USER} onComplete={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: 'Pular por agora' }));

    expect(await screen.findByText('Token de sessão facial inválido.')).toBeInTheDocument();
    expectPreLoginFailureHandled();
  });
});
