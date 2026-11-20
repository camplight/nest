// A tray agent dropped on the canvas: on a card it is invited there (today's behaviour); on empty canvas, for editors,
// it starts a new chat with that agent at the drop point or in the area under it.
import {DEFAULT_CARD_WIDTH} from '@nest/schemas';
import type {Point} from './geometry';
import {CARD_PLACE_HEIGHT,clearOfCards,type Placed} from './loose';

export type AgentDropTarget = {kind: 'card'; channelId: string} | {kind: 'canvas'; areaId: string | null};

/** A card under the pointer (any access) keeps the drag; otherwise empty canvas takes it only when a chat can start there. */
export function agentDropTarget({cardId, areaId, canStart}: {cardId?: string | null; areaId?: string | null; canStart: boolean}): AgentDropTarget | null {
  if (cardId) return {kind: 'card', channelId: cardId};
  return canStart ? {kind: 'canvas', areaId: areaId ?? null} : null;
}

export type NewChatMember = {subscriberType: 'AGENT'; subscriberId: string};

/** A dropped agent is the new chat's only agent; without one, the person's own agent joins (as for `+ Chat`). */
export function newChatMembers(agent: string | undefined, personalAgentId: string | undefined): NewChatMember[] {
  const id = agent || personalAgentId;
  return id ? [{subscriberType: 'AGENT', subscriberId: id}] : [];
}

/** Where a chat started at a canvas point goes: centred there, moved down below any card it would cover. */
export function startSpot(at: Point, cards: Placed[]): Point {
  const spot = {x: Math.round(at.x - DEFAULT_CARD_WIDTH / 2), y: Math.round(at.y - CARD_PLACE_HEIGHT / 2)};
  return {x: spot.x, y: spot.y + clearOfCards({...spot, w: DEFAULT_CARD_WIDTH, h: CARD_PLACE_HEIGHT}, cards)};
}

export const startFailed = (agent?: string) => agent ? `Could not start a chat with ${agent}. Try again.` : 'Could not start a new chat. Try again.';
