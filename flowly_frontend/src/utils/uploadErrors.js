// Mensagens de upload (anexos e foto de perfil).
// A conferência local só antecipa o aviso: a API continua validando tipo, assinatura, tamanho e conteúdo.
export const UPLOAD_MAX_BYTES = 10 * 1024 * 1024;

const ALLOWED_TYPES = {
  'image/png': ['.png'],
  'image/jpeg': ['.jpg', '.jpeg'],
  'application/pdf': ['.pdf'],
};
const IMAGE_TYPES = ['image/png', 'image/jpeg'];

export const UPLOAD_ACCEPT = '.png,.jpg,.jpeg,.pdf,image/png,image/jpeg,application/pdf';

const notice = (kind, title, message) => ({ kind, title, message });

const extensionOf = (name = '') => {
  const index = name.lastIndexOf('.');
  return index >= 0 ? name.slice(index).toLowerCase() : '';
};

// Devolve um aviso quando o arquivo certamente seria recusado; null quando pode seguir para a API.
export const validateUploadFile = (file, { imagesOnly = false } = {}) => {
  if (!file) return null;
  if (!file.size) {
    return notice('invalid', 'Arquivo inválido', 'O arquivo está vazio.');
  }
  if (file.size > UPLOAD_MAX_BYTES) {
    return notice('invalid', 'Arquivo muito grande', 'O arquivo excede o limite de 10 MB.');
  }
  const allowedTypes = imagesOnly ? IMAGE_TYPES : Object.keys(ALLOWED_TYPES);
  const extensions = ALLOWED_TYPES[file.type];
  if (!allowedTypes.includes(file.type) || !extensions?.includes(extensionOf(file.name))) {
    return notice(
      'invalid',
      'Tipo de arquivo não permitido',
      imagesOnly ? 'Envie uma imagem PNG ou JPG.' : 'Envie um arquivo PNG, JPG ou PDF.',
    );
  }
  return null;
};

const serverMessage = (data) => [data?.erro, data?.error]
  .find((value) => typeof value === 'string' && value.trim());

// Traduz a resposta da API em aviso. Nunca exibe campos técnicos (debug, stack).
export const describeUploadError = (error, fallback = 'Não foi possível enviar o arquivo.') => {
  const response = error?.response;
  if (!response) {
    return notice(
      'unavailable',
      'Falha de conexão',
      'Não foi possível enviar o arquivo. Verifique sua conexão e tente novamente.',
    );
  }

  const data = response.data && typeof response.data === 'object' ? response.data : {};
  const message = serverMessage(data);

  switch (response.status) {
    case 422:
      return data.codigo === 'upload_blocked'
        ? notice('blocked', 'Arquivo bloqueado', message || 'O arquivo contém conteúdo não permitido.')
        : notice('invalid', 'Arquivo inválido', message || 'O arquivo não pôde ser aceito.');
    case 503:
      return notice(
        'unavailable',
        'Verificação indisponível',
        message || 'Não foi possível verificar a segurança do arquivo agora. Tente novamente em alguns instantes.',
      );
    case 413:
      return notice('invalid', 'Arquivo muito grande', 'O arquivo excede o limite de 10 MB.');
    case 400:
      return notice('invalid', 'Arquivo não aceito', message || 'Envie um arquivo PNG, JPG ou PDF.');
    case 429:
      return notice('unavailable', 'Muitos envios', message || 'Aguarde alguns minutos e tente novamente.');
    default:
      return notice('error', 'Falha no envio', message || fallback);
  }
};
