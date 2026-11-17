const express = require('express');
const router = express.Router();
const auth = require('../middlewares/auth');
const ensureObjectBody = require('../middlewares/ensureObjectBody');
const faceController = require('../controllers/faceController');
const faceRecoveryController = require('../controllers/faceRecoveryController');
const {
  codeValidationLimiter,
  emailCodeLimiter,
  faceVerifyLimiter,
  sensitivePasswordActionLimiter,
} = require('../middlewares/rateLimiters');

router.use(ensureObjectBody);

router.get('/health', faceController.health);

router.post('/enroll', faceController.enrollWithSession);
router.post('/verify', faceController.requireFaceVerifySession, faceVerifyLimiter, faceController.verifyWithSession);
router.post('/skip-enrollment', faceController.skipEnrollment);

// Recuperacao excepcional: so produz efeito com autorizacao ativa do operador (scripts/faceRecovery.js).
router.post('/recovery/send-code', emailCodeLimiter, faceRecoveryController.sendRecoveryCode);
router.post('/recovery/re-enroll', codeValidationLimiter, faceRecoveryController.reenroll);

router.get('/status', auth, faceController.getStatus);
router.post('/enroll-profile', auth, sensitivePasswordActionLimiter, faceController.enrollFromProfile);

module.exports = router;
