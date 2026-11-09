// Loose chats: the chats a person is part of that are not on the current canvas. Pure list logic for the pile.
import {CARD_HEIGHT,DEFAULT_CARD_WIDTH,type Project} from '@nest/schemas';
import type {Channel,ChannelParticipant} from '../types';
import type {CardPulse} from './pulse';
import {AREA_FIT_PAD,overlaps,type Point,type Rect} from './geometry';

export type LooseChat = {channelId: string; projectId: string | null; title: string; participants: ChannelParticipant[]; lastActivityAt: number | null; needsYou: boolean; agents: string[]};
export type LooseAge = 'any' | 'today' | 'week' | 'older';
export type LooseFilter = {query: string; needsYou: boolean; agent: string | null; age: LooseAge};
export type LooseInput = {
  /** App's already-visible channels. */
  channels: Channel[]; projects: Project[];
  boardChannelIds: ReadonlySet<string>; hidden: ReadonlySet<string>;
  username: string; userId: string;
  pulses: ReadonlyMap<string, CardPulse>;
  showHidden: boolean;
};

const DAY_MS = 24 * 60 * 60_000;
const isHuman = (p: ChannelParticipant) => p.subscriberType.trim().toUpperCase() === 'HUMAN';
const isAgent = (p: ChannelParticipant) => p.subscriberType.trim().toUpperCase() === 'AGENT';
/** Lifecycle channels are engine plumbing; the sidebar never lists them. */
const isSystem = (channel: Channel) => channel.name.toLowerCase().startsWith('agent.lifecycle.');

/** The person's own chats (a human participant, or the owner) that are not archived, on this board or hidden. Newest activity first. */
export function looseChats({channels, projects, boardChannelIds, hidden, username, userId, pulses, showHidden}: LooseInput): LooseChat[] {
  const byChannel = new Map(projects.map(project => [project.channelId, project]));
  const items: LooseChat[] = [];
  for (const channel of channels) {
    if (channel.archivedAt || isSystem(channel) || boardChannelIds.has(channel.id) || (!showHidden && hidden.has(channel.id))) continue;
    const participants = channel.participants ?? [];
    const mine = (Boolean(userId) && channel.ownerHumanId === userId) || participants.some(p => isHuman(p) && p.subscriberId === username);
    if (!mine) continue;
    const project = byChannel.get(channel.id);
    const pulse = pulses.get(channel.id);
    items.push({
      channelId: channel.id,
      projectId: project?.id ?? null,
      // Same title as a placed card: the project name, else the channel name.
      title: project?.name || channel.name,
      participants,
      lastActivityAt: pulse?.lastActivityAt ?? project?.createdAt ?? null,
      needsYou: Boolean(pulse?.needsYou.length),
      agents: [...new Set(participants.filter(isAgent).map(p => p.subscriberId))],
    });
  }
  return items.sort((a, b) => (b.lastActivityAt ?? -Infinity) - (a.lastActivityAt ?? -Infinity) || a.title.localeCompare(b.title));
}

/** Keeps order. The query matches the title or a participant id, ignoring case. */
export function filterLoose(items: LooseChat[], {query, needsYou, agent, age}: LooseFilter, now: number): LooseChat[] {
  const q = query.trim().toLowerCase();
  const today = now - DAY_MS, week = now - 7 * DAY_MS;
  return items.filter(item => {
    if (needsYou && !item.needsYou) return false;
    if (agent && !item.agents.includes(agent)) return false;
    const at = item.lastActivityAt;
    if (age === 'today' && (at === null || at < today)) return false;
    if (age === 'week' && (at === null || at < week)) return false;
    if (age === 'older' && at !== null && at >= week) return false;
    if (!q) return true;
    return item.title.toLowerCase().includes(q) || item.participants.some(p => p.subscriberId.toLowerCase().includes(q));
  });
}

export const GRID_COLUMNS = 3;
export const GRID_STEP = {x: 300, y: 200};
export const AREA_PADDING = 48;

/** Cards in rows of 3, 300×200 apart, with the grid's bounds centred on `centre` (canvas units). */
export function gridPlacement(channelIds: string[], centre: Point): {cards: {channelId: string; x: number; y: number}[]; bounds: Rect} {
  const columns = Math.min(GRID_COLUMNS, Math.max(1, channelIds.length)), rows = Math.max(1, Math.ceil(channelIds.length / GRID_COLUMNS));
  const w = (columns - 1) * GRID_STEP.x + DEFAULT_CARD_WIDTH, h = (rows - 1) * GRID_STEP.y + CARD_HEIGHT;
  const x = Math.round(centre.x - w / 2), y = Math.round(centre.y - h / 2);
  return {
    cards: channelIds.map((channelId, i) => ({channelId, x: x + (i % GRID_COLUMNS) * GRID_STEP.x, y: y + Math.floor(i / GRID_COLUMNS) * GRID_STEP.y})),
    bounds: {x, y, w, h},
  };
}

/** The rect of a new area that wraps `bounds` with 48 px on every side. */
export const areaAround = (bounds: Rect, pad = AREA_PADDING): Rect => ({x: bounds.x - pad, y: bounds.y - pad, w: bounds.w + 2 * pad, h: bounds.h + 2 * pad});

/** A chat dropped from the pile lands as a default-width card centred on the drop point. */
export const dropPlacement = (at: Point, w = DEFAULT_CARD_WIDTH): Point => ({x: Math.round(at.x - w / 2), y: Math.round(at.y - CARD_HEIGHT / 2)});

/** The space kept between a moved grid (or its area) and the card above it. */
export const PLACE_GAP = 40;
/**
 * How far down `rect` (a new grid, or the area around it) must move so it covers no existing card:
 * below the lowest card it overlaps plus a gap, again until it overlaps none. 0 when it is already clear.
 */
export function clearOfCards(rect: Rect, cards: {x: number; y: number; w: number}[], gap = PLACE_GAP): number {
  const taken = cards.map(card => ({x: card.x, y: card.y, w: card.w, h: CARD_HEIGHT}));
  let dy = 0;
  // Each pass moves past at least one more card, so this ends within one pass per card.
  for (let pass = 0; pass <= taken.length; pass++) {
    const moved = {...rect, y: rect.y + dy};
    const hits = taken.filter(card => overlaps(moved, card));
    if (!hits.length) break;
    dy = Math.max(...hits.map(card => card.y + card.h)) + gap - rect.y;
  }
  return dy;
}

/**
 * Where chats dropped from the pile land: one chat centred on the drop point, or several in the
 * 3-wide grid centred there, moved down below any existing card it would cover.
 */
export function dropLayout(channelIds: string[], at: Point, cards: {x: number; y: number; w: number}[]): {channelId: string; x: number; y: number}[] {
  if (channelIds.length === 1) return [{channelId: channelIds[0]!, ...dropPlacement(at)}];
  const first = gridPlacement(channelIds, at);
  const dy = clearOfCards(first.bounds, cards);
  return dy ? gridPlacement(channelIds, {x: at.x, y: at.y + dy}).cards : first.cards;
}

type Placed = {x: number; y: number; w: number};
/** Room kept around other cards when a card is moved in from the chat header. */
const SLOT_MARGIN = PLACE_GAP / 2;
const SLOT_TRIES = 400;
const takenBy = (cards: Placed[]): Rect[] =>
  cards.map(card => ({x: card.x - SLOT_MARGIN, y: card.y - SLOT_MARGIN, w: card.w + 2 * SLOT_MARGIN, h: CARD_HEIGHT + 2 * SLOT_MARGIN}));

/**
 * Where a card moved into an area goes: the first free grid spot under its title bar, row by row,
 * in as many columns as fit (at least one). Rows continue below the area, which then grows to fit.
 */
export function slotInArea(area: Rect, cards: Placed[], w = DEFAULT_CARD_WIDTH): Point {
  const columns = Math.max(1, Math.floor((area.w - 2 * AREA_FIT_PAD.side - w) / GRID_STEP.x) + 1);
  const taken = takenBy(cards);
  const spotAt = (i: number): Point => ({x: area.x + AREA_FIT_PAD.side + (i % columns) * GRID_STEP.x, y: area.y + AREA_FIT_PAD.top + Math.floor(i / columns) * GRID_STEP.y});
  for (let i = 0; i < SLOT_TRIES; i++) {
    const spot = spotAt(i);
    if (!taken.some(rect => overlaps(rect, {...spot, w, h: CARD_HEIGHT}))) return spot;
  }
  return spotAt(SLOT_TRIES);
}

/**
 * Where a card taken out of an area goes: just right of that area, stepping down (then further
 * right) until it overlaps no area and no other card.
 */
export function slotOutsideAreas(home: Rect, areas: Rect[], cards: Placed[], w = DEFAULT_CARD_WIDTH): Point {
  const taken = [...takenBy(cards), ...areas];
  const start = {x: home.x + home.w + PLACE_GAP, y: home.y};
  const rows = SLOT_TRIES / 4, step = SLOT_MARGIN;
  for (let i = 0; i < SLOT_TRIES; i++) {
    const spot = {x: start.x + Math.floor(i / rows) * GRID_STEP.x, y: start.y + (i % rows) * step};
    if (!taken.some(rect => overlaps(rect, {...spot, w, h: CARD_HEIGHT}))) return spot;
  }
  return {x: start.x + 4 * GRID_STEP.x, y: start.y};
}
