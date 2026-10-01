import { cpSync, existsSync, mkdirSync, symlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const repoRoot = fileURLToPath(new URL('../', import.meta.url));
function ensureLink(target: string, path: string) {
  try { symlinkSync(target, path, 'junction'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
}

export function configureOrgOpsEnv() {
  // Translate configuration at the process boundary, never in upstream source.
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith('NEST_') && value !== undefined) process.env[`ORGOPS_${key.slice(5)}`] = value;
  }
  const dataDir = resolve(repoRoot, process.env.NEST_ENGINE_DATA_DIR ?? '.nest-data');
  const projectRoot = resolve(dataDir, 'engine');
  mkdirSync(projectRoot, {recursive: true});
  for (const name of ['.nest-data', '.orgops-data']) {
    ensureLink(dataDir, resolve(projectRoot, name));
  }
  const skills = resolve(projectRoot, 'skills');
  if (!existsSync(skills)) cpSync(resolve(repoRoot, 'vendor/orgops/skills'), skills, {recursive: true});
  const files = resolve(repoRoot, 'files'); mkdirSync(files, {recursive: true});
  ensureLink(files, resolve(projectRoot, 'files'));
  process.env.ORGOPS_PROJECT_ROOT = projectRoot;
  process.env.ORGOPS_RUNNER_ID_FILE = resolve(repoRoot, process.env.NEST_RUNNER_ID_FILE ?? process.env.ORGOPS_RUNNER_ID_FILE ?? '.agent-runner-id');
  return {dataDir, projectRoot};
}
