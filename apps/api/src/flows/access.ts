/** The parts of an engine channel record that decide access without a session. */
export type AccessChannel = {
  visibility?: string; ownerHumanId?: string | null; archivedAt?: number | null;
  participants?: { subscriberType: string; subscriberId: string }[];
};
export type ChannelAccess = { read: boolean; post: boolean; member: boolean };

/** Whether `name` is an AGENT participant of the chat. */
export const isAgentIn = (channel: AccessChannel | undefined, name: string) =>
  (channel?.participants ?? []).some(p => p.subscriberType === 'AGENT' && p.subscriberId === name);

/**
 * Access decided from an engine channel record alone, so background work can apply it with the
 * service token and the API applies the same rule at creation (S9):
 * - member: the human owns the chat or is a HUMAN participant.
 * - read: the chat is PUBLIC (the engine treats anything not PRIVATE as public), or member.
 * - post: read, and the chat is not archived.
 * Team-only and viewer-share access count as no access, which is stricter than the engine.
 */
export function channelAccess(channel: AccessChannel | undefined, human: { id: string; username: string }): ChannelAccess {
  if (!channel) return { read: false, post: false, member: false };
  const member = Boolean(channel.ownerHumanId && channel.ownerHumanId === human.id)
    || (channel.participants ?? []).some(p => p.subscriberType === 'HUMAN' && p.subscriberId === human.username);
  const read = member || channel.visibility !== 'PRIVATE';
  return { read, post: read && !channel.archivedAt, member };
}

/**
 * What a viewer may do with a link (S10). canManage: pause or disconnect, for the creator or a member of
 * the target chat. canEdit: change what, when, who and the label, for the creator only.
 */
export function linkRights(link: { createdBy: string }, target: AccessChannel | undefined, viewer: { id: string; username: string }) {
  const creator = link.createdBy === viewer.id;
  return { canManage: creator || channelAccess(target, viewer).member, canEdit: creator };
}
