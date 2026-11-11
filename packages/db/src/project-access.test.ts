import { describe, expect, it } from 'vitest';
import { openProductDb } from './index';
import type { CreateProjectAccessRequestResult, DecisionResult } from './project-access';
import { CreateProjectAccessRequestSchema, ProjectAccessDecisionSchema, type ProjectAccessRequest } from '../../schemas/src/projects';

const ownerId = 'human-owner';
const requesterId = 'human-requester';
const projectId = '11111111-1111-4111-8111-111111111111';
const requestId = '22222222-2222-4222-8222-222222222222';
const otherRequestId = '33333333-3333-4333-8333-333333333333';
const now = 1_800_000_000_000;

function setup() {
  const store = openProductDb(':memory:');
  store.projects.createProject({
    id: projectId,
    ownerId,
    channelId: 'project-channel',
    name: 'Private launch',
    description: 'Hidden project brief',
    createdAt: now - 1_000,
    collaboration: 'private',
  });
  return store;
}

function request(overrides: Partial<{
  id: string;
  projectId: string;
  requesterId: string;
  requesterUsername: string;
  createdAt: number;
}> = {}) {
  return {
    id: requestId,
    projectId,
    requesterId,
    requesterUsername: 'requester-old-name',
    createdAt: now,
    ...overrides,
  };
}

function resultRequest(result: CreateProjectAccessRequestResult | DecisionResult): ProjectAccessRequest {
  if (!('request' in result)) throw new Error(`Expected request result, received ${result.kind}`);
  return result.request;
}

function auditRows(store: ReturnType<typeof openProductDb>) {
  return store.db.prepare(
    "SELECT type,actor_id AS actorId,payload_json AS payloadJson,created_at AS createdAt FROM product_audit WHERE type IN ('audit.project.access.requested','audit.project.access.approved','audit.project.access.denied','audit.project.member.revoked') ORDER BY id",
  ).all() as {type: string; actorId: string; payloadJson: string; createdAt: number}[];
}

describe('project access request schemas', () => {
  it('accepts only UUID creation IDs and explicit owner decisions', () => {
    expect(CreateProjectAccessRequestSchema.parse({id: requestId})).toEqual({id: requestId});
    expect(ProjectAccessDecisionSchema.parse({decision: 'approve'})).toEqual({decision: 'approve'});
    expect(ProjectAccessDecisionSchema.parse({decision: 'deny'})).toEqual({decision: 'deny'});
    expect(() => CreateProjectAccessRequestSchema.parse({id: 'retry-me'})).toThrow();
    expect(() => ProjectAccessDecisionSchema.parse({decision: 'remove'})).toThrow();
  });
});

describe('project access store', () => {
  it('applies migration 011 and creates one active request idempotently', () => {
    const store = setup();
    try {
      expect(store.db.prepare('SELECT name FROM product_migrations WHERE name=?').get('011_project_access_requests')).toBeTruthy();

      const created = store.projectAccess.create(request());
      expect(created).toMatchObject({kind: 'created', request: {id: requestId, status: 'pending'}});
      const createdRequest = resultRequest(created);
      expect(store.projectAccess.create(request())).toEqual({kind: 'existing', request: createdRequest});
      expect(store.projectAccess.create(request({id: otherRequestId}))).toEqual({kind: 'existing', request: createdRequest});
      expect(store.projectAccess.activeForProjects([projectId])).toEqual([createdRequest]);

      expect(auditRows(store).map(row => ({...row, payloadJson: JSON.parse(row.payloadJson)}))).toEqual([
        {
          type: 'audit.project.access.requested',
          actorId: requesterId,
          payloadJson: {projectId, requestId, requesterId, requesterUsername: 'requester-old-name'},
          createdAt: now,
        },
      ]);
    } finally {
      store.close();
    }
  });

  it('orders active owner requests oldest first across selected projects', () => {
    const store = setup();
    try {
      const otherProjectId = '44444444-4444-4444-8444-444444444444';
      store.projects.createProject({
        id: otherProjectId,
        ownerId,
        channelId: 'other-channel',
        name: 'Other project',
        description: '',
        createdAt: now,
        collaboration: 'team',
      });
      const later = store.projectAccess.create(request({projectId: otherProjectId, createdAt: now + 20}));
      const earlier = store.projectAccess.create(request({
        id: otherRequestId,
        requesterId: 'another-human',
        requesterUsername: 'another-person',
        createdAt: now + 10,
      }));
      expect(store.projectAccess.activeForProjects([otherProjectId, projectId])).toEqual([
        'request' in earlier ? earlier.request : undefined,
        'request' in later ? later.request : undefined,
      ]);
      expect(store.projectAccess.activeForProjects([])).toEqual([]);
    } finally {
      store.close();
    }
  });

  it('rejects request ID reuse for another project or requester', () => {
    const store = setup();
    try {
      store.projects.createProject({
        id: '44444444-4444-4444-8444-444444444444',
        ownerId,
        channelId: 'other-channel',
        name: 'Other project',
        description: '',
        createdAt: now,
        collaboration: 'team',
      });
      expect(store.projectAccess.create(request()).kind).toBe('created');
      expect(store.projectAccess.create(request({requesterId: 'different-human'}))).toEqual({kind: 'conflict'});
      expect(store.projectAccess.create(request({projectId: '44444444-4444-4444-8444-444444444444'}))).toEqual({kind: 'conflict'});
    } finally {
      store.close();
    }
  });

  it('serializes approval before denial and atomically finalizes team collaboration', () => {
    const store = setup();
    try {
      store.projectAccess.create(request());
      const claimed = store.projectAccess.claimApproval(requestId, projectId, ownerId, now + 10);
      expect(claimed).toMatchObject({kind: 'changed', request: {status: 'approving', decisionStartedAt: now + 10, decidedBy: ownerId}});
      const claimedRequest = resultRequest(claimed);
      expect(store.projectAccess.claimApproval(requestId, projectId, ownerId, now + 20)).toEqual({kind: 'existing', request: claimedRequest});
      expect(store.projectAccess.deny(requestId, projectId, ownerId, now + 30)).toEqual({kind: 'conflict', request: claimedRequest});

      const approved = store.projectAccess.finishApproval(requestId, projectId, ownerId, now + 40);
      expect(approved).toMatchObject({kind: 'changed', request: {status: 'approved', decidedAt: now + 40}});
      expect(store.projects.project(projectId)?.collaboration).toBe('team');
      expect(store.projectAccess.finishApproval(requestId, projectId, ownerId, now + 50)).toEqual({kind: 'existing', request: resultRequest(approved)});

      expect(auditRows(store).map(row => row.type)).toEqual([
        'audit.project.access.requested',
        'audit.project.access.approved',
      ]);
    } finally {
      store.close();
    }
  });

  it('can release a definite pre-subscription approval failure', () => {
    const store = setup();
    try {
      store.projectAccess.create(request());
      store.projectAccess.claimApproval(requestId, projectId, ownerId, now + 10);
      expect(store.projectAccess.releaseApproval(requestId, 'not-the-owner')).toBe(false);
      expect(store.projectAccess.releaseApproval(requestId, ownerId)).toBe(true);
      expect(store.projectAccess.get(requestId)).toMatchObject({
        status: 'pending',
        decisionStartedAt: null,
        decidedAt: null,
        decidedBy: null,
      });
    } finally {
      store.close();
    }
  });

  it('retains denied history and returns the newest state before allowing another active request', () => {
    const store = setup();
    try {
      store.projectAccess.create(request());
      const denied = store.projectAccess.deny(requestId, projectId, ownerId, now + 10);
      expect(denied).toMatchObject({kind: 'changed', request: {status: 'denied', decidedAt: now + 10}});
      const deniedRequest = resultRequest(denied);
      expect(store.projectAccess.deny(requestId, projectId, ownerId, now + 20)).toEqual({kind: 'existing', request: deniedRequest});

      const replacement = store.projectAccess.create(request({id: otherRequestId, createdAt: now + 30, requesterUsername: 'requester-new-name'}));
      expect(replacement).toMatchObject({kind: 'created', request: {id: otherRequestId, status: 'pending'}});
      const replacementRequest = resultRequest(replacement);
      expect(store.projectAccess.latest(projectId, requesterId)).toEqual(replacementRequest);
      expect(store.projectAccess.activeForProjects([projectId])).toEqual([replacementRequest]);
      expect(store.projectAccess.get(requestId)).toEqual(deniedRequest);
      expect(auditRows(store).map(row => row.type)).toEqual([
        'audit.project.access.requested',
        'audit.project.access.denied',
        'audit.project.access.requested',
      ]);
    } finally {
      store.close();
    }
  });

  it('records each confirmed revocation event supplied by the membership boundary', () => {
    const store = setup();
    try {
      store.projectAccess.auditRevocation(projectId, requesterId, 'requester', ownerId, now + 10);
      store.projectAccess.auditRevocation(projectId, requesterId, 'requester', ownerId, now + 20);
      expect(auditRows(store).map(row => row.type)).toEqual([
        'audit.project.member.revoked',
        'audit.project.member.revoked',
      ]);

      store.projectAccess.create(request({createdAt: now + 30}));
      store.projectAccess.claimApproval(requestId, projectId, ownerId, now + 40);
      store.projectAccess.finishApproval(requestId, projectId, ownerId, now + 50);
      store.projectAccess.auditRevocation(projectId, requesterId, 'requester-renamed', ownerId, now + 60);
      expect(auditRows(store).map(row => row.type)).toEqual([
        'audit.project.member.revoked',
        'audit.project.member.revoked',
        'audit.project.access.requested',
        'audit.project.access.approved',
        'audit.project.member.revoked',
      ]);
    } finally {
      store.close();
    }
  });
});
