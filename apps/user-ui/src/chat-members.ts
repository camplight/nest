// Adding and removing chat members through the existing engine membership routes, confirmed by a re-read.
// Shared by the regular chat (mention invites, Manage channel) and the canvas agent tray.
import {getApiHeaders, type apiFetch, type apiJson} from './api';
import type {Channel, ChannelParticipant} from './types';

export type ChatMember = {subscriberType: 'AGENT' | 'HUMAN'; subscriberId: string};
type Transport = {fetch: typeof apiFetch; fetchJson: typeof apiJson};

const CHANNELS = '/api/channels?includeArchived=1';
const isMember = (list: Channel[], channelId: string, member: ChannelParticipant) =>
  Boolean(list.find(channel => channel.id === channelId)?.participants?.some(p =>
    p.subscriberType === member.subscriberType && p.subscriberId === member.subscriberId));

/**
 * Project chats go through the project members route (it checks project ownership and audits);
 * other chats subscribe directly. A lost response is reconciled by re-reading the channel list,
 * which is returned once the member is confirmed present.
 */
export async function addChatMember({channelId, projectId, member, fetch, fetchJson}: Transport & {
  channelId: string; projectId?: string | null; member: ChatMember;
}): Promise<Channel[]> {
  const path = projectId ? `/api/projects/${encodeURIComponent(projectId)}/members` : `/api/channels/${encodeURIComponent(channelId)}/subscribe`;
  try {
    await fetch(path, {method: 'POST', headers: getApiHeaders(), body: JSON.stringify(member)});
  } catch { /* Re-read membership to reconcile a response lost after subscription. */ }
  const fresh = await fetchJson<Channel[]>(CHANNELS);
  if (!isMember(fresh, channelId, member)) throw Error('Invitation unconfirmed');
  return fresh;
}

/**
 * Unsubscribes the member (any participant type, as Manage channel lists teams too). A failure stands
 * only if the re-read still shows them in the chat; the request's own error is kept for the message.
 */
export async function removeChatMember({channelId, member, fetch, fetchJson}: Transport & {
  channelId: string; member: ChannelParticipant;
}): Promise<Channel[]> {
  let failure: unknown = null;
  try {
    await fetch(`/api/channels/${encodeURIComponent(channelId)}/unsubscribe`, {
      method: 'POST', headers: getApiHeaders(),
      body: JSON.stringify({subscriberType: member.subscriberType, subscriberId: member.subscriberId}),
    });
  } catch (error) { failure = error; }
  let fresh: Channel[];
  try { fresh = await fetchJson<Channel[]>(CHANNELS); } catch (error) { throw failure ?? error; }
  if (isMember(fresh, channelId, member)) throw failure ?? Error('Removal unconfirmed');
  return fresh;
}
