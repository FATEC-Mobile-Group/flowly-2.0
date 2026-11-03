import { spawnSync } from 'node:child_process';

const forwardedArgs = process.argv
  .slice(2)
  .filter((argument) => argument !== '--watchAll=false' && argument !== '--watchAll=true');

const result = spawnSync(
  process.execPath,
  ['node_modules/vitest/vitest.mjs', 'run', ...forwardedArgs],
  { stdio: 'inherit' },
);

process.exit(result.status ?? 1);
