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
  let ownerId: string;
  let loseSubscribeResponse: boolean;
  let loseUnsubscribeResponse: boolean;
  let failSubscribeBeforeCommit: boolean;
  let failChannelsAfterHumans: boolean;
  let failNextChannelRead: boolean;
  let pauseSubscribe: Promise<void> | null;
  let releaseSubscribe: (() => void) | null;
  let subscriptionStarted: Promise<void> | null;
  let markSubscriptionStarted: (() => void) | null;

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

  async function requestAccess(id = randomUUID(), targetProjectId = projectId) {
    const response = await call(`/api/projects/${targetProjectId}/access-requests`, requesterHeaders, 'POST', {id});
    expect(response.status).toBe(201);
    return id;
  }

  async function decide(id: string, decision: 'approve' | 'deny', headers: HeadersInit = ownerHeaders, targetProjectId = projectId) {
    return call(`/api/projects/${targetProjectId}/access-requests/${id}/decision`, headers, 'POST', {decision});
  }

  async function projectChannel(targetChannelId = channelId) {
    const channels = await (await call('/api/channels', ownerHeaders)).json() as {id: string; participants: {subscriberType: string; subscriberId: string}[]}[];
    return channels.find(channel => channel.id === targetChannelId)!;
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
    loseSubscribeResponse = false;
    loseUnsubscribeResponse = false;
    failSubscribeBeforeCommit = false;
    failChannelsAfterHumans = false;
    failNextChannelRead = false;
    pauseSubscribe = null;
    releaseSubscribe = null;
    subscriptionStarted = null;
    markSubscriptionStarted = null;
    const client = createOrgOpsClient('http://engine', (async (url, init) => {
      const path = new URL(String(url)).pathname;
      const method = (init?.method ?? 'GET').toUpperCase();
      if (path.endsWith('/subscribe') && method === 'POST') {
        if (failSubscribeBeforeCommit) {
          failSubscribeBeforeCommit = false;
          throw new Error('Subscription request did not receive a response');
        }
        if (pauseSubscribe) {
          markSubscriptionStarted?.();
          await pauseSubscribe;
          pauseSubscribe = null;
        }
      }
      if (failNextChannelRead && path === '/api/channels' && method === 'GET') {
        failNextChannelRead = false;
        return new Response(JSON.stringify({error: 'fixture channel outage'}), {status: 503, headers: {'content-type': 'application/json'}});
      }
      const response = await engine.app.fetch(new Request(url, init));
      if (failChannelsAfterHumans && path === '/api/humans' && method === 'GET') {
        failChannelsAfterHumans = false;
        failNextChannelRead = true;
      }
      if (loseSubscribeResponse && path.endsWith('/subscribe') && method === 'POST') {
        loseSubscribeResponse = false;
        throw new Error('Lost subscribe response after engine commit');
      }
      if (loseUnsubscribeResponse && path.endsWith('/unsubscribe') && method === 'POST') {
        loseUnsubscribeResponse = false;
        throw new Error('Lost unsubscribe response after engine commit');
      }
      return response;
    }) as typeof fetch);
    product = createApp({orgops: client, dbPath: join(dir, 'product.sqlite')});
    ownerHeaders = await login('owner');
    ownerId = (await (await call('/api/auth/me', ownerHeaders)).json() as {id: string}).id;

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

  it('denies without changing engine membership and rejects unauthorized or conflicting decisions', async () => {
    const id = await requestAccess();
    expect((await projectChannel()).participants.some(member => member.subscriberType === 'HUMAN' && member.subscriberId === 'requester-old')).toBe(false);

    expect((await decide(id, 'deny', {})).status).toBe(401);
    expect((await decide(id, 'deny', {'x-nest-runner-token': 'runner-secret'})).status).toBe(401);
    expect((await decide(id, 'deny', requesterHeaders)).status).toBe(404);

    const denied = await decide(id, 'deny');
    expect(denied.status).toBe(200);
    expect(await denied.json()).toMatchObject({id, status: 'denied', projectCollaboration: 'private'});
    expect((await decide(id, 'deny')).status).toBe(200);
    expect((await decide(id, 'approve')).status).toBe(409);
    expect((await projectChannel()).participants.some(member => member.subscriberType === 'HUMAN' && member.subscriberId === 'requester-old')).toBe(false);
    expect(await (await call(`/api/projects/${projectId}/access-request`, requesterHeaders)).json()).toMatchObject({status: 'denied', request: {id}});
  });

  it('approves by durable human ID, uses the current username, and converts a legacy project to team access', async () => {
    const id = await requestAccess();
    engine.db.prepare('UPDATE humans SET username=? WHERE id=?').run('requester-renamed', requester.id);

    const approved = await decide(id, 'approve');
    expect(approved.status).toBe(200);
    expect(await approved.json()).toMatchObject({id, status: 'approved', requesterId: requester.id, projectCollaboration: 'team'});
    expect(product.store.projects.project(projectId)?.collaboration).toBe('team');
    const humans = (await projectChannel()).participants.filter(member => member.subscriberType === 'HUMAN');
    expect(humans).toContainEqual({subscriberType: 'HUMAN', subscriberId: 'requester-renamed'});
    expect(humans).not.toContainEqual({subscriberType: 'HUMAN', subscriberId: 'requester-old'});

    const renamedHeaders = await login('requester-renamed');
    expect((await call(`/api/projects/${projectId}`, renamedHeaders)).status).toBe(200);
    expect(product.store.db.prepare("SELECT count(*) AS count FROM product_audit WHERE type='audit.project.access.approved' AND json_extract(payload_json,'$.requestId')=?").get(id)).toEqual({count: 1});
  });

  it('fails closed for a deleted requester while leaving denial available', async () => {
    const id = await requestAccess();
    engine.db.prepare('DELETE FROM humans WHERE id=?').run(requester.id);

    const approval = await decide(id, 'approve');
    expect(approval.status).toBe(409);
    expect(await approval.json()).toEqual({error: 'Requester is no longer available'});
    expect(product.store.projectAccess.get(id)?.status).toBe('pending');

    const denial = await decide(id, 'deny');
    expect(denial.status).toBe(200);
    expect(product.store.projectAccess.get(id)?.status).toBe('denied');
  });

  it('releases approval after a definite pre-subscription failure but retains an uncertain subscription claim', async () => {
    const id = await requestAccess();
    failChannelsAfterHumans = true;
    expect((await decide(id, 'approve')).status).toBe(502);
    expect(product.store.projectAccess.get(id)?.status).toBe('pending');

    failSubscribeBeforeCommit = true;
    expect((await decide(id, 'approve')).status).toBe(502);
    expect(product.store.projectAccess.get(id)?.status).toBe('approving');
    expect((await decide(id, 'deny')).status).toBe(409);

    const retried = await decide(id, 'approve');
    expect(retried.status).toBe(200);
    expect(product.store.projectAccess.get(id)?.status).toBe('approved');
  });

  it('reconciles lost subscribe responses and independently added membership without duplicate grants', async () => {
    const id = await requestAccess();
    loseSubscribeResponse = true;
    expect((await decide(id, 'approve')).status).toBe(200);
    expect((await decide(id, 'approve')).status).toBe(200);
    expect((await projectChannel()).participants.filter(member => member.subscriberType === 'HUMAN' && member.subscriberId === 'requester-old')).toHaveLength(1);
    expect(product.store.db.prepare("SELECT count(*) AS count FROM product_audit WHERE type='audit.project.access.approved' AND json_extract(payload_json,'$.requestId')=?").get(id)).toEqual({count: 1});

    const otherId = await requestAccess(randomUUID(), otherProjectId);
    expect((await call(`/api/channels/${otherChannelId}/subscribe`, ownerHeaders, 'POST', {subscriberType: 'HUMAN', subscriberId: 'requester-old'})).status).toBe(200);
    expect((await decide(otherId, 'approve', ownerHeaders, otherProjectId)).status).toBe(200);
    expect((await projectChannel(otherChannelId)).participants.filter(member => member.subscriberType === 'HUMAN' && member.subscriberId === 'requester-old')).toHaveLength(1);
  });

  it('claims approval before engine mutation so concurrent denial cannot contradict membership', async () => {
    const id = await requestAccess();
    subscriptionStarted = new Promise(resolve => { markSubscriptionStarted = resolve; });
    pauseSubscribe = new Promise(resolve => { releaseSubscribe = resolve; });
    const approval = decide(id, 'approve');
    const started = await Promise.race([subscriptionStarted.then(() => true), approval.then(() => false)]);
    expect(started).toBe(true);
    const denial = await decide(id, 'deny');
    expect(denial.status).toBe(409);
    expect(product.store.projectAccess.get(id)?.status).toBe('approving');
    releaseSubscribe?.();
    expect((await approval).status).toBe(200);
    expect((await projectChannel()).participants).toContainEqual({subscriberType: 'HUMAN', subscriberId: 'requester-old'});

    const otherId = await requestAccess(randomUUID(), otherProjectId);
    expect((await decide(otherId, 'deny', ownerHeaders, otherProjectId)).status).toBe(200);
    expect((await decide(otherId, 'approve', ownerHeaders, otherProjectId)).status).toBe(409);
    expect((await projectChannel(otherChannelId)).participants).not.toContainEqual({subscriberType: 'HUMAN', subscriberId: 'requester-old'});
  });

  it('blocks decisions when the owner can no longer manage the active channel', async () => {
    const id = await requestAccess();
    expect((await call(`/api/channels/${channelId}/archive`, ownerHeaders, 'POST', {})).status).toBe(200);
    const approval = await decide(id, 'approve');
    expect(approval.status).toBe(404);
    expect(await approval.json()).toEqual({error: 'Project unavailable'});
    const denial = await decide(id, 'deny');
    expect(denial.status).toBe(404);
    expect(await denial.json()).toEqual({error: 'Project unavailable'});
    expect(product.store.projectAccess.get(id)?.status).toBe('pending');
  });

  it('confirms revocation, reconciles a lost response, audits once, and permits another request', async () => {
    const id = await requestAccess();
    expect((await decide(id, 'approve')).status).toBe(200);
    expect((await call(`/api/projects/${projectId}`, requesterHeaders)).status).toBe(200);

    const path = `/api/projects/${projectId}/members/requester-old`;
    expect((await call(path, {}, 'DELETE')).status).toBe(401);
    expect((await call(path, {'x-nest-runner-token': 'runner-secret'}, 'DELETE')).status).toBe(401);
    expect((await call(path, requesterHeaders, 'DELETE')).status).toBe(404);
    expect((await call(`/api/projects/${projectId}/members/owner`, ownerHeaders, 'DELETE')).status).toBe(400);

    loseUnsubscribeResponse = true;
    const removed = await call(path, ownerHeaders, 'DELETE');
    expect(removed.status).toBe(200);
    expect(await removed.json()).toEqual({status: 'removed'});
    expect((await call(path, ownerHeaders, 'DELETE')).status).toBe(200);
    expect((await projectChannel()).participants).not.toContainEqual({subscriberType: 'HUMAN', subscriberId: 'requester-old'});
    expect((await call(`/api/projects/${projectId}`, requesterHeaders)).status).toBe(404);
    expect(await (await call(`/api/projects/${projectId}/access-request`, requesterHeaders)).json()).toEqual({status: 'requestable'});
    expect((await call(`/api/projects/${projectId}/access-requests`, requesterHeaders, 'POST', {id: randomUUID()})).status).toBe(201);
    expect(product.store.db.prepare("SELECT count(*) AS count FROM product_audit WHERE type='audit.project.member.revoked' AND json_extract(payload_json,'$.projectId')=? AND json_extract(payload_json,'$.memberId')=?").get(projectId, requester.id)).toEqual({count: 1});
  });
});
