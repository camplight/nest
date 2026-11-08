// Live card state for the canvas: seeds engine events over HTTP, takes realtime events from App's
// WebSocket fan-out, and publishes one CardPulse per covered chat (board cards now, loose chats later).
import type {MentionNotification, SendMessage} from '@nest/schemas';
import type {Agent,EventRow} from '../types';
import {agentLifecycleStart,fetchAgentStarts,mergeAgentStarts,type AgentStarts} from '../chat/lifecycles';
import {cardPulse,type CardPulse,type PulseCard} from './pulse';

export type CanvasLive = {
  subscribe(listener: () => void): () => void;
  snapshot(): Map<string, CardPulse>;
  /** The chats to keep pulses for. Any list of channels with their agents: board cards, loose chats. */
  setCards(cards: PulseCard[]): void;
  ingest(event: EventRow): void;
  refresh(): Promise<void>;
  /** Refresh now, then every 30 s while the page is visible and on focus, until stop(). */
  start(): void;
  stop(): void;
};
type FetchJson = <T>(url: string) => Promise<T>;
export type CanvasLiveOptions = {
  fetchJson: FetchJson;
  now(): number;
  /** Schedules one coalesced recompute; requestAnimationFrame by default. */
  frame?(callback: () => void): void;
  intervalMs?: number;
  doc?: Document;
  win?: Window;
};

const REFRESH_MS = 30_000;
const MENTIONS_DELAY_MS = 1500;
// Enough history per chat to find the open turn, the latest ending and the newest artifacts.
// Over the cap a channel is trimmed back to TRIM_TO, progress phases first, so a start is not evicted.
const MAX_EVENTS_PER_CHANNEL = 400;
const TRIM_TO = 300;
/** Kept in full, per channel. Each seed's page also sets how far back a refresh can vouch for its kind. */
const SEEDS = [
  {url: '/api/events?typePrefix=agent.turn.&order=desc&limit=1000', limit: 1000, prefix: 'agent.turn.'},
  // Wrapped agents report their turns as wrapper.turn.*, which activeTurns reads too.
  {url: '/api/events?typePrefix=wrapper.turn.&order=desc&limit=200', limit: 200, prefix: 'wrapper.turn.'},
  {url: '/api/events?type=message.created&order=desc&limit=500', limit: 500, prefix: 'message.created'},
];
/**
 * A native turn's mid-turn signals are its tool events. Only their timestamps matter, so each is kept
 * stripped (toSignal) and only the latest per channel and agent.
 */
const TOOL_SEED = '/api/events?typePrefix=tool.&order=desc&limit=500';
const at = (event: EventRow) => event.createdAt ?? 0;
const kindOf = (type: string) => SEEDS.findIndex(seed => type.startsWith(seed.prefix));

/** What a signal keeps of an agent event: no payload, so tool arguments and output never sit in memory. */
export function toSignal({id, type, source, channelId, createdAt}: EventRow): EventRow {
  return {id, type, source, channelId, createdAt};
}

const NUDGE_TEXT = 'are you still on this? Please post a short status update.';
/** A Nudge: a message targeted at the agent with a leading mention of it, through the normal send path. */
export function nudgeMessage(channelId: string, name: string, id: string = crypto.randomUUID()): SendMessage {
  return {id, channelId, text: `@${name} ${NUDGE_TEXT}`, mentions: [{kind: 'AGENT', name, start: 0, end: name.length + 1}], attachments: [], targetAgentName: name};
}

const samePulse = (a: CardPulse | undefined, b: CardPulse) => a !== undefined && JSON.stringify(a) === JSON.stringify(b);
const sameNames = (a: string[] | undefined, b: string[]) => a !== undefined && a.length === b.length && a.every((name, i) => name === b[i]);

export function createCanvasLive({fetchJson, now, frame, intervalMs = REFRESH_MS, doc = globalThis.document, win = globalThis.window}: CanvasLiveOptions): CanvasLive {
  const schedule = frame ?? ((callback: () => void) => {
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(callback); else setTimeout(callback, 16);
  });
  const listeners = new Set<() => void>();
  const events = new Map<string, Map<string, EventRow>>();
  /** channel → agent → that agent's latest stripped signal there. */
  const signals = new Map<string, Map<string, EventRow>>();
  let cards = new Map<string, string[]>();
  let agents: Agent[] = [];
  let starts: AgentStarts = {};
  let mentions: MentionNotification[] = [];
  let pulses = new Map<string, CardPulse>();
  let dirty = new Set<string>();
  let all = false;
  let scheduled = false;
  let generation = 0;
  let timer: ReturnType<typeof setInterval> | null = null;
  let mentionsTimer: ReturnType<typeof setTimeout> | null = null;

  function storeEvent(channelId: string, event: EventRow) {
    let channel = events.get(channelId);
    if (!channel) events.set(channelId, channel = new Map());
    channel.set(event.id, event);
    if (channel.size <= MAX_EVENTS_PER_CHANNEL) return;
    const newest = (rows: EventRow[]) => rows.sort((a, b) => at(b) - at(a));
    const rows = [...channel.values()];
    const others = newest(rows.filter(e => e.type !== 'agent.turn.phase')).slice(0, TRIM_TO);
    const phases = newest(rows.filter(e => e.type === 'agent.turn.phase')).slice(0, TRIM_TO - others.length);
    events.set(channelId, new Map([...others, ...phases].map(e => [e.id, e])));
  }

  /** Keeps what the pulses read; returns false for anything else. */
  function store(event: EventRow) {
    const channelId = event.channelId;
    if (!channelId) return false;
    if (kindOf(event.type) >= 0) { storeEvent(channelId, event); return true; }
    if (!event.source.startsWith('agent:')) return false;
    const agent = event.source.slice(6);
    let channel = signals.get(channelId);
    if (!channel) signals.set(channelId, channel = new Map());
    const previous = channel.get(agent);
    if (!previous || at(event) >= at(previous)) channel.set(agent, toSignal(event));
    return true;
  }

  /** Recomputes the dirty channels (or all of them) and publishes only if a pulse changed. */
  function recompute() {
    const ids = all ? [...cards.keys()] : [...dirty].filter(id => cards.has(id));
    const removed = [...pulses.keys()].filter(id => !cards.has(id));
    all = false; dirty = new Set();
    if (!ids.length && !removed.length) return;
    const subset = ids.map(channelId => ({channelId, agentNames: cards.get(channelId)!}));
    const rows = ids.flatMap(id => [...(events.get(id)?.values() ?? []), ...(signals.get(id)?.values() ?? [])]);
    const fresh = cardPulse({events: rows, agents, starts, mentions, cards: subset, now: now()});
    let next: Map<string, CardPulse> | null = null;
    for (const [id, pulse] of fresh) {
      if (samePulse(pulses.get(id), pulse)) continue;
      (next ??= new Map(pulses)).set(id, pulse);
    }
    for (const id of removed) (next ??= new Map(pulses)).delete(id);
    if (!next) return;
    pulses = next;
    for (const listener of [...listeners]) listener();
  }

  function mark(id: string | 'all') {
    if (id === 'all') all = true; else dirty.add(id);
    if (scheduled) return;
    scheduled = true;
    schedule(() => { scheduled = false; recompute(); });
  }

  async function loadMentions() {
    try {
      const result = await fetchJson<{items: MentionNotification[]}>('/api/mentions');
      if (!Array.isArray(result.items)) return;
      mentions = result.items;
      mark('all');
    } catch {}
  }

  async function refresh() {
    const mine = ++generation;
    const [turnRows, wrapperRows, messageRows, toolRows, nextStarts, nextAgents, nextMentions] = await Promise.allSettled([
      fetchJson<EventRow[]>(SEEDS[0].url),
      fetchJson<EventRow[]>(SEEDS[1].url),
      fetchJson<EventRow[]>(SEEDS[2].url),
      fetchJson<EventRow[]>(TOOL_SEED),
      fetchAgentStarts(fetchJson),
      fetchJson<Agent[]>('/api/agents'),
      fetchJson<{items: MentionNotification[]}>('/api/mentions'),
    ]);
    if (mine !== generation) return;
    const pages = [turnRows, wrapperRows, messageRows].map(result => result.status === 'fulfilled' && Array.isArray(result.value) ? result.value : null);
    // A full page vouches for its kind back to its oldest row; a short page for all of it. A failed page
    // vouches for nothing, so everything held of that kind is kept.
    const horizons = pages.map((page, i) => page && page.length >= SEEDS[i].limit ? page.reduce((oldest, e) => Math.min(oldest, at(e)), Infinity) : -Infinity);
    // The seed replaces held events it vouches for, so a turn that ended while the canvas was closed does not
    // linger. Held events newer than the horizon (live ones, and any ingested during this fetch) are merged back by id.
    const held = [...events.values()].flatMap(channel => [...channel.values()]);
    events.clear();
    for (const page of pages) page?.forEach(store);
    for (const event of held) {
      const kind = kindOf(event.type);
      if (kind >= 0 && at(event) >= horizons[kind]) storeEvent(event.channelId!, event);
    }
    // Signals only ever move forward: a refresh never takes one back.
    if (toolRows.status === 'fulfilled' && Array.isArray(toolRows.value)) toolRows.value.forEach(store);
    if (nextStarts.status === 'fulfilled') starts = mergeAgentStarts(starts, nextStarts.value);
    if (nextAgents.status === 'fulfilled' && Array.isArray(nextAgents.value)) agents = nextAgents.value;
    if (nextMentions.status === 'fulfilled' && Array.isArray(nextMentions.value.items)) mentions = nextMentions.value.items;
    all = true;
    recompute();
  }

  const visible = () => !doc || doc.visibilityState !== 'hidden';
  const onFocus = () => void refresh();
  const onVisibility = () => { if (visible()) void refresh(); };

  return {
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    snapshot: () => pulses,
    setCards(list) {
      const next = new Map(list.map(card => [card.channelId, card.agentNames]));
      for (const [id, names] of next) if (!sameNames(cards.get(id), names)) mark(id);
      const removed = [...cards.keys()].filter(id => !next.has(id));
      cards = next;
      // recompute() drops pulses for channels that are no longer covered.
      for (const id of removed) mark(id);
    },
    ingest(event) {
      if (!event?.id) return;
      const start = agentLifecycleStart(event);
      if (start) {
        const merged = mergeAgentStarts(starts, {[start.agent]: start.at});
        if (merged !== starts) { starts = merged; mark('all'); }
        return;
      }
      if (!event.channelId || !store(event)) return;
      if (event.type === 'message.created') {
        if (mentionsTimer) clearTimeout(mentionsTimer);
        mentionsTimer = setTimeout(() => { mentionsTimer = null; void loadMentions(); }, MENTIONS_DELAY_MS);
      }
      if (cards.has(event.channelId)) mark(event.channelId);
    },
    refresh,
    start() {
      if (timer) return;
      void refresh();
      timer = setInterval(() => { if (visible()) void refresh(); }, intervalMs);
      win?.addEventListener('focus', onFocus);
      doc?.addEventListener('visibilitychange', onVisibility);
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
      if (mentionsTimer) clearTimeout(mentionsTimer);
      mentionsTimer = null;
      win?.removeEventListener('focus', onFocus);
      doc?.removeEventListener('visibilitychange', onVisibility);
    },
  };
}
