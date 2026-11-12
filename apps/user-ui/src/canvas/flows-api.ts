// Typed helpers for the product /api/flows routes (apps/api/src/flows/routes.ts and scheduler.ts): availability, links,
// needs, schedules and the decisions taken from Needs you (a hand-off's OK, a project task's review, Run now).
import type {AgentMadeSchedule,CreatedTrigger,FlowNeed,ForkView,Link,LinkPatch,NewFork,NewLink,NewSchedule,NewTrigger,ProjectDetail,SchedulePatch,ScheduleView,Task,TriggerPatch,TriggerView} from '@nest/schemas';
import {ApiError,apiFetch,apiJson,getApiHeaders} from '../api';

export type FlowsAvailability = {enabled: boolean; reason?: string; serviceAgent: string | null; summaries: 'model' | 'fallback'; webhooks: boolean};
/** A link as GET /api/flows/links lists it: the stored link, both titles as the viewer may see them, and their rights. */
export type LinkView = Link & {fromTitle: string; toTitle: string; canManage: boolean; canEdit: boolean};

/** A versioned link write lost a race: `current` is the stored link, or null when it was disconnected. */
export class LinkConflict extends Error {
  constructor(readonly current: Link | null) {
    super('Link changed');
    this.name = 'LinkConflict';
  }
}

/** The API's `{error}` text, or the fallback. */
export function flowError(error: unknown, fallback: string) {
  if (!(error instanceof Error)) return fallback;
  try { return (JSON.parse(error.message) as {error?: string}).error || fallback; } catch { return error.message || fallback; }
}
function conflict(error: unknown): unknown {
  if (!(error instanceof ApiError) || error.status !== 409) return error;
  try {
    const body = JSON.parse(error.message) as {error?: string; current?: Link | null};
    if (body.error === 'Link changed') return new LinkConflict(body.current ?? null);
  } catch {}
  return error;
}
const write = (method: string, body: unknown): RequestInit => ({method, headers: getApiHeaders(), body: JSON.stringify(body)});
const linkPath = (id: string) => `/api/flows/links/${encodeURIComponent(id)}`;

export const getAvailability = () => apiJson<FlowsAvailability>('/api/flows/availability');
export const getNeeds = async () => (await apiJson<{items: FlowNeed[]}>('/api/flows/needs')).items;
/** Every link touching a chat the viewer can read. */
export const getLinks = async (channelId: string) => (await apiJson<{links: LinkView[]}>(`/api/flows/links?channelId=${encodeURIComponent(channelId)}`)).links;

/**
 * Connects two chats (`intro`: the target gets a `Picks up what "A" produces.` note). A pair already connected answers with
 * the existing link. Refusals (no access to either chat, flows not set up) come back as the API's `{error}`.
 */
export const createLink = (input: Pick<NewLink, 'id' | 'from' | 'to'> & {intro?: boolean}) =>
  apiJson<Link>('/api/flows/links', write('POST', input));

/** The forks of a chat the viewer can read; a fork the viewer cannot read is titled `a private chat`. */
export const getForks = async (parentChannelId: string) =>
  (await apiJson<{forks: ForkView[]}>(`/api/flows/forks?parentChannelId=${encodeURIComponent(parentChannelId)}`)).forks;
/** Makes a chat the viewer started a fork of one message: Switchyard seeds it, and findings flow back. A repeat answers the same fork. */
export const createFork = (input: NewFork) => apiJson<{childChannelId: string; linkId: string | null}>('/api/flows/forks', write('POST', input));

export async function patchLink(id: string, patch: Omit<LinkPatch, 'version'>, version: number): Promise<Link> {
  try { return await apiJson<Link>(linkPath(id), write('PATCH', {...patch, version})); } catch (error) { throw conflict(error); }
}
/** One write that retries once on the current version when another write got in first. */
export async function patchLatest(id: string, patch: Omit<LinkPatch, 'version'>, version: number): Promise<Link> {
  try { return await patchLink(id, patch, version); } catch (error) {
    if (!(error instanceof LinkConflict) || !error.current) throw error;
    return patchLink(id, patch, error.current.version);
  }
}
export async function deleteLink(id: string, version: number): Promise<void> {
  try { await apiFetch(`${linkPath(id)}?version=${version}`, {method: 'DELETE'}); } catch (error) { throw conflict(error); }
}
export const sendNow = (id: string) => apiJson<{status: string}>(`${linkPath(id)}/send`, {method: 'POST', headers: getApiHeaders()});

/** Approves or declines a hand-off awaiting the viewer's OK (only its link's creator may). 409: already decided or the link is paused. */
export const decideHandoff = (deliveryId: string, decision: 'approve' | 'decline') =>
  apiFetch(`/api/flows/deliveries/${encodeURIComponent(deliveryId)}/decision`, write('POST', {decision})).then(() => undefined);

/**
 * Reviews a project task awaiting review (the project owner's POST /api/projects/:id/tasks/:taskId/reviews), at the task's
 * current version as the project reads now.
 */
export async function reviewTask(projectId: string, taskId: string, decision: 'approve' | 'request_changes', feedback: string): Promise<Task> {
  const project = `/api/projects/${encodeURIComponent(projectId)}`;
  const task = (await apiJson<ProjectDetail>(project)).tasks.find(t => t.id === taskId);
  if (!task) throw new Error('This task is no longer in the project.');
  return apiJson<Task>(`${project}/tasks/${encodeURIComponent(taskId)}/reviews`, write('POST', {version: task.version, decision, feedback}));
}

/** Run now (a strip's, or a missed run's in Needs you): `POST /api/flows/schedules/:id/run`. */
export const runScheduleNow = (scheduleId: string) =>
  apiJson<{runId: string}>(`${schedulePath(scheduleId)}/run`, {method: 'POST', headers: getApiHeaders()});

/** Every schedule and webhook in a chat the viewer can read, and the future runs agents booked themselves (`set by {agent}`). */
export type ScheduleList = {schedules: ScheduleView[]; agentMade: AgentMadeSchedule[]; triggers: TriggerView[]};
export const getSchedules = () => apiJson<ScheduleList>('/api/flows/schedules');
/** A versioned schedule write lost a race: `current` is the stored schedule, or null when it was deleted. */
export class ScheduleConflict extends Error {
  constructor(readonly current: ScheduleView | null) {
    super('Schedule changed');
    this.name = 'ScheduleConflict';
  }
}
function scheduleConflict(error: unknown): unknown {
  if (!(error instanceof ApiError) || error.status !== 409) return error;
  try {
    const body = JSON.parse(error.message) as {error?: string; current?: ScheduleView | null};
    if (body.error === 'Schedule changed') return new ScheduleConflict(body.current ?? null);
  } catch {}
  return error;
}
const schedulePath = (id: string) => `/api/flows/schedules/${encodeURIComponent(id)}`;
/** Books the first run. A repeat with the same id answers the stored schedule. */
export const createSchedule = (input: NewSchedule) => apiJson<ScheduleView>('/api/flows/schedules', write('POST', input));
/** One versioned write, retried once on the current version when another write got in first. */
export async function patchSchedule(id: string, patch: Omit<SchedulePatch, 'version'>, version: number): Promise<ScheduleView> {
  const once = async (at: number) => {
    try { return await apiJson<ScheduleView>(schedulePath(id), write('PATCH', {...patch, version: at})); } catch (error) { throw scheduleConflict(error); }
  };
  try { return await once(version); } catch (error) {
    if (!(error instanceof ScheduleConflict) || !error.current) throw error;
    return once(error.current.version);
  }
}
/** Deletes a schedule and its booked run; runs already posted stay in the chat. */
export async function deleteSchedule(id: string, version: number): Promise<void> {
  const once = async (at: number) => {
    try { await apiFetch(`${schedulePath(id)}?version=${at}`, {method: 'DELETE'}); } catch (error) { throw scheduleConflict(error); }
  };
  try { await once(version); } catch (error) {
    if (!(error instanceof ScheduleConflict)) throw error;
    if (error.current) await once(error.current.version);
  }
}

// Webhook triggers: POST /api/hooks/<token> wakes the agent. The URL comes back from create and rotate only.
/** A versioned webhook write lost a race: `current` is the stored webhook, or null when it was deleted. */
export class TriggerConflict extends Error {
  constructor(readonly current: TriggerView | null) {
    super('Webhook changed');
    this.name = 'TriggerConflict';
  }
}
function triggerConflict(error: unknown): unknown {
  if (!(error instanceof ApiError) || error.status !== 409) return error;
  try {
    const body = JSON.parse(error.message) as {error?: string; current?: TriggerView | null};
    if (body.error === 'Webhook changed') return new TriggerConflict(body.current ?? null);
  } catch {}
  return error;
}
const triggerPath = (id: string) => `/api/flows/triggers/${encodeURIComponent(id)}`;
/** A new webhook and its URL, shown once. A repeat with the same id gives the same webhook a new URL. */
export const createTrigger = (input: NewTrigger) => apiJson<CreatedTrigger>('/api/flows/triggers', write('POST', input));
/** A new URL for the webhook (its creator only); the old one stops working at once. */
export const rotateTrigger = (id: string) => apiJson<{url: string}>(`${triggerPath(id)}/rotate`, {method: 'POST', headers: getApiHeaders()});
/** One versioned write, retried once on the current version when another write got in first. */
export async function patchTrigger(id: string, patch: Omit<TriggerPatch, 'version'>, version: number): Promise<TriggerView> {
  const once = async (at: number) => {
    try { return await apiJson<TriggerView>(triggerPath(id), write('PATCH', {...patch, version: at})); } catch (error) { throw triggerConflict(error); }
  };
  try { return await once(version); } catch (error) {
    if (!(error instanceof TriggerConflict) || !error.current) throw error;
    return once(error.current.version);
  }
}
/** Deletes a webhook: its URL stops working; calls already posted stay in the chat. */
export async function deleteTrigger(id: string, version: number): Promise<void> {
  const once = async (at: number) => {
    try { await apiFetch(`${triggerPath(id)}?version=${at}`, {method: 'DELETE'}); } catch (error) { throw triggerConflict(error); }
  };
  try { await once(version); } catch (error) {
    if (!(error instanceof TriggerConflict)) throw error;
    if (error.current) await once(error.current.version);
  }
}
