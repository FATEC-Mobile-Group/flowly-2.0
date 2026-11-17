// Politica de auditoria do CI: so o aviso listado e seus efeitos transitivos comprovados passam.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { evaluateAudit, formatAnnotation, loadExceptions, parseAuditOutput, runAudit } from './audit-policy.mjs';

const ALLOWED_URL = 'https://github.com/advisories/GHSA-fc5q-39xc-vjpf';
const EXCEPTION = {
  id: 'GHSA-fc5q-39xc-vjpf',
  package: 'picomatch',
  reason: 'ReDoS do picomatch so em ferramentas de desenvolvimento.',
  expiresOn: '2027-01-31',
};
const TODAY = new Date('2026-11-17T12:00:00Z');

const advisory = (name, url, severity = 'high', extra = {}) => ({
  source: 1247710,
  name,
  dependency: name,
  title: 'aviso',
  url,
  severity,
  range: '<=4.0.7',
  ...extra,
});

const entry = (name, severity, via, extra = {}) => ({
  name,
  severity,
  isDirect: false,
  via,
  effects: [],
  range: '*',
  nodes: [`node_modules/${name}`],
  fixAvailable: true,
  ...extra,
});

// O relatorio real do npm 11 para flowly_frontend (vite 8.3.4, vitest 5.0.4, picomatch 4.0.7).
const realReport = () => {
  const vulnerabilities = {
    '@vitejs/plugin-react': entry('@vitejs/plugin-react', 'high', ['vite'], { isDirect: true }),
    fdir: entry('fdir', 'high', ['picomatch']),
    picomatch: entry('picomatch', 'high', [advisory('picomatch', ALLOWED_URL)], {
      effects: ['fdir', 'tinyglobby', 'vite', 'vitest'],
    }),
    tinyglobby: entry('tinyglobby', 'high', ['fdir', 'picomatch']),
    vite: entry('vite', 'high', ['picomatch', 'tinyglobby'], { isDirect: true }),
    vitest: entry('vitest', 'high', ['picomatch', 'tinyglobby', 'vite'], { isDirect: true }),
  };
  return withMetadata({ auditReportVersion: 2, vulnerabilities });
};

function withMetadata(report) {
  const counts = { info: 0, low: 0, moderate: 0, high: 0, critical: 0 };
  Object.values(report.vulnerabilities).forEach((item) => {
    counts[item.severity] += 1;
  });
  return {
    ...report,
    metadata: { vulnerabilities: { ...counts, total: Object.keys(report.vulnerabilities).length } },
  };
}

const evaluate = (report, options = {}) =>
  evaluateAudit(report, { exceptions: [EXCEPTION], today: TODAY, ...options });

describe('relatorio atual: so o aviso conhecido', () => {
  test('passa e lista as seis ocorrencias permitidas com a data de expiracao', () => {
    const result = evaluate(realReport());

    expect(result.ok).toBe(true);
    expect(result.failures).toEqual([]);
    expect(result.allowed).toHaveLength(1);
    expect(result.allowed[0].id).toBe('GHSA-fc5q-39xc-vjpf');
    expect(result.allowed[0].expiresOn).toBe('2027-01-31');
    expect(result.allowed[0].packages).toEqual(['@vitejs/plugin-react', 'fdir', 'picomatch', 'tinyglobby', 'vite', 'vitest']);
  });

  test('sem nenhuma vulnerabilidade passa sem avisos', () => {
    const result = evaluate(withMetadata({ auditReportVersion: 2, vulnerabilities: {} }));

    expect(result).toMatchObject({ ok: true, failures: [], allowed: [] });
  });
});

describe('novas vulnerabilidades continuam reprovando', () => {
  const extend = (extra) => {
    const report = realReport();
    return withMetadata({ ...report, vulnerabilities: { ...report.vulnerabilities, ...extra } });
  };

  test('alta em dependencia de desenvolvimento', () => {
    const report = extend({
      esbuild: entry('esbuild', 'high', [advisory('esbuild', 'https://github.com/advisories/GHSA-aaaa-bbbb-cccc')]),
    });

    const result = evaluate(report);

    expect(result.ok).toBe(false);
    expect(result.failures.join('\n')).toMatch(/esbuild.*GHSA-aaaa-bbbb-cccc/);
  });

  test('critica em dependencia direta', () => {
    const report = extend({
      axios: entry('axios', 'critical', [advisory('axios', 'https://github.com/advisories/GHSA-crit-crit-crit', 'critical')], {
        isDirect: true,
      }),
    });

    expect(evaluate(report).ok).toBe(false);
  });

  test('moderada tambem reprova, como o npm audit do CI ja fazia', () => {
    const report = extend({
      postcss: entry('postcss', 'moderate', [advisory('postcss', 'https://github.com/advisories/GHSA-modr-modr-modr', 'moderate')]),
    });

    expect(evaluate(report).ok).toBe(false);
  });

  test('segundo aviso no proprio picomatch derruba a excecao de toda a cadeia', () => {
    const report = realReport();
    report.vulnerabilities.picomatch.via.push(advisory('picomatch', 'https://github.com/advisories/GHSA-novo-novo-novo'));

    const result = evaluate(report);

    expect(result.ok).toBe(false);
    expect(result.failures.join('\n')).toMatch(/GHSA-novo-novo-novo/);
    for (const name of ['picomatch', 'vite', 'vitest', '@vitejs/plugin-react']) {
      expect(result.failures.join('\n')).toContain(name);
    }
  });

  test('pacote que depende do picomatch e de outro pacote vulneravel nao fica coberto', () => {
    const report = extend({
      chokidar: entry('chokidar', 'high', [advisory('chokidar', 'https://github.com/advisories/GHSA-chok-chok-chok')]),
    });
    report.vulnerabilities.vite.via.push('chokidar');

    const result = evaluate(report);

    expect(result.ok).toBe(false);
    expect(result.failures.join('\n')).toMatch(/vite/);
  });

  test('mesmo GHSA em outro pacote nao e coberto', () => {
    const report = extend({
      outro: entry('outro', 'high', [advisory('outro', ALLOWED_URL)]),
    });

    expect(evaluate(report).ok).toBe(false);
  });

  test('referencia transitiva a pacote ausente do relatorio nao e comprovada', () => {
    const report = realReport();
    report.vulnerabilities.fdir.via = ['pacote-fantasma'];

    expect(evaluate(report).ok).toBe(false);
  });

  test('excecao vencida deixa de valer', () => {
    const result = evaluate(realReport(), { today: new Date('2027-02-01T00:00:00Z') });

    expect(result.ok).toBe(false);
    expect(result.failures.join('\n')).toMatch(/expirou em 2027-01-31/);
  });

  test('nivel minimo high ignora moderada nova, mas nunca alta ou critica', () => {
    const moderate = withMetadata({
      ...realReport(),
      vulnerabilities: {
        ...realReport().vulnerabilities,
        postcss: entry('postcss', 'moderate', [advisory('postcss', 'https://github.com/advisories/GHSA-modr-modr-modr', 'moderate')]),
      },
    });

    expect(evaluate(moderate, { auditLevel: 'high' }).ok).toBe(true);

    const high = withMetadata({
      ...realReport(),
      vulnerabilities: {
        ...realReport().vulnerabilities,
        esbuild: entry('esbuild', 'high', [advisory('esbuild', 'https://github.com/advisories/GHSA-aaaa-bbbb-cccc')]),
      },
    });
    expect(evaluate(high, { auditLevel: 'high' }).ok).toBe(false);
  });
});

describe('falhas do proprio npm audit reprovam', () => {
  test('erro do registro no JSON', () => {
    expect(() =>
      parseAuditOutput(JSON.stringify({ error: { code: 'ENOAUDIT', summary: 'Your configured registry does not support audit requests.' } }))
    ).toThrow(/ENOAUDIT/);
  });

  test.each([
    ['saida vazia', ''],
    ['JSON invalido', '{"auditReportVersion": 2, '],
    ['sem vulnerabilities', JSON.stringify({ auditReportVersion: 2, metadata: { vulnerabilities: { total: 0 } } })],
  ])('%s', (_label, output) => {
    expect(() => parseAuditOutput(output)).toThrow();
  });

  test('versao de relatorio desconhecida, mesmo com o resto no formato atual', () => {
    const report = { ...realReport(), auditReportVersion: 1 };

    expect(() => parseAuditOutput(JSON.stringify(report))).toThrow(/auditReportVersion=1/);
  });

  test('contagem do metadata diferente da lista de pacotes', () => {
    const report = realReport();
    report.metadata.vulnerabilities.total = 7;

    expect(() => parseAuditOutput(JSON.stringify(report))).toThrow(/metadata/);
  });

  test('processo que nao executa, morre por sinal ou sai com erro sem relatorio', () => {
    expect(() => runAudit({ spawn: () => ({ error: new Error('ENOENT') }) })).toThrow(/npm audit/);
    expect(() => runAudit({ spawn: () => ({ status: null, signal: 'SIGKILL', stdout: '' }) })).toThrow(/SIGKILL/);
    expect(() => runAudit({ spawn: () => ({ status: 1, stdout: '', stderr: 'registry unreachable' }) })).toThrow();
  });

  test.each([
    ['codigo 2', { status: 2 }, /codigo 2/],
    ['codigo 127', { status: 127 }, /codigo 127/],
    ['sem codigo de saida', {}, /sem codigo/],
    ['codigo nulo sem sinal', { status: null }, /sem codigo/],
  ])('%s reprova mesmo com JSON valido', (_label, exit, message) => {
    const stdout = JSON.stringify(realReport());

    expect(() => runAudit({ spawn: () => ({ ...exit, stdout, stderr: '' }) })).toThrow(message);
  });

  test('saida 0 com relatorio valido e aceita', () => {
    const empty = withMetadata({ auditReportVersion: 2, vulnerabilities: {} });

    expect(runAudit({ spawn: () => ({ status: 0, stdout: JSON.stringify(empty), stderr: '' }) })).toEqual(empty);
  });

  test('saida 1 com relatorio valido e o caso normal de vulnerabilidade encontrada', () => {
    const report = runAudit({ spawn: () => ({ status: 1, stdout: JSON.stringify(realReport()), stderr: '' }) });

    expect(Object.keys(report.vulnerabilities)).toHaveLength(6);
  });

  test('o npm e chamado com a auditoria completa, incluindo desenvolvimento', () => {
    const calls = [];
    runAudit({
      spawn: (command, args) => {
        calls.push([command, args]);
        return { status: 0, stdout: JSON.stringify(withMetadata({ auditReportVersion: 2, vulnerabilities: {} })) };
      },
    });

    expect(calls[0][1]).toEqual(['audit', '--json']);
  });
});

describe('arquivo de excecoes', () => {
  test('o arquivo do repositorio tem somente o aviso do picomatch, com prazo', () => {
    const exceptions = loadExceptions();

    expect(exceptions).toHaveLength(1);
    expect(exceptions[0]).toMatchObject({ id: 'GHSA-fc5q-39xc-vjpf', package: 'picomatch', expiresOn: '2027-01-31' });
  });

  test('excecao sem pacote, sem motivo ou com data malformada e recusada', () => {
    const folder = mkdtempSync(path.join(tmpdir(), 'audit-excecoes-'));
    try {
      for (const bad of [
        { id: 'GHSA-fc5q-39xc-vjpf', reason: 'x', expiresOn: '2027-01-31' },
        { id: 'GHSA-fc5q-39xc-vjpf', package: 'picomatch', expiresOn: '2027-01-31' },
        { id: 'GHSA-fc5q-39xc-vjpf', package: 'picomatch', reason: 'x', expiresOn: '31/01/2027' },
        { id: 'qualquer-coisa', package: 'picomatch', reason: 'x', expiresOn: '2027-01-31' },
      ]) {
        const file = path.join(folder, 'excecoes.json');
        writeFileSync(file, JSON.stringify({ exceptions: [bad] }));
        expect(() => loadExceptions(file)).toThrow(/excecao invalida/);
      }
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });
});

describe('aviso no GitHub Actions', () => {
  test('anotacao de uma linha, com quebras e separadores escapados', () => {
    const line = formatAnnotation('warning', 'Excecao: auditoria, temporaria', 'linha 1\nlinha 2 100%');

    expect(line).toBe('::warning title=Excecao%3A auditoria%2C temporaria::linha 1%0Alinha 2 100%25');
    expect(line).not.toContain('\n');
  });
});
