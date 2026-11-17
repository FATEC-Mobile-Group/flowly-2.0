#!/usr/bin/env node
/**
 * Recuperacao facial excepcional — uso exclusivo de operador autorizado, com acesso ao banco.
 *
 *   node scripts/faceRecovery.js request --email <conta> --operator <id> --reason "<justificativa>"
 *   node scripts/faceRecovery.js confirm --id <autorizacao> --operator <id> [--code <codigo>]
 *   node scripts/faceRecovery.js revoke  --id <autorizacao> --operator <id> --reason "<motivo>"
 *
 * O operador precisa constar em FACE_RECOVERY_OPERATORS. O request envia um codigo de titularidade ao
 * e-mail da conta; o titular o repassa ao operador por outro canal, e o confirm ativa a autorizacao
 * por FACE_RECOVERY_WINDOW_MINUTES. Sem --code, o codigo e lido da entrada padrao (fora do historico).
 */
const USAGE = [
  'Uso:',
  '  node scripts/faceRecovery.js request --email <conta> --operator <id> --reason "<justificativa>"',
  '  node scripts/faceRecovery.js confirm --id <autorizacao> --operator <id> [--code <codigo>]',
  '  node scripts/faceRecovery.js revoke  --id <autorizacao> --operator <id> --reason "<motivo>"',
].join('\n');

const parseArgs = (argv) => {
  const [command, ...rest] = argv;
  const options = {};
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (!arg.startsWith('--')) {
      throw new Error(`Argumento inesperado: ${arg}`);
    }
    const key = arg.slice(2);
    const value = rest[index + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`Valor ausente para --${key}`);
    }
    options[key] = value;
    index += 1;
  }
  return { command, options };
};

const COMMANDS = {
  request: (service, options) =>
    service.requestAuthorization({ email: options.email, operator: options.operator, reason: options.reason }),
  confirm: (service, options) =>
    service.confirmAuthorization({ authorizationId: options.id, operator: options.operator, code: options.code }),
  revoke: (service, options) =>
    service.revokeAuthorization({ authorizationId: options.id, operator: options.operator, reason: options.reason }),
};

const readCodeFromStdin = () =>
  new Promise((resolve) => {
    const readline = require('readline');
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
    rl.question('Codigo informado pelo titular: ', (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });

const defaultDeps = () => {
  const mongoose = require('mongoose');
  const config = require('../config/config');
  return {
    service: require('../services/faceRecoveryAuthorizationService'),
    connect: () => mongoose.connect(config.mongodb.uri),
    disconnect: () => mongoose.disconnect(),
    readCode: readCodeFromStdin,
    log: (line) => console.log(line),
    error: (line) => console.error(line),
  };
};

async function run(argv, deps = defaultDeps()) {
  let parsed;
  try {
    parsed = parseArgs(argv);
  } catch (err) {
    deps.error(err.message);
    deps.error(USAGE);
    return 1;
  }

  const handler = COMMANDS[parsed.command];
  if (!handler) {
    deps.error(USAGE);
    return 1;
  }

  if (parsed.command === 'confirm' && !parsed.options.code) {
    parsed.options.code = await deps.readCode();
  }

  await deps.connect();
  try {
    const result = await handler(deps.service, parsed.options);
    deps.log(JSON.stringify(result));
    return 0;
  } catch (err) {
    deps.error(`ERRO: ${err.message}`);
    return 1;
  } finally {
    await deps.disconnect();
  }
}

if (require.main === module) {
  run(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}

module.exports = { USAGE, parseArgs, run };
