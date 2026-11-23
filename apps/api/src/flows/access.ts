/** The parts of an engine channel record that decide access without a session. */
export type AccessChannel = {
  visibility?: string; ownerHumanId?: string | null; archivedAt?: number | null;
  participants?: { subscriberType: string; subscriberId: string }[];
  /** Viewer shares; the engine's channel list carries them for every chat it lists. */
  shares?: { viewerType: string; viewerId: string }[];
};
export type ChannelAccess = { read: boolean; post: boolean; member: boolean };
/** What the channel record alone cannot say: the human's teams, and whether the chat is shared with them to view. */
export type AccessExtra = { teamIds: ReadonlySet<string>; viewerShare: boolean };
type Person = { id: string; username: string };

const NO_TEAMS: ReadonlySet<string> = new Set();
const NO_EXTRA: AccessExtra = { teamIds: NO_TEAMS, viewerShare: false };

/** Whether `name` is an AGENT participant of the chat. */
export const isAgentIn = (channel: AccessChannel | undefined, name: string) =>
  (channel?.participants ?? []).some(p => p.subscriberType === 'AGENT' && p.subscriberId === name);

/**
 * Access by the engine's rules (OrgOps canViewChannel and canPostToChannel), so background work applies it with the
 * service token and the API applies the same rule at creation (S9):
 * - member: the human owns the chat or is a HUMAN participant.
 * - post: the chat is PUBLIC (the engine treats anything not PRIVATE as public), member, or a TEAM participant is one
 *   of the human's teams; and the chat is not archived.
 * - read: what lets the human post (archived or not), or a viewer share with the human.
 * Without `extra`, team and viewer-share access count as none; `member` never depends on it.
 */
export function channelAccess(channel: AccessChannel | undefined, human: Person, extra: AccessExtra = NO_EXTRA): ChannelAccess {
  if (!channel) return { read: false, post: false, member: false };
  const member = Boolean(channel.ownerHumanId && channel.ownerHumanId === human.id)
    || (channel.participants ?? []).some(p => p.subscriberType === 'HUMAN' && p.subscriberId === human.username);
  const team = (channel.participants ?? []).some(p => p.subscriberType === 'TEAM' && extra.teamIds.has(p.subscriberId));
  const poster = member || team || channel.visibility !== 'PRIVATE';
  return { read: poster || extra.viewerShare, post: poster && !channel.archivedAt, member };
}

/** The ids of the teams a human (by username) is a HUMAN member of. */
export type TeamsOf = (username: string) => Promise<ReadonlySet<string>>;

/**
 * The extras for `channelAccess`: the viewer share from the chat record, and the human's teams only where a team can
 * change the answer (a PRIVATE chat with a TEAM participant that the human is not already a member of).
 */
export function accessExtras(teamsOf: TeamsOf) {
  return async (channel: AccessChannel | undefined, human: Person): Promise<AccessExtra> => {
    if (!channel) return NO_EXTRA;
    const viewerShare = (channel.shares ?? []).some(s => s.viewerType === 'HUMAN' && s.viewerId === human.username);
    const teamsMatter = channel.visibility === 'PRIVATE' && !channelAccess(channel, human).member
      && (channel.participants ?? []).some(p => p.subscriberType === 'TEAM');
    return { teamIds: teamsMatter ? await teamsOf(human.username) : NO_TEAMS, viewerShare };
  };
}

/** `channelAccess` with its extras read through `teamsOf`. */
export function accessReader(teamsOf: TeamsOf) {
  const extras = accessExtras(teamsOf);
  return async (channel: AccessChannel | undefined, human: Person) => channelAccess(channel, human, await extras(channel, human));
}

/**
 * Every human's teams, read with the service token (`GET /api/teams`, then each team's members) on first use and kept
 * for the life of this reader: one tick or one action.
 */
export function serviceTeams(service: {
  teams(): Promise<{ id: string }[]>;
  teamMembers(teamId: string): Promise<{ memberType: string; memberId: string }[]>;
}): TeamsOf {
  let byUser: Promise<Map<string, Set<string>>> | null = null;
  async function load() {
    const map = new Map<string, Set<string>>();
    const teams = await service.teams();
    const members = await Promise.all(teams.map(t => service.teamMembers(t.id)));
    teams.forEach((t, i) => {
      for (const m of members[i]) {
        if (m.memberType !== 'HUMAN') continue;
        let set = map.get(m.memberId);
        if (!set) map.set(m.memberId, set = new Set());
        set.add(t.id);
      }
    });
    return map;
  }
  return async username => (await (byUser ??= load())).get(username) ?? NO_TEAMS;
}

/**
 * The viewer's own teams, read through their session (`GET /api/teams/me`) once per reader; any other human has none
 * here, so a reader built for one viewer never answers for someone else.
 */
export function viewerTeams(mine: () => Promise<{ id: string }[]>, username: string): TeamsOf {
  let ids: Promise<ReadonlySet<string>> | null = null;
  return async name => (name === username ? (ids ??= mine().then(list => new Set(list.map(t => t.id)))) : NO_TEAMS);
}

/**
 * What a viewer may do with a link (S10). canManage: pause or disconnect, for the creator or a member of
 * the target chat. canEdit: change what, when, who and the label, for the creator only.
 */
export function linkRights(link: { createdBy: string }, target: AccessChannel | undefined, viewer: Person) {
  const creator = link.createdBy === viewer.id;
  return { canManage: creator || channelAccess(target, viewer).member, canEdit: creator };
}
