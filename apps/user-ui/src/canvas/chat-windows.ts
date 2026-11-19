// The floating chat windows on the desktop canvas: a front-to-back list, where a new one goes, and per-canvas memory.
import type {Point} from './geometry';
import {SHEET_GUTTER,SHEET_MAX_HEIGHT,type Bounds} from './sheet';

export const MAX_WINDOWS = 4;
export const WINDOW_WIDTH = 440;
export const WINDOW_MIN_WIDTH = 320;
export const CASCADE_STEP = 32;

/** `x`/`y` are the top-left in stage px. */
export type ChatWindow = {channelId: string; x: number; y: number};
/** Index 0 is the front window. */
export type WindowList = readonly ChatWindow[];

const STORAGE_PREFIX = 'nest-canvas-windows:';

export const windowWidth = (bounds: Bounds) => Math.max(WINDOW_MIN_WIDTH, Math.min(WINDOW_WIDTH, bounds.right - bounds.left));
export const windowHeight = (bounds: Bounds) => Math.min(SHEET_MAX_HEIGHT, bounds.bottom - bounds.top);

const clamp = (n: number, min: number, max: number) => Math.min(Math.max(n, min), Math.max(min, max));

/** Keeps the whole window inside the bounds; where it cannot fit, the top-left edge wins. */
export function clampWindow(win: ChatWindow, bounds: Bounds): ChatWindow {
  return {
    ...win,
    x: clamp(win.x, bounds.left, bounds.right - windowWidth(bounds)),
    y: clamp(win.y, bounds.top, bounds.bottom - windowHeight(bounds)),
  };
}

/** Beside the card (right, else left), cascaded from the front window, else the bounds' top-left. Always inside the bounds. */
export function placeWindow(card: {x: number; y: number; w: number} | null, front: ChatWindow | null, bounds: Bounds): Point {
  const width = windowWidth(bounds);
  let at: Point;
  if (card) {
    const right = card.x + card.w + SHEET_GUTTER;
    at = {x: right + width <= bounds.right ? right : card.x - SHEET_GUTTER - width, y: card.y};
  } else if (front) at = {x: front.x + CASCADE_STEP, y: front.y + CASCADE_STEP};
  else at = {x: bounds.left + SHEET_GUTTER, y: bounds.top + SHEET_GUTTER};
  const {x, y} = clampWindow({channelId: '', ...at}, bounds);
  return {x, y};
}

export function bringToFront(list: WindowList, channelId: string): WindowList {
  const win = list.find(w => w.channelId === channelId);
  return win ? [win, ...list.filter(w => w !== win)] : list;
}

/** Opens at `at` (an open chat only comes forward). Beyond MAX_WINDOWS the back-most window other than `activeId` closes. */
export function openWindow(list: WindowList, channelId: string, at: Point, activeId: string | null): WindowList {
  if (list.some(w => w.channelId === channelId)) return bringToFront(list, channelId);
  const next = [{channelId, x: at.x, y: at.y}, ...list];
  if (next.length <= MAX_WINDOWS) return next;
  for (let i = next.length - 1; i > 0; i--) {
    if (next[i].channelId !== activeId) return next.filter((_, j) => j !== i);
  }
  return next.slice(0, MAX_WINDOWS);
}

export function closeWindow(list: WindowList, channelId: string): {list: WindowList; next: string | null} {
  const rest = list.filter(w => w.channelId !== channelId);
  return {list: rest, next: rest[0]?.channelId ?? null};
}

export function moveWindow(list: WindowList, channelId: string, at: Point, bounds: Bounds): WindowList {
  return list.map(w => (w.channelId === channelId ? clampWindow({...w, ...at}, bounds) : w));
}

export function pruneWindows(list: WindowList, allowed: ReadonlySet<string>): WindowList {
  return list.filter(w => allowed.has(w.channelId));
}

const isWindow = (v: unknown): v is ChatWindow => {
  if (!v || typeof v !== 'object') return false;
  const w = v as Record<string, unknown>;
  return typeof w.channelId === 'string' && w.channelId !== '' && Number.isFinite(w.x) && Number.isFinite(w.y);
};

export function readWindows(canvasId: string): WindowList {
  try {
    const parsed: unknown = JSON.parse(sessionStorage.getItem(STORAGE_PREFIX + canvasId) ?? '[]');
    if (!Array.isArray(parsed)) return [];
    const seen = new Set<string>();
    const list: ChatWindow[] = [];
    for (const item of parsed) {
      if (!isWindow(item) || seen.has(item.channelId)) continue;
      seen.add(item.channelId);
      list.push({channelId: item.channelId, x: item.x, y: item.y});
      if (list.length === MAX_WINDOWS) break;
    }
    return list;
  } catch {
    return [];
  }
}

export function writeWindows(canvasId: string, list: WindowList): void {
  try {
    sessionStorage.setItem(STORAGE_PREFIX + canvasId, JSON.stringify(list));
  } catch {
    // Storage is optional: without it the windows just do not survive a reload.
  }
}
