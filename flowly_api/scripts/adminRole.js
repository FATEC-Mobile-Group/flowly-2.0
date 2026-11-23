#!/usr/bin/env node
/**
 * Gestao de perfis user <-> admin — uso exclusivo de operador com acesso operacional ao banco.
 * NAO e uma interface administrativa publica: nao ha rota HTTP; quem roda este script ja precisa ter as
 * credenciais do banco (MONGO_URI) no proprio ambiente. ADMIN_ROLE_OPERATORS so identifica o operador
 * (lista de permissao), nao autentica ninguem.
 *
 *   node scripts/adminRole.js list      --operator <id> [--recent <n>]
 *   node scripts/adminRole.js bootstrap (--email <conta> | --user-id <id>) --operator <id> --reason "<motivo>" (--dry-run | --apply)
 *   node scripts/adminRole.js promote   (--email <conta> | --user-id <id>) --operator <id> --reason "<motivo>" (--dry-run | --apply)
 *   node scripts/adminRole.js demote    (--email <conta> | --user-id <id>) --operator <id> --reason "<motivo>"
 *                                       [--transfer-to-email <admin> | --transfer-to-id <id>] (--dry-run | --apply)
 *
 * Toda regra (primeiro admin so sem admins, conta verificada, sem tarefas abertas, biometria, ultimo admin,
 * transferencia de equipes, auditoria e revogacao de sessoes) fica em services/adminRoleService.js.
 * --dry-run so le o banco: nao toca na trava, na auditoria, nas sessoes nem em documento algum.
 * Sem --apply nada e gravado. A saida nunca inclui a URL do banco, senhas, tokens ou e-mails completos.
 *
 * Conexao: exige MONGO_URI definida explicitamente (nunca usa a conexao padrao do config) e, com --apply,
 * --expect-db <nome> igual ao banco efetivamente conectado. Divergencia encerra sem chamar o servico.
 */

const WRITE_COMMANDS = ['bootstrap', 'promote', 'demote'];
const COMMANDS = ['list', ...WRITE_COMMANDS];
const VALUE_OPTIONS = ['email', 'user-id', 'operator', 'reason', 'transfer-to-email', 'transfer-to-id', 'recent', 'expect-db'];
const FLAG_OPTIONS = ['dry-run', 'apply'];

const EXIT_OK = 0;
const EXIT_FAILED = 1;
const EXIT_USAGE = 2;

const USAGE = [
  'Uso:',
  '  node scripts/adminRole.js list      --operator <id> [--recent <n>] [--expect-db <banco>]',
  '  node scripts/adminRole.js bootstrap (--email <conta> | --user-id <id>) --operator <id> --reason "<motivo>" (--dry-run | --apply)',
  '  node scripts/adminRole.js promote   (--email <conta> | --user-id <id>) --operator <id> --reason "<motivo>" (--dry-run | --apply)',
  '  node scripts/adminRole.js demote    (--email <conta> | --user-id <id>) --operator <id> --reason "<motivo>"',
  '                                      [--transfer-to-email <admin> | --transfer-to-id <id>] (--dry-run | --apply)',
  'Sem --apply nada e gravado. --dry-run so consulta.',
  'Exige MONGO_URI definida; --apply exige tambem --expect-db <banco> igual ao banco conectado.',
].join('\n');

class UsageError extends Error {}

const parseArgs = (argv) => {
  const [command, ...rest] = argv;
  const options = {};
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (!arg.startsWith('--')) throw new UsageError(`Argumento inesperado: ${arg}`);
    const key = arg.slice(2);
    if (Object.prototype.hasOwnProperty.call(options, key)) throw new UsageError(`Opcao repetida: --${key}`);
    if (FLAG_OPTIONS.includes(key)) {
      options[key] = true;
      continue;
    }
    if (!VALUE_OPTIONS.includes(key)) throw new UsageError(`Opcao desconhecida: --${key}`);
    const value = rest[index + 1];
    if (value === undefined || value.startsWith('--')) throw new UsageError(`Valor ausente para --${key}`);
    options[key] = value;
    index += 1;
  }
  return { command, options };
};

// Conferencia de forma antes de conectar. As regras de negocio ficam no servico.
const validateUsage = ({ command, options }) => {
  if (!COMMANDS.includes(command)) throw new UsageError('Comando invalido.');
  if (!options.operator) throw new UsageError('Informe --operator.');
  if (command === 'list') {
    const extra = Object.keys(options).filter((key) => !['operator', 'recent', 'expect-db'].includes(key));
    if (extra.length) throw new UsageError(`Opcao nao usada em list: --${extra[0]}`);
    if (options.recent !== undefined && !/^\d{1,3}$/.test(options.recent)) throw new UsageError('--recent deve ser um numero.');
    return;
  }
  if (Boolean(options.email) === Boolean(options['user-id'])) {
    throw new UsageError('Informe a conta com --email ou --user-id (apenas um).');
  }
  if (!options.reason) throw new UsageError('Informe --reason com a justificativa.');
  if (Boolean(options['dry-run']) === Boolean(options.apply)) {
    throw new UsageError('Escolha --dry-run (simular) ou --apply (gravar).');
  }
  if (options.apply && !options['expect-db']) {
    throw new UsageError('--apply exige --expect-db <banco> para confirmar o destino da gravacao.');
  }
  const transfer = options['transfer-to-email'] || options['transfer-to-id'];
  if (transfer && command !== 'demote') throw new UsageError('Transferencia de equipes so existe em demote.');
  if (options['transfer-to-email'] && options['transfer-to-id']) {
    throw new UsageError('Informe o destino das equipes com --transfer-to-email ou --transfer-to-id (apenas um).');
  }
};

const APPLY = { bootstrap: 'bootstrapFirstAdmin', promote: 'promoteToAdmin', demote: 'demoteToUser' };

const defaultDeps = () => {
  const mongoose = require('mongoose');
  // So a variavel explicita: o config cai em mongodb://localhost:27017/Flowly quando ela falta.
  const configuredUri = () => (process.env.MONGO_URI || '').trim();
  return {
    service: require('../services/adminRoleService'),
    configuredUri,
    connect: () => mongoose.connect(configuredUri()),
    disconnect: () => mongoose.disconnect(),
    // So o nome do banco, nunca a URL (pode conter usuario e senha).
    databaseName: () => mongoose.connection.name,
    log: (line) => console.log(line),
    error: (line) => console.error(line),
  };
};

// Mensagem do servico (texto controlado) ou generica. Nunca err.message de erro inesperado: pode trazer a URL.
const describeError = (err) => {
  if (err?.name === 'AdminRoleError') {
    const details = Object.entries(err.details || {}).map(([key, value]) => `${key}=${value}`).join(' ');
    return `ERRO [${err.code}]: ${err.message}${details ? ` (${details})` : ''}`;
  }
  return `ERRO: falha inesperada (${err?.name || 'Error'}). Nada foi confirmado pelo script.`;
};

async function execute(service, { command, options }) {
  const actor = { kind: 'operator', operator: options.operator };
  if (command === 'list') {
    return service.listAdministrativeSummary({ actor, recentChanges: options.recent ? Number(options.recent) : 10 });
  }

  const targetUserId = await service.resolveUserId({ userId: options['user-id'], email: options.email });
  const transferTeamsTo = options['transfer-to-email'] || options['transfer-to-id']
    ? await service.resolveUserId({ userId: options['transfer-to-id'], email: options['transfer-to-email'] })
    : undefined;
  const args = { targetUserId, actor, reason: options.reason, ...(command === 'demote' ? { transferTeamsTo } : {}) };

  if (options['dry-run']) {
    return { mode: 'dry-run', nothingWritten: true, ...(await service.previewRoleChange(command, args)) };
  }
  return { mode: 'apply', action: command, ...(await service[APPLY[command]](args)) };
}

async function run(argv, deps = defaultDeps()) {
  let parsed;
  try {
    parsed = parseArgs(argv);
    validateUsage(parsed);
  } catch (err) {
    if (!(err instanceof UsageError)) throw err;
    deps.error(err.message);
    deps.error(USAGE);
    return EXIT_USAGE;
  }

  // Sem conexao explicita, nao conecta em lugar nenhum (nem no banco padrao).
  if (!deps.configuredUri()) {
    deps.error('Defina MONGO_URI com a conexao pretendida: este script nao usa a conexao padrao.');
    return EXIT_USAGE;
  }

  try {
    await deps.connect();
  } catch (err) {
    deps.error(describeError(err));
    return EXIT_FAILED;
  }
  try {
    const databaseName = deps.databaseName();
    deps.log(`Banco: ${databaseName}`);
    // Confirmacao do destino antes de qualquer chamada ao servico (obrigatoria com --apply).
    const expected = parsed.options['expect-db'];
    if (expected && expected !== databaseName) {
      deps.error(`ERRO [unexpected_database]: conectado ao banco "${databaseName}", mas --expect-db pede "${expected}". Nada foi feito.`);
      return EXIT_FAILED;
    }
    const result = await execute(deps.service, parsed);
    deps.log(JSON.stringify(result));
    return EXIT_OK;
  } catch (err) {
    deps.error(describeError(err));
    return EXIT_FAILED;
  } finally {
    await deps.disconnect();
  }
}

if (require.main === module) {
  run(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}

module.exports = { USAGE, describeError, parseArgs, run, validateUsage };
