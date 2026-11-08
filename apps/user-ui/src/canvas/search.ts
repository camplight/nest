// Canvas search: what Ctrl/Cmd+K can find, and how matches are ordered. Pure; no DOM.
import type {Canvas,CanvasBoard} from '@nest/schemas';
import type {LooseChat} from './loose';

export type SearchItem = {kind: 'canvas' | 'card' | 'loose' | 'area'; id: string; label: string; detail: string};
export type SearchInput = {canvases: Canvas[]; board: CanvasBoard | null; loose: LooseChat[]};

/** Tie order between kinds, and the order of the groups in the dialog. */
export const KIND_ORDER: SearchItem['kind'][] = ['card', 'area', 'loose', 'canvas'];
export const DEFAULT_LIMIT = 20;

/** Locked and unavailable cards are not here: their titles are not the person's to read. */
export function searchIndex({canvases, board, loose}: SearchInput): SearchItem[] {
  const items: SearchItem[] = [];
  for (const card of board?.cards ?? []) {
    if (card.access !== 'open') continue;
    const agents = card.participants.filter(p => p.subscriberType === 'AGENT').map(p => p.subscriberId);
    items.push({kind: 'card', id: card.channelId, label: card.title || 'Untitled chat', detail: agents.join(', ') || 'No agents'});
  }
  for (const area of board?.areas ?? []) items.push({kind: 'area', id: area.id, label: area.title, detail: 'Area'});
  for (const chat of loose) items.push({kind: 'loose', id: chat.channelId, label: chat.title || 'Untitled chat', detail: chat.agents.join(', ') || 'No agents'});
  for (const canvas of canvases) items.push({kind: 'canvas', id: canvas.id, label: canvas.name, detail: canvas.role === 'owner' ? 'Yours' : 'Shared with you'});
  return items;
}

const isWordChar = (char: string) => /[\p{L}\p{N}]/u.test(char);
/** 0: the label starts with the query; 1: a word of it does; 2: it appears inside; null: no match. */
function score(label: string, query: string): number | null {
  const text = label.toLowerCase();
  let best: number | null = null;
  for (let at = text.indexOf(query); at >= 0; at = text.indexOf(query, at + 1)) {
    const tier = at === 0 ? 0 : !isWordChar(text[at - 1]) ? 1 : 2;
    if (best === null || tier < best) best = tier;
    if (tier === 0) break;
  }
  return best;
}

/** Best matches first. An empty query matches nothing. */
export function rank(items: SearchItem[], query: string, limit = DEFAULT_LIMIT): SearchItem[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  return items
    .map((item, index) => ({item, index, tier: score(item.label, q)}))
    .filter((entry): entry is {item: SearchItem; index: number; tier: number} => entry.tier !== null)
    .sort((a, b) => a.tier - b.tier || KIND_ORDER.indexOf(a.item.kind) - KIND_ORDER.indexOf(b.item.kind) || a.index - b.index)
    .slice(0, limit)
    .map(entry => entry.item);
}
