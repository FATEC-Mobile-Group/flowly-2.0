import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import ChatsPage from './ChatsPage';
import { LOCAL_STORAGE_KEYS } from '../../config/config';
import { mergeMessages, resolveAttachmentUrl, safeDownloadName } from '../../utils/chatAttachments';

// Anexos no chat web: selecao, pre-visualizacao, envio com progresso, cancelamento, repeticao com o mesmo
// clientMessageId, deduplicacao (HTTP + socket), download e pre-visualizacao autenticados, erros e reconexao.
// HTTP, socket e URLs locais sao simulados: nenhum upload sai da maquina.

const { apiGet, apiPost, createSocket } = vi.hoisted(() => ({
  apiGet: vi.fn(),
  apiPost: vi.fn(),
  createSocket: vi.fn(),
}));

vi.mock('../../config/apiClient', () => ({
  __esModule: true,
  default: { get: apiGet, post: apiPost },
  getFullApiUrl: (path) => `http://api.test${path}`,
}));

vi.mock('../../config/socketClient', () => ({ __esModule: true, default: createSocket }));
vi.mock('../../components/layout/Sidebar', () => ({ __esModule: true, default: () => null }));

const ME = { _id: '507f1f77bcf86cd799439011', nome: 'Ana', fotoPerfil: '' };
const OTHER = { _id: '507f1f77bcf86cd799439012', nome: 'Bruno', fotoPerfil: '' };
const EQUIPE_ID = '507f1f77bcf86cd799439013';
const OUTRA_EQUIPE_ID = '507f1f77bcf86cd799439014';
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const anexoUrl = (messageId, inline = false) =>
  `/api/equipes/${EQUIPE_ID}/mensagens/${messageId}/anexo${inline ? '?disposition=inline' : ''}`;

const textoAntigo = { _id: 'aaaaaaaaaaaaaaaaaaaaaaa1', texto: 'Mensagem antiga\ncom quebra', createdAt: '2026-11-20T10:00:00.000Z', user: OTHER };
const imagemNoHistorico = {
  _id: 'bbbbbbbbbbbbbbbbbbbbbbb1',
  tipo: 'anexo',
  texto: 'print da tela',
  createdAt: '2026-11-20T10:05:00.000Z',
  user: OTHER,
  anexo: {
    nomeOriginal: 'tela.png', mimetype: 'image/png', size: 2048, enviadoEm: '2026-11-20T10:05:00.000Z',
    downloadUrl: anexoUrl('bbbbbbbbbbbbbbbbbbbbbbb1'), previewUrl: anexoUrl('bbbbbbbbbbbbbbbbbbbbbbb1', true),
  },
};
const pdfNoHistorico = {
  _id: 'ccccccccccccccccccccccc1',
  tipo: 'anexo',
  texto: '',
  createdAt: '2026-11-20T10:06:00.000Z',
  user: ME,
  anexo: {
    nomeOriginal: 'ata final.pdf', mimetype: 'application/pdf', size: 3 * 1024 * 1024, enviadoEm: '2026-11-20T10:06:00.000Z',
    downloadUrl: anexoUrl('ccccccccccccccccccccccc1'),
  },
};

const respostaDoServidor = (id, nome, mimetype, texto = '') => ({
  _id: id,
  tipo: 'anexo',
  texto,
  createdAt: '2026-11-23T12:00:00.000Z',
  user: ME,
  clientMessageId: 'ignorado',
  anexo: {
    nomeOriginal: nome, mimetype, size: 100, enviadoEm: '2026-11-23T12:00:00.000Z',
    downloadUrl: anexoUrl(id), ...(mimetype.startsWith('image/') ? { previewUrl: anexoUrl(id, true) } : {}),
  },
});

const createFakeSocket = () => {
  const handlers = {};
  const socket = {
    connected: true,
    on: vi.fn((event, handler) => { handlers[event] = [...(handlers[event] || []), handler]; }),
    off: vi.fn((event, handler) => { handlers[event] = (handlers[event] || []).filter((h) => h !== handler); }),
    emit: vi.fn(),
    disconnect: vi.fn(),
    trigger: (event, ...args) => (handlers[event] || []).forEach((handler) => handler(...args)),
  };
  socket.timeout = vi.fn(() => ({ emit: socket.emit }));
  return socket;
};

const arquivo = (nome, tipo, tamanho = 100) => {
  const file = new File([new Uint8Array(Math.min(tamanho, 1024))], nome, { type: tipo });
  if (tamanho > 1024) Object.defineProperty(file, 'size', { value: tamanho });
  return file;
};
const respostaHttp = (status, data) => Object.assign(new Error(`HTTP ${status}`), { response: { status, data } });
const formOf = (call) => call[1];
const idDoEnvio = (call) => formOf(call).get('clientMessageId');

describe('ChatsPage: anexos no chat', () => {
  let socket;
  let blobUrls;
  let historico;

  beforeAll(() => {
    Element.prototype.scrollIntoView = vi.fn();
  });

  afterAll(() => {
    delete Element.prototype.scrollIntoView;
  });

  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem(LOCAL_STORAGE_KEYS.USER_ID, ME._id);
    apiGet.mockReset();
    apiPost.mockReset();
    createSocket.mockReset();
    socket = createFakeSocket();
    createSocket.mockReturnValue(socket);
    historico = [textoAntigo];
    apiGet.mockImplementation(async (url, options) => {
      if (url.startsWith('http://api.test/api/equipes/')) {
        return { data: new Blob(['conteudo'], { type: 'application/octet-stream' }) };
      }
      // Historico inicial vem com ?limit (PR #67); so a sincronizacao de reconexao usa ?after.
      if (url.includes('/messages')) return { data: options?.params?.after ? [] : historico };
      return { data: [{ _id: EQUIPE_ID, nome: 'Equipe Alfa', membros: [ME, OTHER] }, { _id: OUTRA_EQUIPE_ID, nome: 'Equipe Beta', membros: [ME] }] };
    });
    let seq = 0;
    blobUrls = { created: [], revoked: [] };
    URL.createObjectURL = vi.fn(() => {
      seq += 1;
      const url = `blob:flowly-${seq}`;
      blobUrls.created.push(url);
      return url;
    });
    URL.revokeObjectURL = vi.fn((url) => blobUrls.revoked.push(url));
  });

  afterEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  const abrirChat = async () => {
    const view = render(<ChatsPage />);
    await screen.findByText(/Mensagem antiga/);
    return view;
  };
  const inputArquivo = () => screen.getByTestId('chat-file-input');
  const escolher = (file) => fireEvent.change(inputArquivo(), { target: { files: [file] } });
  const campo = () => screen.getByRole('textbox');
  const enviar = async () => {
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^(Enviar|Enviando\.\.\.)$/ }));
    });
  };
  const aviso = () => screen.getByRole('alert');

  describe('historico e renderizacao', () => {
    test('mensagens antigas (sem tipo) continuam como texto, com quebra de linha e autor', async () => {
      await abrirChat();

      const bolha = screen.getByText(/Mensagem antiga/);
      expect(bolha).toHaveClass('chat-bubble');
      expect(bolha.textContent).toBe('Mensagem antiga\ncom quebra');
      expect(screen.getByText('Bruno')).toBeInTheDocument();
    });

    test('imagem do historico: miniatura por requisicao autenticada (Blob) e legenda; PDF sem legenda vira card', async () => {
      historico = [textoAntigo, imagemNoHistorico, pdfNoHistorico];
      await abrirChat();

      const miniatura = await screen.findByRole('img', { name: 'tela.png' });
      expect(miniatura.getAttribute('src')).toMatch(/^blob:flowly-/);
      expect(apiGet).toHaveBeenCalledWith(
        `http://api.test${anexoUrl(imagemNoHistorico._id, true)}`,
        expect.objectContaining({ responseType: 'blob' }),
      );
      expect(screen.getByText('print da tela')).toBeInTheDocument();
      expect(screen.getByText('ata final.pdf')).toBeInTheDocument();
      expect(screen.getByText('3,0 MB')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Baixar ata final.pdf' })).toBeInTheDocument();
      // PDF nunca e carregado inline.
      expect(apiGet.mock.calls.some(([url]) => url.includes(pdfNoHistorico._id))).toBe(false);
      // JWT nunca na URL.
      expect(apiGet.mock.calls.every(([url]) => !/token=/.test(url))).toBe(true);
    });

    test('caminho de anexo fora do padrao do backend nao e requisitado', async () => {
      historico = [textoAntigo, { ...imagemNoHistorico, anexo: { ...imagemNoHistorico.anexo, previewUrl: 'https://outro.site/x.png' } }];
      await abrirChat();

      expect(await screen.findByText('Este anexo não está mais disponível.')).toBeInTheDocument();
      expect(apiGet.mock.calls.some(([url]) => url.includes('outro.site'))).toBe(false);
      expect(resolveAttachmentUrl('/api/storage/files/abc?token=x')).toBeNull();
    });

    test('URL local da miniatura e liberada ao sair da pagina e ao trocar de equipe', async () => {
      historico = [textoAntigo, imagemNoHistorico];
      const view = await abrirChat();
      await screen.findByRole('img', { name: 'tela.png' });
      const url = blobUrls.created[0];

      historico = [];
      fireEvent.click(screen.getByRole('button', { name: /Equipe Beta/ }));
      await waitFor(() => expect(blobUrls.revoked).toContain(url));
      view.unmount();
    });

    test('erro ao carregar a miniatura mostra estado de indisponivel', async () => {
      historico = [textoAntigo, imagemNoHistorico];
      apiGet.mockImplementation(async (url) => {
        if (url.startsWith('http://api.test/api/equipes/')) throw respostaHttp(404, new Blob());
        if (url.includes('/messages')) return { data: historico };
        return { data: [{ _id: EQUIPE_ID, nome: 'Equipe Alfa', membros: [] }] };
      });
      await abrirChat();

      expect(await screen.findByText('Este anexo não está mais disponível.')).toBeInTheDocument();
    });
  });

  describe('selecao e pre-visualizacao', () => {
    test('botao de clipe abre o seletor e o input aceita so PNG, JPEG e PDF', async () => {
      await abrirChat();
      const clickSpy = vi.spyOn(inputArquivo(), 'click');

      fireEvent.click(screen.getByRole('button', { name: /Anexar arquivo/ }));

      expect(clickSpy).toHaveBeenCalledTimes(1);
      expect(inputArquivo().getAttribute('accept')).toBe('.png,.jpg,.jpeg,.pdf,image/png,image/jpeg,application/pdf');
    });

    test.each([
      ['PNG', 'foto.png', 'image/png', true],
      ['JPEG', 'foto.jpg', 'image/jpeg', true],
      ['PDF', 'ata.pdf', 'application/pdf', false],
    ])('%s permitido: mostra nome, tamanho e miniatura local so para imagem', async (_tipo, nome, mime, imagem) => {
      await abrirChat();
      escolher(arquivo(nome, mime, 2048));

      expect(screen.getByText(nome)).toBeInTheDocument();
      expect(screen.getByText('2 KB')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Remover arquivo selecionado' })).toBeInTheDocument();
      expect(Boolean(document.querySelector('.chat-composer-thumb'))).toBe(imagem);
      expect(campo()).toHaveAttribute('placeholder', 'Adicione uma legenda (opcional)...');
      expect(apiPost).not.toHaveBeenCalled();
    });

    test.each([
      ['formato nao suportado', arquivo('anim.gif', 'image/gif'), 'Tipo de arquivo não permitido'],
      ['documento Word', arquivo('doc.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'), 'Tipo de arquivo não permitido'],
      ['acima de 10 MB', arquivo('grande.pdf', 'application/pdf', 10 * 1024 * 1024 + 1), 'Arquivo muito grande'],
    ])('%s: recusado na hora, sem envio', async (_caso, file, titulo) => {
      await abrirChat();
      fireEvent.change(campo(), { target: { value: 'texto em andamento' } });
      escolher(file);

      expect(within(aviso()).getByText(titulo)).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Remover arquivo selecionado' })).not.toBeInTheDocument();
      expect(campo()).toHaveValue('texto em andamento');
      expect(apiPost).not.toHaveBeenCalled();
    });

    test('remover o arquivo libera a miniatura local e mantem o texto', async () => {
      await abrirChat();
      fireEvent.change(campo(), { target: { value: 'legenda' } });
      escolher(arquivo('foto.png', 'image/png'));
      const local = blobUrls.created.at(-1);

      fireEvent.click(screen.getByRole('button', { name: 'Remover arquivo selecionado' }));

      expect(blobUrls.revoked).toContain(local);
      expect(screen.queryByText('foto.png')).not.toBeInTheDocument();
      expect(campo()).toHaveValue('legenda');
    });

    test('cancelar o seletor nao muda nada', async () => {
      await abrirChat();
      fireEvent.change(campo(), { target: { value: 'oi' } });
      escolher(arquivo('ata.pdf', 'application/pdf'));

      fireEvent.change(inputArquivo(), { target: { files: [] } });

      expect(screen.getByText('ata.pdf')).toBeInTheDocument();
      expect(campo()).toHaveValue('oi');
    });

    test('trocar o arquivo libera a miniatura anterior', async () => {
      await abrirChat();
      escolher(arquivo('a.png', 'image/png'));
      const primeira = blobUrls.created.at(-1);

      escolher(arquivo('b.jpg', 'image/jpeg'));

      expect(blobUrls.revoked).toContain(primeira);
      expect(screen.getByText('b.jpg')).toBeInTheDocument();
    });
  });

  describe('envio', () => {
    test('envia FormData com arquivo, legenda e clientMessageId UUID; 201 mostra a mensagem e limpa o rascunho', async () => {
      apiPost.mockResolvedValueOnce({ status: 201, data: { ok: true, duplicate: false, message: respostaDoServidor('ddddddddddddddddddddddd1', 'foto.png', 'image/png', 'olha isso') } });
      await abrirChat();
      const file = arquivo('foto.png', 'image/png');
      escolher(file);
      fireEvent.change(campo(), { target: { value: '  olha isso  ' } });

      await enviar();

      expect(apiPost).toHaveBeenCalledTimes(1);
      const [url, form, options] = apiPost.mock.calls[0];
      expect(url).toBe(`/equipes/${EQUIPE_ID}/mensagens/anexos`);
      expect(form).toBeInstanceOf(FormData);
      expect(form.get('file')).toBe(file);
      expect(form.get('legenda')).toBe('olha isso');
      expect(form.get('clientMessageId')).toMatch(UUID_V4);
      expect(options.signal).toBeInstanceOf(AbortSignal);
      expect(typeof options.onUploadProgress).toBe('function');
      expect(await screen.findByText('olha isso')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Remover arquivo selecionado' })).not.toBeInTheDocument();
      expect(campo()).toHaveValue('');
    });

    test('sem legenda: o campo legenda nao vai no FormData e a mensagem aparece so com o arquivo', async () => {
      apiPost.mockResolvedValueOnce({ status: 201, data: { ok: true, duplicate: false, message: respostaDoServidor('ddddddddddddddddddddddd2', 'ata.pdf', 'application/pdf') } });
      await abrirChat();
      escolher(arquivo('ata.pdf', 'application/pdf'));

      await enviar();

      expect(formOf(apiPost.mock.calls[0]).has('legenda')).toBe(false);
      expect(await screen.findByRole('button', { name: 'Baixar ata.pdf' })).toBeInTheDocument();
    });

    test('resposta HTTP e evento do socket do proprio envio aparecem uma vez so (qualquer ordem)', async () => {
      const mensagem = respostaDoServidor('ddddddddddddddddddddddd3', 'ata.pdf', 'application/pdf');
      apiPost.mockImplementationOnce(async () => {
        act(() => socket.trigger('receive_message', mensagem));
        return { status: 201, data: { ok: true, duplicate: false, message: mensagem } };
      });
      await abrirChat();
      escolher(arquivo('ata.pdf', 'application/pdf'));

      await enviar();
      act(() => socket.trigger('receive_message', mensagem));

      await screen.findByRole('button', { name: 'Baixar ata.pdf' });
      expect(screen.getAllByRole('button', { name: 'Baixar ata.pdf' })).toHaveLength(1);
    });

    test('HTTP 200 (repeticao reconhecida) nao duplica a mensagem que ja estava na lista', async () => {
      const mensagem = respostaDoServidor('ddddddddddddddddddddddd4', 'ata.pdf', 'application/pdf');
      historico = [textoAntigo, mensagem];
      apiPost.mockResolvedValueOnce({ status: 200, data: { ok: true, duplicate: true, message: mensagem } });
      await abrirChat();
      escolher(arquivo('ata.pdf', 'application/pdf'));

      await enviar();

      expect(screen.getAllByRole('button', { name: 'Baixar ata.pdf' })).toHaveLength(1);
    });

    test('cliques repetidos durante o envio nao geram outro upload', async () => {
      let concluir;
      apiPost.mockImplementationOnce(() => new Promise((resolve) => { concluir = resolve; }));
      await abrirChat();
      escolher(arquivo('ata.pdf', 'application/pdf'));

      await enviar();
      await enviar();
      fireEvent.submit(campo().closest('form'));

      expect(apiPost).toHaveBeenCalledTimes(1);
      await act(async () => concluir({ status: 201, data: { ok: true, message: respostaDoServidor('ddddddddddddddddddddddd5', 'ata.pdf', 'application/pdf') } }));
    });

    test('progresso acessivel e botao de cancelar durante o envio', async () => {
      let progresso;
      let concluir;
      apiPost.mockImplementationOnce((_url, _form, options) => {
        progresso = options.onUploadProgress;
        return new Promise((resolve) => { concluir = resolve; });
      });
      await abrirChat();
      escolher(arquivo('ata.pdf', 'application/pdf'));
      await enviar();

      act(() => progresso({ loaded: 40, total: 100 }));

      const barra = screen.getByRole('progressbar', { name: 'Enviando ata.pdf' });
      expect(barra).toHaveAttribute('aria-valuenow', '40');
      expect(screen.getByText('40%')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Cancelar envio de ata.pdf' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /Anexar arquivo/ })).toBeDisabled();
      await act(async () => concluir({ status: 201, data: { ok: true, message: respostaDoServidor('ddddddddddddddddddddddd6', 'ata.pdf', 'application/pdf') } }));
    });
  });

  describe('erros, cancelamento e nova tentativa', () => {
    test('422 do arquivo: aviso e arquivo e legenda mantidos para correcao', async () => {
      apiPost.mockRejectedValueOnce(respostaHttp(422, { erro: 'O arquivo foi bloqueado porque parece conter conteúdo não permitido na plataforma.', codigo: 'upload_blocked' }));
      await abrirChat();
      escolher(arquivo('foto.png', 'image/png'));
      fireEvent.change(campo(), { target: { value: 'minha legenda' } });

      await enviar();

      expect(within(aviso()).getByText('Arquivo bloqueado')).toBeInTheDocument();
      expect(screen.getByText('foto.png')).toBeInTheDocument();
      expect(campo()).toHaveValue('minha legenda');
    });

    test('422 da legenda: titulo proprio e dados mantidos', async () => {
      apiPost.mockRejectedValueOnce(respostaHttp(422, { erro: 'A legenda não foi aceita porque parece conter um insulto.', codigo: 'caption_blocked' }));
      await abrirChat();
      escolher(arquivo('ata.pdf', 'application/pdf'));
      fireEvent.change(campo(), { target: { value: 'legenda ruim' } });

      await enviar();

      expect(within(aviso()).getByText('Legenda não aceita')).toBeInTheDocument();
      expect(within(aviso()).getByText(/parece conter um insulto/)).toBeInTheDocument();
      expect(campo()).toHaveValue('legenda ruim');
    });

    test('503: aviso de indisponibilidade e nova tentativa com o MESMO clientMessageId', async () => {
      apiPost
        .mockRejectedValueOnce(respostaHttp(503, { erro: 'Não foi possível verificar a segurança do arquivo agora.', codigo: 'moderation_unavailable' }))
        .mockResolvedValueOnce({ status: 201, data: { ok: true, message: respostaDoServidor('ddddddddddddddddddddddd7', 'ata.pdf', 'application/pdf') } });
      await abrirChat();
      escolher(arquivo('ata.pdf', 'application/pdf'));

      await enviar();
      const alerta = aviso();
      expect(within(alerta).getByText('Verificação indisponível')).toBeInTheDocument();
      expect(alerta).toHaveClass('warning');
      await enviar();

      expect(apiPost).toHaveBeenCalledTimes(2);
      expect(idDoEnvio(apiPost.mock.calls[1])).toBe(idDoEnvio(apiPost.mock.calls[0]));
    });

    test('falha de conexao: mesma operacao repete o id; legenda alterada vira envio novo', async () => {
      apiPost.mockRejectedValue(new Error('Network Error'));
      await abrirChat();
      escolher(arquivo('ata.pdf', 'application/pdf'));
      fireEvent.change(campo(), { target: { value: 'v1' } });

      await enviar();
      expect(within(aviso()).getByText('Falha de conexão')).toBeInTheDocument();
      await enviar();
      fireEvent.change(campo(), { target: { value: 'v2' } });
      await enviar();

      const ids = apiPost.mock.calls.map(idDoEnvio);
      expect(ids[1]).toBe(ids[0]);
      expect(ids[2]).not.toBe(ids[0]);
      expect(ids[2]).toMatch(UUID_V4);
    });

    test('trocar o arquivo depois de uma falha gera outro clientMessageId', async () => {
      apiPost.mockRejectedValue(new Error('Network Error'));
      await abrirChat();
      escolher(arquivo('a.pdf', 'application/pdf'));
      await enviar();
      escolher(arquivo('b.pdf', 'application/pdf'));
      await enviar();

      const ids = apiPost.mock.calls.map(idDoEnvio);
      expect(ids[1]).not.toBe(ids[0]);
    });

    test('409: aviso de conflito e o proximo envio usa um id novo', async () => {
      apiPost
        .mockRejectedValueOnce(respostaHttp(409, { erro: 'conflito', codigo: 'client_message_id_conflict' }))
        .mockResolvedValueOnce({ status: 201, data: { ok: true, message: respostaDoServidor('ddddddddddddddddddddddd8', 'ata.pdf', 'application/pdf') } });
      await abrirChat();
      escolher(arquivo('ata.pdf', 'application/pdf'));

      await enviar();
      expect(within(aviso()).getByText('Envio em conflito')).toBeInTheDocument();
      await enviar();

      expect(idDoEnvio(apiPost.mock.calls[1])).not.toBe(idDoEnvio(apiPost.mock.calls[0]));
    });

    test.each([
      [413, {}, 'Arquivo muito grande'],
      [400, { erro: 'Não foi possível ler o arquivo enviado.', codigo: 'invalid_multipart' }, 'Arquivo não aceito'],
      [404, { erro: 'Equipe não encontrada' }, 'Chat indisponível'],
    ])('HTTP %s: aviso compreensivel e arquivo mantido', async (status, data, titulo) => {
      apiPost.mockRejectedValueOnce(respostaHttp(status, data));
      await abrirChat();
      escolher(arquivo('ata.pdf', 'application/pdf'));

      await enviar();

      expect(within(aviso()).getByText(titulo)).toBeInTheDocument();
      expect(screen.getByText('ata.pdf')).toBeInTheDocument();
    });

    test('cancelar aborta o upload, mantem arquivo e legenda, e repetir usa o mesmo id', async () => {
      apiPost.mockImplementationOnce((_url, _form, options) => new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(Object.assign(new Error('canceled'), { name: 'CanceledError', code: 'ERR_CANCELED' })));
      }));
      apiPost.mockResolvedValueOnce({ status: 200, data: { ok: true, duplicate: true, message: respostaDoServidor('ddddddddddddddddddddddd9', 'ata.pdf', 'application/pdf') } });
      await abrirChat();
      escolher(arquivo('ata.pdf', 'application/pdf'));
      fireEvent.change(campo(), { target: { value: 'legenda' } });

      await enviar();
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Cancelar envio de ata.pdf' }));
      });

      expect(within(aviso()).getByText('Envio cancelado')).toBeInTheDocument();
      expect(screen.getByText('ata.pdf')).toBeInTheDocument();
      expect(campo()).toHaveValue('legenda');
      await enviar();
      expect(idDoEnvio(apiPost.mock.calls[1])).toBe(idDoEnvio(apiPost.mock.calls[0]));
      expect(await screen.findByRole('button', { name: 'Baixar ata.pdf' })).toBeInTheDocument();
    });

    test('nao ha nova tentativa automatica depois de uma falha', async () => {
      apiPost.mockRejectedValue(new Error('Network Error'));
      await abrirChat();
      escolher(arquivo('ata.pdf', 'application/pdf'));

      await enviar();
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(apiPost).toHaveBeenCalledTimes(1);
    });
  });

  describe('download e ampliacao', () => {
    test('download autenticado como Blob, salvo com o nome original e URL local liberada', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      historico = [textoAntigo, pdfNoHistorico];
      const nomes = [];
      vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function registrar() { nomes.push(this.download); });
      await abrirChat();

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Baixar ata final.pdf' }));
      });

      expect(apiGet).toHaveBeenCalledWith(`http://api.test${anexoUrl(pdfNoHistorico._id)}`, expect.objectContaining({ responseType: 'blob' }));
      expect(nomes).toEqual(['ata final.pdf']);
      const url = blobUrls.created.at(-1);
      act(() => { vi.advanceTimersByTime(1500); });
      expect(blobUrls.revoked).toContain(url);
      vi.useRealTimers();
    });

    test('download indisponivel (503) mostra aviso', async () => {
      historico = [textoAntigo, pdfNoHistorico];
      await abrirChat();
      apiGet.mockImplementationOnce(async () => { throw respostaHttp(503, new Blob()); });

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Baixar ata final.pdf' }));
      });

      expect(within(aviso()).getByText('Armazenamento indisponível')).toBeInTheDocument();
    });

    test('ampliar imagem: dialogo com foco no fechar; Escape fecha e devolve o foco', async () => {
      historico = [textoAntigo, imagemNoHistorico];
      await abrirChat();
      const abrir = await screen.findByRole('button', { name: 'Ampliar imagem tela.png' });
      abrir.focus();

      fireEvent.click(abrir);

      const dialogo = screen.getByRole('dialog', { name: 'Imagem tela.png' });
      expect(dialogo).toHaveAttribute('aria-modal', 'true');
      expect(within(dialogo).getByRole('button', { name: 'Fechar imagem' })).toHaveFocus();
      fireEvent.keyDown(document, { key: 'Escape' });
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      expect(abrir).toHaveFocus();
    });
  });

  describe('socket e reconexao', () => {
    test('mensagem de outra pessoa pelo socket aparece; repetida nao duplica', async () => {
      await abrirChat();
      const mensagem = { _id: 'eeeeeeeeeeeeeeeeeeeeeee1', texto: 'nova pelo socket', createdAt: '2026-11-23T12:00:00.000Z', user: OTHER };

      act(() => socket.trigger('receive_message', mensagem));
      act(() => socket.trigger('receive_message', mensagem));

      expect(screen.getAllByText('nova pelo socket')).toHaveLength(1);
    });

    test('reconexao busca o que chegou depois da ultima mensagem (?after=) e mescla sem duplicar', async () => {
      await abrirChat();
      act(() => socket.trigger('connect'));
      const perdida = { _id: 'eeeeeeeeeeeeeeeeeeeeeee2', texto: 'chegou durante a queda', createdAt: '2026-11-21T09:00:00.000Z', user: OTHER };
      apiGet.mockImplementation(async (url, options) => {
        if (url.includes('/messages')) return { data: options?.params?.after ? [textoAntigo, perdida] : historico };
        return { data: [] };
      });

      await act(async () => socket.trigger('connect'));

      expect(apiGet).toHaveBeenCalledWith(`/equipes/${EQUIPE_ID}/messages`, { params: { after: textoAntigo.createdAt } });
      expect(await screen.findByText('chegou durante a queda')).toBeInTheDocument();
      expect(screen.getAllByText(/Mensagem antiga/)).toHaveLength(1);
    });

    test('primeira conexao nao faz sincronizacao extra', async () => {
      await abrirChat();
      act(() => socket.trigger('connect'));

      expect(apiGet.mock.calls.filter(([, options]) => options?.params?.after)).toHaveLength(0);
    });
  });

  describe('chat de texto continua igual', () => {
    test('sem anexo, o envio vai pelo socket com ACK e nao chama o upload', async () => {
      await abrirChat();
      fireEvent.change(campo(), { target: { value: 'Bom dia' } });

      await enviar();

      expect(socket.emit).toHaveBeenCalledWith('send_message', { equipeId: EQUIPE_ID, texto: 'Bom dia' }, expect.any(Function));
      expect(apiPost).not.toHaveBeenCalled();
      await act(async () => socket.emit.mock.calls.at(-1)[2](null, { ok: true, messageId: 'm1' }));
      expect(campo()).toHaveValue('');
    });

    test('com anexo escolhido, o mesmo botao envia o anexo (nao a mensagem de texto)', async () => {
      apiPost.mockResolvedValueOnce({ status: 201, data: { ok: true, message: respostaDoServidor('fffffffffffffffffffffff1', 'ata.pdf', 'application/pdf', 'legenda') } });
      await abrirChat();
      escolher(arquivo('ata.pdf', 'application/pdf'));
      fireEvent.change(campo(), { target: { value: 'legenda' } });

      await enviar();

      expect(apiPost).toHaveBeenCalledTimes(1);
      expect(socket.emit.mock.calls.some(([event]) => event === 'send_message')).toBe(false);
    });

    test('nomes acessiveis do campo e do botao de anexo', async () => {
      await abrirChat();

      expect(screen.getByRole('textbox', { name: 'Mensagem' })).toBeInTheDocument();
      escolher(arquivo('ata.pdf', 'application/pdf'));
      expect(screen.getByRole('textbox', { name: 'Legenda do arquivo' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Anexar arquivo (PNG, JPG ou PDF, até 10 MB)' })).toBeEnabled();
    });
  });
});

describe('utilitarios de anexos', () => {
  test('mergeMessages: sem duplicar por _id e em ordem cronologica', () => {
    const a = { _id: '1', createdAt: '2026-11-20T10:00:00.000Z', texto: 'a' };
    const b = { _id: '2', createdAt: '2026-11-20T11:00:00.000Z', texto: 'b' };
    const bAtualizada = { ...b, texto: 'b2' };

    expect(mergeMessages([b], [a, b]).map((m) => m._id)).toEqual(['1', '2']);
    expect(mergeMessages([a, b], bAtualizada)).toEqual([a, bAtualizada]);
    expect(mergeMessages([a], { texto: 'sem id' })).toHaveLength(2);
  });

  test('safeDownloadName remove caminho e caracteres invalidos', () => {
    expect(safeDownloadName('..\\pasta/re:la*tó?rio.pdf')).toBe('relatório.pdf');
    expect(safeDownloadName('')).toBe('arquivo');
  });
});
