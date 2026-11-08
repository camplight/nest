// The Needs you list: unread mentions and project reviews, for chats the person can see. Pure; no DOM.
import type {DashboardTask,Project} from '@nest/schemas';
import type {CardPulse} from './pulse';

export type NeedsItem = {key: string; kind: 'mention' | 'review'; channelId: string; chatTitle: string; detail: string; at: number};
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
      items.push({key: `mention:${mention.id}`, kind: 'mention', channelId, chatTitle, detail: `${mention.sender}: ${mention.text}`, at: mention.at});
    }
  }
  const channelOf = new Map(projects.map(project => [project.id, project.channelId]));
  for (const task of reviews) {
    const channelId = channelOf.get(task.projectId);
    const chatTitle = channelId === undefined ? undefined : titles.get(channelId);
    if (channelId === undefined || chatTitle === undefined) continue;
    items.push({key: `review:${task.id}`, kind: 'review', channelId, chatTitle, detail: `${task.title} needs review${task.agentName ? ` · ${task.agentName}` : ''}`, at: task.updatedAt});
  }
  return items.sort((a, b) => b.at - a.at);
}
