import { AxiosError } from 'axios';
import { act, fireEvent, render, screen } from '@testing-library/react';
import apiClient from '../../config/apiClient';
import { authUtils } from '../../config/authUtils';
import { API_ENDPOINTS } from '../../config/config';
import FaceAuthStep, { FACE_LONG_WAIT_MS } from './FaceAuthStep';

const FOTO = 'data:image/jpeg;base64,FOTO';

vi.mock('./FaceCapture', () => ({
  __esModule: true,
  default: ({ onCapture }) => (
    <button type="button" onClick={() => onCapture(FOTO)}>camera</button>
  ),
}));

const RECOVER = 'Não consigo verificar meu rosto';

describe('FaceAuthStep: acesso a recuperacao facial', () => {
  test('na verificacao, o link leva a recuperacao', () => {
    const onRecover = vi.fn();
    render(<FaceAuthStep mode="verify" faceSessionToken="t" user={{ nome: 'Titular' }} onRecover={onRecover} />);

    fireEvent.click(screen.getByRole('button', { name: RECOVER }));

    expect(onRecover).toHaveBeenCalledTimes(1);
  });

  test('no cadastro opcional o link nao aparece', () => {
    render(<FaceAuthStep mode="enroll" faceSessionToken="t" user={{ nome: 'Titular' }} onRecover={vi.fn()} />);

    expect(screen.queryByRole('button', { name: RECOVER })).not.toBeInTheDocument();
  });

  test('sem onRecover o link nao aparece', () => {
    render(<FaceAuthStep mode="verify" faceSessionToken="t" user={{ nome: 'Titular' }} />);

    expect(screen.queryByRole('button', { name: RECOVER })).not.toBeInTheDocument();
  });
});

describe('FaceAuthStep: aviso de espera longa na verificacao', () => {
  const AVISO = /A primeira verificação pode demorar um pouco mais/;
  let requests;
  let pendentes;
  let adapterOriginal;

  // Usa o axios real, com os interceptores reais: so a camada de rede e simulada, e cada resposta fica
  // pendente ate o teste decidir.
  const responder = (indice, status, data = {}) => act(async () => { pendentes[indice](status, data); });

  beforeEach(() => {
    vi.useFakeTimers();
    requests = [];
    pendentes = [];
    adapterOriginal = apiClient.defaults.adapter;
    apiClient.defaults.adapter = (config) => new Promise((resolve, reject) => {
      requests.push(config);
      pendentes.push((status, data) => {
        const response = { status, statusText: String(status), data, headers: {}, config };
        if (status < 400) resolve(response);
        else reject(new AxiosError(`Request failed with status code ${status}`, AxiosError.ERR_BAD_REQUEST, config, null, response));
      });
    });
    vi.spyOn(authUtils, 'saveAuthData').mockImplementation(() => {});
  });

  afterEach(() => {
    apiClient.defaults.adapter = adapterOriginal;
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  const montar = (props = {}) => render(
    <FaceAuthStep mode="verify" faceSessionToken="sessao" user={{ nome: 'Titular' }} onComplete={vi.fn()} {...props} />,
  );
  const enviar = async () => {
    fireEvent.click(screen.getByRole('button', { name: 'camera' }));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Verificar e entrar' })); });
  };
  const avancar = (ms) => act(() => { vi.advanceTimersByTime(ms); });

  test('aparece so depois do tempo de espera, com o spinner, e some no sucesso', async () => {
    const onComplete = vi.fn();
    montar({ onComplete });
    expect(screen.queryByText(AVISO)).not.toBeInTheDocument();

    await enviar();
    avancar(FACE_LONG_WAIT_MS - 1);
    expect(screen.queryByText(AVISO)).not.toBeInTheDocument();
    expect(screen.getAllByText('Verificando...').length).toBeGreaterThan(0);
    avancar(1);
    expect(screen.getByRole('status')).toHaveTextContent(AVISO);

    await responder(0, 200, { token: 'jwt', user: { nome: 'Titular' } });

    expect(screen.queryByText(AVISO)).not.toBeInTheDocument();
    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  test('falha continua recusando o acesso, com a mensagem especifica, e o aviso some', async () => {
    const onComplete = vi.fn();
    montar({ onComplete });
    await enviar();
    avancar(FACE_LONG_WAIT_MS);
    expect(screen.getByText(AVISO)).toBeInTheDocument();

    await responder(0, 401, { erro: 'Rosto não reconhecido. Tente capturar outra foto com o rosto bem visível.' });

    expect(screen.queryByText(AVISO)).not.toBeInTheDocument();
    expect(screen.getByText('Rosto não reconhecido. Tente capturar outra foto com o rosto bem visível.')).toBeInTheDocument();
    expect(onComplete).not.toHaveBeenCalled();
    expect(authUtils.saveAuthData).not.toHaveBeenCalled();
  });

  test('uma requisicao por envio, sem retry; o aviso antigo nao reaparece na nova tentativa', async () => {
    montar();
    await enviar();
    avancar(FACE_LONG_WAIT_MS);
    await responder(0, 400, { erro: 'Não foi possível confirmar que a captura é de um rosto ao vivo.' });
    avancar(FACE_LONG_WAIT_MS * 3);

    expect(requests).toHaveLength(1);
    expect(requests[0].method).toBe('post');
    expect(requests[0].url).toBe(API_ENDPOINTS.FACE_VERIFY);
    expect(JSON.parse(requests[0].data)).toEqual({ faceSessionToken: 'sessao', imageBase64: FOTO });

    await enviar();
    expect(requests).toHaveLength(2);
    expect(screen.queryByText(AVISO)).not.toBeInTheDocument();
    avancar(FACE_LONG_WAIT_MS - 1);
    expect(screen.queryByText(AVISO)).not.toBeInTheDocument();
  });

  test('desmontar durante a verificacao cancela o temporizador', async () => {
    const erroDoConsole = vi.spyOn(console, 'error');
    const { unmount } = montar();
    await enviar();
    expect(vi.getTimerCount()).toBe(1);

    unmount();

    expect(vi.getTimerCount()).toBe(0);
    expect(erroDoConsole).not.toHaveBeenCalled();
  });
});
