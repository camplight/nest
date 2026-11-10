import { describe, expect, it } from 'vitest';
import { ContextNotesSchema, homeAfterMove, MAX_NOTES_CHARS } from './canvas-context';

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
