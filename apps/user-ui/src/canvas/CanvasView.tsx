// Canvas view: top bar, first-canvas prompt, notices and the board surface.
import {useCallback,useEffect,useLayoutEffect,useMemo,useRef,useState,useSyncExternalStore,type FormEvent,type ReactNode} from 'react';
import {CanvasTint,type BoardCard,type Canvas,type NewArea,type Project} from '@nest/schemas';
import type {Agent,Channel} from '../types';
import {WorkspaceTopbar} from '../components/WorkspaceTopbar';
import {ApiError,apiFetch,apiJson,getApiHeaders} from '../api';
import {addChatMember,removeChatMember} from '../chat-members';
import {StartChat} from '../ProjectStart';
import {boardApi,createCanvas,deleteCanvas,getHidden,isCanvasGone,listCanvases,renameCanvas,setHidden,withFreshVersion} from './api';
import {CanvasSwitcher} from './CanvasSwitcher';
import {ShareDialog} from './ShareDialog';
import {createBoardStore} from './board-store';
import {Surface,type SurfaceControls} from './Surface';
import {nudgeMessage,type CanvasLive} from './live';
import {LoosePile} from './LoosePile';
import {areaAround,gridPlacement,looseChats} from './loose';
import {SPLIT_MAX,SPLIT_MIN,clampSplit,readSplit,splitAt,writeSplit} from './split';
import {cardTitle} from './Card';
import {AgentTray} from './AgentTray';
import {trayAgents} from './tray';
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
  /** The confirmed channel list after an agent is added or removed here (App's setChannels). */
  onChannels(channels: Channel[]): void;
};
/** A short message over the canvas about a membership change, with Undo after a removal. */
type MemberNotice = {id: number; text: string; undo?: () => void};
const MEMBER_NOTICE_MS = 6000;
export const CANT_ADD = "You can't add people to this chat";

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

export function CanvasView({canvasId, humanId, username, humans, channels, projects, agents, onSelectCanvas, onMenu, chat, chatChannelId, chatMode, onOpenChat, onCloseChat, onOpenRegular, live, refreshChannels, onChannels}: CanvasViewProps) {
  const store = useMemo(() => createBoardStore({api: boardApi, now: Date.now, intervalMs: SYNC_INTERVAL_MS}), []);
  const state = useSyncExternalStore(store.subscribe, store.snapshot);
  // The list is stamped with the view it was read for: a list read before the URL lost its canvas never drives the redirect.
  const [fetched, setFetched] = useState<{key: string; list: Canvas[]} | null>(null);
  const [listFailed, setListFailed] = useState(false);
  const [listAttempt, setListAttempt] = useState(0);
  const listKey = `${canvasId ?? ''}:${listAttempt}`;
  const canvases = fetched?.list ?? null;
  const freshList = fetched?.key === listKey ? fetched.list : null;
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [sharing, setSharing] = useState(false);
  const selectRef = useRef(onSelectCanvas); selectRef.current = onSelectCanvas;
  /** Re-reads the person's canvases (after create, rename, delete, sharing or access loss). */
  const reloadList = useCallback(async () => {
    const list = await listCanvases();
    setFetched(current => ({key: current?.key ?? '', list}));
    return list;
  }, []);

  useEffect(() => {
    let current = true;
    setListFailed(false);
    listCanvases().then(list => {
      if (!current) return;
      setFetched({key: listKey, list});
      // Without a canvas in the URL, open the most recently updated one in place of this entry.
      if (!canvasId) { const recent = mostRecent(list); if (recent) selectRef.current(recent.id, {replace: true}); }
    }).catch(() => { if (current) setListFailed(true); });
    return () => { current = false; };
  }, [canvasId, listAttempt]);

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
  // Split screen folds the pile so the canvas keeps its room; opening it there lasts until split screen ends.
  const [splitPile, setSplitPile] = useState(false);
  useEffect(() => { if (chatMode !== 'split') setSplitPile(false); }, [chatMode]);

  // One chat at a time, and only one this person can read: never a locked or unavailable card's.
  const chatShown = Boolean(chat && chatChannelId && chatMode && channels.some(channel => channel.id === chatChannelId));
  const openCard = cards?.find(card => card.channelId === chatChannelId);
  const chatTitle = (openCard?.access === 'open' ? cardTitle(openCard) : null) ?? candidates.find(c => c.channelId === chatChannelId)?.title ?? 'Chat';
  const modeRef = useRef(chatMode); modeRef.current = chatShown ? chatMode : null;
  const openRef = useRef(onOpenChat); openRef.current = onOpenChat;
  // A card opens in focus, or replaces the split-screen chat beside the canvas.
  const openFromCard = useCallback((channelId: string) => { setSelectedId(channelId); openRef.current(channelId, modeRef.current ?? 'focus'); }, []);
  // A sent bottom-box chat lands in the pile only: the box starts over and the canvas stays put.
  const [dockKey, setDockKey] = useState(0);
  const refreshRef = useRef(refreshChannels); refreshRef.current = refreshChannels;
  const created = useCallback(() => {
    setDockKey(n => n + 1);
    void refreshRef.current().catch(() => {});
  }, []);
  // Agents on cards: the selected card leads the tray's suggestions; membership goes through the engine.
  const [selectedId, setSelectedId] = useState<string | null>(null);
  useEffect(() => { setSelectedId(null); }, [canvasId]);
  const selected = cards?.find(card => card.channelId === selectedId && card.access === 'open');
  const tray = useMemo(() => board ? trayAgents({agents, humanId, cards: board.cards, areas: board.areas, selectedId: selected?.channelId ?? null}) : [],
    [board, agents, humanId, selected]);
  // As in the regular chat: the engine's canManage, not archived, and a project chat only for the project's owner.
  const manageable = useCallback((card: BoardCard) => card.access === 'open' && card.canManage && !card.archived
    && (!card.projectId || projects.some(project => project.id === card.projectId && project.ownerId === humanId)), [projects, humanId]);
  const [memberNotice, setMemberNotice] = useState<MemberNotice | null>(null);
  const noticeId = useRef(0);
  const say = useCallback((text: string, undo?: () => void) => setMemberNotice({id: ++noticeId.current, text, undo}), []);
  useEffect(() => {
    if (!memberNotice) return;
    const timer = setTimeout(() => setMemberNotice(current => current?.id === memberNotice.id ? null : current), MEMBER_NOTICE_MS);
    return () => clearTimeout(timer);
  }, [memberNotice]);
  const humanRef = useRef(humanId); humanRef.current = humanId;
  const channelsRef = useRef(onChannels); channelsRef.current = onChannels;
  /** Hands the confirmed list to App and re-reads the board, whose participants come from the server. */
  const settle = useCallback((fresh: Channel[], by: string) => {
    if (humanRef.current !== by) return false;
    channelsRef.current(fresh);
    void store.refresh({force: true});
    return true;
  }, [store]);
  const cardFor = (channelId: string) => store.snapshot().board?.cards.find(card => card.channelId === channelId);
  const add = useCallback(async (channelId: string, agent: string) => {
    const card = cardFor(channelId), by = humanRef.current;
    if (!card || card.access !== 'open') return;
    try {
      const fresh = await addChatMember({channelId, projectId: card.projectId, member: {subscriberType: 'AGENT', subscriberId: agent}, fetch: apiFetch, fetchJson: apiJson});
      if (settle(fresh, by)) say(`Added ${agent}`);
    } catch { if (humanRef.current === by) say(`Could not add ${agent}. Try again.`); }
  }, [store, settle, say]);
  const dropAgent = useCallback((channelId: string, agent: string) => {
    const card = cardFor(channelId);
    if (!card || card.access !== 'open') return;
    if (!manageable(card)) { say(CANT_ADD); return; }
    if (card.participants.some(p => p.subscriberType === 'AGENT' && p.subscriberId === agent)) { say(`${agent} is already in this chat`); return; }
    void add(channelId, agent);
  }, [store, manageable, add, say]);
  const removeAgent = useCallback(async (channelId: string, agent: string) => {
    const card = cardFor(channelId), by = humanRef.current;
    if (!card || !manageable(card)) return;
    try {
      const fresh = await removeChatMember({channelId, member: {subscriberType: 'AGENT', subscriberId: agent}, fetch: apiFetch, fetchJson: apiJson});
      if (settle(fresh, by)) say(`Removed ${agent}`, () => { setMemberNotice(null); void add(channelId, agent); });
    } catch { if (humanRef.current === by) say(`Could not remove ${agent}. Try again.`); }
  }, [store, manageable, settle, say, add]);
  // Access lost: say so, open the menu on what is left, and stay put (no redirect, so no loop).
  const gone = state.status === 'gone' && state.canvasId === canvasId;
  useEffect(() => {
    if (!gone) return;
    setSwitcherOpen(true);
    void reloadList().catch(() => {});
  }, [gone, reloadList]);
  useEffect(() => { if (switcherOpen) void reloadList().catch(() => {}); }, [switcherOpen, reloadList]);
  useEffect(() => { setSharing(false); }, [canvasId]);

  const canvasVersion = () => store.snapshot().board?.canvas.version ?? 0;
  const freshVersion = async () => (await reloadList()).find(c => c.id === canvasId)?.version ?? null;
  const createNew = async (newName: string) => { const created = await createCanvas(newName); await reloadList().catch(() => {}); onSelectCanvas(created.id); };
  const rename = async (newName: string) => {
    if (!canvasId) return;
    await withFreshVersion(canvasVersion(), freshVersion, version => renameCanvas(canvasId, newName, version));
    void store.refresh({force: true});
    void reloadList().catch(() => {});
  };
  const remove = async () => {
    if (!canvasId) return;
    try { await withFreshVersion(canvasVersion(), freshVersion, version => deleteCanvas(canvasId, version)); } catch (error) { if (!isCanvasGone(error)) throw error; }
    // The next most recent canvas, or the first-canvas prompt when none is left.
    const rest = (await listCanvases().catch(() => [] as Canvas[])).filter(c => c.id !== canvasId);
    const next = mostRecent(rest);
    onSelectCanvas(next ? next.id : null, {replace: true});
  };
  const current = board?.canvas ?? canvases?.find(c => c.id === canvasId) ?? null;
  const ownerName = current && current.role !== 'owner' ? humans.find(h => h.id === current.ownerId)?.username ?? 'the owner' : null;
  const name = board?.canvas.name ?? canvases?.find(c => c.id === canvasId)?.name ?? '';
  let body: ReactNode;
  if (!canvasId) {
    body = listFailed ? <CanvasMessage text="Could not load your canvases." action="Try again" onAction={() => setListAttempt(n => n + 1)}/>
      : freshList && !freshList.length ? <FirstCanvas onCreated={id => onSelectCanvas(id, {replace: true})}/>
      : <CanvasMessage text="Loading canvases…"/>;
  } else if (state.status === 'gone' && state.canvasId === canvasId) {
    body = <CanvasMessage text="This canvas is no longer shared with you"/>;
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
          onDropChat={canPlace ? dropChat : undefined} controls={controls} onOpenChat={openFromCard} openChannelId={chatShown ? chatChannelId : null}
          onDropAgent={dropAgent} onRemoveAgent={removeAgent} canManageCard={manageable} onSelectCard={setSelectedId} selectedChannelId={selected?.channelId ?? null}/>
        <AgentTray tray={tray} suggestedFor={selected ? cardTitle(selected) : null} agents={agents} humanId={humanId} cards={board.cards} areas={board.areas}/>
        {/* While a chat is open, dropped files go to that chat only. */}
        {humanId ? <div className="canvas-dock"><StartChat key={dockKey} ownerId={humanId} variant="dock" onCreated={created} fileDrop={!chatShown}/></div> : null}
      </div>
      <LoosePile chats={loose} count={looseCount} hidden={hidden} showHidden={showHidden} onShowHidden={setShowHidden}
        canPlace={canPlace} onPlace={place} onHide={hide} open={chatShown && chatMode === 'split' ? splitPile : pileOpen}
        onOpen={chatShown && chatMode === 'split' ? setSplitPile : openPile} now={Date.now}/>
    </>;
  }

  return <section className="canvas-view" aria-label="Canvas">
    <WorkspaceTopbar onMenu={onMenu} leading={canvasId ? <div className="canvas-heading">
      <h1 className="canvas-name">{name}</h1>
      <CanvasSwitcher canvases={canvases ?? []} current={current} open={switcherOpen} onOpenChange={setSwitcherOpen}
        onSelect={id => onSelectCanvas(id)} onCreate={createNew} onRename={rename} onDelete={remove}/>
      {board && board.canvas.role === 'owner' ? <button type="button" className="canvas-share-button" onClick={() => setSharing(true)}>Share</button> : null}
      {ownerName ? <span className="canvas-shared-by">Shared by {ownerName}</span> : null}
    </div> : undefined}/>
    <div className={`canvas-body${chatShown ? ` has-chat is-${chatMode}` : ''}`}>
      {sharing && board && board.canvas.role === 'owner' ? <ShareDialog canvasId={board.canvas.id} ownerId={board.canvas.ownerId} humans={humans}
        version={canvasVersion} freshVersion={freshVersion} onSaved={() => { void store.refresh({force: true}); void reloadList().catch(() => {}); }} onClose={() => setSharing(false)}/> : null}
      <CanvasMain inert={chatShown && chatMode === 'focus'}>
        <div className="canvas-notices">
          {state.notice && state.canvasId === canvasId ? <div className="canvas-notice" role="status">
            <span>{state.notice}</span>
            <button type="button" onClick={store.clearNotice}>Dismiss</button>
          </div> : null}
          {memberNotice && board ? <div key={memberNotice.id} className="canvas-notice" role="status">
            <span>{memberNotice.text}</span>
            {memberNotice.undo ? <button type="button" onClick={memberNotice.undo}>Undo</button> : null}
            <button type="button" onClick={() => setMemberNotice(null)}>Dismiss</button>
          </div> : null}
        </div>
        {body}
      </CanvasMain>
      {chatShown ? <CanvasChat key={chatChannelId} channelId={chatChannelId!} mode={chatMode!} title={chatTitle}
        onMode={mode => onOpenChat(chatChannelId!, mode)} onClose={onCloseChat} onOpenRegular={() => onOpenRegular(chatChannelId!)}>
        {chat}
      </CanvasChat> : null}
    </div>
  </section>;
}

/**
 * The canvas side of the body. Behind a focus chat it is inert: no pointer, Tab or screen reader reaches it.
 * A layout effect, so inert is gone before the closing chat's passive cleanup moves focus back here.
 */
function CanvasMain({inert, children}: {inert: boolean; children: ReactNode}) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    if (inert) element.setAttribute('inert', ''); else element.removeAttribute('inert');
  }, [inert]);
  return <div ref={ref} className="canvas-main">{children}</div>;
}

const SPLIT_STEP = 2;
/** Another dialog above the chat (manage channel, the tour) takes Escape for itself. */
const OTHER_DIALOG = '[aria-modal="true"]:not(.canvas-chat), .dialog-backdrop';

/**
 * The open chat: enlarged over a dimmed canvas (focus), or on the right with a draggable divider (split).
 * The header holds Split screen, Open in the regular chat view and Close; the chat itself is App's chat workspace.
 */
function CanvasChat({channelId, mode, title, onMode, onClose, onOpenRegular, children}: {
  channelId: string; mode: CanvasChatMode; title: string; onMode(mode: CanvasChatMode): void; onClose(): void; onOpenRegular(): void; children: ReactNode;
}) {
  const panel = useRef<HTMLElement>(null);
  const [split, setSplit] = useState(readSplit);
  const splitRef = useRef(split); splitRef.current = split;
  const resizing = useRef<number | null>(null);
  const closeRef = useRef(onClose); closeRef.current = onClose;

  // Focus moves into the chat when it opens. On close it returns to the opened card's Open button when that card
  // is mounted (after a mouse open too), else to what was focused before, else the canvas.
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const body = panel.current?.closest<HTMLElement>('.canvas-body') ?? null;
    panel.current?.focus({preventScroll: true});
    return () => {
      if (!body?.isConnected) return;
      const card = body.querySelector<HTMLElement>(`.canvas-card[data-channel-id="${CSS.escape(channelId)}"] .canvas-card-open`);
      const surface = body.querySelector<HTMLElement>('.canvas-surface');
      const target = [card, previous, surface].find(element => element?.isConnected && body.contains(element));
      target?.focus({preventScroll: true});
    };
  }, []);

  // Escape closes a focus chat, after any inner popup (the mention picker) has had it.
  useEffect(() => {
    if (mode !== 'focus') return;
    const key = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || document.querySelector(OTHER_DIALOG)) return;
      event.preventDefault();
      closeRef.current();
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [mode]);

  const resizeTo = (clientX: number) => {
    const body = panel.current?.parentElement?.getBoundingClientRect();
    if (body) setSplit(splitAt(clientX, {left: body.left, width: body.width}));
  };
  const finish = () => { if (resizing.current === null) return; resizing.current = null; writeSplit(splitRef.current); };
  const nudge = (delta: number) => { const next = clampSplit(splitRef.current + delta); setSplit(next); writeSplit(next); };

  const focus = mode === 'focus';
  return <>
    {focus ? <div className="canvas-chat-backdrop" aria-hidden="true" onClick={onClose}/> : null}
    <section ref={panel} className="canvas-chat" data-mode={mode} tabIndex={-1}
      role={focus ? 'dialog' : 'region'} aria-label={`Open chat ${title}`}
      style={focus ? undefined : {width: `${split}%`}}>
      {focus ? null : <div className="canvas-chat-divider" role="separator" aria-label="Resize chat" aria-orientation="vertical"
        aria-valuenow={split} aria-valuemin={SPLIT_MIN} aria-valuemax={SPLIT_MAX} aria-valuetext={`Chat ${Math.round(split)}% wide`} tabIndex={0}
        onPointerDown={event => {
          if (event.button !== 0) return;
          event.preventDefault();
          resizing.current = event.pointerId;
          try { event.currentTarget.setPointerCapture(event.pointerId); } catch {}
        }}
        onPointerMove={event => { if (resizing.current === event.pointerId) resizeTo(event.clientX); }}
        onPointerUp={finish} onPointerCancel={finish} onLostPointerCapture={finish}
        onKeyDown={event => {
          if (event.key === 'ArrowLeft') { event.preventDefault(); nudge(SPLIT_STEP); }
          else if (event.key === 'ArrowRight') { event.preventDefault(); nudge(-SPLIT_STEP); }
        }}/>}
      <header className="canvas-chat-bar">
        <h2 className="canvas-chat-title">{title}</h2>
        <div className="canvas-chat-actions">
          <button type="button" className="canvas-chat-action" aria-pressed={!focus} onClick={() => onMode(focus ? 'split' : 'focus')}>Split screen</button>
          <button type="button" className="canvas-chat-action" onClick={onOpenRegular}>Open in the regular chat view</button>
          <button type="button" className="canvas-chat-action" onClick={onClose}>Close</button>
        </div>
      </header>
      <div className="canvas-chat-body">{children}</div>
    </section>
  </>;
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
