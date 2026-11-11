// The Needs you list: unread mentions and project reviews, for chats the person can see. Pure; no DOM.
import type {DashboardTask,Project} from '@nest/schemas';
import {oneLine,type CardPulse} from './pulse';

export type NeedsItem = {
  key: string; kind: 'mention' | 'review'; channelId: string; chatTitle: string; detail: string; at: number;
  /** Who the item is from: the mention's sender or the reviewed task's agent (null when the task names none). */
  from: string | null;
  /** The reason as a card's pill reads it: `{sender}: {text}` or `Review {task}`. */
  short: string;
};
export type NeedsInput = {
  pulses: ReadonlyMap<string, CardPulse>;
  /** Visible chats only (open cards and loose chats). A chat missing here never appears: locked, unavailable or not the person's. */
  titles: ReadonlyMap<string, string>;
  reviews: DashboardTask[];
  projects: Project[];
};

/** One item per unread mention and per task awaiting review, newest first. */
export function needsYouItems({pulses, titles, reviews, projects}: NeedsInput): NeedsItem[] {
  const items: NeedsItem[] = [];
  for (const [channelId, pulse] of pulses) {
    const chatTitle = titles.get(channelId);
    if (chatTitle === undefined) continue;
    for (const mention of pulse.needsYou) {
      items.push({key: `mention:${mention.id}`, kind: 'mention', channelId, chatTitle, detail: `${mention.sender}: ${mention.text}`, at: mention.at,
        from: mention.sender, short: `${mention.sender}: ${oneLine(mention.text)}`});
    }
  }
  const channelOf = new Map(projects.map(project => [project.id, project.channelId]));
  for (const task of reviews) {
    const channelId = channelOf.get(task.projectId);
    const chatTitle = channelId === undefined ? undefined : titles.get(channelId);
    if (channelId === undefined || chatTitle === undefined) continue;
    items.push({key: `review:${task.id}`, kind: 'review', channelId, chatTitle, detail: `${task.title} needs review${task.agentName ? ` · ${task.agentName}` : ''}`, at: task.updatedAt,
      from: task.agentName || null, short: `Review ${task.title}`});
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
