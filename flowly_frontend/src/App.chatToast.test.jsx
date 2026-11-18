import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import App from './App';
import apiClient from './config/apiClient';
import { API_ENDPOINTS, LOCAL_STORAGE_KEYS } from './config/config';

// C1: o toast de chat muda o estado do AppContent. Isso nao pode desmontar a pagina protegida
// (antes, o ProtectedRoute era recriado a cada render e o Perfil inteiro remontava: webcam reiniciada,
// perfil buscado de novo, fotos e campos digitados perdidos).

const handlersDoSocket = {};

vi.mock('./components/backgrounds/LightRays', () => ({ __esModule: true, default: () => null }));
vi.mock('./components/text/CurvedLoop', () => ({ __esModule: true, default: () => null }));
vi.mock('./config/socketClient', () => ({
  __esModule: true,
  default: () => ({
    on: vi.fn((evento, fn) => { handlersDoSocket[evento] = fn; }),
    off: vi.fn(),
    emit: vi.fn(),
    disconnect: vi.fn(),
    connected: false,
  }),
}));
vi.mock('./config/apiClient', () => ({
  __esModule: true,
  FACE_API_TIMEOUT_MS: 1000,
  default: {
    get: vi.fn(),
    post: vi.fn(() => new Promise(() => {})),
    put: vi.fn(() => new Promise(() => {})),
    delete: vi.fn(() => new Promise(() => {})),
  },
  getFullApiUrl: (path) => path,
}));

let streams;
let playOriginal;

const novoStream = (id) => {
  const track = { id, readyState: 'live', onended: null, stop: vi.fn(() => { track.readyState = 'ended'; }) };
  return { id, track, getTracks: () => [track], getVideoTracks: () => [track] };
};

const aberturasDaCamera = () => navigator.mediaDevices.getUserMedia.mock.calls.length;
const consultasDePerfil = () => apiClient.get.mock.calls.filter(([url]) => url === API_ENDPOINTS.USER_ME).length;

const entrarComo = (tipo) => {
  localStorage.setItem(LOCAL_STORAGE_KEYS.TOKEN, 'token-de-teste');
  localStorage.setItem(LOCAL_STORAGE_KEYS.USER_TYPE, tipo);
  localStorage.setItem(LOCAL_STORAGE_KEYS.USER_ID, `${tipo}-1`);
  localStorage.setItem(LOCAL_STORAGE_KEYS.USER_NAME, 'Pessoa');
};

const notificar = (notificacao) => act(async () => { handlersDoSocket.notification_created(notificacao); });
const esperar = (ms) => act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)); });

beforeEach(() => {
  streams = [];
  localStorage.clear();
  Object.keys(handlersDoSocket).forEach((evento) => delete handlersDoSocket[evento]);
  playOriginal = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = vi.fn(() => Promise.resolve());
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: {
      getUserMedia: vi.fn(async () => {
        const stream = novoStream(`s${streams.length + 1}`);
        streams.push(stream);
        return stream;
      }),
    },
  });
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage: vi.fn() });
  vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue('data:image/jpeg;base64,FOTO');
  apiClient.get.mockReset();
  apiClient.get.mockImplementation((url) => {
    if (url === API_ENDPOINTS.USER_ME) {
      return Promise.resolve({ data: { nome: 'Pessoa', email: 'pessoa@teste.com', tipo: 'admin' } });
    }
    if (url === API_ENDPOINTS.FACE_STATUS) return Promise.resolve({ data: { enrolled: false } });
    if (url === '/tarefas/minhas') return Promise.resolve({ data: [] });
    return new Promise(() => {});
  });
});

afterEach(() => {
  HTMLMediaElement.prototype.play = playOriginal;
  delete navigator.mediaDevices;
  vi.restoreAllMocks();
});

describe('C1 - toast de chat nao remonta o Perfil', () => {
  test.each(['admin', 'user'])('%s em /perfil: toast aparece e some; pagina, webcam, foto e campos continuam', async (tipo) => {
    entrarComo(tipo);
    window.history.pushState({}, '', '/perfil');
    render(<App />);

    await waitFor(() => expect(aberturasDaCamera()).toBe(1));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Capturar foto de frente' })).toBeEnabled());
    await esperar(50);

    // Estado que o usuario ja produziu na pagina.
    fireEvent.click(screen.getByRole('button', { name: 'Capturar foto de frente' }));
    expect(screen.getByText(/Foto 1\/2/)).toBeInTheDocument();
    const campoNome = document.querySelector('.perfil-card input[type="text"]');
    fireEvent.change(campoNome, { target: { value: 'Nome em edicao' } });
    fireEvent.change(document.getElementById('face-senha-atual'), { target: { value: 'senha-digitada' } });

    const pagina = document.querySelector('.perfil-page');
    const videoAntes = document.querySelector('video.face-capture-video');
    const consultasAntes = consultasDePerfil();

    const confere = () => {
      expect(document.querySelector('.perfil-page')).toBe(pagina);
      expect(pagina.isConnected).toBe(true);
      expect(document.querySelector('video.face-capture-video')).toBe(videoAntes);
      expect(aberturasDaCamera()).toBe(1);
      expect(streams[0].track.stop).not.toHaveBeenCalled();
      expect(videoAntes.srcObject).toBe(streams[0]);
      expect(consultasDePerfil()).toBe(consultasAntes);
      expect(screen.getByText(/Foto 1\/2/)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Capturar foto levemente de lado' })).toBeEnabled();
      expect(document.querySelector('.perfil-card input[type="text"]')).toHaveValue('Nome em edicao');
      expect(document.getElementById('face-senha-atual')).toHaveValue('senha-digitada');
    };

    await notificar({ _id: 'n1', tipo: 'chat', texto: 'Mensagem do time' });
    expect(await screen.findByText('Mensagem do time')).toBeInTheDocument();
    confere();

    // O toast some sozinho depois de 2 s: outra mudanca de estado no AppContent.
    await esperar(2200);
    expect(screen.queryByText('Mensagem do time')).not.toBeInTheDocument();
    confere();
  }, 15000);

  test('notificacao que nao e de chat nao mostra toast e nao mexe na pagina', async () => {
    entrarComo('admin');
    window.history.pushState({}, '', '/perfil');
    render(<App />);
    await waitFor(() => expect(aberturasDaCamera()).toBe(1));
    await esperar(50);
    const pagina = document.querySelector('.perfil-page');
    const consultasAntes = consultasDePerfil();

    await notificar({ _id: 'n2', tipo: 'tarefa', texto: 'Tarefa atualizada' });
    await esperar(50);

    expect(screen.queryByText('Tarefa atualizada')).not.toBeInTheDocument();
    expect(pagina.isConnected).toBe(true);
    expect(aberturasDaCamera()).toBe(1);
    expect(consultasDePerfil()).toBe(consultasAntes);
  });
});
