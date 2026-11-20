// Links, deliveries and forks. Ids and settings only; engine chats and events are never mirrored.
import type Database from 'better-sqlite3';
import { MAX_LINKS_PER_CHAT, type Link, type LinkPatch, type LinkWhat, type LinkWhen, type LinkKind, type PausedReason } from '../../schemas/src/flows';
import { CanvasConflictError, CanvasLimitError } from './canvases';

export type Delivery = {
  id: string; linkId: string; sourceTurnId: string;
  status: 'claimed' | 'awaiting' | 'delivered' | 'declined' | 'failed';
  targetEventId: string | null; leaseUntil: number | null; attempts: number; createdAt: number; updatedAt: number;
};
export type Fork = { childChannelId: string; parentChannelId: string; parentEventId: string; linkId: string | null; createdBy: string; createdAt: number };
export type NewLinkRecord = {
  id: string; from: string; to: string; what?: LinkWhat; when?: LinkWhen; who?: string | null; label?: string;
  kind: LinkKind; createdBy: string; now: number;
  /** Where the hand-off scan starts: turns completed at or before it are never handed off. Defaults to `now`. */
  scannedTo?: number;
};

const CLAIM_LEASE_MS = 60_000;

type LinkRow = { id: string; kind: LinkKind; from_channel: string; to_channel: string; what: LinkWhat; when_mode: LinkWhen; who_agent: string | null; label: string; on_flag: number; paused_reason: PausedReason; created_by: string; created_at: number; version: number };
type DeliveryRow = { id: string; link_id: string; source_turn_id: string; status: Delivery['status']; target_event_id: string | null; lease_until: number | null; attempts: number; created_at: number; updated_at: number };
const toLink = (r: LinkRow): Link => ({ id: r.id, kind: r.kind, from: r.from_channel, to: r.to_channel, what: r.what, when: r.when_mode, who: r.who_agent, label: r.label, on: r.on_flag === 1, pausedReason: r.paused_reason, createdBy: r.created_by, createdAt: r.created_at, version: r.version });
const toDelivery = (r: DeliveryRow): Delivery => ({ id: r.id, linkId: r.link_id, sourceTurnId: r.source_turn_id, status: r.status, targetEventId: r.target_event_id, leaseUntil: r.lease_until, attempts: r.attempts, createdAt: r.created_at, updatedAt: r.updated_at });
const LINK_COLS = 'id,kind,from_channel,to_channel,what,when_mode,who_agent,label,on_flag,paused_reason,created_by,created_at,version';

export function createFlowStore(db: Database.Database, clock: () => number = Date.now) {
  function audit(verb: string, actor: string, payload: Record<string, string | number | null>) {
    db.prepare('INSERT INTO product_audit(type,actor_id,payload_json,created_at) VALUES (?,?,?,?)').run(`audit.flows.${verb}`, actor, JSON.stringify(payload), clock());
  }
  const rawLink = (id: string) => db.prepare(`SELECT ${LINK_COLS} FROM product_links WHERE id=?`).get(id) as LinkRow | undefined;
  const link = (id: string): Link | null => { const r = rawLink(id); return r ? toLink(r) : null; };
  const touching = (channelId: string) => (db.prepare('SELECT COUNT(*) n FROM product_links WHERE from_channel=? OR to_channel=?').get(channelId, channelId) as { n: number }).n;

  function createLink(input: NewLinkRecord): Link {
    return db.transaction(() => {
      const want = { from: input.from, to: input.to, what: input.what ?? 'results', when: input.when ?? 'done', who: input.who ?? null, label: input.label ?? 'results', kind: input.kind };
      const same = rawLink(input.id);
      if (same) {
        const l = toLink(same);
        if (l.from === want.from && l.to === want.to && l.what === want.what && l.when === want.when && l.who === want.who && l.label === want.label && l.kind === want.kind) return l;
        throw new CanvasConflictError(null);
      }
      const pair = db.prepare(`SELECT ${LINK_COLS} FROM product_links WHERE kind=? AND from_channel=? AND to_channel=?`).get(input.kind, input.from, input.to) as LinkRow | undefined;
      if (pair) return toLink(pair);
      for (const channel of [input.from, input.to]) {
        if (touching(channel) >= MAX_LINKS_PER_CHAT) throw new CanvasLimitError(`A chat can have at most ${MAX_LINKS_PER_CHAT} links`);
      }
      db.prepare('INSERT INTO product_links(id,kind,from_channel,to_channel,what,when_mode,who_agent,label,on_flag,paused_reason,scanned_to,created_by,created_at,updated_at,version) VALUES (?,?,?,?,?,?,?,?,1,NULL,?,?,?,?,0)')
        .run(input.id, input.kind, input.from, input.to, want.what, want.when, want.who, want.label, input.scannedTo ?? input.now, input.createdBy, input.now, input.now);
      audit('link-created', input.createdBy, { linkId: input.id, kind: input.kind, from: input.from, to: input.to });
      return link(input.id)!;
    })();
  }

  function linksTouching(channelIds: string[]): Link[] {
    if (!channelIds.length) return [];
    const marks = channelIds.map(() => '?').join(',');
    return (db.prepare(`SELECT ${LINK_COLS} FROM product_links WHERE from_channel IN (${marks}) OR to_channel IN (${marks}) ORDER BY created_at, id`).all(...channelIds, ...channelIds) as LinkRow[]).map(toLink);
  }

  function activeSources(): { channelId: string; links: Link[] }[] {
    const rows = (db.prepare(`SELECT ${LINK_COLS} FROM product_links WHERE on_flag=1 AND when_mode!='manual' ORDER BY from_channel, created_at, id`).all() as LinkRow[]).map(toLink);
    const out = new Map<string, Link[]>();
    for (const l of rows) out.set(l.from, [...(out.get(l.from) ?? []), l]);
    return [...out].map(([channelId, links]) => ({ channelId, links }));
  }

  /**
   * `resumeFrom`: on resume, the scan restarts after this engine time (the newest finished turn, so
   * nothing finished while paused is replayed). It never moves the cursor back; without it, the clock.
   */
  function patchLink(id: string, patch: Omit<LinkPatch, 'version'>, version: number, actor: string, resumeFrom?: number): Link {
    return db.transaction(() => {
      const before = rawLink(id);
      if (!before || before.version !== version) throw new CanvasConflictError(null);
      const resume = patch.on === true && before.on_flag === 0;
      const now = clock();
      const scanned = (db.prepare('SELECT scanned_to FROM product_links WHERE id=?').get(id) as { scanned_to: number }).scanned_to;
      db.prepare(`UPDATE product_links SET what=?,when_mode=?,who_agent=?,label=?,on_flag=?,paused_reason=?,scanned_to=?,updated_at=?,version=version+1 WHERE id=? AND version=?`)
        .run(patch.what ?? before.what, patch.when ?? before.when_mode, patch.who === undefined ? before.who_agent : patch.who, patch.label ?? before.label,
          patch.on === undefined ? before.on_flag : patch.on ? 1 : 0,
          patch.on === true ? null : patch.on === false ? before.paused_reason : before.paused_reason,
          resume ? Math.max(resumeFrom ?? now, scanned) : scanned,
          now, id, version);
      audit('link-updated', actor, { linkId: id });
      return link(id)!;
    })();
  }

  function pause(id: string, reason: Exclude<PausedReason, null>, actor: string): void {
    const changed = db.prepare('UPDATE product_links SET on_flag=0,paused_reason=?,updated_at=?,version=version+1 WHERE id=?').run(reason, clock(), id).changes;
    if (changed) audit('link-paused', actor, { linkId: id, reason });
  }

  /**
   * Archive (the person's hide of a chat): their own running links to or from these chats pause with reason
   * `archived`, and hand-offs on them still waiting for their OK are declined. Returns the paused link ids.
   */
  function archiveLinks(createdBy: string, channelIds: string[]): string[] {
    if (!channelIds.length) return [];
    return db.transaction(() => {
      const marks = channelIds.map(() => '?').join(',');
      const ids = (db.prepare(`SELECT id FROM product_links WHERE created_by=? AND on_flag=1 AND (from_channel IN (${marks}) OR to_channel IN (${marks})) ORDER BY created_at, id`)
        .all(createdBy, ...channelIds, ...channelIds) as { id: string }[]).map(r => r.id);
      const now = clock();
      for (const id of ids) {
        db.prepare("UPDATE product_links SET on_flag=0,paused_reason='archived',updated_at=?,version=version+1 WHERE id=?").run(now, id);
        const waiting = db.prepare("SELECT id FROM product_link_deliveries WHERE link_id=? AND status='awaiting'").all(id) as { id: string }[];
        for (const d of waiting) finishDelivery(d.id, { status: 'declined' }, now, ['awaiting']);
        audit('link-paused', createdBy, { linkId: id, reason: 'archived' });
      }
      return ids;
    })();
  }

  /**
   * Unarchive: the person's links to or from these chats that archiving paused turn back on, unless the other
   * end is still archived (`stillArchived`). The scan restarts now, so nothing finished meanwhile is replayed.
   */
  function unarchiveLinks(createdBy: string, channelIds: string[], stillArchived: ReadonlySet<string>): string[] {
    if (!channelIds.length) return [];
    return db.transaction(() => {
      const marks = channelIds.map(() => '?').join(',');
      const rows = db.prepare(`SELECT id,from_channel,to_channel,scanned_to FROM product_links WHERE created_by=? AND on_flag=0 AND paused_reason='archived' AND (from_channel IN (${marks}) OR to_channel IN (${marks})) ORDER BY created_at, id`)
        .all(createdBy, ...channelIds, ...channelIds) as { id: string; from_channel: string; to_channel: string; scanned_to: number }[];
      const now = clock();
      const resumed = rows.filter(r => !stillArchived.has(r.from_channel) && !stillArchived.has(r.to_channel));
      for (const r of resumed) {
        db.prepare('UPDATE product_links SET on_flag=1,paused_reason=NULL,scanned_to=?,updated_at=?,version=version+1 WHERE id=?').run(Math.max(now, r.scanned_to), now, r.id);
        audit('link-updated', createdBy, { linkId: r.id });
      }
      return resumed.map(r => r.id);
    })();
  }

  function removeLink(id: string, actor: string): void {
    db.transaction(() => {
      if (db.prepare('DELETE FROM product_links WHERE id=?').run(id).changes) audit('link-removed', actor, { linkId: id });
    })();
  }

  const scannedTo = (linkId: string): number => (db.prepare('SELECT scanned_to FROM product_links WHERE id=?').get(linkId) as { scanned_to: number } | undefined)?.scanned_to ?? 0;
  const advance = (linkId: string, createdAt: number): void => { db.prepare('UPDATE product_links SET scanned_to=? WHERE id=? AND scanned_to<?').run(createdAt, linkId, createdAt); };

  const rawDelivery = (id: string) => db.prepare('SELECT * FROM product_link_deliveries WHERE id=?').get(id) as DeliveryRow | undefined;
  const delivery = (id: string): Delivery | null => { const r = rawDelivery(id); return r ? toDelivery(r) : null; };

  function claimDelivery(linkId: string, turnId: string, status: 'claimed' | 'awaiting', now: number): Delivery | null {
    return db.transaction(() => {
      const id = crypto.randomUUID();
      const inserted = db.prepare('INSERT OR IGNORE INTO product_link_deliveries(id,link_id,source_turn_id,status,lease_until,attempts,created_at,updated_at) VALUES (?,?,?,?,?,1,?,?)')
        .run(id, linkId, turnId, status, status === 'claimed' ? now + CLAIM_LEASE_MS : null, now, now).changes;
      if (!inserted) return null;
      audit('delivery-claimed', 'system', { deliveryId: id, linkId, status });
      return delivery(id);
    })();
  }

  const leaseExpired = (now: number): Delivery[] =>
    (db.prepare("SELECT * FROM product_link_deliveries WHERE status='claimed' AND lease_until IS NOT NULL AND lease_until<? ORDER BY created_at, id").all(now) as DeliveryRow[]).map(toDelivery);

  /**
   * Settles a delivery that is still open. Returns false when it was already terminal (or missing).
   * `now` stamps `updated_at`, which the hourly cap counts; it defaults to the store clock.
   * `from` narrows which open statuses it settles (a decline settles only `awaiting`, never a claimed approve).
   */
  function finishDelivery(id: string, result: { status: 'delivered' | 'declined' | 'failed'; targetEventId?: string }, now: number = clock(), from: ('claimed' | 'awaiting')[] = ['claimed', 'awaiting']): boolean {
    const open = from.filter(s => s === 'claimed' || s === 'awaiting');
    if (!open.length) return false;
    const changed = db.prepare(`UPDATE product_link_deliveries SET status=?,target_event_id=COALESCE(?,target_event_id),lease_until=NULL,updated_at=? WHERE id=? AND status IN (${open.map(() => '?').join(',')})`)
      .run(result.status, result.targetEventId ?? null, now, id, ...open).changes;
    if (changed) audit('delivery-finished', 'system', { deliveryId: id, status: result.status });
    return changed > 0;
  }

  /** Takes a delivery whose claim expired, or that was awaiting approval, with a fresh lease. Only one caller can win. */
  function reclaim(id: string, status: 'claimed', now: number, leaseMs: number): Delivery | null {
    const changed = db.prepare("UPDATE product_link_deliveries SET status=?,lease_until=?,attempts=attempts+1,updated_at=? WHERE id=? AND ((status='claimed' AND lease_until IS NOT NULL AND lease_until<?) OR status='awaiting')")
      .run(status, now + leaseMs, now, id, now).changes;
    if (!changed) return null;
    audit('delivery-reclaimed', 'system', { deliveryId: id });
    return delivery(id);
  }

  const deliveredSince = (linkId: string, since: number): number =>
    (db.prepare("SELECT COUNT(*) n FROM product_link_deliveries WHERE link_id=? AND status='delivered' AND updated_at>=?").get(linkId, since) as { n: number }).n;

  /**
   * The creator's links that the worker paused (a reason is set), oldest first, with when they last changed.
   * Links paused because the person archived a chat are left out: they did that on purpose.
   */
  const pausedLinks = (createdBy: string): (Link & { pausedAt: number })[] =>
    (db.prepare(`SELECT ${LINK_COLS},updated_at FROM product_links WHERE created_by=? AND on_flag=0 AND paused_reason IS NOT NULL AND paused_reason!='archived' ORDER BY updated_at, id`).all(createdBy) as (LinkRow & { updated_at: number })[])
      .map(r => ({ ...toLink(r), pausedAt: r.updated_at }));

  const awaiting = (createdBy: string): Delivery[] =>
    (db.prepare("SELECT d.* FROM product_link_deliveries d JOIN product_links l ON l.id=d.link_id WHERE d.status='awaiting' AND l.created_by=? ORDER BY d.created_at, d.id").all(createdBy) as DeliveryRow[]).map(toDelivery);

  const toFork = (r: { child_channel: string; parent_channel: string; parent_event_id: string; link_id: string | null; created_by: string; created_at: number }): Fork =>
    ({ childChannelId: r.child_channel, parentChannelId: r.parent_channel, parentEventId: r.parent_event_id, linkId: r.link_id, createdBy: r.created_by, createdAt: r.created_at });

  function recordFork(input: { childChannelId: string; parentChannelId: string; parentEventId: string; linkId: string | null; createdBy: string }): void {
    db.transaction(() => {
      const inserted = db.prepare('INSERT OR IGNORE INTO product_forks(child_channel,parent_channel,parent_event_id,link_id,created_by,created_at) VALUES (?,?,?,?,?,?)')
        .run(input.childChannelId, input.parentChannelId, input.parentEventId, input.linkId, input.createdBy, clock()).changes;
      if (inserted) audit('fork-recorded', input.createdBy, { childChannelId: input.childChannelId, parentChannelId: input.parentChannelId, linkId: input.linkId });
    })();
  }

  function forkOf(childIds: string[]): Fork[] {
    if (!childIds.length) return [];
    return (db.prepare(`SELECT * FROM product_forks WHERE child_channel IN (${childIds.map(() => '?').join(',')})`).all(...childIds) as Parameters<typeof toFork>[0][]).map(toFork);
  }
  const forksOf = (parentChannelId: string): Fork[] =>
    (db.prepare('SELECT * FROM product_forks WHERE parent_channel=? ORDER BY created_at, child_channel').all(parentChannelId) as Parameters<typeof toFork>[0][]).map(toFork);

  /** Single-worker lease: true when `holder` now holds `name` (already its own, or the previous lease expired). */
  function lease(name: string, holder: string, ms: number, now: number): boolean {
    return db.prepare('INSERT INTO product_flow_leases(name,holder,until) VALUES (?,?,?) ON CONFLICT(name) DO UPDATE SET holder=excluded.holder,until=excluded.until WHERE product_flow_leases.holder=excluded.holder OR product_flow_leases.until<=?')
      .run(name, holder, now + ms, now).changes > 0;
  }

  return { createLink, link, linksTouching, activeSources, patchLink, pause, archiveLinks, unarchiveLinks, removeLink, scannedTo, advance, claimDelivery, leaseExpired, finishDelivery, reclaim, deliveredSince, awaiting, pausedLinks, delivery, recordFork, forkOf, forksOf, lease };
}
export type FlowStore = ReturnType<typeof createFlowStore>;
