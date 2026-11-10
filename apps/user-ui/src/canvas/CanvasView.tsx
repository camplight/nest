// Canvas view: top bar, first-canvas prompt, notices and the board surface.
import {useCallback,useEffect,useLayoutEffect,useMemo,useRef,useState,useSyncExternalStore,type FormEvent,type ReactNode} from 'react';
import {CARD_HEIGHT,CanvasTint,DEFAULT_CARD_WIDTH,areaFor,type BoardCard,type Canvas,type ContextSummary,type NewArea,type Project} from '@nest/schemas';
import type {Agent,Channel} from '../types';
import {WorkspaceTopbar} from '../components/WorkspaceTopbar';
import {ApiError,apiFetch,apiJson,getApiHeaders} from '../api';
import {addChatMember,removeChatMember} from '../chat-members';
import {StartChat} from '../ProjectStart';
import {boardApi,createCanvas,setCardHome,deleteCanvas,getHidden,isCanvasGone,listCanvases,renameCanvas,setHidden,withFreshVersion} from './api';
import {CanvasSwitcher} from './CanvasSwitcher';
import {ShareDialog} from './ShareDialog';
import {createBoardStore,type BoardOp} from './board-store';
import {Surface,outsideFileDropTargets,type FileDropTarget,type SurfaceControls} from './Surface';
import {nudgeMessage,type CanvasLive} from './live';
import {LoosePile,MAX_BULK} from './LoosePile';
import {areaAround,clearOfCards,dropLayout,gridPlacement,looseChats,slotInArea,slotOutsideAreas} from './loose';
import {SPLIT_MAX,SPLIT_MIN,clampSplit,readSplit,splitAt,writeSplit} from './split';
import {cardTitle} from './Card';
import {AgentTray} from './AgentTray';
import {trayAgents} from './tray';
import {NeedsYou} from './NeedsYou';
import {CanvasSearch} from './CanvasSearch';
import {PHONE_QUERY,PhoneList,usePhoneLayout} from './PhoneList';
import {searchIndex,type SearchItem} from './search';
import type {CardPulse} from './pulse';
import {cardCentre,growToFit,type Point} from './geometry';
import type {AreaContext} from './Area';
import {CONTEXT_WARNING,ContextPanel} from './ContextPanel';
import {getContextSummary,type PanelScope} from './context-api';
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
  /** `replace` closes without a new history entry, as when the open chat leaves the visible list. */
  onCloseChat(options?: {replace?: boolean}): void;
  onOpenRegular(channelId: string): void;
  /** Files dropped on a card: App queues them in that chat's reply box and sends them once uploaded. The chat is already open. */
  onChatFiles(channelId: string, files: File[]): void;
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
  return !(typeof matchMedia === 'function' && matchMedia(PHONE_QUERY).matches);
}
const mostRecent = (canvases: Canvas[]) => canvases.reduce<Canvas | null>((best, c) => !best || c.updatedAt > best.updatedAt ? c : best, null);

/** Nudge goes through the normal send path as the signed-in human. */
async function sendNudge(channelId: string, agent: string) {
  await apiJson('/api/messages', {method: 'POST', headers: getApiHeaders(), body: JSON.stringify(nudgeMessage(channelId, agent))});
}

export function CanvasView({canvasId, humanId, username, humans, channels, projects, agents, onSelectCanvas, onMenu, chat, chatChannelId, chatMode, onOpenChat, onCloseChat, onOpenRegular, onChatFiles, live, refreshChannels, onChannels}: CanvasViewProps) {
  const store = useMemo(() => createBoardStore({api: boardApi, now: Date.now, intervalMs: SYNC_INTERVAL_MS}), []);
  // Phones get a list in place of the free canvas.
  const phone = usePhoneLayout();
  const phoneRef = useRef(phone); phoneRef.current = phone;
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

  // Context: one summary per board load feeds every area's dot and `↳` chips; the panel re-reads it after an edit.
  const [summary, setSummary] = useState<{canvasId: string; summary: ContextSummary} | null>(null);
  const summaryCanvas = useRef(canvasId); summaryCanvas.current = canvasId;
  const summaryRef = useRef<ContextSummary | null>(null);
  // A board load joins a read already under way for the same canvas (StrictMode runs effects twice); an edit always re-reads.
  const summaryRead = useRef<{id: string} | null>(null);
  const loadSummary = useCallback((id: string, joinRunning = false) => {
    if (joinRunning && summaryRead.current?.id === id) return;
    const read = {id};
    summaryRead.current = read;
    getContextSummary(id)
      .then(next => { if (summaryCanvas.current === id && summaryRead.current === read) setSummary({canvasId: id, summary: next}); })
      .catch(() => {})
      .finally(() => { if (summaryRead.current === read) summaryRead.current = null; });
  }, []);
  useEffect(() => { if (canvasId) loadSummary(canvasId, true); }, [canvasId, loadSummary]);
  const contextSummary = summary?.canvasId === canvasId ? summary.summary : null;
  summaryRef.current = contextSummary;
  const areaContext = useMemo(() => new Map<string, AreaContext>((contextSummary?.areas ?? []).map(({areaId, ...rest}) => [areaId, rest])), [contextSummary]);
  const [panel, setPanel] = useState<PanelScope | null>(null);
  useEffect(() => { setPanel(null); }, [canvasId]);
  const areaGone = Boolean(panel?.kind === 'area' && board && !board.areas.some(a => a.id === panel.areaId));
  useEffect(() => { if (areaGone) setPanel(null); }, [areaGone]);
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
  const phoneLoose = useMemo(() => showHidden ? loose.filter(chat => !hidden.has(chat.channelId)) : loose, [loose, hidden, showHidden]);
  const candidatesRef = useRef(candidates); candidatesRef.current = candidates;

  useEffect(() => {
    live.setCards([
      ...(cards ?? []).flatMap(card => card.access === 'open'
        ? [{channelId: card.channelId, agentNames: card.participants.filter(p => p.subscriberType === 'AGENT').map(p => p.subscriberId)}] : []),
      ...candidates.map(chat => ({channelId: chat.channelId, agentNames: chat.agents})),
    ]);
  }, [cards, candidates, live]);

  const [memberNotice, setMemberNotice] = useState<MemberNotice | null>(null);
  useEffect(() => { setMemberNotice(null); }, [canvasId]);
  const noticeId = useRef(0);
  const say = useCallback((text: string, undo?: () => void) => setMemberNotice({id: ++noticeId.current, text, undo}), []);
  /**
   * Board writes, plus the drop warning: a move or placement that puts a chat into an area with context AND
   * changes the chat's home says who can see it, with an Undo. The home comes from the server's answer, so
   * it is compared before and after rather than guessed. Undo moves a moved card back, or takes a placed card off
   * (which clears the home again).
   */
  const applyTracked = useCallback(async (op: BoardOp) => {
    if (op.kind !== 'moveCard' && op.kind !== 'placeCards') return store.apply(op);
    const prior = store.snapshot().board;
    const ids = op.kind === 'moveCard' ? [op.channelId] : op.cards.map(card => card.channelId);
    const ok = await store.apply(op);
    const now = store.snapshot().board;
    if (!ok || !prior || !now || now.canvas.id !== prior.canvas.id) return ok;
    const withContext = (areaId: string | undefined) => {
      const area = summaryRef.current?.areas.find(a => a.areaId === areaId);
      return Boolean(area && (area.hasContext || area.links.some(link => link.available)));
    };
    const changed = ids.flatMap(channelId => {
      const before = prior.cards.find(card => card.channelId === channelId), after = now.cards.find(card => card.channelId === channelId);
      if (!after || after.access !== 'open' || !after.home?.isHere) return [];
      const area = areaFor(cardCentre(after), now.areas)?.id;
      const was = before?.access === 'open' ? before.home : null;
      const sameHome = Boolean(before && was?.isHere && was.label === after.home.label && areaFor(cardCentre(before), prior.areas)?.id === area);
      return !sameHome && withContext(area) ? [{channelId, before, x: after.x, y: after.y}] : [];
    });
    if (!changed.length) return ok;
    const canvasOfDrop = now.canvas.id;
    say(CONTEXT_WARNING, () => {
      setMemberNotice(null);
      // Only on the canvas the drop happened on, and only a card still where the drop left it: a newer move stays.
      const current = store.snapshot().board;
      if (!current || current.canvas.id !== canvasOfDrop) return;
      for (const {channelId, before, x, y} of changed) {
        const card = current.cards.find(c => c.channelId === channelId);
        if (!card || card.x !== x || card.y !== y) continue;
        void store.apply(before ? {kind: 'moveCard', channelId, x: before.x, y: before.y, w: before.w} : {kind: 'removeCard', channelId});
      }
    });
    return ok;
  }, [store, say]);
  const controls = useRef<SurfaceControls | null>(null);
  /**
   * Places the chats in a 3-wide grid at the viewport centre, optionally inside a new area, in one call.
   * A grid (or its area) that would cover existing cards moves down below them.
   */
  const place = useCallback((channelIds: string[], withArea: boolean) => {
    const current = store.snapshot().board;
    if (!current || !channelIds.length) return Promise.resolve(false);
    const centre = clampPoint(controls.current?.centre() ?? {x: 0, y: 0});
    const first = gridPlacement(channelIds, centre);
    const dy = clearOfCards(withArea ? areaAround(first.bounds) : first.bounds, current.cards);
    const {cards: placed, bounds} = dy ? gridPlacement(channelIds, clampPoint({x: centre.x, y: centre.y + dy})) : first;
    const area: NewArea | undefined = withArea ? {id: crypto.randomUUID(), title: 'New area', ...areaAround(bounds), tint: TINTS[current.areas.length % TINTS.length]} : undefined;
    return applyTracked({kind: 'placeCards', cards: placed, ...(area ? {area} : {})});
  }, [store, applyTracked]);
  /** Chats dropped from the pile; dropped into an area, that area grows so they all fit inside it. */
  const dropChat = useCallback((channelIds: string[], at: Point) => {
    const current = store.snapshot().board;
    if (!current) return;
    const ids = [...new Set(channelIds)].filter(id => !current.cards.some(card => card.channelId === id) && candidatesRef.current.some(chat => chat.channelId === id)).slice(0, MAX_BULK);
    if (!ids.length) return;
    const cards = dropLayout(ids, at, current.cards).map(card => ({...card, ...clampPoint(card)}));
    void applyTracked({kind: 'placeCards', cards});
    const target = areaFor(at, current.areas);
    const grown = target ? growToFit(target, cards.map(card => ({...card, w: DEFAULT_CARD_WIDTH, h: CARD_HEIGHT}))) : null;
    if (target && grown) void store.apply({kind: 'patchArea', areaId: target.id, patch: grown});
  }, [store, applyTracked]);
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
  const panelOpen = Boolean(panel && board);
  const besideCanvas = panelOpen || chatMode === 'split';
  useEffect(() => { if (!besideCanvas) setSplitPile(false); }, [besideCanvas]);

  // One chat at a time, and only one this person can read: never a locked or unavailable card's.
  const chatShown = Boolean(chat && chatChannelId && chatMode && channels.some(channel => channel.id === chatChannelId));
  const openCard = cards?.find(card => card.channelId === chatChannelId);
  const chatTitle = (openCard?.access === 'open' ? cardTitle(openCard) : null) ?? candidates.find(c => c.channelId === chatChannelId)?.title ?? 'Chat';
  // The header's Area picker: editors only, on a canvas with areas, for a chat on it or in the pile.
  const chatArea = board && chatShown && board.canvas.role !== 'view' && board.areas.length && (openCard ? openCard.access === 'open' : candidates.some(c => c.channelId === chatChannelId))
    ? {areas: board.areas.map(a => ({id: a.id, title: a.title})), current: openCard ? areaFor(cardCentre(openCard), board.areas)?.id ?? null : null,
      placed: Boolean(openCard), onMove: (areaId: string | null) => void moveToAreaRef.current(chatChannelId!, areaId)}
    : undefined;
  // "Use this area's context": chat members only, for a card on this canvas that is not the chat's home.
  const chatMember = openCard?.access === 'open' && (openCard.participants.some(p => p.subscriberType === 'HUMAN' && p.subscriberId === username)
    || channels.find(channel => channel.id === chatChannelId)?.ownerHumanId === humanId);
  const useHere = board && chatShown && openCard?.access === 'open' && chatMember && !openCard.home?.isHere
    ? async () => {
      const name = areaFor(cardCentre(openCard), board.areas)?.title || board.canvas.name;
      try {
        await setCardHome(board.canvas.id, openCard.channelId);
        await store.refresh({force: true});
        say(`This chat now uses ${name}'s context.`);
      } catch { say('Could not change the context. Try again.'); }
    }
    : undefined;
  const modeRef = useRef(chatMode); modeRef.current = chatShown ? chatMode : null;
  // Only chats in App's visible list open: a UI-hidden chat is never loaded or marked seen behind the canvas.
  const visibleRef = useRef(channels); visibleRef.current = channels;
  const openRef = useRef(onOpenChat);
  openRef.current = (channelId: string, mode: CanvasChatMode) => { if (visibleRef.current.some(channel => channel.id === channelId)) onOpenChat(channelId, mode); };
  // The open chat left the visible list (hidden, or access lost): close it in place of this entry.
  const closeRef = useRef(onCloseChat); closeRef.current = onCloseChat;
  const listed = useRef(false);
  useEffect(() => {
    if (!chatChannelId) { listed.current = false; return; }
    if (channels.some(channel => channel.id === chatChannelId)) { listed.current = true; return; }
    // Before App's first channel read the list is empty; App's own load closes an unreadable chat from the URL.
    if (listed.current || channels.length) { listed.current = false; closeRef.current({replace: true}); }
  }, [chatChannelId, channels]);
  // The context panel and an open chat share the side slot: opening a chat closes the panel.
  useEffect(() => { if (chatChannelId) setPanel(null); }, [chatChannelId]);
  const chatShownRef = useRef(chatShown); chatShownRef.current = chatShown;
  const openPanel = useCallback((scope: PanelScope) => {
    if (chatShownRef.current) closeRef.current();
    setPanel(scope);
  }, []);
  // Files on a card go to that chat, in split screen unless a chat is already open. Files on an area go to its context panel (editors only).
  const [areaFiles, setAreaFiles] = useState<{id: number; areaId: string; files: File[]} | null>(null);
  const roleRef = useRef(board?.canvas.role); roleRef.current = board?.canvas.role;
  const chatFilesRef = useRef(onChatFiles); chatFilesRef.current = onChatFiles;
  const dropFiles = useCallback((target: FileDropTarget, files: File[]) => {
    if (target.kind === 'card') {
      if (!visibleRef.current.some(channel => channel.id === target.channelId)) return;
      setSelectedId(target.channelId);
      openRef.current(target.channelId, modeRef.current ?? 'split');
      chatFilesRef.current(target.channelId, files);
      return;
    }
    if (roleRef.current === 'view') return;
    openPanel({kind: 'area', areaId: target.areaId});
    setAreaFiles(current => ({id: (current?.id ?? 0) + 1, areaId: target.areaId, files}));
  }, [openPanel]);
  // Files wait only for their own panel: once it closes or moves to another area they are gone.
  useEffect(() => { if (areaFiles && !(panel?.kind === 'area' && panel.areaId === areaFiles.areaId)) setAreaFiles(null); }, [panel, areaFiles]);
  const openAreaContext = useCallback((areaId: string) => openPanel({kind: 'area', areaId}), [openPanel]);
  // A card opens in focus, or replaces the split-screen chat beside the canvas.
  const openFromCard = useCallback((channelId: string) => { setSelectedId(channelId); openRef.current(channelId, modeRef.current ?? 'focus'); }, []);
  // Agents on cards: the selected card leads the tray's suggestions; membership goes through the engine.
  const [selectedId, setSelectedId] = useState<string | null>(null);
  useEffect(() => { setSelectedId(null); }, [canvasId]);
  const selected = cards?.find(card => card.channelId === selectedId && card.access === 'open');
  const tray = useMemo(() => board ? trayAgents({agents, humanId, cards: board.cards, areas: board.areas, selectedId: selected?.channelId ?? null}) : [],
    [board, agents, humanId, selected]);
  // Needs you and search. Only chats the person can see are named: open cards and loose chats, never a locked or unavailable card.
  const titles = useMemo(() => {
    const map = new Map<string, string>();
    for (const card of cards ?? []) if (card.access === 'open') map.set(card.channelId, card.title || 'Untitled chat');
    for (const chat of candidates) map.set(chat.channelId, chat.title || 'Untitled chat');
    return map;
  }, [cards, candidates]);
  const [highlight, setHighlight] = useState<{id: string; n: number} | null>(null);
  const highlightCount = useRef(0);
  useEffect(() => { setHighlight(null); }, [canvasId]);
  // The pointer fades once the chat that was opened over the pile is closed.
  useEffect(() => {
    if (!highlight || chatShown) return;
    const timer = setTimeout(() => setHighlight(null), 4000);
    return () => clearTimeout(timer);
  }, [highlight, chatShown]);
  /** A chat on this canvas is centred and opened in focus; any other opens in focus and the pile points at it. */
  const jumpTo = useCallback((channelId: string) => {
    const card = store.snapshot().board?.cards.find(c => c.channelId === channelId);
    if (card?.access === 'open') {
      controls.current?.reveal({channelId});
      setSelectedId(channelId);
    } else {
      setHighlight({id: channelId, n: ++highlightCount.current});
      setPileOpen(true);
    }
    openRef.current(channelId, 'focus');
  }, [store]);
  const openFromPile = useCallback((channelId: string) => openRef.current(channelId, 'focus'), []);
  /**
   * A sent bottom-box chat stays in sight: on a canvas this person can edit it is placed at the
   * centre of the view (clear of other cards) and opens beside the canvas; otherwise it opens in
   * focus and the pile points at it. The box starts over either way.
   */
  const [dockKey, setDockKey] = useState(0);
  const refreshRef = useRef(refreshChannels); refreshRef.current = refreshChannels;
  const created = useCallback(async (project: Project) => {
    setDockKey(n => n + 1);
    const before = store.snapshot().board?.canvas.id;
    await refreshRef.current().catch(() => {});
    const channelId = project.channelId;
    const board = store.snapshot().board;
    if (!channelId || !board || board.canvas.id !== before) return;
    const onBoard = board.cards.some(card => card.channelId === channelId)
      || (!phoneRef.current && board.canvas.role !== 'view' && await place([channelId], false));
    // Let App's refreshed chat list reach the canvas before opening the chat from it.
    await new Promise(resolve => requestAnimationFrame(resolve));
    if (!onBoard) { jumpTo(channelId); return; }
    setSelectedId(channelId);
    openRef.current(channelId, modeRef.current ?? 'split');
    // Centre the card once the chat beside it has taken its room.
    requestAnimationFrame(() => requestAnimationFrame(() => controls.current?.reveal({channelId})));
  }, [store, place, jumpTo]);
  /**
   * The open chat's header moves its card into an area (a free spot under the title bar; the area
   * grows to fit) or, with no area, just outside the one it is in. A loose chat is placed straight
   * into the area. The view follows the card.
   */
  const moveToArea = useCallback(async (channelId: string, areaId: string | null) => {
    const current = store.snapshot().board;
    if (!current || current.canvas.role === 'view') return;
    const card = current.cards.find(c => c.channelId === channelId);
    const others = current.cards.filter(c => c.channelId !== channelId);
    const w = card?.w ?? DEFAULT_CARD_WIDTH;
    const target = areaId ? current.areas.find(a => a.id === areaId) : undefined;
    const home = card ? areaFor(cardCentre(card), current.areas) : undefined;
    if (areaId ? !target || target.id === home?.id : !card || !home) return;
    const spot = clampPoint(target ? slotInArea(target, others, w) : slotOutsideAreas(home!, current.areas, others, w));
    const saved = card ? applyTracked({kind: 'moveCard', channelId, ...spot}) : applyTracked({kind: 'placeCards', cards: [{channelId, ...spot}]});
    const grown = target ? growToFit(target, [{...spot, w, h: CARD_HEIGHT}]) : null;
    if (target && grown) void store.apply({kind: 'patchArea', areaId: target.id, patch: grown});
    if (!await saved) return;
    if (target) setSelectedId(channelId);
    requestAnimationFrame(() => controls.current?.reveal({channelId}));
  }, [store, applyTracked]);
  const moveToAreaRef = useRef(moveToArea); moveToAreaRef.current = moveToArea;
  const [searchOpen, setSearchOpen] = useState(false);
  useEffect(() => { setSearchOpen(false); }, [canvasId]);
  const index = useMemo(() => searchIndex({canvases: canvases ?? [], board, loose}), [canvases, board, loose]);
  const choose = useCallback((item: SearchItem) => {
    setSearchOpen(false);
    if (item.kind === 'area') controls.current?.reveal({areaId: item.id});
    else if (item.kind === 'canvas') { if (item.id !== canvasId) selectRef.current(item.id); }
    else jumpTo(item.id);
  }, [canvasId, jumpTo]);
  // Ctrl/Cmd+K opens the search, except while typing in any other field: a composer may use it.
  useEffect(() => {
    if (!canvasId) return;
    const key = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey || event.key.toLowerCase() !== 'k') return;
      const target = event.target;
      if (target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) && !target.closest('.canvas-search')) return;
      if (document.querySelector('[aria-modal="true"]:not([aria-label="Search the canvas"])')) return;
      event.preventDefault();
      setSearchOpen(true);
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [canvasId]);
  // As in the regular chat: the engine's canManage, not archived, and a project chat only for the project's owner.
  const manageable = useCallback((card: BoardCard) => card.access === 'open' && card.canManage && !card.archived
    && (!card.projectId || projects.some(project => project.id === card.projectId && project.ownerId === humanId)), [projects, humanId]);
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
  } else if (phone) {
    // The bottom box stays on phones, under the list.
    body = <div className="canvas-phone-stage">
      <PhoneList key={board.canvas.id} board={board} pulses={pulses} loose={phoneLoose} titles={titles} projects={projects}
        onOpenChat={openFromPile} openChannelId={chatShown ? chatChannelId : null}/>
      {humanId ? <div className="canvas-dock"><StartChat key={dockKey} ownerId={humanId} variant="dock" onCreated={created} fileDrop={!chatShown && !panelOpen} fileDropAccept={outsideFileDropTargets}/></div> : null}
    </div>;
  } else {
    // Keyed by canvas so the saved view, gestures and measured card heights start fresh per canvas.
    const canPlace = board.canvas.role !== 'view';
    body = <>
      <div className="canvas-stage">
        <Surface key={board.canvas.id} board={board} humanId={humanId} onApply={applyTracked} pulses={pulses} onNudge={sendNudge}
          onDropChat={canPlace ? dropChat : undefined} controls={controls} onOpenChat={openFromCard} openChannelId={chatShown ? chatChannelId : null}
          onDropAgent={dropAgent} onRemoveAgent={removeAgent} canManageCard={manageable} onSelectCard={setSelectedId} selectedChannelId={selected?.channelId ?? null}
          areaContext={areaContext} onAreaContext={openAreaContext} onDropFiles={dropFiles}/>
        <AgentTray tray={tray} suggestedFor={selected ? cardTitle(selected) : null} agents={agents} humanId={humanId} cards={board.cards} areas={board.areas}/>
        {/* While a chat or the context panel is open, dropped files go there only. */}
        {humanId ? <div className="canvas-dock"><StartChat key={dockKey} ownerId={humanId} variant="dock" onCreated={created} fileDrop={!chatShown && !panelOpen} fileDropAccept={outsideFileDropTargets}/></div> : null}
      </div>
      <LoosePile chats={loose} count={looseCount} hidden={hidden} showHidden={showHidden} onShowHidden={setShowHidden}
        canPlace={canPlace} onPlace={place} onHide={hide} open={(chatShown && chatMode === 'split') || panelOpen ? splitPile : pileOpen}
        onOpen={(chatShown && chatMode === 'split') || panelOpen ? setSplitPile : openPile} now={Date.now}
        onOpenChat={openFromPile} highlight={highlight}/>
    </>;
  }

  return <section className="canvas-view" aria-label="Canvas">
    <WorkspaceTopbar onMenu={onMenu} search={canvasId ? <div className="canvas-tools">
      {/* On phones Needs you is a segment of the list instead. */}
      {phone ? null : <NeedsYou pulses={pulses} titles={titles} projects={projects} onJump={jumpTo}/>}
      <button type="button" className="canvas-search-button" title="Search the canvas (Ctrl+K)" onClick={() => setSearchOpen(true)}>Search</button>
    </div> : undefined} leading={canvasId ? <div className="canvas-heading">
      <h1 className="canvas-name">{name}</h1>
      <CanvasSwitcher canvases={canvases ?? []} current={current} open={switcherOpen} onOpenChange={setSwitcherOpen}
        onSelect={id => onSelectCanvas(id)} onCreate={createNew} onRename={rename} onDelete={remove}/>
      {board && board.canvas.role === 'owner' ? <button type="button" className="canvas-share-button" onClick={() => setSharing(true)}>Share</button> : null}
      {board ? <button type="button" className={`canvas-share-button canvas-context-button${contextSummary?.canvas.hasContext ? ' has-context' : ''}`}
        aria-pressed={panel?.kind === 'canvas'} onClick={() => panel?.kind === 'canvas' ? setPanel(null) : openPanel({kind: 'canvas'})}>Canvas context</button> : null}
      {ownerName ? <span className="canvas-shared-by">Shared by {ownerName}</span> : null}
    </div> : undefined}/>
    {searchOpen && canvasId ? <CanvasSearch items={index} onClose={() => setSearchOpen(false)} onChoose={choose}/> : null}
    <div className={`canvas-body${chatShown ? ` has-chat is-${chatMode}` : panelOpen ? ' has-context' : ''}`}>
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
      {chatShown ? <CanvasChat key={chatChannelId} channelId={chatChannelId!} mode={chatMode!} title={chatTitle} area={chatArea} onUseHere={useHere}
        onMode={mode => onOpenChat(chatChannelId!, mode)} onClose={() => onCloseChat()} onOpenRegular={() => onOpenRegular(chatChannelId!)}>
        {chat}
      </CanvasChat> : null}
      {!chatShown && panel && board ? <ContextPanel key={`${board.canvas.id}:${panel.kind === 'area' ? panel.areaId : 'canvas'}`} canvasId={board.canvas.id} scope={panel}
        title={panel.kind === 'area' ? board.areas.find(a => a.id === panel.areaId)?.title : undefined}
        canEdit={board.canvas.role !== 'view'} dropped={areaFiles?.areaId === (panel.kind === 'area' ? panel.areaId : null) ? areaFiles : null} holdsChat={panel.kind === 'canvas' ? board.cards.length > 0 : board.cards.some(card => areaFor(cardCentre(card), board.areas)?.id === panel.areaId)}
        onChanged={() => loadSummary(board.canvas.id)} onClose={() => setPanel(null)}/> : null}
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
type ChatArea = {areas: {id: string; title: string}[]; current: string | null; placed: boolean; onMove(areaId: string | null): void};
function CanvasChat({channelId, mode, title, area, onUseHere, onMode, onClose, onOpenRegular, children}: {
  channelId: string; mode: CanvasChatMode; title: string; area?: ChatArea; onUseHere?(): Promise<void>; onMode(mode: CanvasChatMode): void; onClose(): void; onOpenRegular(): void; children: ReactNode;
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
          {area ? <label className="canvas-chat-area">
            <span>Area</span>
            <select value={area.current ?? ''} onChange={event => area.onMove(event.target.value || null)}>
              <option value="" disabled={!area.placed}>{area.placed ? 'No area' : 'Not on this canvas'}</option>
              {area.areas.map(option => <option key={option.id} value={option.id}>{option.title || 'Untitled area'}</option>)}
            </select>
          </label> : null}
          {onUseHere ? <button type="button" className="canvas-chat-action" onClick={() => void onUseHere()}>Use this area's context</button> : null}
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
