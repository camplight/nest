import { z } from 'zod';

export const CanvasRole = z.enum(['owner', 'edit', 'view']);
export type CanvasRole = z.infer<typeof CanvasRole>;
export const CanvasVisibility = z.enum(['private', 'shared']);
export type CanvasVisibility = z.infer<typeof CanvasVisibility>;
export const CanvasTint = z.enum(['moss', 'puff', 'pom', 'pip', 'muff']);
export type CanvasTint = z.infer<typeof CanvasTint>;

/** Assumed rendered card height, used to find a card's centre for area membership. */
export const CARD_HEIGHT = 160;
export const DEFAULT_CARD_WIDTH = 280;
export const MAX_CANVASES_PER_OWNER = 50;
export const MAX_AREAS = 100;
export const MAX_CARDS = 500;
export const MAX_MEMBERS = 30;

const title = z.string().trim().min(1).max(120);
const coord = z.number().finite().min(-1_000_000).max(1_000_000);
const cardWidth = z.number().finite().min(200).max(640);
const areaSize = z.number().finite().min(160).max(20_000);
const version = z.number().int().min(0);
const channelId = z.string().min(1).max(200);

export const NewCanvasSchema = z.object({ id: z.string().uuid(), name: title }).strict();
export const CanvasRenameSchema = z.object({ name: title, version }).strict();
export const CanvasSharingSchema = z.object({
  visibility: CanvasVisibility,
  members: z.array(z.object({ humanId: z.string().min(1).max(200), role: z.enum(['edit', 'view']) }).strict()).max(MAX_MEMBERS),
  version,
}).strict().refine(v => v.visibility === 'shared' || v.members.length === 0, { message: 'Private canvases cannot have members', path: ['members'] });
export const NewAreaSchema = z.object({
  id: z.string().uuid(), title, x: coord, y: coord, w: areaSize, h: areaSize, tint: CanvasTint.optional(),
}).strict();
export const AreaPatchSchema = z.object({
  title: title.optional(), x: coord.optional(), y: coord.optional(), w: areaSize.optional(), h: areaSize.optional(),
  tint: CanvasTint.optional(), version,
}).strict();
export const PlaceCardsSchema = z.object({
  cards: z.array(z.object({ channelId, x: coord, y: coord, w: cardWidth.default(DEFAULT_CARD_WIDTH) }).strict()).min(1).max(100),
  area: NewAreaSchema.optional(),
}).strict();
export const CardPatchSchema = z.object({ x: coord, y: coord, w: cardWidth.optional(), version }).strict();
export const HiddenSchema = z.object({ channelIds: z.array(channelId).min(1).max(100), hidden: z.boolean() }).strict();

export type NewCanvas = z.infer<typeof NewCanvasSchema>;
export type CanvasSharing = z.infer<typeof CanvasSharingSchema>;
export type NewArea = z.infer<typeof NewAreaSchema>;
export type AreaPatch = z.infer<typeof AreaPatchSchema>;
export type PlaceCards = z.infer<typeof PlaceCardsSchema>;
export type CardPatch = z.infer<typeof CardPatchSchema>;

export type Canvas = { id: string; ownerId: string; name: string; visibility: CanvasVisibility; version: number; createdAt: number; updatedAt: number; role: CanvasRole };
export type CanvasArea = { id: string; canvasId: string; title: string; x: number; y: number; w: number; h: number; tint: CanvasTint; version: number };
export type CanvasCardRow = { canvasId: string; channelId: string; projectId: string | null; x: number; y: number; w: number; version: number; placedBy: string; placedAt: number; ownerLabel: string };

/** Smallest-area region containing the point (edges inclusive); ties go to the lowest id. */
export function areaFor(point: { x: number; y: number }, areas: CanvasArea[]): CanvasArea | null {
  let best: CanvasArea | null = null;
  for (const a of areas) {
    if (point.x < a.x || point.x > a.x + a.w || point.y < a.y || point.y > a.y + a.h) continue;
    if (!best || a.w * a.h < best.w * best.h || (a.w * a.h === best.w * best.h && a.id < best.id)) best = a;
  }
  return best;
}

/**
 * A card as one viewer may see it. Locked and unavailable cards deliberately carry no
 * title, participants, project id or kind: the viewer cannot see that chat in the engine.
 */
type BoardCardBase = Omit<CanvasCardRow, 'ownerLabel' | 'projectId'>;
export type BoardCard = BoardCardBase & (
  | { access: 'open'; title: string; kind?: string; projectId: string | null; participants: { subscriberType: string; subscriberId: string }[]; archived: boolean; canManage: boolean }
  | { access: 'locked'; ownerLabel: string }
  | { access: 'unavailable' }
);
export type CanvasBoard = { canvas: Canvas; areas: CanvasArea[]; cards: BoardCard[] };
