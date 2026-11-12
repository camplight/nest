import { randomUUID } from 'node:crypto';
import type { Delivery, ProductDb } from '@nest/db';
import { EngineError, isEngineOutage, type EngineChannel, type EngineEvent, type OrgOpsClient, type ServiceClient } from '@nest/orgops-client';
import { LINK_HOURLY_CAP, type Link, type PausedReason } from '@nest/schemas';
import { channelAccess } from './access';
import type { Switchyard } from './identity';
import type { Summarize } from './summarize';

export const FLOWS_LEASE = 'flows';
const LEASE_MS = 60_000;
/**
 * The single-worker lease the hand-off worker and the scheduler share: one holder per API process, so when two
 * processes run, only one of them delivers hand-offs and books runs. True while `holder` holds it.
 */
export const holdFlowsLease = (store: ProductDb, holder: string, at: number) => store.flows.lease(FLOWS_LEASE, holder, LEASE_MS, at);
const HOUR_MS = 3_600_000;
const PAGE = 100;
/** Pages of completed turns read per source and tick; the rest waits for the next tick. */
const MAX_PAGES = 20;
const RESULT_CHARS = 8_000;
const HANDOFF_CHARS = 24_000;
const MAX_ATTACHMENTS = 20;
const TRANSCRIPT_MESSAGES = 1_000;
const TRANSCRIPT_BYTES = 2 * 1024 * 1024;
/** Oversized messages a transcript reads one by one before it notes the rest as left out. */
const TRANSCRIPT_REFETCH = 50;
/** A retried delivery that keeps being refused (not an outage) is given up after this many attempts. */
const MAX_ATTEMPTS = 5;
const WAKE_MS = 500;
export const NOTHING_TO_SEND = 'Nothing new to hand off yet.';

export type Actor = { id: string; username: string };
type Attachment = { fileId: string; name: string; mime?: string; size?: number };
/** What a finished turn produced: its agent's messages between the turn's start and its completion. */
type Results = { agent: string; messages: { text: string; attachments: Attachment[] }[] };
type Reason = Exclude<PausedReason, null>;

/** A refused hand-off action, with the status the route answers. */
export class FlowActionError extends Error {
  constructor(readonly status: 403 | 404 | 409 | 503, message: string) {
    super(message);
    this.name = 'FlowActionError';
  }
}

/** How a paused link reads in Needs you and in a refused Send now. */
export function pausedWhy(reason: Reason, who: string | null): string {
  if (reason === 'cap') return `hit ${LINK_HOURLY_CAP} an hour`;
  if (reason === 'access') return 'access changed';
  if (reason === 'agent-left') return `${who ?? 'The agent'} left the chat`;
  return 'chat unavailable';
}

const describe = (error: unknown) =>
  error instanceof EngineError ? `engine status ${error.status}` : error instanceof Error ? error.name : 'unknown error';
const str = (value: unknown) => (typeof value === 'string' ? value : '');
const author = (source: string) => source.replace(/^(agent|human):/, '');

function attachmentsOf(payload: Record<string, unknown> | undefined): Attachment[] {
  const list = payload?.attachments;
  if (!Array.isArray(list)) return [];
  const out: Attachment[] = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const entry = item as Record<string, unknown>;
    const fileId = str(entry.fileId).trim();
    if (!fileId) continue;
    out.push({
      fileId, name: str(entry.name).trim() || 'attachment',
      ...(str(entry.mime) ? { mime: str(entry.mime) } : {}),
      ...(typeof entry.size === 'number' ? { size: entry.size } : {}),
    });
  }
  return out;
}

/**
 * The hand-off worker. It runs in the Nest API process under a single-worker lease, reads each linked
 * source chat's completed turns over HTTP with the service token, and posts each hand-off as the stopped
 * Switchyard agent. A delivery row is claimed before posting and every post carries the key
 * `nest:handoff:<linkId>:<turnId>`, so a retry after a crash, a lost response or an outage returns the
 * event the engine already stored. Errors are caught per link and per step, and logged by name only.
 */
export function createHandoffWorker({ store, orgops, token, switchyard, summarize, now = Date.now, holder = randomUUID(), log = line => console.warn(line) }: {
  store: ProductDb; orgops: OrgOpsClient; token: string | undefined; switchyard: Switchyard; summarize: Summarize;
  now?: () => number; holder?: string; log?: (line: string) => void;
}) {
  const flows = store.flows;

  /** Engine records read at most once per tick or action: chats (archived included) and people. */
  function snapshot(service: ServiceClient) {
    let channels: Promise<Map<string, EngineChannel>> | null = null;
    let humans: Promise<Map<string, Actor>> | null = null;
    return {
      service,
      channels: () => (channels ??= service.channels().then(list => new Map(list.map(ch => [ch.id, ch])))),
      humans: () => (humans ??= service.humans().then(list => new Map(list.map(h => [h.id, { id: h.id, username: h.username }])))),
    };
  }
  type Snapshot = ReturnType<typeof snapshot>;

  /** Why a link may not deliver now, by the rule link creation uses (S9); null when it may. */
  async function blocked(link: Link, ctx: Snapshot): Promise<Reason | null> {
    const channels = await ctx.channels();
    const from = channels.get(link.from), to = channels.get(link.to);
    if (!from || !to) return 'unavailable';
    const creator = (await ctx.humans()).get(link.createdBy);
    if (!creator || !channelAccess(from, creator).read || !channelAccess(to, creator).post) return 'access';
    if (link.who && !to.participants.some(p => p.subscriberType === 'AGENT' && p.subscriberId === link.who)) return 'agent-left';
    return null;
  }

  function pause(link: Link, reason: Reason) {
    flows.pause(link.id, reason, 'system');
    log(`[flows] link ${link.id} paused: ${reason}`);
  }

  /** The link as stored now; a paused or removed link never delivers (409). */
  function requireOn(linkId: string): Link {
    const link = flows.link(linkId);
    if (!link) throw new FlowActionError(409, 'This hand-off was disconnected');
    if (!link.on) throw new FlowActionError(409, link.pausedReason ? `Hand-off paused · ${pausedWhy(link.pausedReason, link.who)}` : 'This hand-off is paused');
    return link;
  }

  /** The full payload of an event the list answered without one (over the engine's page budget). */
  async function full(service: ServiceClient, event: EngineEvent): Promise<EngineEvent> {
    if (!event.payloadTruncated) return event;
    return (await service.event(event.id)) ?? event;
  }

  /**
   * What a completed turn produced, or null when it produced nothing to hand off: a turn by the service
   * agent or not by an agent, a `noReply` turn, or a turn without messages. Results are the agent's
   * `message.created` events in that chat after the matching `agent.turn.started` (same trigger), up to
   * the completed event. Without a started event the trigger event is the lower bound.
   */
  async function resultsOf(service: ServiceClient, turn: EngineEvent): Promise<Results | null> {
    if (!turn.source.startsWith('agent:') || !turn.channelId) return null;
    const agent = author(turn.source);
    if (agent === switchyard.name || turn.payload?.noReply === true) return null;
    const trigger = str(turn.payload?.triggerEventId);
    const starts = await service.events({ channelId: turn.channelId, type: 'agent.turn.started', source: turn.source, before: String(turn.createdAt), order: 'desc', limit: '50' });
    let from = trigger ? starts.find(e => str(e.payload?.triggerEventId) === trigger)?.createdAt : undefined;
    if (from === undefined && trigger) from = (await service.event(trigger))?.createdAt;
    if (from === undefined) return null;
    const listed = await service.events({ channelId: turn.channelId, type: 'message.created', source: turn.source, after: String(from), before: String(turn.createdAt), order: 'asc', limit: '200' });
    const messages: Results['messages'] = [];
    for (const listedEvent of listed) {
      // Never the service agent's own posts, whatever the filter returned.
      if (listedEvent.source === `agent:${switchyard.name}`) continue;
      const event = await full(service, listedEvent);
      messages.push({ text: str(event.payload?.text), attachments: attachmentsOf(event.payload) });
    }
    return messages.length ? { agent, messages } : null;
  }

  /** The whole conversation up to the turn: up to 1,000 messages and 2 MiB, newest kept. */
  async function transcript(service: ServiceClient, channelId: string, upTo: number): Promise<Uint8Array> {
    const newest = await service.events({ channelId, type: 'message.created', before: String(upTo + 1), order: 'desc', limit: String(TRANSCRIPT_MESSAGES) });
    const encoder = new TextEncoder();
    const entries: Uint8Array[] = [];
    let refetched = 0, total = 0;
    for (const listed of newest) {
      let event = listed;
      if (event.payloadTruncated && refetched < TRANSCRIPT_REFETCH) { refetched++; event = await full(service, event); }
      const text = event.payloadTruncated ? '(This message is too large to include.)' : str(event.payload?.text);
      const entry = encoder.encode(`**${author(event.source)}** · ${new Date(event.createdAt).toISOString()}\n${text}\n\n`);
      if (total + entry.length > TRANSCRIPT_BYTES) break;
      total += entry.length;
      entries.push(entry);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const entry of entries.reverse()) { bytes.set(entry, offset); offset += entry.length; }
    return bytes;
  }

  /** Posts the hand-off for one turn into the target chat, as the service agent. */
  async function post(link: Link, turn: EngineEvent, results: Results, ctx: Snapshot): Promise<EngineEvent> {
    const channels = await ctx.channels();
    const title = store.projects.byChannels([link.from]).get(link.from)?.name ?? channels.get(link.from)?.name ?? 'another chat';
    const creator = (await ctx.humans()).get(link.createdBy)?.username ?? 'someone';
    let body: string;
    let attachments: Attachment[] = [];
    if (link.what === 'summary') {
      body = (await summarize({ texts: results.messages.map(m => m.text).filter(Boolean), purpose: 'handoff', actor: link.createdBy, ref: { linkId: link.id } })).text;
    } else if (link.what === 'all') {
      const bytes = await transcript(ctx.service, link.from, turn.createdAt);
      const name = `Transcript - ${title}.md`;
      const { fileId } = await ctx.service.upload(name, bytes, 'text/markdown');
      body = 'The whole conversation is attached.';
      attachments = [{ fileId, name, mime: 'text/markdown', size: bytes.length }];
    } else {
      body = results.messages.map(m => m.text.slice(0, RESULT_CHARS)).filter(Boolean).join('\n\n').slice(0, HANDOFF_CHARS);
      attachments = results.messages.flatMap(m => m.attachments).slice(0, MAX_ATTACHMENTS);
    }
    // Checked last, after the summary or transcript: a link paused meanwhile posts nothing.
    requireOn(link.id);
    return switchyard.post({
      channelId: link.to, text: `Hand-off from ${title} · set up by ${creator}\n\n${body}`, target: link.who,
      kind: 'handoff', setBy: link.createdBy, idempotencyKey: `nest:handoff:${link.id}:${turn.id}`,
      ...(attachments.length ? { attachments } : {}),
      meta: { linkId: link.id, sourceChannelId: link.from, sourceTurnId: turn.id },
    });
  }

  async function deliver(link: Link, delivery: Delivery, turn: EngineEvent, results: Results, ctx: Snapshot, at: number) {
    const event = await post(link, turn, results, ctx);
    flows.finishDelivery(delivery.id, { status: 'delivered', targetEventId: event.id }, at);
  }

  /** The service client, once the service agent is usable; null otherwise. */
  async function serviceOrNull(): Promise<ServiceClient | null> {
    try {
      const state = await switchyard.ensure();
      return state.ok && token ? orgops.service(token) : null;
    } catch (error) {
      log(`[flows] the service agent check failed: ${describe(error)}`);
      return null;
    }
  }

  /** Expired claims: a crash or a lost response. The same key makes the engine return the stored event. */
  async function retryExpired(ctx: Snapshot, at: number) {
    for (const expired of flows.leaseExpired(at)) {
      let attempts = expired.attempts;
      try {
        const link = flows.link(expired.linkId);
        // A paused link holds its claim until it is resumed; it never delivers while paused.
        if (!link || !link.on) continue;
        const reason = await blocked(link, ctx);
        if (reason) { pause(link, reason); continue; }
        const taken = flows.reclaim(expired.id, 'claimed', at, LEASE_MS);
        if (!taken) continue;
        attempts = taken.attempts;
        const turn = await ctx.service.event(expired.sourceTurnId);
        const results = turn && await resultsOf(ctx.service, turn);
        if (!turn || !results) {
          flows.finishDelivery(taken.id, { status: 'failed' }, at);
          log(`[flows] delivery ${taken.id} failed: the finished turn is gone`);
          continue;
        }
        await deliver(link, taken, turn, results, ctx, at);
      } catch (error) {
        log(`[flows] retrying delivery ${expired.id} failed: ${describe(error)}`);
        if (attempts >= MAX_ATTEMPTS && !isEngineOutage(error)) flows.finishDelivery(expired.id, { status: 'failed' }, at);
      }
    }
  }

  /** One turn for one link. 'stop' ends this link's scan for the tick without moving its cursor further. */
  async function handle(linkId: string, turn: EngineEvent, results: Results | null, ctx: Snapshot, at: number): Promise<'next' | 'stop'> {
    const link = flows.link(linkId);
    if (!link || !link.on || link.when === 'manual') return 'stop';
    if (!results) { flows.advance(link.id, turn.createdAt); return 'next'; }
    const reason = await blocked(link, ctx);
    if (reason) { pause(link, reason); return 'stop'; }
    if (flows.deliveredSince(link.id, at - HOUR_MS) >= LINK_HOURLY_CAP) { pause(link, 'cap'); return 'stop'; }
    // Paused by a person while the checks above ran: claim nothing.
    if (!flows.link(link.id)?.on) return 'stop';
    const claimed = flows.claimDelivery(link.id, turn.id, link.when === 'approve' ? 'awaiting' : 'claimed', at);
    let outcome: 'next' | 'stop' = 'next';
    if (claimed?.status === 'claimed') {
      try {
        await deliver(link, claimed, turn, results, ctx, at);
      } catch (error) {
        // The claim stands: it is retried once its lease expires, with the same key.
        log(`[flows] hand-off ${claimed.id} failed: ${describe(error)}`);
        outcome = 'stop';
      }
    }
    // Every turn up to here has a delivery row (or produced nothing), so the cursor may pass it.
    flows.advance(link.id, turn.createdAt);
    return outcome;
  }

  async function scan(channelId: string, links: Link[], ctx: Snapshot, at: number) {
    const cursor = new Map(links.map(l => [l.id, flows.scannedTo(l.id)]));
    const open = new Set(cursor.keys());
    let after = Math.min(...cursor.values());
    for (let page = 0; page < MAX_PAGES && open.size; page++) {
      const turns = await ctx.service.events({ channelId, type: 'agent.turn.completed', after: String(after), order: 'asc', limit: String(PAGE) });
      for (const turn of turns) {
        const due = [...open].filter(id => turn.createdAt > cursor.get(id)!);
        if (!due.length) continue;
        // A failed read stops the whole source: no cursor may pass a turn that was not looked at.
        const results = await resultsOf(ctx.service, turn);
        for (const id of due) {
          try {
            if ((await handle(id, turn, results, ctx, at)) === 'stop') open.delete(id);
          } catch (error) {
            log(`[flows] link ${id} skipped this tick: ${describe(error)}`);
            open.delete(id);
          }
        }
      }
      if (turns.length < PAGE) break;
      after = turns[turns.length - 1].createdAt;
    }
  }

  async function run() {
    const at = now();
    if (!holdFlowsLease(store, holder, at)) return;
    const service = await serviceOrNull();
    if (!service) return;
    const ctx = snapshot(service);
    try { await switchyard.drain(); } catch (error) { log(`[flows] draining Switchyard's receipts failed: ${describe(error)}`); }
    try { await retryExpired(ctx, at); } catch (error) { log(`[flows] retrying hand-offs failed: ${describe(error)}`); }
    for (const { channelId, links } of flows.activeSources()) {
      try { await scan(channelId, links, ctx, at); } catch (error) { log(`[flows] scanning a source chat failed: ${describe(error)}`); }
    }
  }

  // One tick at a time; a tick asked for while one runs runs once after it.
  let current: Promise<void> | null = null;
  let queued: Promise<void> | null = null;
  function tick(): Promise<void> {
    if (!current) {
      current = run().catch(error => log(`[flows] tick failed: ${describe(error)}`)).finally(() => { current = null; });
      return current;
    }
    queued ??= current.then(() => { queued = null; return tick(); });
    return queued;
  }

  const wakes = new Map<string, ReturnType<typeof setTimeout>>();
  /** A turn completed in `channelId`: scan soon if it feeds a link. Debounced to 500 ms per source. */
  function wake(channelId: string) {
    if (wakes.has(channelId)) return;
    if (!flows.activeSources().some(s => s.channelId === channelId)) return;
    const timer = setTimeout(() => { wakes.delete(channelId); void tick(); }, WAKE_MS);
    timer.unref?.();
    wakes.set(channelId, timer);
  }

  async function usableService(): Promise<Snapshot> {
    const service = await serviceOrNull();
    if (!service) throw new FlowActionError(503, 'Hand-offs are not set up on this server');
    return snapshot(service);
  }
  /** The worker's checks for a person's action; `cap` also applies the hourly cap (Send now, not an approval). */
  async function refuseIfBlocked(link: Link, ctx: Snapshot, at: number, cap: boolean) {
    const reason = await blocked(link, ctx) ?? (cap && flows.deliveredSince(link.id, at - HOUR_MS) >= LINK_HOURLY_CAP ? 'cap' : null);
    if (!reason) return;
    pause(link, reason);
    throw new FlowActionError(409, `Hand-off paused · ${pausedWhy(reason, link.who)}`);
  }

  /**
   * Send now: hands off the newest finished turn with results, unless this link already has it.
   * For the creator or a member of the receiving chat.
   */
  async function deliverNow(linkId: string, actor: Actor): Promise<'sent' | 'nothing'> {
    if (!flows.link(linkId)) throw new FlowActionError(404, 'Not found');
    const link = requireOn(linkId);
    const ctx = await usableService();
    const at = now();
    if (link.createdBy !== actor.id && !channelAccess((await ctx.channels()).get(link.to), actor).member) {
      throw new FlowActionError(403, 'Only the person who set up this hand-off or a member of the receiving chat can send it');
    }
    await refuseIfBlocked(link, ctx, at, true);
    const turns = await ctx.service.events({ channelId: link.from, type: 'agent.turn.completed', order: 'desc', limit: '20' });
    for (const turn of turns) {
      const results = await resultsOf(ctx.service, turn);
      if (!results) continue;
      requireOn(link.id);
      const claimed = flows.claimDelivery(link.id, turn.id, 'claimed', at);
      if (!claimed) return 'nothing';
      await deliver(link, claimed, turn, results, ctx, at);
      return 'sent';
    }
    return 'nothing';
  }

  /**
   * The creator approves or declines a hand-off awaiting their OK. Approve first takes the row
   * (`awaiting` → `claimed`, with a lease), so a decline can no longer settle it; a failed or lost
   * approve post is then finished by the expired-lease retry, with the same key.
   */
  async function decide(deliveryId: string, decision: 'approve' | 'decline', actor: Actor): Promise<void> {
    const delivery = flows.delivery(deliveryId);
    const found = delivery && flows.link(delivery.linkId);
    if (!delivery || !found) throw new FlowActionError(404, 'Not found');
    if (found.createdBy !== actor.id) throw new FlowActionError(403, 'Only the person who set up this hand-off can approve it');
    const decided = () => new FlowActionError(409, 'This hand-off was already decided');
    if (delivery.status !== 'awaiting') throw decided();
    const at = now();
    if (decision === 'decline') {
      if (!flows.finishDelivery(delivery.id, { status: 'declined' }, at, ['awaiting'])) throw decided();
      return;
    }
    requireOn(found.id);
    const ctx = await usableService();
    await refuseIfBlocked(found, ctx, at, false);
    const link = requireOn(found.id);
    const taken = flows.reclaim(delivery.id, 'claimed', at, LEASE_MS);
    if (!taken) throw decided();
    const turn = await ctx.service.event(delivery.sourceTurnId);
    const results = turn && await resultsOf(ctx.service, turn);
    if (!turn || !results) {
      flows.finishDelivery(taken.id, { status: 'failed' }, at);
      throw new FlowActionError(409, 'The finished work is no longer available');
    }
    await deliver(link, taken, turn, results, ctx, at);
  }

  /**
   * The newest finished turn's engine time in a chat, where a resumed link's scan restarts: 0 when the
   * chat has none, undefined when the engine cannot be asked (the store then uses its clock).
   */
  async function newestTurnAt(channelId: string): Promise<number | undefined> {
    try {
      const service = await serviceOrNull();
      if (!service) return undefined;
      return (await service.events({ channelId, type: 'agent.turn.completed', order: 'desc', limit: '1' }))[0]?.createdAt ?? 0;
    } catch (error) {
      log(`[flows] reading the newest turn failed: ${describe(error)}`);
      return undefined;
    }
  }

  return { tick, wake, deliverNow, decide, newestTurnAt };
}
export type HandoffWorker = ReturnType<typeof createHandoffWorker>;
