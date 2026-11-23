// Pure canvas math: the view transform, zoom, fit, culling and area membership.
import {CARD_HEIGHT,areaFor,type CanvasArea} from '@nest/schemas';

/** screen = canvas × zoom + (x, y), in surface-relative pixels. */
export type View = {x: number; y: number; zoom: number};
export type Point = {x: number; y: number};
export type Rect = {x: number; y: number; w: number; h: number};
export type Size = {w: number; h: number};

export const MIN_ZOOM = 0.2;
export const MAX_ZOOM = 2;
/** Below this zoom cards and areas switch to their compact (semantic zoom) form. */
export const COMPACT_ZOOM = 0.5;
export const ORIGIN: View = {x: 0, y: 0, zoom: 1};

export const clampZoom = (zoom: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
export const toCanvas = (view: View, p: Point): Point => ({x: (p.x - view.x) / view.zoom, y: (p.y - view.y) / view.zoom});
export const toScreen = (view: View, p: Point): Point => ({x: p.x * view.zoom + view.x, y: p.y * view.zoom + view.y});
export const isCompact = (view: View) => view.zoom < COMPACT_ZOOM;

/** Multiplies the zoom (clamped to 0.2–2) while the canvas point under `screen` stays put. */
export function zoomAt(view: View, factor: number, screen: Point): View {
  const zoom = clampZoom(view.zoom * factor);
  const anchor = toCanvas(view, screen);
  return {x: screen.x - anchor.x * zoom, y: screen.y - anchor.y * zoom, zoom};
}

/** Centres the rects' bounds in the viewport with `pad` screen pixels around them, never above 100%. */
export function fit(rects: Rect[], viewport: Size, pad = 48): View {
  if (!rects.length) return ORIGIN;
  let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
  for (const r of rects) {
    left = Math.min(left, r.x); top = Math.min(top, r.y);
    right = Math.max(right, r.x + r.w); bottom = Math.max(bottom, r.y + r.h);
  }
  const w = Math.max(1, right - left), h = Math.max(1, bottom - top);
  const zoom = clampZoom(Math.min(1, (viewport.w - 2 * pad) / w, (viewport.h - 2 * pad) / h));
  return {x: viewport.w / 2 - (left + w / 2) * zoom, y: viewport.h / 2 - (top + h / 2) * zoom, zoom};
}

/** Items that overlap the viewport grown by `margin` screen pixels on every side. */
export function visible<T extends Rect>(items: T[], view: View, viewport: Size, margin = 200): T[] {
  const a = toCanvas(view, {x: -margin, y: -margin}), b = toCanvas(view, {x: viewport.w + margin, y: viewport.h + margin});
  return items.filter(r => r.x <= b.x && r.x + r.w >= a.x && r.y <= b.y && r.y + r.h >= a.y);
}

/** The point that decides a card's area. It uses the shared CARD_HEIGHT so client and server agree. */
export const cardCentre = (card: {x: number; y: number; w: number}): Point => ({x: card.x + card.w / 2, y: card.y + CARD_HEIGHT / 2});

/** True when the rects share some area; touching edges do not count. */
export const overlaps = (a: Rect, b: Rect) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

export const contains = (outer: Rect, inner: Rect) =>
  inner.x >= outer.x && inner.y >= outer.y && inner.x + inner.w <= outer.x + outer.w && inner.y + inner.h <= outer.y + outer.h;

/**
 * What travels with an area when it moves, mirroring the API: areas nested inside it, and the cards
 * whose area (by centre) is it or one of those nested areas.
 */
export function areaMembers(areaId: string, cards: {channelId: string; x: number; y: number; w: number}[], areas: CanvasArea[]) {
  const self = areas.find(a => a.id === areaId);
  const nested = new Set<string>();
  const moving = new Set<string>();
  if (!self) return {areas: nested, cards: moving};
  for (const a of areas) if (a.id !== areaId && contains(self, a)) nested.add(a.id);
  for (const c of cards) {
    const owner = areaFor(cardCentre(c), areas);
    if (owner && (owner.id === areaId || nested.has(owner.id))) moving.add(c.channelId);
  }
  return {areas: nested, cards: moving};
}

/** Room kept around cards inside an area; the top stays clear of the area's title bar. */
export const AREA_FIT_PAD = {side: 32, top: 72};
const MAX_AREA_SIZE = 20_000;
/**
 * The area grown (never shrunk) so every rect fits inside it with AREA_FIT_PAD around it,
 * or null when they already fit. Width and height stay within the API's 20 000 limit.
 */
export function growToFit(area: Rect, rects: Rect[], pad = AREA_FIT_PAD): Rect | null {
  if (!rects.length) return null;
  const left = Math.min(area.x, ...rects.map(r => r.x - pad.side));
  const top = Math.min(area.y, ...rects.map(r => r.y - pad.top));
  const right = Math.max(area.x + area.w, ...rects.map(r => r.x + r.w + pad.side));
  const bottom = Math.max(area.y + area.h, ...rects.map(r => r.y + r.h + pad.side));
  if (left === area.x && top === area.y && right === area.x + area.w && bottom === area.y + area.h) return null;
  return {
    x: Math.round(left), y: Math.round(top),
    w: Math.round(Math.min(MAX_AREA_SIZE, right - left)), h: Math.round(Math.min(MAX_AREA_SIZE, bottom - top)),
  };
}
