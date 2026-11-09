const express = require('express');
const router = express.Router();
const auth = require('../middlewares/auth');
const upload = require('../middlewares/upload');
const moderateUpload = require('../middlewares/moderateUpload');
const userController = require('../controllers/userController');
const { isAdmin } = require('../middlewares/roles');
const { sensitivePasswordActionLimiter } = require('../middlewares/rateLimiters');
const ensureObjectBody = require('../middlewares/ensureObjectBody');

router.use(auth);

router.get('/search', isAdmin, userController.searchUsers);
router.get('/', isAdmin, userController.listarUsers);
router.get('/me', userController.me);
router.put('/me', ensureObjectBody, upload.single('fotoPerfil'), moderateUpload('profile_image'), userController.atualizarPerfil);
router.put('/me/password', ensureObjectBody, sensitivePasswordActionLimiter, userController.atualizarSenha);

module.exports = router;
