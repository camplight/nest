import { Hono, type Context, type Next } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { Human, OrgOpsClient } from '@nest/orgops-client';
import type { ProductDb } from '@nest/db';
import {
  CreateProjectAccessRequestSchema,
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
