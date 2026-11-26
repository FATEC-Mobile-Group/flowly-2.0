// Mesmo limite do backend (flowly_api/utils/equipeDescricao.js).
export const LIMITE_DESCRICAO_EQUIPE = 300;

// Na edicao, a descricao so vai no corpo quando mudou: abrir e salvar uma equipe antiga nao cria o campo, e o
// backend preserva a descricao quando o campo nao vem (clientes antigos). Na criacao, so quando ha texto.
export function montarDadosEquipe({ nome, membrosIds, descricao, descricaoOriginal, editando }) {
  const dados = { nome, membros: Array.from(new Set(membrosIds)) };
  const texto = String(descricao || "").trim();
  if (editando ? texto !== String(descricaoOriginal || "").trim() : texto !== "") dados.descricao = texto;
  return dados;
}
