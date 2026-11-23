// Content-Disposition com o nome original: fallback ASCII sem aspas/controle e filename* em UTF-8 (RFC 5987).
// Usado nos downloads privados de anexos (tarefas e chat). `inline` so quando quem chama ja restringiu o tipo.
const montarContentDisposition = (nome, { inline = false } = {}) => {
  const original = String(nome || 'arquivo');
  const fallback = original.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_').trim() || 'arquivo';
  const utf8 = encodeURIComponent(original)
    .replace(/['()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${inline ? 'inline' : 'attachment'}; filename="${fallback}"; filename*=UTF-8''${utf8}`;
};

module.exports = { montarContentDisposition };
