// Canvas view: top bar, first-canvas prompt, notices and the board surface.
import {useCallback,useEffect,useMemo,useRef,useState,useSyncExternalStore,type FormEvent,type ReactNode} from 'react';
import {CanvasTint,type Canvas,type NewArea,type Project} from '@nest/schemas';
import type {Agent,Channel} from '../types';
import {WorkspaceTopbar} from '../components/WorkspaceTopbar';
import {ApiError,apiJson,getApiHeaders} from '../api';
import {StartChat} from '../ProjectStart';
import {boardApi,createCanvas,getHidden,listCanvases,setHidden} from './api';
import {createBoardStore} from './board-store';
import {Surface,type SurfaceControls} from './Surface';
import {nudgeMessage,type CanvasLive} from './live';
import {LoosePile} from './LoosePile';
import {areaAround,gridPlacement,looseChats} from './loose';
import type {CardPulse} from './pulse';
import type {Point} from './geometry';
import './canvas.css';

export type CanvasHuman = {id?: string; username: string};
export type CanvasChatMode = 'focus' | 'split';
export type CanvasViewProps = {
  canvasId: string | null;
  humanId: string;
  username: string;
  channels: Channel[];
  projects: Project[];
  agents: Agent[];
  humans: CanvasHuman[];
  /** `replace` swaps the history entry, for redirects that Back should skip. */
  onSelectCanvas(id: string | null, options?: {replace?: boolean}): void;
  onMenu(): void;
  chat: ReactNode;
  chatChannelId: string | null;
  chatMode: CanvasChatMode | null;
  onOpenChat(channelId: string, mode: CanvasChatMode): void;
  onCloseChat(): void;
  onOpenRegular(channelId: string): void;
  live: CanvasLive;
  /** Re-reads App's channel and project lists without navigating, so a chat started here shows in the pile. */
  refreshChannels(): Promise<void>;
};

const SYNC_INTERVAL_MS = 5000;
const NO_PULSES: ReadonlyMap<string, CardPulse> = new Map();
const NOTHING: ReadonlySet<string> = new Set();
const TINTS = CanvasTint.options;
/** Keeps a placed grid (or area) well inside the ±1,000,000 coordinate limit. */
const PLACE_LIMIT = 900_000;
const clampPoint = (p: Point): Point => ({x: Math.round(Math.min(PLACE_LIMIT, Math.max(-PLACE_LIMIT, p.x))), y: Math.round(Math.min(PLACE_LIMIT, Math.max(-PLACE_LIMIT, p.y)))});
const pileKey = (humanId: string) => `nest-canvas-pile-open:${humanId}`;
function readPileOpen(humanId: string) {
  try { const saved = localStorage.getItem(pileKey(humanId)); if (saved === '1' || saved === '0') return saved === '1'; } catch {}
  // Phones (the 760 px breakpoint) start with the pile folded away.
  return !(typeof matchMedia === 'function' && matchMedia('(max-width: 760px)').matches);
}
const mostRecent = (canvases: Canvas[]) => canvases.reduce<Canvas | null>((best, c) => !best || c.updatedAt > best.updatedAt ? c : best, null);

/** Nudge goes through the normal send path as the signed-in human. */
async function sendNudge(channelId: string, agent: string) {
  await apiJson('/api/messages', {method: 'POST', headers: getApiHeaders(), body: JSON.stringify(nudgeMessage(channelId, agent))});
}

export function CanvasView({canvasId, humanId, username, channels, projects, onSelectCanvas, onMenu, live, refreshChannels}: CanvasViewProps) {
  const store = useMemo(() => createBoardStore({api: boardApi, now: Date.now, intervalMs: SYNC_INTERVAL_MS}), []);
  const state = useSyncExternalStore(store.subscribe, store.snapshot);
  const [canvases, setCanvases] = useState<Canvas[] | null>(null);
  const [listFailed, setListFailed] = useState(false);
  const [listAttempt, setListAttempt] = useState(0);

  useEffect(() => {
    let current = true;
    setListFailed(false);
    listCanvases().then(list => { if (current) setCanvases(list); }).catch(() => { if (current) setListFailed(true); });
    return () => { current = false; };
  }, [canvasId, listAttempt]);

  // Without a canvas in the URL, open the most recently updated one in place of this entry.
  useEffect(() => {
    if (canvasId || !canvases) return;
    const recent = mostRecent(canvases);
    if (recent) onSelectCanvas(recent.id, {replace: true});
  }, [canvasId, canvases]);

  useEffect(() => {
    if (!canvasId) return;
    void store.open(canvasId);
    store.start();
    return () => store.stop();
  }, [canvasId, store]);

  const board = state.canvasId === canvasId ? state.board : null;
  const pulses = useSyncExternalStore(live.subscribe, live.snapshot);
  // Live state refreshes only while the canvas view is mounted.
  useEffect(() => { live.start(); return () => live.stop(); }, [live]);
  const cards = board?.cards;

  // Loose chats: the person's chats not on this canvas. The hidden list is personal, across canvases.
  const [hidden, setHiddenIds] = useState<ReadonlySet<string>>(NOTHING);
  const [showHidden, setShowHidden] = useState(false);
  useEffect(() => {
    let current = true;
    getHidden().then(result => { if (current) setHiddenIds(new Set(result.channelIds)); }).catch(() => {});
    return () => { current = false; };
  }, [humanId]);
  const boardIds = useMemo(() => new Set((cards ?? []).map(card => card.channelId)), [cards]);
  // Every loose chat, hidden or not and before live state: what the live store covers besides the cards.
  const candidates = useMemo(() => cards ? looseChats({channels, projects, boardChannelIds: boardIds, hidden: NOTHING, username, userId: humanId, pulses: NO_PULSES, showHidden: true}) : [],
    [cards, channels, projects, boardIds, username, humanId]);
  const loose = useMemo(() => cards ? looseChats({channels, projects, boardChannelIds: boardIds, hidden, username, userId: humanId, pulses, showHidden}) : [],
    [cards, channels, projects, boardIds, hidden, username, humanId, pulses, showHidden]);
  const looseCount = useMemo(() => showHidden ? loose.filter(chat => !hidden.has(chat.channelId)).length : loose.length, [loose, hidden, showHidden]);
  const candidatesRef = useRef(candidates); candidatesRef.current = candidates;

  useEffect(() => {
    live.setCards([
      ...(cards ?? []).flatMap(card => card.access === 'open'
        ? [{channelId: card.channelId, agentNames: card.participants.filter(p => p.subscriberType === 'AGENT').map(p => p.subscriberId)}] : []),
      ...candidates.map(chat => ({channelId: chat.channelId, agentNames: chat.agents})),
    ]);
  }, [cards, candidates, live]);

  const controls = useRef<SurfaceControls | null>(null);
  /** Places the chats in a 3-wide grid at the viewport centre, optionally inside a new area, in one call. */
  const place = useCallback((channelIds: string[], withArea: boolean) => {
    const current = store.snapshot().board;
    if (!current || !channelIds.length) return Promise.resolve(false);
    const {cards: placed, bounds} = gridPlacement(channelIds, clampPoint(controls.current?.centre() ?? {x: 0, y: 0}));
    const area: NewArea | undefined = withArea ? {id: crypto.randomUUID(), title: 'New area', ...areaAround(bounds), tint: TINTS[current.areas.length % TINTS.length]} : undefined;
    return store.apply({kind: 'placeCards', cards: placed, ...(area ? {area} : {})});
  }, [store]);
  const dropChat = useCallback((channelId: string, at: Point) => {
    const current = store.snapshot().board;
    if (!current || current.cards.some(card => card.channelId === channelId) || !candidatesRef.current.some(chat => chat.channelId === channelId)) return;
    void store.apply({kind: 'placeCards', cards: [{channelId, ...clampPoint(at)}]});
  }, [store]);
  const hide = useCallback(async (channelIds: string[], value: boolean) => {
    const result = await setHidden(channelIds, value);
    setHiddenIds(new Set(result.channelIds));
    return true;
  }, []);
  const [pileOpen, setPileOpen] = useState(() => readPileOpen(humanId));
  const openPile = useCallback((open: boolean) => {
    setPileOpen(open);
    try { localStorage.setItem(pileKey(humanId), open ? '1' : '0'); } catch {}
  }, [humanId]);
  // A sent bottom-box chat lands in the pile only: the box starts over and the canvas stays put.
  const [dockKey, setDockKey] = useState(0);
  const refreshRef = useRef(refreshChannels); refreshRef.current = refreshChannels;
  const created = useCallback(() => {
    setDockKey(n => n + 1);
    void refreshRef.current().catch(() => {});
  }, []);
  const name = board?.canvas.name ?? canvases?.find(c => c.id === canvasId)?.name ?? '';
  let body: ReactNode;
  if (!canvasId) {
    body = listFailed ? <CanvasMessage text="Could not load your canvases." action="Try again" onAction={() => setListAttempt(n => n + 1)}/>
      : canvases && !canvases.length ? <FirstCanvas onCreated={id => onSelectCanvas(id, {replace: true})}/>
      : <CanvasMessage text="Loading canvases…"/>;
  } else if (state.status === 'gone' && state.canvasId === canvasId) {
    body = <CanvasMessage text="This canvas is not available. It may have been deleted, or it is no longer shared with you." action="Open another canvas" onAction={() => onSelectCanvas(null)}/>;
  } else if (state.status === 'error' && state.canvasId === canvasId) {
    body = <CanvasMessage text="Could not load this canvas." action="Try again" onAction={() => void store.open(canvasId)}/>;
  } else if (!board) {
    body = <CanvasMessage text="Loading canvas…"/>;
  } else {
    // Keyed by canvas so the saved view, gestures and measured card heights start fresh per canvas.
    const canPlace = board.canvas.role !== 'view';
    body = <>
      <div className="canvas-stage">
        <Surface key={board.canvas.id} board={board} humanId={humanId} onApply={store.apply} pulses={pulses} onNudge={sendNudge}
          onDropChat={canPlace ? dropChat : undefined} controls={controls}/>
        {humanId ? <div className="canvas-dock"><StartChat key={dockKey} ownerId={humanId} variant="dock" onCreated={created}/></div> : null}
      </div>
      <LoosePile chats={loose} count={looseCount} hidden={hidden} showHidden={showHidden} onShowHidden={setShowHidden}
        canPlace={canPlace} onPlace={place} onHide={hide} open={pileOpen} onOpen={openPile} now={Date.now}/>
    </>;
  }

  return <section className="canvas-view" aria-label="Canvas">
    <WorkspaceTopbar onMenu={onMenu} leading={canvasId ? <div className="canvas-heading">
      <h1 className="canvas-name">{name}</h1>
      <CanvasSwitcher canvases={canvases ?? []} currentId={canvasId} onSelect={id => onSelectCanvas(id)}/>
    </div> : undefined}/>
    <div className="canvas-body">
      {state.notice && state.canvasId === canvasId ? <div className="canvas-notice" role="status">
        <span>{state.notice}</span>
        <button type="button" onClick={store.clearNotice}>Dismiss</button>
      </div> : null}
      {body}
    </div>
  </section>;
}

/** Placeholder switcher: lists the person's other canvases. A later task replaces it with the full menu. */
function CanvasSwitcher({canvases, currentId, onSelect}: {canvases: Canvas[]; currentId: string; onSelect(id: string): void}) {
  if (canvases.length < 2) return null;
  return <select className="canvas-switcher" aria-label="Switch canvas" value={currentId} onChange={event => onSelect(event.target.value)}>
    {canvases.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
  </select>;
}

function CanvasMessage({text, action, onAction}: {text: string; action?: string; onAction?: () => void}) {
  return <div className="canvas-message">
    <p>{text}</p>
    {action && onAction ? <button type="button" className="canvas-button" onClick={onAction}>{action}</button> : null}
  </div>;
}

function FirstCanvas({onCreated}: {onCreated(id: string): void}) {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  // The id survives a failed submit, so a retry after a lost response cannot create a second canvas.
  const [id, setId] = useState(() => crypto.randomUUID());
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!name.trim() || busy) return;
    setBusy(true); setError('');
    try {
      const canvas = await createCanvas(name.trim(), id);
      onCreated(canvas.id);
    } catch (failure) {
      setError('Could not create the canvas. Try again.');
      // 409: that id already holds a canvas with another name; the next attempt needs a new one.
      if (failure instanceof ApiError && failure.status === 409) setId(crypto.randomUUID());
      setBusy(false);
    }
  }
  return <div className="canvas-first">
    <img className="canvas-first-character" src={`${import.meta.env.BASE_URL}design/avatars/moss.png`} alt="" aria-hidden="true"/>
    <h2>Create your first canvas</h2>
    <p>Lay out your chats on one board and see where each one stands.</p>
    <form onSubmit={submit}>
      <label>Canvas name<input value={name} maxLength={120} placeholder="Launch" onChange={event => setName(event.target.value)} autoFocus/></label>
      <button type="submit" className="canvas-button" disabled={!name.trim() || busy}>{busy ? 'Creating…' : 'Create canvas'}</button>
    </form>
    {error ? <p className="canvas-error" role="alert">{error}</p> : null}
  </div>;
}
