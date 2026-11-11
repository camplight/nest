// Pure link-line math: the mock's geom (switchyard-nest-vision.html, geom) and its reverse-pair offset (renderLinks).
import type {Point,Rect} from './geometry';

/** How far apart a reverse pair (A→B beside B→A) is drawn, so both lines and labels show. */
export const REVERSE_OFFSET = 22;

/**
 * A cubic from one card's edge to the other's, as the mock's geom: side by side (|dx| × 0.75 > |dy|) it leaves the
 * facing side edges at mid-height, else the facing top and bottom edges at mid-width, bowed by 40% of the gap (50 min).
 */
export function linkPath(A: Rect, B: Rect): string {
  const ac = {x: A.x + A.w / 2, y: A.y + A.h / 2}, bc = {x: B.x + B.w / 2, y: B.y + B.h / 2}, dx = bc.x - ac.x, dy = bc.y - ac.y;
  let p1, p2, c1, c2;
  if (Math.abs(dx) * .75 > Math.abs(dy)) {
    const s = Math.sign(dx) || 1, k = Math.max(50, Math.abs(dx) * .4);
    p1 = {x: s > 0 ? A.x + A.w : A.x, y: ac.y}; p2 = {x: s > 0 ? B.x : B.x + B.w, y: bc.y};
    c1 = {x: p1.x + s * k, y: p1.y}; c2 = {x: p2.x - s * k, y: p2.y};
  } else {
    const s = Math.sign(dy) || 1, k = Math.max(50, Math.abs(dy) * .4);
    p1 = {x: ac.x, y: s > 0 ? A.y + A.h : A.y}; p2 = {x: bc.x, y: s > 0 ? B.y : B.y + B.h};
    c1 = {x: p1.x, y: p1.y + s * k}; c2 = {x: p2.x, y: p2.y - s * k};
  }
  return `M${p1.x} ${p1.y}C${c1.x} ${c1.y} ${c2.x} ${c2.y} ${p2.x} ${p2.y}`;
}

/**
 * The y offset of each line: a pair drawn both ways moves the lower id up 22 and the other down 22, applied to both
 * rects (the mock's renderLinks); every other line keeps 0. `from` and `to` are the drawn ends.
 */
export function offsetReverse(links: readonly {id: string; from: string; to: string}[]): Map<string, number> {
  const offsets = new Map<string, number>();
  for (const l of links) {
    const rev = links.find(o => o.from === l.to && o.to === l.from);
    offsets.set(l.id, rev ? (l.id < rev.id ? -REVERSE_OFFSET : REVERSE_OFFSET) : 0);
  }
  return offsets;
}

/** The drawn ends: a link runs source → target; a fork (stored child → parent) is drawn parent → child, as in the mock. */
export function drawnEnds(link: {kind: 'link' | 'fork'; from: string; to: string}): {a: string; b: string} {
  return link.kind === 'fork' ? {a: link.to, b: link.from} : {a: link.from, b: link.to};
}

/** The mock's temporary `.lk.temp` while a card's + port is dragged: from A's right edge at mid-height to the pointer. */
export const tempLinkPath = (A: Rect, p: Point) =>
  `M${A.x + A.w} ${A.y + A.h / 2}C${A.x + A.w + 80} ${A.y + A.h / 2} ${p.x - 80} ${p.y} ${p.x} ${p.y}`;

/** Inside the surface but not empty canvas: its chrome (tools, zoom), an area's title bar, line labels and controls. */
const NOT_EMPTY = '.canvas-chrome, .canvas-area-bar, .lab, button, a, input, textarea, select, [contenteditable]';
/**
 * Where a dragged + port was released, from the element under the pointer (elementFromPoint): another open card, or
 * empty canvas (the surface's own background or an area's inside). Anything else is null: the dragged card, a locked or
 * unavailable card, the surface's chrome, or anything outside the surface (the top bar, the drawer, a popover or sheet).
 */
export function linkRelease(hit: Element | null, surface: Element | null, from: string, isOpen: (channelId: string) => boolean):
  {kind: 'card'; channelId: string} | {kind: 'empty'} | null {
  if (!hit || !surface?.contains(hit)) return null;
  const card = hit.closest('.canvas-card');
  if (card) {
    const id = card.getAttribute('data-channel-id');
    return id && id !== from && isOpen(id) ? {kind: 'card', channelId: id} : null;
  }
  return hit.closest(NOT_EMPTY) ? null : {kind: 'empty'};
}
