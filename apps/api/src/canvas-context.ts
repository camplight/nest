import { Hono, type Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { bodyLimit } from 'hono/body-limit';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { ProductDb } from '@nest/db';
import { CanvasConflictError, CanvasForbiddenError, CanvasLimitError } from '@nest/db';
import type { Human, OrgOpsClient } from '@nest/orgops-client';
import {
  ContextLinkSchema, ContextNotesSchema, MAX_CONTEXT_BYTES_PER_CANVAS, MAX_CONTEXT_FILE_BYTES, MAX_MESSAGE_ATTACHMENTS,
  type Canvas, type ContextLink, type ContextScope, type ScopeContext,
} from '@nest/schemas';
import { ContextFileTooLargeError, removeStored, type ContextFiles } from './context-files';

/** Supplied by Task 4; context routes only accept it for now. */
export type ContextAgents = { ensureAgents(channelIds: string[]): Promise<void> };
type Env = { Variables: { human: Human } };

const uuid = z.string().uuid();
const MiB = 1024 * 1024;
const JSON_LIMIT = 64_000;
// parseBody buffers the whole request, so one upload is capped near what a canvas can ever hold
// (1 MiB covers multipart overhead); the store rejects anything past the canvas limit anyway.
const MULTIPART_OVERHEAD = MiB;
const UPLOAD_LIMIT = MAX_CONTEXT_BYTES_PER_CANVAS + MULTIPART_OVERHEAD;
const DOWNLOAD_HEADERS = {
  'content-type': 'application/octet-stream',
  'x-content-type-options': 'nosniff',
  'content-security-policy': "default-src 'none'; sandbox",
  'cache-control': 'private, no-store',
  'referrer-policy': 'no-referrer',
};

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
export function registerCanvasContextRoutes(app: Hono, { store, orgops, enabled, files }: {
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

  const paths = ['/api/canvases/context-sources', '/api/canvases/:id/context/*', '/api/canvases/:id/areas/:areaId/context/*'];
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
  const areaById = (areaId: string) =>
    store.db.prepare('SELECT id, canvas_id AS canvasId, title FROM product_canvas_areas WHERE id=?').get(areaId) as { id: string; canvasId: string; title: string } | undefined;

  function scopeContext(scope: ContextScope, viewerId: string): ScopeContext {
    const saved = context.get(scope);
    if (scope.kind === 'canvas') return { ...saved, links: [], usedBy: [] };
    // Read through on every request: a linker who loses the source canvas makes the link unavailable at once.
    const links = context.links(scope.areaId).flatMap((link): ContextLink[] => {
      const source = areaById(link.sourceAreaId);
      if (!source) return [];
      const readable = canvases.get(source.canvasId, viewerId);
      return [{
        sourceAreaId: link.sourceAreaId,
        title: readable ? source.title : 'Unavailable area',
        canvasName: readable ? readable.name : null,
        available: Boolean(canvases.get(source.canvasId, link.linkedBy)),
      }];
    });
    const usedBy = context.usedBy(scope.areaId).map(use => ({
      areaId: use.areaId,
      title: canvases.get(use.canvasId, viewerId) ? areaById(use.areaId)?.title ?? null : null,
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
    try {
      for (const part of parts) saved.push({ part, ...(await files.save(part, { maxBytes: MAX_CONTEXT_FILE_BYTES })) });
      // One transaction: either every file of the request is recorded or none is.
      const rows = store.db.transaction(() => {
        // The canvas or area may have been deleted while the files were being written.
        if (!canvases.get(canvas.id, human.id) || (scope.kind === 'area' && !canvases.areas(canvas.id).some(a => a.id === scope.areaId))) throw notFound();
        return saved.map(s => context.addFile(scope, {
          id: randomUUID(), name: fileName(s.part.name), mime: mimeType(s.part.type), size: s.size, storageKey: s.storageKey,
        }, human.id));
      })();
      return c.json(rows, 201);
    } catch (error) {
      await Promise.all(saved.map(s => files.remove(s.storageKey).catch(() => undefined)));
      if (error instanceof ContextFileTooLargeError) throw badRequest('Each file can be at most 20 MiB');
      throw error;
    }
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

  routes.get('/api/canvases/:id/context', read);
  routes.put('/api/canvases/:id/context', writeNotes);
  routes.post('/api/canvases/:id/context/files', uploadFiles);
  routes.get('/api/canvases/:id/context/files/:fileId', c => {
    const stored = fileIn(c, canvasOf(c));
    return c.body(files.open(stored.storageKey), 200, {
      ...DOWNLOAD_HEADERS,
      'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(stored.name.replace(/[\r\n]/g, ''))}`,
    });
  });
  routes.delete('/api/canvases/:id/context/files/:fileId', deleteFile);

  routes.get('/api/canvases/:id/areas/:areaId/context', read);
  routes.put('/api/canvases/:id/areas/:areaId/context', writeNotes);
  routes.post('/api/canvases/:id/areas/:areaId/context/files', uploadFiles);
  routes.delete('/api/canvases/:id/areas/:areaId/context/files/:fileId', deleteFile);

  routes.post('/api/canvases/:id/areas/:areaId/context/links', async c => {
    const canvas = canvasOf(c);
    const scope = scopeOf(c, canvas) as Extract<ContextScope, { kind: 'area' }>;
    requireEdit(canvas);
    const { sourceAreaId } = parse(ContextLinkSchema, await body(c));
    if (sourceAreaId === scope.areaId) throw badRequest('An area cannot use its own context');
    const human = c.get('human');
    // A source on a canvas the caller cannot read is indistinguishable from a missing one.
    const source = areaById(sourceAreaId);
    if (!source || !canvases.get(source.canvasId, human.id)) throw notFound();
    context.link(scope.areaId, sourceAreaId, human.id);
    return c.json(scopeContext(scope, human.id));
  });
  routes.delete('/api/canvases/:id/areas/:areaId/context/links/:sourceAreaId', c => {
    const canvas = canvasOf(c);
    const scope = scopeOf(c, canvas) as Extract<ContextScope, { kind: 'area' }>;
    requireEdit(canvas);
    context.unlink(scope.areaId, param(c, 'sourceAreaId'), c.get('human').id);
    return c.body(null, 204);
  });

  app.route('/', routes);
}
