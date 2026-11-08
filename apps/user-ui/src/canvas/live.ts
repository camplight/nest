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
const MAX_EVENTS_PER_CHANNEL = 400;
const SEEDS = [
  '/api/events?typePrefix=agent.turn.&order=desc&limit=1000',
  // Wrapped agents report their turns as wrapper.turn.*, which activeTurns reads too.
  '/api/events?typePrefix=wrapper.turn.&order=desc&limit=200',
  '/api/events?type=message.created&order=desc&limit=500',
];

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
  let cards = new Map<string, string[]>();
  let agents: Agent[] = [];
  let starts: AgentStarts = {};
  let mentions: MentionNotification[] = [];
  let pulses = new Map<string, CardPulse>();
  let dirty = new Set<string>();
  let all = false;
  let scheduled = false;
  let generation = 0;
  let inflight: EventRow[] | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  let mentionsTimer: ReturnType<typeof setTimeout> | null = null;

  function store(event: EventRow) {
    if (!event.channelId) return;
    let channel = events.get(event.channelId);
    if (!channel) events.set(event.channelId, channel = new Map());
    channel.set(event.id, event);
    if (channel.size > MAX_EVENTS_PER_CHANNEL) {
      const kept = [...channel.values()].sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0)).slice(0, MAX_EVENTS_PER_CHANNEL);
      events.set(event.channelId, new Map(kept.map(e => [e.id, e])));
    }
  }

  /** Recomputes the dirty channels (or all of them) and publishes only if a pulse changed. */
  function recompute() {
    const ids = all ? [...cards.keys()] : [...dirty].filter(id => cards.has(id));
    const removed = [...pulses.keys()].filter(id => !cards.has(id));
    all = false; dirty = new Set();
    if (!ids.length && !removed.length) return;
    const subset = ids.map(channelId => ({channelId, agentNames: cards.get(channelId)!}));
    const rows = ids.flatMap(id => [...(events.get(id)?.values() ?? [])]);
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
    inflight = [];
    const [turnRows, wrapperRows, messageRows, nextStarts, nextAgents, nextMentions] = await Promise.allSettled([
      fetchJson<EventRow[]>(SEEDS[0]),
      fetchJson<EventRow[]>(SEEDS[1]),
      fetchJson<EventRow[]>(SEEDS[2]),
      fetchAgentStarts(fetchJson),
      fetchJson<Agent[]>('/api/agents'),
      fetchJson<{items: MentionNotification[]}>('/api/mentions'),
    ]);
    if (mine !== generation) return;
    const live = inflight ?? [];
    inflight = null;
    const seeded = [turnRows, wrapperRows, messageRows];
    // A full seed replaces what was held, so turns that ended while the canvas was closed do not linger.
    if (seeded.every(r => r.status === 'fulfilled')) events.clear();
    for (const result of seeded) if (result.status === 'fulfilled' && Array.isArray(result.value)) result.value.forEach(store);
    live.forEach(store);
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
      if (!event.channelId) return;
      store(event);
      inflight?.push(event);
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
