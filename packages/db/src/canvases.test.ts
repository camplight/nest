import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { CanvasConflictError, CanvasForbiddenError, CanvasLimitError, openProductDb } from './index';

let dir: string;
let store: ReturnType<typeof openProductDb>;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'nest-canvas-')); store = openProductDb(join(dir, 'product.sqlite')); });
afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });

const mk = (owner = 'owner', name = 'Board') => store.canvases.create({ id: randomUUID(), name }, owner);
const placed = (channelId: string, x = 0, y = 0) => ({ channelId, projectId: null, x, y, w: 280, ownerLabel: 'Ann' });
const newArea = (x: number, y: number, w: number, h: number, id = randomUUID()) => ({ id, title: 'Area', x, y, w, h });
const share = (id: string, members: { humanId: string; role: 'edit' | 'view' }[], version: number) =>
  store.canvases.setSharing(id, { visibility: 'shared', members, version }, 'owner');

describe('canvas store', () => {
  it('lists shared canvases to members, hides private ones, and caps owned canvases at 50', () => {
    const priv = mk(); const shared = mk();
    share(shared.id, [{ humanId: 'viewer', role: 'view' }], shared.version);
    expect(store.canvases.list('viewer').map(c => [c.id, c.role])).toEqual([[shared.id, 'view']]);
    expect(store.canvases.get(priv.id, 'viewer')).toBeNull();
    expect(store.canvases.list('stranger')).toEqual([]);
    for (let i = 2; i < 50; i++) mk();
    expect(() => mk()).toThrow(CanvasLimitError);
    expect(store.canvases.list('owner')).toHaveLength(50);
  });

  it('rejects a stale card move with the winning write as current', () => {
    const c = mk();
    store.canvases.placeCards(c.id, [placed('ch')], undefined, 'owner');
    const won = store.canvases.moveCard(c.id, 'ch', { x: 10, y: 20, version: 0 }, 'owner');
    expect(won.version).toBe(1);
    try { store.canvases.moveCard(c.id, 'ch', { x: 99, y: 99, version: 0 }, 'owner'); expect.unreachable(); }
    catch (e) { expect(e).toBeInstanceOf(CanvasConflictError); expect((e as CanvasConflictError).current).toMatchObject({ x: 10, y: 20 }); }
  });

  it('enforces roles', () => {
    const c = mk();
    store.canvases.placeCards(c.id, [placed('ch')], undefined, 'owner');
    const s = share(c.id, [{ humanId: 'viewer', role: 'view' }, { humanId: 'editor', role: 'edit' }], store.canvases.get(c.id, 'owner')!.version);
    expect(() => store.canvases.moveCard(c.id, 'ch', { x: 1, y: 1, version: 0 }, 'viewer')).toThrow(CanvasForbiddenError);
    expect(() => store.canvases.rename(c.id, 'Nope', s.version, 'editor')).toThrow(CanvasForbiddenError);
    expect(() => store.canvases.remove(c.id, s.version, 'editor')).toThrow(CanvasForbiddenError);
    expect(store.canvases.moveCard(c.id, 'ch', { x: 1, y: 1, version: 0 }, 'editor').x).toBe(1);
    expect(store.canvases.rename(c.id, 'Renamed', store.canvases.get(c.id, 'owner')!.version, 'owner').name).toBe('Renamed');
  });

  it('moves cards in the area and nested areas, but not outside', () => {
    const c = mk();
    const outer = store.canvases.createArea(c.id, newArea(0, 0, 2000, 2000), 'owner');
    const inner = store.canvases.createArea(c.id, newArea(100, 100, 600, 600), 'owner');
    store.canvases.placeCards(c.id, [placed('in-outer', 1000, 1000), placed('in-inner', 200, 200), placed('outside', 5000, 5000)], undefined, 'owner');
    const result = store.canvases.patchArea(c.id, outer.id, { x: 100, y: 50, version: outer.version }, 'owner', { moveCards: true });
    expect(result.area).toMatchObject({ id: outer.id, x: 100, y: 50 });
    expect(result.cards.map(k => k.channelId).sort()).toEqual(['in-inner', 'in-outer']);
    expect(result.areas.map(a => a.id)).toEqual([inner.id]);
    expect(result.areas[0]).toMatchObject({ x: 200, y: 150 });
    const byId = Object.fromEntries(store.canvases.cards(c.id).map(k => [k.channelId, k]));
    expect(byId['in-outer']).toMatchObject({ x: 1100, y: 1050 });
    expect(byId['in-inner']).toMatchObject({ x: 300, y: 250 });
    expect(byId['outside']).toMatchObject({ x: 5000, y: 5000 });
    expect(store.canvases.areas(c.id).find(a => a.id === inner.id)).toMatchObject({ x: 200, y: 150 });
    const o = store.canvases.areas(c.id).find(a => a.id === outer.id)!;
    store.canvases.patchArea(c.id, outer.id, { x: 0, y: 0, version: o.version }, 'owner', { moveCards: false });
    expect(store.canvases.cards(c.id).find(k => k.channelId === 'in-inner')).toMatchObject({ x: 300, y: 250 });
  });

  it('places cards idempotently and caps them at 500', () => {
    const c = mk();
    store.canvases.placeCards(c.id, [placed('a', 1, 1)], undefined, 'owner');
    share(c.id, [{ humanId: 'editor', role: 'edit' }], store.canvases.get(c.id, 'owner')!.version);
    store.canvases.placeCards(c.id, [placed('a', 900, 900)], undefined, 'editor');
    expect(store.canvases.cards(c.id)).toHaveLength(1);
    expect(store.canvases.cards(c.id)[0]).toMatchObject({ x: 1, y: 1, placedBy: 'owner' });
    store.canvases.placeCards(c.id, Array.from({ length: 499 }, (_, i) => placed(`b${i}`)), undefined, 'owner');
    expect(store.canvases.cards(c.id)).toHaveLength(500);
    expect(() => store.canvases.placeCards(c.id, [placed('overflow')], undefined, 'owner')).toThrow(CanvasLimitError);
    expect(() => store.canvases.placeCards(c.id, [placed('a')], undefined, 'owner')).not.toThrow();
  });

  it('creates an area together with placed cards and removes cards and areas by version', () => {
    const c = mk();
    const a = newArea(0, 0, 400, 400);
    store.canvases.placeCards(c.id, [placed('x')], a, 'owner');
    expect(store.canvases.areas(c.id)).toHaveLength(1);
    expect(() => store.canvases.removeCard(c.id, 'x', 5, 'owner')).toThrow(CanvasConflictError);
    store.canvases.removeCard(c.id, 'x', 0, 'owner');
    store.canvases.removeArea(c.id, a.id, 0, 'owner');
    expect(store.canvases.cards(c.id)).toEqual([]);
    expect(store.canvases.areas(c.id)).toEqual([]);
  });

  it('cascades on remove and drops members when made private', () => {
    const c = mk();
    store.canvases.createArea(c.id, newArea(0, 0, 400, 400), 'owner');
    store.canvases.placeCards(c.id, [placed('x')], undefined, 'owner');
    const s = share(c.id, [{ humanId: 'viewer', role: 'view' }], store.canvases.get(c.id, 'owner')!.version);
    expect(store.canvases.members(c.id)).toEqual([{ humanId: 'viewer', role: 'view' }]);
    const p = store.canvases.setSharing(c.id, { visibility: 'private', members: [], version: s.version }, 'owner');
    expect(store.canvases.members(c.id)).toEqual([]);
    expect(store.canvases.get(c.id, 'viewer')).toBeNull();
    expect(() => store.canvases.remove(c.id, p.version + 1, 'owner')).toThrow(CanvasConflictError);
    store.canvases.remove(c.id, p.version, 'owner');
    for (const t of ['product_canvases', 'product_canvas_areas', 'product_canvas_cards', 'product_canvas_members'])
      expect(store.db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get()).toEqual({ n: 0 });
    expect(store.db.prepare("SELECT type FROM product_audit WHERE type LIKE 'audit.canvas.%' ORDER BY id DESC LIMIT 1").get()).toEqual({ type: 'audit.canvas.deleted' });
  });

  it('keeps hidden loose chats per human', () => {
    store.canvases.setHidden('a', ['c1', 'c2'], true);
    store.canvases.setHidden('b', ['c1'], true);
    expect(store.canvases.hidden('a')).toEqual(['c1', 'c2']);
    store.canvases.setHidden('a', ['c1'], false);
    expect(store.canvases.hidden('a')).toEqual(['c2']);
    expect(store.canvases.hidden('b')).toEqual(['c1']);
  });

  it('records the latest migration last (012)', () => {
    const names = (store.db.prepare('SELECT name FROM product_migrations').all() as { name: string }[]).map(r => r.name);
    expect(names.at(-1)).toBe('012_canvas_context');
  });
});
