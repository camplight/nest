// The stage bounds a canvas chat window keeps inside, and the view that presents a card beside a sheet of a given height.
import {clampZoom,type Point,type Rect,type Size,type View} from './geometry';

/** The mock's open card is 540 px; the sheet adds the card's own padding around App's chat. */
export const SHEET_WIDTH = 560;
export const SHEET_MAX_HEIGHT = 720;
/** Clear space kept between the sheet and the edges of the canvas. */
export const SHEET_GUTTER = 16;
/** Clear space kept between the sheet and the top of the bottom box. */
export const DOCK_GAP = 8;
/** Room left above an opened card for its area's title bar. */
export const AREA_HEAD_ROOM = 56;
/** Never anchor so low that the chat has less room than this. */
export const SHEET_MIN_HEIGHT = 320;

/** Where a sheet may sit, in the coordinates it is positioned in: gutters applied, `bottom` above the bottom box. */
export type Bounds = {left: number; top: number; right: number; bottom: number};
const width = (b: Bounds) => Math.max(0, Math.min(SHEET_WIDTH, b.right - b.left));

/** The bounds of a stage `size` with its bottom box `dockTop` px down (null without one): 16 px gutters, 8 px above the box. */
export function stageBounds(size: Size, dockTop: number | null, offset: Point = {x: 0, y: 0}): Bounds {
  const bottom = dockTop !== null && dockTop > SHEET_GUTTER ? dockTop - DOCK_GAP : size.h - SHEET_GUTTER;
  return {left: offset.x + SHEET_GUTTER, top: offset.y + SHEET_GUTTER, right: offset.x + size.w - SHEET_GUTTER, bottom: offset.y + bottom};
}

/**
 * The bounds left of which a sheet keeps clear of the Loose chats drawer, whose right edge is `edge` (the bounds'
 * coordinates; null while it is closed). Only when a full-width sheet still fits beside it: on a narrower canvas the
 * bounds are unchanged and the sheet overlaps the drawer, above it.
 */
export function clearOfDrawer(bounds: Bounds, edge: number | null): Bounds {
  if (edge === null) return bounds;
  const left = edge + SHEET_GUTTER;
  return left > bounds.left && bounds.right - left >= SHEET_WIDTH ? {...bounds, left} : bounds;
}

/**
 * The view that opens a card in place (the mock's openCard): zoom 1, or the largest zoom below it that fits the card.
 * The card's top-left goes where a centred sheet of its real height starts, with room above for the area's title and
 * the whole sheet above the bottom box. `bounds` are in the surface's coordinates.
 */
export function presentView(card: Rect, bounds: Bounds, sheetHeight: number): View {
  const w = width(bounds), room = bounds.bottom - bounds.top;
  const h = Math.max(0, Math.min(sheetHeight, SHEET_MAX_HEIGHT, room));
  const zoom = clampZoom(Math.min(1, (bounds.right - bounds.left) / Math.max(1, card.w), room / Math.max(1, card.h)));
  const left = bounds.left + Math.max(0, (bounds.right - bounds.left - w) / 2);
  // Centred between the top and the bottom box, never so high that the area's title is cut off (unless that would leave
  // the chat too little room).
  const centred = bounds.top + (room - h) / 2;
  const top = bounds.bottom - AREA_HEAD_ROOM >= Math.min(h, SHEET_MIN_HEIGHT) ? Math.max(AREA_HEAD_ROOM, centred) : bounds.top;
  return {zoom, x: left - card.x * zoom, y: top - card.y * zoom};
}
