import { describe, expect, it } from 'vitest';
import { ContextNotesSchema, ContextWebLinkSchema, homeAfterMove, MAX_NOTES_CHARS, normalizeWebUrl } from './canvas-context';

describe('context schemas', () => {
  it('rejects notes over the limit', () => {
    expect(ContextNotesSchema.safeParse({ notes: 'a'.repeat(MAX_NOTES_CHARS), version: 0 }).success).toBe(true);
    expect(ContextNotesSchema.safeParse({ notes: 'a'.repeat(MAX_NOTES_CHARS + 1), version: 0 }).success).toBe(false);
  });
  it('moves a chat home only for its members, and only on the home canvas', () => {
    expect(homeAfterMove(null, { canvasId: 'c1', areaId: 'a1', byMember: true, placement: true })).toEqual({ canvasId: 'c1', areaId: 'a1' });
    expect(homeAfterMove({ canvasId: 'c1', areaId: 'a1' }, { canvasId: 'c1', areaId: null, byMember: true, placement: false })).toEqual({ canvasId: 'c1', areaId: null });
    expect(homeAfterMove({ canvasId: 'c1', areaId: 'a1' }, { canvasId: 'c1', areaId: 'a2', byMember: false, placement: false })).toBeNull();
    expect(homeAfterMove({ canvasId: 'c1', areaId: 'a1' }, { canvasId: 'c2', areaId: 'a2', byMember: true, placement: false })).toBeNull();
    expect(homeAfterMove({ canvasId: 'c1', areaId: 'a1' }, { canvasId: 'c2', areaId: 'a2', byMember: true, placement: true })).toBeNull();
    expect(homeAfterMove(null, { canvasId: 'c1', areaId: 'a1', byMember: false, placement: true })).toBeNull();
  });
  it('creates a first home only on a placement, never on a move (R19)', () => {
    expect(homeAfterMove(null, { canvasId: 'c1', areaId: 'a1', byMember: true, placement: false })).toBeNull();
    expect(homeAfterMove(null, { canvasId: 'c1', areaId: null, byMember: true, placement: false })).toBeNull();
  });
});

describe('web links', () => {
  it('normalizes http(s) urls and rejects everything else', () => {
    expect(normalizeWebUrl('HTTPS://Example.com')).toBe('https://example.com/');
    for (const bad of ['javascript:alert(1)', 'data:text/html,x', 'ftp://x', 'not a url', `https://e.com/${'a'.repeat(2049)}`]) expect(normalizeWebUrl(bad)).toBeNull();
  });
  it('validates a link body strictly', () => {
    expect(ContextWebLinkSchema.safeParse({ url: 'https://a.example', title: '  Hi  ' })).toMatchObject({ success: true, data: { title: 'Hi' } });
    expect(ContextWebLinkSchema.safeParse({ url: 'ftp://a.example' }).success).toBe(false);
    expect(ContextWebLinkSchema.safeParse({ url: 'https://a.example', extra: 1 }).success).toBe(false);
    expect(ContextWebLinkSchema.safeParse({ url: 'https://a.example', title: 'x'.repeat(201) }).success).toBe(false);
  });
});
