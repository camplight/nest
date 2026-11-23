/** Splits projects into active ones and archived ones (their chat is archived), keeping order. */
export function splitArchived<T extends {archived?: boolean}>(projects: T[]): {active: T[]; archived: T[]} {
  return {active: projects.filter(project => !project.archived), archived: projects.filter(project => project.archived)};
}

/**
 * Whether a chat refresh keeps the open project page: its chat is the one chosen and the project is still listed
 * (an archived project stays listed, tagged Archived), and the chat is still visible.
 */
export function keepsProjectPage({selectedProject, channelId, projects, channels}: {
  selectedProject: string | null; channelId: string | null;
  projects: readonly {id: string; channelId: string}[]; channels: readonly {id: string; archivedAt?: number | null}[];
}): boolean {
  return Boolean(selectedProject && channelId) && projects.some(project => project.id === selectedProject && project.channelId === channelId)
    && channels.some(channel => channel.id === channelId);
}

/** The members panel's note when the viewer cannot invite: why, and for an archived project's owner, how to change it. */
export function inviteNote({owner, archived}: {owner: boolean; archived: boolean}): string | null {
  if (owner && archived) return 'This project is archived. Unarchive it to edit or invite.';
  return owner ? null : 'The project owner manages invitations.';
}
