import { Hono, type Context, type Next } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { Human, OrgOpsClient } from '@nest/orgops-client';
import type { ProductDb } from '@nest/db';
import {
  CreateProjectAccessRequestSchema,
  ProjectAccessDecisionSchema,
  type Project,
  type ProjectAccessNotification,
  type ProjectAccessRequest,
  type ProjectAccessRequesterState,
} from '@nest/schemas';

export type ProjectAccessChannel = {
  id: string;
  canManage: boolean;
  canPost: boolean;
  archivedAt?: number | null;
  participants?: {subscriberType: string; subscriberId: string}[];
};

export function canManageProject(project: Project, human: Human, channels: ProjectAccessChannel[]) {
  return project.ownerId === human.id && channels.some(channel =>
    channel.id === project.channelId && channel.canManage && channel.canPost && !channel.archivedAt,
  );
}

export function hasProjectAccess(project: Project, human: Human, channels: ProjectAccessChannel[]) {
  if (canManageProject(project, human, channels)) return true;
  return project.collaboration === 'team' && channels.some(channel =>
    channel.id === project.channelId && channel.canPost && !channel.archivedAt &&
    channel.participants?.some(member => member.subscriberType === 'HUMAN' && member.subscriberId === human.username),
  );
}

function publicRequestState(request: ProjectAccessRequest | undefined): ProjectAccessRequesterState {
  if (request?.status === 'pending' || request?.status === 'approving') {
    return {status: 'pending', request: {id: request.id, createdAt: request.createdAt}};
  }
  if (request?.status === 'denied') {
    return {status: 'denied', request: {id: request.id, decidedAt: request.decidedAt}};
  }
  return {status: 'requestable'};
}

type ProjectAccessEnv = {Variables: {human: Human; channels: ProjectAccessChannel[]}};

export function registerProjectAccessRoutes(app: Hono, {store, orgops}: {store: ProductDb; orgops: OrgOpsClient}) {
  const routes = new Hono<ProjectAccessEnv>();

  routes.use('/api/projects/*', bodyLimit({maxSize: 64_000, onError: c => c.json({error: 'Request too large'}, 413)}));
  const authenticate = async (c: Context<ProjectAccessEnv>, next: Next) => {
    const human = await orgops.currentHuman(c.req.raw.headers);
    if (!human) return c.json({error: 'Unauthorized'}, 401);
    if (human.mustChangePassword) return c.json({error: 'Complete password setup first'}, 403);
    c.set('human', human);
    c.set('channels', await orgops.humanJson<ProjectAccessChannel[]>('/api/channels', c.req.raw.headers));
    c.header('Cache-Control', 'no-store');
    await next();
  };
  routes.use('/api/projects/*', authenticate);
  routes.use('/api/project-access-requests', authenticate);

  routes.get('/api/projects/:projectId/access-request', c => {
    const project = store.projects.project(c.req.param('projectId'));
    if (!project) return c.json({error: 'Project unavailable'}, 404);
    if (hasProjectAccess(project, c.get('human'), c.get('channels'))) return c.json({status: 'member'} satisfies ProjectAccessRequesterState);
    return c.json(publicRequestState(store.projectAccess.latest(project.id, c.get('human').id)));
  });

  routes.post('/api/projects/:projectId/access-requests', async c => {
    const parsed = CreateProjectAccessRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({error: 'Invalid access request'}, 400);
    const project = store.projects.project(c.req.param('projectId'));
    if (!project) return c.json({error: 'Project unavailable'}, 404);
    const human = c.get('human');
    if (project.ownerId === human.id) return c.json({error: 'Project owners already have access'}, 400);
    if (hasProjectAccess(project, human, c.get('channels'))) return c.json({status: 'member'} satisfies ProjectAccessRequesterState);
    const result = store.projectAccess.create({
      id: parsed.data.id,
      projectId: project.id,
      requesterId: human.id,
      requesterUsername: human.username,
      createdAt: Date.now(),
    });
    if (result.kind === 'conflict') return c.json({error: 'Request ID already used'}, 409);
    return c.json(publicRequestState(result.request), result.kind === 'created' ? 201 : 200);
  });

  routes.post('/api/projects/:projectId/access-requests/:requestId/decision', async c => {
    const parsed = ProjectAccessDecisionSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({error: 'Invalid access decision'}, 400);
    const human = c.get('human');
    const project = store.projects.project(c.req.param('projectId'));
    if (!project || !canManageProject(project, human, c.get('channels'))) return c.json({error: 'Project unavailable'}, 404);
    const request = store.projectAccess.get(c.req.param('requestId'));
    if (!request || request.projectId !== project.id) return c.json({error: 'Access request unavailable'}, 404);
    const response = (value: ProjectAccessRequest) => ({...value, projectCollaboration: store.projects.project(project.id)?.collaboration ?? 'private'});

    if (parsed.data.decision === 'deny') {
      const result = store.projectAccess.deny(request.id, project.id, human.id, Date.now());
      if (result.kind === 'missing') return c.json({error: 'Access request unavailable'}, 404);
      if (result.kind === 'conflict') return c.json({error: 'Approval has started. Finish approval, then remove access if needed.', request: result.request}, 409);
      return c.json(response(result.request));
    }

    if (request.status === 'denied') return c.json({error: 'This request was already denied', request}, 409);
    if (request.status === 'approved') return c.json(response(request));
    const people = await orgops.humanJson<Human[]>('/api/humans', c.req.raw.headers);
    const requester = people.find(person => person.id === request.requesterId);
    if (!requester) return c.json({error: 'Requester is no longer available'}, 409);

    const claim = store.projectAccess.claimApproval(request.id, project.id, human.id, Date.now());
    if (claim.kind === 'missing') return c.json({error: 'Access request unavailable'}, 404);
    if (claim.kind === 'conflict') return c.json({error: 'This request has already been decided', request: claim.request}, 409);
    if (claim.request.status === 'approved') return c.json(response(claim.request));
    const newClaim = claim.kind === 'changed';
    const member = {subscriberType: 'HUMAN' as const, subscriberId: requester.username};
    const present = (channels: ProjectAccessChannel[]) => channels.find(channel => channel.id === project.channelId)?.participants
      ?.some(candidate => candidate.subscriberType === member.subscriberType && candidate.subscriberId === member.subscriberId) ?? false;

    let currentChannels: ProjectAccessChannel[];
    try {
      currentChannels = await orgops.humanJson<ProjectAccessChannel[]>('/api/channels', c.req.raw.headers);
    } catch {
      if (newClaim) store.projectAccess.releaseApproval(request.id, human.id);
      return c.json({error: 'Approval could not be confirmed. Retry safely.'}, 502);
    }
    if (!canManageProject(project, human, currentChannels)) {
      if (newClaim) store.projectAccess.releaseApproval(request.id, human.id);
      return c.json({error: 'Project unavailable'}, 404);
    }

    let attempted = false;
    if (!present(currentChannels)) {
      attempted = true;
      try {
        await orgops.humanJson(`/api/channels/${encodeURIComponent(project.channelId)}/subscribe`, c.req.raw.headers, member);
      } catch {
        // The engine may have committed before the response was lost. Confirm below.
      }
    }

    let confirmedChannels: ProjectAccessChannel[];
    try {
      confirmedChannels = await orgops.humanJson<ProjectAccessChannel[]>('/api/channels', c.req.raw.headers);
    } catch {
      if (newClaim && !attempted) store.projectAccess.releaseApproval(request.id, human.id);
      return c.json({error: 'Approval is unconfirmed. Retry to reconcile membership.'}, 502);
    }
    if (!canManageProject(project, human, confirmedChannels) || !present(confirmedChannels)) {
      if (newClaim && !attempted) store.projectAccess.releaseApproval(request.id, human.id);
      return c.json({error: 'Approval is unconfirmed. Retry to reconcile membership.'}, 502);
    }
    const finished = store.projectAccess.finishApproval(request.id, project.id, human.id, Date.now());
    if (finished.kind === 'missing') return c.json({error: 'Access request unavailable'}, 404);
    if (finished.kind === 'conflict') return c.json({error: 'This request changed during approval', request: finished.request}, 409);
    return c.json(response(finished.request));
  });

  routes.delete('/api/projects/:projectId/members/:username', async c => {
    const human = c.get('human');
    const project = store.projects.project(c.req.param('projectId'));
    if (!project || !canManageProject(project, human, c.get('channels'))) return c.json({error: 'Project unavailable'}, 404);
    const people = await orgops.humanJson<Human[]>('/api/humans', c.req.raw.headers);
    const target = people.find(person => person.username === c.req.param('username'));
    if (!target) return c.json({error: 'Member unavailable'}, 404);
    if (target.id === human.id) return c.json({error: 'The project owner cannot be removed'}, 400);
    const member = {subscriberType: 'HUMAN' as const, subscriberId: target.username};
    const present = (channels: ProjectAccessChannel[]) => channels.find(channel => channel.id === project.channelId)?.participants
      ?.some(candidate => candidate.subscriberType === member.subscriberType && candidate.subscriberId === member.subscriberId) ?? false;

    let channels = await orgops.humanJson<ProjectAccessChannel[]>('/api/channels', c.req.raw.headers);
    if (!canManageProject(project, human, channels)) return c.json({error: 'Project unavailable'}, 404);
    if (present(channels)) {
      try {
        await orgops.humanJson(`/api/channels/${encodeURIComponent(project.channelId)}/unsubscribe`, c.req.raw.headers, member);
      } catch {
        // Re-read membership because the unsubscribe may have committed.
      }
      try {
        channels = await orgops.humanJson<ProjectAccessChannel[]>('/api/channels', c.req.raw.headers);
      } catch {
        return c.json({error: 'Removal is unconfirmed. Retry safely.'}, 502);
      }
      if (!canManageProject(project, human, channels) || present(channels)) return c.json({error: 'Removal is unconfirmed. Retry safely.'}, 502);
    }
    store.projectAccess.auditRevocation(project.id, target.id, target.username, human.id, Date.now());
    return c.json({status: 'removed'} as const);
  });

  routes.get('/api/project-access-requests', async c => {
    const human = c.get('human');
    const projects = store.projects.projects(human.id).filter(project => canManageProject(project, human, c.get('channels')));
    if (!projects.length) return c.json([] satisfies ProjectAccessNotification[]);
    const [requests, humans] = await Promise.all([
      Promise.resolve(store.projectAccess.activeForProjects(projects.map(project => project.id))),
      orgops.humanJson<Human[]>('/api/humans', c.req.raw.headers),
    ]);
    const projectsById = new Map(projects.map(project => [project.id, project]));
    const humansById = new Map(humans.map(person => [person.id, person]));
    const notifications = requests.flatMap((request): ProjectAccessNotification[] => {
      if (request.status !== 'pending' && request.status !== 'approving') return [];
      const project = projectsById.get(request.projectId);
      if (!project) return [];
      const requester = humansById.get(request.requesterId);
      return [{
        id: request.id,
        projectId: project.id,
        projectName: project.name,
        projectCollaboration: project.collaboration ?? 'private',
        requesterId: request.requesterId,
        requesterUsername: requester?.username ?? request.requesterUsername,
        requesterAvailable: Boolean(requester),
        status: request.status,
        createdAt: request.createdAt,
      }];
    });
    return c.json(notifications);
  });

  app.route('/', routes);
}
