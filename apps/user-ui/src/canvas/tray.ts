// Who the agents tray and the All agents picker show. Pure: the tray, picker and their tests share it.
import {areaFor,type BoardCard,type CanvasArea} from '@nest/schemas';
import type {Agent} from '../types';
import {rankMentions} from '../mentions';
import {areaMembers,cardCentre} from './geometry';

/** The pinned tray never shows more faces than this; "All agents" holds the rest. */
export const TRAY_MAX = 8;
export type TrayAgent = Agent & {suggested: boolean};
export type OwnerFilter = 'all' | 'yours' | 'team';

const byName = (a: Agent, b: Agent) => a.name.localeCompare(b.name);
const agentsIn = (card: BoardCard | undefined) =>
  card?.access === 'open' ? card.participants.filter(p => p.subscriberType === 'AGENT').map(p => p.subscriberId) : [];

/** Agent names in the open cards of an area, nested areas included (the cards that travel with it). */
export function areaAgentNames(areaId: string, cards: BoardCard[], areas: CanvasArea[]): Set<string> {
  const members = areaMembers(areaId, cards, areas).cards;
  return new Set(cards.filter(card => members.has(card.channelId)).flatMap(agentsIn));
}

/**
 * The pinned tray: for the selected card, the agents in its area's other cards who are not in it
 * (suggestions), then the person's own agents by name, up to TRAY_MAX. Only roster agents appear.
 * The engine gives only private agents an owner, so free places go to the team's agents by name.
 */
export function trayAgents({agents, humanId, cards, areas, selectedId}: {
  agents: Agent[]; humanId: string; cards: BoardCard[]; areas: CanvasArea[]; selectedId: string | null;
}): TrayAgent[] {
  const selected = cards.find(card => card.channelId === selectedId && card.access === 'open');
  const present = new Set(agentsIn(selected));
  const roster = new Map(agents.map(agent => [agent.name, agent]));
  const area = selected ? areaFor(cardCentre(selected), areas) : null;
  const nearby = area ? areaAgentNames(area.id, cards, areas) : new Set<string>();
  const suggested = [...nearby].filter(name => !present.has(name)).flatMap(name => roster.get(name) ?? []).sort(byName);
  const shown = new Set(suggested.map(agent => agent.name));
  const rest = agents.filter(agent => !present.has(agent.name) && !shown.has(agent.name));
  const mine = (agent: Agent) => Boolean(humanId) && agent.ownerHumanId === humanId;
  const own = rest.filter(mine).sort(byName), team = rest.filter(agent => !mine(agent)).sort(byName);
  return [...suggested.map(agent => ({...agent, suggested: true})), ...[...own, ...team].map(agent => ({...agent, suggested: false}))].slice(0, TRAY_MAX);
}

/** The picker: owner filter, optional area limit, then a search ranked like @mentions (by name without one). */
export function pickerAgents({agents, humanId, query, owner, inArea}: {
  agents: Agent[]; humanId: string; query: string; owner: OwnerFilter; inArea: ReadonlySet<string> | null;
}): Agent[] {
  const mine = (agent: Agent) => Boolean(humanId) && agent.ownerHumanId === humanId;
  const kept = agents.filter(agent => (owner === 'all' || (owner === 'yours') === mine(agent)) && (!inArea || inArea.has(agent.name)));
  if (!query.trim()) return kept.sort(byName);
  const byKey = new Map(kept.map(agent => [agent.name, agent]));
  return rankMentions(kept.map(agent => ({id: agent.name, name: agent.name, kind: 'Agent' as const, inConversation: false})), query.trim())
    .flatMap(candidate => byKey.get(candidate.name) ?? []);
}
