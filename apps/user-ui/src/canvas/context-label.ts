// The words the canvas uses for context: chip labels, "Used by …" sentences, file tile kinds and what an open chat sees.
import type {BoardCard,ContextCounts,ContextLink,ContextUse} from '@nest/schemas';

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** `Notes · 2 files`, `Notes`, `1 file`, or `empty` (`Add context` for editors) when there is nothing. */
export function contextLabel(counts: ContextCounts, empty = 'Add context') {
  return [counts.notes ? 'Notes' : '', counts.fileCount ? plural(counts.fileCount, 'file') : ''].filter(Boolean).join(' · ') || empty;
}

/** `A`, `A and B`, `A, B and C`. */
export function joinNames(names: string[]) {
  return names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/** The areas using an area, with those the viewer cannot open counted but never named. Empty when nothing uses it. */
export function usedByList(uses: ContextUse[]) {
  const names = uses.flatMap(use => use.title === null ? [] : [use.title || 'Untitled area']);
  const hidden = uses.length - names.length;
  return joinNames([...names, ...(hidden ? [`${plural(hidden, 'area')} you can't open`] : [])]);
}

/** A link's second line in the popover: the other canvas, if any, then its counts or why it shows none. */
export function linkDetail(link: ContextLink, canvasId: string) {
  const where = link.canvasName && link.canvasId !== canvasId ? `on ${link.canvasName}` : '';
  const what = !link.available ? 'unavailable' : link.counts ? contextLabel(link.counts, 'Nothing yet') : '';
  return [where, what].filter(Boolean).join(' · ');
}

/** True when the link's source lives on another canvas than the one shown (`↗` rather than `↳`). */
export const linkElsewhere = (link: ContextLink, canvasId: string) => link.canvasId !== null && link.canvasId !== canvasId;

export type FileKind = 'image' | 'audio' | 'video' | 'sheet' | 'doc';
/** The tile glyph for a context file, from its type and name. */
export function fileKind(mime: string, name: string): FileKind {
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('audio/')) return 'audio';
  if (mime.startsWith('video/')) return 'video';
  if (/sheet|csv|excel/.test(mime) || /\.(csv|tsv|xlsx?|ods)$/i.test(name)) return 'sheet';
  return 'doc';
}

/** What the open chat's header says after `in {area}`: where its context comes from (home semantics, Phase 2). */
export type ChatSees =
  /** Home here: the canvas, the home area (when there is one) and that area's available links. */
  | {kind: 'sees'; areaId: string | null; names: string[]}
  /** Home is another area or canvas. */
  | {kind: 'from'; label: string}
  /** The home's setter lost its canvas, so agents read nothing (R21). */
  | {kind: 'unavailable'}
  /** No home yet (only a member's placement gives one). */
  | {kind: 'none'};

/**
 * Home semantics for an open card: a chat reads the canvas, its home area and that area's available links only
 * when this card is its home. `area` is the area under the card; `links` that area's links from the board summary.
 */
export function chatSees(card: Extract<BoardCard, {access: 'open'}>, canvasName: string, area: {id: string; title: string} | null, links: ContextLink[]): ChatSees {
  const home = card.home;
  if (home?.available === false) return {kind: 'unavailable'};
  if (!home) return {kind: 'none'};
  if (!home.isHere) return home.label ? {kind: 'from', label: home.label} : {kind: 'none'};
  if (!area) return {kind: 'sees', areaId: null, names: [canvasName]};
  return {kind: 'sees', areaId: area.id, names: [canvasName, area.title || 'Untitled area', ...links.filter(link => link.available).map(link => link.title)]};
}
