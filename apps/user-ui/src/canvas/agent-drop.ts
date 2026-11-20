// A tray agent dropped on the canvas: on a card it is invited there (today's behaviour); on empty canvas, for editors,
// it starts a new chat with that agent at the drop point or in the area under it.
import {DEFAULT_CARD_WIDTH} from '@nest/schemas';
import type {Point} from './geometry';
import {CARD_PLACE_HEIGHT,clearOfCards,type Placed} from './loose';
import {inviteLabel,startLabel,type InviteTarget} from './invite-label';

export type AgentDropTarget = {kind: 'card'; channelId: string} | {kind: 'canvas'; areaId: string | null};

/** A card under the pointer (any access) keeps the drag; otherwise empty canvas takes it only when a chat can start there. */
export function agentDropTarget({cardId, areaId, canStart}: {cardId?: string | null; areaId?: string | null; canStart: boolean}): AgentDropTarget | null {
  if (cardId) return {kind: 'card', channelId: cardId};
  return canStart ? {kind: 'canvas', areaId: areaId ?? null} : null;
}

/** What an agent drag over the canvas does now: the drop effect, the floating label, what to highlight and what a drop does. */
export type AgentDragPlan = {
  /** Set on dragover when the drop is taken; null leaves the browser's no-drop. */
  dropEffect: 'copy' | null;
  label: string | null;
  /** The card or area to highlight. */
  card: string | null;
  area: string | null;
  drop: {kind: 'invite'; channelId: string} | {kind: 'start'; areaId: string | null} | null;
};

/**
 * The agent drag decision. Over a card (`cardId`, looked up as `card`) it is today's invite: an open card takes the
 * drop (`invites`: there is an invite handler) and the label says what dropping does or why it cannot. Off any card,
 * an editor (`canEdit`) with a start handler (`starts`) starts a chat there, in the area under the pointer if any.
 * Anything else takes no drop. `agent` is the dragged name when known (a drag's data is unreadable until the drop).
 */
export function agentDragPlan({agent, cardId, card, areaId, areaTitle, canEdit, starts, invites}: {
  agent: string | null; cardId?: string | null; card?: (InviteTarget & {channelId: string}) | null;
  areaId?: string | null; areaTitle?: string; canEdit: boolean; starts: boolean; invites: boolean;
}): AgentDragPlan {
  const none: AgentDragPlan = {dropEffect: null, label: null, card: null, area: null, drop: null};
  const target = agentDropTarget({cardId, areaId, canStart: canEdit && starts});
  if (!target) return none;
  if (target.kind === 'canvas')
    return {dropEffect: 'copy', label: agent ? startLabel(agent, areaTitle) : null, card: null, area: target.areaId, drop: {kind: 'start', areaId: target.areaId}};
  if (!card || !invites) return none;
  const label = agent ? inviteLabel({agent, card}) : null;
  if (card.access !== 'open') return {...none, label};
  return {dropEffect: 'copy', label, card: card.channelId, area: null, drop: {kind: 'invite', channelId: card.channelId}};
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
