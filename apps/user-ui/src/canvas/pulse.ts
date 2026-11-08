// What each card's chat is doing right now, derived from engine events. Turn state comes from the
// chat's own activeTurns classification (Nest #74); this file only maps it onto card wording.
import {areaFor,type CanvasArea,type MentionNotification} from '@nest/schemas';
import type {Agent,EventRow} from '../types';
import {parseMessageAttachments} from '../chat/timeline';
import {activeTurns} from '../chat/working';
import type {AgentStarts} from '../chat/lifecycles';
import {cardCentre,contains} from './geometry';
import type {AreaSummary} from './Area';

/** An agent mid-turn with no signal for this long reads as quiet (a possible hang). */
export const QUIET_AFTER_MS = 20 * 60_000;
const MAX_ARTIFACTS = 6;

export type AgentPulse = {name: string; state: 'working' | 'quiet' | 'interrupted' | 'done' | 'failed' | 'idle' | 'unavailable'; since: number; quietMinutes?: number};
export type CardPulse = {agents: AgentPulse[]; lastActivityAt: number | null; artifacts: {fileId: string; name: string; mime?: string}[]; needsYou: {kind: 'mention'; id: string; at: number}[]};
export type PulseCard = {channelId: string; agentNames: string[]};
export type PulseInput = {events: EventRow[]; agents: Agent[]; starts: AgentStarts; mentions: MentionNotification[]; cards: PulseCard[]; now: number};

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
const unavailable = (agent: Agent | undefined) =>
  Boolean(agent && (agent.desiredState === 'STOPPED' || agent.runtimeState === 'STOPPED' || agent.runtimeState === 'CRASHED'));

function channelPulse(events: EventRow[], card: PulseCard, input: PulseInput, byName: Map<string, Agent>): CardPulse {
  const turns = activeTurns(events, input.agents, input.starts);
  const latestSignal = new Map<string, number>(), latestEnding = new Map<string, EventRow>();
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
    }
  }

  const agents = [...new Set(card.agentNames)].map((name): AgentPulse => {
    const turn = turns.filter(t => t.agent === name).at(-1);
    if (turn?.interrupted) return {name, state: 'interrupted', since: turn.since};
    if (turn) {
      const signal = Math.max(turn.since, latestSignal.get(name) ?? 0);
      return input.now - signal > QUIET_AFTER_MS
        ? {name, state: 'quiet', since: signal, quietMinutes: Math.floor((input.now - signal) / 60_000)}
        : {name, state: 'working', since: turn.since};
    }
    const row = byName.get(name);
    if (unavailable(row)) return {name, state: 'unavailable', since: row?.updatedAt ?? 0};
    const ending = latestEnding.get(name);
    return ending ? {name, state: ENDINGS[ending.type], since: at(ending)} : {name, state: 'idle', since: 0};
  });

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
    .map(m => ({kind: 'mention' as const, id: m.id, at: m.createdAt}));

  return {agents, lastActivityAt, artifacts, needsYou};
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
 * Compact-zoom counts per area: cards that need you, and cards with an agent working. A card counts
 * for the area that holds its centre and for every area around that one.
 */
export function areaSummaries(cards: {channelId: string; x: number; y: number; w: number}[], areas: CanvasArea[], pulses: ReadonlyMap<string, CardPulse>): Map<string, AreaSummary> {
  const direct = new Map<string, AreaSummary>(areas.map(area => [area.id, {needYou: 0, moving: 0}]));
  for (const card of cards) {
    const pulse = pulses.get(card.channelId);
    if (!pulse) continue;
    const needs = pulse.needsYou.length > 0, moving = pulse.agents.some(agent => agent.state === 'working');
    if (!needs && !moving) continue;
    const owner = areaFor(cardCentre(card), areas);
    const counts = owner && direct.get(owner.id);
    if (!counts) continue;
    if (needs) counts.needYou++;
    if (moving) counts.moving++;
  }
  const result = new Map<string, AreaSummary>();
  for (const area of areas) {
    const total = {needYou: 0, moving: 0};
    for (const other of areas) {
      if (other.id !== area.id && !contains(area, other)) continue;
      const counts = direct.get(other.id)!;
      total.needYou += counts.needYou; total.moving += counts.moving;
    }
    result.set(area.id, total);
  }
  return result;
}
