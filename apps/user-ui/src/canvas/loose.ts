// Loose chats: the chats a person is part of that are not on the current canvas. Pure list logic for the drawer.
import {CARD_HEIGHT,DEFAULT_CARD_WIDTH,type Project} from '@nest/schemas';
import type {Channel,ChannelParticipant} from '../types';
import {oneLine,type CardPulse} from './pulse';
import type {NeedsItem} from './needs';
import {agentText} from './rows';
import {AREA_FIT_PAD,overlaps,type Point,type Rect} from './geometry';

/** The drawer's chips: it has a Needs you item, else an agent is working, else it is done. */
export type LooseState = 'need' | 'working' | 'done';
export type LooseChat = {
  channelId: string; projectId: string | null; title: string; participants: ChannelParticipant[]; lastActivityAt: number | null; agents: string[];
  state: LooseState;
  /** The newest Needs you reason (a mention's first line or the reviewed task's title); null when nothing needs the person. */
  reason: string | null;
  /** The row's second line without a reason: `{agent} · {activity}`, else the last message's first line, else empty. */
  line: string;
  /** The person may archive it for everyone: they manage the chat and, for a project chat, own the project. */
  manageable: boolean;
  /** Archived for everyone (listed only under Show archived). */
  archived: boolean;
};
export type LooseStateFilter = 'all' | LooseState;
export type LooseFilter = {query: string; state: LooseStateFilter; agent: string | null};
export type LooseInput = {
  /** App's already-visible channels. */
  channels: Channel[]; projects: Project[];
  boardChannelIds: ReadonlySet<string>; hidden: ReadonlySet<string>;
  username: string; userId: string;
  pulses: ReadonlyMap<string, CardPulse>;
  /** Each chat's Needs you items (mentions and reviews), newest first, as the cards use them. Without it a chat's unread mentions count. */
  needs?: ReadonlyMap<string, readonly NeedsItem[]>;
  showHidden: boolean;
  /** Also list chats archived for everyone (Show archived in the drawer). */
  showArchived?: boolean;
};

const isHuman = (p: ChannelParticipant) => p.subscriberType.trim().toUpperCase() === 'HUMAN';
const isAgent = (p: ChannelParticipant) => p.subscriberType.trim().toUpperCase() === 'AGENT';
/** Lifecycle channels are engine plumbing; the sidebar never lists them. */
const isSystem = (channel: Channel) => channel.name.toLowerCase().startsWith('agent.lifecycle.');

/**
 * What a loose chat's row says, from the same live pulse and Needs you items as the cards: the newest reason when
 * something needs the person; else the first agent's activity (as on its card row); else the first line of the newest
 * message a person posted; else nothing.
 */
export function looseStatus(agents: readonly string[], pulse: CardPulse | undefined, needs: readonly NeedsItem[] | undefined): Pick<LooseChat, 'state' | 'reason' | 'line'> {
  const reason = needs ? needs[0]?.reason ?? null : pulse?.needsYou[0] ? oneLine(pulse.needsYou[0].text) : null;
  // A quiet agent is still in a live turn (as on its card row), so it counts as working, never done.
  const working = Boolean(pulse?.agents.some(agent => agent.state === 'working' || agent.state === 'quiet'));
  const first = agents[0] === undefined ? undefined : pulse?.agents.find(agent => agent.name === agents[0]);
  let line = '';
  // An idle agent that never said anything has no activity to show.
  if (first && (first.state !== 'idle' || first.said)) line = `${first.name} · ${agentText(first)}`;
  else line = [...(pulse?.people ?? [])].sort((a, b) => b.at - a.at).find(person => person.said)?.said ?? '';
  return {state: reason !== null ? 'need' : working ? 'working' : 'done', reason, line};
}

/** The person's own chats (a human participant, or the owner) that are not on this board, hidden or archived (unless shown). Newest activity first. */
export function looseChats({channels, projects, boardChannelIds, hidden, username, userId, pulses, needs, showHidden, showArchived = false}: LooseInput): LooseChat[] {
  const byChannel = new Map(projects.map(project => [project.channelId, project]));
  const items: LooseChat[] = [];
  for (const channel of channels) {
    if ((channel.archivedAt && !showArchived) || isSystem(channel) || boardChannelIds.has(channel.id) || (!showHidden && hidden.has(channel.id))) continue;
    const participants = channel.participants ?? [];
    const mine = (Boolean(userId) && channel.ownerHumanId === userId) || participants.some(p => isHuman(p) && p.subscriberId === username);
    if (!mine) continue;
    const project = byChannel.get(channel.id);
    const pulse = pulses.get(channel.id);
    const agents = [...new Set(participants.filter(isAgent).map(p => p.subscriberId))];
    const status = looseStatus(agents, pulse, needs ? needs.get(channel.id) ?? [] : undefined);
    items.push({
      channelId: channel.id,
      projectId: project?.id ?? null,
      // Same title as a placed card: the project name, else the channel name.
      title: project?.name || channel.name,
      participants,
      lastActivityAt: pulse?.lastActivityAt ?? project?.createdAt ?? null,
      agents,
      ...status,
      manageable: Boolean(channel.canManage) && (!project || project.ownerId === userId),
      archived: Boolean(channel.archivedAt),
    });
  }
  return items.sort((a, b) => (b.lastActivityAt ?? -Infinity) - (a.lastActivityAt ?? -Infinity) || a.title.localeCompare(b.title));
}

/** Keeps order. The query matches the title or an agent's name, ignoring case. */
export function filterLoose(items: LooseChat[], {query, state, agent}: LooseFilter): LooseChat[] {
  const q = query.trim().toLowerCase();
  return items.filter(item => {
    if (state !== 'all' && item.state !== state) return false;
    if (agent && !item.agents.includes(agent)) return false;
    if (!q) return true;
    return item.title.toLowerCase().includes(q) || item.agents.some(name => name.toLowerCase().includes(q));
  });
}

/** The chip counts: every chat, and how many are in each state. */
/**
 * Whether a loose chat needs the person (a mention or a review waiting): the one test behind the Needs you chip, the
 * top-bar toggle's coral count and the phone list's dot.
 */
export const looseNeedsYou = (chat: LooseChat) => chat.state === 'need';

export function looseCounts(items: readonly LooseChat[]): Record<LooseStateFilter, number> {
  const counts = {all: items.length, need: 0, working: 0, done: 0};
  for (const item of items) counts[looseNeedsYou(item) ? 'need' : item.state]++;
  return counts;
}

export const LOOSE_GROUPS = ['Today', 'Yesterday', 'This week', 'Older'] as const;
export type LooseGroupName = typeof LOOSE_GROUPS[number];
/**
 * The day group of a last activity, by the local calendar: today, yesterday, the five days before that (this week),
 * else older. A chat with no known activity is older.
 */
export function dayGroup(at: number | null, now: number): LooseGroupName {
  if (at === null) return 'Older';
  const day = (back: number) => { const date = new Date(now); date.setHours(0, 0, 0, 0); date.setDate(date.getDate() - back); return date.getTime(); };
  if (at >= day(0)) return 'Today';
  if (at >= day(1)) return 'Yesterday';
  if (at >= day(6)) return 'This week';
  return 'Older';
}

/** One header per day group that has chats, in order, each followed by its rows (none while a group is folded). */
export type DrawerItem =
  | {kind: 'group'; name: LooseGroupName; count: number; fold: 'show' | 'hide' | null; top: number}
  | {kind: 'row'; chat: LooseChat; index: number; top: number};
export const DRAWER_ROW_HEIGHT = 48;
export const DRAWER_GROUP_HEIGHT = 30;
/**
 * The drawer list laid out for windowing: group headers and rows with their offsets. `foldOlder` lets Older fold
 * (no search and the All filter), and `olderOpen` says whether it is shown. `rows` are the listed chats in order,
 * and each row's `index` is its place among them.
 */
export function drawerLayout(items: readonly LooseChat[], now: number, foldOlder: boolean, olderOpen: boolean): {items: DrawerItem[]; rows: LooseChat[]; height: number} {
  const byGroup = new Map<LooseGroupName, LooseChat[]>(LOOSE_GROUPS.map(name => [name, []]));
  for (const item of items) byGroup.get(dayGroup(item.lastActivityAt, now))!.push(item);
  const out: DrawerItem[] = [], rows: LooseChat[] = [];
  let top = 0;
  for (const name of LOOSE_GROUPS) {
    const chats = byGroup.get(name)!;
    if (!chats.length) continue;
    const folds = name === 'Older' && foldOlder;
    out.push({kind: 'group', name, count: chats.length, fold: folds ? olderOpen ? 'hide' : 'show' : null, top});
    top += DRAWER_GROUP_HEIGHT;
    if (folds && !olderOpen) continue;
    for (const chat of chats) {
      out.push({kind: 'row', chat, index: rows.length, top});
      rows.push(chat);
      top += DRAWER_ROW_HEIGHT;
    }
  }
  return {items: out, rows, height: top};
}

export const GRID_COLUMNS = 3;
/**
 * A card that is not mounted yet (so not measured) is assumed this tall when placing it. Cards with participant
 * rows run about 180-260 canvas px. Placement only: area membership keeps the shared CARD_HEIGHT, which the
 * server uses too.
 */
export const CARD_PLACE_HEIGHT = 260;
/** The mock's 300 × 300 grid: a 280 × 260 card with room around it. */
export const GRID_STEP = {x: 300, y: 300};
export const AREA_PADDING = 48;

/** Cards in rows of 3, 300×300 apart, with the grid's bounds centred on `centre` (canvas units). */
export function gridPlacement(channelIds: string[], centre: Point): {cards: {channelId: string; x: number; y: number}[]; bounds: Rect} {
  const columns = Math.min(GRID_COLUMNS, Math.max(1, channelIds.length)), rows = Math.max(1, Math.ceil(channelIds.length / GRID_COLUMNS));
  const w = (columns - 1) * GRID_STEP.x + DEFAULT_CARD_WIDTH, h = (rows - 1) * GRID_STEP.y + CARD_PLACE_HEIGHT;
  const x = Math.round(centre.x - w / 2), y = Math.round(centre.y - h / 2);
  return {
    cards: channelIds.map((channelId, i) => ({channelId, x: x + (i % GRID_COLUMNS) * GRID_STEP.x, y: y + Math.floor(i / GRID_COLUMNS) * GRID_STEP.y})),
    bounds: {x, y, w, h},
  };
}

/** The rect of a new area that wraps `bounds` with 48 px on every side. */
export const areaAround = (bounds: Rect, pad = AREA_PADDING): Rect => ({x: bounds.x - pad, y: bounds.y - pad, w: bounds.w + 2 * pad, h: bounds.h + 2 * pad});

/**
 * A chat dropped from the Loose chats drawer lands as a default-width card whose membership centre (the shared CARD_HEIGHT)
 * is the drop point, so it joins the area it was dropped on.
 */
export const dropPlacement = (at: Point, w = DEFAULT_CARD_WIDTH): Point => ({x: Math.round(at.x - w / 2), y: Math.round(at.y - CARD_HEIGHT / 2)});

/** A card already on the canvas. `h` is its measured height; unmeasured cards use CARD_PLACE_HEIGHT. */
export type Placed = {x: number; y: number; w: number; h?: number};

/** The space kept between a moved grid (or its area) and the card above it. */
export const PLACE_GAP = 40;
/**
 * How far down `rect` (a new grid, or the area around it) must move so it covers no existing card:
 * below the lowest card it overlaps plus a gap, again until it overlaps none. 0 when it is already clear.
 */
export function clearOfCards(rect: Rect, cards: Placed[], gap = PLACE_GAP): number {
  const taken = cards.map(card => ({x: card.x, y: card.y, w: card.w, h: card.h ?? CARD_PLACE_HEIGHT}));
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
 * Where chats dropped from the drawer land: one chat centred on the drop point, or several in the
 * 3-wide grid centred there, moved down below any existing card it would cover.
 */
export function dropLayout(channelIds: string[], at: Point, cards: Placed[]): {channelId: string; x: number; y: number}[] {
  if (channelIds.length === 1) return [{channelId: channelIds[0]!, ...dropPlacement(at)}];
  const first = gridPlacement(channelIds, at);
  const dy = clearOfCards(first.bounds, cards);
  return dy ? gridPlacement(channelIds, {x: at.x, y: at.y + dy}).cards : first.cards;
}

/** Room kept around other cards when a card is moved in from the chat header. */
const SLOT_MARGIN = PLACE_GAP / 2;
const SLOT_TRIES = 400;
const takenBy = (cards: Placed[]): Rect[] =>
  cards.map(card => ({x: card.x - SLOT_MARGIN, y: card.y - SLOT_MARGIN, w: card.w + 2 * SLOT_MARGIN, h: (card.h ?? CARD_PLACE_HEIGHT) + 2 * SLOT_MARGIN}));

/**
 * Where a card moved into an area goes: the first free grid spot under its title bar, row by row,
 * in as many columns as fit (at least one). Rows continue below the area, which then grows to fit.
 */
export function slotInArea(area: Rect, cards: Placed[], w = DEFAULT_CARD_WIDTH, h = CARD_PLACE_HEIGHT): Point {
  const columns = Math.max(1, Math.floor((area.w - 2 * AREA_FIT_PAD.side - w) / GRID_STEP.x) + 1);
  const taken = takenBy(cards);
  const spotAt = (i: number): Point => ({x: area.x + AREA_FIT_PAD.side + (i % columns) * GRID_STEP.x, y: area.y + AREA_FIT_PAD.top + Math.floor(i / columns) * GRID_STEP.y});
  for (let i = 0; i < SLOT_TRIES; i++) {
    const spot = spotAt(i);
    if (!taken.some(rect => overlaps(rect, {...spot, w, h}))) return spot;
  }
  return spotAt(SLOT_TRIES);
}

/**
 * Where a card taken out of an area goes: just right of that area, stepping down (then further
 * right) until it overlaps no area and no other card.
 */
export function slotOutsideAreas(home: Rect, areas: Rect[], cards: Placed[], w = DEFAULT_CARD_WIDTH, h = CARD_PLACE_HEIGHT): Point {
  const taken = [...takenBy(cards), ...areas];
  const start = {x: home.x + home.w + PLACE_GAP, y: home.y};
  const rows = SLOT_TRIES / 4, step = SLOT_MARGIN;
  for (let i = 0; i < SLOT_TRIES; i++) {
    const spot = {x: start.x + Math.floor(i / rows) * GRID_STEP.x, y: start.y + (i % rows) * step};
    if (!taken.some(rect => overlaps(rect, {...spot, w, h}))) return spot;
  }
  return {x: start.x + 4 * GRID_STEP.x, y: start.y};
}

/** The drawer's Archive: chats the person manages are archived for everyone, the rest hidden from their list. Order kept. */
export function archivePlan(ids: string[], manageable: (id: string) => boolean): {archive: string[]; hide: string[]} {
  return {archive: ids.filter(id => manageable(id)), hide: ids.filter(id => !manageable(id))};
}

/** What the drawer's Archive did: `Archived 3 · hid 1 you can't manage`, with any that could not be archived. */
export function archiveNotice(archived: number, hid: number, failed: number): string {
  const parts = [
    ...(archived ? [`Archived ${archived}`] : []),
    ...(hid ? [`hid ${hid} you can't manage`] : []),
    ...(failed ? [`${failed} could not be archived. Try again.`] : []),
  ];
  const text = parts.join(' · ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}
