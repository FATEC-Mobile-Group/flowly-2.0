const express = require('express');
const router = express.Router();
const auth = require('../middlewares/auth');
const faceController = require('../controllers/faceController');
const { faceVerifyLimiter, sensitivePasswordActionLimiter } = require('../middlewares/rateLimiters');

router.get('/health', faceController.health);

router.post('/enroll', faceController.enrollWithSession);
router.post('/verify', faceController.requireFaceVerifySession, faceVerifyLimiter, faceController.verifyWithSession);
router.post('/skip-enrollment', faceController.skipEnrollment);

router.get('/status', auth, faceController.getStatus);
router.post('/enroll-profile', auth, sensitivePasswordActionLimiter, faceController.enrollFromProfile);

module.exports = router;
