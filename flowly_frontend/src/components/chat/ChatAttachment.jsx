import React, { useEffect, useRef, useState } from 'react';
import { FaDownload, FaFileImage, FaFilePdf, FaTimes } from 'react-icons/fa';
import {
  describeAttachmentFetchError,
  fetchAttachmentBlob,
  formatBytes,
  isImageAttachment,
  safeDownloadName,
} from '../../utils/chatAttachments';

// Visualizacao dos anexos do chat. Todo arquivo vem pela requisicao autenticada (Blob) e vira uma URL local
// (blob:), liberada com URL.revokeObjectURL quando o componente sai da tela. Nada vai para localStorage.

// Carrega a imagem so quando ela chega perto da area visivel (sem IntersectionObserver, carrega na hora).
const useNearViewport = (ref) => {
  const [visible, setVisible] = useState(typeof window === 'undefined' || !('IntersectionObserver' in window));
  useEffect(() => {
    if (visible || !ref.current) return undefined;
    const observer = new window.IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        setVisible(true);
        observer.disconnect();
      }
    }, { rootMargin: '200px' });
    observer.observe(ref.current);
    return () => observer.disconnect();
  }, [ref, visible]);
  return visible;
};

// URL local de um anexo autenticado. Liberada ao desmontar ou ao trocar de arquivo; cancelada se sair antes.
export const useAuthorizedObjectUrl = (path, enabled) => {
  const [state, setState] = useState({ url: null, error: null, loading: false });
  useEffect(() => {
    if (!enabled || !path) return undefined;
    const controller = new AbortController();
    let objectUrl = null;
    setState({ url: null, error: null, loading: true });
    fetchAttachmentBlob(path, { signal: controller.signal })
      .then((blob) => {
        objectUrl = URL.createObjectURL(blob);
        setState({ url: objectUrl, error: null, loading: false });
      })
      .catch((error) => {
        if (controller.signal.aborted) return;
        setState({ url: null, error: describeAttachmentFetchError(error), loading: false });
      });
    return () => {
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [path, enabled]);
  return state;
};

// Baixa pela rota autenticada e salva com o nome original sanitizado. A URL local dura so o clique.
export const downloadAttachment = async (anexo) => {
  const blob = await fetchAttachmentBlob(anexo.downloadUrl);
  const url = URL.createObjectURL(blob);
  try {
    const link = document.createElement('a');
    link.href = url;
    link.download = safeDownloadName(anexo.nomeOriginal);
    link.rel = 'noopener';
    document.body.appendChild(link);
    link.click();
    link.remove();
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
};

const DownloadButton = ({ anexo, onError }) => {
  const [downloading, setDownloading] = useState(false);
  const baixar = async () => {
    if (downloading) return;
    setDownloading(true);
    try {
      await downloadAttachment(anexo);
    } catch (error) {
      const aviso = describeAttachmentFetchError(error);
      if (aviso) onError?.(aviso);
    } finally {
      setDownloading(false);
    }
  };
  return (
    <button
      type="button"
      className="chat-attachment-download"
      onClick={baixar}
      disabled={downloading}
      aria-label={`Baixar ${anexo.nomeOriginal}`}
      title="Baixar"
    >
      <FaDownload aria-hidden="true" />
      <span>{downloading ? 'Baixando...' : 'Baixar'}</span>
    </button>
  );
};

const AttachmentImage = ({ anexo, onOpen, onError }) => {
  const boxRef = useRef(null);
  const visible = useNearViewport(boxRef);
  const { url, error, loading } = useAuthorizedObjectUrl(anexo.previewUrl, visible);

  return (
    <div className="chat-attachment-image" ref={boxRef}>
      {url ? (
        <button
          type="button"
          className="chat-attachment-thumb"
          onClick={() => onOpen({ url, anexo })}
          aria-label={`Ampliar imagem ${anexo.nomeOriginal}`}
        >
          <img src={url} alt={anexo.nomeOriginal} />
        </button>
      ) : (
        <div className="chat-attachment-placeholder" role={error ? 'alert' : 'status'}>
          <FaFileImage aria-hidden="true" />
          <span>{error ? error.message : loading ? 'Carregando imagem...' : 'Imagem'}</span>
        </div>
      )}
      <div className="chat-attachment-meta">
        <span className="chat-attachment-name" title={anexo.nomeOriginal}>{anexo.nomeOriginal}</span>
        <span className="chat-attachment-size">{formatBytes(anexo.size)}</span>
        <DownloadButton anexo={anexo} onError={onError} />
      </div>
    </div>
  );
};

// PDF e outros documentos: so card e download (sem renderizar o conteudo inline).
const AttachmentFile = ({ anexo, onError }) => (
  <div className="chat-attachment-file">
    <span className="chat-attachment-icon"><FaFilePdf aria-hidden="true" /></span>
    <div className="chat-attachment-info">
      <span className="chat-attachment-name" title={anexo.nomeOriginal}>{anexo.nomeOriginal}</span>
      <span className="chat-attachment-size">{formatBytes(anexo.size)}</span>
    </div>
    <DownloadButton anexo={anexo} onError={onError} />
  </div>
);

export const AttachmentContent = ({ message, onOpenImage, onError }) => (
  <div className="chat-attachment">
    {isImageAttachment(message.anexo)
      ? <AttachmentImage anexo={message.anexo} onOpen={onOpenImage} onError={onError} />
      : <AttachmentFile anexo={message.anexo} onError={onError} />}
    {message.texto ? <p className="chat-attachment-caption">{message.texto}</p> : null}
  </div>
);

// Imagem ampliada: dialogo modal, foco no botao de fechar, Escape fecha e o foco volta para quem abriu.
export const AttachmentLightbox = ({ image, onClose }) => {
  const closeRef = useRef(null);
  useEffect(() => {
    const opener = document.activeElement;
    closeRef.current?.focus();
    const onKey = (event) => {
      if (event.key === 'Escape') onClose();
      if (event.key === 'Tab') {
        event.preventDefault();
        closeRef.current?.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      if (opener && typeof opener.focus === 'function') opener.focus();
    };
  }, [onClose]);

  return (
    <div className="chat-lightbox" role="dialog" aria-modal="true" aria-label={`Imagem ${image.anexo.nomeOriginal}`} onClick={onClose}>
      <div className="chat-lightbox-content" onClick={(event) => event.stopPropagation()}>
        <button ref={closeRef} type="button" className="chat-lightbox-close" onClick={onClose} aria-label="Fechar imagem">
          <FaTimes aria-hidden="true" />
        </button>
        <img src={image.url} alt={image.anexo.nomeOriginal} />
        <span className="chat-lightbox-caption">{image.anexo.nomeOriginal}</span>
      </div>
    </div>
  );
};

// Arquivo escolhido, antes do envio: miniatura local (imagem) ou icone (PDF), nome, tamanho e acoes.
export const ComposerAttachmentPreview = ({ draft, progress, uploading, onRemove, onReplace, onCancel }) => (
  <div className="chat-composer-attachment" aria-live="polite">
    {draft.localUrl ? (
      <img className="chat-composer-thumb" src={draft.localUrl} alt="" />
    ) : (
      <span className="chat-attachment-icon"><FaFilePdf aria-hidden="true" /></span>
    )}
    <div className="chat-attachment-info">
      <span className="chat-attachment-name" title={draft.file.name}>{draft.file.name}</span>
      <span className="chat-attachment-size">{formatBytes(draft.file.size)}</span>
      {uploading && (
        <div className="chat-upload-progress">
          <div
            className="chat-upload-bar"
            role="progressbar"
            aria-label={`Enviando ${draft.file.name}`}
            aria-valuemin={0}
            aria-valuemax={100}
            {...(progress == null ? { 'aria-valuetext': 'Enviando' } : { 'aria-valuenow': progress })}
          >
            <span style={{ width: `${progress ?? 100}%` }} className={progress == null ? 'indeterminado' : ''} />
          </div>
          <span className="chat-upload-percent">{progress == null ? 'Enviando...' : `${progress}%`}</span>
        </div>
      )}
    </div>
    {uploading ? (
      <button type="button" className="chat-composer-action" onClick={onCancel} aria-label={`Cancelar envio de ${draft.file.name}`}>
        Cancelar
      </button>
    ) : (
      <>
        <button type="button" className="chat-composer-action" onClick={onReplace} aria-label="Trocar arquivo">
          Trocar
        </button>
        <button type="button" className="chat-composer-action" onClick={onRemove} aria-label="Remover arquivo selecionado">
          <FaTimes aria-hidden="true" />
        </button>
      </>
    )}
  </div>
);
