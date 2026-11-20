const ActivityLog = require('../models/ActivityLog');

// Sem options.session (todos os usos legados): falha so vai para o console e o fluxo segue, como sempre foi.
// Com options.session (caminho transacional idempotente): o log entra na mesma transacao e um erro SOBE, para
// abortar tudo junto (tarefa, log e conclusao da chave). Nada e engolido nesse caminho.
const logActivity = async (tipoAcao, detalhes, user, tarefa, options = {}) => {
  const session = options && options.session;
  if (session) {
    const log = new ActivityLog({ tipoAcao, detalhes, user, tarefa });
    await log.save({ session });
    return;
  }

  try {
    const log = new ActivityLog({
      tipoAcao,
      detalhes,
      user,
      tarefa
    });
    await log.save();
  } catch (error) {
    console.error('Erro ao registrar log de atividade:', error);
  }
};

module.exports = logActivity;
