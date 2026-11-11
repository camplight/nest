// Typed helpers for the product /api/flows routes (apps/api/src/flows/routes.ts): availability, links and needs.
import type {FlowNeed,Link,LinkPatch,NewLink} from '@nest/schemas';
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
