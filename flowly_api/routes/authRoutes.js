const express = require('express');
const router = express.Router();
const authController = require('../controllers/authController.js');
const emailController = require('../controllers/emailController.js');

router.post('/registrar', authController.registrar);
router.post('/login', authController.login);
router.get('/users', authController.listarUsers);

// Rotas de autenticação em dois fatores
router.post('/2fa/enviar-codigo', emailController.enviarCodigoVerificacao);
router.post('/2fa/validar-codigo', emailController.validarCodigoVerificacao);
router.get('/2fa/validar-token', emailController.validarTokenVerificacao);
router.post('/recuperar-senha/enviar-codigo', emailController.enviarCodigoRecuperacaoSenha);
router.post('/recuperar-senha/validar-codigo', emailController.validarCodigoRecuperacaoSenha);
router.post('/recuperar-senha/redefinir', emailController.redefinirSenhaComCodigo);

module.exports = router;

