import apiClient, { getFullApiUrl } from '../config/apiClient';
import { UPLOAD_ACCEPT, describeUploadError, validateUploadFile } from './uploadErrors';

// Anexos no chat da equipe (contrato: flowly_api/controllers/chatAttachmentController.js).
// Formatos e limite sao os mesmos do backend (PNG, JPEG e PDF, ate 10 MB); a API continua validando tudo.

export const CHAT_ATTACHMENT_ACCEPT = UPLOAD_ACCEPT;
export const CHAT_UPLOAD_TIMEOUT_MS = 120000;
export const IMAGE_TYPES = new Set(['image/png', 'image/jpeg']);

export const validateChatFile = (file) => validateUploadFile(file);

export const isImageAttachment = (anexo) => IMAGE_TYPES.has(anexo?.mimetype);

// Mensagem antiga (sem tipo) continua sendo texto.
export const isAttachmentMessage = (message) => message?.tipo === 'anexo' && Boolean(message?.anexo);

const hex = (bytes) => Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');

// UUID v4 em minusculas, como o backend exige.
export const newClientMessageId = () => {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID().toLowerCase();
  }
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const h = hex(bytes);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
};

export const formatBytes = (bytes) => {
  const value = Number(bytes) || 0;
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1).replace('.', ',')} MB`;
};

export const buildAttachmentForm = ({ file, clientMessageId, legenda }) => {
  const form = new FormData();
  form.append('clientMessageId', clientMessageId);
  if (legenda) form.append('legenda', legenda);
  form.append('file', file);
  return form;
};

// Upload autenticado (o apiClient injeta o JWT). Sem retry automatico: quem repete e a pessoa, com o mesmo id.
export const uploadChatAttachment = ({ equipeId, form, signal, onProgress }) => apiClient.post(
  `/equipes/${equipeId}/mensagens/anexos`,
  form,
  {
    signal,
    timeout: CHAT_UPLOAD_TIMEOUT_MS,
    onUploadProgress: (event) => {
      if (!onProgress) return;
      const total = event?.total;
      onProgress(total ? Math.min(100, Math.round((event.loaded / total) * 100)) : null);
    },
  },
);

// So os caminhos que o backend gera para o anexo; qualquer outra coisa no payload e ignorada.
const ATTACHMENT_PATH = /^\/api\/equipes\/[a-f\d]{24}\/mensagens\/[a-f\d]{24}\/anexo(\?disposition=inline)?$/i;

export const resolveAttachmentUrl = (path) => (typeof path === 'string' && ATTACHMENT_PATH.test(path)
  ? getFullApiUrl(path)
  : null);

// Arquivo como Blob pela requisicao autenticada (JWT no cabecalho, nunca na URL).
export const fetchAttachmentBlob = async (path, { signal } = {}) => {
  const url = resolveAttachmentUrl(path);
  if (!url) {
    const error = new Error('invalid_attachment_path');
    error.code = 'invalid_attachment_path';
    throw error;
  }
  const res = await apiClient.get(url, { responseType: 'blob', signal, timeout: CHAT_UPLOAD_TIMEOUT_MS });
  return res.data;
};

// Nome para salvar: sem caminho nem caracteres que o sistema de arquivos recusa.
export const safeDownloadName = (name) => {
  const base = String(name || '').split(/[\\/]/).pop().replace(/[\u0000-\u001f\u007f<>:"|?*]/g, '').trim();
  return base || 'arquivo';
};

export const isCanceledRequest = (error) => error?.name === 'CanceledError' || error?.code === 'ERR_CANCELED';

const notice = (kind, title, message) => ({ kind, title, message });

// Erros do upload: os do backend de anexos (409, 404, legenda) e os gerais de upload (uploadErrors.js).
export const describeChatUploadError = (error) => {
  if (isCanceledRequest(error)) {
    return notice(
      'warning',
      'Envio cancelado',
      'O envio foi interrompido. Se o arquivo já tinha chegado ao servidor, ele aparecerá no chat; enviar de novo não duplica.',
    );
  }
  const status = error?.response?.status;
  const data = error?.response?.data && typeof error.response.data === 'object' ? error.response.data : {};
  if (status === 422 && data.codigo === 'caption_blocked') {
    return notice('blocked', 'Legenda não aceita', data.erro || 'Revise a legenda e tente novamente.');
  }
  if (status === 409) {
    return notice(
      'error',
      'Envio em conflito',
      'Este envio já tinha sido registrado com outro conteúdo. Envie novamente para criar um novo envio.',
    );
  }
  if (status === 404) {
    return notice('error', 'Chat indisponível', 'Você não tem mais acesso a esta equipe ou ela não existe.');
  }
  if (status === 401) {
    return notice('error', 'Sessão encerrada', 'Entre novamente para enviar arquivos.');
  }
  const base = describeUploadError(error, 'Não foi possível enviar o arquivo.');
  return notice(base.kind === 'unavailable' ? 'warning' : base.kind, base.title, base.message);
};

// Erros ao abrir ou baixar: a resposta chega como Blob, entao a mensagem sai do status.
export const describeAttachmentFetchError = (error) => {
  if (isCanceledRequest(error)) return null;
  const status = error?.response?.status;
  // Caminho fora do padrao do backend: nada foi requisitado, entao nao e falha de conexao.
  if (error?.code === 'invalid_attachment_path') {
    return notice('error', 'Arquivo indisponível', 'Este anexo não está mais disponível.');
  }
  if (!error?.response) {
    return notice('warning', 'Falha de conexão', 'Não foi possível carregar o arquivo. Verifique sua conexão e tente novamente.');
  }
  if (status === 404) return notice('error', 'Arquivo indisponível', 'Este anexo não está mais disponível.');
  if (status === 401 || status === 403) return notice('error', 'Acesso negado', 'Você não tem acesso a este anexo.');
  if (status === 503) {
    return notice('warning', 'Armazenamento indisponível', 'Não foi possível acessar o arquivo agora. Tente novamente em instantes.');
  }
  return notice('error', 'Falha ao carregar', 'Não foi possível carregar o arquivo.');
};

const timeOf = (message) => {
  const time = new Date(message?.createdAt).getTime();
  return Number.isFinite(time) ? time : Number.POSITIVE_INFINITY;
};

// Uma lista so, sem duplicar por _id (a resposta HTTP do upload e o evento do socket trazem a mesma mensagem),
// em ordem cronologica. Mensagem repetida substitui a anterior (mesmo conteudo, payload mais recente).
export const mergeMessages = (current, incoming) => {
  const list = [...current];
  const index = new Map(list.map((message, position) => [message?._id, position]));
  for (const message of Array.isArray(incoming) ? incoming : [incoming]) {
    if (!message) continue;
    const position = message._id ? index.get(message._id) : undefined;
    if (position !== undefined) {
      list[position] = message;
    } else {
      if (message._id) index.set(message._id, list.length);
      list.push(message);
    }
  }
  return list
    .map((message, position) => ({ message, position }))
    .sort((a, b) => (timeOf(a.message) - timeOf(b.message)) || (a.position - b.position))
    .map(({ message }) => message);
};
