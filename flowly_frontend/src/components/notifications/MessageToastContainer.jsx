import React from 'react';
import { getFullApiUrl } from '../../config/apiClient';
import '../../styles/components/MessageToastContainer.css';

const getInitials = (name = 'Usuario') =>
  name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0])
    .join('')
    .toUpperCase();

function MessageToastContainer({ toasts = [] }) {
  if (toasts.length === 0) return null;

  return (
    <div className="message-toast-container" aria-live="polite" aria-atomic="false">
      {toasts.map((toast) => {
        const metadata = toast.metadata || {};
        const senderName = metadata.senderName || 'Usuario';
        const senderPhoto = metadata.senderPhoto;
        const teamName = metadata.equipeNome || metadata.teamName || '';
        const messageText = metadata.messageText || toast.texto || 'Nova mensagem recebida.';

        return (
          <article className="message-toast" key={toast.toastId || toast._id}>
            <div className="message-toast-avatar" aria-label={senderName}>
              {senderPhoto ? (
                <img src={getFullApiUrl(senderPhoto)} alt="" />
              ) : (
                <span>{getInitials(senderName)}</span>
              )}
            </div>
            <div className="message-toast-content">
              <strong>{senderName}</strong>
              {teamName && <span className="message-toast-team">{teamName}</span>}
              <p>{messageText}</p>
            </div>
          </article>
        );
      })}
    </div>
  );
}

export default MessageToastContainer;
