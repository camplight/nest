// Phones: the canvas as a list. Groups the cards by area for PhoneList. Pure; no DOM.
import {areaFor,type BoardCard,type CanvasArea} from '@nest/schemas';
import {cardCentre} from './geometry';

export type PhoneGroup = {id: string; title: string; tint: CanvasArea['tint'] | null; cards: BoardCard[]};
/** The id of the group for cards that sit in no area. */
export const NO_AREA = 'none';
const reading = (a: {x: number; y: number}, b: {x: number; y: number}) => a.y - b.y || a.x - b.x;

/**
 * Each area with the cards whose centre is in it (the innermost area, as on the surface), top to bottom
 * and left to right; then a group for the cards in no area, when there are any.
 */
export function phoneGroups(cards: BoardCard[], areas: CanvasArea[]): PhoneGroup[] {
  const byArea = new Map<string, BoardCard[]>();
  const outside: BoardCard[] = [];
  for (const card of [...cards].sort(reading)) {
    const area = areaFor(cardCentre(card), areas);
    if (!area) { outside.push(card); continue; }
    const list = byArea.get(area.id);
    if (list) list.push(card); else byArea.set(area.id, [card]);
  }
  const groups: PhoneGroup[] = [...areas].sort(reading).map(area => ({id: area.id, title: area.title, tint: area.tint, cards: byArea.get(area.id) ?? []}));
  return outside.length ? [...groups, {id: NO_AREA, title: 'Not in an area', tint: null, cards: outside}] : groups;
}
