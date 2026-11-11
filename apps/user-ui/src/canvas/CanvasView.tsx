// Canvas view: top bar, first-canvas prompt, notices and the board surface.
import {useCallback,useEffect,useId,useLayoutEffect,useMemo,useRef,useState,useSyncExternalStore,type CSSProperties,type FormEvent,type ReactNode} from 'react';
import {Columns2,Ellipsis,SquareArrowOutUpRight,X} from 'lucide-react';
import {CanvasTint,DEFAULT_CARD_WIDTH,MAX_MESSAGE_ATTACHMENTS,areaFor,type BoardCard,type Canvas,type ContextSummary,type NewArea,type Project} from '@nest/schemas';
import type {Agent,Channel} from '../types';
import {WorkspaceTopbar} from '../components/WorkspaceTopbar';
import {ApiError,apiFetch,apiJson,getApiHeaders} from '../api';
import {addChatMember,removeChatMember} from '../chat-members';
import {StartChat} from '../ProjectStart';
import {boardApi,createCanvas,setCardHome,deleteCanvas,getHidden,isCanvasGone,listCanvases,renameCanvas,setHidden,withFreshVersion} from './api';
import {CanvasSwitcher} from './CanvasSwitcher';
import {ShareDialog} from './ShareDialog';
import {createBoardStore,type BoardOp} from './board-store';
import {Surface,type FileDropTarget,type SurfaceControls} from './Surface';
import {FOLDER_NOTICE,dragCarriesFiles,outsideCanvasChat} from '../components/file-drop';
import {AgentAvatar} from '../components/AgentAvatar';
import {ChatHeaderSlotsContext,type ChatHeaderSlots} from '../chat/header-slots';
import {nudgeMessage,type CanvasLive} from './live';
import {LoosePile,MAX_BULK} from './LoosePile';
import {CARD_PLACE_HEIGHT,areaAround,clearOfCards,dropLayout,gridPlacement,looseChats,slotInArea,slotOutsideAreas,type Placed} from './loose';
import {SPLIT_MAX,SPLIT_MIN,clampSplit,readSplit,splitAt,writeSplit} from './split';
import {cardTitle} from './Card';
import {AgentTray} from './AgentTray';
import {trayAgents} from './tray';
import {NeedsYou,useReviews} from './NeedsYou';
import {needsByChannel,needsYouItems,type NeedsItem} from './needs';
import {CanvasSearch} from './CanvasSearch';
import {PHONE_QUERY,PhoneList,usePhoneLayout} from './PhoneList';
import {searchIndex,type SearchItem} from './search';
import type {CardPulse} from './pulse';
import {cardCentre,growToFit,type Point} from './geometry';
import type {AreaContext} from './Area';
import {CONTEXT_WARNING,ContextPanel} from './ContextPanel';
import {errorText,getContextSummary,uploadContextFile,type PanelScope} from './context-api';
import {chatSees,contextLabel,joinNames,type ChatSees} from './context-label';
import {cardSheet,looseSheet,samePlace,stageBounds,type SheetPlace} from './sheet';
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
/** Files dropped on an area going straight into its context, with their combined progress. */
type AreaUpload = {id: number; text: string; progress: number};
const MEMBER_NOTICE_MS = 6000;
export const CANT_ADD = "You can't add people to this chat";
/** The canvas's file-drag banner (the mock's three targets); a viewer's areas take no files. */
export const FILE_DRAG_HINT = 'Drop on a chat to share files with it, on an area to add them to its context, or anywhere else to start a chat';
const FILE_DRAG_HINT_VIEW = 'Drop on a chat to share files with it, or anywhere else to start a chat';
const VIEW_ONLY_FILES = 'You can view this canvas but not add files to its context.';
const s = (n: number) => n === 1 ? '' : 's';
const them = (n: number) => n === 1 ? 'it' : 'them';

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

  // Context: one summary per board load feeds every area's chip, `↳` chips, shelf and footer; an edit re-reads it.
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
  // The context popover: its scope and the control it is anchored to.
  const [panel, setPanel] = useState<(PanelScope & {anchor: HTMLElement | null}) | null>(null);
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
      // The home was already on this canvas when the card was home before the drop.
      const wasHere = Boolean(before && was?.isHere);
      const sameHome = wasHere && was!.label === after.home.label && areaFor(cardCentre(before!), prior.areas)?.id === area;
      // A home newly on this canvas brings the canvas's own notes and files too, in an area or not.
      const canvasContext = !wasHere && Boolean(summaryRef.current?.canvas.hasContext);
      return !sameHome && (canvasContext || withContext(area)) ? [{channelId, before, x: after.x, y: after.y}] : [];
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
  /** A card's measured height once it is mounted, else the placement estimate. Placement only; never area membership. */
  const heightOf = useCallback((channelId: string) => controls.current?.cardHeight(channelId) ?? CARD_PLACE_HEIGHT, []);
  const measured = useCallback((cards: readonly BoardCard[]): Placed[] => cards.map(card => ({x: card.x, y: card.y, w: card.w, h: heightOf(card.channelId)})), [heightOf]);
  /** A new area whose title opens for typing as soon as it is shown (drawn, or made from chats). */
  const [renameAreaId, setRenameAreaId] = useState<string | null>(null);
  useEffect(() => { setRenameAreaId(null); }, [canvasId]);
  const renameStarted = useCallback((areaId: string) => setRenameAreaId(current => current === areaId ? null : current), []);
  /**
   * Places the chats in a 3-wide grid at the viewport centre, optionally inside a new area, in one call.
   * A grid (or its area) that would cover existing cards moves down below them.
   */
  const place = useCallback((channelIds: string[], withArea: boolean) => {
    const current = store.snapshot().board;
    if (!current || !channelIds.length) return Promise.resolve(false);
    const centre = clampPoint(controls.current?.centre() ?? {x: 0, y: 0});
    const first = gridPlacement(channelIds, centre);
    const dy = clearOfCards(withArea ? areaAround(first.bounds) : first.bounds, measured(current.cards));
    const {cards: placed, bounds} = dy ? gridPlacement(channelIds, clampPoint({x: centre.x, y: centre.y + dy})) : first;
    const area: NewArea | undefined = withArea ? {id: crypto.randomUUID(), title: 'New area', ...areaAround(bounds), tint: TINTS[current.areas.length % TINTS.length]} : undefined;
    const saved = applyTracked({kind: 'placeCards', cards: placed, ...(area ? {area} : {})});
    // The mock's areaFromChats: frame the new area, open its title for typing and say what to do next.
    if (area) void saved.then(ok => {
      if (!ok) return;
      say(`New area with ${channelIds.length} chat${channelIds.length === 1 ? '' : 's'}. Rename it, and add context they should all share.`);
      requestAnimationFrame(() => { controls.current?.reveal({areaId: area.id}); setRenameAreaId(area.id); });
    });
    return saved;
  }, [store, applyTracked, say, measured]);
  /** Chats dropped from the pile; dropped into an area, that area grows so they all fit inside it. */
  const dropChat = useCallback((channelIds: string[], at: Point) => {
    const current = store.snapshot().board;
    if (!current) return;
    const ids = [...new Set(channelIds)].filter(id => !current.cards.some(card => card.channelId === id) && candidatesRef.current.some(chat => chat.channelId === id)).slice(0, MAX_BULK);
    if (!ids.length) return;
    const cards = dropLayout(ids, at, measured(current.cards)).map(card => ({...card, ...clampPoint(card)}));
    void applyTracked({kind: 'placeCards', cards});
    const target = areaFor(at, current.areas);
    // The dropped cards are not mounted yet, so the area grows for the placement estimate.
    const grown = target ? growToFit(target, cards.map(card => ({...card, w: DEFAULT_CARD_WIDTH, h: CARD_PLACE_HEIGHT}))) : null;
    if (target && grown) void store.apply({kind: 'patchArea', areaId: target.id, patch: grown});
  }, [store, applyTracked, measured]);
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
  const besideCanvas = chatMode === 'split';
  useEffect(() => { if (!besideCanvas) setSplitPile(false); }, [besideCanvas]);

  // One chat at a time, and only one this person can read: never a locked or unavailable card's.
  const chatShown = Boolean(chat && chatChannelId && chatMode && channels.some(channel => channel.id === chatChannelId));
  const openCard = cards?.find(card => card.channelId === chatChannelId);
  /**
   * A focus chat opens in place (the mock's openCard): over its card when it is on this canvas, else as a plain chat over
   * the bottom box. Phones have no free canvas, so their chat fills the body instead.
   */
  const sheetAnchor: SheetAnchor | null = chatShown && chatMode === 'focus' && !phone && board ? openCard?.access === 'open' ? 'card' : 'loose' : null;
  const chatTitle = (openCard?.access === 'open' ? cardTitle(openCard) : null) ?? candidates.find(c => c.channelId === chatChannelId)?.title ?? 'Chat';
  // The header's Area picker: editors only, on a canvas with areas, for a chat on it or in the pile.
  const chatArea = board && chatShown && board.canvas.role !== 'view' && board.areas.length && (openCard ? openCard.access === 'open' : candidates.some(c => c.channelId === chatChannelId))
    ? {areas: board.areas.map(a => ({id: a.id, title: a.title})), current: openCard ? areaFor(cardCentre(openCard), board.areas)?.id ?? null : null,
      placed: Boolean(openCard), onMove: (areaId: string | null) => void moveToAreaRef.current(chatChannelId!, areaId)}
    : undefined;
  // The header's sub-line: who is in the chat, then where it sits and which context it reads (home semantics).
  const chatPeople = (openCard?.access === 'open' ? openCard.participants : channels.find(channel => channel.id === chatChannelId)?.participants) ?? [];
  const chatHome = board && openCard?.access === 'open' ? areaFor(cardCentre(openCard), board.areas) ?? null : null;
  const chatChannel = channels.find(channel => channel.id === chatChannelId);
  const chatSub: ChatSub | undefined = board && chatShown ? {
    people: chatPeople.map(p => ({agent: p.subscriberType === 'AGENT', name: p.subscriberId})),
    state: chatChannel?.archivedAt ? 'Archived' : chatChannel?.canPost === false ? 'Read-only' : undefined,
    place: openCard?.access === 'open'
      ? {kind: 'card', area: chatHome ? chatHome.title || 'Untitled area' : null,
        sees: chatSees(openCard, board.canvas.name, chatHome, chatHome ? areaContext.get(chatHome.id)?.links ?? [] : [])}
      : {kind: 'loose'},
    onSees: (areaId, opener) => openPanel(areaId ? {kind: 'area', areaId} : {kind: 'canvas'}, opener),
  } : undefined;
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
  /** Moves the view so a card opened in place sits where its sheet (at its current height) fits above the bottom box. */
  const viewRoot = useRef<HTMLElement>(null);
  const presentCard = useCallback((channelId: string) => {
    const root = viewRoot.current, surface = root?.querySelector('.canvas-surface')?.getBoundingClientRect();
    const dock = root?.querySelector('.canvas-dock')?.getBoundingClientRect();
    const sheet = root?.querySelector<HTMLElement>('.canvas-chat[data-mode="focus"]');
    const dockTop = surface && dock?.height ? dock.top - surface.top : null;
    return controls.current?.present(channelId, Math.max(SHEET_OPEN_HEIGHT, sheet?.offsetHeight ?? 0), dockTop) ?? false;
  }, []);
  /** Shows a card: a focus chat's card where its sheet fits, any other centred at a readable zoom. */
  const showCard = useCallback((channelId: string) => {
    if (modeRef.current === 'focus' && !phoneRef.current) presentCard(channelId);
    else controls.current?.reveal({channelId});
  }, [presentCard]);
  // The open chat's sheet follows its card as the view moves: the surface reports each change to the sheet.
  const viewListeners = useRef(new Set<() => void>());
  const viewChanged = useCallback(() => { for (const listener of viewListeners.current) listener(); }, []);
  const watchView = useCallback((listener: () => void) => {
    viewListeners.current.add(listener);
    return () => { viewListeners.current.delete(listener); };
  }, []);
  // Opening in place moves the camera so the card (and the sheet over it) is in view, once per open; a surface still
  // mounting (a deep link) is retried for a few frames.
  const inPlace = sheetAnchor === 'card' ? chatChannelId : null;
  useEffect(() => {
    if (!inPlace) return;
    let frame = 0, tries = 0;
    const go = () => { if (!presentCard(inPlace) && ++tries < 60) frame = requestAnimationFrame(go); };
    go();
    return () => cancelAnimationFrame(frame);
  }, [inPlace, presentCard]);
  // The canvas stays live behind a sheet (the mock): a press on empty canvas closes it, unless that press was closing a
  // popover over it (the context popover, the sheet's More menu), which it does alone. Read on the window's capture
  // phase, registered before any popover's own outside-press listener, so the popover is still there.
  const pressHadPopover = useRef(false);
  useEffect(() => {
    const down = () => { pressHadPopover.current = Boolean(document.querySelector(CANVAS_POPOVER)); };
    window.addEventListener('pointerdown', down, true);
    return () => window.removeEventListener('pointerdown', down, true);
  }, []);
  const emptyPress = useCallback(() => { if (!pressHadPopover.current) closeRef.current(); }, []);
  const fitCloses = useCallback(() => closeRef.current(), []);
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
  // The context popover floats over the canvas: opening it leaves an open chat (split or focus) as it is.
  // The same opener closes it again; another opener moves it there.
  const panelRef = useRef(panel); panelRef.current = panel;
  const openPanel = useCallback((scope: PanelScope, anchor: HTMLElement | null) => {
    const open = panelRef.current;
    const same = open && open.kind === scope.kind && (scope.kind === 'canvas' || (open.kind === 'area' && open.areaId === scope.areaId));
    setPanel(same && open.anchor === anchor ? null : {...scope, anchor});
  }, []);
  /**
   * Files on a card go to that chat, in split screen unless a chat is already open (R10). Files on an area go straight
   * into its context with a progress notice and a toast, opening nothing; while that area's popover is open they join
   * its Files section instead. A viewer's drop on an area only says why nothing happened.
   */
  const [areaFiles, setAreaFiles] = useState<{id: number; areaId: string; files: File[]} | null>(null);
  const [areaUploads, setAreaUploads] = useState<AreaUpload[]>([]);
  useEffect(() => { setAreaUploads([]); }, [canvasId]);
  const uploadId = useRef(0);
  const roleRef = useRef(board?.canvas.role); roleRef.current = board?.canvas.role;
  const chatFilesRef = useRef(onChatFiles); chatFilesRef.current = onChatFiles;
  const uploadToArea = useCallback((areaId: string, dropped: File[]) => {
    const current = store.snapshot().board;
    const area = current?.areas.find(a => a.id === areaId);
    if (!current || !area) return;
    const canvas = current.canvas.id, name = area.title || 'Untitled area';
    const files = dropped.slice(0, MAX_MESSAGE_ATTACHMENTS), cut = dropped.length - files.length;
    const id = ++uploadId.current, done = new Array<number>(files.length).fill(0);
    const text = `Adding ${files.length} file${s(files.length)} to ${name}'s context…`;
    setAreaUploads(rows => [...rows, {id, text, progress: 0}]);
    const progress = () => setAreaUploads(rows => rows.map(row => row.id === id ? {...row, progress: done.reduce((a, b) => a + b, 0) / files.length} : row));
    void Promise.allSettled(files.map((file, n) => uploadContextFile(canvas, {kind: 'area', areaId}, file, fraction => { done[n] = fraction; progress(); })
      .then(saved => { done[n] = 1; progress(); return saved; })))
      .then(results => {
        setAreaUploads(rows => rows.filter(row => row.id !== id));
        loadSummary(canvas);
        if (store.snapshot().board?.canvas.id !== canvas) return;
        const added = results.filter(result => result.status === 'fulfilled').length;
        const failed = results.flatMap((result, n) => result.status === 'rejected' ? [{name: files[n].name, reason: errorText(result.reason, 'Upload failed')}] : []);
        // The spec's warning when chats in the area (or in areas that use it) read this context.
        const board = store.snapshot().board!;
        const holdsChat = board.cards.some(card => areaFor(cardCentre(card), board.areas)?.id === areaId);
        const parts = [
          added ? `Added ${added} file${s(added)} to ${name}'s context. Every chat in the area can now see ${them(added)}.` : '',
          failed.length ? `Could not add ${joinNames(failed.map(f => f.name))}: ${failed[0].reason}` : '',
          cut ? `Only the first ${MAX_MESSAGE_ATTACHMENTS} files were added.` : '',
          added && holdsChat ? CONTEXT_WARNING : '',
        ];
        say(parts.filter(Boolean).join(' '));
      });
  }, [store, loadSummary, say]);
  const dropFiles = useCallback((target: FileDropTarget, files: File[], folders: boolean) => {
    if (target.kind === 'area' && roleRef.current === 'view') { say(VIEW_ONLY_FILES); return; }
    if (folders && (target.kind === 'card' ? visibleRef.current.some(channel => channel.id === target.channelId) : true)) say(FOLDER_NOTICE);
    if (!files.length) return;
    if (target.kind === 'card') {
      if (!visibleRef.current.some(channel => channel.id === target.channelId)) return;
      setSelectedId(target.channelId);
      openRef.current(target.channelId, modeRef.current ?? 'split');
      chatFilesRef.current(target.channelId, files);
      return;
    }
    const open = panelRef.current;
    if (open?.kind === 'area' && open.areaId === target.areaId) setAreaFiles(current => ({id: (current?.id ?? 0) + 1, areaId: target.areaId, files}));
    else uploadToArea(target.areaId, files);
  }, [say, uploadToArea]);
  // Files wait only for their own popover: once it closes or moves to another area they are gone.
  useEffect(() => { if (areaFiles && !(panel?.kind === 'area' && panel.areaId === areaFiles.areaId)) setAreaFiles(null); }, [panel, areaFiles]);
  const openAreaContext = useCallback((areaId: string, opener: HTMLElement) => openPanel({kind: 'area', areaId}, opener), [openPanel]);
  // Empty canvas: files always go to the bottom box (even with a split chat open), which says so and takes focus.
  const dockFiles = useCallback((count: number) => say(`Attached ${count} file${s(count)}. Say what you want done with ${them(count)}, then press Send.`), [say]);
  // The banner during any file drag over the canvas (not over a focus chat, which takes every drop itself).
  const [fileDrag, setFileDrag] = useState(false);
  const focusChat = chatShown && chatMode === 'focus';
  useEffect(() => {
    if (!canvasId || phone || focusChat) { setFileDrag(false); return; }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stop = () => { clearTimeout(timer); setFileDrag(false); };
    const over = (event: DragEvent) => {
      if (!dragCarriesFiles(event.dataTransfer)) return;
      setFileDrag(true);
      clearTimeout(timer);
      // Dragover repeats while the pointer is in the window; a pause means it left or the drag ended.
      timer = setTimeout(stop, 300);
    };
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') stop(); };
    window.addEventListener('dragover', over, true);
    window.addEventListener('drop', stop, true);
    window.addEventListener('dragend', stop, true);
    window.addEventListener('keydown', key);
    return () => {
      stop();
      window.removeEventListener('dragover', over, true);
      window.removeEventListener('drop', stop, true);
      window.removeEventListener('dragend', stop, true);
      window.removeEventListener('keydown', key);
    };
  }, [canvasId, phone, focusChat]);
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
  // Cards show their chat's Needs you items too (mentions and reviews), so the reviews are read here for both.
  const [needsOpen, setNeedsOpen] = useState(false);
  // Read only for a shown canvas on a wide screen; the phone list reads its own.
  const reviews = useReviews(needsOpen, Boolean(canvasId) && !phone);
  const needsCache = useRef<ReadonlyMap<string, NeedsItem[]>>(new Map());
  const cardNeeds = useMemo(() => {
    const next = needsByChannel(needsYouItems({pulses, titles, reviews, projects}), needsCache.current);
    needsCache.current = next;
    return next;
  }, [pulses, titles, reviews, projects]);
  const [highlight, setHighlight] = useState<{id: string; n: number} | null>(null);
  const highlightCount = useRef(0);
  useEffect(() => { setHighlight(null); }, [canvasId]);
  // The pointer fades once the chat that was opened over the pile is closed.
  useEffect(() => {
    if (!highlight || chatShown) return;
    const timer = setTimeout(() => setHighlight(null), 4000);
    return () => clearTimeout(timer);
  }, [highlight, chatShown]);
  /** A chat on this canvas is shown and opened in place; any other opens as a plain chat and the pile points at it. */
  const jumpTo = useCallback((channelId: string) => {
    const card = store.snapshot().board?.cards.find(c => c.channelId === channelId);
    if (card?.access === 'open') {
      presentCard(channelId);
      setSelectedId(channelId);
    } else {
      setHighlight({id: channelId, n: ++highlightCount.current});
      setPileOpen(true);
    }
    openRef.current(channelId, 'focus');
  }, [store, presentCard]);
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
    const mode = modeRef.current ?? 'split';
    openRef.current(channelId, mode);
    // Centre the card once the chat beside it has taken its room; a focus chat moves the view itself as it opens in place.
    if (mode === 'split') requestAnimationFrame(() => requestAnimationFrame(() => controls.current?.reveal({channelId})));
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
    const h = heightOf(channelId);
    const spot = clampPoint(target ? slotInArea(target, measured(others), w, h) : slotOutsideAreas(home!, current.areas, measured(others), w, h));
    const saved = card ? applyTracked({kind: 'moveCard', channelId, ...spot}) : applyTracked({kind: 'placeCards', cards: [{channelId, ...spot}]});
    const grown = target ? growToFit(target, [{...spot, w, h}]) : null;
    if (target && grown) void store.apply({kind: 'patchArea', areaId: target.id, patch: grown});
    if (!await saved) return;
    if (target) setSelectedId(channelId);
    requestAnimationFrame(() => showCard(channelId));
  }, [store, applyTracked, measured, heightOf, showCard]);
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
      if (document.querySelector('[aria-modal="true"]:not([aria-label="Search the canvas"]):not(.canvas-chat)')) return;
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
        onOpenChat={openFromPile} openChannelId={chatShown ? chatChannelId : null} areaContext={areaContext} onAreaContext={openAreaContext}/>
      {humanId ? <div className="canvas-dock"><StartChat key={dockKey} ownerId={humanId} variant="dock" voice onCreated={created} fileDrop={!chatShown} fileDropAccept={outsideCanvasChat} onFilesDropped={dockFiles}/></div> : null}
    </div>;
  } else {
    // Keyed by canvas so the saved view, gestures and measured card heights start fresh per canvas.
    const canPlace = board.canvas.role !== 'view';
    body = <>
      <div className="canvas-stage">
        <Surface key={board.canvas.id} board={board} humanId={humanId} onApply={applyTracked} pulses={pulses} onNudge={sendNudge}
          onDropChat={canPlace && !focusChat ? dropChat : undefined} controls={controls} onOpenChat={openFromCard} openChannelId={chatShown ? chatChannelId : null}
          onDropAgent={dropAgent} onRemoveAgent={removeAgent} canManageCard={manageable} onSelectCard={setSelectedId} selectedChannelId={selected?.channelId ?? null}
          areaContext={areaContext} onAreaContext={openAreaContext} contextAreaId={panel?.kind === 'area' ? panel.areaId : null} onOpenCanvas={id => onSelectCanvas(id)} onDropFiles={focusChat ? undefined : dropFiles}
          needs={cardNeeds} viewer={username} onNotice={say} onAreaCreated={setRenameAreaId} renameAreaId={renameAreaId} onRenameStarted={renameStarted}
          onViewChange={viewChanged} onEmptyPress={focusChat ? emptyPress : undefined} onFit={focusChat ? fitCloses : undefined}/>
        <AgentTray tray={tray} suggestedFor={selected ? cardTitle(selected) : null} agents={agents} humanId={humanId} cards={board.cards} areas={board.areas}/>
        {/* Files dropped on empty canvas start a chat here, even beside a split chat; a focus chat takes every drop itself. */}
        {humanId ? <div className="canvas-dock"><StartChat key={dockKey} ownerId={humanId} variant="dock" voice onCreated={created} fileDrop={!focusChat}
          fileDropAccept={outsideCanvasChat} fileDropOverlay={false} onFilesDropped={dockFiles}/></div> : null}
        {fileDrag ? <p className="canvas-file-hint" role="status">{board.canvas.role === 'view' ? FILE_DRAG_HINT_VIEW : FILE_DRAG_HINT}</p> : null}
      </div>
      <LoosePile chats={loose} count={looseCount} hidden={hidden} showHidden={showHidden} onShowHidden={setShowHidden}
        canPlace={canPlace} onPlace={place} onHide={hide} open={chatShown && chatMode === 'split' ? splitPile : pileOpen}
        onOpen={chatShown && chatMode === 'split' ? setSplitPile : openPile} now={Date.now}
        onOpenChat={openFromPile} highlight={highlight}/>
    </>;
  }

  return <section ref={viewRoot} className="canvas-view" aria-label="Canvas">
    <WorkspaceTopbar onMenu={onMenu} search={canvasId ? <div className="canvas-tools">
      {/* On phones Needs you is a segment of the list instead. */}
      {phone ? null : <NeedsYou pulses={pulses} titles={titles} projects={projects} reviews={reviews} onOpenChange={setNeedsOpen} onJump={jumpTo}/>}
      <button type="button" className="canvas-search-button" title="Search the canvas (Ctrl+K)" onClick={() => setSearchOpen(true)}>Search</button>
    </div> : undefined} leading={canvasId ? <div className="canvas-heading">
      <h1 className="canvas-name">{name}</h1>
      <CanvasSwitcher canvases={canvases ?? []} current={current} open={switcherOpen} onOpenChange={setSwitcherOpen}
        onSelect={id => onSelectCanvas(id)} onCreate={createNew} onRename={rename} onDelete={remove}/>
      {board && board.canvas.role === 'owner' ? <button type="button" className="canvas-share-button" onClick={() => setSharing(true)}>Share</button> : null}
      {board ? <button type="button" className={`canvas-share-button canvas-context-button${contextSummary?.canvas.hasContext ? ' has-context' : ''}`}
        aria-haspopup="dialog" aria-expanded={panel?.kind === 'canvas'} title={`Canvas context: notes and files every chat on ${board.canvas.name} can see`}
        onClick={event => openPanel({kind: 'canvas'}, event.currentTarget)}>
        Canvas context{contextSummary?.canvas.hasContext ? <span className="canvas-context-count"> · {contextLabel(contextSummary.canvas)}</span> : null}
      </button> : null}
      {ownerName ? <span className="canvas-shared-by">Shared by {ownerName}</span> : null}
    </div> : undefined}/>
    {searchOpen && canvasId ? <CanvasSearch items={index} onClose={() => setSearchOpen(false)} onChoose={choose}/> : null}
    <div className={`canvas-body${chatShown ? ` has-chat is-${chatMode}` : ''}${sheetAnchor ? ` is-${sheetAnchor === 'card' ? 'in-place' : 'plain'}` : ''}`}>
      {sharing && board && board.canvas.role === 'owner' ? <ShareDialog canvasId={board.canvas.id} ownerId={board.canvas.ownerId} humans={humans}
        version={canvasVersion} freshVersion={freshVersion} onSaved={() => { void store.refresh({force: true}); void reloadList().catch(() => {}); }} onClose={() => setSharing(false)}/> : null}
      <CanvasMain behind={focusChat ? phone ? 'inert' : 'hidden' : null}>
        <div className="canvas-notices">
          {state.notice && state.canvasId === canvasId ? <div className="canvas-notice" role="status">
            <span>{state.notice}</span>
            <button type="button" onClick={store.clearNotice}>Dismiss</button>
          </div> : null}
          {board ? areaUploads.map(upload => <div key={upload.id} className="canvas-notice" role="status">
            <span>{upload.text}</span>
            <span className="composer-attachment-progress canvas-notice-progress" role="progressbar" aria-label={upload.text} aria-valuemin={0} aria-valuemax={100}
              aria-valuenow={Math.round(upload.progress * 100)}><span style={{width: `${Math.round(upload.progress * 100)}%`}}/></span>
          </div>) : null}
          {memberNotice && board ? <div key={memberNotice.id} className="canvas-notice" role="status">
            <span>{memberNotice.text}</span>
            {memberNotice.undo ? <button type="button" onClick={memberNotice.undo}>Undo</button> : null}
            <button type="button" onClick={() => setMemberNotice(null)}>Dismiss</button>
          </div> : null}
        </div>
        {body}
      </CanvasMain>
      {chatShown ? <CanvasChat key={chatChannelId} channelId={chatChannelId!} mode={chatMode!} anchor={sheetAnchor} watchView={watchView} title={chatTitle} sub={chatSub} area={chatArea} onUseHere={useHere}
        onMode={mode => onOpenChat(chatChannelId!, mode)} onClose={() => onCloseChat()} onOpenRegular={() => onOpenRegular(chatChannelId!)}>
        {chat}
      </CanvasChat> : null}
      {panel && board ? <ContextPanel key={`${board.canvas.id}:${panel.kind === 'area' ? panel.areaId : 'canvas'}`} canvasId={board.canvas.id}
        canvasName={board.canvas.name} scope={panel.kind === 'area' ? {kind: 'area', areaId: panel.areaId} : {kind: 'canvas'}} anchor={panel.anchor}
        title={panel.kind === 'area' ? board.areas.find(a => a.id === panel.areaId)?.title : undefined}
        canEdit={board.canvas.role !== 'view'} dropped={areaFiles?.areaId === (panel.kind === 'area' ? panel.areaId : null) ? areaFiles : null} holdsChat={panel.kind === 'canvas' ? board.cards.length > 0 : board.cards.some(card => areaFor(cardCentre(card), board.areas)?.id === panel.areaId)}
        onViewOnlyDrop={() => say(VIEW_ONLY_FILES)} onChanged={() => loadSummary(board.canvas.id)} onClose={() => setPanel(null)}/> : null}
    </div>
  </section>;
}

/**
 * The canvas side of the body. Behind a sheet opened in place it stays live for the pointer (pan, zoom, the tray and the
 * bottom box, as in the mock) but is hidden from screen readers, and the sheet keeps Tab inside itself. Behind a phone's
 * full-screen chat it is inert. A layout effect, so both are gone before the closing chat's passive cleanup moves focus
 * back here.
 */
function CanvasMain({behind, children}: {behind: 'hidden' | 'inert' | null; children: ReactNode}) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    if (behind === 'inert') element.setAttribute('inert', ''); else element.removeAttribute('inert');
    if (behind === 'hidden') element.setAttribute('aria-hidden', 'true'); else element.removeAttribute('aria-hidden');
  }, [behind]);
  return <div ref={ref} className="canvas-main">{children}</div>;
}

const SPLIT_STEP = 2;
/** Another dialog above the chat (manage channel, the tour) takes Escape and Tab for itself, and so does an open context popover. */
const OTHER_DIALOG = '[aria-modal="true"]:not(.canvas-chat), .dialog-backdrop, .canvas-context';
/** An open popover a press on the canvas closes first: the sheet stays open under it (the mock's anyPop). */
export const CANVAS_POPOVER = '.canvas-context, .canvas-chat-menu:not([hidden]), .canvas-menu, .canvas-picker';
const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"]), [contenteditable="true"]';

/** Where a focus chat's sheet is anchored: over its card, or as a plain chat over the bottom box. */
type SheetAnchor = 'card' | 'loose';
/** A sheet's height while it opens (its CSS min-height): the camera centres at least this much. */
const SHEET_OPEN_HEIGHT = 440;
/**
 * The open chat: opened in place over the canvas (focus), or on the right with a draggable divider (split).
 * The header holds Split screen, Open in the regular chat view and Close; the chat itself is App's chat workspace.
 */
type ChatArea = {areas: {id: string; title: string}[]; current: string | null; placed: boolean; onMove(areaId: string | null): void};
/** Who is in the open chat, and where its card sits and which context it reads. */
type ChatSub = {
  people: {agent: boolean; name: string}[];
  /** An archived or read-only chat says so here (the regular view's header line, which the sheet leaves out). */
  state?: 'Archived' | 'Read-only';
  place: {kind: 'loose'} | {kind: 'card'; area: string | null; sees: ChatSees};
  /** Opens the context the chat sees (its home area's, or the canvas's) under the pressed control. */
  onSees(areaId: string | null, opener: HTMLElement): void;
};
const MAX_SUB_FACES = 5;
const initials = (name: string) => name.replace(/[^\p{L}\p{N}]+/gu, ' ').trim().split(' ').filter(Boolean).slice(0, 2).map(word => word[0]).join('').toUpperCase() || '?';

/** The mock's `.ch-sub`: participant faces, then `in {area} · sees N contexts` (a button to that context) or where it comes from. */
function ChatSubline({sub}: {sub: ChatSub}) {
  const {people, place} = sub;
  const shown = people.slice(0, MAX_SUB_FACES), more = people.length - shown.length;
  const where = place.kind === 'loose' ? 'Plain chat · not on this canvas' : place.area ? `in ${place.area}` : 'on the canvas';
  let sees: ReactNode = null;
  if (place.kind === 'card') {
    const s = place.sees;
    sees = s.kind === 'sees'
      ? <button type="button" className="canvas-chat-sees" aria-haspopup="dialog" title={`Sees: ${s.names.join(', ')}`} onClick={event => sub.onSees(s.areaId, event.currentTarget)}>
        {s.names.length === 1 ? `sees ${s.names[0]}` : `sees ${s.names.length} contexts`}
      </button>
      : s.kind === 'from' ? <span>context from {s.label}</span>
      : s.kind === 'unavailable' ? <span>context <span className="canvas-context-tag">unavailable</span></span>
      : <span>no shared context yet</span>;
  }
  return <p className="canvas-chat-sub">
    {people.length ? <span className="canvas-chat-faces" role="img" aria-label={`In this chat: ${people.map(p => p.name).join(', ')}`}>
      {shown.map(person => person.agent
        ? <span key={`a:${person.name}`} className="canvas-chat-face" title={person.name}><AgentAvatar name={person.name} size={20}/></span>
        : <span key={`h:${person.name}`} className="canvas-chat-face is-human" title={person.name} aria-hidden="true">{initials(person.name)}</span>)}
      {more ? <span className="canvas-chat-face is-more" aria-hidden="true">+{more}</span> : null}
    </span> : null}
    <span>{where}{sees ? ' · ' : ''}</span>{sees}
    {sub.state ? <span className="canvas-chat-state"> · {sub.state}</span> : null}
  </p>;
}

function CanvasChat({channelId, mode, anchor, watchView, title, sub, area, onUseHere, onMode, onClose, onOpenRegular, children}: {
  channelId: string; mode: CanvasChatMode; anchor: SheetAnchor | null; watchView(listener: () => void): () => void;
  title: string; sub?: ChatSub; area?: ChatArea; onUseHere?(): Promise<void>; onMode(mode: CanvasChatMode): void; onClose(): void; onOpenRegular(): void; children: ReactNode;
}) {
  const panel = useRef<HTMLElement>(null);
  const [split, setSplit] = useState(readSplit);
  const splitRef = useRef(split); splitRef.current = split;
  const resizing = useRef<number | null>(null);
  const closeRef = useRef(onClose); closeRef.current = onClose;
  const modeRef = useRef(mode); modeRef.current = mode;

  // In place: the sheet's top-left stays on its card's on-screen top-left as the view moves (or centred over the bottom
  // box for a plain chat). Read before paint, and again after every view change, resize or card move.
  const [place, setPlace] = useState<SheetPlace | null>(null);
  useLayoutEffect(() => {
    if (mode !== 'focus' || !anchor) { setPlace(null); return; }
    const update = () => {
      const body = panel.current?.closest<HTMLElement>('.canvas-body');
      if (!body) return;
      // Within the stage (never over the Loose chats pile beside it) and above the bottom box.
      const b = body.getBoundingClientRect(), stage = body.querySelector('.canvas-stage')?.getBoundingClientRect() ?? b;
      const dock = body.querySelector('.canvas-dock')?.getBoundingClientRect();
      const bounds = stageBounds({w: stage.width, h: stage.height}, dock?.height ? dock.top - stage.top : null, {x: stage.left - b.left, y: stage.top - b.top});
      let next: SheetPlace;
      if (anchor === 'card') {
        const card = body.querySelector<HTMLElement>(`.canvas-card[data-channel-id="${CSS.escape(channelId)}"]`)?.getBoundingClientRect();
        next = cardSheet(card ? {x: card.left - b.left, y: card.top - b.top} : null, bounds);
      } else next = looseSheet(bounds, b.height, window.innerHeight);
      setPlace(current => samePlace(current, next) ? current : next);
    };
    update();
    const unwatch = watchView(update);
    window.addEventListener('resize', update);
    return () => { unwatch(); window.removeEventListener('resize', update); };
  }, [mode, anchor, channelId, watchView]);

  // Tab stays inside a focus chat (the canvas behind it is hidden from screen readers). It acts only when focus is in the
  // sheet, on the page body or in the hidden canvas: focus in any other dialog or portal (the Huddle, Manage channel, a
  // popover) is that dialog's to move, and is never pulled back here.
  useEffect(() => {
    if (mode !== 'focus') return;
    const key = (event: KeyboardEvent) => {
      const sheet = panel.current;
      if (event.key !== 'Tab' || event.defaultPrevented || !sheet || document.querySelector(OTHER_DIALOG)) return;
      const items = [...sheet.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(element => element.getClientRects().length > 0 && !element.closest('[hidden]'));
      if (!items.length) return;
      const first = items[0], last = items[items.length - 1], active = document.activeElement;
      const inside = active instanceof Node && sheet.contains(active);
      if (!inside && active && active !== document.body && !active.closest('.canvas-main')) return;
      if (!inside || (event.shiftKey ? active === first || active === sheet : active === last)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      }
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [mode]);

  // The More menu (⋯): Move to area, Use this area's context, Sharing and Export chat. Escape and an outside press close
  // it before anything else, and choosing an action closes it.
  const [menu, setMenu] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuButton = useRef<HTMLButtonElement>(null);
  const menuId = useId();
  useEffect(() => {
    if (!menu) return;
    const key = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      event.preventDefault();
      setMenu(false);
      menuButton.current?.focus();
    };
    const press = (event: PointerEvent) => { if (!(event.target instanceof Node && menuRef.current?.contains(event.target))) setMenu(false); };
    // Choosing an action closes it. A native listener: Sharing and Export are portaled from the thread, so their clicks
    // travel React's tree (the thread), not this panel's.
    const panelElement = menuRef.current?.querySelector('.canvas-chat-menu');
    const choose = (event: Event) => { if (event.target instanceof Element && event.target.closest('button')) setMenu(false); };
    window.addEventListener('keydown', key, true);
    window.addEventListener('pointerdown', press, true);
    panelElement?.addEventListener('click', choose);
    return () => {
      window.removeEventListener('keydown', key, true);
      window.removeEventListener('pointerdown', press, true);
      panelElement?.removeEventListener('click', choose);
    };
  }, [menu]);
  // Huddle goes on the title row; Sharing and Export chat into the More menu (ChatThread portals them).
  const [actionsSlot, setActionsSlot] = useState<HTMLElement | null>(null);
  const [moreSlot, setMoreSlot] = useState<HTMLElement | null>(null);
  const slots = useMemo<ChatHeaderSlots>(() => ({actions: actionsSlot, more: moreSlot}), [actionsSlot, moreSlot]);

  // Focus moves into the chat when it opens. On close it returns to the opened card's Open button when that card
  // is mounted (after a mouse open too), else to what was focused before, else the canvas.
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const body = panel.current?.closest<HTMLElement>('.canvas-body') ?? null;
    panel.current?.focus({preventScroll: true});
    return () => {
      if (!body?.isConnected) return;
      const cardElement = body.querySelector<HTMLElement>(`.canvas-card[data-channel-id="${CSS.escape(channelId)}"]`);
      const card = cardElement?.querySelector<HTMLElement>('.canvas-card-open') ?? null;
      const surface = body.querySelector<HTMLElement>('.canvas-surface');
      const target = [card, previous, surface].find(element => element?.isConnected && body.contains(element));
      target?.focus({preventScroll: true});
      // The mock's closeCard: the card the chat closed back into flashes once.
      if (cardElement && modeRef.current === 'focus') flashCard(cardElement);
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
  const vars: Record<string, string> | undefined = focus && place ? {'--sheet-x': `${place.x}px`, '--sheet-w': `${place.w}px`, '--sheet-max-h': `${place.maxH}px`,
    ...(place.kind === 'card' ? {'--sheet-y': `${place.y}px`} : {'--sheet-bottom': `${place.bottom}px`})} : undefined;
  const sheet = vars as CSSProperties | undefined;
  return <section ref={panel} className="canvas-chat" data-mode={mode} data-place={focus ? place?.kind : undefined} tabIndex={-1}
    role={focus ? 'dialog' : 'region'} aria-modal={focus ? true : undefined} aria-label={`Open chat ${title}`}
    style={focus ? sheet : {width: `${split}%`}}>
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
    {/* The mock's `.ch-head`: title and sub-line, then `.ch-acts` of 30 px icon buttons and Close. */}
    <header className="canvas-chat-bar">
      <div className="canvas-chat-heading">
        <h2 className="canvas-chat-title">{title}</h2>
        {sub ? <ChatSubline sub={sub}/> : null}
      </div>
      <div className="canvas-chat-actions">
        <button type="button" className="canvas-chat-icon" aria-label="Split screen" aria-pressed={!focus}
          title={focus ? 'Split screen: the chat on the right, the canvas stays usable' : 'Float over the canvas instead'}
          onClick={() => onMode(focus ? 'split' : 'focus')}><Columns2 size={16} aria-hidden="true"/></button>
        <span ref={setActionsSlot} className="canvas-chat-slot"/>
        <button type="button" className="canvas-chat-icon" aria-label="Open in the regular chat view" title="Open in the regular chat view"
          onClick={onOpenRegular}><SquareArrowOutUpRight size={16} aria-hidden="true"/></button>
        <div ref={menuRef} className="canvas-chat-more">
          <button ref={menuButton} type="button" className="canvas-chat-icon" aria-label="More chat actions" title="More: area, sharing and export"
            aria-expanded={menu} aria-controls={menuId} onClick={() => setMenu(open => !open)}><Ellipsis size={16} aria-hidden="true"/></button>
          <div id={menuId} className="canvas-chat-menu" role="group" aria-label="More chat actions" hidden={!menu}>
            {area ? <label className="canvas-chat-area">
              <span>Area</span>
              <select value={area.current ?? ''} onChange={event => { setMenu(false); area.onMove(event.target.value || null); }}>
                <option value="" disabled={!area.placed}>{area.placed ? 'No area' : 'Not on this canvas'}</option>
                {area.areas.map(option => <option key={option.id} value={option.id}>{option.title || 'Untitled area'}</option>)}
              </select>
            </label> : null}
            {onUseHere ? <button type="button" className="canvas-chat-menu-item" onClick={() => void onUseHere()}>Use this area's context</button> : null}
            <span ref={setMoreSlot} className="canvas-chat-slot"/>
          </div>
        </div>
        <button type="button" className="canvas-chat-icon canvas-chat-close" aria-label="Close" title="Close" onClick={onClose}><X size={16} aria-hidden="true"/></button>
      </div>
    </header>
    <ChatHeaderSlotsContext.Provider value={slots}>
      <div className="canvas-chat-body">{children}</div>
    </ChatHeaderSlotsContext.Provider>
  </section>;
}

/** A short lime ring that fades out (the mock's `.card.flash`). A data attribute, so the card's own re-renders keep it. */
function flashCard(element: HTMLElement) {
  element.removeAttribute('data-flash');
  void element.offsetWidth;
  element.setAttribute('data-flash', '');
  element.addEventListener('animationend', () => element.removeAttribute('data-flash'), {once: true});
  // Reduced motion runs no animation: the marker goes on its own.
  setTimeout(() => element.removeAttribute('data-flash'), 1400);
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
