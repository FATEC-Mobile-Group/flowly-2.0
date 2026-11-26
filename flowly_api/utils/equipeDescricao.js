// Descricao opcional da equipe (aditiva). Ausente no corpo = nao mexe no valor gravado (clientes antigos nao
// enviam o campo e nao apagam descricoes existentes); texto vazio ou null = remove a descricao.
const LIMITE_DESCRICAO_EQUIPE = 300;

const MENSAGEM_DESCRICAO_INVALIDA = 'A descrição da equipe deve ser um texto.';
const MENSAGEM_DESCRICAO_LONGA = `A descrição da equipe deve ter no máximo ${LIMITE_DESCRICAO_EQUIPE} caracteres.`;

// { ausente: true } | { valor: '' | 'texto' } | { erro }
const lerDescricaoEquipe = (valor) => {
  if (valor === undefined) return { ausente: true };
  if (valor === null) return { valor: '' };
  if (typeof valor !== 'string') return { erro: MENSAGEM_DESCRICAO_INVALIDA };
  const texto = valor.replace(/\r\n?/g, '\n').trim();
  if (texto.length > LIMITE_DESCRICAO_EQUIPE) return { erro: MENSAGEM_DESCRICAO_LONGA };
  return { valor: texto };
};

module.exports = {
  LIMITE_DESCRICAO_EQUIPE,
  MENSAGEM_DESCRICAO_INVALIDA,
  MENSAGEM_DESCRICAO_LONGA,
  lerDescricaoEquipe,
};
