import { useRef, type CSSProperties, type KeyboardEvent, type PointerEvent } from "react";

export const SIDEBAR_DEFAULT_WIDTH = 248;
export const SIDEBAR_MIN_WIDTH = 200;
export const SIDEBAR_MAX_WIDTH = 440;
const STORAGE_KEY = "nest-sidebar-width";
const KEY_STEP = 16;

export function clampSidebarWidth(value: number): number {
  return Math.round(Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, value)));
}

/** The width this browser last chose, or null for the default. Storage may be unavailable. */
export function readSidebarWidth(): number | null {
  try {
    const stored = Number(localStorage.getItem(STORAGE_KEY));
    return Number.isFinite(stored) && stored > 0 ? clampSidebarWidth(stored) : null;
  } catch {
    return null;
  }
}

export function storeSidebarWidth(width: number | null) {
  try {
    if (width === null) localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, String(width));
  } catch {
    // A per-browser convenience only; the default width still works.
  }
}

/** Inline style for the shell; the CSS falls back to the default width when unset. */
export function sidebarWidthStyle(width: number | null): CSSProperties | undefined {
  return width === null ? undefined : ({ "--sidebar-width": `${width}px` } as CSSProperties);
}

/** Drag handle on the sidebar's right edge. Arrow keys resize; Enter or double-click resets. */
export function SidebarResizer({ width, onChange }: { width: number | null; onChange(width: number | null): void }) {
  const drag = useRef<{ startX: number; startWidth: number } | null>(null);
  const current = width ?? SIDEBAR_DEFAULT_WIDTH;
  const commit = (next: number | null) => {
    onChange(next);
    storeSidebarWidth(next);
  };
  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { startX: event.clientX, startWidth: current };
    document.body.classList.add("sidebar-resizing");
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    onChange(clampSidebarWidth(drag.current.startWidth + event.clientX - drag.current.startX));
  };
  const endDrag = (event: PointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    const next = clampSidebarWidth(drag.current.startWidth + event.clientX - drag.current.startX);
    drag.current = null;
    document.body.classList.remove("sidebar-resizing");
    commit(next);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const keys: Record<string, number | null> = {
      ArrowLeft: clampSidebarWidth(current - KEY_STEP),
      ArrowRight: clampSidebarWidth(current + KEY_STEP),
      Home: SIDEBAR_MIN_WIDTH,
      End: SIDEBAR_MAX_WIDTH,
      Enter: null,
    };
    if (!(event.key in keys)) return;
    event.preventDefault();
    commit(keys[event.key] ?? null);
  };
  return (
    <div
      className="sidebar-resizer"
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize sidebar"
      aria-valuemin={SIDEBAR_MIN_WIDTH}
      aria-valuemax={SIDEBAR_MAX_WIDTH}
      aria-valuenow={current}
      title="Drag to resize. Double-click to reset."
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onDoubleClick={() => commit(null)}
      onKeyDown={onKeyDown}
    />
  );
}
