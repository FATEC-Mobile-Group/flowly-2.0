// Envio de mensagem do chat com confirmação do servidor (ACK do Socket.IO).
// Nunca reenvia sozinho: sem confirmação, o resultado é "incerto" e quem decide é a pessoa.
export const CHAT_SEND_TIMEOUT_MS = 10000;

export const CHAT_SEND_MESSAGES = {
  offline: 'Sem conexão com o chat no momento. Seu texto foi mantido; tente de novo quando a conexão voltar.',
  uncertain:
    'Não recebemos a confirmação do servidor. Confira se a mensagem apareceu no chat antes de enviar de novo.',
  error: 'Não foi possível enviar a mensagem agora. Seu texto foi mantido; tente novamente.',
  blocked: 'Sua mensagem não foi enviada porque viola as regras do chat. Revise o texto e tente novamente.',
};

export const CHAT_SEND_TITLES = {
  blocked: 'Mensagem bloqueada',
  error: 'Mensagem não enviada',
  offline: 'Mensagem não enviada',
  uncertain: 'Envio não confirmado',
};

// Resolve com { status: 'sent' | 'blocked' | 'error' | 'offline' | 'uncertain', message?, messageId? }.
export const sendChatMessage = (socket, payload, { timeoutMs = CHAT_SEND_TIMEOUT_MS } = {}) =>
  new Promise((resolve) => {
    if (!socket || !socket.connected) {
      resolve({ status: 'offline', message: CHAT_SEND_MESSAGES.offline });
      return;
    }

    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      socket.off?.('message_blocked', onLegacyBlocked);
      socket.off?.('disconnect', onDisconnect);
      resolve(result);
    };
    // Servidor anterior ao ACK: recusas chegam só por message_blocked.
    function onLegacyBlocked(response) {
      const blocked = !['team_access_denied', 'invalid_user'].includes(response?.reason);
      finish({
        status: blocked ? 'blocked' : 'error',
        message: response?.message || (blocked ? CHAT_SEND_MESSAGES.blocked : CHAT_SEND_MESSAGES.error),
      });
    }
    // A conexão caiu depois do envio: a mensagem pode ou não ter sido gravada.
    function onDisconnect() {
      finish({ status: 'uncertain', message: CHAT_SEND_MESSAGES.uncertain });
    }

    socket.on('message_blocked', onLegacyBlocked);
    socket.on('disconnect', onDisconnect);

    socket.timeout(timeoutMs).emit('send_message', payload, (error, response) => {
      if (error) {
        finish({ status: 'uncertain', message: CHAT_SEND_MESSAGES.uncertain });
        return;
      }
      if (response?.ok) {
        finish({ status: 'sent', messageId: response.messageId });
        return;
      }
      if (response?.blocked) {
        finish({ status: 'blocked', message: response.message || CHAT_SEND_MESSAGES.blocked });
        return;
      }
      finish({ status: 'error', message: response?.message || CHAT_SEND_MESSAGES.error });
    });
  });
