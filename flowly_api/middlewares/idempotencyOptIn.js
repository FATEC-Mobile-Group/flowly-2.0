// Idempotencia opcional: so quando o cliente envia Idempotency-Key a requisicao vai para o caminho protegido.
// Sem o cabecalho, segue para o handler legado, sem nenhuma mudanca de comportamento para as telas.
// Cabecalho presente mas vazio ou malformado tambem vai para o caminho protegido, que responde 400: um cliente
// que pediu idempotencia nunca cai silenciosamente no caminho sem protecao.
const comIdempotenciaOpcional = (handlerProtegido) => (req, res, next) => {
  if (req.get('Idempotency-Key') === undefined) {
    return next();
  }
  return handlerProtegido(req, res, next);
};

module.exports = { comIdempotenciaOpcional };
