import { StrictMode } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import FaceCapture, { CAMERA_SETTLE_MS } from './FaceCapture';

// Ciclo de vida da webcam (C2): getUserMedia e assincrono, entao cada stream que chega precisa
// de um dono. Os streams sao falsos e cada pedido fica pendente ate o teste resolver, na ordem que quiser.
// O jsdom nao reproduz video: quadroPronto() simula o elemento com um quadro real e cameraPronta() dispara o
// evento nativo e passa a estabilizacao.

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

const quadroPronto = ({ largura = 640, altura = 480, readyState = 4 } = {}) => {
  Object.defineProperties(video(), {
    readyState: { configurable: true, value: readyState },
    videoWidth: { configurable: true, value: largura },
    videoHeight: { configurable: true, value: altura },
    paused: { configurable: true, value: false },
    ended: { configurable: true, value: false },
  });
};
const disparar = (evento = 'playing') => act(() => { video().dispatchEvent(new Event(evento)); });
const avancar = (ms) => act(() => { vi.advanceTimersByTime(ms); });
const cameraPronta = (opcoes) => {
  quadroPronto(opcoes);
  disparar('loadeddata');
  avancar(CAMERA_SETTLE_MS);
};

beforeEach(() => {
  vi.useFakeTimers();
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
  vi.useRealTimers();
  HTMLMediaElement.prototype.play = playOriginal;
  delete navigator.mediaDevices;
  vi.restoreAllMocks();
});

describe('FaceCapture - abertura da camera', () => {
  test('abre a camera uma vez, com as restricoes atuais, e so libera a captura com um quadro real', async () => {
    const cam = camera();
    render(<FaceCapture onCapture={() => {}} captureMode="dual" />);

    expect(screen.getByText('Iniciando câmera...')).toBeInTheDocument();
    expect(cam.chamadas()).toBe(1);
    expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledWith(RESTRICOES);

    await cam.resolver(0);

    expect(video().srcObject).toBe(cam.stream(0));
    expect(HTMLMediaElement.prototype.play).toHaveBeenCalled();
    // Stream recebido nao basta: sem quadro, a captura segue indisponivel.
    expect(botaoCapturar()).toBeDisabled();
    expect(screen.getByText('Iniciando câmera...')).toBeInTheDocument();

    cameraPronta();
    expect(botaoCapturar()).toBeEnabled();
    expect(screen.queryByText('Iniciando câmera...')).not.toBeInTheDocument();
  });

  test('re-renderizacoes comuns (props novas) nao reabrem a camera', async () => {
    const cam = camera();
    const { rerender } = render(<FaceCapture onCapture={() => {}} captureMode="dual" />);
    await cam.resolver(0);
    cameraPronta();

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

  test('orientacao textual antes da captura; no cadastro as dicas de cada foto continuam', async () => {
    const dica = 'Posicione o rosto inteiro na moldura, olhe para a câmera e prefira uma iluminação frontal.';
    const { unmount } = render(<FaceCapture onCapture={() => {}} />);
    expect(screen.getByText(dica)).toBeInTheDocument();
    unmount();

    render(<FaceCapture onCapture={() => {}} captureMode="dual" />);
    expect(screen.getByText(dica)).toBeInTheDocument();
    expect(screen.getByText(/Foto 0\/2: Olhe de frente para a câmera/)).toBeInTheDocument();
  });
});

describe('FaceCapture - prontidao real do video', () => {
  test('so o evento nativo com quadro libera, e so depois da estabilizacao', async () => {
    const cam = camera();
    render(<FaceCapture onCapture={() => {}} />);
    await cam.resolver(0);

    avancar(5000); // sem evento nem quadro, o tempo sozinho nao libera nada
    expect(botaoCapturar('Capturar rosto')).toBeDisabled();

    quadroPronto();
    disparar('playing');
    avancar(CAMERA_SETTLE_MS - 1);
    expect(botaoCapturar('Capturar rosto')).toBeDisabled();
    avancar(1);
    expect(botaoCapturar('Capturar rosto')).toBeEnabled();
  });

  test('quadro ja disponivel antes do registro dos listeners tambem libera', async () => {
    const cam = camera();
    render(<FaceCapture onCapture={() => {}} />);
    quadroPronto(); // o elemento ja tem quadro quando o stream chega
    await cam.resolver(0);

    avancar(CAMERA_SETTLE_MS);
    expect(botaoCapturar('Capturar rosto')).toBeEnabled();
  });

  test('video sem dimensoes validas nao libera e nunca gera foto', async () => {
    const cam = camera();
    const onCapture = vi.fn();
    render(<FaceCapture onCapture={onCapture} />);
    await cam.resolver(0);

    cameraPronta({ largura: 0, altura: 0 });
    expect(botaoCapturar('Capturar rosto')).toBeDisabled();
    fireEvent.click(botaoCapturar('Capturar rosto'));

    cameraPronta({ readyState: 1 }); // HAVE_METADATA: ainda sem quadro
    expect(botaoCapturar('Capturar rosto')).toBeDisabled();
    expect(HTMLCanvasElement.prototype.toDataURL).not.toHaveBeenCalled();
    expect(onCapture).not.toHaveBeenCalled();
  });

  test('stream encerrado durante a estabilizacao nao libera a captura', async () => {
    const cam = camera();
    render(<FaceCapture onCapture={() => {}} />);
    await cam.resolver(0);
    quadroPronto();
    disparar('loadeddata');

    cam.stream(0).track.readyState = 'ended';
    act(() => { cam.stream(0).track.onended(); });
    avancar(CAMERA_SETTLE_MS);

    expect(botaoCapturar('Capturar rosto')).toBeDisabled();
    expect(vi.getTimerCount()).toBe(0);
  });

  test('falha de reproducao do video mantem a captura indisponivel e mostra o aviso da camera', async () => {
    HTMLMediaElement.prototype.play = vi.fn(() => Promise.reject(Object.assign(new Error('x'), { name: 'NotAllowedError' })));
    const cam = camera();
    render(<FaceCapture onCapture={() => {}} />);
    await cam.resolver(0);

    expect(screen.getByText('Não foi possível acessar a câmera. Verifique as permissões do navegador.')).toBeInTheDocument();
    avancar(CAMERA_SETTLE_MS);
    expect(botaoCapturar('Capturar rosto')).toBeDisabled();
  });

  test('desmontar com a estabilizacao pendente cancela o temporizador', async () => {
    const erroDoConsole = vi.spyOn(console, 'error');
    const cam = camera();
    const { unmount } = render(<FaceCapture onCapture={() => {}} />);
    await cam.resolver(0);
    quadroPronto();
    disparar('playing');
    expect(vi.getTimerCount()).toBe(1);

    unmount();

    expect(vi.getTimerCount()).toBe(0);
    avancar(CAMERA_SETTLE_MS);
    expect(erroDoConsole).not.toHaveBeenCalled();
  });

  test('evento e temporizador do stream antigo nao liberam a camera nova antes da hora', async () => {
    const cam = camera();
    render(<FaceCapture onCapture={() => {}} captureMode="dual" />);
    await cam.resolver(0);
    cameraPronta();
    fireEvent.click(botaoCapturar());

    // A camera cai e o usuario pede outra foto: o stream novo ainda nao chegou.
    cam.stream(0).track.readyState = 'ended';
    act(() => { cam.stream(0).track.onended(); });
    fireEvent.click(screen.getByRole('button', { name: 'Tirar outra foto' }));
    disparar('playing'); // evento atrasado do video antigo
    avancar(CAMERA_SETTLE_MS);
    expect(botaoCapturar()).toBeDisabled();

    // O stream novo espera a sua propria estabilizacao.
    await cam.resolver(1);
    expect(botaoCapturar()).toBeDisabled();
    avancar(CAMERA_SETTLE_MS);
    expect(botaoCapturar()).toBeEnabled();
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
    cameraPronta();

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
    cameraPronta();
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
    cameraPronta();
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
    cameraPronta();

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
    cameraPronta();

    expect(video().srcObject).toBe(cam.stream(1));
    expect(botaoCapturar()).toBeEnabled();

    // Um aviso atrasado do stream substituido nao desliga a camera nova.
    act(() => { cam.stream(0).track.onended?.(); });
    expect(botaoCapturar()).toBeEnabled();
  });

  test('captura das duas fotos continua em JPEG 0.92, com as dimensoes reais e sem nova espera', async () => {
    const cam = camera();
    const onCapture = vi.fn();
    const larguras = [];
    const toDataURL = HTMLCanvasElement.prototype.toDataURL;
    toDataURL.mockImplementation(function registrar() {
      larguras.push(`${this.width}x${this.height}`);
      return 'data:image/jpeg;base64,FOTO';
    });
    render(<FaceCapture onCapture={onCapture} captureMode="dual" />);
    await cam.resolver(0);
    cameraPronta({ largura: 1280, altura: 720 });

    fireEvent.click(botaoCapturar());
    expect(vi.getTimerCount()).toBe(0);
    fireEvent.click(botaoCapturar('Capturar foto levemente de lado'));

    expect(toDataURL).toHaveBeenCalledTimes(2);
    expect(toDataURL).toHaveBeenNthCalledWith(1, 'image/jpeg', 0.92);
    expect(toDataURL).toHaveBeenNthCalledWith(2, 'image/jpeg', 0.92);
    expect(larguras).toEqual(['1280x720', '1280x720']);
    expect(onCapture).toHaveBeenLastCalledWith(['data:image/jpeg;base64,FOTO', 'data:image/jpeg;base64,FOTO']);
    expect(cam.chamadas()).toBe(1);
  });

  test('"Tirar outra foto" com o mesmo stream valido libera na hora, sem reabrir a camera', async () => {
    const cam = camera();
    const onCapture = vi.fn();
    render(<FaceCapture onCapture={onCapture} />);
    await cam.resolver(0);
    cameraPronta();

    fireEvent.click(botaoCapturar('Capturar rosto'));
    expect(botaoCapturar('Capturar rosto')).toBeDisabled(); // previa na tela
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Tirar outra foto' })); });

    expect(botaoCapturar('Capturar rosto')).toBeEnabled();
    expect(vi.getTimerCount()).toBe(0);
    expect(cam.chamadas()).toBe(1);
    expect(cam.stream(0).track.stop).not.toHaveBeenCalled();
    expect(onCapture).toHaveBeenLastCalledWith('');
  });
});
