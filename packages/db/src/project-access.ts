import type Database from 'better-sqlite3';
import type { ProjectAccessRequest } from '../../schemas/src/projects';

export type CreateProjectAccessRequestInput = Pick<
  ProjectAccessRequest,
  'id' | 'projectId' | 'requesterId' | 'requesterUsername' | 'createdAt'
>;

export type CreateProjectAccessRequestResult =
  | {kind: 'created' | 'existing'; request: ProjectAccessRequest}
  | {kind: 'conflict'};

export type DecisionResult =
  | {kind: 'changed' | 'existing' | 'conflict'; request: ProjectAccessRequest}
  | {kind: 'missing'};

const columns = `
  id,
  project_id AS projectId,
  requester_id AS requesterId,
  requester_username AS requesterUsername,
  status,
  created_at AS createdAt,
  decision_started_at AS decisionStartedAt,
  decided_at AS decidedAt,
  decided_by AS decidedBy
`;

export function createProjectAccessStore(db: Database.Database) {
  const byId = db.prepare(`SELECT ${columns} FROM product_project_access_requests WHERE id=?`);

  function get(id: string) {
    return byId.get(id) as ProjectAccessRequest | undefined;
  }

  function latest(projectId: string, requesterId: string) {
    return db.prepare(`
      SELECT ${columns}
      FROM product_project_access_requests
      WHERE project_id=? AND requester_id=?
      ORDER BY created_at DESC, rowid DESC
      LIMIT 1
    `).get(projectId, requesterId) as ProjectAccessRequest | undefined;
  }

  function audit(type: string, actorId: string, payload: unknown, at: number) {
    db.prepare('INSERT INTO product_audit(type,actor_id,payload_json,created_at) VALUES (?,?,?,?)')
      .run(type, actorId, JSON.stringify(payload), at);
  }

  const createTransaction = db.transaction((input: CreateProjectAccessRequestInput): CreateProjectAccessRequestResult => {
    const sameId = get(input.id);
    if (sameId) {
      if (sameId.projectId !== input.projectId || sameId.requesterId !== input.requesterId) return {kind: 'conflict'};
      return {kind: 'existing', request: sameId};
    }
    const active = db.prepare(`
      SELECT ${columns}
      FROM product_project_access_requests
      WHERE project_id=? AND requester_id=? AND status IN ('pending','approving')
      ORDER BY created_at DESC, rowid DESC
      LIMIT 1
    `).get(input.projectId, input.requesterId) as ProjectAccessRequest | undefined;
    if (active) return {kind: 'existing', request: active};
    db.prepare(`
      INSERT INTO product_project_access_requests(
        id,project_id,requester_id,requester_username,status,created_at,
        decision_started_at,decided_at,decided_by
      ) VALUES (?,?,?,?, 'pending', ?,NULL,NULL,NULL)
    `).run(input.id, input.projectId, input.requesterId, input.requesterUsername, input.createdAt);
    audit('audit.project.access.requested', input.requesterId, {
      projectId: input.projectId,
      requestId: input.id,
      requesterId: input.requesterId,
      requesterUsername: input.requesterUsername,
    }, input.createdAt);
    return {kind: 'created', request: get(input.id)!};
  });

  function create(input: CreateProjectAccessRequestInput) {
    return createTransaction(input);
  }

  function activeForProjects(projectIds: string[]) {
    if (!projectIds.length) return [];
    return db.prepare(`
      SELECT ${columns}
      FROM product_project_access_requests
      WHERE project_id IN (${projectIds.map(() => '?').join(',')})
        AND status IN ('pending','approving')
      ORDER BY created_at, rowid
    `).all(...projectIds) as ProjectAccessRequest[];
  }

  const denyTransaction = db.transaction((requestId: string, projectId: string, ownerId: string, at: number): DecisionResult => {
    const current = get(requestId);
    if (!current || current.projectId !== projectId) return {kind: 'missing'};
    if (current.status === 'denied') return {kind: 'existing', request: current};
    if (current.status !== 'pending') return {kind: 'conflict', request: current};
    const changed = db.prepare(`
      UPDATE product_project_access_requests
      SET status='denied', decided_at=?, decided_by=?
      WHERE id=? AND project_id=? AND status='pending'
    `).run(at, ownerId, requestId, projectId).changes;
    if (!changed) {
      const raced = get(requestId);
      return raced ? {kind: 'conflict', request: raced} : {kind: 'missing'};
    }
    audit('audit.project.access.denied', ownerId, {
      projectId,
      requestId,
      requesterId: current.requesterId,
      requesterUsername: current.requesterUsername,
    }, at);
    return {kind: 'changed', request: get(requestId)!};
  });

  function deny(requestId: string, projectId: string, ownerId: string, at: number) {
    return denyTransaction(requestId, projectId, ownerId, at);
  }

  const claimApprovalTransaction = db.transaction((requestId: string, projectId: string, ownerId: string, at: number): DecisionResult => {
    const current = get(requestId);
    if (!current || current.projectId !== projectId) return {kind: 'missing'};
    if (current.status === 'approved') return {kind: 'existing', request: current};
    if (current.status === 'approving') {
      return current.decidedBy === ownerId
        ? {kind: 'existing', request: current}
        : {kind: 'conflict', request: current};
    }
    if (current.status !== 'pending') return {kind: 'conflict', request: current};
    const changed = db.prepare(`
      UPDATE product_project_access_requests
      SET status='approving', decision_started_at=?, decided_by=?
      WHERE id=? AND project_id=? AND status='pending'
    `).run(at, ownerId, requestId, projectId).changes;
    if (!changed) {
      const raced = get(requestId);
      return raced ? {kind: 'conflict', request: raced} : {kind: 'missing'};
    }
    return {kind: 'changed', request: get(requestId)!};
  });

  function claimApproval(requestId: string, projectId: string, ownerId: string, at: number) {
    return claimApprovalTransaction(requestId, projectId, ownerId, at);
  }

  function releaseApproval(requestId: string, ownerId: string) {
    return db.prepare(`
      UPDATE product_project_access_requests
      SET status='pending', decision_started_at=NULL, decided_at=NULL, decided_by=NULL
      WHERE id=? AND status='approving' AND decided_by=?
    `).run(requestId, ownerId).changes === 1;
  }

  const finishApprovalTransaction = db.transaction((requestId: string, projectId: string, ownerId: string, at: number): DecisionResult => {
    const current = get(requestId);
    if (!current || current.projectId !== projectId) return {kind: 'missing'};
    if (current.status === 'approved') return {kind: 'existing', request: current};
    if (current.status !== 'approving' || current.decidedBy !== ownerId) return {kind: 'conflict', request: current};
    const changed = db.prepare(`
      UPDATE product_project_access_requests
      SET status='approved', decided_at=?
      WHERE id=? AND project_id=? AND status='approving' AND decided_by=?
    `).run(at, requestId, projectId, ownerId).changes;
    if (!changed) {
      const raced = get(requestId);
      return raced ? {kind: 'conflict', request: raced} : {kind: 'missing'};
    }
    db.prepare("UPDATE product_projects SET collaboration='team' WHERE id=? AND collaboration='private'").run(projectId);
    audit('audit.project.access.approved', ownerId, {
      projectId,
      requestId,
      requesterId: current.requesterId,
      requesterUsername: current.requesterUsername,
    }, at);
    return {kind: 'changed', request: get(requestId)!};
  });

  function finishApproval(requestId: string, projectId: string, ownerId: string, at: number) {
    return finishApprovalTransaction(requestId, projectId, ownerId, at);
  }

  const auditRevocationTransaction = db.transaction((
    projectId: string,
    memberId: string,
    memberUsername: string,
    ownerId: string,
    at: number,
  ) => {
    audit('audit.project.member.revoked', ownerId, {projectId, memberId, memberUsername}, at);
  });

  function auditRevocation(projectId: string, memberId: string, memberUsername: string, ownerId: string, at: number) {
    auditRevocationTransaction(projectId, memberId, memberUsername, ownerId, at);
  }

  return {
    get,
    latest,
    create,
    activeForProjects,
    deny,
    claimApproval,
    releaseApproval,
    finishApproval,
    auditRevocation,
  };
}
