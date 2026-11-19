// Dragging a chat window by its header. The window follows the pointer from local state, so only the window re-renders
// while it moves; the owner gets the final top-left once, on release, and clamps and saves it.
import {useRef,useState,type PointerEvent as ReactPointerEvent,type RefObject} from 'react';
import type {Point} from './geometry';
import type {Bounds} from './sheet';
import {clampWindow,type ChatWindow} from './chat-windows';

/** What a press on a window's header may start a drag from: anything but its controls. */
export const NOT_A_HANDLE = 'button, a, input, select, textarea, label, [contenteditable="true"], .canvas-chat-menu';

type Drag = {id: number; x: number; y: number; from: Point; to: Point | null};

/**
 * `win` is where the window is drawn (the dragged spot while a drag runs). `onStart` runs when a press starts a drag
 * (a passive window comes to the front then). `onEnd` follows every press that started a
 * drag, moved or not, after `onMove`. `focusOnStart` moves focus into the panel when a drag starts (the press's own focus
 * change is prevented, so no text gets selected), so Escape then reaches the window that was just dragged.
 */
export function useWindowDrag({win, bounds, panel, onMove, onStart, onEnd, focusOnStart = false}: {
  win?: ChatWindow; bounds?: Bounds; panel: RefObject<HTMLElement>;
  onMove?(at: Point): void; onStart?(): void; onEnd?(): void; focusOnStart?: boolean;
}) {
  const drag = useRef<Drag | null>(null);
  const [at, setAt] = useState<Point | null>(null);
  const latest = useRef({win, onMove, onStart, onEnd}); latest.current = {win, onMove, onStart, onEnd};
  const shown = win && bounds && at ? clampWindow({...win, ...at}, bounds) : win;
  const end = (event: ReactPointerEvent<HTMLElement>) => {
    const d = drag.current;
    if (d?.id !== event.pointerId) return;
    drag.current = null;
    if (d.to) latest.current.onMove?.(d.to);
    setAt(null);
    latest.current.onEnd?.();
  };
  const handlers = {
    onPointerDown(event: ReactPointerEvent<HTMLElement>) {
      // Only presses on the header's own DOM: a dialog portaled from its slots (the Huddle) bubbles here through React too.
      const from = latest.current.win, target = event.target;
      if (event.button !== 0 || !from || !latest.current.onMove || !(target instanceof Element) || !event.currentTarget.contains(target) || target.closest(NOT_A_HANDLE)) return;
      event.preventDefault();
      if (focusOnStart && !panel.current?.contains(document.activeElement)) panel.current?.focus({preventScroll: true});
      drag.current = {id: event.pointerId, x: event.clientX, y: event.clientY, from: {x: from.x, y: from.y}, to: null};
      try { event.currentTarget.setPointerCapture(event.pointerId); } catch {}
      latest.current.onStart?.();
    },
    onPointerMove(event: ReactPointerEvent<HTMLElement>) {
      const d = drag.current;
      if (d?.id !== event.pointerId) return;
      d.to = {x: d.from.x + event.clientX - d.x, y: d.from.y + event.clientY - d.y};
      setAt(d.to);
    },
    onPointerUp: end, onPointerCancel: end, onLostPointerCapture: end,
  };
  return {win: shown, handlers};
}
