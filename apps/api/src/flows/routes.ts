import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import { CanvasConflictError, CanvasLimitError, type ProductDb } from '@nest/db';
import { isEngineOutage, type EngineEvent, type Human, type OrgOpsClient } from '@nest/orgops-client';
import { LinkPatchSchema, NewLinkSchema, type FlowNeed, type Link } from '@nest/schemas';
import type { Channel } from '../canvases';
import { channelAccess, linkRights } from './access';
import type { Switchyard, SwitchyardState } from './identity';
import { FlowActionError, NOTHING_TO_SEND, pausedWhy, type HandoffWorker } from './handoff';

const NOT_SET_UP = 'Hand-offs are not set up on this server';
/** The title of a chat the viewer cannot read. */
export const PRIVATE_CHAT_TITLE = 'a private chat';
const uuid = z.string().uuid();
const DecisionSchema = z.object({ decision: z.enum(['approve', 'decline']) }).strict();

export type Availability = {
  enabled: boolean; reason?: string; serviceAgent: string | null;
  summaries: 'model' | 'fallback'; webhooks: boolean;
};

/**
 * Links between chats. Engine chats, participants and events are read through the viewer's own
 * session; Switchyard joins and posts with the service token. Flag off: every route answers 404.
 */
export function registerFlowRoutes(app: Hono, { store, orgops, enabled, switchyard, worker }: {
  store: ProductDb; orgops: OrgOpsClient; enabled: boolean; switchyard: Switchyard; worker: HandoffWorker;
}) {
  const routes = new Hono<{ Variables: { human: Human } }>();
  routes.onError((error, c) => {
    if (error instanceof HTTPException) return c.json({ error: error.message }, error.status);
    if (error instanceof CanvasLimitError) return c.json({ error: error.message }, 400);
    if (error instanceof FlowActionError) return c.json({ error: error.message }, error.status);
    console.error('Flow request failed:', error.name);
    return c.json({ error: 'The engine is unavailable. Links are kept; refresh and retry.' }, 502);
  });
  const fail = (status: 400 | 403 | 404 | 409 | 503, message: string) => new HTTPException(status, { message });
  const notFound = () => fail(404, 'Not found');
  function parse<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, value: unknown): T {
    const result = schema.safeParse(value);
    if (!result.success) throw fail(400, result.error.issues.map(i => i.message).join('; '));
    return result.data;
  }
  const body = async (c: { req: { json(): Promise<unknown> } }) => c.req.json().catch(() => null);

  const auth = async (c: any, next: () => Promise<void>) => {
    const human = await orgops.currentHuman(c.req.raw.headers);
    if (!human) return c.json({ error: 'Unauthorized' }, 401);
    if (human.mustChangePassword) return c.json({ error: 'Complete password setup first' }, 403);
    c.set('human', human);
    c.header('Cache-Control', 'no-store');
    await next();
  };
  for (const path of ['/api/flows', '/api/flows/*']) {
    // The flag comes first, so a disabled server answers 404 whoever asks.
    routes.use(path, async (_c, next) => { if (!enabled) throw notFound(); await next(); });
    routes.use(path, bodyLimit({ maxSize: 64_000, onError: c => c.json({ error: 'Request too large' }, 413) }));
    routes.use(path, auth);
  }

  /** Every chat the engine lists for the viewer, archived ones included. */
  const viewerChannels = async (headers: Headers) =>
    new Map((await orgops.humanJson<Channel[]>('/api/channels?includeArchived=1', headers)).map(ch => [ch.id, ch]));
  /** Card titles (project name, else chat name) for chats the viewer can read; anything else is 'a private chat'. */
  function titles(channels: Map<string, Channel>, ids: string[]) {
    const projects = store.projects.byChannels(ids.filter(id => channels.has(id)));
    return (id: string) => {
      const ch = channels.get(id);
      return ch ? projects.get(id)?.name ?? ch.name ?? '' : PRIVATE_CHAT_TITLE;
    };
  }
  const isAgentIn = (channel: Channel | undefined, name: string) =>
    (channel?.participants ?? []).some(p => p.subscriberType === 'AGENT' && p.subscriberId === name);
  const requireAgent = (channel: Channel | undefined, who: string | null | undefined) => {
    if (who && !isAgentIn(channel, who)) throw fail(409, `Add ${who} to the chat first`);
  };
  /** ensure() throws on a refused token or a failed create; the browser only learns that flows are unavailable. */
  async function serviceState(): Promise<SwitchyardState> {
    try { return await switchyard.ensure(); } catch { return { ok: false, reason: 'engine-unavailable' }; }
  }
  /** A link the viewer may act on. Someone who reads neither chat and did not create it cannot tell it exists. */
  async function linkFor(c: any) {
    if (!uuid.safeParse(c.req.param('id')).success) throw notFound();
    const human = c.get('human') as Human;
    const channels = await viewerChannels(c.req.raw.headers);
    // Read after the engine call, so the checks below and the write that follows see the same row.
    const link = store.flows.link(c.req.param('id'));
    if (!link) throw notFound();
    if (link.createdBy !== human.id && !channels.has(link.from) && !channels.has(link.to)) throw notFound();
    return { link, human, channels, rights: linkRights(link, channels.get(link.to), human) };
  }
  const conflict = (c: any, id: string) => c.json({ error: 'Link changed', current: store.flows.link(id) }, 409);

  routes.get('/api/flows/availability', async c => {
    const state = await serviceState();
    const availability: Availability = {
      enabled: state.ok,
      ...(state.ok ? {} : { reason: state.reason }),
      // A name taken by someone else's agent is not ours to hide.
      serviceAgent: state.ok || state.reason === 'engine-unavailable' ? switchyard.name : null,
      // Task 4 makes summaries real; Task 13 adds webhooks.
      summaries: 'fallback',
      webhooks: false,
    };
    return c.json(availability);
  });

  routes.get('/api/flows/links', async c => {
    const channelId = c.req.query('channelId');
    if (!channelId) throw fail(400, 'channelId is required');
    const human = c.get('human');
    const channels = await viewerChannels(c.req.raw.headers);
    if (!channels.has(channelId)) throw notFound();
    const links = store.flows.linksTouching([channelId]);
    const title = titles(channels, links.flatMap(l => [l.from, l.to]));
    return c.json({ links: links.map(l => ({ ...l, fromTitle: title(l.from), toTitle: title(l.to), ...linkRights(l, channels.get(l.to), human) })) });
  });

  routes.post('/api/flows/links', async c => {
    const input = parse(NewLinkSchema, await body(c));
    const human = c.get('human');
    const channels = await viewerChannels(c.req.raw.headers);
    const from = channels.get(input.from), to = channels.get(input.to);
    // The rule delivery applies (S9): team-only and viewer-share access count as none.
    if (!channelAccess(from, human).read || !channelAccess(to, human).post) throw fail(403, 'You need to read the first chat and post in the second');
    requireAgent(to, input.who);
    if (!(await serviceState()).ok) throw fail(503, NOT_SET_UP);
    try {
      await switchyard.join(input.to);
      await switchyard.join(input.from);
    } catch (error) {
      if (isEngineOutage(error)) throw error;
      console.error('Switchyard could not join a linked chat:', (error as Error).name);
      throw fail(503, NOT_SET_UP);
    }
    // Only turns after the newest finished one are handed off. With none, the scan starts at 0: every
    // turn it finds completed after this read, including one that completes while the link is created.
    const newest = (await orgops.humanJson<EngineEvent[]>(
      `/api/events?channelId=${encodeURIComponent(input.from)}&type=agent.turn.completed&order=desc&limit=1`, c.req.raw.headers))[0];
    const existed = store.flows.link(input.id) !== null;
    let link: Link;
    try {
      link = store.flows.createLink({
        id: input.id, from: input.from, to: input.to, what: input.what, when: input.when, who: input.who ?? null, label: input.label,
        kind: 'link', createdBy: human.id, now: Date.now(), scannedTo: newest?.createdAt ?? 0,
      });
    } catch (error) {
      if (error instanceof CanvasConflictError) throw fail(409, 'Link ID already used');
      throw error;
    }
    // This request's link (new, or a retry of it): the note's key makes a retry return the note already posted.
    const mine = link.id === input.id;
    if (input.intro && mine) {
      try {
        await switchyard.post({
          channelId: input.to, text: `Picks up what "${titles(channels, [input.from])(input.from)}" produces.`, target: null,
          kind: 'note', setBy: human.id, idempotencyKey: `nest:note:new-step:${link.id}`, meta: { linkId: link.id },
        });
      } catch (error) {
        // The link stands without its note; retrying the same request posts it.
        console.error('The new-step note could not be posted:', (error as Error).name);
      }
    }
    // 201 for a new link; 200 for a retry, or for a pair that is already linked (the existing link).
    return c.json(link, mine && !existed ? 201 : 200);
  });

  routes.patch('/api/flows/links/:id', async c => {
    const { version, ...patch } = parse(LinkPatchSchema, await body(c));
    const { link, human, channels, rights } = await linkFor(c);
    const settings = patch.what !== undefined || patch.when !== undefined || patch.who !== undefined || patch.label !== undefined;
    if (settings && !rights.canEdit) throw fail(403, 'Only the person who set up this hand-off can change it');
    if (!rights.canManage) throw fail(403, 'Only the person who set up this hand-off or a member of the receiving chat can pause it');
    if (settings) requireAgent(channels.get(link.to), patch.who);
    try {
      return c.json(store.flows.patchLink(link.id, patch, version, human.id));
    } catch (error) {
      if (error instanceof CanvasConflictError) return conflict(c, link.id);
      throw error;
    }
  });

  // Messages already handed off stay in the engine; only the link goes.
  routes.delete('/api/flows/links/:id', async c => {
    const raw = c.req.query('version');
    const version = Number(raw);
    if (!raw || !Number.isInteger(version) || version < 0) throw fail(400, 'version is required');
    const { link, human, rights } = await linkFor(c);
    if (!rights.canManage) throw fail(403, 'Only the person who set up this hand-off or a member of the receiving chat can disconnect it');
    if (link.version !== version) return conflict(c, link.id);
    store.flows.removeLink(link.id, human.id);
    return c.body(null, 204);
  });

  // Send now: the newest finished result not yet handed off on this link.
  routes.post('/api/flows/links/:id/send', async c => {
    const { link, human, rights } = await linkFor(c);
    if (!rights.canManage) throw fail(403, 'Only the person who set up this hand-off or a member of the receiving chat can send it');
    const status = await worker.deliverNow(link.id, human);
    if (status === 'nothing') throw fail(409, NOTHING_TO_SEND);
    return c.json({ status });
  });

  routes.post('/api/flows/deliveries/:id/decision', async c => {
    if (!uuid.safeParse(c.req.param('id')).success) throw notFound();
    const { decision } = parse(DecisionSchema, await body(c));
    await worker.decide(c.req.param('id'), decision, c.get('human'));
    return c.body(null, 204);
  });

  /** The viewer's hand-offs awaiting their OK and their links the worker paused. */
  routes.get('/api/flows/needs', async c => {
    const human = c.get('human');
    const channels = await viewerChannels(c.req.raw.headers);
    const awaiting = store.flows.awaiting(human.id).flatMap(d => {
      const link = store.flows.link(d.linkId);
      return link ? [{ delivery: d, link }] : [];
    });
    const paused = store.flows.pausedLinks(human.id);
    const title = titles(channels, [...awaiting.map(a => a.link), ...paused].flatMap(l => [l.from, l.to]));
    // The finished turn's agent, read with the viewer's own session.
    const agents = await Promise.all(awaiting.map(({ delivery }) =>
      orgops.humanJson<EngineEvent>(`/api/events/${encodeURIComponent(delivery.sourceTurnId)}`, c.req.raw.headers)
        .then(turn => turn.source.startsWith('agent:') ? turn.source.slice('agent:'.length) : null, () => null)));
    const items: FlowNeed[] = [
      ...awaiting.map(({ delivery, link }, i): FlowNeed => {
        const short = `Approve hand-off to ${title(link.to)}`;
        return {
          key: `approval:${delivery.id}`, kind: 'approval', channelId: link.from, at: delivery.createdAt, from: agents[i],
          short, reason: short,
          detail: `${agents[i] ?? 'An agent'} finished something in ${title(link.from)}. It goes to ${title(link.to)} after your OK.`,
          gate: { kind: 'approval', deliveryId: delivery.id, linkId: link.id },
        };
      }),
      ...paused.map((link): FlowNeed => {
        const why = pausedWhy(link.pausedReason!, link.who);
        return {
          key: `paused:${link.id}`, kind: 'paused', channelId: link.from, at: link.pausedAt, from: null,
          short: `Hand-off to ${title(link.to)} paused · ${why}`, reason: why,
          detail: `Nothing passes from ${title(link.from)} to ${title(link.to)} until you resume it.`,
          gate: { kind: 'paused', linkId: link.id },
        };
      }),
    ];
    return c.json({ items: items.sort((a, b) => b.at - a.at) });
  });

  // Unknown flow endpoints never fall through to the engine proxy.
  routes.all('/api/flows', () => { throw notFound(); });
  routes.all('/api/flows/*', () => { throw notFound(); });
  app.route('/', routes);
}
