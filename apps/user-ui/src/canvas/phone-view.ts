// Phones (760 px wide or less): the canvas by default, or the list (PhoneList) once the top bar's `List` toggle is
// pressed; the choice is remembered per browser. Also which pieces of the canvas chrome each layout shows. Pure.

export type PhoneView = 'canvas' | 'list';
/** Where the phone's choice is kept (localStorage; a blocked or empty store means the canvas). */
export const PHONE_VIEW_KEY = 'nest-canvas-phone-view';

/** The stored choice: the list only when it was chosen, the canvas otherwise (nothing stored, or anything else). */
export function phoneView(stored: string | null): PhoneView {
  return stored === 'list' ? 'list' : 'canvas';
}
export function readPhoneView(): PhoneView {
  try { return phoneView(localStorage.getItem(PHONE_VIEW_KEY)); } catch { return 'canvas'; }
}
export function writePhoneView(view: PhoneView) {
  try { localStorage.setItem(PHONE_VIEW_KEY, view); } catch {}
}

export type CanvasChrome = {
  /** The phone list in place of the surface. */
  list: boolean;
  /** The status legend (the mock's `.legend`). */
  legend: boolean;
  /** The zoom buttons and Fit (phones pinch instead). */
  zoom: boolean;
  /** The Loose chats drawer (the list has its own Loose chats segment instead). */
  drawer: boolean;
  /** The top bar's Needs you button (the list has its own Needs you segment instead). */
  needsButton: boolean;
  /** The top bar's `List` toggle. */
  viewToggle: boolean;
};

/**
 * What the canvas shows: on a phone, the list or the canvas without the legend and zoom buttons (the mock's phone rule;
 * Nest's navigation rail is already a slide-in menu there); on a wider screen, everything, the legend except in split screen.
 */
export function canvasChrome(phone: boolean, view: PhoneView, split: boolean): CanvasChrome {
  if (!phone) return {list: false, legend: !split, zoom: true, drawer: true, needsButton: true, viewToggle: false};
  const list = view === 'list';
  return {list, legend: false, zoom: false, drawer: !list, needsButton: !list, viewToggle: true};
}
