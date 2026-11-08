// Chat membership helpers against the unchanged engine and the Nest API, through a fetch adapter onto the product app.
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApp as createEngine} from '../../../vendor/orgops/apps/api/src/app';
import {createOrgOpsClient} from '@nest/orgops-client';
import {createApp} from '../../api/src/app';
import {ApiError} from './api';
import {addChatMember, removeChatMember} from './chat-members';
import type {Channel} from './types';

describe('chat membership helpers against the unchanged engine', () => {
  let dir: string, engine: ReturnType<typeof createEngine>, product: ReturnType<typeof createApp>;
  let owner: Record<string, string>, mate: Record<string, string>;
  const json = {'content-type': 'application/json'};
  const call = (h: Record<string, string>, method: string, path: string, body?: unknown) =>
    product.app.request(path, {method, headers: h, ...(body === undefined ? {} : {body: JSON.stringify(body)})});
  /** The browser's apiFetch/apiJson, signed in as `h`: a failed response throws ApiError with its text. */
  const adapter = (h: Record<string, string>) => {
    const fetch = async (path: string, init?: RequestInit) => {
      const response = await product.app.request(path, {...init, headers: {...(init?.headers as Record<string, string> | undefined), cookie: h.cookie}});
      if (!response.ok) throw new ApiError((await response.text()) || `Request failed: ${response.status}`, response.status);
      return response;
    };
    const fetchJson = async <T,>(path: string, init?: RequestInit) => (await (await fetch(path, init)).json()) as T;
    return {fetch, fetchJson};
  };
  const has = (list: Channel[], channelId: string, name: string) =>
    Boolean(list.find(channel => channel.id === channelId)?.participants?.some(p => p.subscriberType === 'AGENT' && p.subscriberId === name));
  /** The engine's own membership rows, independent of what the helper returned. */
  const engineHas = (channelId: string, name: string) =>
    Boolean(engine.db.prepare("SELECT 1 FROM channel_subscriptions WHERE channel_id=? AND subscriber_type='AGENT' AND subscriber_id=?").get(channelId, name));

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'nest-chat-members-test-'));
    const previous = process.env.ORGOPS_PROJECT_ROOT; process.env.ORGOPS_PROJECT_ROOT = dir;
    engine = createEngine({dbPath: join(dir, 'engine.sqlite'), dataDir: dir, adminUser: 'owner', adminPass: 'password', runnerToken: 'runner-secret'});
    if (previous === undefined) delete process.env.ORGOPS_PROJECT_ROOT; else process.env.ORGOPS_PROJECT_ROOT = previous;
    const client = createOrgOpsClient('http://engine', (async (url, init) => engine.app.fetch(new Request(url, init))) as typeof fetch);
    product = createApp({orgops: client, dbPath: join(dir, 'product.sqlite')});
    const login = async (username: string, password: string) => {
      const r = await call(json, 'POST', '/api/auth/login', {username, password});
      return {...json, cookie: r.headers.get('set-cookie')!.split(';')[0]};
    };
    owner = await login('owner', 'password');
    expect((await call(owner, 'POST', '/api/humans/invite', {username: 'mate', tempPassword: 'password'})).status).toBeLessThan(300);
    engine.db.prepare('UPDATE humans SET must_change_password=0 WHERE username=?').run('mate');
    mate = await login('mate', 'password');
    expect((await call(owner, 'POST', '/api/agents', {name: 'Pip', modelId: 'test', visibility: 'PUBLIC', workspacePath: join(dir, 'workspace')})).status).toBe(201);
  });
  afterEach(() => { product.store.close(); engine.db.close(); rmSync(dir, {recursive: true, force: true}); });

  const member = {subscriberType: 'AGENT' as const, subscriberId: 'Pip'};

  it('adds an agent to a plain channel and returns the fresh list with it', async () => {
    const channel = await (await call(owner, 'POST', '/api/channels', {name: 'Plain', visibility: 'PRIVATE'})).json() as Channel;
    const list = await addChatMember({channelId: channel.id, projectId: null, member, ...adapter(owner)});
    expect(has(list, channel.id, 'Pip')).toBe(true);
    expect(await engineHas(channel.id, 'Pip')).toBe(true);
  });

  it('adds an agent to a project chat through the project members route', async () => {
    const projectId = randomUUID();
    const project = await (await call(owner, 'POST', '/api/projects', {id: projectId, name: 'Launch', description: 'Ship it'})).json() as {channelId: string};
    expect(await engineHas(project.channelId, 'Pip')).toBe(false);
    const list = await addChatMember({channelId: project.channelId, projectId, member, ...adapter(owner)});
    expect(has(list, project.channelId, 'Pip')).toBe(true);
    expect(await engineHas(project.channelId, 'Pip')).toBe(true);
    // The project route writes the product audit row; the plain subscribe route would not.
    const audit = product.store.db.prepare("SELECT COUNT(*) AS n FROM product_audit WHERE type='audit.project.member.added'").get() as {n: number};
    expect(audit.n).toBe(1);
  });

  it('removes an agent and returns the fresh list without it', async () => {
    const channel = await (await call(owner, 'POST', '/api/channels', {name: 'Plain', visibility: 'PRIVATE'})).json() as Channel;
    await addChatMember({channelId: channel.id, projectId: null, member, ...adapter(owner)});
    const list = await removeChatMember({channelId: channel.id, member, ...adapter(owner)});
    expect(list.some(c => c.id === channel.id)).toBe(true);
    expect(has(list, channel.id, 'Pip')).toBe(false);
    expect(await engineHas(channel.id, 'Pip')).toBe(false);
  });

  it('rejects adding to a chat the human can see but not manage, and leaves the engine unchanged', async () => {
    const channel = await (await call(owner, 'POST', '/api/channels', {name: 'Owner only', visibility: 'PRIVATE'})).json() as Channel;
    expect((await call(owner, 'POST', `/api/channels/${channel.id}/subscribe`, {subscriberType: 'HUMAN', subscriberId: 'mate'})).status).toBeLessThan(300);
    const seen = await adapter(mate).fetchJson<Channel[]>('/api/channels?includeArchived=1');
    expect(seen.find(c => c.id === channel.id)?.canManage).toBe(false);
    await expect(addChatMember({channelId: channel.id, projectId: null, member, ...adapter(mate)})).rejects.toThrow('Invitation unconfirmed');
    expect(await engineHas(channel.id, 'Pip')).toBe(false);
  });

  it('rejects a removal the human may not make, keeping the engine error', async () => {
    const channel = await (await call(owner, 'POST', '/api/channels', {name: 'Owner only', visibility: 'PRIVATE'})).json() as Channel;
    await call(owner, 'POST', `/api/channels/${channel.id}/subscribe`, {subscriberType: 'HUMAN', subscriberId: 'mate'});
    await addChatMember({channelId: channel.id, projectId: null, member, ...adapter(owner)});
    await expect(removeChatMember({channelId: channel.id, member, ...adapter(mate)})).rejects.toBeInstanceOf(ApiError);
    expect(await engineHas(channel.id, 'Pip')).toBe(true);
  });
});
