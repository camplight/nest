// One shared estimate of the engine's clock. Event timestamps are the server's, so anything that compares them with
// "now" (running calls, quiet agents) must use serverNow(), never the browser clock alone.
// Three sources move the offset:
//  - a response's Date header (whole seconds, so approximate), in both directions;
//  - a realtime event, which was created a moment ago, in both directions (fresh);
//  - a seeded (history) event, which can only be older than now, so it can only raise the offset.
export type ServerClock = {
  serverNow(): number;
  /** `fresh`: the time is the server's present (a realtime event), so it sets the offset; otherwise it only raises it. */
  noteServerTime(ms: number, options?: {fresh?: boolean}): void;
  noteResponseDate(response: {headers: {get(name: string): string | null}}): void;
  offset(): number;
};

export function createServerClock(now: () => number = Date.now): ServerClock {
  let offset = 0;
  return {
    serverNow: () => now() + offset,
    noteServerTime(ms, {fresh = false} = {}) {
      if (!Number.isFinite(ms)) return;
      offset = fresh ? ms - now() : Math.max(offset, ms - now());
    },
    noteResponseDate(response) {
      const date = Date.parse(response.headers.get('date') ?? '');
      if (Number.isFinite(date)) offset = date - now();
    },
    offset: () => offset,
  };
}

/** The clock the whole app shares. */
export const serverClock = createServerClock();
