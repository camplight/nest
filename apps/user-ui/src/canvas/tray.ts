// Who the agents tray and the All agents picker show. Pure: the tray, picker and their tests share it.
import {AGENT_PIN_MAX,areaFor,type BoardCard,type CanvasArea} from '@nest/schemas';
import type {Agent} from '../types';
import {rankMentions} from '../mentions';
import {areaMembers,cardCentre} from './geometry';
import type {CardPulse} from './pulse';

/** The tray leads with at most this many suggestions for the selected chat, as in the mock. */
export const SUGGESTION_MAX = 3;
export type TrayAgents = {suggested: Agent[]; pinned: Agent[]};
export type PickerFilter = 'all' | 'yours' | 'free' | 'working';
export type PickerGroup = {label: string; agents: Agent[]};

const byName = (a: Agent, b: Agent) => a.name.localeCompare(b.name);
const agentsIn = (card: BoardCard | undefined) =>
  card?.access === 'open' ? card.participants.filter(p => p.subscriberType === 'AGENT').map(p => p.subscriberId) : [];
const owns = (humanId: string) => (agent: Agent) => Boolean(humanId) && agent.ownerHumanId === humanId;

/** Agent names in the open cards of an area, nested areas included (the cards that travel with it). */
export function areaAgentNames(areaId: string, cards: BoardCard[], areas: CanvasArea[]): Set<string> {
  const members = areaMembers(areaId, cards, areas).cards;
  return new Set(cards.filter(card => members.has(card.channelId)).flatMap(agentsIn));
}

/**
 * The pins before a person saves any: their own agents by name, then the team's by name, up to the pin limit,
 * so a new person never sees an empty tray. The engine may give public agents an owner too.
 */
export function seedPins(agents: Agent[], humanId: string): string[] {
  const mine = owns(humanId);
  return [...agents.filter(mine).sort(byName), ...agents.filter(agent => !mine(agent)).sort(byName)].slice(0, AGENT_PIN_MAX).map(agent => agent.name);
}

/**
 * The pin list the person sees and stars: their saved pins, or the seed until they save any (the seeded agents
 * count as pinned). Empty while the saved pins are still loading, so they never flash the seed first.
 */
export function effectivePins(saved: {agentNames: readonly string[]; saved: boolean} | null, agents: Agent[], humanId: string): string[] {
  if (!saved) return [];
  return saved.saved ? [...saved.agentNames] : seedPins(agents, humanId);
}

/**
 * One star press on the visible pin list: unstarring removes that agent and keeps the rest, starring appends.
 * Null when it would pass the pin limit (the caller shows the limit notice and saves nothing).
 */
export function togglePin(current: readonly string[], name: string): string[] | null {
  if (current.includes(name)) return current.filter(pin => pin !== name);
  return current.length >= AGENT_PIN_MAX ? null : [...current, name];
}

/**
 * The tray: for the selected card, up to SUGGESTION_MAX agents from its area's other cards who are not in it,
 * then the person's pins in their order (see effectivePins), minus those suggested.
 * Only roster agents appear, so a pin for an agent that is gone or no longer visible drops out silently.
 */
export function trayAgents({agents, cards, areas, selectedId, pins}: {
  agents: Agent[]; cards: BoardCard[]; areas: CanvasArea[]; selectedId: string | null; pins: readonly string[];
}): TrayAgents {
  const selected = cards.find(card => card.channelId === selectedId && card.access === 'open');
  const present = new Set(agentsIn(selected));
  const roster = new Map(agents.map(agent => [agent.name, agent]));
  const area = selected ? areaFor(cardCentre(selected), areas) : null;
  const nearby = area ? areaAgentNames(area.id, cards, areas) : new Set<string>();
  const suggested = [...nearby].filter(name => !present.has(name)).flatMap(name => roster.get(name) ?? []).sort(byName).slice(0, SUGGESTION_MAX);
  const shown = new Set(suggested.map(agent => agent.name));
  const pinned = pins.filter(name => !shown.has(name)).flatMap(name => roster.get(name) ?? []);
  return {suggested, pinned};
}

/** Placed cards on this canvas where each agent is a participant and working right now (live pulses). */
export function busyCounts(cards: BoardCard[], pulses: ReadonlyMap<string, CardPulse>): Map<string, number> {
  const counts = new Map<string, number>();
  for (const card of cards) {
    const members = new Set(agentsIn(card));
    for (const agent of pulses.get(card.channelId)?.agents ?? [])
      if (agent.state === 'working' && members.has(agent.name)) counts.set(agent.name, (counts.get(agent.name) ?? 0) + 1);
  }
  return counts;
}
/** `in 2 chats` or `free`. */
export const busyLabel = (count: number) => count ? `in ${count} chat${count === 1 ? '' : 's'}` : 'free';

/**
 * The picker: the chip filter and optional area limit, then a search over name (ranked like @mentions),
 * role (the engine description) and owner name, then groups by owner: `Yours` first, then `{owner}'s team` (or `Team`
 * for an agent without a known owner) by label. Rows keep the search rank within a group, else go by name.
 */
export function pickerGroups({agents, humanId, owners, query, filter, inArea, busy}: {
  agents: Agent[]; humanId: string; owners: ReadonlyMap<string, string>; query: string; filter: PickerFilter;
  inArea: ReadonlySet<string> | null; busy: ReadonlyMap<string, number>;
}): PickerGroup[] {
  const mine = owns(humanId);
  const kept = agents.filter(agent => (!inArea || inArea.has(agent.name)) && (
    filter === 'all' || (filter === 'yours' && mine(agent)) || (filter === 'free' && !busy.get(agent.name)) || (filter === 'working' && Boolean(busy.get(agent.name)))));
  const q = query.trim();
  let ordered = [...kept].sort(byName);
  if (q) {
    const byKey = new Map(kept.map(agent => [agent.name, agent]));
    const ranked = rankMentions(kept.map(agent => ({id: agent.name, name: agent.name, kind: 'Agent' as const, inConversation: false})), q)
      .flatMap(candidate => byKey.get(candidate.name) ?? []);
    const named = new Set(ranked.map(agent => agent.name)), needle = q.toLowerCase();
    const other = ordered.filter(agent => !named.has(agent.name) && [agent.description ?? '', owners.get(agent.ownerHumanId ?? '') ?? '']
      .join(' ').toLowerCase().includes(needle));
    ordered = [...ranked, ...other];
  }
  const groups = new Map<string, Agent[]>();
  for (const agent of ordered) {
    const owner = agent.ownerHumanId ? owners.get(agent.ownerHumanId) : undefined;
    const label = mine(agent) ? 'Yours' : owner ? `${owner}'s team` : 'Team';
    groups.set(label, [...groups.get(label) ?? [], agent]);
  }
  return [...groups].map(([label, list]) => ({label, agents: list}))
    .sort((a, b) => a.label === 'Yours' ? -1 : b.label === 'Yours' ? 1 : a.label.localeCompare(b.label));
}
