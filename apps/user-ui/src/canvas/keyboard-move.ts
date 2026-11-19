// Moving a focused card or area with the arrow keys: how far one press goes, and the burst that turns a run of presses
// into one stored move (the same board operation a pointer drop makes).

/** World px per arrow press, and with Shift. */
export const NUDGE_STEP = 8;
export const NUDGE_STEP_SHIFT = 40;
/** Presses closer together than this form one move. */
export const MOVE_BURST_MS = 400;

const DIRECTIONS: Record<string, {x: number; y: number}> = {
  ArrowLeft: {x: -1, y: 0}, ArrowRight: {x: 1, y: 0}, ArrowUp: {x: 0, y: -1}, ArrowDown: {x: 0, y: 1},
};

/** The offset one key press moves by, in world px, or null for any key that is not an arrow. */
export function nudge(key: string, shift: boolean): {dx: number; dy: number} | null {
  const direction = Object.hasOwn(DIRECTIONS, key) ? DIRECTIONS[key] : undefined;
  if (!direction) return null;
  const step = shift ? NUDGE_STEP_SHIFT : NUDGE_STEP;
  return {dx: direction.x * step, dy: direction.y * step};
}

export type MoveBurstOptions = {
  /** The burst ended: store the summed offset once. */
  commit(dx: number, dy: number): void;
  /** The burst was cancelled (Escape), or netted to no move: put the preview back. */
  revert(): void;
  delayMs?: number;
  setTimer?(fn: () => void, ms: number): unknown;
  clearTimer?(handle: unknown): void;
};

/**
 * Accumulates presses; `commit` runs once, `delayMs` after the last press. `step` returns the running offset for the
 * preview, `cancel` drops it (and reverts), `flush` commits now (another move or a pointer press takes over).
 */
export function createMoveBurst({commit, revert, delayMs = MOVE_BURST_MS,
  setTimer = (fn, ms) => setTimeout(fn, ms), clearTimer = handle => clearTimeout(handle as ReturnType<typeof setTimeout>)}: MoveBurstOptions) {
  let total: {dx: number; dy: number} | null = null;
  let timer: unknown = null;
  const stop = () => { if (timer !== null) clearTimer(timer); timer = null; };
  function flush() {
    stop();
    if (!total) return;
    const {dx, dy} = total;
    total = null;
    if (dx || dy) commit(dx, dy); else revert();
  }
  return {
    step(dx: number, dy: number) {
      total = {dx: (total?.dx ?? 0) + dx, dy: (total?.dy ?? 0) + dy};
      stop();
      timer = setTimer(flush, delayMs);
      return {...total};
    },
    cancel() {
      stop();
      if (!total) return;
      total = null;
      revert();
    },
    flush,
    active: () => total !== null,
  };
}
export type MoveBurst = ReturnType<typeof createMoveBurst>;

/** What the live region says after a keyboard move: the area a card joined or left, else just that it moved. */
export function moveAnnouncement(before: {id: string; title: string} | null, after: {id: string; title: string} | null) {
  if (after && after.id !== before?.id) return `Moved into ${after.title || 'Untitled area'}`;
  if (!after && before) return `Moved out of ${before.title || 'Untitled area'}`;
  return 'Moved';
}
