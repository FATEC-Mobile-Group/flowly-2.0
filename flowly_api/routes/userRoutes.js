const express = require('express');
const router = express.Router();
const auth = require('../middlewares/auth');
const upload = require('../middlewares/upload');
const userController = require('../controllers/userController');

router.use(auth);

router.get('/search', userController.searchUsers);
router.get('/', userController.listarUsers);
router.get('/me', userController.me);
router.get('/me/photo-url', userController.obterUrlAssinadaFotoPerfil);
router.put('/me', upload.single('fotoPerfil'), userController.atualizarPerfil);
router.put('/me/password', userController.atualizarSenha);

module.exports = router;
