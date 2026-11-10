import { Hono, type Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import type { ProductDb } from '@nest/db';
import type { OrgOpsClient } from '@nest/orgops-client';
import type { ContextScope } from '@nest/schemas';
import { attachment, DOWNLOAD_HEADERS, linkSources, type ContextAgents } from './canvas-context';
import type { ContextFiles } from './context-files';

export const CONTEXT_SKILL = 'nest-context';
const SECRET_NAME = 'NEST_CONTEXT_TOKEN';
const BEARER = /^Bearer (nest_context_[a-f0-9]{64})$/;
const CHANNEL_ID = /^[A-Za-z0-9_-]{1,128}$/;
const RATE_LIMIT = 60;
const RATE_WINDOW_MS = 60_000;
// Agents that cannot be set up right now are left alone for a while, so polled board reads stay quiet.
const WRAPPED_RETRY_MS = 10 * 60_000;
const FAILED_RETRY_MS = 60_000;

type Participant = { subscriberType: string; subscriberId: string };
type EngineChannel = { id: string; archivedAt?: number | null; participants?: Participant[]; metadata?: unknown };
type EngineAgent = { name: string; mode?: string; enabledSkills?: string[] };
export type ContextReader = { agentName: string; state: 'ready' | 'wrapped' | 'unconfigured' };

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
/**
 * Agents the engine lists in `metadata.federation.participants`. Any chat creator or manager can write
 * that list unchecked, and the engine merges it into `participants`, so these names prove nothing.
 * Mirrors the engine's projectedParticipantsFromMetadata (trimmed id, trimmed upper-case type).
 */
function projectedAgents(metadata: unknown) {
  const object = (value: unknown) => (value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null);
  const listed = object(object(metadata)?.federation)?.participants;
  return new Set((Array.isArray(listed) ? listed : []).flatMap(entry => {
    const item = object(entry) ?? {};
    const type = String(item.subscriberType ?? '').trim().toUpperCase();
    const id = String(item.subscriberId ?? '').trim();
    return type === 'AGENT' && id ? [id] : [];
  }));
}
/** Agents subscribed to the chat. Fails closed: a name also projected through metadata never counts. */
const agentsIn = (channel?: EngineChannel) => {
  const projected = projectedAgents(channel?.metadata);
  return [...new Set((channel?.participants ?? [])
    .filter(p => p.subscriberType === 'AGENT' && !projected.has(p.subscriberId)).map(p => p.subscriberId))];
};

/**
 * Agent context keys. Each native agent in a chat whose home has context gets its own key: Nest keeps
 * only its sha256 hash, installs the key as the agent's private engine secret NEST_CONTEXT_TOKEN and
 * adds the `nest-context` skill to the agent. The key is never logged, audited or returned by a route.
 * Agent reads name a chat; membership is checked through the engine on every read.
 */
export function createContextAgents({ store, orgops, engineToken }: { store: ProductDb; orgops: OrgOpsClient; engineToken?: string }) {
  const context = store.canvasContext;
  const settingUp = new Map<string, Promise<void>>(); // by agent name
  const inflight = new Map<string, Promise<void>>(); // by channel id
  const retryAfter = new Map<string, number>(); // by agent name

  function service(path: string, method = 'GET', body?: unknown) {
    const headers: Record<string, string> = { 'x-orgops-runner-token': engineToken! };
    if (body !== undefined) headers['content-type'] = 'application/json';
    return orgops.request(path, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  }
  async function serviceJson<T>(path: string): Promise<T | null> {
    const response = await service(path);
    if (response.status === 404) return null;
    if (!response.ok) throw Error(`Engine request failed (${response.status})`);
    return response.json() as Promise<T>;
  }
  // Only live chats: an archived or missing chat is neither set up nor readable.
  async function liveChannels() {
    const rows = (await serviceJson<EngineChannel[]>('/api/channels')) ?? [];
    return new Map(rows.filter(channel => !channel.archivedAt).map(channel => [channel.id, channel]));
  }
  const agent = (name: string) => serviceJson<EngineAgent>(`/api/agents/${encodeURIComponent(name)}`);

  function hasContext(channelId: string) {
    const home = context.home(channelId);
    if (!home) return false;
    const filled = (scope: ContextScope) => { const saved = context.get(scope); return saved.notes.length > 0 || saved.files.length > 0; };
    if (filled({ kind: 'canvas', canvasId: home.canvasId })) return true;
    if (!home.areaId) return false;
    return filled({ kind: 'area', canvasId: home.canvasId, areaId: home.areaId }) || context.links(home.areaId).length > 0;
  }
  const ready = (name: string) => Boolean(context.keyFor(name)) && context.skillEnabled(name);
  const waiting = (name: string) => !ready(name) && (retryAfter.get(name) ?? 0) <= Date.now();

  function failed(agentName: string) {
    retryAfter.set(agentName, Date.now() + FAILED_RETRY_MS);
    store.db.prepare('INSERT INTO product_audit(type,actor_id,payload_json,created_at) VALUES (?,?,?,?)')
      .run('audit.canvas.context.agent_setup_failed', 'system', JSON.stringify({ agentName }), Date.now());
  }
  function setUp(agentName: string) {
    const running = settingUp.get(agentName);
    if (running) return running;
    const run = (async () => {
      let tokenHash: string | null = null;
      try {
        if (!waiting(agentName)) return;
        const found = await agent(agentName);
        if (!found) throw Error('Agent not found');
        // Codex and Claude Code harnesses do not load engine skills, so they get no key.
        if (found.mode === 'WRAPPED') { retryAfter.set(agentName, Date.now() + WRAPPED_RETRY_MS); return; }
        const key = `nest_context_${randomBytes(32).toString('hex')}`;
        tokenHash = sha256(key);
        context.saveKey(agentName, tokenHash);
        const secret = await service('/api/secrets', 'POST', { name: SECRET_NAME, value: key, scopeType: 'private', scopeId: agentName });
        if (!secret.ok) throw Error('Could not install the context key');
        // PATCH replaces the whole list: send the agent's current skills plus ours, never fewer.
        const skills = found.enabledSkills ?? [];
        if (!skills.includes(CONTEXT_SKILL)) {
          const patched = await service(`/api/agents/${encodeURIComponent(agentName)}`, 'PATCH', { enabledSkills: [...new Set([...skills, CONTEXT_SKILL])] });
          if (!patched.ok) throw Error('Could not enable the context skill');
        }
        context.markSkillEnabled(agentName);
        retryAfter.delete(agentName);
      } catch {
        // A key that may not have reached the engine is useless: revoke it so the next attempt starts over.
        if (tokenHash) context.revokeKey(tokenHash);
        failed(agentName);
      }
    })().finally(() => settingUp.delete(agentName));
    settingUp.set(agentName, run);
    return run;
  }

  /** Sets up the native agents of these chats whose home has context. Never throws; failures are audited. */
  async function ensureAgents(channelIds: string[]) {
    if (!engineToken) return;
    try {
      const waits: Promise<void>[] = [];
      const fresh: string[] = [];
      for (const id of new Set(channelIds)) {
        if (!hasContext(id)) continue;
        const running = inflight.get(id);
        if (running) waits.push(running); else fresh.push(id);
      }
      if (fresh.length) {
        const run: Promise<void> = (async () => {
          const channels = await liveChannels();
          const names = new Set(fresh.flatMap(id => agentsIn(channels.get(id))));
          await Promise.all([...names].filter(waiting).map(setUp));
        })().catch(() => undefined).finally(() => { for (const id of fresh) if (inflight.get(id) === run) inflight.delete(id); });
        for (const id of fresh) inflight.set(id, run);
        waits.push(run);
      }
      await Promise.all(waits);
    } catch { /* Setup is best effort; the next write or board read retries. */ }
  }

  const pending: ContextAgents['pending'] = channels => (engineToken
    ? channels.filter(ch => !ch.archivedAt && agentsIn(ch).some(waiting) && hasContext(ch.id)).map(ch => ch.id)
    : []);

  /** The agents in these chats and whether each can read context. Throws when the engine is unavailable. */
  async function readers(channelIds: string[]): Promise<ContextReader[]> {
    if (!engineToken) return [];
    const channels = await liveChannels();
    const names = [...new Set(channelIds.flatMap(id => agentsIn(channels.get(id))))].sort();
    return Promise.all(names.map(async (agentName): Promise<ContextReader> => {
      const found = await agent(agentName);
      return { agentName, state: found?.mode === 'WRAPPED' ? 'wrapped' : ready(agentName) ? 'ready' : 'unconfigured' };
    }));
  }

  /** What an agent may read for a chat: the chat's home canvas, home area and its available links (one level). */
  function homeContext(channelId: string) {
    const home = context.home(channelId);
    if (!home) return { canvas: null, area: null, linked: [] };
    const read = (scope: ContextScope) => { const { notes, files } = context.get(scope); return { notes, files }; };
    const canvasName = (store.db.prepare('SELECT name FROM product_canvases WHERE id=?').get(home.canvasId) as { name: string } | undefined)?.name ?? '';
    const areaTitle = home.areaId ? (store.db.prepare('SELECT title FROM product_canvas_areas WHERE id=?').get(home.areaId) as { title: string } | undefined)?.title ?? '' : '';
    return {
      canvas: { name: canvasName, ...read({ kind: 'canvas', canvasId: home.canvasId }) },
      area: home.areaId ? { title: areaTitle, ...read({ kind: 'area', canvasId: home.canvasId, areaId: home.areaId }) } : null,
      // A source's own links are never followed.
      linked: home.areaId ? linkSources(store, home.areaId).filter(link => link.available).map(({ source }) => (
        { title: source.title, ...read({ kind: 'area', canvasId: source.canvasId, areaId: source.id }) })) : [],
    };
  }
  function readableFile(channelId: string, fileId: string) {
    const home = context.home(channelId);
    const stored = z.string().uuid().safeParse(fileId).success ? context.file(fileId) : null;
    if (!home || !stored) return null;
    if (stored.scope.kind === 'canvas') return stored.scope.canvasId === home.canvasId ? stored : null;
    if (!home.areaId) return null;
    const areas = new Set([home.areaId, ...linkSources(store, home.areaId).filter(link => link.available).map(link => link.source.id)]);
    return areas.has(stored.scope.areaId) ? stored : null;
  }

  /** Agent routes. They authenticate only by the agent's context key (never cookies) and 404 with the flag off. */
  function registerRoutes(app: Hono, { enabled, files }: { enabled: boolean; files: Pick<ContextFiles, 'open'> }) {
    const routes = new Hono<{ Variables: { agentName: string } }>();
    const fail = (status: 400 | 401 | 403 | 404 | 429 | 503, message: string) => new HTTPException(status, { message });
    const windows = new Map<string, { start: number; count: number }>();
    routes.onError((error, c) => {
      if (error instanceof HTTPException) return c.json({ error: error.message }, error.status);
      console.error('Agent context request failed:', error.name);
      return c.json({ error: 'Context is unavailable. Retry later.' }, 502);
    });
    const limited = (tokenHash: string) => {
      const now = Date.now();
      if (windows.size > 10_000) for (const [hash, w] of windows) if (now - w.start >= RATE_WINDOW_MS) windows.delete(hash);
      const current = windows.get(tokenHash);
      if (!current || now - current.start >= RATE_WINDOW_MS) { windows.set(tokenHash, { start: now, count: 1 }); return false; }
      return ++current.count > RATE_LIMIT;
    };
    const guard = async (c: Context<{ Variables: { agentName: string } }>, next: () => Promise<void>) => {
      c.header('Cache-Control', 'no-store');
      if (!enabled) throw fail(404, 'Not found');
      const key = BEARER.exec(c.req.header('authorization') ?? '')?.[1];
      if (!key) throw fail(401, 'Unauthorized');
      const tokenHash = sha256(key);
      const agentName = context.agentForKey(tokenHash);
      if (!agentName) throw fail(401, 'Unauthorized');
      if (limited(tokenHash)) throw fail(429, 'Too many requests');
      c.set('agentName', agentName);
      await next();
    };
    routes.use('/api/context', guard);
    routes.use('/api/context/*', guard);
    // The chat comes from the request; the engine must list this agent in it, live, on every read.
    async function chatOf(c: Context<{ Variables: { agentName: string } }>) {
      const channelId = c.req.query('channelId') ?? '';
      if (!CHANNEL_ID.test(channelId)) throw fail(400, 'channelId is required');
      if (!engineToken) throw fail(503, 'Context is not configured');
      const channel = (await liveChannels()).get(channelId);
      if (!agentsIn(channel).includes(c.get('agentName'))) throw fail(403, 'This agent is not in that chat');
      return channelId;
    }
    routes.get('/api/context/agent', async c => c.json(homeContext(await chatOf(c))));
    routes.get('/api/context/agent/files/:fileId', async c => {
      const channelId = await chatOf(c);
      const stored = readableFile(channelId, c.req.param('fileId'));
      if (!stored) throw fail(404, 'Not found');
      return c.body(files.open(stored.storageKey), 200, { ...DOWNLOAD_HEADERS, 'content-disposition': attachment(stored.name) });
    });
    // Nothing under /api/context falls through to the engine proxy.
    routes.all('/api/context', () => { throw fail(404, 'Not found'); });
    routes.all('/api/context/*', () => { throw fail(404, 'Not found'); });
    app.route('/', routes);
  }

  return { ensureAgents, pending, readers, registerRoutes };
}
export type ContextAgentsService = ReturnType<typeof createContextAgents>;
