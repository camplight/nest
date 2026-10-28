import {createHash} from 'node:crypto';
import {mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {isDeepStrictEqual} from 'node:util';

const legacy = '/app/.nest-data/codex-runtime/nestsystem-bridge.mjs';
const canonical = '/app/deploy/nestsystem-bridge.mjs';

// Only the explicitly pinned NestSystem recipe is managed here. Other wrapped
// agents, custom commands, workspaces and session mappings remain operator-owned.
export async function reconcileNestSystemBridge({agentName, agentId, apiUrl, token, dataDir, fetchImpl = fetch}) {
  if (agentName !== 'NestSystem' || !agentId) return 'not-configured';
  if (!apiUrl || !token) throw Error('NestSystem bridge reconciliation context missing');
  const request = async (method, body) => {
    const response = await fetchImpl(new URL('/api/agents/NestSystem', apiUrl), {
      method, redirect: 'error', signal: AbortSignal.timeout(5000),
      headers: {'content-type': 'application/json', 'x-orgops-runner-token': token},
      ...(body ? {body: JSON.stringify(body)} : {}),
    });
    if (method === 'GET' && response.status === 404) return null;
    if (!response.ok) {
      await response.body?.cancel();
      throw Error('NestSystem bridge reconciliation failed');
    }
    return response.json();
  };
  const agent = await request('GET');
  if (!agent) return 'not-found';
  if (agent.id !== agentId || agent.mode !== 'WRAPPED') return 'not-managed';
  const config = agent.wrappedConfig;
  const command = config?.runtime?.command;
  if (config?.kind !== 'codex' || (config.harness && config.harness !== 'command') || typeof command !== 'string') return 'needs-review';
  if (command.trimEnd().endsWith(`node ${canonical}`)) return 'current';
  if (!command.trimEnd().endsWith(`node ${legacy}`)) return 'needs-review';

  // Verify the release contains the executable before changing the stored recipe.
  readFileSync(new URL('../deploy/nestsystem-bridge.mjs', import.meta.url));
  const next = structuredClone(config);
  next.runtime.command = command.replace(new RegExp(`node ${legacy.replaceAll('.', '\\.')}\\s*$`), `node ${canonical}`);
  const setup = next.setup?.command;
  if (typeof setup === 'string') {
    // Remove only the generated legacy file-write statement; preserve directory
    // preparation, environment aliases and all other setup/configuration fields.
    const write = /fs\.writeFileSync\("\/app\/\.nest-data\/codex-runtime\/nestsystem-bridge\.mjs",Buffer\.from\("[A-Za-z0-9+/=]+","base64"\),\{mode:0o644\}\);/;
    if (!write.test(setup)) return 'needs-review';
    next.setup.command = setup.replace(write, '');
  }
  const directory = join(dataDir, 'codex-runtime', 'bridge-config-backups');
  mkdirSync(directory, {recursive: true, mode: 0o700});
  const snapshot = JSON.stringify({agentId, wrappedConfig: config});
  const hash = createHash('sha256').update(snapshot).digest('hex');
  try {writeFileSync(join(directory, `${hash}.json`), snapshot + '\n', {mode: 0o600, flag: 'wx'});}
  catch (error) {if (error.code !== 'EEXIST') throw error;}
  await request('PATCH', {wrappedConfig: next});
  const saved = await request('GET');
  if (saved?.id !== agentId || !isDeepStrictEqual(saved.wrappedConfig, next)) throw Error('NestSystem bridge verification failed');
  return 'migrated';
}
