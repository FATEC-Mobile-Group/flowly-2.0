const express = require('express');
const router = express.Router();
const authController = require('../controllers/authController.js');
const emailController = require('../controllers/emailController.js');
const auth = require('../middlewares/auth');
const {
  loginLimiter,
  registerLimiter,
  emailCodeLimiter,
  codeValidationLimiter,
} = require('../middlewares/rateLimiters');

router.post('/registrar', registerLimiter, authController.registrar);
router.post('/login', loginLimiter, authController.login);
router.get('/users', auth, authController.listarUsers);

// Rotas de autenticação em dois fatores
router.post('/2fa/enviar-codigo', emailCodeLimiter, emailController.enviarCodigoVerificacao);
router.post('/2fa/validar-codigo', codeValidationLimiter, emailController.validarCodigoVerificacao);
router.get('/2fa/validar-token', codeValidationLimiter, emailController.validarTokenVerificacao);
router.post('/recuperar-senha/enviar-codigo', emailCodeLimiter, emailController.enviarCodigoRecuperacaoSenha);
router.post('/recuperar-senha/validar-codigo', codeValidationLimiter, emailController.validarCodigoRecuperacaoSenha);
router.post('/recuperar-senha/redefinir', codeValidationLimiter, emailController.redefinirSenhaComCodigo);

module.exports = router;

