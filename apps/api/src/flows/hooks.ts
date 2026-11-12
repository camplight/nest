import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Context, Hono } from 'hono';
import { CanvasConflictError, type ProductDb } from '@nest/db';
import { EngineError, type Human, type OrgOpsClient } from '@nest/orgops-client';
import {
  HOOK_CALLS_PER_MINUTE, HOOK_INLINE_CHARS, HOOK_PAYLOAD_FILE, HOOK_TOKEN_PATTERN, MAX_HOOK_BYTES, NewTriggerSchema, TriggerPatchSchema,
  type CreatedTrigger, type FlowNeed, type SchedulePausedReason, type Trigger, type TriggerView,
} from '@nest/schemas';
import type { Channel } from '../canvases';
import { channelAccess, type AccessChannel } from './access';
import type { ForkRouteTools } from './forks';
import type { Switchyard } from './identity';

type PauseReason = Exclude<SchedulePausedReason, null>;
const WINDOW_MS = 60_000;
/** Header values used as the delivery id (the engine idempotency key's last part) only up to this length. */
const MAX_DELIVERY_ID = 200;

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
const describe = (error: unknown) =>
  error instanceof EngineError ? `engine status ${error.status}` : error instanceof Error ? error.name : 'unknown error';
const isAgentIn = (channel: AccessChannel | undefined, name: string) =>
  (channel?.participants ?? []).some(p => p.subscriberType === 'AGENT' && p.subscriberId === name);

/** A new webhook token: `nest_hook_` and 32 random bytes in base64url. Only its sha256 and last 4 characters are kept. */
export function mintHookToken(): { token: string; hash: string; hint: string } {
  const token = `nest_hook_${randomBytes(32).toString('base64url')}`;
  return { token, hash: sha256(token), hint: token.slice(-4) };
}

/** The origin the caller reached Nest at: the proxy's forwarded proto and host when they look sane, else the request URL. */
export function requestOrigin(request: Request): string {
  const url = new URL(request.url);
  const first = (name: string) => request.headers.get(name)?.split(',')[0]?.trim() ?? '';
  const proto = first('x-forwarded-proto'), host = first('x-forwarded-host');
  const scheme = proto === 'http' || proto === 'https' ? proto : url.protocol.slice(0, -1);
  return `${scheme}://${host && /^[A-Za-z0-9.-]+(:\d{1,5})?$|^\[[0-9A-Fa-f:.]+\](:\d{1,5})?$/.test(host) ? host : url.host}`;
}

/** How a trigger Nest paused reads in Needs you; the same reasons as a paused schedule (ruling T10-R2). */
export function triggerPausedWhy(reason: PauseReason, agent: string): string {
  if (reason === 'access') return "you can't post here any more";
  if (reason === 'agent-left') return `${agent} left the chat`;
  return 'this chat is no longer available';
}

/** The creator's webhook triggers that Nest paused, for Needs you, until resumed or deleted. */
export function triggerNeeds(store: ProductDb, creatorId: string): FlowNeed[] {
  return store.schedules.pausedTriggersFor(creatorId).map((t): FlowNeed => {
    const why = triggerPausedWhy(t.pausedReason!, t.agent);
    return {
      key: `trigger-paused:${t.id}`, kind: 'paused', channelId: t.channelId, at: t.updatedAt, from: null,
      short: `Webhook paused · ${why}`, reason: why,
      detail: `Webhook · ${t.label} · ${t.agent}. Calls to its URL do nothing until you resume it.`,
      gate: { kind: 'trigger-paused', triggerId: t.id },
    };
  });
}

/** What a viewer may do with a trigger: the creator changes and rotates it; the creator or a chat member pauses or deletes it. */
export function triggerView(t: Trigger, channel: AccessChannel | undefined, viewer: { id: string; username: string }): TriggerView {
  const creator = t.createdBy === viewer.id;
  return { ...t, canEdit: creator, canManage: creator || channelAccess(channel, viewer).member };
}

/**
 * Reads a body, counting bytes as they arrive; null as soon as it passes `max` (the rest is never read). A missing or
 * wrong content-length changes nothing.
 */
async function readCapped(body: ReadableStream<Uint8Array> | null, max: number): Promise<Uint8Array | null> {
  if (!body) return new Uint8Array(0);
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

/** A code fence longer than any run of backticks in the text, so the payload cannot close it early. */
function fenced(text: string): string {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map(run => run.length));
  const fence = '`'.repeat(Math.max(3, longest + 1));
  return `${fence}\n${text}\n${fence}`;
}

/**
 * Webhook triggers. `POST /api/hooks/<token>` is public: no cookie or session is read, and it is answered here, never
 * by the engine proxy. The token is looked up only by its sha256. A call passes, in order: the lookup (unknown or off:
 * 404), the rate limit (30 per trigger in any 60 s, in this process: 429), the size (64 KiB, counted while reading: 413),
 * then the creator's post access and the agent (else the trigger pauses and the call gets 404). It then posts as
 * Switchyard to the agent with the key `nest:hook:<id>:<deliveryId>` and answers 202. Every other failure answers 404
 * too. Tokens, URLs and payloads are never logged; logs carry trigger ids and error names only.
 */
export function createHooks({ store, orgops, token, switchyard, now = Date.now, log = line => console.warn(line) }: {
  store: ProductDb; orgops: OrgOpsClient; token: string | undefined; switchyard: Switchyard;
  now?: () => number; log?: (line: string) => void;
}) {
  const triggers = store.schedules;
  // Accepted calls per trigger in the last minute (sliding), in this process only.
  const calls = new Map<string, number[]>();
  function admit(id: string, at: number): boolean {
    const recent = (calls.get(id) ?? []).filter(t => t > at - WINDOW_MS);
    if (recent.length >= HOOK_CALLS_PER_MINUTE) { calls.set(id, recent); return false; }
    recent.push(at);
    calls.set(id, recent);
    if (calls.size > 1_000) for (const [key, list] of calls) if (!list.some(t => t > at - WINDOW_MS)) calls.delete(key);
    return true;
  }

  /** Why the trigger cannot run now (its chat, its creator's post access, its agent), or its creator's name. */
  async function check(t: Trigger): Promise<{ reason: PauseReason } | { username: string }> {
    const service = orgops.service(token!);
    const [channels, humans] = await Promise.all([service.channels(), service.humans()]);
    const channel = channels.find(ch => ch.id === t.channelId);
    if (!channel) return { reason: 'unavailable' };
    const creator = humans.find(h => h.id === t.createdBy);
    if (!creator || !channelAccess(channel, creator).post) return { reason: 'access' };
    if (!isAgentIn(channel, t.agent)) return { reason: 'agent-left' };
    return { username: creator.username };
  }

  async function deliver(c: Context, t: Trigger, bytes: Uint8Array, username: string): Promise<void> {
    const header = (name: string) => c.req.header(name)?.trim() ?? '';
    const given = [header('idempotency-key'), header('x-github-delivery')].find(v => v.length > 0 && v.length <= MAX_DELIVERY_ID);
    const deliveryId = given ?? randomUUID();
    // UTF-8 with replacement characters; never parsed, whatever the content type says.
    const body = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
    const long = body.length > HOOK_INLINE_CHARS;
    let attachments: { fileId: string; name: string; mime: string; size: number }[] = [];
    if (long) {
      const { fileId } = await orgops.service(token!).upload(HOOK_PAYLOAD_FILE, bytes, 'application/json');
      attachments = [{ fileId, name: HOOK_PAYLOAD_FILE, mime: 'application/json', size: bytes.byteLength }];
    }
    const heading = long ? `Payload (the first ${HOOK_INLINE_CHARS.toLocaleString('en-US')} characters; all of it is attached as ${HOOK_PAYLOAD_FILE}):` : 'Payload:';
    await switchyard.post({
      channelId: t.channelId, target: t.agent, kind: 'webhook', setBy: t.createdBy,
      text: `Webhook · ${t.label} · set up by ${username}\n\n${t.prompt}\n\n${heading}\n${fenced(long ? body.slice(0, HOOK_INLINE_CHARS) : body)}`,
      idempotencyKey: `nest:hook:${t.id}:${deliveryId}`, meta: { triggerId: t.id },
      ...(attachments.length ? { attachments } : {}),
    });
  }

  /** The public endpoint. Its answers are `{error:'Not found'}` (404), 413, 429 or 202 `{ok:true}`, with no detail. */
  async function call(c: Context, enabled: boolean): Promise<Response> {
    c.header('Cache-Control', 'no-store');
    const notFound = () => c.json({ error: 'Not found' }, 404);
    let id: string | null = null;
    try {
      if (!enabled || !token || c.req.method !== 'POST') return notFound();
      const raw = c.req.param('token') ?? '';
      if (!HOOK_TOKEN_PATTERN.test(raw)) return notFound();
      const t = triggers.triggerByHash(sha256(raw));
      if (!t || !t.on) return notFound();
      id = t.id;
      const at = now();
      if (!admit(t.id, at)) return c.json({ error: 'Too many requests' }, 429);
      const bytes = await readCapped(c.req.raw.body, MAX_HOOK_BYTES);
      if (!bytes) return c.json({ error: 'Payload too large' }, 413);
      const verdict = await check(t);
      if ('reason' in verdict) {
        if (triggers.pauseTrigger(t.id, verdict.reason, 'system')) log(`[flows] webhook ${t.id} paused: ${verdict.reason}`);
        return notFound();
      }
      await deliver(c, t, bytes, verdict.username);
      triggers.touchTrigger(t.id, at);
      return c.json({ ok: true }, 202);
    } catch (error) {
      log(`[flows] webhook ${id ?? 'call'} failed: ${describe(error)}`);
      return notFound();
    }
  }

  return { call, now };
}
export type Hooks = ReturnType<typeof createHooks>;

/**
 * The public webhook endpoint, registered before every cookie-auth route and the engine proxy. Every method and path
 * under /api/hooks is answered here: only `POST /api/hooks/<token>` can succeed. With the canvas flag off it answers
 * 404 exactly as an unknown token does. No CORS headers are set.
 */
export function registerHookEndpoint(app: Hono, { hooks, enabled }: { hooks: Hooks; enabled: boolean }) {
  app.all('/api/hooks/:token', c => hooks.call(c, enabled));
  const notFound = (c: Context) => { c.header('Cache-Control', 'no-store'); return c.json({ error: 'Not found' }, 404); };
  app.all('/api/hooks', notFound);
  app.all('/api/hooks/*', notFound);
}

/**
 * Trigger routes under /api/flows (cookie auth, the flag and the body limit come from the flow routes). Creating needs
 * post access to the chat (the flows rule), an agent in it other than Switchyard, and room (5 per chat). Settings
 * (prompt, agent, label) and rotation are the creator's; on/off and delete are open to the creator and the chat's members.
 */
export function registerTriggerRoutes(routes: Hono<{ Variables: { human: Human } }>, { store, switchyard, hooks, tools }: {
  store: ProductDb; switchyard: Switchyard; hooks: Hooks; tools: ForkRouteTools;
}) {
  const { fail, parse, body, viewerChannels, join } = tools;
  const triggers = store.schedules;
  const notFound = () => fail(404, 'Not found');
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const url = (c: Context, token: string) => `${requestOrigin(c.req.raw)}/api/hooks/${token}`;

  async function triggerFor(c: Context) {
    const id = c.req.param('id') ?? '';
    if (!uuid.test(id)) throw notFound();
    const human = c.get('human') as Human;
    const channels = await viewerChannels(c.req.raw.headers);
    const t = triggers.trigger(id);
    if (!t || (t.createdBy !== human.id && !channels.has(t.channelId))) throw notFound();
    return { t, human, channels, view: triggerView(t, channels.get(t.channelId), human) };
  }
  const requireAgent = (channel: Channel | undefined, agent: string) => {
    if (agent === switchyard.name) throw fail(400, `${agent} cannot answer webhooks`);
    if (!isAgentIn(channel, agent)) throw fail(409, `Add ${agent} to the chat first`);
  };
  const conflict = (c: Context, id: string, channels: Map<string, Channel>, human: Human) => {
    const current = triggers.trigger(id);
    return c.json({ error: 'Webhook changed', current: current && triggerView(current, channels.get(current.channelId), human) }, 409);
  };

  routes.post('/api/flows/triggers', async c => {
    const input = parse(NewTriggerSchema, await body(c));
    const human = c.get('human');
    const channels = await viewerChannels(c.req.raw.headers);
    const channel = channels.get(input.channelId);
    if (!channelAccess(channel, human).post) throw fail(403, 'You need to be able to post in this chat');
    requireAgent(channel, input.agent);
    const existing = triggers.trigger(input.id);
    if (existing && existing.createdBy !== human.id) throw fail(409, 'Webhook ID already used');
    // The limit comes before Switchyard joins, so a refused webhook changes nothing in the engine.
    if (!existing) triggers.checkTriggerLimit(input.channelId);
    await join([input.channelId]);
    const minted = mintHookToken();
    let created: { trigger: Trigger; rotated: boolean };
    try {
      created = triggers.createTrigger({ ...input, tokenHash: minted.hash, tokenHint: minted.hint, createdBy: human.id, now: hooks.now() });
    } catch (error) {
      if (error instanceof CanvasConflictError) throw fail(409, 'Webhook ID already used');
      throw error;
    }
    const t = created.trigger;
    try {
      await switchyard.post({
        channelId: t.channelId, text: `Webhook · ${t.label} · ${t.agent}`, target: null,
        kind: 'note', setBy: human.id, idempotencyKey: `nest:note:webhook:${t.id}`, meta: { triggerId: t.id },
      });
    } catch (error) {
      // The webhook stands without its note; retrying the request posts it (and gives a new URL).
      console.error('The webhook note could not be posted:', (error as Error).name);
    }
    const answer: CreatedTrigger = { trigger: triggerView(t, channel, human), url: url(c, minted.token) };
    return c.json(answer, created.rotated ? 200 : 201);
  });

  // A new URL; the old one stops working in the same write. Creator only.
  routes.post('/api/flows/triggers/:id/rotate', async c => {
    const { t, human, view } = await triggerFor(c);
    if (!view.canEdit) throw fail(403, 'Only the person who set up this webhook can change its URL');
    const minted = mintHookToken();
    if (!triggers.rotateTrigger(t.id, minted.hash, minted.hint, hooks.now(), human.id)) throw notFound();
    return c.json({ url: url(c, minted.token) });
  });

  routes.patch('/api/flows/triggers/:id', async c => {
    const { version, ...patch } = parse(TriggerPatchSchema, await body(c));
    const { t, human, channels, view } = await triggerFor(c);
    const settings = patch.prompt !== undefined || patch.agent !== undefined || patch.label !== undefined;
    if (settings && !view.canEdit) throw fail(403, 'Only the person who set up this webhook can change it');
    if (!view.canManage) throw fail(403, 'Only the person who set up this webhook or a member of the chat can pause it');
    if (patch.agent !== undefined && patch.agent !== t.agent) requireAgent(channels.get(t.channelId), patch.agent);
    if (t.version !== version) return conflict(c, t.id, channels, human);
    try {
      const updated = triggers.patchTrigger(t.id, patch, version, human.id);
      return c.json(triggerView(updated, channels.get(updated.channelId), human));
    } catch (error) {
      if (error instanceof CanvasConflictError) return conflict(c, t.id, channels, human);
      throw error;
    }
  });

  // Calls already posted stay in the chat; the URL stops working.
  routes.delete('/api/flows/triggers/:id', async c => {
    const raw = c.req.query('version');
    const version = Number(raw);
    if (!raw || !Number.isInteger(version) || version < 0) throw fail(400, 'version is required');
    const { t, human, channels, view } = await triggerFor(c);
    if (!view.canManage) throw fail(403, 'Only the person who set up this webhook or a member of the chat can delete it');
    if (t.version !== version) return conflict(c, t.id, channels, human);
    triggers.removeTrigger(t.id, human.id);
    return c.body(null, 204);
  });
}

/** Every trigger in a chat the viewer can read, with their rights. */
export const triggerViews = (store: ProductDb, channels: Map<string, Channel>, viewer: Human): TriggerView[] =>
  store.schedules.triggersIn([...channels.keys()]).map(t => triggerView(t, channels.get(t.channelId), viewer));
