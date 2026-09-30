import { spawn } from 'node:child_process';
import { repoRoot } from './orgops-env';

const apiOnly = process.argv[2] === 'api';
const commands: string[][] = [];
if (!process.env.ORGOPS_URL) {
  commands.push(['--import', 'tsx', 'scripts/start-orgops.ts', 'api']);
  process.env.ORGOPS_URL = `http://127.0.0.1:${process.env.ORGOPS_PORT ?? 8788}`;
}
commands.push([...(process.env.NODE_ENV === 'development' ? ['--watch'] : []), '--import', 'tsx', 'apps/api/src/server.ts']);
if (!apiOnly) {
  commands.push(['--import', 'tsx', 'scripts/start-orgops.ts', 'runner']);
  commands.push(['node_modules/vite/bin/vite.js', 'preview', 'apps/admin-ui', '--config', 'apps/admin-ui/vite.config.ts', '--host', '0.0.0.0', '--port', '4173']);
  commands.push(['node_modules/vite/bin/vite.js', 'preview', 'apps/user-ui', '--config', 'apps/user-ui/vite.config.ts', '--host', '0.0.0.0', '--port', '4190']);
}
const children = commands.map(args => spawn(process.execPath, args, {cwd: repoRoot, env: process.env, stdio: 'inherit'}));
let stopping = false;
function stop(code: number) {
  if (stopping) return; stopping = true; process.exitCode = code;
  for (const child of children) child.kill('SIGTERM');
}
for (const child of children) {
  child.on('error', error => { console.error(error.message); stop(1); });
  child.on('exit', code => stop(code ?? 1));
}
process.on('SIGINT', () => stop(0)); process.on('SIGTERM', () => stop(0));
