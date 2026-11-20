import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { bodyLimit } from 'hono/body-limit';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { ProductDb } from '@nest/db';
import { CanvasConflictError, CanvasForbiddenError, CanvasLimitError, type Fork } from '@nest/db';
import type { Human, OrgOpsClient } from '@nest/orgops-client';
import { availableHome, isChatMember, type ContextAgents } from './canvas-context';
import { removeStored, type ContextFiles } from './context-files';
import { linkRights } from './flows/access';
import {
  AgentPinsSchema, areaFor, CARD_HEIGHT, DEFAULT_CARD_WIDTH, homeAfterMove, NewCanvasSchema, CanvasRenameSchema, CanvasSharingSchema, HiddenSchema, NewAreaSchema, AreaPatchSchema, PlaceCardsSchema, CardPatchSchema,
  type AgentPins, type BoardCard, type BoardLink, type Canvas, type CanvasArea, type CanvasBoard, type CanvasCardRow, type Link,
} from '@nest/schemas';

export type Channel = {
  id: string; name?: string; kind?: string; visibility?: string; archivedAt?: number | null; ownerHumanId?: string | null;
  participants?: { subscriberType: string; subscriberId: string }[]; canManage?: boolean;
};
type Person = { id: string; username: string };
/** Links and forks for one board. Links are resolved for `viewer`; only pairs with both cards on the canvas are shown. */
export type BoardFlows = { links: Link[]; forks: Fork[]; viewer: Person };

/**
 * A link as one viewer may see it: label and settings when the viewer can read either chat, else a bare
 * line, like a locked card.
 */
export function boardLink(link: Link, visible: Map<string, Channel>, viewer: Person): BoardLink {
  const base = { id: link.id, kind: link.kind, from: link.from, to: link.to, on: link.on };
  if (!visible.has(link.from) && !visible.has(link.to)) return { ...base, access: 'locked' };
  return {
    ...base, access: 'open', label: link.label, what: link.what, when: link.when, who: link.who, pausedReason: link.pausedReason,
    ...linkRights(link, visible.get(link.to), viewer),
  };
}
const uuid = z.string().uuid();

/**
 * Privacy boundary of the canvas: a card is described only if the engine lists its chat for
 * the viewer. Anything else exposes at most the chat's engine owner (`ownerLabel`, recorded when
 * the card was placed), never the chat itself.
 */
export function resolveBoard(
  rows: CanvasCardRow[], areas: CanvasArea[], canvas: Canvas, channels: Channel[],
  projectsByChannel: Map<string, { id: string; name: string }>, viewerId: string,
  homeFor: (row: CanvasCardRow, areaId: string | null) => { isHere: boolean; label: string | null } | null = () => null,
  flows: BoardFlows = { links: [], forks: [], viewer: { id: viewerId, username: '' } },
): CanvasBoard {
  const visible = new Map(channels.map(ch => [ch.id, ch]));
  const titleOf = (ch: Channel) => projectsByChannel.get(ch.id)?.name ?? ch.name ?? '';
  const parents = new Map(flows.forks.map(fork => [fork.childChannelId, fork.parentChannelId]));
  const forkOf = (channelId: string) => {
    const parent = parents.get(channelId);
    if (!parent) return null;
    const ch = visible.get(parent);
    return { channelId: parent, title: ch ? titleOf(ch) : 'another chat' };
  };
  const cards = rows.map((row): BoardCard => {
    const { ownerLabel, projectId, ...base } = row;
    const ch = visible.get(row.channelId);
    if (ch) {
      const project = projectsByChannel.get(row.channelId);
      return {
        ...base, access: 'open', title: titleOf(ch), ...(ch.kind ? { kind: ch.kind } : {}),
        projectId: project?.id ?? projectId, participants: ch.participants ?? [], archived: Boolean(ch.archivedAt), canManage: Boolean(ch.canManage),
        home: homeFor(row, areaFor({ x: row.x + row.w / 2, y: row.y + CARD_HEIGHT / 2 }, areas)?.id ?? null),
        forkOf: forkOf(row.channelId),
      };
    }
    return row.placedBy === viewerId ? { ...base, access: 'unavailable' } : { ...base, access: 'locked', ownerLabel };
  });
  const onCanvas = new Set(rows.map(row => row.channelId));
  const links = flows.links.filter(l => onCanvas.has(l.from) && onCanvas.has(l.to)).map(l => boardLink(l, visible, flows.viewer));
  // Links and forks are hashed too, or a link-only change would answer {unchanged:true} (S2).
  const etag = createHash('sha256').update(JSON.stringify({ canvas, areas, cards, links })).digest('hex');
  return { canvas, areas, cards, links, etag };
}

// Card rows from the store carry a project id and owner label; hand them back only for chats the caller can see.
function forViewer(rows: CanvasCardRow[], channels: Channel[]) {
  const seen = new Set(channels.map(ch => ch.id));
  return rows.map(row => {
    if (seen.has(row.channelId)) return row;
    const { ownerLabel: _ownerLabel, ...rest } = row;
    return { ...rest, projectId: null } as CanvasCardRow;
  });
}

export function registerCanvasRoutes(app: Hono, { store, orgops, enabled, files, agents }: {
  store: ProductDb; orgops: OrgOpsClient; enabled: boolean; files?: Pick<ContextFiles, 'remove'>; agents?: ContextAgents;
}) {
  // `channels` is every chat the engine lists for the caller, archived ones included, read once per request.
  const routes = new Hono<{ Variables: { human: Human; channels: Channel[] } }>();
  const canvases = store.canvases;
  routes.onError((error, c) => {
    if (error instanceof HTTPException) return c.json({ error: error.message }, error.status);
    if (error instanceof CanvasConflictError) {
      // Card rows carry a project id and owner label: shape them for this viewer like any other card.
      const current = error.current;
      const shaped = current && 'channelId' in current ? forViewer([current], c.get('channels') ?? [])[0] : current;
      return c.json({ error: 'Canvas changed', current: shaped }, 409);
    }
    if (error instanceof CanvasForbiddenError) return c.json({ error: error.message }, 403);
    if (error instanceof CanvasLimitError) return c.json({ error: error.message }, 400);
    console.error('Canvas request failed:', error.name);
    return c.json({ error: 'The engine is unavailable. Canvas data is retained; refresh and retry.' }, 502);
  });
  const notFound = () => new HTTPException(404, { message: 'Not found' });
  function parse<T>(schema: z.ZodType<T>, value: unknown): T {
    const result = schema.safeParse(value);
    if (!result.success) throw new HTTPException(400, { message: result.error.issues.map(i => i.message).join('; ') });
    return result.data;
  }
  const body = async (c: { req: { json(): Promise<unknown> } }) => c.req.json().catch(() => null);

  routes.use('/api/canvases', bodyLimit({ maxSize: 64_000, onError: c => c.json({ error: 'Request too large' }, 413) }));
  routes.use('/api/canvases/*', bodyLimit({ maxSize: 64_000, onError: c => c.json({ error: 'Request too large' }, 413) }));
  const auth = async (c: any, next: () => Promise<void>) => {
    const human = await orgops.currentHuman(c.req.raw.headers);
    if (!human) return c.json({ error: 'Unauthorized' }, 401);
    if (human.mustChangePassword) return c.json({ error: 'Complete password setup first' }, 403);
    c.set('human', human);
    c.header('Cache-Control', 'no-store');
    await next();
  };
  routes.use('/api/canvases', auth);
  routes.use('/api/canvases/*', auth);
  routes.get('/api/canvases/availability', c => c.json({ available: enabled }));
  routes.use('/api/canvases', async (_c, next) => { if (!enabled) throw notFound(); await next(); });
  routes.use('/api/canvases/*', async (c, next) => {
    if (!enabled) throw notFound();
    // Tray pins never read chats; they skip the channel list.
    if (c.req.path !== '/api/canvases/agent-pins')
      c.set('channels', await orgops.humanJson<Channel[]>('/api/channels?includeArchived=1', c.req.raw.headers));
    await next();
  });

  // Registered before /:id so these literal paths are never read as canvas ids.
  routes.get('/api/canvases/hidden', c => c.json({ channelIds: canvases.hidden(c.get('human').id) }));
  routes.post('/api/canvases/hidden', async c => {
    const input = parse(HiddenSchema, await body(c));
    const human = c.get('human');
    // Only channels the caller can see (and not archived) are stored; others are dropped silently.
    const visible = new Set(c.get('channels').filter(channel => !channel.archivedAt).map(channel => channel.id));
    const ids = input.channelIds.filter(id => visible.has(id));
    canvases.setHidden(human.id, ids, input.hidden);
    const hidden = canvases.hidden(human.id);
    // Archive pauses the person's own hand-offs to and from these chats; unarchive resumes the ones it paused.
    if (input.hidden) store.flows.archiveLinks(human.id, ids);
    else store.flows.unarchiveLinks(human.id, ids, new Set(hidden));
    return c.json({ channelIds: hidden });
  });

  // Agents pinned to the person's tray, across canvases and devices. Agents the engine no longer lists for them
  // (deleted, or private to someone else) are dropped silently, on read and on save.
  const visibleAgents = async (c: any) =>
    new Set((await orgops.humanJson<{ name: string }[]>('/api/agents', c.req.raw.headers)).map(agent => agent.name));
  const pinsFor = (names: string[] | null, visible: Set<string>): AgentPins =>
    ({ agentNames: (names ?? []).filter(name => visible.has(name)), saved: names !== null });
  routes.get('/api/canvases/agent-pins', async c => c.json(pinsFor(store.agentPins.get(c.get('human').id), await visibleAgents(c))));
  routes.put('/api/canvases/agent-pins', async c => {
    const input = parse(AgentPinsSchema, await body(c));
    const visible = await visibleAgents(c);
    const humanId = c.get('human').id;
    // Checked and written with no await between them, so a seeded save can never replace pins saved meanwhile.
    const existing = store.agentPins.get(humanId);
    if (input.expectSaved === false && existing !== null)
      return c.json({ error: 'Pins already saved', current: pinsFor(existing, visible) }, 409);
    const saved = store.agentPins.set(humanId, input.agentNames.filter(name => visible.has(name)));
    return c.json(pinsFor(saved, visible));
  });

  routes.get('/api/canvases', c => c.json(canvases.list(c.get('human').id)));
  routes.post('/api/canvases', async c => {
    const input = parse(NewCanvasSchema, await body(c));
    const human = c.get('human');
    const used = store.db.prepare('SELECT owner_id AS ownerId, name FROM product_canvases WHERE id=?').get(input.id) as { ownerId: string; name: string } | undefined;
    if (used) {
      if (used.ownerId === human.id && used.name === input.name) return c.json(canvases.get(input.id, human.id));
      return c.json({ error: 'Canvas ID already used' }, 409);
    }
    return c.json(canvases.create(input, human.id), 201);
  });

  routes.all('/api/canvases/:id/*', async (c, next) => { if (!uuid.safeParse(c.req.param('id')).success) throw notFound(); await next(); });
  routes.all('/api/canvases/:id', async (c, next) => { if (!uuid.safeParse(c.req.param('id')).success) throw notFound(); await next(); });
  // Missing and inaccessible canvases are indistinguishable (404); only then can a write answer 403.
  function visible(c: { req: { param(name: string): string }; get(key: 'human'): Human }) {
    const canvas = canvases.get(c.req.param('id'), c.get('human').id);
    if (!canvas) throw notFound();
    return canvas;
  }
  routes.patch('/api/canvases/:id', async c => {
    const canvas = visible(c);
    const input = parse(CanvasRenameSchema, await body(c));
    return c.json(canvases.rename(canvas.id, input.name, input.version, c.get('human').id));
  });
  // Context files are unlinked only after the delete commits; their keys are read before the rows go.
  const unlinkContext = async (storageKeys: string[]) => { if (files) await removeStored(files, storageKeys); };
  routes.delete('/api/canvases/:id', async c => {
    const canvas = visible(c);
    const version = Number(c.req.query('version'));
    if (!c.req.query('version') || !Number.isInteger(version) || version < 0) throw new HTTPException(400, { message: 'version is required' });
    const storageKeys = store.canvasContext.storageKeysFor(canvas.id);
    canvases.remove(canvas.id, version, c.get('human').id);
    await unlinkContext(storageKeys);
    return c.body(null, 204);
  });

  async function people(headers: HeadersInit) { return orgops.humanJson<Person[]>('/api/humans', headers); }
  function sharing(canvasId: string, humans: Person[], visibility: string) {
    const names = new Map(humans.map(h => [h.id, h.username]));
    return { visibility, members: canvases.members(canvasId).map(m => ({ humanId: m.humanId, username: names.get(m.humanId) ?? m.humanId, role: m.role })) };
  }
  routes.get('/api/canvases/:id/members', async c => {
    const canvas = visible(c);
    return c.json(sharing(canvas.id, await people(c.req.raw.headers), canvas.visibility));
  });
  routes.put('/api/canvases/:id/members', async c => {
    const canvas = visible(c);
    const human = c.get('human');
    if (canvas.role !== 'owner') throw new CanvasForbiddenError('Only the owner can change sharing');
    const input = parse(CanvasSharingSchema, await body(c));
    const humans = await people(c.req.raw.headers);
    const known = new Set(humans.map(h => h.id));
    if (input.members.some(m => !known.has(m.humanId))) throw new HTTPException(400, { message: 'Unknown teammate' });
    const updated = canvases.setSharing(canvas.id, input, human.id);
    return c.json(sharing(canvas.id, humans, updated.visibility));
  });

  const requiredVersion = (c: { req: { query(name: string): string | undefined } }) => {
    const raw = c.req.query('version');
    const version = Number(raw);
    if (!raw || !Number.isInteger(version) || version < 0) throw new HTTPException(400, { message: 'version is required' });
    return version;
  };
  // Home labels name an area or canvas, so they appear only for viewers who can read the home canvas.
  function homeLabels(human: Human, canvasId: string) {
    const readable = new Map<string, string | null>();
    const canvasName = (id: string) => {
      if (!readable.has(id)) readable.set(id, canvases.get(id, human.id)?.name ?? null);
      return readable.get(id)!;
    };
    const areaTitle = (id: string) => (store.db.prepare('SELECT title FROM product_canvas_areas WHERE id=?').get(id) as { title: string } | undefined)?.title;
    return (row: CanvasCardRow, areaId: string | null) => {
      const home = store.canvasContext.home(row.channelId);
      if (!home) return null;
      // Its setter lost the home canvas: nothing is read from it until a member re-homes the chat (R21).
      if (!availableHome(store, row.channelId)) return { isHere: false, label: null, available: false as const };
      const isHere = home.canvasId === canvasId && home.areaId === areaId;
      const name = canvasName(home.canvasId);
      if (name === null) return { isHere, label: 'another canvas' };
      return { isHere, label: home.areaId ? areaTitle(home.areaId) ?? name : name };
    };
  }
  function buildBoard(human: Human, channels: Channel[], canvasId: string) {
    const canvas = canvases.get(canvasId, human.id);
    if (!canvas) throw notFound();
    const rows = canvases.cards(canvasId);
    const ids = rows.map(r => r.channelId);
    const forks = store.flows.forkOf(ids);
    return resolveBoard(rows, canvases.areas(canvasId), canvas, channels, store.projects.byChannels([...ids, ...forks.map(f => f.parentChannelId)]), human.id, homeLabels(human, canvasId),
      { links: store.flows.linksTouching(ids), forks, viewer: human });
  }
  routes.get('/api/canvases/:id/board', async c => {
    const canvas = visible(c);
    const board = buildBoard(c.get('human'), c.get('channels'), canvas.id);
    if (agents) {
      // Polled every few seconds: decide from the channel list already loaded, so a settled board makes
      // no engine calls, and never make the read wait for (or fail on) agent setup.
      try {
        const open = new Set(board.cards.filter(card => card.access === 'open').map(card => card.channelId));
        const pending = agents.pending(c.get('channels').filter(ch => open.has(ch.id)));
        if (pending.length) void agents.ensureAgents(pending).catch(() => undefined);
      } catch (error) {
        console.error('Context agent setup failed:', (error as Error).name);
      }
    }
    const etag = c.req.query('etag');
    if (etag && etag === board.etag) return c.json({ unchanged: true });
    return c.json(board);
  });

  routes.post('/api/canvases/:id/areas', async c => {
    const canvas = visible(c);
    const input = parse(NewAreaSchema, await body(c));
    if (canvases.areas(canvas.id).some(a => a.id === input.id)) return c.json({ error: 'Area ID already used' }, 409);
    return c.json(canvases.createArea(canvas.id, input, c.get('human').id), 201);
  });
  routes.patch('/api/canvases/:id/areas/:areaId', async c => {
    const canvas = visible(c);
    const input = parse(AreaPatchSchema, await body(c));
    const moveCards = c.req.query('moveCards') === '1';
    const result = canvases.patchArea(canvas.id, c.req.param('areaId'), input, c.get('human').id, { moveCards });
    return c.json({ area: result.area, cards: forViewer(result.cards, c.get('channels')), areas: result.areas });
  });
  routes.delete('/api/canvases/:id/areas/:areaId', async c => {
    const canvas = visible(c);
    const version = requiredVersion(c);
    const storageKeys = store.canvasContext.storageKeysForArea(c.req.param('areaId'));
    canvases.removeArea(canvas.id, c.req.param('areaId'), version, c.get('human').id);
    await unlinkContext(storageKeys);
    return c.body(null, 204);
  });

  // The home follows a chat member's placement or move; anyone else leaves it alone. Only a placement can
  // give a homeless chat a home (R19). Returns whether it changed.
  function saveHome(canvasId: string, row: CanvasCardRow, areas: CanvasArea[], channel: Channel | undefined, human: Human, placement: boolean) {
    const area = areaFor({ x: row.x + row.w / 2, y: row.y + CARD_HEIGHT / 2 }, areas);
    const current = store.canvasContext.home(row.channelId);
    const next = homeAfterMove(current, { canvasId, areaId: area?.id ?? null, byMember: isChatMember(channel, human), placement });
    if (next) store.canvasContext.setHome(row.channelId, next, human.id);
    return Boolean(next) && (next!.canvasId !== current?.canvasId || next!.areaId !== current?.areaId);
  }
  // A new home may bring context with it, so the chat's agents are set up before answering. The home is
  // already saved, so a setup problem is logged by name only and never fails the request.
  const homesChanged = async (channelIds: string[]) => {
    if (!agents || !channelIds.length) return;
    try {
      await agents.settle(channelIds);
    } catch (error) {
      console.error('Context agent setup failed:', (error as Error).name);
    }
  };
  routes.post('/api/canvases/:id/cards', async c => {
    const canvas = visible(c);
    const human = c.get('human');
    const input = parse(PlaceCardsSchema, await body(c));
    if (canvas.role === 'view') throw new CanvasForbiddenError();
    // Only chats the engine lists for the caller, and not archived, can be placed.
    const byId = new Map(c.get('channels').filter(ch => !ch.archivedAt).map(ch => [ch.id, ch]));
    if (input.cards.some(card => !byId.has(card.channelId))) throw new HTTPException(400, { message: 'Some chats are not available to you' });
    const projects = store.projects.byChannels(input.cards.map(card => card.channelId));
    // Cards already on this canvas are not placed again, so only the new ones count as a placement.
    const before = new Set(canvases.cards(canvas.id).map(row => row.channelId));
    const names = new Map((await people(c.req.raw.headers)).map(h => [h.id, h.username]));
    canvases.placeCards(canvas.id, input.cards.map(card => ({
      channelId: card.channelId, x: card.x, y: card.y, w: card.w ?? DEFAULT_CARD_WIDTH,
      projectId: projects.get(card.channelId)?.id ?? null,
      ownerLabel: names.get(byId.get(card.channelId)!.ownerHumanId ?? '') ?? 'a teammate',
    })), input.area, human.id);
    // A member's first placement gives the chat its home; later placements follow the move rule.
    const areas = canvases.areas(canvas.id);
    const changed = canvases.cards(canvas.id)
      .filter(row => input.cards.some(card => card.channelId === row.channelId)
        && saveHome(canvas.id, row, areas, byId.get(row.channelId), human, !before.has(row.channelId)))
      .map(row => row.channelId);
    await homesChanged(changed);
    return c.json(buildBoard(human, c.get('channels'), canvas.id), 201);
  });
  routes.patch('/api/canvases/:id/cards/:channelId', async c => {
    const canvas = visible(c);
    const input = parse(CardPatchSchema, await body(c));
    const human = c.get('human');
    const row = canvases.moveCard(canvas.id, c.req.param('channelId'), input, human.id);
    if (saveHome(canvas.id, row, canvases.areas(canvas.id), c.get('channels').find(ch => ch.id === row.channelId), human, false)) await homesChanged([row.channelId]);
    // The move may have changed the chat's home, so the answer carries the card's current home label.
    const moved = forViewer([row], c.get('channels'))[0];
    const open = c.get('channels').some(ch => ch.id === row.channelId);
    const home = open ? homeLabels(human, canvas.id)(row, areaFor({ x: row.x + row.w / 2, y: row.y + CARD_HEIGHT / 2 }, canvases.areas(canvas.id))?.id ?? null) : undefined;
    return c.json(home === undefined ? moved : { ...moved, home });
  });
  routes.delete('/api/canvases/:id/cards/:channelId', c => {
    const canvas = visible(c);
    const channelId = c.req.param('channelId');
    canvases.removeCard(canvas.id, channelId, requiredVersion(c), c.get('human').id);
    // A chat that leaves its home canvas has no home until it is placed again.
    if (store.canvasContext.home(channelId)?.canvasId === canvas.id) store.canvasContext.clearHome(channelId, c.get('human').id);
    return c.body(null, 204);
  });

  routes.all('/api/canvases/*', () => { throw notFound(); });
  app.route('/', routes);
}
