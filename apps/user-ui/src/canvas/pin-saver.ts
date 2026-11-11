// Saves the person's tray pins one request at a time. Each save sends the whole list, so a burst of star presses
// coalesces: while one PUT is in flight only the newest list waits, and it goes out when that PUT settles.
// The server therefore always ends with the list the person last saw.
import type {AgentPins} from '@nest/schemas';

export type PinSaverOptions = {
  /** PUT the whole list; `expectSaved: false` asks the server to refuse (409) if pins are already saved. */
  put(agentNames: string[], expectSaved?: false): Promise<AgentPins>;
  isConflict(error: unknown): boolean;
  /** The server's answer to the newest list, once nothing newer waits. */
  onSaved(pins: AgentPins): void;
  /** A save failed and nothing newer waits: `confirmed` is the last list the server holds. */
  onError(confirmed: AgentPins): void;
  /** A seeded save met pins saved elsewhere; the queue is dropped and the caller should re-read. */
  onConflict(): void;
};

export function createPinSaver({put, isConflict, onSaved, onError, onConflict}: PinSaverOptions) {
  let confirmed: AgentPins = {agentNames: [], saved: false};
  let queued: string[] | null = null, inFlight = false;
  function flush() {
    if (inFlight || !queued) return;
    const list = queued;
    queued = null;
    inFlight = true;
    // Until the server holds a list, a save carries the seed and must not replace pins saved elsewhere.
    put(list, confirmed.saved ? undefined : false)
      .then(pins => { confirmed = pins; if (!queued) onSaved(pins); })
      .catch(error => {
        if (isConflict(error)) { queued = null; onConflict(); }
        else if (!queued) onError(confirmed);
      })
      .finally(() => { inFlight = false; flush(); });
  }
  return {
    /** Queue the newest whole list. */
    save(agentNames: string[]) { queued = [...agentNames]; flush(); },
    /** The list the server holds, as read by GET. */
    confirm(pins: AgentPins) { confirmed = pins; },
    busy: () => inFlight || queued !== null,
  };
}
export type PinSaver = ReturnType<typeof createPinSaver>;
