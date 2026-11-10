// The infinite canvas: pan and zoom (mouse, trackpad, touch), culling, area drawing and card/area moves.
// One transformed container holds every mounted item; only items near the viewport mount.
import {useCallback,useEffect,useLayoutEffect,useMemo,useReducer,useRef,useState,type DragEvent as ReactDragEvent,type MutableRefObject,type PointerEvent as ReactPointerEvent} from 'react';
import {CARD_HEIGHT,CanvasTint,areaFor,type BoardCard,type CanvasArea,type CanvasBoard} from '@nest/schemas';
import type {BoardOp} from './board-store';
import {Area,type AreaContext,type AreaSummary} from './Area';
import {Card} from './Card';
import {droppedFiles,outsideFileDropTargets} from '../components/file-drop';
import {AgentAvatar} from '../components/AgentAvatar';
import {areaSummaries,type CardPulse} from './pulse';
import {ORIGIN,areaMembers,cardCentre,clampZoom,fit,growToFit,isCompact,toCanvas,visible,zoomAt,type Point,type Rect,type Size,type View} from './geometry';

export type SurfaceProps = {
  board: CanvasBoard;
  humanId: string;
  onApply(op: BoardOp): Promise<boolean>;
  /** Live state per channel id; each card gets its own pulse object, stable while unchanged. */
  pulses?: ReadonlyMap<string, CardPulse>;
  onNudge?(channelId: string, agent: string): Promise<void>;
  /** Loose chats dragged from the pile (one, or every selected row) and dropped here, at this canvas point. */
  onDropChat?(channelIds: string[], at: Point): void;
  /** Filled in by the surface so its owner can ask where the viewport is. */
  controls?: MutableRefObject<SurfaceControls | null>;
  /** A click (not a drag) on an open card's body. */
  onOpenChat?(channelId: string): void;
  /** The chat open beside or over the canvas, marked on its card. */
  openChannelId?: string | null;
  /** An agent from the tray or picker dropped on an open card. Locked and unavailable cards take no drop. */
  onDropAgent?(channelId: string, agent: string): void;
  /** An agent's face dragged more than REMOVE_DISTANCE outside its card. */
  onRemoveAgent?(channelId: string, agent: string): void;
  /** Whether the person may add and remove this card's agents; without it no face drags. */
  canManageCard?(card: BoardCard): boolean;
  /** A press on a card selects it (the agent tray suggests for the selected card). */
  onSelectCard?(channelId: string): void;
  selectedChannelId?: string | null;
  /** Each area's context markers (dot and `↳` chips), from one summary request per board load. */
  areaContext?: ReadonlyMap<string, AreaContext>;
  /** Opens an area's context panel. */
  onAreaContext?(areaId: string): void;
  /**
   * Files dropped on an open card or, for editors, on an area. A file drag highlights the card or area under it.
   * Anywhere else on the canvas, file drags are left to the bottom box or the open chat.
   */
  onDropFiles?(target: FileDropTarget, files: File[], folders: boolean): void;
};
export type FileDropTarget = {kind: 'card'; channelId: string} | {kind: 'area'; areaId: string};
const carriesFiles = (event: ReactDragEvent) => event.dataTransfer.types.includes('Files');
export type SurfaceControls = {
  /** The canvas point at the centre of the viewport. */
  centre(): Point;
  /** Animates the view to a card (at zoom 0.8 or more) or fits an area. False when it is not on this canvas. */
  reveal(target: {channelId: string} | {areaId: string}): boolean;
};
/** A reveal reads at a comfortable size: never smaller than this. */
const REVEAL_MIN_ZOOM = 0.8;
const REVEAL_MS = 320;
const prefersReducedMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
/** The drag data type a pile row carries: the chat's channel id, or several ids on separate lines. */
export const CHAT_DRAG_TYPE = 'application/x-nest-chat';
/** The drag data type a tray or picker face carries: the agent's name. */
export const AGENT_DRAG_TYPE = 'application/x-nest-agent';
const NO_PULSES: ReadonlyMap<string, CardPulse> = new Map();

type Tool = 'select' | 'area';
type Mode = 'pan' | 'card' | 'area' | 'resize' | 'draw' | 'face';
type Gesture = {pointerId: number; mode: Mode; id?: string; agent?: string; start: Point; startView: View; active: boolean; members?: {cards: Set<string>; areas: Set<string>}; base?: {w: number; h: number}};
type Preview =
  | {kind: 'card'; id: string; dx: number; dy: number}
  | {kind: 'area'; id: string; dx: number; dy: number; cards: Set<string>; areas: Set<string>}
  | {kind: 'resize'; id: string; w: number; h: number}
  | {kind: 'draw'; rect: Rect}
  | {kind: 'face'; id: string; agent: string; x: number; y: number; away: boolean};
type Pinch = {ids: [number, number]; dist: number; mid: Point; view: View};

const DRAG_THRESHOLD = 3;
const ZOOM_STEP = 1.25;
const WHEEL_ZOOM_RATE = 0.0025;
const TWIG_TILE = 260;
const MIN_AREA = 160, MAX_AREA = 20_000, MAX_COORD = 1_000_000;
const TINTS = CanvasTint.options;
const SAVE_DELAY_MS = 250;
/** A face released more than this many screen pixels outside its card's bounds leaves the chat. */
export const REMOVE_DISTANCE = 80;

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

export function Surface({board, humanId, onApply, pulses = NO_PULSES, onNudge, onDropChat, controls, onOpenChat, openChannelId = null,
  onDropAgent, onRemoveAgent, canManageCard, onSelectCard, selectedChannelId = null, areaContext, onAreaContext, onDropFiles}: SurfaceProps) {
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
  const pointerOver = useRef(false);
  /** Set by a drag's pointerup so the click that follows it does not open the card. */
  const dragged = useRef(false);
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

  // An animated move of the view. Any gesture that sets the view meanwhile takes over, and the animation stops.
  const tween = useRef(0);
  useEffect(() => () => cancelAnimationFrame(tween.current), []);
  const animateTo = useCallback((target: View) => {
    cancelAnimationFrame(tween.current);
    if (prefersReducedMotion() || typeof requestAnimationFrame !== 'function') { viewRef.current = target; setViewState(target); return; }
    const from = viewRef.current, started = performance.now();
    let last = from;
    const step = (time: number) => {
      if (viewRef.current !== last) return;
      const t = Math.min(1, (time - started) / REVEAL_MS), e = 1 - (1 - t) ** 3;
      last = {x: from.x + (target.x - from.x) * e, y: from.y + (target.y - from.y) * e, zoom: from.zoom + (target.zoom - from.zoom) * e};
      viewRef.current = last;
      setViewState(last);
      if (t < 1) tween.current = requestAnimationFrame(step);
    };
    tween.current = requestAnimationFrame(step);
  }, []);
  const cardRectsRef = useRef(cardRects); cardRectsRef.current = cardRects;
  useEffect(() => {
    if (!controls) return;
    controls.current = {
      centre: () => {
        const element = surfaceRef.current;
        return toCanvas(viewRef.current, {x: (element?.clientWidth ?? 0) / 2, y: (element?.clientHeight ?? 0) / 2});
      },
      reveal: target => {
        const element = surfaceRef.current;
        if (!element?.clientWidth || !element.clientHeight) return false;
        const viewport = {w: element.clientWidth, h: element.clientHeight};
        const card = 'channelId' in target;
        const rect: Rect | undefined = card ? cardRectsRef.current.find(c => c.card.channelId === target.channelId) : boardRef.current.areas.find(a => a.id === target.areaId);
        if (!rect) return false;
        let next = fit([rect], viewport);
        if (card && next.zoom < REVEAL_MIN_ZOOM) {
          const zoom = REVEAL_MIN_ZOOM;
          next = {zoom, x: viewport.w / 2 - (rect.x + rect.w / 2) * zoom, y: viewport.h / 2 - (rect.y + rect.h / 2) * zoom};
        }
        animateTo(next);
        return true;
      },
    };
    return () => { controls.current = null; };
  }, [controls, animateTo]);

  const dropRef = useRef(onDropChat); dropRef.current = onDropChat;
  const carriesChat = (event: ReactDragEvent) => canEdit && Boolean(dropRef.current) && event.dataTransfer.types.includes(CHAT_DRAG_TYPE);
  // An agent drag targets the open card under the pointer; anywhere else (locked, unavailable, empty canvas) takes no drop.
  const agentDropRef = useRef(onDropAgent); agentDropRef.current = onDropAgent;
  const [dropId, setDropId] = useState<string | null>(null);
  /** The area a pile chat would land in if dropped now. */
  const [chatDropArea, setChatDropArea] = useState<string | null>(null);
  const carriesAgent = (event: ReactDragEvent) => Boolean(agentDropRef.current) && event.dataTransfer.types.includes(AGENT_DRAG_TYPE);
  const openCardAt = (event: ReactDragEvent) => {
    const id = (event.target instanceof Element ? event.target.closest<HTMLElement>('.canvas-card') : null)?.dataset.channelId;
    const card = id ? boardRef.current.cards.find(c => c.channelId === id) : undefined;
    return card?.access === 'open' ? card : null;
  };
  useEffect(() => {
    const end = () => { setDropId(null); setChatDropArea(null); };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') end(); };
    window.addEventListener('dragend', end, true);
    // A drop that lands elsewhere (the bottom box, the panel) or a drag that leaves the window ends the highlight too.
    window.addEventListener('drop', end, true);
    window.addEventListener('blur', end);
    window.addEventListener('keydown', escape);
    return () => {
      window.removeEventListener('dragend', end, true);
      window.removeEventListener('drop', end, true);
      window.removeEventListener('blur', end);
      window.removeEventListener('keydown', escape);
    };
  }, []);
  // A file drag targets the open card (anyone with chat access) or the area (editors) under the pointer.
  const filesRef = useRef(onDropFiles); filesRef.current = onDropFiles;
  const fileTargetAt = (event: ReactDragEvent): FileDropTarget | null => {
    if (!filesRef.current || !(event.target instanceof Element)) return null;
    const cardId = event.target.closest<HTMLElement>('.canvas-card')?.dataset.channelId;
    if (cardId) return boardRef.current.cards.some(c => c.channelId === cardId && c.access === 'open') ? {kind: 'card', channelId: cardId} : null;
    const areaId = event.target.closest<HTMLElement>('.canvas-area')?.dataset.areaId;
    return areaId && canEdit ? {kind: 'area', areaId} : null;
  };
  const ownsFiles = (event: ReactDragEvent) => carriesFiles(event) && !outsideFileDropTargets(event.target);
  function dragOver(event: ReactDragEvent<HTMLDivElement>) {
    if (carriesFiles(event)) {
      // Over a card or area the browser must not open the file, even where nothing takes it (a locked card, a viewer's area).
      if (!ownsFiles(event)) { setDropId(null); setChatDropArea(null); return; }
      event.preventDefault();
      const target = fileTargetAt(event);
      event.dataTransfer.dropEffect = target ? 'copy' : 'none';
      setDropId(target?.kind === 'card' ? target.channelId : null);
      setChatDropArea(target?.kind === 'area' ? target.areaId : null);
      return;
    }
    if (carriesAgent(event)) {
      const card = openCardAt(event);
      setDropId(card?.channelId ?? null);
      if (!card) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'copy';
      return;
    }
    if (!carriesChat(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    setChatDropArea(areaFor(toCanvas(viewRef.current, local(event)), boardRef.current.areas)?.id ?? null);
  }
  function drop(event: ReactDragEvent<HTMLDivElement>) {
    if (carriesFiles(event)) {
      setDropId(null); setChatDropArea(null);
      if (!ownsFiles(event)) return;
      event.preventDefault();
      const target = fileTargetAt(event), {files, folders} = droppedFiles(event.dataTransfer);
      if (target && (files.length || folders)) filesRef.current?.(target, files, folders);
      return;
    }
    if (carriesAgent(event)) {
      setDropId(null);
      const card = openCardAt(event);
      if (!card) return;
      event.preventDefault();
      const agent = event.dataTransfer.getData(AGENT_DRAG_TYPE);
      if (agent) agentDropRef.current?.(card.channelId, agent);
      return;
    }
    if (!carriesChat(event)) return;
    event.preventDefault();
    setChatDropArea(null);
    const channelIds = event.dataTransfer.getData(CHAT_DRAG_TYPE).split('\n').map(id => id.trim()).filter(Boolean);
    if (channelIds.length) dropRef.current?.(channelIds, toCanvas(viewRef.current, local(event)));
  }

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

  // Space+drag pans while focus is on the canvas, or nowhere with the pointer over it; Escape drops the tool and any gesture.
  useEffect(() => {
    const down = (event: KeyboardEvent) => {
      // Space still presses a focused button or link; only a free Space arms panning.
      if (isEditable(event.target) || (event.target instanceof Element && event.target.closest('button, a'))) return;
      if (event.key === ' ') {
        // A split-screen chat (or anything else beside the canvas) keeps its own Space.
        const surface = surfaceRef.current, focus = document.activeElement;
        const onSurface = Boolean(surface && focus && surface.contains(focus));
        if (!onSurface && !((!focus || focus === document.body) && pointerOver.current)) return;
        event.preventDefault(); if (!spaceRef.current) { spaceRef.current = true; setSpaceHeld(true); }
      }
      else if (event.key === 'Escape') { setTool('select'); if (gesture.current?.active) cancel(); }
    };
    const up = (event: KeyboardEvent) => { if (event.key === ' ') { spaceRef.current = false; setSpaceHeld(false); } };
    const blur = () => { spaceRef.current = false; setSpaceHeld(false); };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', blur);
    return () => { window.removeEventListener('keydown', down); window.removeEventListener('keyup', up); window.removeEventListener('blur', blur); };
  }, [cancel]);

  const removeAgentRef = useRef(onRemoveAgent); removeAgentRef.current = onRemoveAgent;
  const selectRef = useRef(onSelectCard); selectRef.current = onSelectCard;
  /** Whether a screen point is more than REMOVE_DISTANCE outside the card's on-screen bounds. */
  const awayFrom = (channelId: string, at: {clientX: number; clientY: number}) => {
    const r = elements.current.get(channelId)?.getBoundingClientRect();
    if (!r) return false;
    return at.clientX < r.left - REMOVE_DISTANCE || at.clientX > r.right + REMOVE_DISTANCE
      || at.clientY < r.top - REMOVE_DISTANCE || at.clientY > r.bottom + REMOVE_DISTANCE;
  };

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
    const pressed = pan ? undefined : target.closest<HTMLElement>('.canvas-card')?.dataset.channelId;
    if (pressed) selectRef.current?.(pressed);
    if (!pan && target.closest('button, input, textarea, select, a, .canvas-menu, .canvas-chrome')) return;
    const handle = pan ? null : target.closest<HTMLElement>('[data-drag]');
    const start = local(event), startView = viewRef.current;
    const current = boardRef.current;
    let next: Gesture = {pointerId: event.pointerId, mode: 'pan', start, startView, active: false};
    if (handle?.dataset.drag === 'face' && pressed && handle.dataset.agent) {
      next = {...next, mode: 'face', id: pressed, agent: handle.dataset.agent};
    } else if (handle?.dataset.drag === 'card') {
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
      case 'face': setPreview({kind: 'face', id: g.id!, agent: g.agent!, x: point.x, y: point.y, away: awayFrom(g.id!, event)}); return;
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
    if (g.active) { dragged.current = true; setTimeout(() => { dragged.current = false; }, 0); }
    if (!g.active || event.type === 'pointercancel') return;
    if (g.mode === 'face') {
      if (awayFrom(g.id!, event)) removeAgentRef.current?.(g.id!, g.agent!);
      return;
    }
    const point = local(event), zoom = g.startView.zoom;
    const dx = (point.x - g.start.x) / zoom, dy = (point.y - g.start.y) / zoom;
    const current = boardRef.current;
    const apply = (op: BoardOp) => void applyRef.current(op);
    if (g.mode === 'card') {
      const card = current.cards.find(c => c.channelId === g.id);
      if (card) {
        const moved = {x: clampCoord(card.x + dx), y: clampCoord(card.y + dy), w: card.w, h: heights.current.get(card.channelId) ?? CARD_HEIGHT};
        apply({kind: 'moveCard', channelId: card.channelId, x: moved.x, y: moved.y});
        // A card dropped into an area that does not quite hold it grows the area to fit.
        const target = areaFor(cardCentre(moved), current.areas);
        const grown = target ? growToFit(target, [moved]) : null;
        if (target && grown) apply({kind: 'patchArea', areaId: target.id, patch: grown});
      }
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

  // A hovered or focused `↳` chip draws a dotted line to its source area when that area is on this canvas.
  const [linkHover, setLinkHover] = useState<{from: string; to: string} | null>(null);
  const hoverLink = useCallback((areaId: string, sourceAreaId: string | null) =>
    setLinkHover(current => sourceAreaId ? {from: areaId, to: sourceAreaId} : current?.from === areaId ? null : current), []);
  const areaContextRef = useRef(onAreaContext); areaContextRef.current = onAreaContext;
  const openAreaContext = useCallback((areaId: string) => areaContextRef.current?.(areaId), []);

  const nudgeRef = useRef(onNudge); nudgeRef.current = onNudge;
  const nudge = useCallback(async (channelId: string, agent: string) => { await nudgeRef.current?.(channelId, agent); }, []);
  const openRef = useRef(onOpenChat); openRef.current = onOpenChat;
  // Stable while the surface lives, so memoized cards do not re-render; a drag or Space-pan never opens.
  const openCard = useCallback((channelId: string) => {
    if (dragged.current || spaceRef.current) return;
    openRef.current?.(channelId);
  }, []);
  const removeCard = useCallback((channelId: string) => {
    surfaceRef.current?.focus({preventScroll: true});
    void applyRef.current({kind: 'removeCard', channelId});
  }, []);

  const compact = isCompact(view);
  // Summaries show only at compact zoom; an unchanged count keeps its object so the area does not re-render.
  const summaryCache = useRef(new Map<string, AreaSummary>());
  const summaries = useMemo(() => {
    if (!compact) return null;
    const next = new Map<string, AreaSummary>();
    for (const [id, summary] of areaSummaries(board.cards, board.areas, pulses)) {
      const previous = summaryCache.current.get(id);
      next.set(id, previous && previous.needYou === summary.needYou && previous.moving === summary.moving ? previous : summary);
    }
    summaryCache.current = next;
    return next;
  }, [compact, board.cards, board.areas, pulses]);
  const shownCards = useMemo(() => new Set(visible(cardRects, view, size).map(r => r.card.channelId)), [cardRects, view, size]);
  const shownAreas = useMemo(() => new Set(visible(board.areas, view, size).map(a => a.id)), [board.areas, view, size]);
  // Which area each card sits in (by centre, like the API), for the tinted stripe on cards in an area.
  const homes = useMemo(() => new Map(board.cards.map(card => [card.channelId, areaFor(cardCentre(card), board.areas)])), [board.cards, board.areas]);
  const movingCard = preview?.kind === 'card' ? board.cards.find(c => c.channelId === preview.id) : undefined;
  // The area a dragged card or pile chat would join if dropped now: it lights up while the pointer is over it.
  const cardTarget = movingCard && preview?.kind === 'card'
    ? areaFor(cardCentre({x: movingCard.x + preview.dx, y: movingCard.y + preview.dy, w: movingCard.w}), board.areas) : undefined;
  const targetAreaId = cardTarget !== undefined ? cardTarget?.id ?? null : chatDropArea;
  const homeOf = (card: BoardCard) => card === movingCard ? cardTarget ?? null : homes.get(card.channelId) ?? null;
  const cardShift = (card: BoardCard) =>
    preview?.kind === 'card' && preview.id === card.channelId ? preview
      : preview?.kind === 'area' && preview.cards.has(card.channelId) ? preview : null;
  const areaShift = (area: CanvasArea) =>
    preview?.kind === 'area' && (preview.id === area.id || preview.areas.has(area.id)) ? preview : null;

  // A removed link draws nothing, even when its chip went away under the pointer.
  const linked = linkHover && areaContext?.get(linkHover.from)?.links.some(l => l.sourceAreaId === linkHover.to);
  const linkFrom = linked ? board.areas.find(a => a.id === linkHover.from) : undefined;
  const linkTo = linkHover ? board.areas.find(a => a.id === linkHover.to) : undefined;
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
    onPointerEnter={() => { pointerOver.current = true; }}
    onPointerLeave={() => { pointerOver.current = false; }}
    // A press on a face's image or a file chip would start the browser's own drag and cancel the pointer gesture.
    onDragStart={event => event.preventDefault()}
    onDragOver={dragOver}
    onDrop={drop}
    onDragLeave={event => { if (!(event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget))) { setDropId(null); setChatDropArea(null); } }}
    onLostPointerCapture={event => {
      // Only the surface's own capture counts; a touch target losing its implicit capture to the surface bubbles here too.
      if (event.target === surfaceRef.current && gesture.current?.pointerId === event.pointerId && gesture.current.active) cancel();
    }}>
    <div className={`canvas-world${compact ? ' is-compact' : ''}`} style={{transform: `translate(${view.x}px, ${view.y}px) scale(${view.zoom})`, visibility: ready ? undefined : 'hidden'}}>
      {board.areas.map(area => {
        const shift = areaShift(area), resize = preview?.kind === 'resize' && preview.id === area.id ? preview : null;
        if (!shift && !resize && !shownAreas.has(area.id)) return null;
        return <Area key={area.id} area={area} dx={shift?.dx ?? 0} dy={shift?.dy ?? 0} w={resize?.w ?? area.w} h={resize?.h ?? area.h}
          canEdit={canEdit} compact={compact} summary={summaries?.get(area.id)} dropTarget={area.id === targetAreaId} onRename={rename} onDelete={remove}
          context={areaContext?.get(area.id)} onContext={onAreaContext ? openAreaContext : undefined} onLinkHover={hoverLink}/>;
      })}
      {linkFrom && linkTo ? <ContextLine from={linkFrom} to={linkTo}/> : null}
      {preview?.kind === 'draw' ? <div className="canvas-area-draft" style={{transform: `translate(${preview.rect.x}px, ${preview.rect.y}px)`, width: Math.max(MIN_AREA, preview.rect.w), height: Math.max(MIN_AREA, preview.rect.h)}}/> : null}
      {board.cards.map(card => {
        const shift = cardShift(card), home = homeOf(card);
        if (!shift && !shownCards.has(card.channelId)) return null;
        return <Card key={card.channelId} card={card} draggable={canEdit} dx={shift?.dx ?? 0} dy={shift?.dy ?? 0}
          dragging={preview?.kind === 'card' && preview.id === card.channelId} measure={measure}
          pulse={card.access === 'open' ? pulses.get(card.channelId) : undefined}
          onNudge={onNudge ? nudge : undefined} onRemove={canEdit ? removeCard : undefined}
          onOpen={onOpenChat ? openCard : undefined} open={card.channelId === openChannelId}
          facesDraggable={Boolean(onRemoveAgent && canManageCard?.(card))}
          draggingFace={preview?.kind === 'face' && preview.id === card.channelId ? preview.agent : null}
          dropping={dropId === card.channelId} selected={card.channelId === selectedChannelId}
          areaTitle={home?.title} areaTint={home?.tint}/>;
      })}
    </div>
    {preview?.kind === 'face' ? <div className={`canvas-face-ghost${preview.away ? ' is-away' : ''}`} aria-hidden="true"
      style={{transform: `translate(${preview.x}px, ${preview.y}px)`}}>
      <AgentAvatar name={preview.agent} size={34}/>
      {preview.away ? <span className="canvas-face-ghost-label">Remove {preview.agent}</span> : null}
    </div> : null}
    <div className="canvas-chrome canvas-tools" role="toolbar" aria-label="Canvas tools">
      <button type="button" className="canvas-tool" aria-pressed={tool === 'area'} disabled={!canEdit}
        title={canEdit ? 'Drag on the canvas to draw an area' : 'You can view this canvas but not change it.'}
        onClick={() => setTool(t => t === 'area' ? 'select' : 'area')}>Area</button>
    </div>
    <div className="canvas-chrome canvas-zoom" role="group" aria-label="Zoom">
      <button type="button" aria-label="Zoom out" onClick={() => zoomBy(1 / ZOOM_STEP)}><span aria-hidden="true">−</span></button>
      {/* Not live: a pinch or wheel zoom would announce every step. */}
      <output aria-label="Zoom level" aria-live="off">{Math.round(view.zoom * 100)}%</output>
      <button type="button" aria-label="Zoom in" onClick={() => zoomBy(ZOOM_STEP)}><span aria-hidden="true">+</span></button>
      <button type="button" className="canvas-fit" onClick={fitAll}>Fit</button>
    </div>
  </div>;
}

/** The dotted line from an area's title bar to the area whose context it uses, bowed so it reads as a link, not an edge. */
function ContextLine({from, to}: {from: Rect; to: Rect}) {
  const a = {x: from.x + Math.min(from.w / 2, 160), y: from.y + 30}, b = {x: to.x + Math.min(to.w / 2, 160), y: to.y + 30};
  const lift = Math.max(60, Math.hypot(b.x - a.x, b.y - a.y) / 4);
  // Side by side: arch over the top. Stacked: bow out to the right.
  const control = Math.abs(b.x - a.x) >= Math.abs(b.y - a.y)
    ? {x: (a.x + b.x) / 2, y: Math.min(a.y, b.y) - lift}
    : {x: Math.max(a.x, b.x) + lift, y: (a.y + b.y) / 2};
  return <svg className="canvas-context-lines" aria-hidden="true" width="1" height="1">
    <path className="canvas-context-line" d={`M ${a.x} ${a.y} Q ${control.x} ${control.y} ${b.x} ${b.y}`}/>
    <circle className="canvas-context-line-end" cx={b.x} cy={b.y} r="5"/>
  </svg>;
}
