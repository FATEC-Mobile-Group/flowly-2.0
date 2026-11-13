import { AxiosError } from 'axios';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import apiClient from '../../config/apiClient';
import { authUtils } from '../../config/authUtils';
import { API_ENDPOINTS, LOCAL_STORAGE_KEYS } from '../../config/config';
import FaceProfileEnroll from './FaceProfileEnroll';

const PHOTOS = ['data:image/jpeg;base64,AAAA', 'data:image/jpeg;base64,BBBB'];

vi.mock('./FaceCapture', () => ({
  __esModule: true,
  default: ({ onCapture }) => (
    <button type="button" onClick={() => onCapture(PHOTOS)}>
      Simular captura
    </button>
  ),
}));

const TOKEN = 'TOKEN_ATUAL';
const PASSWORD = 'SenhaOriginal@1';
const USER = { id: 'usuario-1', tipo: 'user', nome: 'Usuario Teste', fotoPerfil: '' };

let requests;
let navigations;

// Usa o axios real, com os interceptores reais: so a camada de rede e simulada.
const mockResponse = (status, data = {}) => {
  apiClient.defaults.adapter = async (config) => {
    requests.push(config);
    if (status < 400) return { status, statusText: 'OK', data, headers: {}, config };
    const response = { status, statusText: String(status), data, headers: {}, config };
    throw new AxiosError(`Request failed with status code ${status}`, AxiosError.ERR_BAD_REQUEST, config, null, response);
  };
};

const passwordField = () => screen.getByLabelText('Senha atual');
const submitButton = () => screen.getByRole('button', { name: /Cadastrar verificação facial|Atualizar rosto/ });
const capture = () => fireEvent.click(screen.getByRole('button', { name: 'Simular captura' }));
const typePassword = (value = PASSWORD) => fireEvent.change(passwordField(), { target: { value } });

const storedValues = () => [
  ...Object.values({ ...localStorage }),
  ...Object.values({ ...sessionStorage }),
].join('|');

beforeEach(() => {
  requests = [];
  navigations = [];
  localStorage.clear();
  sessionStorage.clear();
  vi.stubGlobal('location', {
    pathname: '/perfil',
    hostname: 'localhost',
    origin: 'http://localhost',
    search: '',
    get href() {
      return 'http://localhost/perfil';
    },
    set href(value) {
      navigations.push(value);
    },
  });
  authUtils.saveAuthData(TOKEN, USER);
});

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
  sessionStorage.clear();
});

describe('FaceProfileEnroll: senha atual no cadastro facial pelo perfil', () => {
  test('o botao so habilita com as fotos e a senha', () => {
    mockResponse(200);
    render(<FaceProfileEnroll enrolled={false} />);

    expect(passwordField()).toHaveAttribute('type', 'password');
    expect(submitButton()).toBeDisabled();

    capture();
    expect(submitButton()).toBeDisabled();

    typePassword();
    expect(submitButton()).toBeEnabled();
  });

  test('senha correta envia fotos e senha uma vez, conclui e limpa o campo', async () => {
    mockResponse(200, { msg: 'ok', enrolled: true });
    const onEnrolled = vi.fn();
    render(<FaceProfileEnroll enrolled={false} onEnrolled={onEnrolled} />);

    capture();
    typePassword();
    fireEvent.click(submitButton());

    expect(await screen.findByText('Verificação facial cadastrada com sucesso.')).toBeInTheDocument();
    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe(API_ENDPOINTS.FACE_ENROLL_PROFILE);
    expect(requests[0].headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(JSON.parse(requests[0].data)).toEqual({ imagesBase64: PHOTOS, senhaAtual: PASSWORD });
    expect(onEnrolled).toHaveBeenCalledTimes(1);
    expect(passwordField()).toHaveValue('');
  });

  test('senha errada mostra a mensagem, limpa o campo e mantem a sessao', async () => {
    mockResponse(400, { erro: 'Senha atual incorreta.' });
    const onEnrolled = vi.fn();
    render(<FaceProfileEnroll enrolled={false} onEnrolled={onEnrolled} />);

    capture();
    typePassword('SenhaErrada@999');
    fireEvent.click(submitButton());

    expect(await screen.findByText('Senha atual incorreta.')).toBeInTheDocument();
    expect(onEnrolled).not.toHaveBeenCalled();
    expect(passwordField()).toHaveValue('');
    expect(localStorage.getItem(LOCAL_STORAGE_KEYS.TOKEN)).toBe(TOKEN);
    expect(navigations).toEqual([]);
  });

  test('depois da senha errada, basta digitar de novo, sem repetir as fotos', async () => {
    mockResponse(400, { erro: 'Senha atual incorreta.' });
    render(<FaceProfileEnroll enrolled />);

    capture();
    typePassword('SenhaErrada@999');
    fireEvent.click(submitButton());
    await screen.findByText('Senha atual incorreta.');

    mockResponse(200, { msg: 'ok', enrolled: true });
    typePassword();
    fireEvent.click(submitButton());

    await screen.findByText('Verificação facial cadastrada com sucesso.');
    expect(JSON.parse(requests[1].data)).toEqual({ imagesBase64: PHOTOS, senhaAtual: PASSWORD });
  });

  test.each([
    ['sucesso', 200, {}],
    ['senha errada', 400, { erro: 'Senha atual incorreta.' }],
  ])('a senha nao fica guardada no navegador apos %s', async (_label, status, data) => {
    mockResponse(status, data);
    render(<FaceProfileEnroll enrolled={false} />);

    capture();
    typePassword();
    expect(storedValues()).not.toContain(PASSWORD);
    fireEvent.click(submitButton());

    await waitFor(() => expect(requests).toHaveLength(1));
    await waitFor(() => expect(passwordField()).toHaveValue(''));
    expect(storedValues()).not.toContain(PASSWORD);
  });

  test('JWT expirado (401) continua encerrando a sessao, como no D03', async () => {
    mockResponse(401, { error: 'Token inválido ou expirado' });
    render(<FaceProfileEnroll enrolled={false} />);

    capture();
    typePassword();
    fireEvent.click(submitButton());

    await waitFor(() => expect(navigations).toEqual(['/']));
    expect(localStorage.getItem(LOCAL_STORAGE_KEYS.TOKEN)).toBeNull();
  });
});
