import { act, fireEvent, render, screen } from '@testing-library/react';
import PerfilUser from './PerfilUser';

const { apiGet, apiPut } = vi.hoisted(() => ({ apiGet: vi.fn(), apiPut: vi.fn() }));

vi.mock('../../config/apiClient', () => ({
  __esModule: true,
  default: { get: apiGet, put: apiPut, post: vi.fn() },
  getFullApiUrl: (path) => path,
}));
vi.mock('../../components/layout/Sidebar', () => ({ __esModule: true, default: () => null }));
vi.mock('../../components/face/FaceProfileEnroll', () => ({ __esModule: true, default: () => null }));

const respostaHttp = (status, data) => Object.assign(new Error(`HTTP ${status}`), { response: { status, data } });
const foto = (nome = 'eu.png', tipo = 'image/png') => new File([new Uint8Array(64)], nome, { type: tipo });

const abrirPerfil = async () => {
  render(<PerfilUser />);
  await screen.findByDisplayValue('Ana');
};
const escolherFoto = (file) => {
  const input = document.querySelector('input[type="file"]');
  fireEvent.change(input, { target: { files: [file] } });
};
const salvar = async () => {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Salvar Perfil' }));
  });
};

describe('PerfilUser: avisos da foto de perfil', () => {
  beforeEach(() => {
    apiGet.mockReset();
    apiPut.mockReset();
    apiGet.mockImplementation(async (url) => (String(url).includes('face')
      ? { data: { enrolled: false } }
      : { data: { nome: 'Ana', email: 'ana@exemplo.com', tipo: 'user', fotoPerfil: '' } }));
  });

  test('foto bloqueada: mostra a mensagem da API e nunca o campo debug', async () => {
    apiPut.mockRejectedValue(respostaHttp(422, {
      erro: 'O arquivo foi bloqueado porque parece conter conteúdo não permitido na plataforma.',
      detalhe: 'O arquivo foi bloqueado porque parece conter conteúdo não permitido na plataforma.',
      codigo: 'upload_blocked',
      debug: 'Google Vision retornou HTTP 500: detalhe interno',
    }));
    await abrirPerfil();
    escolherFoto(foto());
    await salvar();

    expect(screen.getByText(/conteúdo não permitido na plataforma/)).toBeInTheDocument();
    expect(screen.queryByText(/detalhe interno/)).not.toBeInTheDocument();
  });

  test('verificação indisponível: explica que é temporário', async () => {
    apiPut.mockRejectedValue(respostaHttp(503, {
      erro: 'Não foi possível verificar a segurança do arquivo agora. Ele não foi enviado; tente novamente em alguns instantes.',
      codigo: 'moderation_unavailable',
    }));
    await abrirPerfil();
    escolherFoto(foto());
    await salvar();

    expect(screen.getByText(/tente novamente em alguns instantes/)).toBeInTheDocument();
  });

  test('PDF como foto: avisa na hora e não envia o arquivo', async () => {
    apiPut.mockResolvedValue({ data: { user: { nome: 'Ana', fotoPerfil: '' } } });
    await abrirPerfil();
    escolherFoto(foto('documento.pdf', 'application/pdf'));

    expect(screen.getByText('Envie uma imagem PNG ou JPG.')).toBeInTheDocument();
    await salvar();
    const formData = apiPut.mock.calls[0][1];
    expect(formData.get('fotoPerfil')).toBeNull();
  });
});
