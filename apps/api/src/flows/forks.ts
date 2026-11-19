import { randomUUID } from 'node:crypto';
import type { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { ProductDb } from '@nest/db';
import type { EngineEvent, Human, OrgOpsClient } from '@nest/orgops-client';
import { FORK_LINK_LABEL, FORK_QUOTE_CHARS, FORK_SUMMARY_MESSAGES, NewForkSchema, type ForkView } from '@nest/schemas';
import type { Channel } from '../canvases';
import type { ChannelAccess } from './access';
import type { Switchyard } from './identity';
import type { Summarize } from './summarize';

/** What the flow routes share with the fork routes: their refusals, parsing and the viewer's engine view. */
export type ForkRouteTools = {
  fail(status: 400 | 403 | 404 | 409 | 503, message: string): HTTPException;
  parse<T>(schema: { safeParse(value: unknown): { success: true; data: T } | { success: false; error: { issues: { message: string }[] } } }, value: unknown): T;
  body(c: unknown): Promise<unknown>;
  viewerChannels(headers: Headers): Promise<Map<string, Channel>>;
  /** The flows access rule (S9) for the viewer, with their teams read once for this request. */
  viewerAccess(headers: Headers, human: Human): (channel: Channel | undefined) => Promise<ChannelAccess>;
  titles(channels: Map<string, Channel>, ids: string[]): (id: string) => string;
  /** Switchyard joins both chats, or the request fails with 503 (an outage is rethrown for the 502 answer). */
  join(channelIds: string[]): Promise<void>;
};

const str = (value: unknown) => (typeof value === 'string' ? value : '');
const authorOf = (source: string) => source.replace(/^(agent|human):/, '') || source || 'Someone';
const textOf = (event: EngineEvent) => str((event.payload as Record<string, unknown> | undefined)?.text);
/** A markdown quote of the forked message, every line quoted. */
const quote = (text: string) => text.slice(0, FORK_QUOTE_CHARS).split('\n').map(line => `> ${line}`.trimEnd()).join('\n');

/** `HH:MM` in the viewer's time zone (UTC without one). Throws a RangeError for an unknown zone. */
export function forkTime(at: number, timeZone = 'UTC'): string {
  return new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone }).format(at);
}

/**
 * Forks: a chat the viewer started becomes a fork of one message in a chat they can read. Switchyard joins both
 * chats and posts the seed into the fork (its first line names the parent, the author, the time and who set it up,
 * then a summary up to that message and the message quoted), targeted at the author when they are an agent in the
 * fork. A fork link (child → parent) lets findings flow back. The engine is read with the viewer's own session.
 */
export function registerForkRoutes(routes: Hono<{ Variables: { human: Human } }>, { store, orgops, switchyard, summarize, tools }: {
  store: ProductDb; orgops: OrgOpsClient; switchyard: Switchyard; summarize: Summarize; tools: ForkRouteTools;
}) {
  const { fail, parse, body, viewerChannels, viewerAccess, titles, join } = tools;
  const notFound = () => fail(404, 'Not found');

  /** The message, read as the viewer: it must be a message in the parent chat. */
  async function messageIn(parentChannelId: string, eventId: string, headers: Headers): Promise<EngineEvent> {
    const response = await orgops.humanRequest(`/api/events/${encodeURIComponent(eventId)}`, headers);
    if (response.status >= 500) throw new Error(`Engine request failed (${response.status})`);
    if (!response.ok) throw notFound();
    const event = (await response.json()) as EngineEvent;
    if (event.channelId !== parentChannelId || event.type !== 'message.created') throw notFound();
    return event;
  }

  routes.post('/api/flows/forks', async c => {
    const input = parse(NewForkSchema, await body(c));
    const timeZone = input.timeZone ?? 'UTC';
    try { forkTime(0, timeZone); } catch { throw fail(400, 'Unknown time zone'); }
    const human = c.get('human');
    const headers = c.req.raw.headers;
    const channels = await viewerChannels(headers);
    const parent = channels.get(input.parentChannelId), child = channels.get(input.childChannelId);
    // The rule links use (S9): teams count as the engine counts them, and a viewer share reads.
    if (!(await viewerAccess(headers, human)(parent)).read) throw fail(403, 'You need to read the chat you fork from');
    const project = store.projects.byChannels([input.childChannelId]).get(input.childChannelId);
    if (!child || !project || store.projects.project(project.id)?.ownerId !== human.id) throw fail(403, 'A fork goes into a chat you started');

    const done = store.flows.forkOf([input.childChannelId])[0];
    if (done) {
      if (done.parentChannelId !== input.parentChannelId || done.parentEventId !== input.parentEventId) throw fail(409, 'This chat is already a fork of another message');
      return c.json({ childChannelId: done.childChannelId, linkId: done.linkId }, 200);
    }
    const message = await messageIn(input.parentChannelId, input.parentEventId, headers);
    await join([input.childChannelId, input.parentChannelId]);

    // Up to 40 messages ending at the forked one (the engine gives each event a distinct, increasing createdAt).
    const history = (await orgops.humanJson<EngineEvent[]>(
      `/api/events?channelId=${encodeURIComponent(input.parentChannelId)}&type=message.created&order=desc&limit=${FORK_SUMMARY_MESSAGES}&before=${message.createdAt + 1}`, headers)).reverse();
    if (!history.some(event => event.id === message.id)) history.push(message);
    const texts = history.flatMap(event => textOf(event).trim() ? [`${authorOf(event.source)}: ${textOf(event)}`] : []);
    const summary = await summarize({ texts, purpose: 'fork', actor: human.id, ref: { forkId: input.childChannelId } });

    const author = authorOf(message.source);
    const agentAuthor = message.source.startsWith('agent:') && author !== switchyard.name
      && (child.participants ?? []).some(p => p.subscriberType === 'AGENT' && p.subscriberId === author);
    const title = titles(channels, [input.parentChannelId])(input.parentChannelId);
    const text = `Forked from "${title}" · ${author}, ${forkTime(message.createdAt, timeZone)} · set up by ${human.username}\n\n${summary.text}\n\n${quote(textOf(message))}`;
    // The key makes a retry after a lost response return the seed already posted.
    await switchyard.post({
      channelId: input.childChannelId, text, target: agentAuthor ? author : null, kind: 'fork-seed', setBy: human.id,
      idempotencyKey: `nest:fork:${input.childChannelId}`, meta: { parentChannelId: input.parentChannelId, parentEventId: input.parentEventId },
    });

    // Findings flow back from turns that finish after the newest one now (none in a new chat).
    const newest = (await orgops.humanJson<EngineEvent[]>(
      `/api/events?channelId=${encodeURIComponent(input.childChannelId)}&type=agent.turn.completed&order=desc&limit=1`, headers))[0];
    const link = store.flows.createLink({
      id: randomUUID(), kind: 'fork', from: input.childChannelId, to: input.parentChannelId, what: 'results', when: 'done', who: null,
      label: FORK_LINK_LABEL, createdBy: human.id, now: Date.now(), scannedTo: newest?.createdAt ?? 0,
    });
    store.flows.recordFork({ childChannelId: input.childChannelId, parentChannelId: input.parentChannelId, parentEventId: input.parentEventId, linkId: link.id, createdBy: human.id });
    // A concurrent fork of the same chat from another message got there first.
    const stored = store.flows.forkOf([input.childChannelId])[0];
    if (stored.parentChannelId !== input.parentChannelId || stored.parentEventId !== input.parentEventId) {
      // This request's findings link would carry the child's results into a chat it is not a fork of.
      if (stored.linkId !== link.id) store.flows.removeLink(link.id, human.id);
      throw fail(409, 'This chat is already a fork of another message');
    }
    return c.json({ childChannelId: input.childChannelId, linkId: stored.linkId }, 201);
  });

  routes.get('/api/flows/forks', async c => {
    const parentChannelId = c.req.query('parentChannelId');
    if (!parentChannelId) throw fail(400, 'parentChannelId is required');
    const channels = await viewerChannels(c.req.raw.headers);
    if (!(await viewerAccess(c.req.raw.headers, c.get('human'))(channels.get(parentChannelId))).read) throw notFound();
    const forks = store.flows.forksOf(parentChannelId);
    const title = titles(channels, forks.map(f => f.childChannelId));
    const list: ForkView[] = forks.map(f => ({ childChannelId: f.childChannelId, parentEventId: f.parentEventId, title: title(f.childChannelId) }));
    return c.json({ forks: list });
  });
}

