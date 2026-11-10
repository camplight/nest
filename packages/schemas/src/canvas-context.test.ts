import { describe, expect, it } from 'vitest';
import { ContextNotesSchema, homeAfterMove, MAX_NOTES_CHARS } from './canvas-context';

describe('context schemas', () => {
  it('rejects notes over the limit', () => {
    expect(ContextNotesSchema.safeParse({ notes: 'a'.repeat(MAX_NOTES_CHARS), version: 0 }).success).toBe(true);
    expect(ContextNotesSchema.safeParse({ notes: 'a'.repeat(MAX_NOTES_CHARS + 1), version: 0 }).success).toBe(false);
  });
  it('moves a chat home only for its members, and only on the home canvas', () => {
    expect(homeAfterMove(null, { canvasId: 'c1', areaId: 'a1', byMember: true })).toEqual({ canvasId: 'c1', areaId: 'a1' });
    expect(homeAfterMove({ canvasId: 'c1', areaId: 'a1' }, { canvasId: 'c1', areaId: null, byMember: true })).toEqual({ canvasId: 'c1', areaId: null });
    expect(homeAfterMove({ canvasId: 'c1', areaId: 'a1' }, { canvasId: 'c1', areaId: 'a2', byMember: false })).toBeNull();
    expect(homeAfterMove({ canvasId: 'c1', areaId: 'a1' }, { canvasId: 'c2', areaId: 'a2', byMember: true })).toBeNull();
    expect(homeAfterMove(null, { canvasId: 'c1', areaId: 'a1', byMember: false })).toBeNull();
  });
});
