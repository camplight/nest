// The infinite canvas: pan and zoom (mouse, trackpad, touch), culling, area drawing and card/area moves.
// One transformed container holds every mounted item; only items near the viewport mount.
import {useCallback,useEffect,useLayoutEffect,useMemo,useReducer,useRef,useState,type PointerEvent as ReactPointerEvent} from 'react';
import {CARD_HEIGHT,CanvasTint,type BoardCard,type CanvasArea,type CanvasBoard} from '@nest/schemas';
import type {BoardOp} from './board-store';
import {Area,type AreaSummary} from './Area';
import {Card} from './Card';
import {ORIGIN,areaMembers,clampZoom,fit,isCompact,toCanvas,visible,zoomAt,type Point,type Rect,type Size,type View} from './geometry';

export type SurfaceProps = {
  board: CanvasBoard;
  humanId: string;
  onApply(op: BoardOp): Promise<boolean>;
  /** Compact-zoom summaries per area id; Task 6 fills them from live state. */
  summaries?: ReadonlyMap<string, AreaSummary>;
};

type Tool = 'select' | 'area';
type Mode = 'pan' | 'card' | 'area' | 'resize' | 'draw';
type Gesture = {pointerId: number; mode: Mode; id?: string; start: Point; startView: View; active: boolean; members?: {cards: Set<string>; areas: Set<string>}; base?: {w: number; h: number}};
type Preview =
  | {kind: 'card'; id: string; dx: number; dy: number}
  | {kind: 'area'; id: string; dx: number; dy: number; cards: Set<string>; areas: Set<string>}
  | {kind: 'resize'; id: string; w: number; h: number}
  | {kind: 'draw'; rect: Rect};
type Pinch = {ids: [number, number]; dist: number; mid: Point; view: View};

const DRAG_THRESHOLD = 3;
const ZOOM_STEP = 1.25;
const WHEEL_ZOOM_RATE = 0.0025;
const TWIG_TILE = 260;
const MIN_AREA = 160, MAX_AREA = 20_000, MAX_COORD = 1_000_000;
const TINTS = CanvasTint.options;
const SAVE_DELAY_MS = 250;

const viewKey = (humanId: string, canvasId: string) => `nest-canvas-view:${humanId}:${canvasId}`;
function readView(key: string): View | null {
  try {
    const raw = JSON.parse(localStorage.getItem(key) ?? 'null') as Partial<View> | null;
    if (!raw || ![raw.x, raw.y, raw.zoom].every(n => typeof n === 'number' && Number.isFinite(n))) return null;
    return {x: raw.x!, y: raw.y!, zoom: clampZoom(raw.zoom!)};
  } catch { return null; }
}
function writeView(key: string, view: View) {
  try { localStorage.setItem(key, JSON.stringify(view)); } catch {}
}
const clampCoord = (n: number) => Math.round(Math.min(MAX_COORD, Math.max(-MAX_COORD, n)));
const clampSize = (n: number) => Math.round(Math.min(MAX_AREA, Math.max(MIN_AREA, n)));
const isEditable = (target: EventTarget | null) => target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));
const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);
const midpoint = (a: Point, b: Point): Point => ({x: (a.x + b.x) / 2, y: (a.y + b.y) / 2});

export function Surface({board, humanId, onApply, summaries}: SurfaceProps) {
  const canEdit = board.canvas.role !== 'view';
  // Without a known human the view is not remembered, so it can never land under another person's key.
  const key = humanId ? viewKey(humanId, board.canvas.id) : null;
  const surfaceRef = useRef<HTMLDivElement>(null);
  const [saved] = useState(() => key ? readView(key) : null);
  const [view, setViewState] = useState<View>(saved ?? ORIGIN);
  const [ready, setReady] = useState(Boolean(saved));
  const [size, setSize] = useState<Size>({w: 0, h: 0});
  const [tool, setTool] = useState<Tool>('select');
  const [preview, setPreview] = useState<Preview | null>(null);
  const [spaceHeld, setSpaceHeld] = useState(false);

  // Latest values for the native and pointer handlers, which are bound once.
  const viewRef = useRef(view);
  const boardRef = useRef(board); boardRef.current = board;
  const applyRef = useRef(onApply); applyRef.current = onApply;
  const toolRef = useRef(tool); toolRef.current = tool;
  const spaceRef = useRef(false);
  const gesture = useRef<Gesture | null>(null);
  const touches = useRef(new Map<number, Point>());
  const pinch = useRef<Pinch | null>(null);
  const frame = useRef(0);

  /** View changes from gestures land at most once per frame. */
  const setView = useCallback((next: View) => {
    viewRef.current = next;
    if (frame.current) return;
    frame.current = requestAnimationFrame(() => { frame.current = 0; setViewState(viewRef.current); });
  }, []);
  useEffect(() => () => cancelAnimationFrame(frame.current), []);

  // Card heights are not stored: measure the mounted ones and keep the last known value.
  const heights = useRef(new Map<string, number>());
  const elements = useRef(new Map<string, HTMLElement>());
  const [heightTick, bumpHeights] = useReducer((n: number) => n + 1, 0);
  const observer = useMemo(() => typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(entries => {
    let changed = false;
    for (const entry of entries) {
      const element = entry.target as HTMLElement, id = element.dataset.channelId, height = element.offsetHeight;
      if (id && height && heights.current.get(id) !== height) { heights.current.set(id, height); changed = true; }
    }
    if (changed) bumpHeights();
  }), []);
  useEffect(() => () => observer?.disconnect(), [observer]);
  const measure = useCallback((id: string, element: HTMLElement | null) => {
    const previous = elements.current.get(id);
    if (previous && previous !== element) { observer?.unobserve(previous); elements.current.delete(id); }
    if (element && previous !== element) { elements.current.set(id, element); observer?.observe(element); }
  }, [observer]);

  const cardRects = useMemo(() => board.cards.map(card => ({card, x: card.x, y: card.y, w: card.w, h: heights.current.get(card.channelId) ?? CARD_HEIGHT})), [board.cards, heightTick]);
  const contentRects = useCallback((): Rect[] => [...cardRects, ...boardRef.current.areas], [cardRects]);

  useLayoutEffect(() => {
    const element = surfaceRef.current;
    if (!element) return;
    const read = () => setSize({w: element.clientWidth, h: element.clientHeight});
    read();
    const watch = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(read);
    watch?.observe(element);
    return () => watch?.disconnect();
  }, []);

  // Without a saved view, the first view frames whatever is on the canvas.
  useLayoutEffect(() => {
    if (ready || !size.w || !size.h) return;
    const first = fit(contentRects(), size);
    viewRef.current = first;
    setViewState(first);
    setReady(true);
  }, [ready, size, contentRects]);

  useEffect(() => {
    if (!ready || !key) return;
    const timer = setTimeout(() => writeView(key, view), SAVE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [ready, key, view]);

  const local = (event: {clientX: number; clientY: number}): Point => {
    const rect = surfaceRef.current!.getBoundingClientRect();
    return {x: event.clientX - rect.left, y: event.clientY - rect.top};
  };

  // Wheel: Ctrl/Cmd (and trackpad pinch, which arrives as a ctrlKey wheel) zooms; a plain wheel pans.
  useEffect(() => {
    const element = surfaceRef.current;
    if (!element) return;
    const wheel = (event: WheelEvent) => {
      if (isEditable(event.target)) return;
      event.preventDefault();
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? element.clientHeight : 1;
      const current = viewRef.current;
      if (event.ctrlKey || event.metaKey) {
        setView(zoomAt(current, Math.exp(-event.deltaY * unit * WHEEL_ZOOM_RATE), local(event)));
      } else {
        const dx = event.shiftKey && !event.deltaX ? event.deltaY : event.deltaX, dy = event.shiftKey && !event.deltaX ? 0 : event.deltaY;
        setView({...current, x: current.x - dx * unit, y: current.y - dy * unit});
      }
    };
    element.addEventListener('wheel', wheel, {passive: false});
    return () => element.removeEventListener('wheel', wheel);
  }, [setView]);

  const cancel = useCallback(() => {
    gesture.current = null;
    setPreview(null);
  }, []);

  // Space+drag pans from anywhere; Escape drops the tool and any gesture.
  useEffect(() => {
    const down = (event: KeyboardEvent) => {
      // Space still presses a focused button or link; only a free Space arms panning.
      if (isEditable(event.target) || (event.target instanceof Element && event.target.closest('button, a'))) return;
      if (event.key === ' ') { event.preventDefault(); if (!spaceRef.current) { spaceRef.current = true; setSpaceHeld(true); } }
      else if (event.key === 'Escape') { setTool('select'); if (gesture.current?.active) cancel(); }
    };
    const up = (event: KeyboardEvent) => { if (event.key === ' ') { spaceRef.current = false; setSpaceHeld(false); } };
    const blur = () => { spaceRef.current = false; setSpaceHeld(false); };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', blur);
    return () => { window.removeEventListener('keydown', down); window.removeEventListener('keyup', up); window.removeEventListener('blur', blur); };
  }, [cancel]);

  function startPinch() {
    const [[a, pa], [b, pb]] = [...touches.current.entries()];
    pinch.current = {ids: [a, b], dist: Math.max(1, distance(pa, pb)), mid: midpoint(pa, pb), view: viewRef.current};
  }

  function pointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    // A new press always ends the previous gesture, even when this one is ignored below.
    if (gesture.current) cancel();
    if (event.pointerType === 'touch') {
      touches.current.set(event.pointerId, local(event));
      if (touches.current.size === 2) { cancel(); startPinch(); return; }
      if (touches.current.size > 2) return;
    } else if (event.button !== 0 && event.button !== 1) return;
    const target = event.target as HTMLElement;
    const pan = spaceRef.current || event.button === 1;
    if (!pan && target.closest('button, input, textarea, select, a, .canvas-menu, .canvas-chrome')) return;
    const handle = pan ? null : target.closest<HTMLElement>('[data-drag]');
    const start = local(event), startView = viewRef.current;
    const current = boardRef.current;
    let next: Gesture = {pointerId: event.pointerId, mode: 'pan', start, startView, active: false};
    if (handle?.dataset.drag === 'card') {
      next = {...next, mode: 'card', id: handle.dataset.channelId};
    } else if (handle?.dataset.drag === 'area' || handle?.dataset.drag === 'area-resize') {
      const id = handle.closest<HTMLElement>('[data-area-id]')?.dataset.areaId;
      const area = current.areas.find(a => a.id === id);
      if (area && handle.dataset.drag === 'area') next = {...next, mode: 'area', id, members: areaMembers(area.id, current.cards, current.areas)};
      else if (area) next = {...next, mode: 'resize', id, base: {w: area.w, h: area.h}};
    } else if (!pan && toolRef.current === 'area' && canEdit) {
      next = {...next, mode: 'draw'};
    }
    gesture.current = next;
  }

  function pointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.pointerType === 'touch' && touches.current.has(event.pointerId)) {
      touches.current.set(event.pointerId, local(event));
      const p = pinch.current;
      if (p) {
        const a = touches.current.get(p.ids[0]), b = touches.current.get(p.ids[1]);
        if (!a || !b) return;
        const mid = midpoint(a, b), zoomed = zoomAt(p.view, distance(a, b) / p.dist, p.mid);
        setView({...zoomed, x: zoomed.x + mid.x - p.mid.x, y: zoomed.y + mid.y - p.mid.y});
        return;
      }
    }
    const g = gesture.current;
    if (!g || g.pointerId !== event.pointerId) return;
    // A press released outside the surface before the drag began sends no pointerup here:
    // hovering with no button down ends that gesture instead of resuming it.
    if (event.pointerType !== 'touch' && event.buttons === 0) { cancel(); return; }
    const point = local(event);
    const dx = point.x - g.start.x, dy = point.y - g.start.y;
    if (!g.active) {
      if (Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
      g.active = true;
      try { surfaceRef.current?.setPointerCapture(event.pointerId); } catch {}
    }
    const zoom = g.startView.zoom;
    switch (g.mode) {
      case 'pan': setView({...g.startView, x: g.startView.x + dx, y: g.startView.y + dy}); return;
      case 'card': setPreview({kind: 'card', id: g.id!, dx: dx / zoom, dy: dy / zoom}); return;
      case 'area': setPreview({kind: 'area', id: g.id!, dx: dx / zoom, dy: dy / zoom, cards: g.members!.cards, areas: g.members!.areas}); return;
      case 'resize': setPreview({kind: 'resize', id: g.id!, w: clampSize(g.base!.w + dx / zoom), h: clampSize(g.base!.h + dy / zoom)}); return;
      case 'draw': {
        const a = toCanvas(g.startView, g.start), b = toCanvas(viewRef.current, point);
        setPreview({kind: 'draw', rect: {x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(b.x - a.x), h: Math.abs(b.y - a.y)}});
      }
    }
  }

  function pointerUp(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.pointerType === 'touch') {
      touches.current.delete(event.pointerId);
      if (pinch.current) { if (touches.current.size < 2) pinch.current = null; return; }
    }
    const g = gesture.current;
    if (!g || g.pointerId !== event.pointerId) return;
    gesture.current = null;
    setPreview(null);
    if (!g.active || event.type === 'pointercancel') return;
    const point = local(event), zoom = g.startView.zoom;
    const dx = (point.x - g.start.x) / zoom, dy = (point.y - g.start.y) / zoom;
    const current = boardRef.current;
    const apply = (op: BoardOp) => void applyRef.current(op);
    if (g.mode === 'card') {
      const card = current.cards.find(c => c.channelId === g.id);
      if (card) apply({kind: 'moveCard', channelId: card.channelId, x: clampCoord(card.x + dx), y: clampCoord(card.y + dy)});
    } else if (g.mode === 'area') {
      const area = current.areas.find(a => a.id === g.id);
      if (area) apply({kind: 'patchArea', areaId: area.id, patch: {x: clampCoord(area.x + dx), y: clampCoord(area.y + dy)}, moveCards: true});
    } else if (g.mode === 'resize') {
      const area = current.areas.find(a => a.id === g.id);
      if (area) apply({kind: 'patchArea', areaId: area.id, patch: {w: clampSize(g.base!.w + dx), h: clampSize(g.base!.h + dy)}});
    } else if (g.mode === 'draw') {
      const a = toCanvas(g.startView, g.start), b = toCanvas(viewRef.current, point);
      apply({kind: 'createArea', area: {
        id: crypto.randomUUID(), title: 'New area',
        x: clampCoord(Math.min(a.x, b.x)), y: clampCoord(Math.min(a.y, b.y)),
        w: clampSize(Math.abs(b.x - a.x)), h: clampSize(Math.abs(b.y - a.y)),
        tint: TINTS[current.areas.length % TINTS.length],
      }});
      setTool('select');
    }
  }

  const zoomBy = (factor: number) => setView(zoomAt(viewRef.current, factor, {x: size.w / 2, y: size.h / 2}));
  const fitAll = () => setView(fit(contentRects(), size));
  const rename = useCallback((areaId: string, title: string) => void applyRef.current({kind: 'patchArea', areaId, patch: {title}}), []);
  const remove = useCallback((areaId: string) => {
    // The area and its focused Delete button unmount: keep keyboard focus on the canvas.
    surfaceRef.current?.focus({preventScroll: true});
    void applyRef.current({kind: 'deleteArea', areaId});
  }, []);

  const compact = isCompact(view);
  const shownCards = useMemo(() => new Set(visible(cardRects, view, size).map(r => r.card.channelId)), [cardRects, view, size]);
  const shownAreas = useMemo(() => new Set(visible(board.areas, view, size).map(a => a.id)), [board.areas, view, size]);
  const cardShift = (card: BoardCard) =>
    preview?.kind === 'card' && preview.id === card.channelId ? preview
      : preview?.kind === 'area' && preview.cards.has(card.channelId) ? preview : null;
  const areaShift = (area: CanvasArea) =>
    preview?.kind === 'area' && (preview.id === area.id || preview.areas.has(area.id)) ? preview : null;

  const tile = TWIG_TILE * view.zoom;
  const classes = ['canvas-surface', tool === 'area' ? 'is-drawing' : '', spaceHeld ? 'is-panning-key' : '', preview ? 'is-gesturing' : ''].filter(Boolean).join(' ');
  return <div
    ref={surfaceRef}
    tabIndex={-1}
    className={classes}
    aria-label={`Canvas ${board.canvas.name}`}
    data-role={board.canvas.role}
    style={{backgroundSize: `${tile}px ${tile}px`, backgroundPosition: `${view.x}px ${view.y}px`}}
    onPointerDown={pointerDown}
    onPointerMove={pointerMove}
    onPointerUp={pointerUp}
    onPointerCancel={pointerUp}
    onLostPointerCapture={event => {
      // Only the surface's own capture counts; a touch target losing its implicit capture to the surface bubbles here too.
      if (event.target === surfaceRef.current && gesture.current?.pointerId === event.pointerId && gesture.current.active) cancel();
    }}>
    <div className={`canvas-world${compact ? ' is-compact' : ''}`} style={{transform: `translate(${view.x}px, ${view.y}px) scale(${view.zoom})`, visibility: ready ? undefined : 'hidden'}}>
      {board.areas.map(area => {
        const shift = areaShift(area), resize = preview?.kind === 'resize' && preview.id === area.id ? preview : null;
        if (!shift && !resize && !shownAreas.has(area.id)) return null;
        return <Area key={area.id} area={area} dx={shift?.dx ?? 0} dy={shift?.dy ?? 0} w={resize?.w ?? area.w} h={resize?.h ?? area.h}
          canEdit={canEdit} compact={compact} summary={summaries?.get(area.id)} onRename={rename} onDelete={remove}/>;
      })}
      {preview?.kind === 'draw' ? <div className="canvas-area-draft" style={{transform: `translate(${preview.rect.x}px, ${preview.rect.y}px)`, width: Math.max(MIN_AREA, preview.rect.w), height: Math.max(MIN_AREA, preview.rect.h)}}/> : null}
      {board.cards.map(card => {
        const shift = cardShift(card);
        if (!shift && !shownCards.has(card.channelId)) return null;
        return <Card key={card.channelId} card={card} draggable={canEdit} dx={shift?.dx ?? 0} dy={shift?.dy ?? 0}
          dragging={preview?.kind === 'card' && preview.id === card.channelId} measure={measure}/>;
      })}
    </div>
    <div className="canvas-chrome canvas-tools" role="toolbar" aria-label="Canvas tools">
      <button type="button" className="canvas-tool" aria-pressed={tool === 'area'} disabled={!canEdit}
        title={canEdit ? 'Drag on the canvas to draw an area' : 'You can view this canvas but not change it.'}
        onClick={() => setTool(t => t === 'area' ? 'select' : 'area')}>Area</button>
    </div>
    <div className="canvas-chrome canvas-zoom" role="group" aria-label="Zoom">
      <button type="button" aria-label="Zoom out" onClick={() => zoomBy(1 / ZOOM_STEP)}><span aria-hidden="true">−</span></button>
      <output aria-label="Zoom level" aria-live="polite">{Math.round(view.zoom * 100)}%</output>
      <button type="button" aria-label="Zoom in" onClick={() => zoomBy(ZOOM_STEP)}><span aria-hidden="true">+</span></button>
      <button type="button" className="canvas-fit" onClick={fitAll}>Fit</button>
    </div>
  </div>;
}
