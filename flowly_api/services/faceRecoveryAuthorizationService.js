const config = require('../config/config');
const User = require('../models/User');
const FaceProfile = require('../models/FaceProfile');
const FaceRecoveryAuthorization = require('../models/FaceRecoveryAuthorization');
const { generateSecurityCode, hashSecurityCode, matchesSecurityCode } = require('../utils/securityCodes');
const { sendOwnershipCodeEmail } = require('../utils/faceRecoveryEmails');
const { recordSecurityEvent } = require('../utils/securityAudit');

// Autorizacao excepcional, usada pelo operador via scripts/faceRecovery.js (nunca exposta por HTTP).
// 1. request: o operador registra quem e por que; o codigo de titularidade vai ao e-mail da conta.
// 2. confirm: o titular repassa o codigo ao operador por outro canal; a autorizacao fica ativa por pouco tempo.
// O operador nunca ve o codigo enviado: so o titular, que controla o e-mail da conta.

const OWNERSHIP_PURPOSE = 'face_recovery_ownership';
const OBJECT_ID_PATTERN = /^[a-f\d]{24}$/i;
const MIN_REASON_LENGTH = 10;

const recoveryError = (message) => {
  const error = new Error(message);
  error.code = 'FACE_RECOVERY_AUTHORIZATION';
  return error;
};

const minutesFrom = (date, minutes) => new Date(date.getTime() + minutes * 60 * 1000);

const assertOperator = (operator) => {
  if (typeof operator !== 'string' || !config.face.recovery.operators.includes(operator.trim())) {
    throw recoveryError('Operador nao autorizado para recuperacao facial.');
  }
  return operator.trim();
};

const normalizeEmail = (email) => (typeof email === 'string' ? email.trim().toLowerCase() : '');

async function requestAuthorization({ email, operator, reason, now = new Date() }) {
  const operatorId = assertOperator(operator);
  const justification = typeof reason === 'string' ? reason.trim() : '';
  if (justification.length < MIN_REASON_LENGTH) {
    throw recoveryError(`Informe uma justificativa com pelo menos ${MIN_REASON_LENGTH} caracteres.`);
  }

  const user = await User.findOne({ email: normalizeEmail(email) });
  if (!user || user.verificado === false) {
    throw recoveryError('Conta inexistente ou com e-mail nao verificado.');
  }
  const profile = await FaceProfile.findOne({ userId: user._id, enrolled: true });
  if (!profile) {
    throw recoveryError('A conta nao tem cadastro facial ativo para recuperar.');
  }

  await FaceRecoveryAuthorization.updateMany(
    { userId: user._id, status: { $in: ['pending', 'active'] } },
    { $set: { status: 'revoked', revokedAt: now, revokedReason: 'substituida por novo pedido' }, $unset: { ownershipCodeHash: '' } }
  );

  const code = generateSecurityCode();
  const authorization = await FaceRecoveryAuthorization.create({
    userId: user._id,
    operator: operatorId,
    reason: justification,
    status: 'pending',
    ownershipCodeHash: hashSecurityCode(OWNERSHIP_PURPOSE, code),
    ownershipAttempts: 0,
    ownershipExpiresAt: minutesFrom(now, config.face.recovery.codeMinutes),
  });

  try {
    await sendOwnershipCodeEmail(user, code, { minutes: config.face.recovery.codeMinutes });
  } catch (_err) {
    await FaceRecoveryAuthorization.updateOne(
      { _id: authorization._id, status: 'pending' },
      { $set: { status: 'revoked', revokedAt: new Date(), revokedReason: 'falha no envio do codigo' }, $unset: { ownershipCodeHash: '' } }
    );
    await recordSecurityEvent({
      event: 'face_recovery_authorization_requested',
      outcome: 'failed',
      reason: 'email_failed',
      actor: 'operator',
      operator: operatorId,
      userId: user._id,
      authorizationId: authorization._id,
    });
    throw recoveryError('Nao foi possivel enviar o codigo de titularidade. Nada foi autorizado.');
  }

  await recordSecurityEvent({
    event: 'face_recovery_authorization_requested',
    outcome: 'requested',
    actor: 'operator',
    operator: operatorId,
    userId: user._id,
    authorizationId: authorization._id,
  });

  return { authorizationId: String(authorization._id), ownershipExpiresAt: authorization.ownershipExpiresAt };
}

async function confirmAuthorization({ authorizationId, operator, code, now = new Date() }) {
  const operatorId = assertOperator(operator);
  const deny = async (reason) => {
    await recordSecurityEvent({
      event: 'face_recovery_authorization_confirmed',
      outcome: 'denied',
      reason,
      actor: 'operator',
      operator: operatorId,
      ...(OBJECT_ID_PATTERN.test(String(authorizationId)) ? { authorizationId } : {}),
    });
  };

  if (!OBJECT_ID_PATTERN.test(String(authorizationId))) {
    await deny('invalid_id');
    throw recoveryError('Autorizacao inexistente.');
  }

  const authorization = await FaceRecoveryAuthorization.findById(authorizationId);
  const { maxAttempts, windowMinutes } = config.face.recovery;
  if (
    !authorization ||
    authorization.status !== 'pending' ||
    authorization.operator !== operatorId ||
    !(authorization.ownershipExpiresAt > now) ||
    authorization.ownershipAttempts >= maxAttempts
  ) {
    await deny('not_pending');
    throw recoveryError('Autorizacao inexistente, expirada, ja usada ou de outro operador.');
  }

  if (!matchesSecurityCode(OWNERSHIP_PURPOSE, code, authorization.ownershipCodeHash)) {
    const updated = await FaceRecoveryAuthorization.findOneAndUpdate(
      { _id: authorization._id, status: 'pending' },
      { $inc: { ownershipAttempts: 1 } },
      { new: true }
    );
    if (updated && updated.ownershipAttempts >= maxAttempts) {
      await FaceRecoveryAuthorization.updateOne(
        { _id: authorization._id, status: 'pending' },
        { $set: { status: 'revoked', revokedAt: now, revokedReason: 'tentativas esgotadas' }, $unset: { ownershipCodeHash: '' } }
      );
    }
    await deny('invalid_code');
    throw recoveryError('Codigo de titularidade invalido.');
  }

  // Condicional: entre confirmacoes simultaneas, so uma ativa.
  const activated = await FaceRecoveryAuthorization.findOneAndUpdate(
    {
      _id: authorization._id,
      status: 'pending',
      operator: operatorId,
      ownershipCodeHash: authorization.ownershipCodeHash,
      ownershipExpiresAt: { $gt: now },
    },
    {
      $set: { status: 'active', activatedAt: now, expiresAt: minutesFrom(now, windowMinutes) },
      $unset: { ownershipCodeHash: '' },
    },
    { new: true }
  );
  if (!activated) {
    await deny('not_pending');
    throw recoveryError('Autorizacao inexistente, expirada, ja usada ou de outro operador.');
  }

  await recordSecurityEvent({
    event: 'face_recovery_authorized',
    outcome: 'success',
    actor: 'operator',
    operator: operatorId,
    userId: activated.userId,
    authorizationId: activated._id,
  });

  return { authorizationId: String(activated._id), expiresAt: activated.expiresAt };
}

async function revokeAuthorization({ authorizationId, operator, reason, now = new Date() }) {
  const operatorId = assertOperator(operator);
  if (!OBJECT_ID_PATTERN.test(String(authorizationId))) {
    throw recoveryError('Autorizacao inexistente.');
  }
  const motive = typeof reason === 'string' && reason.trim() ? reason.trim().slice(0, 200) : 'revogada pelo operador';

  const revoked = await FaceRecoveryAuthorization.findOneAndUpdate(
    { _id: authorizationId, status: { $in: ['pending', 'active'] } },
    { $set: { status: 'revoked', revokedAt: now, revokedReason: motive }, $unset: { ownershipCodeHash: '' } },
    { new: true }
  );
  if (!revoked) {
    throw recoveryError('Autorizacao inexistente ou ja encerrada.');
  }

  await recordSecurityEvent({
    event: 'face_recovery_authorization_revoked',
    outcome: 'success',
    actor: 'operator',
    operator: operatorId,
    userId: revoked.userId,
    authorizationId: revoked._id,
  });

  return { authorizationId: String(revoked._id) };
}

module.exports = {
  OWNERSHIP_PURPOSE,
  confirmAuthorization,
  requestAuthorization,
  revokeAuthorization,
};
