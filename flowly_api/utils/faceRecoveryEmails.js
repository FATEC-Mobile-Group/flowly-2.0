const sendEmail = require('./sendEmail');

const escapeHtml = (value = '') =>
  String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);

const layout = (title, body) => `<!DOCTYPE html><html><head><meta charset="utf-8"/>
  <style>
  body{background:#f4f1fb;margin:0;font-family:Arial,sans-serif;color:#2D1B3D}
  .wrap{max-width:600px;margin:24px auto;background:#fff;border:1px solid #8B5CF6;border-radius:12px;overflow:hidden}
  .head{background:#6D28D9;color:#fff;padding:18px 24px;font-size:20px;font-weight:bold}
  .content{padding:24px}
  .code{font-size:28px;letter-spacing:6px;font-weight:bold;margin:16px 0}
  .alert{background:#FFF3E0;border:1px solid #FFB74D;border-radius:8px;padding:12px 16px;margin:16px 0}
  </style></head><body><div class="wrap"><div class="head">${title}</div><div class="content">${body}</div></div></body></html>`;

// Enviado quando um operador inicia a recuperacao excepcional: o titular repassa o codigo ao operador.
const sendOwnershipCodeEmail = (user, code, { minutes }) =>
  sendEmail(
    user.email,
    'Flowly • Confirmação de titularidade para recuperação facial',
    null,
    layout(
      'Flowly • Recuperação da verificação facial',
      `<p>Olá <strong>${escapeHtml(user.nome)}</strong>,</p>
      <p>O suporte do Flowly iniciou uma recuperação excepcional da verificação facial desta conta.</p>
      <div class="code">${code}</div>
      <p>Informe este código ao operador <strong>somente se foi você quem pediu a recuperação</strong>. Ele vale por ${minutes} minutos.</p>
      <div class="alert">Se você não pediu, não informe o código a ninguém e altere sua senha.</div>`
    )
  );

const sendRecoveryCodeEmail = (user, code, { minutes }) =>
  sendEmail(
    user.email,
    'Flowly • Código para recadastrar a verificação facial',
    null,
    layout(
      'Flowly • Recadastro da verificação facial',
      `<p>Olá <strong>${escapeHtml(user.nome)}</strong>,</p>
      <p>Use o código abaixo, junto com sua senha atual, para recadastrar o rosto desta conta:</p>
      <div class="code">${code}</div>
      <p>O código vale por ${minutes} minutos e só funciona uma vez.</p>
      <div class="alert">Se você não pediu, ignore este e-mail e altere sua senha.</div>`
    )
  );

const sendRecoveryCompletedEmail = (user) =>
  sendEmail(
    user.email,
    'Flowly • Verificação facial recadastrada',
    null,
    layout(
      'Flowly • Verificação facial recadastrada',
      `<p>Olá <strong>${escapeHtml(user.nome)}</strong>,</p>
      <p>A verificação facial desta conta foi recadastrada e as sessões abertas antes foram encerradas.</p>
      <p>Entre novamente com e-mail, senha e o novo rosto.</p>
      <div class="alert">Se não foi você, procure o suporte do Flowly imediatamente.</div>`
    )
  );

module.exports = {
  escapeHtml,
  sendOwnershipCodeEmail,
  sendRecoveryCodeEmail,
  sendRecoveryCompletedEmail,
};
