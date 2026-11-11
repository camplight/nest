import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openProductDb, type ProductDb } from '@nest/db';
import { createSummarizer } from './summarize';

describe('summaries', () => {
  let dir: string, store: ProductDb;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'nest-sum-')); store = openProductDb(join(dir, 'p.sqlite')); });
  afterEach(() => { store.db.close(); rmSync(dir, { recursive: true, force: true }); });
  const audits = () => store.db.prepare("SELECT actor_id AS actorId, payload_json AS payload FROM product_audit WHERE type='audit.flows.summary'").all() as { actorId: string; payload: string }[];
  const model = async () => ({ model: 'openrouter:m/x', env: { OPENROUTER_API_KEY: 'k' } });

  it('labels a model summary and audits it to the creator', async () => {
    let seen: any;
    const s = createSummarizer({ store, model, generate: async (m, msgs, o) => { seen = { m, msgs, o }; return { text: ' done ', usage: { inputTokens: 5, outputTokens: 2 } }; } });
    const r = await s({ texts: ['a', 'b'], purpose: 'handoff', actor: 'u1', ref: { linkId: 'l1' } });
    expect(r).toEqual({ text: 'Summary (by openrouter:m/x):\ndone', model: 'openrouter:m/x' });
    expect(seen.o.maxTokens).toBe(400);
    expect(seen.msgs[0].content).toMatch(/^Summarise what this chat produced in at most 5 short lines/);
    expect(seen.msgs[1].content).toBe('a\n\nb');
    const rows = audits();
    expect(rows).toHaveLength(1);
    expect(rows[0].actorId).toBe('u1');
    expect(JSON.parse(rows[0].payload)).toEqual({ purpose: 'handoff', linkId: 'l1', model: 'openrouter:m/x', inputTokens: 5, outputTokens: 2 });
  });
  it('falls back to the last result, cut to 1,200 characters, when no model is set', async () => {
    const s = createSummarizer({ store, model: async () => null, generate: async () => { throw new Error('unused'); } });
    const r = await s({ texts: ['first', 'x'.repeat(3000)], purpose: 'fork', actor: 'u1', ref: { forkId: 'f' } });
    expect(r.model).toBeNull();
    expect(r.text).toBe(`Summary unavailable. The latest result, shortened:\n${'x'.repeat(1200)}`);
    expect(audits()).toEqual([]);
  });
  it('falls back when the model throws or times out', async () => {
    const s = createSummarizer({ store, model, generate: async () => { throw new Error('sk-secret timeout'); } });
    const r = await s({ texts: ['hello'], purpose: 'handoff', actor: 'u1', ref: {} });
    expect(r).toEqual({ text: 'Summary unavailable. The latest result, shortened:\nhello', model: null });
    expect(JSON.stringify(r)).not.toContain('sk-secret');
    expect(audits()).toEqual([]);
  });
  it('keeps only the last 12,000 characters of input', async () => {
    let content = '';
    const s = createSummarizer({ store, model, generate: async (_m, msgs) => { content = msgs[1].content; return { text: 'ok' }; } });
    await s({ texts: ['A'.repeat(20_000), 'tail'], purpose: 'handoff', actor: 'u', ref: {} });
    expect(content).toHaveLength(12_000);
    expect(content.endsWith('tail')).toBe(true);
    expect(content).not.toContain('B');
  });
});
