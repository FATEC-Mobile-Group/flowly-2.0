#!/usr/bin/env node
/**
 * Auditoria completa do frontend no CI, incluindo dependencias de desenvolvimento.
 *
 * Roda `npm audit --json` e reprova qualquer vulnerabilidade, exceto os avisos listados em
 * audit-exceptions.json e os pacotes cuja cadeia `via` leva somente a eles. A excecao vale para um
 * pacote especifico e tem data de expiracao. Erro do npm, registro indisponivel ou relatorio invalido
 * tambem reprovam. A auditoria de producao (`npm audit --omit=dev`) roda separada, sem excecoes.
 *
 *   node scripts/audit-policy.mjs [--audit-level=low|moderate|high|critical] [--report=arquivo.json]
 */
import { spawnSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SEVERITIES = ['info', 'low', 'moderate', 'high', 'critical'];
const FRONTEND_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXCEPTIONS_FILE = path.join(FRONTEND_DIR, 'audit-exceptions.json');

export function parseAuditOutput(output) {
  if (typeof output !== 'string' || !output.trim()) {
    throw new Error('npm audit nao produziu relatorio.');
  }

  let report;
  try {
    report = JSON.parse(output);
  } catch {
    throw new Error('npm audit devolveu JSON invalido.');
  }

  if (report?.error) {
    const { code = 'desconhecido', summary = '' } = report.error;
    throw new Error(`npm audit falhou (${code}): ${summary}`.trim());
  }
  if (report?.auditReportVersion !== 2) {
    throw new Error(`Formato de relatorio inesperado (auditReportVersion=${report?.auditReportVersion}).`);
  }
  const { vulnerabilities } = report;
  if (!vulnerabilities || typeof vulnerabilities !== 'object' || Array.isArray(vulnerabilities)) {
    throw new Error('Relatorio sem a lista vulnerabilities.');
  }

  const names = Object.keys(vulnerabilities);
  const counts = report.metadata?.vulnerabilities;
  const counted = SEVERITIES.reduce((sum, severity) => sum + (Number(counts?.[severity]) || 0), 0);
  if (!counts || counts.total !== names.length || counted !== names.length) {
    throw new Error('Contagem do metadata nao confere com a lista de vulnerabilidades.');
  }
  for (const name of names) {
    const item = vulnerabilities[name];
    if (!SEVERITIES.includes(item?.severity) || !Array.isArray(item.via) || item.via.length === 0) {
      throw new Error(`Entrada invalida no relatorio: ${name}.`);
    }
  }
  return report;
}

const npmCommand = () => (process.platform === 'win32' ? 'npm.cmd' : 'npm');
// No Windows o npm.cmd exige shell; os argumentos sao fixos, entao o comando vai inteiro como texto.
const defaultSpawn = (command, args, options) =>
  process.platform === 'win32'
    ? spawnSync(`${command} ${args.join(' ')}`, { ...options, shell: true })
    : spawnSync(command, args, options);

export function runAudit({ spawn = defaultSpawn, cwd = FRONTEND_DIR } = {}) {
  const result = spawn(npmCommand(), ['audit', '--json'], { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (result.error) {
    throw new Error(`Nao foi possivel executar npm audit: ${result.error.message}`);
  }
  if (result.signal) {
    throw new Error(`npm audit interrompido por ${result.signal}.`);
  }
  // So 0 (nada encontrado) e 1 (vulnerabilidades encontradas) sao saidas esperadas. Qualquer outro codigo,
  // ou nenhum, reprova mesmo com um JSON aparentemente valido.
  if (result.status !== 0 && result.status !== 1) {
    throw new Error(
      typeof result.status === 'number'
        ? `npm audit terminou com codigo ${result.status}.`
        : 'npm audit terminou sem codigo de saida.'
    );
  }
  // Com 1, quem decide e o relatorio, que precisa ser valido.
  try {
    return parseAuditOutput(result.stdout);
  } catch (err) {
    const detail = String(result.stderr || '').trim().slice(0, 300);
    throw new Error(detail ? `${err.message} stderr: ${detail}` : err.message);
  }
}

const advisoryId = (via) => String(via?.url || '').split('/').filter(Boolean).pop() || `fonte ${via?.source}`;
const endOfDay = (date) => new Date(`${date}T23:59:59.999Z`);

export function evaluateAudit(report, { exceptions = [], today = new Date(), auditLevel = 'low' } = {}) {
  const threshold = SEVERITIES.indexOf(auditLevel);
  if (threshold < 0) {
    throw new Error(`audit-level invalido: ${auditLevel}`);
  }

  const vulnerabilities = report.vulnerabilities;
  const active = exceptions.filter((item) => today <= endOfDay(item.expiresOn));
  const expired = exceptions.filter((item) => !active.includes(item));

  const matchException = (via, list) =>
    list.find((item) => item.id === advisoryId(via) && item.package === (via.name || via.dependency));

  // Um pacote e permitido se cada item de `via` for um aviso permitido ou outro pacote permitido.
  // Referencia a pacote ausente, ou ciclo, nao conta como comprovacao.
  const memo = new Map();
  const isAllowed = (name, visiting = new Set()) => {
    if (memo.has(name)) return memo.get(name);
    const item = vulnerabilities[name];
    if (!item || visiting.has(name)) return false;
    visiting.add(name);
    const allowed = item.via.every((via) =>
      typeof via === 'string' ? isAllowed(via, visiting) : Boolean(matchException(via, active))
    );
    visiting.delete(name);
    memo.set(name, allowed);
    return allowed;
  };

  const describe = (item) =>
    item.via
      .map((via) => {
        if (typeof via === 'string') {
          return isAllowed(via) ? null : `via ${via}`;
        }
        if (matchException(via, active)) return null;
        const stale = matchException(via, expired);
        return stale
          ? `${advisoryId(via)} (excecao expirou em ${stale.expiresOn}; revise antes de renovar)`
          : `${advisoryId(via)} (${via.severity}: ${via.title || 'sem titulo'})`;
      })
      .filter(Boolean)
      .join('; ');

  const failures = [];
  const allowedNames = [];
  for (const name of Object.keys(vulnerabilities).sort()) {
    const item = vulnerabilities[name];
    if (isAllowed(name)) {
      allowedNames.push(name);
    } else if (SEVERITIES.indexOf(item.severity) >= threshold) {
      failures.push(`${name} (${item.severity}${item.isDirect ? ', direta' : ''}): ${describe(item)}`);
    }
  }

  const advisoriesReached = (name, seen = new Set()) => {
    if (seen.has(name)) return [];
    seen.add(name);
    return vulnerabilities[name].via.flatMap((via) =>
      typeof via === 'string' ? advisoriesReached(via, seen) : [matchException(via, active)]
    );
  };

  const allowed = active
    .map((exception) => {
      const packages = allowedNames.filter((name) => advisoriesReached(name).includes(exception));
      const severity = packages
        .map((name) => vulnerabilities[name].severity)
        .sort((a, b) => SEVERITIES.indexOf(b) - SEVERITIES.indexOf(a))[0];
      return { ...exception, severity, packages };
    })
    .filter((item) => item.packages.length > 0);

  return { ok: failures.length === 0, failures, allowed };
}

// Comandos de workflow do GitHub: a mensagem precisa ser uma linha so.
const escapeData = (value) => String(value).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
const escapeProperty = (value) => escapeData(value).replace(/:/g, '%3A').replace(/,/g, '%2C');

export function formatAnnotation(level, title, message) {
  return `::${level} title=${escapeProperty(title)}::${escapeData(message)}`;
}

export function loadExceptions(file = EXCEPTIONS_FILE) {
  const { exceptions } = JSON.parse(readFileSync(file, 'utf8'));
  if (!Array.isArray(exceptions)) {
    throw new Error(`${file}: exceptions precisa ser uma lista.`);
  }
  for (const item of exceptions) {
    if (!/^GHSA(-[0-9a-z]{4}){3}$/.test(item.id) || !item.package || !item.reason || !/^\d{4}-\d{2}-\d{2}$/.test(item.expiresOn)) {
      throw new Error(`${file}: excecao invalida ${JSON.stringify(item.id)}.`);
    }
  }
  return exceptions;
}

function main(argv) {
  const option = (name) => argv.find((arg) => arg.startsWith(`--${name}=`))?.split('=').slice(1).join('=');
  const auditLevel = option('audit-level') || 'low';
  const reportFile = option('report');

  let report;
  let exceptions;
  try {
    exceptions = loadExceptions();
    report = reportFile ? parseAuditOutput(readFileSync(reportFile, 'utf8')) : runAudit();
  } catch (err) {
    console.log(formatAnnotation('error', 'npm audit', err.message));
    return 1;
  }

  const result = evaluateAudit(report, { exceptions, today: new Date(), auditLevel });
  const summary = ['### npm audit (completo)', ''];

  for (const item of result.allowed) {
    const message =
      `${item.id} (${item.package}, ${item.severity}) permitido ate ${item.expiresOn} em: ` +
      `${item.packages.join(', ')}. ${item.reason}`;
    console.log(formatAnnotation('warning', 'Excecao temporaria de auditoria', message));
    summary.push(`- Excecao temporaria: ${message}`);
  }
  for (const failure of result.failures) {
    console.log(formatAnnotation('error', 'Vulnerabilidade nao permitida', failure));
    summary.push(`- Nao permitida: ${failure}`);
  }

  const total = Object.keys(report.vulnerabilities).length;
  const verdict = result.ok
    ? `Aprovado: ${total} ocorrencia(s), todas cobertas por excecao temporaria valida.`
    : `Reprovado: ${result.failures.length} ocorrencia(s) sem excecao (nivel minimo ${auditLevel}).`;
  console.log(verdict);
  summary.push('', verdict, '');

  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary.join('\n')}\n`);
  }
  return result.ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = main(process.argv.slice(2));
}
