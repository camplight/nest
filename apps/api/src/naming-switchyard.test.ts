import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const generate = vi.hoisted(() => vi.fn());
vi.mock('@orgops/llm', async importOriginal => ({ ...(await importOriginal<typeof import('@orgops/llm')>()), generate }));

import { createApp as createEngine } from '../../../vendor/orgops/apps/api/src/app';
import { createOrgOpsClient } from '@nest/orgops-client';
import { createApp } from './app';

// Naming and summaries on an install with no management or naming agent: provider keys live only
// as public engine secrets and are read as the Switchyard agent, through the real engine over HTTP.
describe('naming and summaries fall back to the Switchyard agent', () => {
  let dir: string, engine: ReturnType<typeof createEngine>, product: ReturnType<typeof createApp>, headers: Record<string, string>;
  let channelId: string, projectId: string;
  const logs: string[] = [];
  const request = (path: string, body?: unknown, h = headers) => product.app.request(path, { method: body === undefined ? 'GET' : 'POST', headers: h, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const build = () => {
    const client = createOrgOpsClient('http://engine', (async (url, init) => engine.app.fetch(new Request(url, init))) as typeof fetch);
    return createApp({ orgops: client, dbPath: join(dir, 'product.sqlite'), projectNamingModelId: 'naming-model', defaultAgentModelId: 'naming-model', projectNamingLog: line => logs.push(line) });
  };
  beforeEach(async () => {
    logs.length = 0; generate.mockReset();
    dir = mkdtempSync(join(tmpdir(), 'nest-naming-switchyard-'));
    vi.stubEnv('NEST_RUNNER_TOKEN', 'runner-secret'); vi.stubEnv('ORGOPS_MASTER_KEY', Buffer.alloc(32, 7).toString('base64'));
    for (const name of ['NEST_MANAGEMENT_AGENT_NAME', 'NEST_MANAGEMENT_AGENT_ID', 'NEST_PROJECT_NAMING_AGENT_NAME', 'NEST_SWITCHYARD_AGENT_NAME', 'OPENROUTER_API_KEY']) vi.stubEnv(name, '');
    engine = createEngine({ dbPath: join(dir, 'engine.sqlite'), dataDir: dir, adminUser: 'owner', adminPass: 'password', runnerToken: 'runner-secret' });
    product = build();
    const login = await request('/api/auth/login', { username: 'owner', password: 'password' }, { 'content-type': 'application/json' });
    headers = { 'content-type': 'application/json', cookie: login.headers.get('set-cookie')!.split(';')[0] };
    channelId = (await (await request('/api/channels', { name: 'Room', visibility: 'PRIVATE' })).json()).id;
    await request('/api/models', { id: 'naming-model', provider: 'openrouter', modelName: 'fixture', enabled: true });
    await request('/api/secrets', { name: 'OPENROUTER_API_KEY', value: 'fixture-provider-key', scopeType: 'public' });
    projectId = randomUUID();
    expect((await request('/api/projects', { id: projectId, name: 'Launch', description: 'Ship a useful result', channelId })).status).toBe(201);
    expect((await request('/api/messages', { id: randomUUID(), channelId, text: 'Plan an autumn website launch.' })).status).toBe(201);
    await request(`/api/projects/${projectId}/suggest-details`, { messageRequestId: product.store.db.prepare('SELECT id FROM product_message_requests').get() ? (product.store.db.prepare('SELECT id FROM product_message_requests').get() as { id: string }).id : '', expected: { name: 'Launch', description: 'Ship a useful result' } });
  });
  afterEach(() => { vi.unstubAllEnvs(); product.store.close(); engine.db.close(); rmSync(dir, { recursive: true, force: true }); });
  const addSwitchyard = async () => expect((await request('/api/agents', { name: 'Switchyard', modelId: 'test', workspacePath: join(dir, 'sw') })).status).toBe(201);

  it('names a chat and summarises using the Switchyard agent keys', async () => {
    await addSwitchyard();
    generate.mockResolvedValue({ text: JSON.stringify({ name: 'Autumn launch', description: 'Launch the website this autumn.' }) });
    await product.projectNaming.tick();
    expect(generate).toHaveBeenCalledWith('openrouter:fixture', expect.anything(), expect.objectContaining({ env: expect.objectContaining({ OPENROUTER_API_KEY: 'fixture-provider-key' }) }));
    expect(product.store.projects.project(projectId)?.name).toBe('Autumn launch');
    generate.mockResolvedValue({ text: 'It shipped.' });
    expect(await product.summarize({ texts: ['done'], purpose: 'handoff', actor: 'a', ref: {} })).toEqual({ text: 'Summary (by openrouter:fixture):\nIt shipped.', model: 'openrouter:fixture' });
    expect(generate).toHaveBeenLastCalledWith('openrouter:fixture', expect.anything(), expect.objectContaining({ env: expect.objectContaining({ OPENROUTER_API_KEY: 'fixture-provider-key' }) }));
  });

  it('logs one sanitized category when the provider is unavailable', async () => {
    await product.projectNaming.tick();
    expect(logs).toEqual(['project naming: provider unavailable']);
    expect(generate).not.toHaveBeenCalled();
  });
});
