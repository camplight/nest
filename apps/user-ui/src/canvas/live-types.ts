// Placeholder for the live card state that Task 6 defines in live.ts (CanvasLive there replaces this).
export type CanvasLive = {subscribe(listener: () => void): () => void; snapshot(): Map<string, unknown>};

const EMPTY = new Map<string, unknown>();
/** Until Task 6 the canvas has no live state: nothing to subscribe to and an empty snapshot. */
export const idleCanvasLive: CanvasLive = {subscribe: () => () => {}, snapshot: () => EMPTY};
