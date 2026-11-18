import { StrictMode } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import FaceCapture from './FaceCapture';

// Ciclo de vida da webcam (C2): getUserMedia e assincrono, entao cada stream que chega precisa
// de um dono. Os streams sao falsos e cada pedido fica pendente ate o teste resolver, na ordem que quiser.

const RESTRICOES = {
  video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } },
  audio: false,
};

const novoStream = (id) => {
  const track = {
    id,
    readyState: 'live',
    onended: null,
    stop: vi.fn(() => { track.readyState = 'ended'; }),
  };
  return { id, track, getTracks: () => [track], getVideoTracks: () => [track] };
};

let pedidos;
let playOriginal;

const camera = () => ({
  chamadas: () => navigator.mediaDevices.getUserMedia.mock.calls.length,
  resolver: (indice) => act(async () => { pedidos[indice].resolver(); }),
  rejeitar: (indice) => act(async () => { pedidos[indice].rejeitar(new Error('NotAllowedError')); }),
  stream: (indice) => pedidos[indice].stream,
});

const video = () => document.querySelector('video.face-capture-video');
const botaoCapturar = (nome = 'Capturar foto de frente') => screen.getByRole('button', { name: nome });

beforeEach(() => {
  pedidos = [];
  playOriginal = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = vi.fn(() => Promise.resolve());
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: {
      getUserMedia: vi.fn(() => new Promise((resolve, reject) => {
        const stream = novoStream(`s${pedidos.length + 1}`);
        pedidos.push({ stream, resolver: () => resolve(stream), rejeitar: reject });
      })),
    },
  });
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage: vi.fn() });
  vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue('data:image/jpeg;base64,FOTO');
});

afterEach(() => {
  HTMLMediaElement.prototype.play = playOriginal;
  delete navigator.mediaDevices;
  vi.restoreAllMocks();
});

describe('FaceCapture - abertura da camera', () => {
  test('abre a camera uma vez, com as restricoes atuais, e liga o video', async () => {
    const cam = camera();
    render(<FaceCapture onCapture={() => {}} captureMode="dual" />);

    expect(screen.getByText('Iniciando câmera...')).toBeInTheDocument();
    expect(cam.chamadas()).toBe(1);
    expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledWith(RESTRICOES);

    await cam.resolver(0);

    expect(video().srcObject).toBe(cam.stream(0));
    expect(HTMLMediaElement.prototype.play).toHaveBeenCalled();
    expect(botaoCapturar()).toBeEnabled();
    expect(screen.queryByText('Iniciando câmera...')).not.toBeInTheDocument();
  });

  test('re-renderizacoes comuns (props novas) nao reabrem a camera', async () => {
    const cam = camera();
    const { rerender } = render(<FaceCapture onCapture={() => {}} captureMode="dual" />);
    await cam.resolver(0);

    rerender(<FaceCapture onCapture={() => {}} captureMode="dual" disabled />);
    rerender(<FaceCapture onCapture={() => {}} captureMode="dual" processing processingLabel="Salvando..." />);
    rerender(<FaceCapture onCapture={() => {}} captureMode="dual" />);

    expect(cam.chamadas()).toBe(1);
    expect(cam.stream(0).track.stop).not.toHaveBeenCalled();
    expect(video().srcObject).toBe(cam.stream(0));
  });

  test('erro do pedido atual mostra a mensagem de permissao', async () => {
    const cam = camera();
    render(<FaceCapture onCapture={() => {}} />);
    await cam.rejeitar(0);

    expect(screen.getByText('Não foi possível acessar a câmera. Verifique as permissões do navegador.')).toBeInTheDocument();
    expect(botaoCapturar('Capturar rosto')).toBeDisabled();
  });
});

describe('FaceCapture - liberacao do dispositivo', () => {
  test('ao desmontar, para as tracks e libera video.srcObject', async () => {
    const cam = camera();
    const { unmount } = render(<FaceCapture onCapture={() => {}} captureMode="dual" />);
    await cam.resolver(0);
    const elemento = video();
    expect(elemento.srcObject).toBe(cam.stream(0));

    unmount();

    expect(cam.stream(0).track.stop).toHaveBeenCalledTimes(1);
    expect(cam.stream(0).track.readyState).toBe('ended');
    expect(elemento.srcObject).toBeNull();
  });

  test('stream que chega depois da desmontagem e encerrado na hora', async () => {
    const cam = camera();
    const { unmount } = render(<FaceCapture onCapture={() => {}} captureMode="dual" />);
    unmount(); // por exemplo: o usuario saiu do Perfil com o pedido de permissao aberto

    await cam.resolver(0);

    expect(cam.stream(0).track.stop).toHaveBeenCalledTimes(1);
    expect(cam.stream(0).track.readyState).toBe('ended');
  });

  test('erro que chega depois da desmontagem nao gera aviso', async () => {
    const erroDoConsole = vi.spyOn(console, 'error');
    const cam = camera();
    const { unmount } = render(<FaceCapture onCapture={() => {}} />);
    unmount();

    await cam.rejeitar(0);

    expect(erroDoConsole).not.toHaveBeenCalled();
  });
});

describe('FaceCapture - React StrictMode (montagem dupla em desenvolvimento)', () => {
  const montarEmStrictMode = () => render(
    <StrictMode><FaceCapture onCapture={() => {}} captureMode="dual" /></StrictMode>,
  );

  test('respostas em ordem: o pedido abandonado e parado e so o atual fica no video', async () => {
    const cam = camera();
    const { unmount } = montarEmStrictMode();
    expect(cam.chamadas()).toBe(2);

    await cam.resolver(0);
    await cam.resolver(1);

    expect(cam.stream(0).track.stop).toHaveBeenCalledTimes(1);
    expect(cam.stream(1).track.stop).not.toHaveBeenCalled();
    expect(video().srcObject).toBe(cam.stream(1));
    expect(botaoCapturar()).toBeEnabled();

    unmount();
    expect(cam.stream(1).track.stop).toHaveBeenCalledTimes(1);
    expect([cam.stream(0), cam.stream(1)].every((s) => s.track.readyState === 'ended')).toBe(true);
  });

  test('respostas fora de ordem: o pedido mais novo vence e o antigo e parado ao chegar', async () => {
    const cam = camera();
    montarEmStrictMode();

    await cam.resolver(1);
    expect(video().srcObject).toBe(cam.stream(1));

    await cam.resolver(0);

    expect(cam.stream(0).track.stop).toHaveBeenCalledTimes(1);
    expect(cam.stream(1).track.stop).not.toHaveBeenCalled();
    expect(video().srcObject).toBe(cam.stream(1));
    expect(botaoCapturar()).toBeEnabled();
  });

  test('falha do pedido abandonado nao apaga a camera que ja funciona', async () => {
    const cam = camera();
    montarEmStrictMode();

    await cam.resolver(1);
    await cam.rejeitar(0);

    expect(screen.queryByText(/Não foi possível acessar a câmera/)).not.toBeInTheDocument();
    expect(video().srcObject).toBe(cam.stream(1));
    expect(botaoCapturar()).toBeEnabled();
  });
});

describe('FaceCapture - reinicio legitimo e captura', () => {
  test('camera encerrada pelo sistema volta com "Tirar outra foto"; o stream antigo nao mexe mais no estado', async () => {
    const cam = camera();
    const onCapture = vi.fn();
    render(<FaceCapture onCapture={onCapture} captureMode="dual" />);
    await cam.resolver(0);

    fireEvent.click(botaoCapturar());
    expect(screen.getByText(/Foto 1\/2/)).toBeInTheDocument();

    // O sistema encerra a camera (cabo, outro app, permissao revogada).
    const fimDoSistema = cam.stream(0).track.onended;
    cam.stream(0).track.readyState = 'ended';
    act(() => { fimDoSistema(); });
    expect(botaoCapturar('Capturar foto levemente de lado')).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: 'Tirar outra foto' }));
    expect(cam.chamadas()).toBe(2);
    expect(cam.stream(0).track.stop).toHaveBeenCalled();
    await cam.resolver(1);

    expect(video().srcObject).toBe(cam.stream(1));
    expect(botaoCapturar()).toBeEnabled();

    // Um aviso atrasado do stream substituido nao desliga a camera nova.
    act(() => { cam.stream(0).track.onended?.(); });
    expect(botaoCapturar()).toBeEnabled();
  });

  test('captura das duas fotos continua em JPEG 0.92 e entrega as duas imagens', async () => {
    const cam = camera();
    const onCapture = vi.fn();
    render(<FaceCapture onCapture={onCapture} captureMode="dual" />);
    await cam.resolver(0);

    fireEvent.click(botaoCapturar());
    fireEvent.click(botaoCapturar('Capturar foto levemente de lado'));

    expect(HTMLCanvasElement.prototype.toDataURL).toHaveBeenCalledTimes(2);
    expect(HTMLCanvasElement.prototype.toDataURL).toHaveBeenNthCalledWith(1, 'image/jpeg', 0.92);
    expect(HTMLCanvasElement.prototype.toDataURL).toHaveBeenNthCalledWith(2, 'image/jpeg', 0.92);
    expect(onCapture).toHaveBeenLastCalledWith(['data:image/jpeg;base64,FOTO', 'data:image/jpeg;base64,FOTO']);
    expect(cam.chamadas()).toBe(1);
  });
});
