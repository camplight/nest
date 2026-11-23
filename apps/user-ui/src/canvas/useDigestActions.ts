// The open chat's digest actions: Approve, Request changes, Don't hand off and Run now, with the rules for when an armed
// Request changes is cancelled. Kept out of CanvasView so the arming has one home.
import {useCallback,useEffect,useRef,useState} from 'react';
import type {Project} from '@nest/schemas';
import {decideHandoff,flowError,reviewTask,runScheduleNow,type LinkView} from './flows-api';
import type {NeedsItem} from './needs';

/**
 * The reply box's Request changes (App's composer): arm it with what to do with the next message sent (false when no reply
 * box could take it), or cancel it.
 */
export type ChangeRequests = {
  arm(onSent: (text: string) => Promise<void>): boolean;
  cancel(): void;
};

export type DigestActionsInput = {
  say(text: string): void;
  /** Re-reads the flow items (useFlows) and the reviews (useReviews). */
  refreshFlows(): void;
  rereadReviews(): void;
  changeRequests?: ChangeRequests;
  /** The open chat's links, for the target's title in `Handed off to "{B}".`. */
  links: readonly LinkView[];
  projects: readonly Project[];
  humanId: string;
  /** The open chat's Needs you items (undefined when no chat is open or it has none). */
  chatNeeds: readonly NeedsItem[] | undefined;
  /** Changes whenever the open chat, its mode or whether it is shown changes: an armed request ends there. */
  chatKey: string;
};

export function useDigestActions({say, refreshFlows, rereadReviews, changeRequests, links, projects, humanId, chatNeeds, chatKey}: DigestActionsInput) {
  const linksRef = useRef(links); linksRef.current = links;
  const requests = useRef(changeRequests); requests.current = changeRequests;
  /** The key of the item an armed Request changes is for; the state copy lets the digest show it. */
  const armed = useRef<string | null>(null);
  const [armedKey, setArmedKey] = useState<string | null>(null);
  const setArmed = (key: string | null) => { armed.current = key; setArmedKey(key); };
  const cancel = useCallback(() => {
    if (armed.current === null) return;
    setArmed(null);
    requests.current?.cancel();
  }, []);
  // The item went (decided here or elsewhere, or no longer listed): its request goes with it, and the placeholder returns.
  useEffect(() => {
    if (armed.current !== null && !chatNeeds?.some(item => item.key === armed.current)) cancel();
  }, [chatNeeds, cancel]);
  // Another chat, another mode (focus, split, or the regular chat view, which unmounts the canvas), or the chat closed.
  useEffect(() => cancel, [chatKey, cancel]);

  const approve = useCallback(async (item: NeedsItem) => {
    cancel();
    const gate = item.gate;
    if (gate?.kind === 'approval') {
      const target = linksRef.current.find(l => l.id === gate.linkId)?.toTitle ?? item.short.replace(/^Approve hand-off to /, '');
      try { await decideHandoff(gate.deliveryId, 'approve'); say(`Handed off to "${target}".`); }
      catch (error) { say(flowError(error, 'Could not approve the hand-off. Try again.')); }
      finally { refreshFlows(); }
    } else if (gate?.kind === 'review') {
      try { await reviewTask(gate.projectId, gate.taskId, 'approve', ''); }
      catch (error) { say(flowError(error, 'Could not approve it. Try again.')); }
      finally { rereadReviews(); }
    }
  }, [cancel, say, refreshFlows, rereadReviews]);

  const requestChanges = useCallback((item: NeedsItem) => {
    const gate = item.gate;
    if (gate?.kind !== 'approval' && gate?.kind !== 'review') return;
    // The reply is posted in the chat as usual; once it is sent, the hand-off is declined or the task goes back with it.
    const taken = requests.current?.arm(async text => {
      if (armed.current !== item.key) return;
      setArmed(null);
      if (gate.kind === 'approval') {
        try { await decideHandoff(gate.deliveryId, 'decline'); }
        catch (error) { say(flowError(error, 'Could not decline the hand-off. Try again.')); }
        finally { refreshFlows(); }
      } else {
        try { await reviewTask(gate.projectId, gate.taskId, 'request_changes', text); }
        catch (error) { say(flowError(error, 'Could not send the changes to the task. Try again.')); }
        finally { rereadReviews(); }
      }
    });
    if (taken) setArmed(item.key);
    else { setArmed(null); say('The reply box is not ready. Open the chat and try again.'); }
  }, [say, refreshFlows, rereadReviews]);

  /** Don't hand off: declines a hand-off awaiting the person's OK at once; the link stays on for the next result. */
  const decline = useCallback(async (item: NeedsItem) => {
    cancel();
    const gate = item.gate;
    if (gate?.kind !== 'approval') return;
    const target = linksRef.current.find(l => l.id === gate.linkId)?.toTitle ?? item.short.replace(/^Approve hand-off to /, '');
    try { await decideHandoff(gate.deliveryId, 'decline'); say(`Not handed off to "${target}".`); }
    catch (error) { say(flowError(error, 'Could not stop the hand-off. Try again.')); }
    finally { refreshFlows(); }
  }, [cancel, say, refreshFlows]);

  /** Run now on a missed run (Task 10 serves the route). */
  const runNow = useCallback(async (item: NeedsItem) => {
    if (item.gate?.kind !== 'missed') return;
    try { await runScheduleNow(item.gate.scheduleId); }
    catch (error) { say(flowError(error, 'Could not start the run. Try again.')); }
    finally { refreshFlows(); }
  }, [say, refreshFlows]);

  // Decisions follow the server: an approval item is only ever the link creator's own; a review is the project owner's.
  const canDecide = useCallback((item: NeedsItem) => {
    const gate = item.gate;
    return gate?.kind !== 'review' || projects.find(p => p.id === gate.projectId)?.ownerId === humanId;
  }, [projects, humanId]);

  return {approve, requestChanges, decline, cancelChanges: cancel, armedKey, runNow, canDecide};
}
