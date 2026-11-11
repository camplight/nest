// Pure link-line math: the mock's geom (switchyard-nest-vision.html, geom) and its reverse-pair offset (renderLinks).
import type {Rect} from './geometry';

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
