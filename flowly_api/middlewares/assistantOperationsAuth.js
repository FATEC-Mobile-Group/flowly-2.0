const crypto = require('crypto');

// Credencial interna exclusiva das rotas de confirmacao do assistente (/api/assistant/operations).
// So o servico do assistente a conhece; o navegador nunca chama estas rotas (nada de VITE_*).
//
// - ASSISTANT_OPERATIONS_SECRET ausente, vazio ou curto demais: 503 (fail-closed), sem tocar em mais nada.
//   Minimo de 43 caracteres: a menor forma textual comum de 32 bytes aleatorios (base64url sem padding; base64
//   tem 44 e hex 64). Gere com, por exemplo, crypto.randomBytes(32).toString('base64url').
// - Cabecalho ausente ou diferente: 401, antes da autenticacao do usuario e de qualquer acesso ao banco.
// - Comparacao em tempo constante sobre resumos HMAC de tamanho fixo: nem o conteudo nem o tamanho do segredo
//   vazam pelo tempo de resposta.
// - Nunca registra o segredo recebido nem o configurado.
const SECRET_ENV = 'ASSISTANT_OPERATIONS_SECRET';
const SECRET_HEADER = 'X-Assistant-Operations-Secret';
const MIN_SECRET_LENGTH = 43;
const COMPARE_KEY = crypto.randomBytes(32);
let avisoConfiguracaoEmitido = false;

const digest = (value) => crypto.createHmac('sha256', COMPARE_KEY).update(String(value)).digest();

const secretMatches = (expected, received) => {
  if (typeof received !== 'string' || !received) return false;
  return crypto.timingSafeEqual(digest(expected), digest(received));
};

const requireAssistantOperationsSecret = (req, res, next) => {
  const expected = String(process.env[SECRET_ENV] || '').trim();
  if (expected.length < MIN_SECRET_LENGTH) {
    // Mesma resposta para ausente e curto (nao revela qual); aviso uma vez por processo, sem o conteudo.
    if (!avisoConfiguracaoEmitido) {
      avisoConfiguracaoEmitido = true;
      console.error(`[assistant-operations] ${SECRET_ENV} ausente ou com menos de ${MIN_SECRET_LENGTH} caracteres`);
    }
    return res.status(503).json({ ok: false, code: 'assistant_operations_not_configured' });
  }
  if (!secretMatches(expected, req.get(SECRET_HEADER))) {
    return res.status(401).json({ ok: false, code: 'assistant_secret_invalid' });
  }
  return next();
};

module.exports = { requireAssistantOperationsSecret, SECRET_ENV, SECRET_HEADER, MIN_SECRET_LENGTH };
