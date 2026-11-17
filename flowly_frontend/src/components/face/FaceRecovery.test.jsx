import { AxiosError } from 'axios';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import apiClient from '../../config/apiClient';
import { authUtils } from '../../config/authUtils';
import { API_ENDPOINTS } from '../../config/config';
import FaceRecovery from './FaceRecovery';

const PHOTOS = ['data:image/jpeg;base64,AAAA', 'data:image/jpeg;base64,BBBB'];

vi.mock('./FaceCapture', () => ({
  __esModule: true,
  default: ({ onCapture }) => (
    <button type="button" onClick={() => onCapture(PHOTOS)}>
      Simular captura
    </button>
  ),
}));

const EMAIL = 'titular@exemplo.com';
const OLD_TOKEN = 'TOKEN_GUARDADO_ANTIGO';
const SEND_MESSAGE = 'Se a recuperacao facial estiver autorizada para esta conta, um codigo sera enviado ao e-mail cadastrado.';
const DONE_MESSAGE = 'Verificacao facial recadastrada. Entre novamente com e-mail, senha e o novo rosto.';

let requests;
let responses;
let navigations;

// Axios real com os interceptores reais: so a camada de rede e simulada.
const respondWith = (...queue) => {
  responses = queue;
  apiClient.defaults.adapter = async (config) => {
    requests.push(config);
    const [status, data] = responses.shift();
    if (status < 400) return { status, statusText: 'OK', data, headers: {}, config };
    const response = { status, statusText: String(status), data, headers: {}, config };
    throw new AxiosError(`Request failed with status code ${status}`, AxiosError.ERR_BAD_REQUEST, config, null, response);
  };
};

const renderRecovery = (props = {}) => render(<FaceRecovery initialEmail={EMAIL} onDone={vi.fn()} onCancel={vi.fn()} {...props} />);
const askCode = () => fireEvent.click(screen.getByRole('button', { name: 'Enviar código' }));
const fill = ({ codigo = '123456', senha = 'SenhaDoTitular@1' } = {}) => {
  fireEvent.change(screen.getByLabelText('Código recebido por e-mail'), { target: { value: codigo } });
  fireEvent.change(screen.getByLabelText('Senha atual'), { target: { value: senha } });
};
const capture = () => fireEvent.click(screen.getByRole('button', { name: 'Simular captura' }));
const submitButton = () => screen.getByRole('button', { name: 'Recadastrar rosto' });

beforeEach(() => {
  requests = [];
  navigations = [];
  localStorage.clear();
  sessionStorage.clear();
  vi.stubGlobal('location', {
    pathname: '/',
    hostname: 'localhost',
    origin: 'http://localhost',
    search: '',
    get href() {
      return 'http://localhost/';
    },
    set href(value) {
      navigations.push(value);
    },
  });
  authUtils.saveAuthData(OLD_TOKEN, { id: 'u1', tipo: 'user', nome: 'Titular', fotoPerfil: '' });
});

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
  sessionStorage.clear();
});

describe('FaceRecovery: recadastro facial excepcional', () => {
  test('pede o codigo sem o JWT guardado e mostra a resposta generica', async () => {
    respondWith([200, { msg: SEND_MESSAGE }]);
    renderRecovery();

    expect(screen.getByLabelText('E-mail')).toHaveValue(EMAIL);
    askCode();

    expect(await screen.findByText(SEND_MESSAGE)).toBeInTheDocument();
    expect(requests[0].url).toBe(API_ENDPOINTS.FACE_RECOVERY_SEND_CODE);
    expect(JSON.parse(requests[0].data)).toEqual({ email: EMAIL });
    expect(requests[0].headers.Authorization).toBeUndefined();
  });

  test('so envia com codigo, senha e as duas fotos, sem JWT e sem guardar token', async () => {
    respondWith([200, { msg: SEND_MESSAGE }], [200, { msg: DONE_MESSAGE }]);
    renderRecovery();
    askCode();
    await screen.findByText(SEND_MESSAGE);

    // Cada requisito isolado: codigo e senha sem fotos, depois sem senha, depois sem codigo.
    expect(submitButton()).toBeDisabled();
    fill();
    expect(submitButton()).toBeDisabled();
    capture();
    expect(submitButton()).toBeEnabled();
    fill({ senha: '' });
    expect(submitButton()).toBeDisabled();
    fill({ codigo: '' });
    expect(submitButton()).toBeDisabled();
    fill();
    expect(submitButton()).toBeEnabled();

    fireEvent.click(submitButton());

    expect(await screen.findByText(DONE_MESSAGE)).toBeInTheDocument();
    const sent = requests[1];
    expect(sent.url).toBe(API_ENDPOINTS.FACE_RECOVERY_REENROLL);
    expect(JSON.parse(sent.data)).toEqual({ email: EMAIL, codigo: '123456', senha: 'SenhaDoTitular@1', imagesBase64: PHOTOS });
    expect(sent.headers.Authorization).toBeUndefined();
    expect(sent.timeout).toBe(120000);
    expect(authUtils.getToken()).toBe(OLD_TOKEN);
    expect(screen.queryByLabelText('Senha atual')).not.toBeInTheDocument();
  });

  test('erro da API aparece e nao desloga nem redireciona', async () => {
    respondWith([200, { msg: SEND_MESSAGE }], [401, { erro: 'Codigo, e-mail ou senha invalidos.' }]);
    renderRecovery();
    askCode();
    await screen.findByText(SEND_MESSAGE);
    fill({ codigo: '000000' });
    capture();

    fireEvent.click(submitButton());

    expect(await screen.findByText('Codigo, e-mail ou senha invalidos.')).toBeInTheDocument();
    expect(navigations).toEqual([]);
    expect(authUtils.getToken()).toBe(OLD_TOKEN);
    expect(submitButton()).toBeEnabled();
  });

  test('rosto ligado a outra conta mostra a mensagem do servidor', async () => {
    const duplicate = 'Este rosto já está vinculado a outra conta Flowly.';
    respondWith([200, { msg: SEND_MESSAGE }], [409, { erro: duplicate, codigo: 'FACE_DUPLICATE' }]);
    renderRecovery();
    askCode();
    await screen.findByText(SEND_MESSAGE);
    fill();
    capture();

    fireEvent.click(submitButton());

    expect(await screen.findByText(duplicate)).toBeInTheDocument();
  });

  test('voltar ao login chama onCancel antes e onDone depois de concluir', async () => {
    const onCancel = vi.fn();
    const onDone = vi.fn();
    respondWith([200, { msg: SEND_MESSAGE }], [200, { msg: DONE_MESSAGE }]);
    renderRecovery({ onCancel, onDone });

    fireEvent.click(screen.getByRole('button', { name: 'Voltar ao login' }));
    expect(onCancel).toHaveBeenCalledTimes(1);

    askCode();
    await screen.findByText(SEND_MESSAGE);
    fill();
    capture();
    fireEvent.click(submitButton());
    await screen.findByText(DONE_MESSAGE);
    fireEvent.click(screen.getByRole('button', { name: 'Ir para o login' }));

    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
  });
});
