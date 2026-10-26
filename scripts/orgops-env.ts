import { cpSync, existsSync, lstatSync, mkdirSync, readlinkSync, renameSync, rmSync, symlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const repoRoot = fileURLToPath(new URL('../', import.meta.url));
function ensureLink(target: string, path: string) {
  try { symlinkSync(target, path, 'junction'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    // These are Nest-owned compatibility links. Repoint them atomically when a
    // native release moves; never delete a real user directory or its contents.
    if (!lstatSync(path).isSymbolicLink() || readlinkSync(path) === target) return;
    const temporary = `${path}.${randomUUID()}`;
    try { symlinkSync(target, temporary, 'junction'); renameSync(temporary, path); }
    finally { rmSync(temporary, {force: true}); }
  }
}

export function configureOrgOpsEnv(component: 'api' | 'runner' = 'api') {
  // Provider service credentials belong only to the Nest API, not OrgOps or skills.
  for(const key of Object.keys(process.env))if(key.startsWith('NEST_COMPOSIO_')||key.startsWith('ORGOPS_COMPOSIO_')||key.endsWith('CONNECTION_METADATA_TOKEN')||key.endsWith('MANAGEMENT_AGENT_ID')||key.endsWith('MANAGEMENT_AGENT_NAME'))delete process.env[key];
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
  const connectionSkill=resolve(skills,'nest-connections');
  if(!existsSync(connectionSkill))cpSync(resolve(repoRoot,'skills/nest-connections'),connectionSkill,{recursive:true});
  const files = resolve(repoRoot, process.env.NEST_FILES_DIR ?? 'files'); mkdirSync(files, {recursive: true});
  ensureLink(files, resolve(projectRoot, 'files'));
  process.env.ORGOPS_PROJECT_ROOT = projectRoot;
  process.env.ORGOPS_RUNNER_ID_FILE = resolve(repoRoot, process.env.NEST_RUNNER_ID_FILE ?? process.env.ORGOPS_RUNNER_ID_FILE ?? '.agent-runner-id');
  return {dataDir, projectRoot};
}
