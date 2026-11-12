// Forking a chat from one message (the mock's fork()): a new team chat named after the message's first sentence, with
// the author agent in it, then the fork itself (Switchyard's seed and the findings link). The project id is stored per
// message until the fork is made, so a retry after a lost response finishes the same chat instead of starting another.
import {forkTitle,type Project} from '@nest/schemas';
import {ApiError,apiJson,getApiHeaders} from '../api';
import {createFork} from './flows-api';

/** The message a fork starts from. */
export type ForkSource = {eventId: string; text: string; author: string; authorKind: 'human' | 'agent' | 'system' | 'activity'};
export type ForkResult = {childChannelId: string; linkId: string | null; projectId: string; title: string};

const storageKey = (ownerId: string, eventId: string, withAgent: boolean) => `nest-fork:${ownerId}:${eventId}:${withAgent ? 'agent' : 'alone'}`;
function storedId(key: string): string {
  try {
    const saved = sessionStorage.getItem(key);
    if (saved) return saved;
  } catch {}
  const id = crypto.randomUUID();
  try { sessionStorage.setItem(key, id); } catch {}
  return id;
}
function forget(key: string) { try { sessionStorage.removeItem(key); } catch {} }
/** The viewer's IANA time zone, for the seed's `{HH:MM}`. */
function timeZone() { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined; } catch { return undefined; } }

async function project(ownerId: string, source: ForkSource, withAgent: boolean): Promise<Project> {
  const key = storageKey(ownerId, source.eventId, withAgent);
  const members = withAgent ? [{subscriberType: 'AGENT', subscriberId: source.author}] : [];
  try {
    return await apiJson<Project>('/api/projects', {method: 'POST', headers: getApiHeaders(),
      body: JSON.stringify({id: storedId(key), name: forkTitle(source.text), members, collaboration: 'team'})});
  } catch (error) {
    // The id holds another request (or someone else's project): the next attempt starts over.
    if (error instanceof ApiError && error.status === 409) forget(key);
    throw error;
  }
}

/**
 * Starts a fork of `source` in `parentChannelId`. The fork starts with the person forking and, when an agent wrote the
 * message, that agent. When the agent cannot be added (no longer available to this person), the fork starts without it.
 */
export async function startFork({ownerId, parentChannelId, source}: {ownerId: string; parentChannelId: string; source: ForkSource}): Promise<ForkResult> {
  let withAgent = source.authorKind === 'agent';
  let created: Project;
  try { created = await project(ownerId, source, withAgent); } catch (error) {
    if (!withAgent || !(error instanceof ApiError) || (error.status !== 400 && error.status !== 403)) throw error;
    withAgent = false;
    created = await project(ownerId, source, false);
  }
  const zone = timeZone();
  const fork = await createFork({childChannelId: created.channelId, parentChannelId, parentEventId: source.eventId, ...(zone ? {timeZone: zone} : {})});
  forget(storageKey(ownerId, source.eventId, withAgent));
  return {...fork, projectId: created.id, title: created.name};
}
