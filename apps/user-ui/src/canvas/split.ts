// Split screen: the chat's share of the canvas body width, in percent, remembered per browser.
export const SPLIT_KEY = 'nest-canvas-split';
export const SPLIT_DEFAULT = 45;
export const SPLIT_MIN = 25;
/** The canvas keeps at least 40% of the width. */
export const SPLIT_MAX = 60;

type ReadStorage = Pick<Storage, 'getItem'>;
type WriteStorage = Pick<Storage, 'setItem'>;
const local = () => (typeof localStorage === 'undefined' ? null : localStorage);

export function clampSplit(percent: number) {
  if (!Number.isFinite(percent)) return SPLIT_DEFAULT;
  return Math.round(Math.min(SPLIT_MAX, Math.max(SPLIT_MIN, percent)) * 10) / 10;
}

/** The chat width for a divider at `clientX`: the chat runs from there to the body's right edge. */
export function splitAt(clientX: number, body: {left: number; width: number}) {
  if (!(body.width > 0)) return SPLIT_DEFAULT;
  return clampSplit((body.left + body.width - clientX) / body.width * 100);
}

export function readSplit(storage: ReadStorage | null = local()) {
  try {
    const saved = storage?.getItem(SPLIT_KEY);
    return saved ? clampSplit(Number(saved)) : SPLIT_DEFAULT;
  } catch { return SPLIT_DEFAULT; }
}

export function writeSplit(percent: number, storage: WriteStorage | null = local()) {
  try { storage?.setItem(SPLIT_KEY, String(clampSplit(percent))); } catch {}
}
