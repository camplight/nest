import {archiveNotice,archivePlan,type LooseChat} from './loose';

export type ArchiveDeps = {
  chats: readonly LooseChat[];
  hidden: ReadonlySet<string>;
  /** The engine archive through Nest (which pauses the chat's hand-offs); false when the engine refused it. */
  engineArchive(channelId: string, archived: boolean): Promise<boolean>;
  setHidden(channelIds: string[], hidden: boolean): Promise<{channelIds: string[]}>;
  /** Reloads chats after the engine archive changed one. */
  refresh(): Promise<void>;
};
/** `hidden` is the person's new hidden list when it changed. */
export type ArchiveResult = {ok: boolean; notice: string | null; hidden: string[] | null};

/**
 * The Loose chats drawer's Archive: chats the person manages are archived for everyone, the rest hidden from their
 * list, and the notice says how many of each. A chat the engine refused counts as failed and is never hidden in its
 * place. Undo (`value` false) unarchives an archived chat and unhides a hidden one.
 */
export async function archiveOrHide(channelIds: string[], value: boolean, deps: ArchiveDeps): Promise<ArchiveResult> {
  const byId = new Map(deps.chats.map(chat => [chat.channelId, chat]));
  if (!value) {
    const archived = channelIds.filter(id => byId.get(id)?.archived);
    const results = await Promise.all(archived.map(id => deps.engineArchive(id, false)));
    const unhide = channelIds.filter(id => deps.hidden.has(id));
    const hidden = unhide.length ? (await deps.setHidden(unhide, false)).channelIds : null;
    if (results.some(Boolean)) await deps.refresh();
    return {ok: results.every(Boolean), notice: null, hidden};
  }
  const plan = archivePlan(channelIds.filter(id => !byId.get(id)?.archived), id => Boolean(byId.get(id)?.manageable));
  let done = 0;
  for (const id of plan.archive) if (await deps.engineArchive(id, true)) done += 1;
  const failed = plan.archive.length - done;
  const hidden = plan.hide.length ? (await deps.setHidden(plan.hide, true)).channelIds : null;
  if (done) await deps.refresh();
  if (!done && !plan.hide.length) return {ok: !failed, notice: null, hidden};
  return {ok: true, notice: archiveNotice(done, plan.hide.length, failed), hidden};
}
