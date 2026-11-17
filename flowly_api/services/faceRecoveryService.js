const crypto = require('crypto');
const argon2 = require('argon2');
const config = require('../config/config');
const User = require('../models/User');
const FaceProfile = require('../models/FaceProfile');
const TwoFactorToken = require('../models/TwoFactorToken');
const FaceRecoveryAuthorization = require('../models/FaceRecoveryAuthorization');
const { generateSecurityCode, hashSecurityCode, matchesSecurityCode } = require('../utils/securityCodes');
const { sendRecoveryCodeEmail, sendRecoveryCompletedEmail } = require('../utils/faceRecoveryEmails');
const { recordSecurityEvent } = require('../utils/securityAudit');
const { runInTransaction, supportsTransactions } = require('../utils/mongoTransactions');
const { extractEmbeddingsFromImages } = require('../utils/faceEnrollmentImages');
const { assertUniqueFaceEnrollment } = require('../utils/faceEnrollmentGuard');
const { encryptEmbeddings } = require('../utils/faceEmbeddingCrypto');
const { normalizeFaceError } = require('../utils/faceErrorMessages');
const { disconnectUserSockets, revokeUserSessions } = require('../utils/sessionGuard');

// Recadastro facial excepcional. So funciona com autorizacao ativa do operador
// (services/faceRecoveryAuthorizationService.js) e exige codigo do e-mail, senha atual e duas fotos novas.
// Nao emite token de acesso: depois do recadastro o titular entra pelo login normal, com o rosto novo.

const RECOVERY_PURPOSE = 'face_recovery';
// Mesmo hash falso do login: conta inexistente leva o mesmo tempo que senha errada.
const DUMMY_PASSWORD_HASH =
  '$argon2id$v=19$m=65536,t=3,p=4$2JAO6WHH7k+2wbl9rEUa1A$+XbUA9FrGJtcU3dEFgQOQ4E1fhNs8kr5YMpGzF6oVmc';

const MESSAGES = {
  invalidCredentials: 'Codigo, e-mail ou senha invalidos.',
  tooManyAttempts: 'Muitas tentativas. Peca um novo codigo.',
  notAuthorized: 'Recuperacao facial nao autorizada ou expirada. Procure o suporte.',
  unavailable: 'Recuperacao facial indisponivel no momento.',
  faceService: 'Servico facial indisponivel.',
  conflict: 'Esta recuperacao ja foi concluida ou esta em andamento.',
  persistence: 'Nao foi possivel concluir a recuperacao. Nada foi alterado.',
};

const failure = (statusCode, kind, message) => Object.assign(new Error(message), { statusCode, kind });

const normalizeEmail = (email) => (typeof email === 'string' ? email.trim().toLowerCase() : '');

const findActiveAuthorization = (userId, now) =>
  FaceRecoveryAuthorization.findOne({ userId, status: 'active', expiresAt: { $gt: now } });

const audit = (outcome, reason, user, authorization, event = 'face_recovery_completed') =>
  recordSecurityEvent({
    event,
    outcome,
    reason,
    actor: 'self',
    userId: user?._id,
    authorizationId: authorization?._id,
  });

async function sendRecoveryCode(email, now = new Date()) {
  const user = await User.findOne({ email: normalizeEmail(email) });
  if (!user || user.verificado === false) {
    return;
  }

  const authorization = await findActiveAuthorization(user._id, now);
  const profile = authorization ? await FaceProfile.findOne({ userId: user._id, enrolled: true }) : null;
  if (!authorization || !profile) {
    await audit('denied', authorization ? 'no_face_profile' : 'not_authorized', user, authorization, 'face_recovery_code_requested');
    return;
  }

  await TwoFactorToken.deleteMany({ userId: user._id, purpose: RECOVERY_PURPOSE });
  const code = generateSecurityCode();
  await TwoFactorToken.create({
    userId: user._id,
    codigo: hashSecurityCode(RECOVERY_PURPOSE, code),
    // Campo obrigatorio do modelo; este fluxo nao usa link, so o codigo.
    token: hashSecurityCode(`${RECOVERY_PURPOSE}:link`, crypto.randomBytes(32).toString('hex')),
    purpose: RECOVERY_PURPOSE,
  });

  try {
    await sendRecoveryCodeEmail(user, code, { minutes: config.face.recovery.codeMinutes });
  } catch (_err) {
    await TwoFactorToken.deleteMany({ userId: user._id, purpose: RECOVERY_PURPOSE });
    await audit('failed', 'email_failed', user, authorization, 'face_recovery_code_requested');
    return;
  }

  await audit('requested', undefined, user, authorization, 'face_recovery_code_requested');
}

async function checkCredentials({ email, codigo, senha }) {
  const user = await User.findOne({ email: normalizeEmail(email) });
  if (!user) {
    await argon2.verify(DUMMY_PASSWORD_HASH, senha).catch(() => false);
    throw failure(401, 'credentials', MESSAGES.invalidCredentials);
  }

  const token = await TwoFactorToken.findOne({ userId: user._id, purpose: RECOVERY_PURPOSE });
  if (!token) {
    await argon2.verify(DUMMY_PASSWORD_HASH, senha).catch(() => false);
    await audit('denied', 'no_code', user);
    throw failure(401, 'credentials', MESSAGES.invalidCredentials);
  }

  if ((Number(token.tentativas) || 0) >= config.face.recovery.maxAttempts) {
    await TwoFactorToken.deleteOne({ _id: token._id });
    await audit('denied', 'attempts_exceeded', user);
    throw failure(429, 'attempts', MESSAGES.tooManyAttempts);
  }

  // Senha e codigo errados contam no mesmo limite: a rota nao serve para testar senhas.
  const passwordOk = await argon2.verify(user.senha, senha).catch(() => false);
  const codeOk = matchesSecurityCode(RECOVERY_PURPOSE, codigo, token.codigo);
  if (!passwordOk || !codeOk) {
    await TwoFactorToken.updateOne({ _id: token._id }, { $inc: { tentativas: 1 } });
    await audit('denied', 'invalid_credentials', user);
    throw failure(401, 'credentials', MESSAGES.invalidCredentials);
  }

  return { user, token };
}

async function extractNewEmbeddings(imagesBase64, user, authorization) {
  let extracted;
  try {
    extracted = await extractEmbeddingsFromImages(imagesBase64, 'enroll');
  } catch (err) {
    if (err.statusCode && err.statusCode < 500) {
      await audit('denied', 'photo_rejected', user, authorization);
      throw failure(400, 'photo', normalizeFaceError(err.message, 'enroll'));
    }
    await audit('failed', 'face_service_unavailable', user, authorization);
    throw failure(err.statusCode === 504 ? 504 : 503, 'face_service', MESSAGES.faceService);
  }

  if (!extracted.ok) {
    await audit('denied', 'photo_rejected', user, authorization);
    throw failure(400, 'photo', extracted.erro);
  }

  return {
    embeddings: extracted.embeddings.map((item) => item.embedding),
    model: extracted.embeddings[0].model || 'VGG-Face',
  };
}

async function reenrollWithRecoveryCode({ email, codigo, senha, imagesBase64 }) {
  const { user, token } = await checkCredentials({ email, codigo, senha });

  const authorization = await findActiveAuthorization(user._id, new Date());
  if (!authorization) {
    await audit('denied', 'not_authorized', user);
    throw failure(403, 'authorization', MESSAGES.notAuthorized);
  }
  const profile = await FaceProfile.findOne({ userId: user._id, enrolled: true });
  if (!profile) {
    await audit('denied', 'no_face_profile', user, authorization);
    throw failure(403, 'authorization', MESSAGES.notAuthorized);
  }

  // Sem transacao, consumir o codigo e trocar o perfil nao seriam atomicos: melhor nao fazer.
  if (!(await supportsTransactions())) {
    await audit('failed', 'no_transaction_support', user, authorization);
    throw failure(503, 'unavailable', MESSAGES.unavailable);
  }

  const { embeddings, model } = await extractNewEmbeddings(imagesBase64, user, authorization);

  // Contra todos os outros perfis ativos, com o limiar de login como piso (utils/faceEnrollmentGuard.js).
  try {
    await assertUniqueFaceEnrollment(user._id, embeddings);
  } catch (err) {
    if (err.code === 'FACE_DUPLICATE') {
      await audit('denied', 'duplicate', user, authorization);
    }
    throw err;
  }

  const encryptedEmbeddings = encryptEmbeddings(embeddings);

  // Tudo ou nada: autorizacao e codigo consumidos, perfil trocado e sessoes revogadas na mesma transacao.
  // O perfil continua enrolled em qualquer resultado: uma falha nunca deixa a conta sem o rosto obrigatorio.
  try {
    await runInTransaction(async (session) => {
      const committedAt = new Date();
      const claimed = await FaceRecoveryAuthorization.findOneAndUpdate(
        { _id: authorization._id, status: 'active', expiresAt: { $gt: committedAt } },
        { $set: { status: 'consumed', consumedAt: committedAt } },
        { new: true, session }
      );
      if (!claimed) {
        throw failure(409, 'conflict', MESSAGES.conflict);
      }

      const consumedCode = await TwoFactorToken.findOneAndDelete({ _id: token._id, purpose: RECOVERY_PURPOSE }, { session });
      if (!consumedCode) {
        throw failure(409, 'conflict', MESSAGES.conflict);
      }

      const updated = await FaceProfile.findOneAndUpdate(
        { userId: user._id, enrolled: true },
        {
          $set: { encryptedEmbeddings, model, enrolled: true, enrolledAt: committedAt },
          $unset: { embedding: '', embeddings: '' },
        },
        { new: true, session }
      );
      if (!updated) {
        throw failure(409, 'conflict', MESSAGES.conflict);
      }

      await revokeUserSessions(user._id, { session });
    });
  } catch (err) {
    const conflict = err.kind === 'conflict';
    await audit('failed', conflict ? 'conflict' : 'persistence_error', user, authorization);
    if (conflict) {
      throw err;
    }
    console.error('Falha ao concluir recuperacao facial:', err.name);
    throw failure(500, 'persistence', MESSAGES.persistence);
  }

  // Depois do commit: derruba sockets, registra e avisa. O aviso nao decide o sucesso.
  disconnectUserSockets(user._id);
  await audit('success', undefined, user, authorization);
  sendRecoveryCompletedEmail(user).catch((err) => {
    console.warn('Aviso de recuperacao facial nao enviado:', err.name);
  });
}

module.exports = {
  MESSAGES,
  RECOVERY_PURPOSE,
  reenrollWithRecoveryCode,
  sendRecoveryCode,
};
