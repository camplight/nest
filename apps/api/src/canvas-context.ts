import { Hono, type Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { bodyLimit } from 'hono/body-limit';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { ProductDb } from '@nest/db';
import { CanvasConflictError, CanvasForbiddenError, CanvasLimitError } from '@nest/db';
import type { Human, OrgOpsClient } from '@nest/orgops-client';
import {
  areaFor, CARD_HEIGHT, ContextLinkSchema, ContextNotesSchema, MAX_CONTEXT_BYTES_PER_CANVAS, MAX_CONTEXT_FILE_BYTES, MAX_MESSAGE_ATTACHMENTS,
  type Canvas, type ChatHome, type ContextFile, type ContextLink, type ContextReader, type ContextScope, type ContextSummary, type ScopeContext,
} from '@nest/schemas';
import { ContextFileTooLargeError, removeStored, type ContextFiles } from './context-files';

/** Agent setup (see context-agents.ts): context writes and home changes call `ensureAgents` for the chats they affect. */
export type ContextAgents = {
  /** False when Nest has no engine service token, so no agent can be given a context key. */
  configured: boolean;
  ensureAgents(channelIds: string[]): Promise<void>;
  /** The agents in these chats and whether each can read context. */
  readers(channelIds: string[]): Promise<ContextReader[]>;
  /** Chats among these (already loaded) channels that still have an agent to set up; answers without calling the engine. */
  pending(channels: { id: string; archivedAt?: number | null; participants?: { subscriberType: string; subscriberId: string }[]; metadata?: unknown }[]): string[];
};
/** A chat member: a HUMAN participant (identified by username, as in projects) or the engine owner. */
export function isChatMember(channel: { ownerHumanId?: string | null; participants?: { subscriberType: string; subscriberId: string }[] } | undefined, human: Human) {
  if (!channel) return false;
  return channel.ownerHumanId === human.id
    || Boolean(channel.participants?.some(p => p.subscriberType === 'HUMAN' && p.subscriberId === human.username));
}
type Env = { Variables: { human: Human } };
type ViewerChannel = { id: string; participants?: { subscriberType: string; subscriberId: string }[] };

const uuid = z.string().uuid();
const MiB = 1024 * 1024;
const JSON_LIMIT = 64_000;
// parseBody buffers the whole request, so one upload is capped near what a canvas can ever hold
// (1 MiB covers multipart overhead); the store rejects anything past the canvas limit anyway.
const MULTIPART_OVERHEAD = MiB;
const UPLOAD_LIMIT = MAX_CONTEXT_BYTES_PER_CANVAS + MULTIPART_OVERHEAD;
export const DOWNLOAD_HEADERS = {
  'content-type': 'application/octet-stream',
  'x-content-type-options': 'nosniff',
  'content-security-policy': "default-src 'none'; sandbox",
  'cache-control': 'private, no-store',
  'referrer-policy': 'no-referrer',
};

export const attachment = (name: string) => `attachment; filename*=UTF-8''${encodeURIComponent(name.replace(/[\r\n]/g, ''))}`;

const areaById = (store: ProductDb, areaId: string) =>
  store.db.prepare('SELECT id, canvas_id AS canvasId, title FROM product_canvas_areas WHERE id=?').get(areaId) as { id: string; canvasId: string; title: string } | undefined;
/**
 * An area's links with their source areas, read through on every call. A link is available only while
 * its linker can still read the source canvas, so losing access makes it unavailable at once.
 */
export function linkSources(store: ProductDb, areaId: string) {
  return store.canvasContext.links(areaId).flatMap(link => {
    const source = areaById(store, link.sourceAreaId);
    if (!source) return [];
    return [{ ...link, source, available: Boolean(store.canvases.get(source.canvasId, link.linkedBy)) }];
  });
}
/**
 * A chat's home while it is available: the person who set it must still be able to read its canvas, as with a
 * link's linker (R21). Losing that access makes the home unavailable at once; a member re-homing it restores it.
 */
export function availableHome(store: ProductDb, channelId: string): ChatHome | null {
  const entry = store.canvasContext.homeEntry(channelId);
  if (!entry || !store.canvases.get(entry.canvasId, entry.setBy)) return null;
  return { canvasId: entry.canvasId, areaId: entry.areaId };
}
/** Chats whose home context includes this scope: homes on the canvas, or in the area or an area that links to it. */
export function chatsUsing(store: ProductDb, scope: ContextScope) {
  const { canvasContext: context } = store;
  if (scope.kind === 'canvas') return [...context.homesIn(scope.canvasId).keys()];
  const areas = [{ areaId: scope.areaId, canvasId: scope.canvasId }, ...context.usedBy(scope.areaId)];
  return areas.flatMap(({ areaId, canvasId }) => [...context.homesIn(canvasId)].filter(([, home]) => home.areaId === areaId).map(([channelId]) => channelId));
}

// Display names only; the stored file is always named by its uuid storage key.
function fileName(raw: string) {
  const name = raw.replace(/[\u0000-\u001f\u007f]/g, '').replace(/[\\/]/g, '_').trim().slice(0, 255);
  return name || 'file';
}
function mimeType(raw: string) {
  const mime = raw.split(';')[0].trim().toLowerCase();
  return /^[a-z0-9][\w.+-]*\/[\w.+-]+$/.test(mime) && mime.length <= 100 ? mime : 'application/octet-stream';
}

/**
 * Notes, files and links for canvases and areas. Registered before the Phase 1 canvas routes, so
 * its own middleware (auth, flag, no-store, body limits) covers only these paths. Context edits never
 * call the engine beyond identifying the caller.
 */
export function registerCanvasContextRoutes(app: Hono, { store, orgops, enabled, files, agents }: {
  store: ProductDb; orgops: OrgOpsClient; enabled: boolean; files: ContextFiles; agents?: ContextAgents;
}) {
  const routes = new Hono<Env>();
  const { canvases, canvasContext: context } = store;
  const notFound = () => new HTTPException(404, { message: 'Not found' });
  const badRequest = (message: string) => new HTTPException(400, { message });
  routes.onError((error, c) => {
    if (error instanceof HTTPException) return c.json({ error: error.message }, error.status);
    if (error instanceof CanvasConflictError) return c.json({ error: 'Context changed' }, 409);
    if (error instanceof CanvasForbiddenError) return c.json({ error: error.message }, 403);
    if (error instanceof CanvasLimitError) return c.json({ error: error.message }, 400);
    console.error('Canvas context request failed:', error.name);
    return c.json({ error: 'Canvas context is unavailable. Refresh and retry.' }, 500);
  });

  const paths = ['/api/canvases/context-sources', '/api/canvases/:id/cards/:channelId/home', '/api/canvases/:id/context/*', '/api/canvases/:id/areas/:areaId/context/*'];
  const jsonLimit = bodyLimit({ maxSize: JSON_LIMIT, onError: c => c.json({ error: 'Request too large' }, 413) });
  const uploadLimit = bodyLimit({ maxSize: UPLOAD_LIMIT, onError: c => c.json({ error: 'Upload too large' }, 413) });
  const isUpload = (c: Context) => c.req.method === 'POST' && /\/context\/files\/?$/.test(c.req.path);
  for (const path of paths) {
    routes.use(path, (c, next) => (isUpload(c) ? uploadLimit : jsonLimit)(c, next));
    routes.use(path, async (c, next) => {
      const human = await orgops.currentHuman(c.req.raw.headers);
      if (!human) return c.json({ error: 'Unauthorized' }, 401);
      if (human.mustChangePassword) return c.json({ error: 'Complete password setup first' }, 403);
      if (!enabled) throw notFound();
      c.set('human', human);
      c.header('Cache-Control', 'no-store');
      await next();
    });
  }

  function parse<T>(schema: z.ZodType<T>, value: unknown): T {
    const result = schema.safeParse(value);
    if (!result.success) throw badRequest(result.error.issues.map(i => i.message).join('; '));
    return result.data;
  }
  const body = (c: Context) => c.req.json().catch(() => null);
  const param = (c: Context, name: string) => {
    const value = c.req.param(name);
    if (!value || !uuid.safeParse(value).success) throw notFound();
    return value;
  };
  // Missing and unreadable canvases look the same (404); only a readable canvas can answer 403.
  function canvasOf(c: Context<Env>) {
    const canvas = canvases.get(param(c, 'id'), c.get('human').id);
    if (!canvas) throw notFound();
    return canvas;
  }
  // The store trusts its callers on scope, so the area must be checked against the path's canvas here.
  function scopeOf(c: Context<Env>, canvas: Canvas): ContextScope {
    if (!c.req.param('areaId')) return { kind: 'canvas', canvasId: canvas.id };
    const areaId = param(c, 'areaId');
    if (!canvases.areas(canvas.id).some(a => a.id === areaId)) throw notFound();
    return { kind: 'area', canvasId: canvas.id, areaId };
  }
  const requireEdit = (canvas: Canvas) => { if (canvas.role === 'view') throw new CanvasForbiddenError(); };
  // Agents in the affected chats get their context key once there is something to read. Runs after the
  // write has committed and never throws, so it cannot turn a saved write into a failure.
  const setUpAgents = async (channelIds: () => string[]) => {
    if (!agents) return;
    try {
      await agents.ensureAgents(channelIds());
    } catch (error) {
      console.error('Context agent setup failed:', (error as Error).name);
    }
  };

  // A source area is named only to viewers who can read its canvas.
  const linksFor = (areaId: string, viewerId: string) => linkSources(store, areaId).map(({ sourceAreaId, source, available }): ContextLink => {
    const readable = canvases.get(source.canvasId, viewerId);
    return { sourceAreaId, title: readable ? source.title : 'Unavailable area', canvasName: readable ? readable.name : null, available };
  });
  const filled = (scope: ContextScope) => { const saved = context.get(scope); return saved.notes.length > 0 || saved.files.length > 0; };

  function scopeContext(scope: ContextScope, viewerId: string): ScopeContext {
    const saved = context.get(scope);
    if (scope.kind === 'canvas') return { ...saved, links: [], usedBy: [] };
    const links = linksFor(scope.areaId, viewerId);
    const usedBy = context.usedBy(scope.areaId).map(use => ({
      areaId: use.areaId,
      title: canvases.get(use.canvasId, viewerId) ? areaById(store, use.areaId)?.title ?? null : null,
    }));
    return { ...saved, links, usedBy };
  }

  routes.get('/api/canvases/context-sources', c => {
    const human = c.get('human');
    return c.json(canvases.list(human.id).flatMap(canvas =>
      canvases.areas(canvas.id).map(area => ({ canvasId: canvas.id, canvasName: canvas.name, areaId: area.id, title: area.title }))));
  });

  const read = (c: Context<Env>) => {
    const canvas = canvasOf(c);
    return c.json(scopeContext(scopeOf(c, canvas), c.get('human').id));
  };
  const writeNotes = async (c: Context<Env>) => {
    const canvas = canvasOf(c);
    const scope = scopeOf(c, canvas);
    requireEdit(canvas);
    const input = parse(ContextNotesSchema, await body(c));
    const human = c.get('human');
    try {
      context.setNotes(scope, input.notes, input.version, human.id);
    } catch (error) {
      if (error instanceof CanvasConflictError) return c.json({ error: 'Context changed', current: scopeContext(scope, human.id) }, 409);
      throw error;
    }
    await setUpAgents(() => chatsUsing(store, scope));
    return c.json(scopeContext(scope, human.id));
  };

  const uploadFiles = async (c: Context<Env>) => {
    const canvas = canvasOf(c);
    const scope = scopeOf(c, canvas);
    requireEdit(canvas);
    // Refuse before reading the body when it cannot fit in what is left of this canvas's budget.
    const declared = c.req.header('content-length');
    if (declared !== undefined && Number(declared) > MAX_CONTEXT_BYTES_PER_CANVAS - context.canvasBytes(canvas.id) + MULTIPART_OVERHEAD) {
      return c.json({ error: 'Upload too large' }, 413);
    }
    // A body-limit overflow while reading stays a 413; only a malformed body becomes 400.
    const form = await c.req.parseBody({ all: true }).catch(error => {
      if (error instanceof HTTPException) throw error;
      return null;
    });
    if (!form) throw badRequest('Send files as multipart form data');
    const values = Object.values(form).flatMap(value => (Array.isArray(value) ? value : [value]));
    if (!values.length) throw badRequest('Choose at least one file');
    if (values.length > MAX_MESSAGE_ATTACHMENTS) throw badRequest(`Upload at most ${MAX_MESSAGE_ATTACHMENTS} files at a time`);
    const raw = form.file;
    const parts = (Array.isArray(raw) ? raw : raw === undefined ? [] : [raw]).filter((part): part is File => part instanceof File);
    if (parts.length !== values.length) throw badRequest('Only file parts are accepted');
    // Every part is checked before anything is written, so a rejected request leaves nothing on disk.
    if (parts.some(part => part.size > MAX_CONTEXT_FILE_BYTES)) throw badRequest('Each file can be at most 20 MiB');
    const human = c.get('human');
    const saved: { part: File; storageKey: string; size: number }[] = [];
    let rows: ContextFile[];
    try {
      for (const part of parts) saved.push({ part, ...(await files.save(part, { maxBytes: MAX_CONTEXT_FILE_BYTES })) });
      // One transaction: either every file of the request is recorded or none is.
      rows = store.db.transaction(() => {
        // The canvas or area may have been deleted while the files were being written.
        if (!canvases.get(canvas.id, human.id) || (scope.kind === 'area' && !canvases.areas(canvas.id).some(a => a.id === scope.areaId))) throw notFound();
        return saved.map(s => context.addFile(scope, {
          id: randomUUID(), name: fileName(s.part.name), mime: mimeType(s.part.type), size: s.size, storageKey: s.storageKey,
        }, human.id));
      })();
    } catch (error) {
      await Promise.all(saved.map(s => files.remove(s.storageKey).catch(() => undefined)));
      if (error instanceof ContextFileTooLargeError) throw badRequest('Each file can be at most 20 MiB');
      throw error;
    }
    // Outside the cleanup above: the rows are committed, so their files must stay.
    await setUpAgents(() => chatsUsing(store, scope));
    return c.json(rows, 201);
  };

  // A file id answers only within its own canvas (and, for area paths, its own area).
  function fileIn(c: Context<Env>, canvas: Canvas, scope?: ContextScope) {
    const stored = context.file(param(c, 'fileId'));
    if (!stored || stored.canvasId !== canvas.id) throw notFound();
    if (scope && (stored.scope.kind !== scope.kind || (scope.kind === 'area' && stored.scope.kind === 'area' && stored.scope.areaId !== scope.areaId))) throw notFound();
    return stored;
  }
  const deleteFile = async (c: Context<Env>) => {
    const canvas = canvasOf(c);
    const scope = scopeOf(c, canvas);
    const stored = fileIn(c, canvas, scope);
    requireEdit(canvas);
    context.removeFile(c.req.param('fileId')!, c.get('human').id);
    await removeStored(files, [stored.storageKey]);
    return c.body(null, 204);
  };

  // The board's chips and context dots in one request, rather than one context read per area.
  routes.get('/api/canvases/:id/context/summary', c => {
    const canvas = canvasOf(c);
    const viewerId = c.get('human').id;
    const summary: ContextSummary = {
      areas: canvases.areas(canvas.id).map(area => ({
        areaId: area.id,
        hasContext: filled({ kind: 'area', canvasId: canvas.id, areaId: area.id }),
        links: linksFor(area.id, viewerId).map(({ sourceAreaId, title, available }) => ({ sourceAreaId, title, available })),
      })),
      canvas: { hasContext: filled({ kind: 'canvas', canvasId: canvas.id }) },
    };
    return c.json(summary);
  });

  routes.get('/api/canvases/:id/context', read);
  routes.put('/api/canvases/:id/context', writeNotes);
  routes.post('/api/canvases/:id/context/files', uploadFiles);
  routes.get('/api/canvases/:id/context/files/:fileId', c => {
    const stored = fileIn(c, canvasOf(c));
    return c.body(files.open(stored.storageKey), 200, {
      ...DOWNLOAD_HEADERS,
      'content-disposition': attachment(stored.name),
    });
  });
  routes.delete('/api/canvases/:id/context/files/:fileId', deleteFile);

  routes.get('/api/canvases/:id/areas/:areaId/context', read);
  routes.put('/api/canvases/:id/areas/:areaId/context', writeNotes);
  routes.post('/api/canvases/:id/areas/:areaId/context/files', uploadFiles);
  routes.delete('/api/canvases/:id/areas/:areaId/context/files/:fileId', deleteFile);

  // Who can read this area's context: the agents in the chats homed here that the viewer can see in the engine.
  routes.get('/api/canvases/:id/areas/:areaId/context/readers', async c => {
    const canvas = canvasOf(c);
    const scope = scopeOf(c, canvas) as Extract<ContextScope, { kind: 'area' }>;
    // An unavailable home (its setter lost the canvas) gives its agents nothing to read here.
    const homed = [...context.homesIn(canvas.id)].filter(([channelId, home]) => home.areaId === scope.areaId && availableHome(store, channelId)).map(([channelId]) => channelId);
    if (!homed.length) return c.json([]);
    const visible = new Map((await orgops.humanJson<ViewerChannel[]>('/api/channels', c.req.raw.headers)).map(channel => [channel.id, channel]));
    const channelIds = homed.filter(id => visible.has(id));
    if (agents?.configured) return c.json(await agents.readers(channelIds));
    // Without agent setup nobody can be given a key: every agent in these chats is unconfigured.
    const names = [...new Set(channelIds.flatMap(id => (visible.get(id)?.participants ?? [])
      .filter(p => p.subscriberType === 'AGENT').map(p => p.subscriberId)))].sort();
    return c.json(names.map((agentName): ContextReader => ({ agentName, state: 'unconfigured' })));
  });

  routes.post('/api/canvases/:id/areas/:areaId/context/links', async c => {
    const canvas = canvasOf(c);
    const scope = scopeOf(c, canvas) as Extract<ContextScope, { kind: 'area' }>;
    requireEdit(canvas);
    const { sourceAreaId } = parse(ContextLinkSchema, await body(c));
    if (sourceAreaId === scope.areaId) throw badRequest('An area cannot use its own context');
    const human = c.get('human');
    // A source on a canvas the caller cannot read is indistinguishable from a missing one.
    const source = areaById(store, sourceAreaId);
    if (!source || !canvases.get(source.canvasId, human.id)) throw notFound();
    context.link(scope.areaId, sourceAreaId, human.id);
    await setUpAgents(() => chatsUsing(store, scope));
    return c.json(scopeContext(scope, human.id));
  });
  routes.delete('/api/canvases/:id/areas/:areaId/context/links/:sourceAreaId', c => {
    const canvas = canvasOf(c);
    const scope = scopeOf(c, canvas) as Extract<ContextScope, { kind: 'area' }>;
    requireEdit(canvas);
    context.unlink(scope.areaId, param(c, 'sourceAreaId'), c.get('human').id);
    return c.body(null, 204);
  });

  // "Use this area's context": a chat member moves the chat's home to this canvas and the area under the card.
  routes.post('/api/canvases/:id/cards/:channelId/home', async c => {
    const canvas = canvasOf(c);
    parse(z.object({}).strict(), await body(c));
    const human = c.get('human');
    const channelId = c.req.param('channelId');
    const card = canvases.cards(canvas.id).find(row => row.channelId === channelId);
    if (!card) throw notFound();
    const channels = await orgops.humanJson<{ id: string; ownerHumanId?: string | null; participants?: { subscriberType: string; subscriberId: string }[] }[]>(
      '/api/channels?includeArchived=1', c.req.raw.headers);
    // A chat the caller cannot see in the engine, or is not part of, may not be given a home by them.
    if (!isChatMember(channels.find(ch => ch.id === channelId), human)) throw new CanvasForbiddenError('Only members of this chat can change its context');
    const area = areaFor({ x: card.x + card.w / 2, y: card.y + CARD_HEIGHT / 2 }, canvases.areas(canvas.id));
    const home = { canvasId: canvas.id, areaId: area?.id ?? null };
    context.setHome(channelId, home, human.id);
    await setUpAgents(() => [channelId]);
    return c.json({ home });
  });

  app.route('/', routes);
}
