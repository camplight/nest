import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { CanvasConflictError, CanvasLimitError, openProductDb } from './index';

let dir: string;
let store: ReturnType<typeof openProductDb>;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'nest-flows-')); store = openProductDb(join(dir, 'product.sqlite')); });
afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
const mk = (from: string, to: string, extra: Record<string, unknown> = {}) =>
  store.flows.createLink({ id: randomUUID(), from, to, kind: 'link', createdBy: 'u', now: 1000, ...extra });

describe('flow store', () => {
  it('applies the 014_links_forks migration', () => {
    const names = (store.db.prepare('SELECT name FROM product_migrations').all() as { name: string }[]).map(r => r.name);
    expect(names).toContain('014_links_forks');
  });
  it('returns the existing link for the same pair, and is idempotent by id', () => {
    const a = mk('a', 'b');
    expect(mk('a', 'b').id).toBe(a.id);
    expect(store.flows.createLink({ id: a.id, from: 'a', to: 'b', kind: 'link', createdBy: 'u', now: 5 })).toEqual(a);
    expect(() => store.flows.createLink({ id: a.id, from: 'a', to: 'c', kind: 'link', createdBy: 'u', now: 5 })).toThrow(CanvasConflictError);
  });
  it('starts the scan at scannedTo when given, else at now', () => {
    expect(store.flows.scannedTo(mk('a', 'b').id)).toBe(1000);
    const l = mk('c', 'd', { scannedTo: 400 });
    expect(store.flows.scannedTo(l.id)).toBe(400);
    expect(l.createdAt).toBe(1000);
  });
  it('caps links per chat at 50', () => {
    for (let i = 0; i < 50; i++) mk('hub', `t${i}`);
    expect(() => mk('hub', 'extra')).toThrow(CanvasLimitError);
    expect(() => mk('x', 'hub')).toThrow(CanvasLimitError);
  });
  it('claims a turn once', () => {
    const l = mk('a', 'b');
    expect(store.flows.claimDelivery(l.id, 't1', 'claimed', 1000)).not.toBeNull();
    expect(store.flows.claimDelivery(l.id, 't1', 'claimed', 1000)).toBeNull();
  });
  it('patches with compare-and-swap and resets the scan point on resume', () => {
    const l = mk('a', 'b');
    store.flows.pause(l.id, 'cap', 'u');
    const paused = store.flows.link(l.id)!;
    expect(paused).toMatchObject({ on: false, pausedReason: 'cap' });
    expect(() => store.flows.patchLink(l.id, { label: 'x' }, l.version, 'u')).toThrow(CanvasConflictError);
    const resumed = store.flows.patchLink(l.id, { on: true }, paused.version, 'u');
    expect(resumed).toMatchObject({ on: true, pausedReason: null });
    expect(store.flows.scannedTo(l.id)).toBeGreaterThan(1000);
    store.flows.advance(l.id, 5);
    expect(store.flows.scannedTo(l.id)).toBeGreaterThan(5);
  });
  it('cascades deliveries when a link is removed and lists active sources', () => {
    const l = mk('a', 'b'); mk('c', 'd', { when: 'manual' });
    expect(store.flows.activeSources().map(s => s.channelId)).toEqual(['a']);
    store.flows.claimDelivery(l.id, 't1', 'awaiting', 1);
    expect(store.flows.awaiting('u')).toHaveLength(1);
    store.flows.removeLink(l.id, 'u');
    expect(store.db.prepare('SELECT COUNT(*) n FROM product_link_deliveries').get()).toEqual({ n: 0 });
  });
  it('finishes deliveries, expires leases and counts delivered', () => {
    const l = mk('a', 'b');
    const d = store.flows.claimDelivery(l.id, 't1', 'claimed', 1000)!;
    expect(store.flows.leaseExpired(1000)).toEqual([]);
    expect(store.flows.leaseExpired(1000 + 60_001).map(x => x.id)).toEqual([d.id]);
    store.flows.finishDelivery(d.id, { status: 'delivered', targetEventId: 'e1' });
    expect(store.flows.delivery(d.id)).toMatchObject({ status: 'delivered', targetEventId: 'e1' });
    expect(store.flows.deliveredSince(l.id, 0)).toBe(1);
  });
  it('stamps a finished delivery with the given time, which the hourly count uses', () => {
    const l = mk('a', 'b');
    const d = store.flows.claimDelivery(l.id, 't1', 'claimed', 1000)!;
    expect(store.flows.finishDelivery(d.id, { status: 'delivered', targetEventId: 'e1' }, 5000)).toBe(true);
    expect(store.flows.delivery(d.id)).toMatchObject({ updatedAt: 5000 });
    expect(store.flows.deliveredSince(l.id, 5000)).toBe(1);
    expect(store.flows.deliveredSince(l.id, 5001)).toBe(0);
  });
  it('lists the creator\'s links paused with a reason', () => {
    const paused = mk('a', 'b');
    const byHand = mk('a', 'c');
    mk('a', 'd');
    const other = store.flows.createLink({ id: randomUUID(), from: 'x', to: 'y', kind: 'link', createdBy: 'v', now: 1000 });
    store.flows.pause(paused.id, 'cap', 'system');
    store.flows.pause(other.id, 'access', 'system');
    store.flows.patchLink(byHand.id, { on: false }, 0, 'u');
    expect(store.flows.pausedLinks('u')).toEqual([expect.objectContaining({ id: paused.id, pausedReason: 'cap', on: false, pausedAt: expect.any(Number) })]);
    expect(store.flows.pausedLinks('v').map(l => l.id)).toEqual([other.id]);
  });
  it('refuses to finish a terminal delivery', () => {
    const l = mk('a', 'b');
    const d = store.flows.claimDelivery(l.id, 't1', 'claimed', 1000)!;
    expect(store.flows.finishDelivery(d.id, { status: 'delivered', targetEventId: 'e1' })).toBe(true);
    expect(store.flows.finishDelivery(d.id, { status: 'failed' })).toBe(false);
    expect(store.flows.delivery(d.id)).toMatchObject({ status: 'delivered', targetEventId: 'e1', leaseUntil: null });
  });
  it('reclaims an expired claim once and moves awaiting to claimed', () => {
    const l = mk('a', 'b');
    const d = store.flows.claimDelivery(l.id, 't1', 'claimed', 1000)!;
    expect(store.flows.reclaim(d.id, 'claimed', 1000, 500)).toBeNull();
    const won = store.flows.reclaim(d.id, 'claimed', 70_000, 500);
    expect(won).toMatchObject({ status: 'claimed', attempts: 2, leaseUntil: 70_500 });
    expect(store.flows.reclaim(d.id, 'claimed', 70_000, 500)).toBeNull();
    const a = store.flows.claimDelivery(l.id, 't2', 'awaiting', 1000)!;
    expect(store.flows.reclaim(a.id, 'claimed', 2000, 500)).toMatchObject({ status: 'claimed', attempts: 2, leaseUntil: 2500 });
    expect(store.flows.reclaim(a.id, 'claimed', 2000, 500)).toBeNull();
  });
  it('records forks once per child and nulls the link on removal', () => {
    const l = mk('p', 'c', { kind: 'fork' });
    const f = { childChannelId: 'c', parentChannelId: 'p', parentEventId: 'e', linkId: l.id, createdBy: 'u' };
    store.flows.recordFork(f); store.flows.recordFork(f);
    expect(store.flows.forkOf(['c', 'zz'])).toHaveLength(1);
    expect(store.flows.forksOf('p')).toHaveLength(1);
    store.flows.removeLink(l.id, 'u');
    expect(store.flows.forkOf(['c'])[0].linkId).toBeNull();
  });
  it('holds a lease for one holder until it expires', () => {
    expect(store.flows.lease('w', 'A', 1000, 0)).toBe(true);
    expect(store.flows.lease('w', 'B', 1000, 500)).toBe(false);
    expect(store.flows.lease('w', 'A', 1000, 500)).toBe(true);
    expect(store.flows.lease('w', 'B', 1000, 1500)).toBe(true);
  });
  it('audits ids only', () => {
    mk('a', 'b');
    expect(store.db.prepare("SELECT type FROM product_audit WHERE type LIKE 'audit.flows.%'").all()).toEqual([{ type: 'audit.flows.link-created' }]);
  });
});
