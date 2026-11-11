// What each card's chat is doing right now, derived from engine events. Turn state comes from the
// chat's own activeTurns classification (Nest #74); this file only maps it onto card wording.
import {areaFor,type CanvasArea,type MentionNotification} from '@nest/schemas';
import type {Agent,EventRow} from '../types';
import {parseMessageAttachments} from '../chat/timeline';
import {activeTurns} from '../chat/working';
import type {AgentStarts} from '../chat/lifecycles';
import {cardCentre,contains} from './geometry';
import type {AreaSummary} from './Area';
import {summarise,type AppCall,type AppSummary} from '../app-activity';

/** An agent mid-turn with no signal for this long reads as quiet (a possible hang). */
export const QUIET_AFTER_MS = 20 * 60_000;
const MAX_ARTIFACTS = 6;

/** The app an agent is using right now: the app's name and the action's name only, never a command, argument or output. */
export type AppNow = Pick<AppCall, 'app' | 'appName' | 'action'>;
export type AgentPulse = {
  name: string; state: 'working' | 'quiet' | 'interrupted' | 'done' | 'failed' | 'idle' | 'unavailable'; since: number; quietMinutes?: number;
  /** The open turn's latest progress line (codex-progress or wrapped-progress), for working, quiet and interrupted turns. */
  activity?: string;
  /** The newest app call this agent has running here, while its turn is open. */
  app?: AppNow;
  /** The first line of the agent's latest message here. */
  said?: string;
};
/** A person who posted in the loaded history: their latest message's first line and how many files it carried. */
export type PersonPulse = {name: string; at: number; said: string; files: number};
export type CardPulse = {agents: AgentPulse[]; people: PersonPulse[]; lastActivityAt: number | null; artifacts: {fileId: string; name: string; mime?: string}[]; needsYou: {kind: 'mention'; id: string; at: number; sender: string; text: string}[]; apps: AppSummary};
export type PulseCard = {channelId: string; agentNames: string[]};
export type PulseInput = {events: EventRow[]; agents: Agent[]; starts: AgentStarts; mentions: MentionNotification[]; cards: PulseCard[]; now: number; /** Classified app calls per channel (see app-activity.ts). */ apps?: ReadonlyMap<string, AppCall[]>};

const ENDINGS: Record<string, 'done' | 'failed'> = {
  'agent.turn.completed': 'done', 'wrapper.turn.completed': 'done',
  'agent.turn.failed': 'failed', 'wrapper.turn.failed': 'failed',
};
const at = (event: EventRow) => event.createdAt ?? 0;
const record = (payload: unknown) => payload && typeof payload === 'object' ? payload as Record<string, unknown> : {};

/**
 * The agent an event is a signal from: its own events, or the runner's wrapper events naming it.
 * A human's message that targets the agent (a Nudge, say) is not a signal from it.
 */
function signalFrom(event: EventRow) {
  if (event.source.startsWith('agent:')) return event.source.slice(6);
  const target = record(event.payload).targetAgentName;
  return event.source.startsWith('system:runner') && typeof target === 'string' ? target : '';
}
/** A message or progress text as one short line: its first non-empty line, without leading Markdown marks, at most 140 characters. */
export function oneLine(text: unknown) {
  if (typeof text !== 'string') return '';
  const line = text.split(/\r?\n/).map(part => part.replace(/^[\s#>*+-]+/, '').replace(/[*_`]+/g, '').replace(/\s+/g, ' ').trim()).find(Boolean) ?? '';
  return line.length > 140 ? `${line.slice(0, 139).trimEnd()}…` : line;
}
const unavailable = (agent: Agent | undefined) =>
  Boolean(agent && (agent.desiredState === 'STOPPED' || agent.runtimeState === 'STOPPED' || agent.runtimeState === 'CRASHED'));

function channelPulse(events: EventRow[], card: PulseCard, input: PulseInput, byName: Map<string, Agent>): CardPulse {
  const turns = activeTurns(events, input.agents, input.starts);
  const latestSignal = new Map<string, number>(), latestEnding = new Map<string, EventRow>();
  const lastSaid = new Map<string, EventRow>();
  let lastActivityAt: number | null = null;
  const messages: EventRow[] = [];
  for (const event of events) {
    const agent = signalFrom(event);
    if (agent) {
      latestSignal.set(agent, Math.max(latestSignal.get(agent) ?? 0, at(event)));
      const previous = latestEnding.get(agent);
      if (ENDINGS[event.type] && (!previous || at(event) >= at(previous))) latestEnding.set(agent, event);
    }
    if (event.type === 'message.created') {
      messages.push(event);
      lastActivityAt = Math.max(lastActivityAt ?? 0, at(event));
      const previous = lastSaid.get(event.source);
      if (!previous || at(event) >= at(previous)) lastSaid.set(event.source, event);
    }
  }
  // The newest running call per agent; finished and failed calls are counted in `apps`, never shown as live.
  const running = new Map<string, AppCall>();
  for (const call of input.apps?.get(card.channelId) ?? []) {
    const previous = running.get(call.agent);
    if (call.state === 'running' && (!previous || call.at >= previous.at)) running.set(call.agent, call);
  }
  const saidBy = (source: string) => oneLine(record(lastSaid.get(source)?.payload).text);

  const agents = [...new Set(card.agentNames)].map((name): AgentPulse => {
    const turn = turns.filter(t => t.agent === name).at(-1);
    const said = saidBy(`agent:${name}`);
    // Optional fields appear only when known, so an unchanged pulse serialises the same.
    const extra = (fields: Partial<AgentPulse>) => Object.fromEntries(Object.entries({...fields, said}).filter(([, value]) => value)) as Partial<AgentPulse>;
    const activity = oneLine(turn?.progressText);
    if (turn?.interrupted) return {name, state: 'interrupted', since: turn.since, ...extra({activity})};
    if (turn) {
      const signal = Math.max(turn.since, latestSignal.get(name) ?? 0);
      const call = running.get(name);
      const app = call ? {app: call.app, appName: call.appName, action: call.action} : undefined;
      return input.now - signal > QUIET_AFTER_MS
        ? {name, state: 'quiet', since: signal, quietMinutes: Math.floor((input.now - signal) / 60_000), ...extra({activity})}
        : {name, state: 'working', since: turn.since, ...extra({activity, app})};
    }
    const row = byName.get(name);
    if (unavailable(row)) return {name, state: 'unavailable', since: row?.updatedAt ?? 0, ...extra({})};
    const ending = latestEnding.get(name);
    return ending ? {name, state: ENDINGS[ending.type], since: at(ending), ...extra({})} : {name, state: 'idle', since: 0, ...extra({})};
  });
  const people: PersonPulse[] = [...lastSaid].flatMap(([source, event]) => source.startsWith('human:')
    ? [{name: source.slice(6), at: at(event), said: saidBy(source), files: parseMessageAttachments(event.payload).length}] : []);

  const artifacts: CardPulse['artifacts'] = [], files = new Set<string>();
  for (const event of messages.sort((a, b) => at(b) - at(a))) {
    for (const {fileId, name, mime} of parseMessageAttachments(event.payload)) {
      if (files.has(fileId)) continue;
      files.add(fileId);
      artifacts.push(mime === undefined ? {fileId, name} : {fileId, name, mime});
      if (artifacts.length === MAX_ARTIFACTS) break;
    }
    if (artifacts.length === MAX_ARTIFACTS) break;
  }

  const needsYou = input.mentions
    .filter(m => m.channelId === card.channelId && m.readAt == null)
    .sort((a, b) => b.createdAt - a.createdAt)
    .map(m => ({kind: 'mention' as const, id: m.id, at: m.createdAt, sender: m.sender, text: m.text}));

  return {agents, people, lastActivityAt, artifacts, needsYou, apps: summarise(input.apps?.get(card.channelId) ?? [])};
}

/** One pulse per card. Events from channels that are not cards are ignored. */
export function cardPulse(input: PulseInput): Map<string, CardPulse> {
  const byChannel = new Map<string, EventRow[]>(input.cards.map(card => [card.channelId, []]));
  for (const event of input.events) if (event.channelId) byChannel.get(event.channelId)?.push(event);
  const byName = new Map(input.agents.map(agent => [agent.name, agent]));
  const result = new Map<string, CardPulse>();
  for (const card of input.cards) result.set(card.channelId, channelPulse(byChannel.get(card.channelId)!, card, input, byName));
  return result;
}

/**
 * Compact-zoom counts per area: cards that need you, cards with an agent working and cards with an agent gone quiet
 * (a card can count in more than one). A card counts for the area that holds its centre and for every area around that one.
 * `needs` holds each card's Needs you items (mentions and reviews); without it a card's unread mentions count.
 */
export function areaSummaries(cards: {channelId: string; x: number; y: number; w: number}[], areas: CanvasArea[], pulses: ReadonlyMap<string, CardPulse>,
  needs?: ReadonlyMap<string, readonly unknown[]>): Map<string, AreaSummary> {
  const zero = (): AreaSummary => ({needYou: 0, moving: 0, quiet: 0, chats: 0});
  const direct = new Map<string, AreaSummary>(areas.map(area => [area.id, zero()]));
  for (const card of cards) {
    const owner = areaFor(cardCentre(card), areas);
    const counts = owner && direct.get(owner.id);
    if (!counts) continue;
    counts.chats++;
    const pulse = pulses.get(card.channelId);
    if ((needs ? needs.get(card.channelId)?.length ?? 0 : pulse?.needsYou.length ?? 0) > 0) counts.needYou++;
    if (pulse?.agents.some(agent => agent.state === 'working')) counts.moving++;
    if (pulse?.agents.some(agent => agent.state === 'quiet')) counts.quiet++;
  }
  const result = new Map<string, AreaSummary>();
  for (const area of areas) {
    const total = zero();
    for (const other of areas) {
      if (other.id !== area.id && !contains(area, other)) continue;
      const counts = direct.get(other.id)!;
      total.needYou += counts.needYou; total.moving += counts.moving; total.quiet += counts.quiet; total.chats += counts.chats;
    }
    result.set(area.id, total);
  }
  return result;
}
