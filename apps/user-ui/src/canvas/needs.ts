// The Needs you list: unread mentions, project reviews and the server's flow items (hand-offs awaiting the person's OK,
// their paused links and missed runs), for chats the person can see. Pure; no DOM.
import type {DashboardTask,FlowNeed,Project} from '@nest/schemas';
import {oneLine,type CardPulse} from './pulse';

/** What an item lets the person decide: a flow item's gate from the server, or a project task's review. */
export type NeedsGate = FlowNeed['gate'] | {kind: 'review'; projectId: string; taskId: string};
export type NeedsItem = {
  key: string; kind: 'mention' | 'review' | FlowNeed['kind']; channelId: string; chatTitle: string; detail: string; at: number;
  /** Who the item is from: the mention's sender or the reviewed task's agent (null when the task names none). */
  from: string | null;
  /** The reason as a card's pill reads it: `{sender}: {text}` or `Review {task}`. */
  short: string;
  /** The reason alone, for the sender's row: the mention's first line or the task's title. */
  reason: string;
  /** Absent for a mention: there is nothing to decide in place. */
  gate?: NeedsGate;
  /**
   * False for a flow item whose chat the person cannot open here (deleted, archived or no longer theirs): it is listed
   * under the server's title, and its row does not jump.
   */
  canOpen: boolean;
};
export type NeedsInput = {
  pulses: ReadonlyMap<string, CardPulse>;
  /**
   * Visible chats only (open cards and loose chats). A mention or review in a chat missing here never appears; a flow
   * item falls back to the server's `chatTitle`, so a pause Nest made in a chat the person lost still shows.
   */
  titles: ReadonlyMap<string, string>;
  reviews: DashboardTask[];
  projects: Project[];
  /** The viewer's flow items from GET /api/flows/needs: detail, short, reason and from are the server's. */
  flows: readonly FlowNeed[];
};

/** One item per unread mention, per task awaiting review and per flow item, newest first. */
export function needsYouItems({pulses, titles, reviews, projects, flows}: NeedsInput): NeedsItem[] {
  const items: NeedsItem[] = [];
  for (const [channelId, pulse] of pulses) {
    const chatTitle = titles.get(channelId);
    if (chatTitle === undefined) continue;
    for (const mention of pulse.needsYou) {
      items.push({key: `mention:${mention.id}`, kind: 'mention', channelId, chatTitle, detail: `${mention.sender}: ${mention.text}`, at: mention.at,
        from: mention.sender, short: `${mention.sender}: ${oneLine(mention.text)}`, reason: oneLine(mention.text), canOpen: true});
    }
  }
  const channelOf = new Map(projects.map(project => [project.id, project.channelId]));
  for (const task of reviews) {
    const channelId = channelOf.get(task.projectId);
    const chatTitle = channelId === undefined ? undefined : titles.get(channelId);
    if (channelId === undefined || chatTitle === undefined) continue;
    items.push({key: `review:${task.id}`, kind: 'review', channelId, chatTitle, detail: `${task.title} needs review${task.agentName ? ` · ${task.agentName}` : ''}`, at: task.updatedAt,
      from: task.agentName || null, short: `Review ${task.title}`, reason: task.title, gate: {kind: 'review', projectId: task.projectId, taskId: task.id}, canOpen: true});
  }
  for (const need of flows) {
    const known = titles.get(need.channelId);
    const chatTitle = known ?? (need.chatTitle || undefined);
    if (chatTitle === undefined) continue;
    items.push({key: need.key, kind: need.kind, channelId: need.channelId, chatTitle, detail: need.detail, at: need.at,
      from: need.from, short: need.short, reason: need.reason, gate: need.gate, canOpen: known !== undefined});
  }
  return items.sort((a, b) => b.at - a.at);
}

/**
 * The items per chat, newest first. A chat whose items are unchanged keeps its previous array (`previous`),
 * so a memoized card does not re-render when another chat's items change.
 */
export function needsByChannel(items: NeedsItem[], previous?: ReadonlyMap<string, NeedsItem[]>): Map<string, NeedsItem[]> {
  const grouped = new Map<string, NeedsItem[]>();
  for (const item of items) {
    const list = grouped.get(item.channelId);
    if (list) list.push(item); else grouped.set(item.channelId, [item]);
  }
  for (const [channelId, list] of grouped) {
    const old = previous?.get(channelId);
    if (old && old.length === list.length && JSON.stringify(old) === JSON.stringify(list)) grouped.set(channelId, old);
  }
  return grouped;
}
