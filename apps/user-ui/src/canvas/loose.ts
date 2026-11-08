// Loose chats: the chats a person is part of that are not on the current canvas. Pure list logic for the pile.
import {CARD_HEIGHT,DEFAULT_CARD_WIDTH,type Project} from '@nest/schemas';
import type {Channel,ChannelParticipant} from '../types';
import type {CardPulse} from './pulse';
import type {Point,Rect} from './geometry';

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
