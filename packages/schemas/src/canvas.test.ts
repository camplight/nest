import { describe, expect, it } from 'vitest';
import { areaFor, CanvasSharingSchema, PlaceCardsSchema, type CanvasArea } from './canvas';

const area = (id: string, x: number, y: number, w: number, h: number): CanvasArea => ({ id, canvasId: 'c', title: id, x, y, w, h, tint: 'moss', version: 0 });

describe('areaFor', () => {
  it('returns the inner of two nested areas', () => {
    expect(areaFor({ x: 150, y: 150 }, [area('outer', 0, 0, 1000, 1000), area('inner', 100, 100, 200, 200)])?.id).toBe('inner');
  });
  it('returns null outside every area', () => {
    expect(areaFor({ x: 5000, y: 5000 }, [area('a', 0, 0, 1000, 1000)])).toBeNull();
  });
  it('breaks equal sizes by lowest id', () => {
    expect(areaFor({ x: 10, y: 10 }, [area('b', 0, 0, 200, 200), area('a', 0, 0, 200, 200)])?.id).toBe('a');
  });
});

describe('canvas schemas', () => {
  it('rejects 101 cards and a card width of 199', () => {
    const card = { channelId: 'c', x: 0, y: 0, w: 280 };
    expect(PlaceCardsSchema.safeParse({ cards: Array(100).fill(card) }).success).toBe(true);
    expect(PlaceCardsSchema.safeParse({ cards: Array(101).fill(card) }).success).toBe(false);
    expect(PlaceCardsSchema.safeParse({ cards: [{ ...card, w: 199 }] }).success).toBe(false);
  });
  it('defaults card width to 280', () => {
    expect(PlaceCardsSchema.parse({ cards: [{ channelId: 'c', x: 0, y: 0 }] }).cards[0].w).toBe(280);
  });
  it('rejects members on a private canvas', () => {
    const members = [{ humanId: 'h', role: 'view' as const }];
    expect(CanvasSharingSchema.safeParse({ visibility: 'private', members, version: 0 }).success).toBe(false);
    expect(CanvasSharingSchema.safeParse({ visibility: 'shared', members, version: 0 }).success).toBe(true);
  });
});
