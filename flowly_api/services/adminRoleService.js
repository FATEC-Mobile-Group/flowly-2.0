const config = require('../config/config');
const User = require('../models/User');
const Equipe = require('../models/Equipe');
const Tarefa = require('../models/Tarefa');
const FaceProfile = require('../models/FaceProfile');
const RoleLock = require('../models/RoleLock');
const RoleChangeEvent = require('../models/RoleChangeEvent');
const { runInTransaction, supportsTransactions } = require('../utils/mongoTransactions');
const { disconnectUserSockets } = require('../utils/sessionGuard');

// Nucleo das mudancas de perfil user <-> admin. Sem HTTP: quem chamar estas funcoes precisa ja ter
// autenticado o autor (o script scripts/adminRole.js roda com acesso operacional ao banco).
// `admin` continua sendo um papel amplo (sem empresas).
//
// Autor (actor):
//   { kind: 'admin', userId }      administrador existente; conferido no banco dentro da transacao.
//   { kind: 'operator', operator } processo local com acesso ao banco. A lista config.adminRoles.operators
//                                  so identifica o operador: nao autentica.
//
// Cada operacao tem um "plano" com todas as pre-condicoes. A gravacao roda o plano dentro da transacao,
// depois da trava (RoleLock), e aplica: troca condicional do tipo com authVersion + 1, transferencias e
// auditoria. A simulacao (preview*) roda o mesmo plano so com leituras, sem trava, sessao ou gravacao.

const ROLE_LOCK_ID = 'admin-roles';
const MIN_REASON = 10;
const MAX_REASON = 500;
const OBJECT_ID_PATTERN = /^[a-f\d]{24}$/i;

class AdminRoleError extends Error {
  constructor(statusCode, code, message, details = {}) {
    super(message);
    this.name = 'AdminRoleError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

const fail = (statusCode, code, message, details) => {
  throw new AdminRoleError(statusCode, code, message, details);
};

const sameId = (a, b) => a != null && b != null && String(a) === String(b);
const normalizeEmail = (email) => (typeof email === 'string' ? email.trim().toLowerCase() : '');

const assertObjectId = (value, code = 'not_found', message = 'Conta nao encontrada.') => {
  if (!OBJECT_ID_PATTERN.test(String(value || ''))) fail(404, code, message);
  return String(value);
};

const normalizeReason = (reason) => {
  const text = typeof reason === 'string' ? reason.trim() : '';
  if (text.length < MIN_REASON || text.length > MAX_REASON) {
    fail(400, 'invalid_reason', `Informe um motivo entre ${MIN_REASON} e ${MAX_REASON} caracteres.`);
  }
  return text;
};

// Formato do autor, antes de abrir a transacao. A existencia do admin e conferida no plano.
const normalizeActor = (actor) => {
  if (actor?.kind === 'operator') {
    const operator = typeof actor.operator === 'string' ? actor.operator.trim() : '';
    if (!operator || !config.adminRoles.operators.includes(operator)) {
      fail(403, 'invalid_actor', 'Operador nao autorizado para gerenciar perfis.');
    }
    return { kind: 'operator', operator };
  }
  if (actor?.kind === 'admin') {
    return { kind: 'admin', userId: assertObjectId(actor.userId, 'invalid_actor', 'Autor invalido.') };
  }
  return fail(403, 'invalid_actor', 'Autor invalido.');
};

const assertTransactions = async () => {
  if (!(await supportsTransactions())) {
    fail(503, 'transactions_unavailable', 'Gestao de perfis indisponivel: o banco nao suporta transacoes.');
  }
};

// Sem sessao (simulacao), as leituras vao direto ao banco.
const options = (session) => (session ? { session } : {});

const lockRoles = (session) =>
  RoleLock.findOneAndUpdate({ _id: ROLE_LOCK_ID }, { $inc: { version: 1 } }, { upsert: true, new: true, session });

const loadUser = (userId, session) =>
  User.findOne({ _id: userId }, 'tipo verificado authVersion email', options(session));

const assertAdminActor = async (actor, session) => {
  if (actor.kind !== 'admin') return;
  const author = await loadUser(actor.userId, session);
  if (!author || author.tipo !== 'admin') {
    fail(403, 'invalid_actor', 'Somente um administrador pode alterar perfis.');
  }
};

// Operador e so um rotulo; quando o rotulo e o proprio e-mail da conta alvo, e autoalteracao.
const assertNotOperatorSelf = (actor, target) => {
  if (actor.kind === 'operator' && normalizeEmail(actor.operator) === normalizeEmail(target.email)) {
    fail(403, 'self_change', 'Ninguem pode alterar o proprio perfil.');
  }
};

const countAdmins = async (session) => (await User.find({ tipo: 'admin' }, '_id', options(session))).length;

const openAssignedTasks = async (userId, session) =>
  (await Tarefa.find({ user: userId, status: { $ne: 'concluido' } }, '_id', options(session))).length;

const hasEnrolledFace = async (userId, session) =>
  Boolean(await FaceProfile.findOne({ userId, enrolled: true }, '_id', options(session)));

// Troca condicional: so muda se o perfil ainda for o esperado. authVersion + 1 invalida os tokens antigos.
const switchRole = async (userId, fromRole, toRole, session) => {
  const updated = await User.findOneAndUpdate(
    { _id: userId, tipo: fromRole },
    { $set: { tipo: toRole }, $inc: { authVersion: 1 } },
    { new: true, session }
  );
  if (!updated) fail(409, 'conflict', 'O perfil da conta mudou durante a operacao. Tente novamente.');
  return updated;
};

const recordChange = (event, session) => RoleChangeEvent.create([event], { session });

const actorFields = (actor) => (actor.kind === 'admin'
  ? { actorKind: 'admin', actorUserId: actor.userId }
  : { actorKind: 'operator', actorOperator: actor.operator });

// Conta a promover: existe, e-mail confirmado, ainda user e sem tarefas abertas atribuidas
// (as rotas de tarefas do responsavel sao so de user: promovida, perderia o acesso a elas).
const assertPromotable = async (targetId, session) => {
  const target = await loadUser(targetId, session);
  if (!target) fail(404, 'not_found', 'Conta nao encontrada.');
  if (target.verificado !== true) fail(409, 'email_not_verified', 'A conta precisa ter o e-mail confirmado.');
  if (target.tipo !== 'user') fail(409, 'already_admin', 'A conta ja e administradora.');
  const openTasks = await openAssignedTasks(targetId, session);
  if (openTasks > 0) {
    fail(409, 'open_tasks', 'A conta tem tarefas abertas atribuidas. Reatribua ou conclua antes de promover.', { openTasks });
  }
  return target;
};

// ---------------------------------------------------------------------------------------------------------
// Preparacao (fora da transacao) e planos (pre-condicoes; dentro da transacao ou na simulacao).
// ---------------------------------------------------------------------------------------------------------

const prepare = (action, { targetUserId, actor, reason, transferTeamsTo }) => {
  const author = normalizeActor(actor);
  const motive = normalizeReason(reason);
  const targetId = assertObjectId(targetUserId);
  if (action === 'bootstrap' && author.kind !== 'operator') {
    fail(403, 'invalid_actor', 'O primeiro administrador e criado por um operador.');
  }
  if (action !== 'bootstrap' && author.kind === 'admin' && sameId(author.userId, targetId)) {
    fail(403, 'self_change', 'Ninguem pode alterar o proprio perfil.');
  }
  let transferId = null;
  if (action === 'demote' && transferTeamsTo != null && transferTeamsTo !== '') {
    transferId = assertObjectId(transferTeamsTo, 'invalid_transfer', 'Administrador de destino invalido.');
    if (sameId(transferId, targetId)) fail(400, 'invalid_transfer', 'As equipes precisam ir para outro administrador.');
  }
  return { author, motive, targetId, transferId };
};

// Primeiro administrador: so com zero admins. Nao exige biometria (primeiro acesso viavel); o registro
// anota se havia rosto cadastrado. O operador pode ser o proprio titular: nao ha outro admin.
async function planBootstrap({ targetId }, session) {
  if ((await countAdmins(session)) > 0) {
    fail(409, 'admins_exist', 'Ja existe administrador. Use a promocao normal.');
  }
  await assertPromotable(targetId, session);
  return {
    action: 'bootstrap', targetUserId: targetId, fromRole: 'user', toRole: 'admin',
    faceProfileEnrolled: await hasEnrolledFace(targetId, session),
  };
}

// Promocao: exige cadastro facial ativo (admin com rosto passa pela verificacao facial no login).
async function planPromotion({ author, targetId }, session) {
  await assertAdminActor(author, session);
  const target = await assertPromotable(targetId, session);
  assertNotOperatorSelf(author, target);
  if (!(await hasEnrolledFace(targetId, session))) {
    fail(409, 'face_profile_required', 'A conta precisa ter verificacao facial cadastrada para ser administradora.');
  }
  return { action: 'promote', targetUserId: targetId, fromRole: 'user', toRole: 'admin', faceProfileEnrolled: true };
}

// Rebaixamento: nunca o ultimo admin; equipes criadas pela conta so com transferencia para outro admin.
async function planDemotion({ author, targetId, transferId }, session) {
  await assertAdminActor(author, session);
  const target = await loadUser(targetId, session);
  if (!target) fail(404, 'not_found', 'Conta nao encontrada.');
  if (target.tipo !== 'admin') fail(409, 'not_admin', 'A conta nao e administradora.');
  assertNotOperatorSelf(author, target);

  // Dentro da transacao, contada depois da trava: duas remocoes simultaneas nao passam pela mesma contagem.
  if ((await countAdmins(session)) <= 1) {
    fail(409, 'last_admin', 'Nao e possivel rebaixar o ultimo administrador.');
  }

  const teams = await Equipe.find({ createdBy: targetId }, '_id', options(session));
  if (teams.length > 0) {
    if (!transferId) {
      fail(409, 'owns_teams', 'A conta criou equipes. Informe outro administrador para assumi-las.', { teams: teams.length });
    }
    const receiver = await loadUser(transferId, session);
    if (!receiver || receiver.tipo !== 'admin' || receiver.verificado !== true) {
      fail(409, 'invalid_transfer', 'O destino das equipes precisa ser outro administrador com e-mail confirmado.');
    }
  }

  return {
    action: 'demote', targetUserId: targetId, fromRole: 'admin', toRole: 'user',
    faceProfileEnrolled: await hasEnrolledFace(targetId, session),
    teamIds: teams.map((team) => String(team._id)),
    transferTo: teams.length ? transferId : null,
  };
}

const PLANS = { bootstrap: planBootstrap, promote: planPromotion, demote: planDemotion };

// ---------------------------------------------------------------------------------------------------------
// Gravacao: transacao com trava, plano, troca de perfil, transferencias e auditoria. Tudo ou nada.
// ---------------------------------------------------------------------------------------------------------

async function applyChange(action, args) {
  const prepared = prepare(action, args);
  await assertTransactions();

  let plan;
  await runInTransaction(async (session) => {
    await lockRoles(session);
    plan = await PLANS[action](prepared, session);

    if (plan.teamIds?.length) {
      const moved = await Equipe.updateMany(
        { _id: { $in: plan.teamIds }, createdBy: prepared.targetId },
        { $set: { createdBy: plan.transferTo }, $addToSet: { membros: plan.transferTo } },
        { session }
      );
      if (moved.modifiedCount !== plan.teamIds.length) {
        fail(409, 'conflict', 'As equipes mudaram durante a operacao. Tente novamente.');
      }
    }

    await switchRole(prepared.targetId, plan.fromRole, plan.toRole, session);
    await recordChange({
      action, targetUserId: prepared.targetId, fromRole: plan.fromRole, toRole: plan.toRole,
      ...actorFields(prepared.author), reason: prepared.motive, faceProfileEnrolled: plan.faceProfileEnrolled,
      ...(plan.teamIds?.length ? { transferredTeamIds: plan.teamIds, transferredTo: plan.transferTo } : {}),
    }, session);
  });

  // Depois do commit: derruba as conexoes em tempo real; os tokens ja nao valem (authVersion).
  disconnectUserSockets(prepared.targetId);
  return plan;
}

async function bootstrapFirstAdmin(args) {
  const plan = await applyChange('bootstrap', args);
  return { userId: plan.targetUserId, role: 'admin' };
}

async function promoteToAdmin(args) {
  const plan = await applyChange('promote', args);
  return { userId: plan.targetUserId, role: 'admin' };
}

async function demoteToUser(args) {
  const plan = await applyChange('demote', args);
  return { userId: plan.targetUserId, role: 'user', transferredTeamIds: plan.teamIds };
}

// ---------------------------------------------------------------------------------------------------------
// Somente leitura (usado pelo script): simulacao, busca de conta e resumo administrativo.
// ---------------------------------------------------------------------------------------------------------

/**
 * Simula bootstrap/promote/demote com as mesmas pre-condicoes, sem trava, sem transacao e sem gravar nada.
 * O resultado pode mudar ate a gravacao: a gravacao confere tudo de novo, depois da trava.
 */
async function previewRoleChange(action, args) {
  if (!PLANS[action]) fail(400, 'invalid_action', 'Acao invalida.');
  const prepared = prepare(action, args);
  await assertTransactions();
  const plan = await PLANS[action](prepared, null);
  return {
    action: plan.action,
    userId: plan.targetUserId,
    fromRole: plan.fromRole,
    toRole: plan.toRole,
    faceProfileEnrolled: plan.faceProfileEnrolled,
    ...(plan.teamIds ? { teamsToTransfer: plan.teamIds.length, transferTo: plan.transferTo } : {}),
  };
}

// Conta por id ou e-mail (normalizado como no cadastro). So devolve o id.
async function resolveUserId({ userId, email } = {}) {
  if (userId) return assertObjectId(userId);
  const normalized = normalizeEmail(email);
  if (!normalized) fail(400, 'invalid_target', 'Informe a conta por e-mail ou id.');
  const user = await User.findOne({ email: normalized }, '_id');
  if (!user) fail(404, 'not_found', 'Conta nao encontrada.');
  return String(user._id);
}

const maskEmail = (email) => {
  const [local = '', domain = ''] = String(email || '').split('@');
  return domain ? `${local.slice(0, 1)}***@${domain}` : '***';
};

// Resumo para o operador: admins (id, nome, e-mail mascarado, biometria, equipes criadas) e ultimas
// mudancas registradas. Sem senha, token, authVersion ou dado biometrico.
async function listAdministrativeSummary({ actor, recentChanges = 10 } = {}) {
  if (normalizeActor(actor).kind !== 'operator') fail(403, 'invalid_actor', 'Consulta restrita a operadores.');
  const admins = await User.find({ tipo: 'admin' }, '_id nome email verificado');
  const summary = await Promise.all(admins.map(async (admin) => ({
    userId: String(admin._id),
    nome: admin.nome,
    email: maskEmail(admin.email),
    verificado: admin.verificado === true,
    faceProfileEnrolled: await hasEnrolledFace(admin._id, null),
    teamsCreated: (await Equipe.find({ createdBy: admin._id }, '_id')).length,
  })));
  const changes = await RoleChangeEvent.find({}).sort({ createdAt: -1 }).limit(recentChanges);
  return {
    adminCount: summary.length,
    admins: summary,
    recentChanges: changes.map((event) => ({
      at: event.createdAt,
      action: event.action,
      userId: String(event.targetUserId),
      fromRole: event.fromRole,
      toRole: event.toRole,
      actor: event.actorKind === 'admin' ? `admin:${event.actorUserId}` : `operator:${event.actorOperator}`,
      reason: event.reason,
    })),
  };
}

module.exports = {
  AdminRoleError,
  ROLE_LOCK_ID,
  bootstrapFirstAdmin,
  demoteToUser,
  listAdministrativeSummary,
  previewRoleChange,
  promoteToAdmin,
  resolveUserId,
};
