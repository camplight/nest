import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { CanvasConflictError, CanvasLimitError, openProductDb } from './index';
import { ContextWebLinksFullError } from './canvas-context';
import type { ContextScope } from '../../schemas/src/canvas-context';

let dir: string;
let store: ReturnType<typeof openProductDb>;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'nest-ctx-')); store = openProductDb(join(dir, 'product.sqlite')); });
afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });

const ctx = () => store.canvasContext;
const mkCanvas = () => store.canvases.create({ id: randomUUID(), name: 'Board' }, 'owner');
const mkArea = (canvasId: string) => store.canvases.createArea(canvasId, { id: randomUUID(), title: 'Area', x: 0, y: 0, w: 400, h: 400 }, 'owner');
const areaScope = (canvasId: string, areaId: string): ContextScope => ({ kind: 'area', canvasId, areaId });
const f = (size = 10, key: string = randomUUID()) => ({ id: randomUUID(), name: 'a.txt', mime: 'text/plain', size, storageKey: key });

describe('canvas context store', () => {
  it('saves notes with compare-and-swap and rejects a stale version', () => {
    const c = mkCanvas(); const scope: ContextScope = { kind: 'canvas', canvasId: c.id };
    expect(ctx().get(scope)).toEqual({ notes: '', version: 0, files: [], webLinks: [] });
    expect(ctx().setNotes(scope, 'one', 0, 'owner')).toEqual({ notes: 'one', version: 1 });
    expect(() => ctx().setNotes(scope, 'two', 0, 'owner')).toThrow(CanvasConflictError);
    expect(() => ctx().setNotes(scope, 'two', 5, 'owner')).toThrow(CanvasConflictError);
    expect(ctx().setNotes(scope, 'two', 1, 'owner').version).toBe(2);
    const audits = store.db.prepare("SELECT payload_json FROM product_audit WHERE type='audit.canvas.context.notes.set'").all() as { payload_json: string }[];
    const payloads = audits.map(a => a.payload_json);
    const ids = { canvasId: c.id, scope: 'canvas', scopeId: c.id };
    expect(payloads.map(p => JSON.parse(p))).toEqual([ids, ids]);
    expect(payloads.join()).not.toMatch(/one|two/);
  });

  it('caps files at 50 per scope and 200 MiB per canvas', () => {
    const c = mkCanvas(); const a = mkArea(c.id);
    const scope = areaScope(c.id, a.id);
    for (let i = 0; i < 50; i++) ctx().addFile(scope, f(), 'owner');
    expect(() => ctx().addFile(scope, f(), 'owner')).toThrow(CanvasLimitError);
    const c2 = mkCanvas(); const big: ContextScope = { kind: 'canvas', canvasId: c2.id };
    for (let i = 0; i < 10; i++) ctx().addFile(big, f(20 * 1024 * 1024), 'owner');
    expect(ctx().canvasBytes(c2.id)).toBe(200 * 1024 * 1024);
    expect(() => ctx().addFile(big, f(1), 'owner')).toThrow(CanvasLimitError);
  });

  it('looks up and removes a file, returning its storage key', () => {
    const c = mkCanvas(); const scope: ContextScope = { kind: 'canvas', canvasId: c.id };
    const input = f(5, 'k1'); ctx().addFile(scope, input, 'owner');
    expect(ctx().file(input.id)).toEqual({ canvasId: c.id, scope, storageKey: 'k1', name: 'a.txt', mime: 'text/plain', size: 5 });
    expect(ctx().removeFile(input.id, 'owner')).toEqual({ storageKey: 'k1' });
    expect(ctx().file(input.id)).toBeNull();
  });

  it('links areas idempotently, rejects self-links and an 11th link, and lists users of a source', () => {
    const c = mkCanvas(); const a = mkArea(c.id); const src = mkArea(c.id);
    expect(() => ctx().link(a.id, a.id, 'owner')).toThrow(CanvasLimitError);
    ctx().link(a.id, src.id, 'owner'); ctx().link(a.id, src.id, 'owner');
    expect(ctx().links(a.id)).toHaveLength(1);
    expect(ctx().usedBy(src.id)).toEqual([{ areaId: a.id, canvasId: c.id }]);
    for (let i = 0; i < 9; i++) ctx().link(a.id, mkArea(c.id).id, 'owner');
    expect(() => ctx().link(a.id, mkArea(c.id).id, 'owner')).toThrow(CanvasLimitError);
    ctx().link(a.id, src.id, 'owner');
    ctx().unlink(a.id, src.id, 'owner');
    expect(ctx().links(a.id)).toHaveLength(9);
  });

  it('cascades an area delete: context, files, links both ways, and clears homes', () => {
    const c = mkCanvas(); const a = mkArea(c.id); const b = mkArea(c.id);
    const scope = areaScope(c.id, a.id);
    ctx().setNotes(scope, 'n', 0, 'owner');
    ctx().addFile(scope, f(1, 'ka'), 'owner');
    ctx().link(a.id, b.id, 'owner'); ctx().link(b.id, a.id, 'owner');
    ctx().setHome('ch', { canvasId: c.id, areaId: a.id }, 'owner');
    expect(ctx().storageKeysForArea(a.id)).toEqual(['ka']);
    store.canvases.removeArea(c.id, a.id, a.version, 'owner');
    expect(store.db.prepare('SELECT COUNT(*) AS n FROM product_canvas_context').get()).toEqual({ n: 0 });
    expect(ctx().get(scope)).toEqual({ notes: '', version: 0, files: [], webLinks: [] });
    expect(ctx().storageKeysForArea(a.id)).toEqual([]);
    expect(ctx().links(b.id)).toEqual([]);
    expect(ctx().home('ch')).toEqual({ canvasId: c.id, areaId: null });
  });

  it('cascades a canvas delete including homes, files and keys of its scopes', () => {
    const c = mkCanvas(); const a = mkArea(c.id);
    ctx().setNotes({ kind: 'canvas', canvasId: c.id }, 'n', 0, 'owner');
    ctx().addFile(areaScope(c.id, a.id), f(1, 'ka'), 'owner');
    ctx().setHome('ch', { canvasId: c.id, areaId: a.id }, 'owner');
    expect(ctx().storageKeysFor(c.id)).toEqual(['ka']);
    expect([...ctx().homesIn(c.id).keys()]).toEqual(['ch']);
    store.canvases.remove(c.id, store.canvases.get(c.id, 'owner')!.version, 'owner');
    for (const t of ['product_canvas_context', 'product_canvas_context_files', 'product_chat_home', 'product_area_context_refs'])
      expect(store.db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get()).toEqual({ n: 0 });
    expect(ctx().home('ch')).toBeNull();
  });

  it('updates a home in place', () => {
    const c = mkCanvas();
    ctx().setHome('ch', { canvasId: c.id, areaId: null }, 'owner');
    const a = mkArea(c.id);
    ctx().setHome('ch', { canvasId: c.id, areaId: a.id }, 'owner');
    expect(ctx().homesIn(c.id).get('ch')).toEqual({ canvasId: c.id, areaId: a.id });
    expect(ctx().homeEntry('ch')).toEqual({ canvasId: c.id, areaId: a.id, setBy: 'owner' });
    ctx().setHome('ch', { canvasId: c.id, areaId: a.id }, 'mate');
    expect(ctx().homeEntry('ch')).toEqual({ canvasId: c.id, areaId: a.id, setBy: 'mate' });
    expect(ctx().homeEntry('none')).toBeNull();
  });

  it('round-trips a context key by hash and revokes the previous key on rotation', () => {
    expect(ctx().keyFor('bot')).toBeNull();
    ctx().saveKey('bot', 'hash1');
    expect(ctx().agentForKey('hash1')).toBe('bot');
    expect(ctx().keyFor('bot')).toMatchObject({ id: expect.any(String) });
    ctx().saveKey('bot', 'hash2');
    expect(ctx().agentForKey('hash1')).toBeNull();
    expect(ctx().agentForKey('hash2')).toBe('bot');
    expect(ctx().agentForKey('nope')).toBeNull();
  });

  it('revokes one key by its hash and audits only the agent name', () => {
    ctx().saveKey('bot', 'hash1');
    ctx().revokeKey('hash1');
    ctx().revokeKey('hash1');
    ctx().revokeKey('unknown');
    expect(ctx().agentForKey('hash1')).toBeNull();
    expect(ctx().keyFor('bot')).toBeNull();
    const rows = store.db.prepare("SELECT actor_id, payload_json FROM product_audit WHERE type='audit.canvas.context.key.revoked'").all();
    expect(rows).toEqual([{ actor_id: 'system', payload_json: JSON.stringify({ agentName: 'bot' }) }]);
  });

  it('remembers which agents have the skill enabled', () => {
    expect(ctx().skillEnabled('bot')).toBe(false);
    ctx().markSkillEnabled('bot'); ctx().markSkillEnabled('bot');
    expect(ctx().skillEnabled('bot')).toBe(true);
    const rows = store.db.prepare("SELECT actor_id, payload_json FROM product_audit WHERE type='audit.canvas.context.skill.enabled'").all();
    expect(rows).toEqual([{ actor_id: 'system', payload_json: JSON.stringify({ agentName: 'bot' }) }]);
  });

  describe('web links', () => {
    it('adds and lists web links per scope in added order', () => {
      const c = mkCanvas(); const a = mkArea(c.id); const scope = areaScope(c.id, a.id);
      ctx().addWebLink(scope, { id: randomUUID(), url: 'https://a.example/', title: null }, 'owner');
      ctx().addWebLink(scope, { id: randomUUID(), url: 'https://b.example/', title: 'B' }, 'owner');
      expect(ctx().get(scope).webLinks.map(l => l.url)).toEqual(['https://a.example/', 'https://b.example/']);
      expect(ctx().get(scope).webLinks[1]).toMatchObject({ title: 'B', addedBy: 'owner' });
      expect(ctx().get({ kind: 'canvas', canvasId: c.id }).webLinks).toEqual([]);
    });
    it('a duplicate url returns the existing link', () => {
      const c = mkCanvas(); const scope: ContextScope = { kind: 'canvas', canvasId: c.id };
      const first = ctx().addWebLink(scope, { id: randomUUID(), url: 'https://example.com/', title: null }, 'owner');
      const second = ctx().addWebLink(scope, { id: randomUUID(), url: 'https://example.com/', title: null }, 'owner');
      expect(first.created).toBe(true);
      expect(second.created).toBe(false);
      expect(second.link.id).toBe(first.link.id);
      expect(ctx().get(scope).webLinks).toHaveLength(1);
    });
    it('refuses the 51st link', () => {
      const c = mkCanvas(); const scope: ContextScope = { kind: 'canvas', canvasId: c.id };
      for (let i = 0; i < 50; i++) ctx().addWebLink(scope, { id: randomUUID(), url: `https://example.com/${i}`, title: null }, 'owner');
      expect(() => ctx().addWebLink(scope, { id: randomUUID(), url: 'https://example.com/x', title: null }, 'owner')).toThrow(ContextWebLinksFullError);
    });
    it('removeWebLink deletes it and audits ids only', () => {
      const c = mkCanvas(); const scope: ContextScope = { kind: 'canvas', canvasId: c.id };
      const { link } = ctx().addWebLink(scope, { id: randomUUID(), url: 'https://secret.example/path', title: 'Secret title' }, 'owner');
      expect(ctx().webLink(link.id)).toEqual({ canvasId: c.id, scope });
      expect(ctx().removeWebLink(link.id, 'owner')).toBe(true);
      expect(ctx().removeWebLink(link.id, 'owner')).toBe(false);
      expect(ctx().webLink(link.id)).toBeNull();
      expect(ctx().get(scope).webLinks).toEqual([]);
      const rows = store.db.prepare("SELECT type, payload_json FROM product_audit WHERE type LIKE 'audit.canvas.context.web-link.%'").all() as { type: string; payload_json: string }[];
      expect(rows.map(r => r.type)).toEqual(['audit.canvas.context.web-link.added', 'audit.canvas.context.web-link.removed']);
      for (const r of rows) { expect(r.payload_json).not.toContain('secret.example'); expect(r.payload_json).not.toContain('Secret title'); expect(r.payload_json).toContain(link.id); }
    });
    it('removeArea deletes the area\'s web links', () => {
      const c = mkCanvas(); const a = mkArea(c.id); const scope = areaScope(c.id, a.id);
      ctx().addWebLink(scope, { id: randomUUID(), url: 'https://example.com/', title: null }, 'owner');
      store.canvases.removeArea(c.id, a.id, a.version, 'owner');
      expect(store.db.prepare('SELECT COUNT(*) AS n FROM product_canvas_context_web_links').get()).toEqual({ n: 0 });
    });
  });
});
