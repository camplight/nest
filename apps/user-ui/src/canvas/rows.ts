// A card's participant rows (the mock's `partRow`): one per agent and per person, with what they are doing now
// and a state dot. Pure; no DOM.
import type {AgentPulse,AppNow,CardPulse} from './pulse';
import type {NeedsItem} from './needs';

export type RowState = AgentPulse['state'] | 'waiting' | 'posted';
export type ParticipantRow = {
  kind: 'agent' | 'human';
  /** The engine name: an agent's name or a person's username. */
  name: string;
  /** What the row shows as the name: `You` for the viewer. */
  label: string;
  state: RowState;
  /** The live activity line; empty when nothing is known. */
  text: string;
  /** The app an agent is using right now (while working). */
  app: AppNow | null;
};
export type RowsInput = {
  participants: {subscriberType: string; subscriberId: string}[];
  pulse?: CardPulse;
  /** This chat's Needs you items, newest first. */
  needs: readonly NeedsItem[];
  /** The signed-in person's username. */
  viewer: string;
};

/** Rows shown on a card before `+N more`, as in the mock. */
export const MAX_ROWS = 4;

const files = (n: number) => `shared ${n} file${n === 1 ? '' : 's'}`;
/** The newest item from this participant, phrased for its row. */
const waitingText = (item: NeedsItem) => `${item.kind === 'review' ? 'needs your review' : 'needs you'} · ${item.reason}`;

function agentText(agent: AgentPulse): string {
  switch (agent.state) {
    case 'working': return agent.app ? `${agent.app.appName} · ${agent.app.action}` : agent.activity || 'working';
    case 'quiet': return `quiet for ${agent.quietMinutes ?? 0} min${agent.activity ? ` · last: ${agent.activity}` : ''}`;
    case 'interrupted': return 'stopped unexpectedly';
    case 'failed': return 'ran into an error';
    case 'unavailable': return 'unavailable';
    case 'done': return agent.said || 'done';
    default: return agent.said || 'idle';
  }
}

/**
 * Waiting on you: a participant waits on the viewer only when one of this chat's Needs you items (addressed to the viewer)
 * comes from them: an unread mention they sent, or a task of theirs awaiting the viewer's review. Message text is never
 * read for it. Waiting replaces only done, idle and "posted"; a live turn (working or quiet) and a problem (interrupted,
 * failed, unavailable) say more about the agent right now.
 */
const WAITS_OVER = new Set<RowState>(['done', 'idle', 'posted']);
/** Which rows stay when there are more than MAX_ROWS: the ones that most need a look. */
const PRIORITY: Record<RowState, number> = {waiting: 0, working: 1, quiet: 2, interrupted: 3, failed: 3, done: 4, posted: 4, unavailable: 5, idle: 6};

/** Every participant's row: agents in roster order, then people, with the viewer last. */
export function participantRows({participants, pulse, needs, viewer}: RowsInput): ParticipantRow[] {
  const newestFrom = new Map<string, NeedsItem>();
  // Mentions come from people and reviews from agents, so an agent and a person with the same name never mix.
  const whoFrom = (item: NeedsItem) => `${item.kind === 'review' ? 'agent' : 'human'}:${item.from}`;
  for (const item of needs) if (item.from && !newestFrom.has(whoFrom(item))) newestFrom.set(whoFrom(item), item);
  const agents = pulse?.agents ?? participants.filter(p => p.subscriberType === 'AGENT').map((p): AgentPulse => ({name: p.subscriberId, state: 'idle', since: 0}));
  const people = new Map((pulse?.people ?? []).map(person => [person.name, person]));
  const humans = participants.filter(p => p.subscriberType === 'HUMAN').map(p => p.subscriberId);
  const rows: ParticipantRow[] = agents.map(agent => ({kind: 'agent', name: agent.name, label: agent.name, state: agent.state, text: agentText(agent), app: agent.state === 'working' ? agent.app ?? null : null}));
  for (const name of [...humans.filter(name => name !== viewer), ...humans.filter(name => name === viewer)]) {
    const person = people.get(name);
    rows.push({kind: 'human', name, label: name === viewer ? 'You' : name, state: person ? 'posted' : 'idle',
      text: person ? person.files ? files(person.files) : person.said : '', app: null});
  }
  return rows.map(row => {
    const item = newestFrom.get(`${row.kind}:${row.name}`);
    return item && WAITS_OVER.has(row.state) ? {...row, state: 'waiting' as const, text: waitingText(item), app: null} : row;
  });
}

/** The rows a card shows: all of them up to MAX_ROWS, else the MAX_ROWS that most need a look, in their usual order. */
export function shownRows(rows: ParticipantRow[]): {shown: ParticipantRow[]; hidden: number} {
  if (rows.length <= MAX_ROWS) return {shown: rows, hidden: 0};
  const keep = new Set(rows.map((row, i) => ({row, i})).sort((a, b) => PRIORITY[a.row.state] - PRIORITY[b.row.state] || a.i - b.i).slice(0, MAX_ROWS).map(({row}) => row));
  return {shown: rows.filter(row => keep.has(row)), hidden: rows.length - MAX_ROWS};
}
