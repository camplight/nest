import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp as createEngine } from '../../../vendor/orgops/apps/api/src/app';
import { createOrgOpsClient } from '@nest/orgops-client';
import { createApp } from './app';

type JsonHeaders = Record<string, string>;

describe('project access request API against the unchanged engine', () => {
  let dir: string;
  let engine: ReturnType<typeof createEngine>;
  let product: ReturnType<typeof createApp>;
  let ownerHeaders: JsonHeaders;
  let requesterHeaders: JsonHeaders;
  let mustChangeHeaders: JsonHeaders;
  let requester: {id: string; username: string};
  let projectId: string;
  let channelId: string;
  let otherProjectId: string;
  let otherChannelId: string;

  async function call(path: string, headers: HeadersInit = ownerHeaders, method = 'GET', body?: unknown) {
    return product.app.request(path, {
      method,
      headers,
      ...(body === undefined ? {} : {body: JSON.stringify(body)}),
    });
  }

  async function login(username: string) {
    const response = await call('/api/auth/login', {'content-type': 'application/json'}, 'POST', {username, password: 'password'});
    expect(response.status).toBe(200);
    return {'content-type': 'application/json', cookie: response.headers.get('set-cookie')!.split(';')[0]};
  }

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'nest-project-access-test-'));
    engine = createEngine({
      dbPath: join(dir, 'engine.sqlite'),
      dataDir: dir,
      projectRoot: dir,
      adminUser: 'owner',
      adminPass: 'password',
      runnerToken: 'runner-secret',
    });
    const client = createOrgOpsClient('http://engine', ((url, init) => engine.app.fetch(new Request(url, init))) as typeof fetch);
    product = createApp({orgops: client, dbPath: join(dir, 'product.sqlite')});
    ownerHeaders = await login('owner');

    const invited = await call('/api/humans/invite', ownerHeaders, 'POST', {username: 'requester-old', tempPassword: 'password'});
    expect(invited.status).toBe(201);
    requester = await invited.json() as typeof requester;
    mustChangeHeaders = await login('requester-old');
    engine.db.prepare('UPDATE humans SET must_change_password=0 WHERE id=?').run(requester.id);
    requesterHeaders = await login('requester-old');

    const channel = await (await call('/api/channels', ownerHeaders, 'POST', {name: 'Hidden project room', visibility: 'PRIVATE'})).json() as {id: string};
    channelId = channel.id;
    projectId = randomUUID();
    const created = await call('/api/projects', ownerHeaders, 'POST', {
      id: projectId,
      name: 'Secret launch',
      description: 'Confidential roadmap',
      channelId,
    });
    expect(created.status).toBe(201);

    const otherChannel = await (await call('/api/channels', ownerHeaders, 'POST', {name: 'Other hidden room', visibility: 'PRIVATE'})).json() as {id: string};
    otherChannelId = otherChannel.id;
    otherProjectId = randomUUID();
    const otherCreated = await call('/api/projects', ownerHeaders, 'POST', {
      id: otherProjectId,
      name: 'Second secret launch',
      description: 'Another hidden roadmap',
      channelId: otherChannelId,
      collaboration: 'team',
    });
    expect(otherCreated.status).toBe(201);
  });

  afterEach(() => {
    product.store.close();
    engine.db.close();
    rmSync(dir, {recursive: true, force: true});
  });

  it('requires a completed human session and keeps requester state metadata-free', async () => {
    expect((await call(`/api/projects/${projectId}/access-request`, {})).status).toBe(401);
    expect((await call(`/api/projects/${projectId}/access-request`, mustChangeHeaders)).status).toBe(403);
    expect((await call(`/api/projects/${projectId}/access-requests`, {}, 'POST', {id: randomUUID()})).status).toBe(401);
    expect((await call('/api/project-access-requests', {})).status).toBe(401);

    const response = await call(`/api/projects/${projectId}/access-request`, requesterHeaders);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const text = await response.text();
    expect(JSON.parse(text)).toEqual({status: 'requestable'});
    for (const secret of ['Secret launch', 'Confidential roadmap', 'owner', channelId]) expect(text).not.toContain(secret);

    const missing = await call(`/api/projects/${randomUUID()}/access-request`, requesterHeaders);
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({error: 'Project unavailable'});
  });

  it('creates one pending request and reconciles same-ID, new-ID, and conflicting project retries', async () => {
    const id = randomUUID();
    const created = await call(`/api/projects/${projectId}/access-requests`, requesterHeaders, 'POST', {id});
    expect(created.status).toBe(201);
    const request = await created.json();
    expect(request).toEqual({status: 'pending', request: {id, createdAt: expect.any(Number)}});

    const sameRetry = await call(`/api/projects/${projectId}/access-requests`, requesterHeaders, 'POST', {id});
    expect(sameRetry.status).toBe(200);
    expect(await sameRetry.json()).toEqual(request);

    const newIdRetry = await call(`/api/projects/${projectId}/access-requests`, requesterHeaders, 'POST', {id: randomUUID()});
    expect(newIdRetry.status).toBe(200);
    expect(await newIdRetry.json()).toEqual(request);

    const conflict = await call(`/api/projects/${otherProjectId}/access-requests`, requesterHeaders, 'POST', {id});
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toEqual({error: 'Request ID already used'});
    expect(product.store.projectAccess.activeForProjects([projectId, otherProjectId])).toHaveLength(1);
  });

  it('rejects owner self-requests and gives current team members precedence over request history', async () => {
    const self = await call(`/api/projects/${projectId}/access-requests`, ownerHeaders, 'POST', {id: randomUUID()});
    expect(self.status).toBe(400);

    const requested = await call(`/api/projects/${otherProjectId}/access-requests`, requesterHeaders, 'POST', {id: randomUUID()});
    expect(requested.status).toBe(201);
    expect((await call(`/api/channels/${otherChannelId}/subscribe`, ownerHeaders, 'POST', {subscriberType: 'HUMAN', subscriberId: 'requester-old'})).status).toBe(200);

    expect(await (await call(`/api/projects/${otherProjectId}/access-request`, requesterHeaders)).json()).toEqual({status: 'member'});
    expect(await (await call(`/api/projects/${otherProjectId}/access-requests`, requesterHeaders, 'POST', {id: randomUUID()})).json()).toEqual({status: 'member'});
    expect((await call(`/api/projects/${otherProjectId}`, requesterHeaders)).status).toBe(200);
  });

  it('presents approving as pending, persists denial, and permits a new request after denial', async () => {
    const firstId = randomUUID();
    expect((await call(`/api/projects/${projectId}/access-requests`, requesterHeaders, 'POST', {id: firstId})).status).toBe(201);
    expect(product.store.projectAccess.claimApproval(firstId, projectId, 'owner-human-id', Date.now()).kind).toBe('changed');
    expect(await (await call(`/api/projects/${projectId}/access-request`, requesterHeaders)).json()).toEqual({
      status: 'pending',
      request: {id: firstId, createdAt: expect.any(Number)},
    });

    expect(product.store.projectAccess.releaseApproval(firstId, 'owner-human-id')).toBe(true);
    const denied = product.store.projectAccess.deny(firstId, projectId, 'owner-human-id', Date.now());
    expect(denied.kind).toBe('changed');
    expect(await (await call(`/api/projects/${projectId}/access-request`, requesterHeaders)).json()).toEqual({
      status: 'denied',
      request: {id: firstId, decidedAt: expect.any(Number)},
    });

    const secondId = randomUUID();
    expect((await call(`/api/projects/${projectId}/access-requests`, requesterHeaders, 'POST', {id: secondId})).status).toBe(201);
    expect(await (await call(`/api/projects/${projectId}/access-request`, requesterHeaders)).json()).toEqual({
      status: 'pending',
      request: {id: secondId, createdAt: expect.any(Number)},
    });
  });

  it('treats approved history without current membership as requestable', async () => {
    const id = randomUUID();
    expect((await call(`/api/projects/${projectId}/access-requests`, requesterHeaders, 'POST', {id})).status).toBe(201);
    expect(product.store.projectAccess.claimApproval(id, projectId, 'owner-human-id', Date.now()).kind).toBe('changed');
    expect(product.store.projectAccess.finishApproval(id, projectId, 'owner-human-id', Date.now()).kind).toBe('changed');
    expect(await (await call(`/api/projects/${projectId}/access-request`, requesterHeaders)).json()).toEqual({status: 'requestable'});
  });

  it('lists active requests only for currently manageable owner projects and resolves current usernames', async () => {
    const firstId = randomUUID();
    const secondId = randomUUID();
    expect((await call(`/api/projects/${projectId}/access-requests`, requesterHeaders, 'POST', {id: firstId})).status).toBe(201);
    expect((await call(`/api/projects/${otherProjectId}/access-requests`, requesterHeaders, 'POST', {id: secondId})).status).toBe(201);
    expect(product.store.projectAccess.claimApproval(firstId, projectId, (await (await call('/api/auth/me', ownerHeaders)).json()).id, Date.now()).kind).toBe('changed');

    engine.db.prepare('UPDATE humans SET username=? WHERE id=?').run('requester-renamed', requester.id);
    engine.db.prepare('UPDATE channels SET owner_human_id=NULL WHERE id=?').run(otherChannelId);

    const ownerResponse = await call('/api/project-access-requests', ownerHeaders);
    expect(ownerResponse.status).toBe(200);
    expect(ownerResponse.headers.get('cache-control')).toBe('no-store');
    expect(await ownerResponse.json()).toEqual([
      {
        id: firstId,
        projectId,
        projectName: 'Secret launch',
        projectCollaboration: 'private',
        requesterId: requester.id,
        requesterUsername: 'requester-renamed',
        requesterAvailable: true,
        status: 'approving',
        createdAt: expect.any(Number),
      },
    ]);

    expect(await (await call('/api/project-access-requests', requesterHeaders)).json()).toEqual([]);

    engine.db.prepare('DELETE FROM humans WHERE id=?').run(requester.id);
    expect(await (await call('/api/project-access-requests', ownerHeaders)).json()).toEqual([
      expect.objectContaining({
        id: firstId,
        requesterId: requester.id,
        requesterUsername: 'requester-old',
        requesterAvailable: false,
      }),
    ]);
  });
});
