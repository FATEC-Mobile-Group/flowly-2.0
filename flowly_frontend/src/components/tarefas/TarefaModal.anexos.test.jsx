import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import TarefaModal from './TarefaModal';
import { LOCAL_STORAGE_KEYS } from '../../config/config';

const { apiGet, apiDelete } = vi.hoisted(() => ({ apiGet: vi.fn(), apiDelete: vi.fn() }));

vi.mock('../../config/apiClient', () => ({
  __esModule: true,
  default: { get: apiGet, post: vi.fn(), put: vi.fn(), delete: apiDelete },
  getFullApiUrl: (path) => path,
}));

const TAREFA_ID = '507f1f77bcf86cd799439021';
const ANA = { _id: '507f1f77bcf86cd799439011', nome: 'Ana' };
const BRUNO = { _id: '507f1f77bcf86cd799439012', nome: 'Bruno' };

const anexoDaAna = {
  _id: 'a1', nomeOriginal: 'relatório final.pdf', mimetype: 'application/pdf', size: 2.5 * 1024 * 1024,
  url: '/api/storage/files/x?token=t', uploadedBy: ANA, uploadedAt: '2026-11-20T13:30:00.000Z',
};
const anexoDoBruno = {
  _id: 'b1', nomeOriginal: 'foto.png', mimetype: 'image/png', size: 2048,
  url: '/api/storage/files/y?token=t', uploadedBy: BRUNO, uploadedAt: '2026-11-21T09:00:00.000Z',
};
const anexoAntigo = { _id: 'c1', nomeOriginal: 'antigo.png', mimetype: 'image/png', size: 500, url: '/api/storage/files/z?token=t' };

const detalhes = (anexos) => ({ data: { tarefa: { _id: TAREFA_ID, descricao: 'Revisar', anexos }, comentarios: [], logs: [] } });
const respostaHttp = (status, data) => Object.assign(new Error(`HTTP ${status}`), { response: { status, data } });

const abrirAnexos = async () => {
  render(<TarefaModal tarefaId={TAREFA_ID} onClose={() => {}} />);
  fireEvent.click(await screen.findByRole('button', { name: /Anexos/ }));
};
const linha = (nome) => screen.getByText(nome).closest('li');

describe('TarefaModal: lista, download e remoção de anexos', () => {
  beforeEach(() => {
    localStorage.setItem(LOCAL_STORAGE_KEYS.USER_ID, ANA._id);
    apiGet.mockReset();
    apiDelete.mockReset();
    apiGet.mockResolvedValue(detalhes([anexoDaAna, anexoDoBruno, anexoAntigo]));
  });

  afterEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  test('mostra nome, tamanho, autor e data; antigo aparece sem autoria', async () => {
    await abrirAnexos();

    expect(within(linha('relatório final.pdf')).getByText(/2,5 MB · Você ·/)).toBeInTheDocument();
    expect(within(linha('foto.png')).getByText(/2 KB · Bruno ·/)).toBeInTheDocument();
    expect(within(linha('antigo.png')).getByText('500 B · Autor não registrado')).toBeInTheDocument();
  });

  test('lixeira aparece só nos anexos do usuário atual; download em todos', async () => {
    await abrirAnexos();

    expect(within(linha('relatório final.pdf')).getByRole('button', { name: 'Remover relatório final.pdf' })).toBeInTheDocument();
    expect(within(linha('foto.png')).queryByRole('button', { name: /Remover/ })).not.toBeInTheDocument();
    expect(within(linha('antigo.png')).queryByRole('button', { name: /Remover/ })).not.toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /^Baixar / })).toHaveLength(3);
  });

  test('remoção pede confirmação; cancelar não chama a API', async () => {
    await abrirAnexos();
    fireEvent.click(screen.getByRole('button', { name: 'Remover relatório final.pdf' }));

    const confirmacao = screen.getByRole('group', { name: 'Confirmar remoção de relatório final.pdf' });
    expect(within(confirmacao).getByText('Remover este anexo?')).toBeInTheDocument();
    fireEvent.click(within(confirmacao).getByRole('button', { name: 'Cancelar' }));

    expect(apiDelete).not.toHaveBeenCalled();
    expect(screen.queryByRole('group', { name: /Confirmar remoção/ })).not.toBeInTheDocument();
  });

  test('remoção confirmada chama a rota do anexo, avisa e recarrega a lista', async () => {
    apiDelete.mockResolvedValue({ data: { msg: 'Anexo removido' } });
    await abrirAnexos();
    apiGet.mockResolvedValue(detalhes([anexoDoBruno, anexoAntigo]));

    fireEvent.click(screen.getByRole('button', { name: 'Remover relatório final.pdf' }));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Remover' }));
    });

    expect(apiDelete).toHaveBeenCalledWith(`/tarefas/${TAREFA_ID}/anexos/a1`);
    expect(screen.getByRole('status')).toHaveTextContent('Anexo removido');
    await waitFor(() => expect(screen.queryByText('relatório final.pdf')).not.toBeInTheDocument());
  });

  test.each([
    [503, { erro: 'Não foi possível remover o arquivo agora. O anexo foi mantido; tente novamente.' }, 'Armazenamento indisponível'],
    [403, { erro: 'Somente quem enviou o anexo pode removê-lo.' }, 'Remoção não permitida'],
  ])('falha %s na remoção: avisa e mantém o anexo', async (status, corpo, titulo) => {
    apiDelete.mockRejectedValue(respostaHttp(status, corpo));
    await abrirAnexos();

    fireEvent.click(screen.getByRole('button', { name: 'Remover relatório final.pdf' }));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Remover' }));
    });

    const aviso = screen.getByRole('alert');
    expect(within(aviso).getByText(titulo)).toBeInTheDocument();
    expect(within(aviso).getByText(corpo.erro)).toBeInTheDocument();
    expect(screen.getByText('relatório final.pdf')).toBeInTheDocument();
  });

  test('download pede o arquivo pela API autenticada e salva com o nome original', async () => {
    const blob = new Blob(['%PDF'], { type: 'application/pdf' });
    URL.createObjectURL = vi.fn(() => 'blob:anexo');
    URL.revokeObjectURL = vi.fn();
    const nomes = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function registrar() {
      nomes.push(this.download);
    });
    await abrirAnexos();
    apiGet.mockResolvedValueOnce({ data: blob });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Baixar foto.png' }));
    });

    expect(apiGet).toHaveBeenLastCalledWith(`/tarefas/${TAREFA_ID}/anexos/b1/download`, { responseType: 'blob' });
    expect(URL.createObjectURL).toHaveBeenCalledWith(blob);
    expect(nomes).toEqual(['foto.png']);
  });

  test('download de anexo que sumiu: aviso claro', async () => {
    await abrirAnexos();
    apiGet.mockRejectedValueOnce(respostaHttp(404, new Blob(['{}'])));

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Baixar antigo.png' }));
    });

    expect(within(screen.getByRole('alert')).getByText('Arquivo não encontrado')).toBeInTheDocument();
  });
});
