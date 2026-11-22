import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import TarefaModal from './TarefaModal';

const { apiGet, apiPost } = vi.hoisted(() => ({ apiGet: vi.fn(), apiPost: vi.fn() }));

vi.mock('../../config/apiClient', () => ({
  __esModule: true,
  default: { get: apiGet, post: apiPost, put: vi.fn() },
  getFullApiUrl: (path) => path,
}));

const TAREFA_ID = '507f1f77bcf86cd799439021';
const detalhes = { tarefa: { _id: TAREFA_ID, descricao: 'Revisar relatório', anexos: [] }, comentarios: [], logs: [] };

const arquivo = (nome, tipo, tamanho = 64) => new File([new Uint8Array(tamanho)], nome, { type: tipo });
const respostaHttp = (status, data) => Object.assign(new Error(`HTTP ${status}`), { response: { status, data } });

const abrirAnexos = async () => {
  render(<TarefaModal tarefaId={TAREFA_ID} onClose={() => {}} />);
  fireEvent.click(await screen.findByRole('button', { name: /Anexos/ }));
};
const escolher = (file) => fireEvent.change(screen.getByLabelText('Arquivo do anexo'), { target: { files: [file] } });
const enviar = async () => {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Fazer Upload' }));
  });
};

describe('TarefaModal: avisos de upload', () => {
  let alertSpy;

  beforeEach(() => {
    apiGet.mockReset();
    apiPost.mockReset();
    apiGet.mockResolvedValue({ data: detalhes });
    alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {});
  });

  afterEach(() => {
    alertSpy.mockRestore();
  });

  test('arquivo bloqueado: mostra o motivo no formulário, sem alert, e mantém o arquivo', async () => {
    apiPost.mockRejectedValue(respostaHttp(422, {
      erro: 'O arquivo foi bloqueado porque parece conter conteúdo não permitido na plataforma.',
      codigo: 'upload_blocked',
      categorias: ['hate_symbols'],
      debug: 'detalhe interno',
    }));
    await abrirAnexos();
    escolher(arquivo('foto.png', 'image/png'));
    await enviar();

    const aviso = screen.getByRole('alert');
    expect(within(aviso).getByText('Arquivo bloqueado')).toBeInTheDocument();
    expect(within(aviso).getByText(/conteúdo não permitido/)).toBeInTheDocument();
    expect(aviso).not.toHaveTextContent('detalhe interno');
    expect(alertSpy).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Fazer Upload' })).toBeEnabled();
  });

  test('verificação indisponível (503): aviso próprio e permite tentar de novo', async () => {
    apiPost.mockRejectedValueOnce(respostaHttp(503, {
      erro: 'Não foi possível verificar a segurança do arquivo agora. Ele não foi enviado; tente novamente em alguns instantes.',
      codigo: 'moderation_unavailable',
    }));
    await abrirAnexos();
    escolher(arquivo('foto.png', 'image/png'));
    await enviar();

    const aviso = screen.getByRole('alert');
    expect(aviso).toHaveClass('unavailable');
    expect(within(aviso).getByText('Verificação indisponível')).toBeInTheDocument();

    apiPost.mockResolvedValueOnce({ data: { msg: 'Anexo adicionado com sucesso' } });
    await enviar();

    expect(apiPost).toHaveBeenCalledTimes(2);
    expect(screen.getByRole('status')).toHaveTextContent('Anexo enviado');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  test('arquivo inválido na API (422 invalid_file) usa o título de arquivo inválido', async () => {
    apiPost.mockRejectedValue(respostaHttp(422, {
      erro: 'O conteúdo do arquivo não corresponde ao tipo informado.',
      codigo: 'invalid_file',
    }));
    await abrirAnexos();
    escolher(arquivo('foto.png', 'image/png'));
    await enviar();

    expect(within(screen.getByRole('alert')).getByText('Arquivo inválido')).toBeInTheDocument();
  });

  test.each([
    ['tipo não permitido', arquivo('animacao.gif', 'image/gif'), 'Tipo de arquivo não permitido'],
    ['acima de 10 MB', arquivo('grande.pdf', 'application/pdf', 10 * 1024 * 1024 + 1), 'Arquivo muito grande'],
    ['extensão trocada', arquivo('foto.pdf', 'image/png'), 'Tipo de arquivo não permitido'],
  ])('%s: avisa na hora e não envia', async (_caso, file, titulo) => {
    await abrirAnexos();
    escolher(file);

    expect(within(screen.getByRole('alert')).getByText(titulo)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Fazer Upload' })).toBeDisabled();
    expect(apiPost).not.toHaveBeenCalled();
  });

  test('falha de conexão: aviso de conexão, sem alert', async () => {
    apiPost.mockRejectedValue(new Error('Network Error'));
    await abrirAnexos();
    escolher(arquivo('ata.pdf', 'application/pdf'));
    await enviar();

    expect(within(screen.getByRole('alert')).getByText('Falha de conexão')).toBeInTheDocument();
    expect(alertSpy).not.toHaveBeenCalled();
  });

  test('envio aceito recarrega os detalhes e limpa a escolha', async () => {
    apiPost.mockResolvedValue({ data: { msg: 'Anexo adicionado com sucesso' } });
    await abrirAnexos();
    escolher(arquivo('ata.pdf', 'application/pdf'));
    await enviar();

    await waitFor(() => expect(apiGet).toHaveBeenCalledTimes(2));
    expect(screen.getByRole('button', { name: 'Fazer Upload' })).toBeDisabled();
  });
});
