// Where an open focus chat sits: the mock's `.card.open` (a placed card grown in place) and `.qchat` (a plain chat).
import {clampZoom,type Point,type Rect,type Size,type View} from './geometry';

/** The mock's open card is 540 px; the sheet adds the card's own padding around App's chat. */
export const SHEET_WIDTH = 560;
export const SHEET_MAX_HEIGHT = 720;
/** A loose chat's sheet: the mock's `.qchat .chat` max-height is min(640px, 100vh - 190px). */
export const LOOSE_MAX_HEIGHT = 640;
export const LOOSE_VIEWPORT_ROOM = 190;
/** Clear space kept between the sheet and the edges of the canvas. */
export const SHEET_GUTTER = 16;
/** Never anchor so low that the chat has less room than this. */
export const SHEET_MIN_HEIGHT = 320;
/** The mock's `.qchat` sits at bottom 84 px: just above the bottom box. */
export const LOOSE_BOTTOM = 84;

/** `x`/`y` (or `bottom`) are relative to the region the sheet is positioned in. */
export type CardSheet = {kind: 'card'; x: number; y: number; w: number; maxH: number};
export type LooseSheet = {kind: 'loose'; x: number; bottom: number; w: number; maxH: number};
export type SheetPlace = CardSheet | LooseSheet;

const clamp = (n: number, min: number, max: number) => Math.min(Math.max(n, min), Math.max(min, max));

/** The sheet's width and tallest height in a region, 16 px clear of every edge. */
export function sheetSize(region: Size): Size {
  return {w: Math.max(0, Math.min(SHEET_WIDTH, region.w - 2 * SHEET_GUTTER)), h: Math.max(0, Math.min(SHEET_MAX_HEIGHT, region.h - 2 * SHEET_GUTTER))};
}

/**
 * The view that opens a card in place (the mock's openCard): zoom 1, or the largest zoom below it that fits the card,
 * with the card's top-left where a centred sheet starts, so the sheet over it reads as the card grown in place.
 */
export function presentView(card: Rect, viewport: Size): View {
  const sheet = sheetSize(viewport);
  const zoom = clampZoom(Math.min(1, (viewport.w - 2 * SHEET_GUTTER) / Math.max(1, card.w), (viewport.h - 2 * SHEET_GUTTER) / Math.max(1, card.h)));
  const left = Math.max(SHEET_GUTTER, (viewport.w - sheet.w) / 2), top = Math.max(SHEET_GUTTER, (viewport.h - sheet.h) / 2);
  return {zoom, x: left - card.x * zoom, y: top - card.y * zoom};
}

/** The sheet over a placed card: its top-left on the card's on-screen top-left, kept inside the region. Centred without one. */
export function cardSheet(card: Point | null, region: Size): CardSheet {
  const {w, h} = sheetSize(region);
  const x = card ? clamp(card.x, SHEET_GUTTER, region.w - w - SHEET_GUTTER) : Math.max(SHEET_GUTTER, (region.w - w) / 2);
  const y = card ? clamp(card.y, SHEET_GUTTER, region.h - SHEET_GUTTER - Math.min(h, SHEET_MIN_HEIGHT)) : Math.max(SHEET_GUTTER, (region.h - h) / 2);
  return {kind: 'card', x: Math.round(x), y: Math.round(y), w: Math.round(w), maxH: Math.round(Math.max(0, Math.min(h, region.h - y - SHEET_GUTTER)))};
}

/** A chat that is not on the canvas: a sheet centred on `centreX`, its bottom `bottom` px above the region's (over the bottom box). */
export function looseSheet(region: Size, centreX: number, bottom: number, viewportHeight: number): LooseSheet {
  const w = sheetSize(region).w;
  const x = clamp(centreX - w / 2, SHEET_GUTTER, region.w - w - SHEET_GUTTER);
  const b = clamp(bottom, SHEET_GUTTER, region.h - SHEET_GUTTER - Math.min(SHEET_MIN_HEIGHT, region.h - 2 * SHEET_GUTTER));
  const maxH = Math.min(LOOSE_MAX_HEIGHT, viewportHeight - LOOSE_VIEWPORT_ROOM, region.h - b - SHEET_GUTTER);
  return {kind: 'loose', x: Math.round(x), bottom: Math.round(b), w: Math.round(w), maxH: Math.round(Math.max(Math.min(SHEET_MIN_HEIGHT, region.h - b - SHEET_GUTTER), maxH))};
}

export const samePlace = (a: SheetPlace | null, b: SheetPlace | null) => a === b || (!!a && !!b && JSON.stringify(a) === JSON.stringify(b));
