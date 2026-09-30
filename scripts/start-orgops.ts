import { serve } from '@hono/node-server';
import { resolve } from 'node:path';
import { configureOrgOpsEnv } from './orgops-env';

const {dataDir} = configureOrgOpsEnv();
if (process.argv[2] === 'runner') {
  process.env.ORGOPS_API_URL = process.env.NEST_RUNNER_API_URL ?? process.env.NEST_API_URL ?? process.env.ORGOPS_URL ?? 'http://127.0.0.1:8788';
  const deadline = Date.now() + 180_000;
  while (true) {
    try { if ((await fetch(`${process.env.ORGOPS_API_URL}/health`, {signal: AbortSignal.timeout(2000)})).ok) break; } catch {}
    if (Date.now() > deadline) throw new Error('OrgOps API did not become ready');
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  const {loop} = await import('../vendor/orgops/apps/agent-runner/src/runner');
  await loop();
} else {
  const {createApp} = await import('../vendor/orgops/apps/api/src/app');
  const {app, injectWebSocket} = createApp({
    dataDir, dbPath: resolve(dataDir, process.env.NEST_ENGINE_DB_FILE ?? 'nest.sqlite'),
    runnerApiUrl: process.env.NEST_PUBLIC_API_URL ?? 'http://localhost:8787',
  });
  const server = serve({fetch: app.fetch, port: Number(process.env.ORGOPS_PORT ?? 8788), hostname: process.env.ORGOPS_BIND_HOST ?? '127.0.0.1'});
  injectWebSocket(server);
}
