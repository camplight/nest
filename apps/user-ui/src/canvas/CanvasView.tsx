// Canvas view: top bar, first-canvas prompt, notices and the board surface.
import {useCallback,useEffect,useId,useLayoutEffect,useMemo,useReducer,useRef,useState,useSyncExternalStore,type CSSProperties,type FormEvent,type MutableRefObject,type ReactNode} from 'react';
import {Columns2,Ellipsis,FileText,Search,Share2,SquareArrowOutUpRight,X} from 'lucide-react';
import {AGENT_PIN_LIMIT_MESSAGE,CanvasTint,relTime,ruleText,type AgentPins,type TriggerView,type BoardLink,type Link,DEFAULT_CARD_WIDTH,MAX_MESSAGE_ATTACHMENTS,areaFor,type BoardCard,type Canvas,type CanvasArea,type ContextSummary,type NewArea,type Project,type ScheduleView} from '@nest/schemas';
import type {Agent,Channel} from '../types';
import {WorkspaceTopbar} from '../components/WorkspaceTopbar';
import {ApiError,apiFetch,apiJson,getApiHeaders} from '../api';
import {addChatMember,removeChatMember} from '../chat-members';
import {StartChat} from '../ProjectStart';
import {NOT_SCHEDULED_NO_AGENT,NOT_SCHEDULED_TOO_LONG,browserZone,notScheduledText,promptTooLong,type TypedSchedule} from '../dock-schedule';
import {boardApi,createCanvas,setCardHome,deleteCanvas,getAgentPins,getHidden,isCanvasGone,isPinsConflict,putAgentPins,listCanvases,renameCanvas,setHidden,withFreshVersion} from './api';
import {CanvasSwitcher} from './CanvasSwitcher';
import {ShareDialog} from './ShareDialog';
import {createBoardStore,type BoardOp} from './board-store';
import {Surface,type FileDropTarget,type SurfaceControls} from './Surface';
import {FOLDER_NOTICE,dragCarriesFiles,outsideCanvasChat} from '../components/file-drop';
import {AgentAvatar} from '../components/AgentAvatar';
import {ChatHeaderSlotsContext,type ChatHeaderSlots} from '../chat/header-slots';
import {nudgeMessage,type CanvasLive} from './live';
import {LooseDrawer,LooseToggle,MAX_BULK} from './LooseDrawer';
import {CARD_PLACE_HEIGHT,areaAround,clearOfCards,dropLayout,gridPlacement,looseChats,looseNeedsYou,slotInArea,slotOutsideAreas,type Placed} from './loose';
import {SPLIT_MAX,SPLIT_MIN,clampSplit,readSplit,splitAt,writeSplit} from './split';
import {cardTitle} from './Card';
import {AgentTray} from './AgentTray';
import {busyCounts,effectivePins,togglePin,trayAgents} from './tray';
import {createPinPresses,createPinSaver} from './pin-saver';
import {NeedsYou,useReviews} from './NeedsYou';
import {needsByChannel,needsYouItems,type NeedsItem} from './needs';
import {CanvasSearch} from './CanvasSearch';
import {PhoneList,usePhoneLayout} from './PhoneList';
import {searchIndex,type SearchItem} from './search';
import type {CardPulse} from './pulse';
import {cardCentre,growToFit,type Point} from './geometry';
import type {AreaContext} from './Area';
import {CONTEXT_WARNING,ContextPanel} from './ContextPanel';
import {errorText,getContextSummary,uploadContextFile,type PanelScope} from './context-api';
import {chatSees,contextLabel,joinNames,type ChatSees} from './context-label';
import {clearOfDrawer,stageBounds,type Bounds} from './sheet';
import {clampWindow,moveWindow,placeWindow,windowVars,type ChatWindow} from './chat-windows';
import {isServiceAgent,useFlows} from './useFlows';
import {LinkConflict,createLink,createSchedule,createTrigger,deleteLink,deleteSchedule,deleteTrigger,flowError,getLinks,patchLatest,patchSchedule,patchTrigger,rotateTrigger,runScheduleNow,sendNow,type LinkView} from './flows-api';
import {useDigestActions,type ChangeRequests} from './useDigestActions';
import {ChatDigest,agentLine} from './ChatDigest';
import {participantRows} from './rows';
import {HandoffPopover,type HandoffChange} from './HandoffPopover';
import {LinkPicker} from './LinkPicker';
import {ChatSetup} from './ChatSetup';
import {LinkIcon} from './Links';
import {startFork,type ForkResult,type ForkSource} from './fork';
import {SchedulePopover,type ScheduleDraft,type WebhookDraft} from './SchedulePopover';
import {ClockIcon,ScheduledList,scheduleStrip} from './ScheduledList';
import {jobsByChannel,scheduleJobs,scheduledCount,setupChip,type ScheduleJob} from './schedule-jobs';
import type {WindowCores} from '../chat/window-cores';
import './canvas.css';

export type CanvasHuman = {id?: string; username: string};
export type CanvasChatMode = 'focus' | 'split';
export type CanvasViewProps = {
  windowCores: WindowCores;
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
  /** Re-reads App's channel and project lists without navigating, so a chat started here shows in Loose chats. */
  refreshChannels(): Promise<void>;
  /** The confirmed channel list after an agent is added or removed here (App's setChannels). */
  onChannels(channels: Channel[]): void;
  /**
   * Request changes in the open chat's digest: App's reply box asks `What should change?` and hands the next message sent to
   * the armed callback; cancel restores it.
   */
  changeRequests?: ChangeRequests;
  /**
   * Forks from App's thread (flows set up): the canvas registers how it forks (create, place the fork under its parent's
   * card and frame it, or open it as a loose chat) and how a fork chip opens a chat.
   */
  forks?: MutableRefObject<CanvasForks | null>;
};
export type CanvasForks = {fork(source: ForkSource, parentChannelId: string): Promise<ForkResult | null>; open(channelId: string): void};
/** The mock's fork toast. */
export const forkToast = (parent: string) => `Forked. The new conversation sees "${parent}" up to that message.`;
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
const NO_LINKS: LinkView[] = [];
const NO_JOBS: readonly ScheduleJob[] = [];
/**
 * The open clock popover: a new item (`key` fixed when it opened), a schedule, or a webhook. `url` is a webhook's full URL
 * right after it was made or rotated, shown once; `created` is the made webhook until the list has it.
 */
type SchedPop = {
  channelId: string; scheduleId: string | null; triggerId: string | null; anchor: HTMLElement | null; newId: string; key: string;
  url: string | null; created: TriggerView | null;
};
/** The mock's toasts after a schedule is saved and deleted. */
export const scheduledToast = (rule: Parameters<typeof ruleText>[0], nextAt: number | null, now: number) =>
  rule.kind === 'webhook' ? `${ruleText(rule)}. Runs each time it happens.`
    : nextAt === null ? `${ruleText(rule)}.` : `${ruleText(rule)}. Next run ${relTime(nextAt, now)}.`;
export const SCHEDULE_DELETED = 'Schedule deleted. Past runs stay in the chat.';
/** A chat started from the toolbar or an area before its first message names it. */
const NEW_CHAT_NAME = 'New chat';
/** The mock's toast after a bottom-box send that repeats (Task 12); the notices when it is not saved are in dock-schedule.ts. */
export const typedScheduledToast = (rule: Parameters<typeof ruleText>[0]) => `Scheduled: ${ruleText(rule)}. First run now, then on schedule.`;
const SCHEDULE_TITLE = 'Schedule or trigger: run this on a timer or when something happens';
/** The mock's newStep toast (without its rename hint: a card title is renamed from the chat, not by double-click). */
export const NEW_STEP_TOAST = 'New step added. Pick who picks it up.';
const TINTS = CanvasTint.options;
/** Keeps a placed grid (or area) well inside the ±1,000,000 coordinate limit. */
const PLACE_LIMIT = 900_000;
const clampPoint = (p: Point): Point => ({x: Math.round(Math.min(PLACE_LIMIT, Math.max(-PLACE_LIMIT, p.x))), y: Math.round(Math.min(PLACE_LIMIT, Math.max(-PLACE_LIMIT, p.y)))});
const PINS_SAVE_FAILED = 'Couldn\'t save your pinned agents. Try again.';
const PINS_LOAD_FAILED = 'Couldn\'t load your pinned agents. Try again.';
const PINS_SAVED_ELSEWHERE = 'Your pinned agents were saved elsewhere. Showing them now.';
const mostRecent = (canvases: Canvas[]) => canvases.reduce<Canvas | null>((best, c) => !best || c.updatedAt > best.updatedAt ? c : best, null);

/** Nudge goes through the normal send path as the signed-in human. */
async function sendNudge(channelId: string, agent: string) {
  await apiJson('/api/messages', {method: 'POST', headers: getApiHeaders(), body: JSON.stringify(nudgeMessage(channelId, agent))});
}

export function CanvasView({canvasId, humanId, username, humans, channels, projects, agents, onSelectCanvas, onMenu, chat, chatChannelId, chatMode, onOpenChat, onCloseChat, onOpenRegular, onChatFiles, live, refreshChannels, onChannels, changeRequests, forks}: CanvasViewProps) {
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
  // Hand-offs: shown only when the server has them set up. The service agent (Switchyard) posts them; it is never a
  // card row, a tray or picker face, a mention or a quiet agent.
  const flows = useFlows(Boolean(canvasId));
  const flowsOn = flows.availability?.enabled === true;
  const service = flows.availability?.serviceAgent ?? null;
  const roster = useMemo(() => agents.filter(agent => !isServiceAgent(agent.name, service)), [agents, service]);
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
  const candidatesRef = useRef(candidates); candidatesRef.current = candidates;

  useEffect(() => {
    live.setCards([
      ...(cards ?? []).flatMap(card => card.access === 'open'
        ? [{channelId: card.channelId, agentNames: card.participants.filter(p => p.subscriberType === 'AGENT' && !isServiceAgent(p.subscriberId, service)).map(p => p.subscriberId)}] : []),
      ...candidates.map(chat => ({channelId: chat.channelId, agentNames: chat.agents.filter(name => !isServiceAgent(name, service))})),
    ]);
  }, [cards, candidates, live, service]);

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
  /** Chats dropped from the drawer; dropped into an area, that area grows so they all fit inside it. */
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
  // The Loose chats drawer (over the left of the canvas, which keeps its width) and the agent picker (above the tray)
  // share the left side, so opening either closes the other, as in the mock. Both start closed.
  const drawerId = useId();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [drawerFocus, setDrawerFocus] = useState(0);
  const looseButton = useRef<HTMLButtonElement>(null);
  const showDrawer = useCallback((open: boolean) => { setDrawerOpen(open); if (open) setPickerOpen(false); }, []);
  const showPicker = useCallback((open: boolean) => { setPickerOpen(open); if (open) setDrawerOpen(false); }, []);
  const drawerRef = useRef(drawerOpen); drawerRef.current = drawerOpen;
  // Phones have no drawer: the toggle selects the phone list's own Loose chats segment instead.
  const [phoneLoose, setPhoneLoose] = useState(0);
  const toggleDrawer = useCallback(() => {
    // A phone chat covers the list, so it closes first.
    if (phoneRef.current) {
      if (modeRef.current) closeRef.current();
      setPhoneLoose(n => n + 1);
      return;
    }
    const open = !drawerRef.current;
    showDrawer(open);
    if (open) setDrawerFocus(n => n + 1);
  }, [showDrawer]);
  const closeDrawer = useCallback((returnFocus: boolean) => {
    setDrawerOpen(false);
    if (returnFocus) looseButton.current?.focus({preventScroll: true});
  }, []);
  /** New area from these: the chats in a new area at the view's centre, its title open for typing; the drawer closes (the mock's areaFromChats). */
  const newArea = useCallback(async (channelIds: string[]) => {
    const ok = await place(channelIds, true);
    if (ok) setDrawerOpen(false);
    return ok;
  }, [place]);

  // One chat at a time, and only one this person can read: never a locked or unavailable card's.
  const chatShown = Boolean(chat && chatChannelId && chatMode && channels.some(channel => channel.id === chatChannelId));
  const openCard = cards?.find(card => card.channelId === chatChannelId);
  /**
   * A focus chat on the desktop is a window: fixed to the screen beside its card (or cascaded), dragged by its header, over
   * a canvas that stays fully usable (no dimming, nothing hidden). Phones have no free canvas, so their chat fills the body.
   */
  const windowed = chatShown && chatMode === 'focus' && !phone;
  const chatTitle = (openCard?.access === 'open' ? cardTitle(openCard) : null) ?? candidates.find(c => c.channelId === chatChannelId)?.title ?? 'Chat';
  // A loose chat this person may place: an editor's, on desktop (phones have no free canvas to place it on).
  const canPlaceLoose = Boolean(board && chatShown && !openCard && !phone && board.canvas.role !== 'view' && candidates.some(c => c.channelId === chatChannelId));
  // The header's Area picker: editors only, for a card on a canvas with areas, or a loose chat (which can also go on the
  // canvas outside any area, so it has the picker even on a canvas without areas).
  const chatArea = board && chatShown && board.canvas.role !== 'view' && (openCard ? openCard.access === 'open' && board.areas.length : candidates.some(c => c.channelId === chatChannelId) && (board.areas.length || canPlaceLoose))
    ? {areas: board.areas.map(a => ({id: a.id, title: a.title})), current: openCard ? areaFor(cardCentre(openCard), board.areas)?.id ?? null : null,
      placed: Boolean(openCard), onCanvas: canPlaceLoose, onMove: (areaId: string | null) => void moveToAreaRef.current(chatChannelId!, areaId)}
    : undefined;
  // The keyboard (and single-pointer) way to put one loose chat on the canvas, beside dragging its drawer row.
  const placeHere = canPlaceLoose ? () => void moveToAreaRef.current(chatChannelId!, null) : undefined;
  // The header's sub-line: who is in the chat, then where it sits and which context it reads (home semantics).
  const chatPeople = (openCard?.access === 'open' ? openCard.participants : channels.find(channel => channel.id === chatChannelId)?.participants) ?? [];
  const chatHome = board && openCard?.access === 'open' ? areaFor(cardCentre(openCard), board.areas) ?? null : null;
  const chatChannel = channels.find(channel => channel.id === chatChannelId);
  const chatSub: ChatSub | undefined = board && chatShown ? {
    people: chatPeople.map(p => ({agent: p.subscriberType === 'AGENT', name: p.subscriberId, service: p.subscriberType === 'AGENT' && isServiceAgent(p.subscriberId, service)})),
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
  /** Moves the view so a card sits where a sheet of the open chat's height, centred, would fit above the bottom box. */
  const viewRoot = useRef<HTMLElement>(null);
  const presentCard = useCallback((channelId: string) => {
    const root = viewRoot.current, surface = root?.querySelector('.canvas-surface')?.getBoundingClientRect();
    const dock = root?.querySelector('.canvas-dock')?.getBoundingClientRect();
    const sheet = root?.querySelector<HTMLElement>('.canvas-chat[data-mode="focus"]');
    const dockTop = surface && dock?.height ? dock.top - surface.top : null;
    // The card lands clear of an open Loose chats drawer when the sheet fits beside it.
    const drawer = root?.querySelector('.canvas-drawer')?.getBoundingClientRect();
    const drawerEdge = surface && drawer?.width ? drawer.right - surface.left : null;
    return controls.current?.present(channelId, Math.max(SHEET_OPEN_HEIGHT, sheet?.offsetHeight ?? 0), dockTop, drawerEdge) ?? false;
  }, []);
  /** Shows a card: a focus chat's card where its sheet fits, any other centred at a readable zoom. */
  const showCard = useCallback((channelId: string) => {
    if (modeRef.current === 'focus' && !phoneRef.current) presentCard(channelId);
    else controls.current?.reveal({channelId});
  }, [presentCard]);
  /**
   * The window's top-left, relative to `.canvas-body` (where the chat is positioned), and the bounds it was clamped to: the
   * stage clear of the bottom box. Placed when a chat opens as a window (beside its card when the card is on screen, else at
   * the bounds' top-left; clear of an open Loose chats drawer when it fits), kept where it is dragged, pulled back inside on
   * a resize and dropped when the chat closes or goes to split screen. The view never moves it: it is fixed to the screen.
   */
  const [floating, setFloating] = useState<{win: ChatWindow; bounds: Bounds} | null>(null);
  const windowFor = windowed ? chatChannelId : null;
  // Placed again once the stage is there: a chat opened while the canvas loads (a reload or deep link) first measures the
  // bare body, with no card and no bottom box to keep clear of.
  const stageFor = board?.canvas.id ?? null;
  useLayoutEffect(() => {
    const body = viewRoot.current?.querySelector<HTMLElement>('.canvas-body');
    const frame = windowFor && body ? windowFrame(body) : null;
    if (!windowFor || !body || !frame) { setFloating(null); return; }
    const card = body.querySelector<HTMLElement>(`.canvas-card[data-channel-id="${CSS.escape(windowFor)}"]`)?.getBoundingClientRect();
    const onScreen = card && card.right > frame.stage.left && card.left < frame.stage.right && card.bottom > frame.stage.top && card.top < frame.stage.bottom;
    const drawer = body.querySelector('.canvas-drawer')?.getBoundingClientRect();
    const at = placeWindow(onScreen ? {x: card.left - frame.body.left, y: card.top - frame.body.top, w: card.width} : null, null,
      clearOfDrawer(frame.bounds, drawer?.width ? drawer.right - frame.body.left : null));
    setFloating({win: {channelId: windowFor, ...at}, bounds: frame.bounds});
  }, [windowFor, stageFor]);
  useEffect(() => {
    if (!windowFor) return;
    const resize = () => {
      const body = viewRoot.current?.querySelector<HTMLElement>('.canvas-body'), frame = body ? windowFrame(body) : null;
      if (frame) setFloating(current => current && {win: clampWindow(current.win, frame.bounds), bounds: frame.bounds});
    };
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, [windowFor]);
  const moveFloating = useCallback((at: Point) => {
    setFloating(current => current && {...current, win: moveWindow([current.win], current.win.channelId, at, current.bounds)[0]});
  }, []);
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
  // The banner during any file drag over the canvas, chat windows open or not (a window takes the drops on itself).
  const [fileDrag, setFileDrag] = useState(false);
  useEffect(() => {
    if (!canvasId || phone) { setFileDrag(false); return; }
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
  }, [canvasId, phone]);
  // A card opens in focus, or replaces the split-screen chat beside the canvas.
  const openFromCard = useCallback((channelId: string) => { setSelectedId(channelId); openRef.current(channelId, modeRef.current ?? 'focus'); }, []);
  // Agents on cards: the selected card leads the tray's suggestions; membership goes through the engine.
  const [selectedId, setSelectedId] = useState<string | null>(null);
  useEffect(() => { setSelectedId(null); }, [canvasId]);
  const selected = cards?.find(card => card.channelId === selectedId && card.access === 'open');
  // Tray pins are personal and follow the person across canvases and devices; null until read. A failed read
  // shows the seed but is marked `failed`, so a star press re-reads first and never saves the seed over real pins.
  const [pins, setPinState] = useState<(AgentPins & {failed?: true}) | null>(null);
  const pinsRef = useRef(pins);
  const setPins = useCallback((next: (AgentPins & {failed?: true}) | null) => { pinsRef.current = next; setPinState(next); }, []);
  const agentsRef = useRef(roster); agentsRef.current = roster;
  // One saver and press queue per person: when the person changes or the view closes, pending saves are dropped and
  // answers still on their way are ignored, so one person's list is never saved under the next session.
  const pinControl = useRef<{press(name: string): void} | null>(null);
  useEffect(() => {
    let live = true;
    const fail = () => { if (live) setPins({agentNames: [], saved: false, failed: true}); };
    const saver = createPinSaver({
      put: putAgentPins, isConflict: isPinsConflict, onSaved: setPins,
      onError: confirmed => { setPins(confirmed); say(PINS_SAVE_FAILED); },
      // A seeded save met pins saved on another device: show those instead.
      onConflict: () => {
        load().then(() => { if (live) say(PINS_SAVED_ELSEWHERE); }).catch(() => { fail(); if (live) say(PINS_LOAD_FAILED); });
      },
    });
    async function load() {
      const result = await getAgentPins();
      if (!live) throw Error('Pins read for a previous person');
      saver.confirm(result);
      setPins(result);
      return result;
    }
    const presses = createPinPresses<AgentPins & {failed?: true}>({
      current: () => pinsRef.current, reload: load, onLoadFailed: () => say(PINS_LOAD_FAILED),
      apply: (name, state) => {
        const next = togglePin(effectivePins(state, agentsRef.current, humanId), name);
        if (!next) { say(AGENT_PIN_LIMIT_MESSAGE); return; }
        setPins({agentNames: next, saved: true});
        saver.save(next);
      },
    });
    pinControl.current = presses;
    setPins(null);
    load().catch(fail);
    return () => {
      live = false;
      saver.dispose();
      presses.dispose();
      if (pinControl.current === presses) pinControl.current = null;
    };
  }, [humanId, say, setPins]);
  // The pins the person sees (the seed until they save any). A star press saves that list with the one change.
  const shownPins = useMemo(() => effectivePins(pins, roster, humanId), [pins, roster, humanId]);
  const toggle = useCallback((name: string) => { pinControl.current?.press(name); }, []);
  const tray = useMemo(() => board ? trayAgents({agents: roster, cards: board.cards, areas: board.areas, selectedId: selected?.channelId ?? null, pins: shownPins})
    : {suggested: [], pinned: []}, [board, roster, selected, shownPins]);
  const busy = useMemo(() => busyCounts(board?.cards ?? [], pulses), [board, pulses]);
  const owners = useMemo(() => new Map(humans.flatMap(person => person.id ? [[person.id, person.username] as const] : [])), [humans]);
  // Needs you and search. Only chats the person can see are named: open cards and loose chats, never a locked or unavailable card.
  const titles = useMemo(() => {
    const map = new Map<string, string>();
    for (const card of cards ?? []) if (card.access === 'open') map.set(card.channelId, card.title || 'Untitled chat');
    for (const chat of candidates) map.set(chat.channelId, chat.title || 'Untitled chat');
    return map;
  }, [cards, candidates]);
  // Cards show their chat's Needs you items too (mentions and reviews), so the reviews are read here for both.
  const [needsOpen, setNeedsOpen] = useState(false);
  // Read once for a shown canvas, phones included: the phone list's Needs you takes them from here, and a loose chat
  // that only waits on a review turns the top-bar count coral there too. Read again as either Needs you opens.
  const [phoneNeedsOpen, setPhoneNeedsOpen] = useState(false);
  // Bumped after a review decided in the open chat's digest, so the reviews are read again at once.
  const [reviewsRead, rereadReviews] = useReducer((n: number) => n + 1, 0);
  const reviews = useReviews(needsOpen || phoneNeedsOpen, Boolean(canvasId), reviewsRead);
  const needsCache = useRef<ReadonlyMap<string, NeedsItem[]>>(new Map());
  // Flow items (approvals, paused links, missed runs) join from useFlows; cards show them as their pill too.
  const cardNeeds = useMemo(() => {
    const next = needsByChannel(needsYouItems({pulses, titles, reviews, projects, flows: flows.needs}), needsCache.current);
    needsCache.current = next;
    return next;
  }, [pulses, titles, reviews, projects, flows.needs]);
  // The drawer's rows read the same pulses and Needs you items as the cards: a row's reason, activity and chip.
  const loose = useMemo(() => cards ? looseChats({channels, projects, boardChannelIds: boardIds, hidden, username, userId: humanId, pulses, needs: cardNeeds, showHidden}) : [],
    [cards, channels, projects, boardIds, hidden, username, humanId, pulses, cardNeeds, showHidden]);
  const shownLoose = useMemo(() => showHidden ? loose.filter(chat => !hidden.has(chat.channelId)) : loose, [loose, hidden, showHidden]);
  const looseHot = useMemo(() => shownLoose.some(looseNeedsYou), [shownLoose]);
  // Scheduled jobs (flows): the viewer's schedules and agents' own booked runs. Cards show a badge, the open chat its strips,
  // and the top bar the jobs in chats on this canvas or loose.
  const jobs = useMemo(() => scheduleJobs({schedules: flows.schedules.schedules, agentMade: flows.schedules.agentMade, triggers: flows.schedules.triggers, viewerId: humanId, names: owners, tz: browserZone()}),
    [flows.schedules, humanId, owners]);
  const jobsCache = useRef<ReadonlyMap<string, readonly ScheduleJob[]>>(new Map());
  const cardJobs = useMemo(() => {
    const next = jobsByChannel(jobs, jobsCache.current);
    jobsCache.current = next;
    return next;
  }, [jobs]);
  const canvasJobs = useMemo(() => jobs.filter(job => titles.has(job.channelId)), [jobs, titles]);
  const [schedList, setSchedList] = useState<HTMLElement | null>(null);
  useEffect(() => { setSchedList(null); }, [canvasId]);
  const [highlight, setHighlight] = useState<{id: string; n: number} | null>(null);
  const highlightCount = useRef(0);
  useEffect(() => { setHighlight(null); }, [canvasId]);
  // The pointer fades once the chat that was opened over the drawer is closed.
  useEffect(() => {
    if (!highlight || chatShown) return;
    const timer = setTimeout(() => setHighlight(null), 4000);
    return () => clearTimeout(timer);
  }, [highlight, chatShown]);
  /** A chat on this canvas is selected and opened (its window beside the card when it is on screen); any other opens as a plain chat and the drawer points at it. */
  const jumpTo = useCallback((channelId: string) => {
    const card = store.snapshot().board?.cards.find(c => c.channelId === channelId);
    if (card?.access === 'open') setSelectedId(channelId);
    else {
      setHighlight({id: channelId, n: ++highlightCount.current});
      // Phones have no drawer: they list loose chats in their own segment.
      if (!phoneRef.current) showDrawer(true);
    }
    openRef.current(channelId, 'focus');
  }, [store, showDrawer]);
  const openLoose = useCallback((channelId: string) => openRef.current(channelId, 'focus'), []);
  /**
   * A sent bottom-box chat stays in sight: on a canvas this person can edit it is placed at the
   * centre of the view (clear of other cards) and opens beside the canvas; otherwise it opens in
   * focus and the drawer points at it. The box starts over either way.
   */
  const [dockKey, setDockKey] = useState(0);
  const refreshRef = useRef(refreshChannels); refreshRef.current = refreshChannels;
  /**
   * A typed repeat from the bottom box, saved once its chat exists and the message is sent. A failure keeps the chat and
   * the message and only says why; the lead agent is the chat's, so the engine has it as a member already.
   */
  const scheduleTyped = useCallback(async (channelId: string, typed: TypedSchedule) => {
    if (!typed.agent) { say(NOT_SCHEDULED_NO_AGENT); return; }
    if (promptTooLong(typed.prompt)) { say(NOT_SCHEDULED_TOO_LONG); return; }
    try {
      await createSchedule({id: typed.id, channelId, agent: typed.agent, prompt: typed.prompt, rule: typed.rule, timezone: browserZone()});
      say(typedScheduledToast(typed.rule));
    } catch (error) {
      say(notScheduledText(error));
    } finally { flows.refresh(); }
  }, [say, flows.refresh]);
  /** A new chat into an area: a free spot under the title bar; the area grows to hold it. */
  const placeInArea = useCallback(async (channelId: string, area: CanvasArea) => {
    const current = store.snapshot().board;
    if (!current) return false;
    const w = DEFAULT_CARD_WIDTH, h = CARD_PLACE_HEIGHT;
    const spot = clampPoint(slotInArea(area, measured(current.cards), w, h));
    if (!await applyTracked({kind: 'placeCards', cards: [{channelId, ...spot}]})) return false;
    const grown = growToFit(area, [{...spot, w, h}]);
    if (grown) void store.apply({kind: 'patchArea', areaId: area.id, patch: grown});
    return true;
  }, [store, applyTracked, measured]);
  const created = useCallback(async (project: Project, typed?: {schedule?: TypedSchedule}) => {
    setDockKey(n => n + 1);
    if (typed?.schedule && project.channelId) void scheduleTyped(project.channelId, typed.schedule);
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
    // Centre the card once the chat beside it has taken its room; it was placed at the view's centre, so a window opens beside it.
    if (mode === 'split') requestAnimationFrame(() => requestAnimationFrame(() => controls.current?.reveal({channelId})));
  }, [store, place, jumpTo, scheduleTyped]);
  /** The chat mode last used on the canvas (a card click's floating sheet until one is opened), for chats started without one open. */
  const lastModeRef = useRef<CanvasChatMode>('focus');
  if (chatShown && chatMode) lastModeRef.current = chatMode;
  const startingChat = useRef(false);
  /**
   * The toolbar's `Chat` and an area's `+ Chat` (editors): a new team chat named "New chat" (the first message names it,
   * as from the bottom box) with the person's own agent, if they have one, placed at the view's centre or inside the area
   * (which grows to hold it), then opened in the current or last chat mode with its composer focused.
   */
  const newChat = useCallback(async (areaId?: string) => {
    const current = store.snapshot().board;
    if (!current || current.canvas.role === 'view' || phoneRef.current || startingChat.current) return;
    startingChat.current = true;
    try {
      let project: Project;
      try {
        const roster = await apiJson<{personalAgent: {subscriberId: string} | null}>('/api/projects/members').catch(() => null);
        const members = roster?.personalAgent ? [{subscriberType: 'AGENT', subscriberId: roster.personalAgent.subscriberId}] : [];
        project = await apiJson<Project>('/api/projects', {method: 'POST', headers: getApiHeaders(),
          body: JSON.stringify({id: crypto.randomUUID(), name: NEW_CHAT_NAME, members, collaboration: 'team'})});
      } catch { say('Could not start a new chat. Try again.'); return; }
      await refreshRef.current().catch(() => {});
      const now = store.snapshot().board;
      if (!now || now.canvas.id !== current.canvas.id) return;
      const area = areaId ? now.areas.find(a => a.id === areaId) : undefined;
      if (!await (area ? placeInArea(project.channelId, area) : place([project.channelId], false))) { say('Could not put the new chat on the canvas. Try again.'); return; }
      // Let App's refreshed chat list reach the canvas before opening the chat from it.
      await new Promise(resolve => requestAnimationFrame(resolve));
      setSelectedId(project.channelId);
      const mode = modeRef.current ?? lastModeRef.current;
      openRef.current(project.channelId, mode);
      if (mode === 'split') requestAnimationFrame(() => requestAnimationFrame(() => controls.current?.reveal({channelId: project.channelId})));
      let tries = 0;
      const focus = () => {
        const box = viewRoot.current?.querySelector<HTMLTextAreaElement>('.canvas-chat textarea');
        if (box) box.focus({preventScroll: true}); else if (++tries < 60) requestAnimationFrame(focus);
      };
      requestAnimationFrame(focus);
    } finally { startingChat.current = false; }
  }, [store, say, place, placeInArea]);
  const newChatHere = useCallback(() => void newChat(), [newChat]);
  const newChatInArea = useCallback((areaId: string) => void newChat(areaId), [newChat]);
  /**
   * The open chat's header moves its card into an area (a free spot under the title bar; the area
   * grows to fit) or, with no area, just outside the one it is in. A loose chat is placed straight
   * into the area, or with no area at the viewport centre (clear of other cards, as Place on canvas).
   * The view follows the card; an open window stays where it is.
   */
  const moveToArea = useCallback(async (channelId: string, areaId: string | null) => {
    const current = store.snapshot().board;
    if (!current || current.canvas.role === 'view') return;
    const card = current.cards.find(c => c.channelId === channelId);
    const others = current.cards.filter(c => c.channelId !== channelId);
    const w = card?.w ?? DEFAULT_CARD_WIDTH;
    const target = areaId ? current.areas.find(a => a.id === areaId) : undefined;
    const home = card ? areaFor(cardCentre(card), current.areas) : undefined;
    if (!areaId && !card) {
      if (!candidatesRef.current.some(chat => chat.channelId === channelId) || !await place([channelId], false)) return;
      setSelectedId(channelId);
      return;
    }
    if (areaId ? !target || target.id === home?.id : !card || !home) return;
    const h = heightOf(channelId);
    const spot = clampPoint(target ? slotInArea(target, measured(others), w, h) : slotOutsideAreas(home!, current.areas, measured(others), w, h));
    const saved = card ? applyTracked({kind: 'moveCard', channelId, ...spot}) : applyTracked({kind: 'placeCards', cards: [{channelId, ...spot}]});
    const grown = target ? growToFit(target, [{...spot, w, h}]) : null;
    if (target && grown) void store.apply({kind: 'patchArea', areaId: target.id, patch: grown});
    if (!await saved) return;
    if (target) setSelectedId(channelId);
    requestAnimationFrame(() => showCard(channelId));
  }, [store, applyTracked, measured, heightOf, showCard, place]);
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
  /**
   * The Hand-off popover: opened from a line's label, read from the link API (version, titles and rights), and saved
   * one change at a time so each write carries the version the previous one returned. While it is open the line shows
   * its settings (and the name as typed) before the board re-reads them.
   */
  // `chat`: opened from the open chat's links row, whose other chat may not be on this canvas (no line to follow).
  const [flowPop, setFlowPop] = useState<{linkId: string; anchor: HTMLElement | null; view: LinkView | null; draft?: string; chat?: true} | null>(null);
  const flowPopRef = useRef(flowPop); flowPopRef.current = flowPop;
  useEffect(() => { setFlowPop(null); }, [canvasId]);
  const flowLinkGone = Boolean(flowPop && !flowPop.chat && board && !board.links.some(l => l.id === flowPop.linkId && l.access === 'open'));
  useEffect(() => { if (flowLinkGone) setFlowPop(null); }, [flowLinkGone]);
  /** The link with its version and rights, read through a chat the viewer can read (the source first). */
  const readLink = useCallback(async (linkId: string): Promise<LinkView | null> => {
    const current = store.snapshot().board, link = current?.links.find(l => l.id === linkId);
    if (!current || !link) return null;
    const readable = (id: string) => current.cards.some(card => card.channelId === id && card.access === 'open');
    for (const channelId of readable(link.from) || !readable(link.to) ? [link.from, link.to] : [link.to, link.from]) {
      try { const found = (await getLinks(channelId)).find(l => l.id === linkId); if (found) return found; } catch {}
    }
    return null;
  }, [store]);
  const openFlowLink = useCallback((linkId: string, anchor: HTMLElement | null) => {
    if (flowPopRef.current?.linkId === linkId) return;
    setLinkPick(null);
    setFlowPop({linkId, anchor, view: null});
    void readLink(linkId).then(view => {
      if (flowPopRef.current?.linkId !== linkId) return;
      if (view) setFlowPop(current => current?.linkId === linkId ? {...current, view} : current);
      else { setFlowPop(null); say('Could not open this hand-off. Try again.'); }
    });
  }, [readLink, say]);
  const closeFlowPop = useCallback(() => setFlowPop(null), []);
  const flowQueue = useRef<Promise<void>>(Promise.resolve());
  /** The newest version this page saved for each link, for changes that run after their popover closed. */
  const flowVersions = useRef(new Map<string, number>());
  const queueFlow = useCallback((run: () => Promise<void>) => { flowQueue.current = flowQueue.current.then(run, run); }, []);
  // The link comes from the popover with the change: a name flushed as the popover closes (Escape, a press outside)
  // runs after flowPop is already null, and still saves.
  const changeFlow = useCallback((change: HandoffChange, link: LinkView) => queueFlow(async () => {
    const open = flowPopRef.current?.view?.id === link.id ? flowPopRef.current.view : null;
    const view = open ?? link;
    const by = humanRef.current;
    // An agent from `+ Someone else` joins the receiving chat first (manage rights), then picks it up.
    if (change.who) {
      const card = cardFor(view.to);
      const inChat = card?.access === 'open' && card.participants.some(p => p.subscriberType === 'AGENT' && p.subscriberId === change.who);
      if (!inChat) {
        if (!card || card.access !== 'open' || !manageable(card)) { say(CANT_ADD); return; }
        try {
          const fresh = await addChatMember({channelId: card.channelId, projectId: card.projectId, member: {subscriberType: 'AGENT', subscriberId: change.who}, fetch: apiFetch, fetchJson: apiJson});
          if (!settle(fresh, by)) return;
        } catch { if (humanRef.current === by) say(`Could not add ${change.who}. Try again.`); return; }
      }
    }
    const before = view;
    setFlowPop(current => current?.linkId === view.id && current.view ? {...current, view: {...current.view, ...change}} : current);
    try {
      const live = flowPopRef.current?.view?.id === view.id ? flowPopRef.current.view.version : undefined;
      const saved = await patchLatest(view.id, change, Math.max(live ?? 0, flowVersions.current.get(view.id) ?? 0, view.version));
      flowVersions.current.set(saved.id, saved.version);
      setFlowPop(current => current?.linkId === saved.id && current.view
        ? {...current, view: {...current.view, ...saved}, draft: change.label !== undefined && current.draft === saved.label ? undefined : current.draft} : current);
      void store.refresh({force: true});
      bumpLinks();
      if (change.on !== undefined) flows.refresh();
    } catch (error) {
      setFlowPop(current => current?.linkId === before.id && current.view
        ? {...current, view: {...current.view, what: before.what, when: before.when, who: before.who, label: before.label, on: before.on}, draft: undefined} : current);
      if (error instanceof LinkConflict && !error.current) { setFlowPop(null); void store.refresh({force: true}); }
      say(flowError(error, 'Could not change the hand-off. Try again.'));
    }
  }), [queueFlow, manageable, settle, say, store, flows.refresh]);
  const disconnectFlow = useCallback(() => queueFlow(async () => {
    const view = flowPopRef.current?.view;
    if (!view) return;
    const version = flowPopRef.current?.view?.version ?? view.version;
    try {
      try { await deleteLink(view.id, version); } catch (error) {
        if (!(error instanceof LinkConflict)) throw error;
        if (error.current) await deleteLink(view.id, error.current.version);
      }
      setFlowPop(null);
      say(`Disconnected. "${view.toTitle}" keeps what it already got.`);
      void store.refresh({force: true});
      bumpLinks();
      flows.refresh();
    } catch (error) { say(flowError(error, 'Could not disconnect. Try again.')); }
  }), [queueFlow, say, store, flows.refresh]);
  const sendFlow = useCallback(() => queueFlow(async () => {
    const view = flowPopRef.current?.view;
    if (!view) return;
    try {
      await sendNow(view.id);
      setFlowPop(null);
      say(`Sent to "${view.toTitle}".`);
    } catch (error) { say(flowError(error, 'Could not send it. Try again.')); }
  }), [queueFlow, say]);
  const draftFlowLabel = useCallback((label: string) => setFlowPop(current => current ? {...current, draft: label} : current), []);
  /** A fork line's label: findings stop or start flowing back to the parent, with no popover (the mock's toggle-link). */
  const toggleFork = useCallback((linkId: string) => queueFlow(async () => {
    const view = await readLink(linkId);
    if (!view) { say('Could not change the fork. Try again.'); return; }
    try {
      const saved = await patchLatest(view.id, {on: !view.on}, view.version);
      say(saved.on ? `Findings from "${view.fromTitle}" flow back to "${view.toTitle}" again.` : `Paused: findings from "${view.fromTitle}" no longer flow back to "${view.toTitle}".`);
      void store.refresh({force: true});
      bumpLinks();
      flows.refresh();
    } catch (error) { say(flowError(error, 'Could not change the fork. Try again.')); }
  }), [queueFlow, readLink, say, store, flows.refresh]);
  // The board's links, with the open popover's settings (and the name as typed) over its own line.
  const shownLinks = useMemo((): BoardLink[] | undefined => {
    if (!flowsOn || !board) return undefined;
    const view = flowPop?.view;
    if (!view) return board.links;
    return board.links.map(l => l.id === view.id && l.access === 'open'
      ? {...l, what: view.what, when: view.when, who: view.who, on: view.on, label: flowPop?.draft ?? view.label} : l);
  }, [flowsOn, board, flowPop]);
  /**
   * Connecting chats (the mock's connect, linkpick and newStep): a dragged `+` port, the chat picker (a card's connect
   * button, the open chat's header and its `+ Connect`) or a new step. A new link, or the pair's existing one, opens its
   * Hand-off popover under its label once the board shows it. A refusal (S9: no access to either chat) is a toast.
   */
  const [linkPick, setLinkPick] = useState<{from: string; anchor: HTMLElement | null} | null>(null);
  useEffect(() => { setLinkPick(null); }, [canvasId]);
  const pickFrom = linkPick && board ? board.cards.find((card): card is Extract<BoardCard, {access: 'open'}> => card.channelId === linkPick.from && card.access === 'open') : undefined;
  useEffect(() => { if (linkPick && board && !pickFrom) setLinkPick(null); }, [linkPick, board, pickFrom]);
  // Connecting changes the shared canvas (both cards show the line), so view-role members cannot (T7-R1).
  const openLinkPick = useCallback((from: string, anchor: HTMLElement | null) => {
    if (store.snapshot().board?.canvas.role === 'view') return;
    setFlowPop(null);
    setLinkPick(current => current?.from === from && current.anchor === anchor ? null : {from, anchor});
  }, [store]);
  const closeLinkPick = useCallback(() => setLinkPick(null), []);
  /** Opens a link's popover under its label, once the label is drawn (a few frames after the board re-read). */
  const showLink = useCallback((linkId: string) => {
    if (phoneRef.current) { openFlowLink(linkId, null); return; }
    let tries = 0;
    const go = () => {
      const label = viewRoot.current?.querySelector<HTMLElement>(`.canvas-world > .lab[data-link-id="${CSS.escape(linkId)}"]`) ?? null;
      if (label || ++tries >= 30) openFlowLink(linkId, label); else requestAnimationFrame(go);
    };
    requestAnimationFrame(go);
  }, [openFlowLink]);
  const connect = useCallback(async (from: string, to: string, intro = false) => {
    setLinkPick(null);
    if (store.snapshot().board?.canvas.role === 'view') return false;
    let link: Link;
    try { link = await createLink({id: crypto.randomUUID(), from, to, ...(intro ? {intro: true} : {})}); } catch (error) {
      say(flowError(error, 'Could not connect these chats. Try again.'));
      return false;
    }
    bumpLinks();
    await store.refresh({force: true});
    showLink(link.id);
    return true;
  }, [say, store, showLink]);
  const connectCards = useCallback((from: string, to: string) => void connect(from, to), [connect]);
  /**
   * A new step after a chat (editors only): a new team chat named after it, placed with its top 60 px above `at` (the
   * mock's newStep; an area there grows to hold it), connected with the intro note, its popover open.
   */
  const newStep = useCallback(async (from: string, at: Point) => {
    const current = store.snapshot().board;
    const source = current?.cards.find(card => card.channelId === from);
    if (!current || current.canvas.role === 'view' || source?.access !== 'open') return;
    setLinkPick(null);
    let project: Project;
    try {
      project = await apiJson<Project>('/api/projects', {method: 'POST', headers: getApiHeaders(),
        body: JSON.stringify({id: crypto.randomUUID(), name: `Next step after "${cardTitle(source).slice(0, 26)}"`, members: [], collaboration: 'team'})});
    } catch { say('Could not add a new step. Try again.'); return; }
    void refreshRef.current().catch(() => {});
    const now = store.snapshot().board;
    if (!now || now.canvas.id !== current.canvas.id) return;
    const spot = clampPoint({x: at.x, y: at.y - 60});
    if (!await store.apply({kind: 'placeCards', cards: [{channelId: project.channelId, ...spot}]})) { say('Could not put the new step on the canvas. Try again.'); return; }
    const target = areaFor(cardCentre({...spot, w: DEFAULT_CARD_WIDTH}), now.areas);
    const grown = target ? growToFit(target, [{...spot, w: DEFAULT_CARD_WIDTH, h: CARD_PLACE_HEIGHT}]) : null;
    if (target && grown) await store.apply({kind: 'patchArea', areaId: target.id, patch: grown});
    if (await connect(from, project.channelId, true)) say(NEW_STEP_TOAST);
  }, [store, say, connect]);
  const dropNewStep = useCallback((from: string, at: Point) => void newStep(from, at), [newStep]);
  /** The picker's new step goes 120 px right of the chat and 60 px down (the mock's lp-new). */
  const pickNewStep = useCallback((from: string) => {
    const card = store.snapshot().board?.cards.find(c => c.channelId === from);
    if (card) void newStep(from, {x: card.x + card.w + 120, y: card.y + 60});
  }, [store, newStep]);
  /**
   * Fork from here (the mock's fork()): the new chat goes 40 px right and 360 px below its parent's card when that card is
   * on this canvas and the person may edit it (into the parent's area, which grows to hold it); the open chat closes and
   * the fork is framed, flashed and focused. Otherwise (another canvas, a view-role member, a loose parent) the fork
   * opens as a loose chat. Either way the toast says what the fork sees.
   */
  const forkFrom = useCallback(async (source: ForkSource, parentChannelId: string): Promise<ForkResult | null> => {
    const before = store.snapshot().board;
    const parentCard = before?.cards.find(card => card.channelId === parentChannelId);
    const parentTitle = (parentCard?.access === 'open' ? cardTitle(parentCard) : null) ?? candidatesRef.current.find(chat => chat.channelId === parentChannelId)?.title
      ?? projects.find(project => project.channelId === parentChannelId)?.name ?? channels.find(channel => channel.id === parentChannelId)?.name ?? 'this chat';
    let result: ForkResult;
    try { result = await startFork({ownerId: humanRef.current, parentChannelId, source}); } catch (error) {
      say(flowError(error, 'Could not fork this chat. Try again.'));
      return null;
    }
    await refreshRef.current().catch(() => {});
    const child = result.childChannelId;
    const now = store.snapshot().board;
    const parent = now?.cards.find(card => card.channelId === parentChannelId);
    let placed = false;
    if (now && before && now.canvas.id === before.canvas.id && now.canvas.role !== 'view' && parent) {
      placed = now.cards.some(card => card.channelId === child);
      if (!placed) {
        const spot = clampPoint({x: parent.x + 40, y: parent.y + 360});
        placed = await store.apply({kind: 'placeCards', cards: [{channelId: child, ...spot}]});
        const area = areaFor(cardCentre(parent), now.areas);
        const grown = placed && area ? growToFit(area, [{...spot, w: DEFAULT_CARD_WIDTH, h: CARD_PLACE_HEIGHT}]) : null;
        if (area && grown) await store.apply({kind: 'patchArea', areaId: area.id, patch: grown});
      }
    }
    // Let App's refreshed chat list reach the canvas before opening the chat from it.
    await new Promise(resolve => requestAnimationFrame(resolve));
    if (placed && !phoneRef.current) {
      closeRef.current();
      setSelectedId(child);
      // Once the sheet is gone and the card mounted: frame it, flash it and give it focus (never the page body).
      let tries = 0;
      const frame = () => {
        const root = viewRoot.current;
        const card = root?.querySelector<HTMLElement>(`.canvas-card[data-channel-id="${CSS.escape(child)}"]`);
        if ((!card || root?.querySelector('.canvas-chat')) && ++tries < 60) { requestAnimationFrame(frame); return; }
        controls.current?.reveal({channelId: child});
        if (!card) return;
        flashCard(card);
        card.querySelector<HTMLElement>('.canvas-card-open')?.focus({preventScroll: true});
      };
      requestAnimationFrame(frame);
    } else jumpTo(child);
    void store.refresh({force: true});
    bumpLinks();
    say(forkToast(parentTitle));
    return result;
  }, [store, projects, channels, say, jumpTo]);
  /** A fork chip: the chat opens like a card does (in the current mode), or as a loose chat. */
  const openFork = useCallback((channelId: string) => {
    if (store.snapshot().board?.cards.some(card => card.channelId === channelId && card.access === 'open')) openFromCard(channelId);
    else jumpTo(channelId);
  }, [store, openFromCard, jumpTo]);
  useEffect(() => {
    if (!forks) return;
    const handle: CanvasForks = {fork: forkFrom, open: openFork};
    forks.current = handle;
    return () => { if (forks.current === handle) forks.current = null; };
  }, [forks, forkFrom, openFork]);
  const canLink = flowsOn && Boolean(board) && board?.canvas.role !== 'view';
  const canConnect = useCallback((card: BoardCard) => canLink && card.access === 'open', [canLink]);
  /** The open chat's links (for its Setup line), re-read as the board's links change and after each change made here. */
  const [linksTick, bumpLinks] = useReducer((n: number) => n + 1, 0);
  const [chatLinks, setChatLinks] = useState<{channelId: string; links: LinkView[]} | null>(null);
  const boardLinks = useMemo(() => JSON.stringify(board?.links ?? []), [board?.links]);
  useEffect(() => {
    if (!flowsOn || !chatShown || !chatChannelId) return;
    let live = true;
    getLinks(chatChannelId).then(links => { if (live) setChatLinks({channelId: chatChannelId, links}); }).catch(() => {});
    return () => { live = false; };
  }, [flowsOn, chatShown, chatChannelId, boardLinks, linksTick]);
  // The popover's settings show on the chips at once (a pause strikes its chip through before the re-read).
  const setupLinks = useMemo(() => {
    const links = chatLinks?.channelId === chatChannelId ? chatLinks.links : NO_LINKS;
    const view = flowPop?.view;
    return view ? links.map(l => l.id === view.id ? {...l, ...view} : l) : links;
  }, [chatLinks, chatChannelId, flowPop]);
  const openChatLink = useCallback((link: LinkView, anchor: HTMLElement) => {
    if (flowPopRef.current?.linkId === link.id) return;
    setLinkPick(null);
    setFlowPop({linkId: link.id, anchor, view: link, chat: true});
  }, []);
  /**
   * The clock popover (the mock's openSched): a new schedule for the open chat from its header's clock, or one of its
   * schedules from a strip's Edit. Saving first adds an agent who is not in the chat yet (manage rights, as `+ Someone else`).
   */
  const [schedPop, setSchedPop] = useState<SchedPop | null>(null);
  const schedPopRef = useRef(schedPop); schedPopRef.current = schedPop;
  useEffect(() => { setSchedPop(null); }, [canvasId]);
  // It belongs to the open chat: closing or switching the chat closes it, and so does its schedule or webhook being deleted
  // elsewhere. A webhook made in it is read from its create answer until the list has it.
  const popSchedule = schedPop?.scheduleId ? flows.schedules.schedules.find(s => s.id === schedPop.scheduleId) ?? null : null;
  const popTrigger = schedPop?.triggerId ? flows.schedules.triggers.find(t => t.id === schedPop.triggerId) ?? (schedPop.created?.id === schedPop.triggerId ? schedPop.created : null) : null;
  const schedPopStale = Boolean(schedPop && (!chatShown || schedPop.channelId !== chatChannelId || (schedPop.scheduleId && !popSchedule) || (schedPop.triggerId && !popTrigger)));
  useEffect(() => { if (schedPopStale) setSchedPop(null); }, [schedPopStale]);
  const schedulesRef = useRef(flows.schedules.schedules); schedulesRef.current = flows.schedules.schedules;
  const triggersRef = useRef(flows.schedules.triggers); triggersRef.current = flows.schedules.triggers;
  const peopleRef = useRef(chatPeople); peopleRef.current = chatPeople;
  const openSchedule = useCallback((channelId: string, scheduleId: string | null, anchor: HTMLElement | null, triggerId: string | null = null) => {
    setFlowPop(null); setLinkPick(null); setSchedList(null);
    setSchedPop(current => current && current.channelId === channelId && current.scheduleId === scheduleId && current.triggerId === triggerId && current.anchor === anchor ? null
      : {channelId, scheduleId, triggerId, anchor, newId: crypto.randomUUID(), key: scheduleId ?? triggerId ?? crypto.randomUUID(), url: null, created: null});
  }, []);
  const closeSchedPop = useCallback(() => setSchedPop(null), []);
  /** Whether the person may add agents to this chat: a card's rule, or for a loose chat the same rule on its channel. */
  const canAddTo = useCallback((channelId: string) => {
    const card = cardFor(channelId);
    if (card) return manageable(card);
    const channel = visibleRef.current.find(c => c.id === channelId), project = projects.find(p => p.channelId === channelId);
    return Boolean(channel?.canManage && !channel.archivedAt && (!project || project.ownerId === humanId));
  }, [store, manageable, projects, humanId]);
  /** Adds the agent to the chat first when it is a pinned one not in it yet (manage rights); false when it could not. */
  const ensureAgent = useCallback(async (channelId: string, agent: string): Promise<boolean> => {
    if (peopleRef.current.some(p => p.subscriberType === 'AGENT' && p.subscriberId === agent)) return true;
    const by = humanRef.current;
    if (!canAddTo(channelId)) { say(CANT_ADD); return false; }
    const card = cardFor(channelId);
    try {
      const fresh = await addChatMember({channelId, projectId: card?.access === 'open' ? card.projectId : projects.find(p => p.channelId === channelId)?.id ?? null,
        member: {subscriberType: 'AGENT', subscriberId: agent}, fetch: apiFetch, fetchJson: apiJson});
      return settle(fresh, by);
    } catch { if (humanRef.current === by) say(`Could not add ${agent}. Try again.`); return false; }
  }, [canAddTo, projects, settle, say]);
  const saveSchedule = useCallback(async (draft: ScheduleDraft, opened: ScheduleView | null): Promise<boolean> => {
    const pop = schedPopRef.current;
    if (!pop) return false;
    const {channelId} = pop;
    const current = pop.scheduleId ? schedulesRef.current.find(s => s.id === pop.scheduleId) : null;
    if (pop.scheduleId && !current) return false;
    if (!await ensureAgent(channelId, draft.agent)) return false;
    // Only what the person changed since the popover opened: someone else's edit in the meantime stays.
    const base = opened ?? current;
    try {
      const saved = current && base
        ? await patchSchedule(current.id, {
          ...(draft.prompt !== base.prompt ? {prompt: draft.prompt} : {}),
          ...(draft.agent !== base.agent ? {agent: draft.agent} : {}),
          ...(JSON.stringify(draft.rule) !== JSON.stringify(base.rule) ? {rule: draft.rule} : {}),
        }, current.version)
        : await createSchedule({id: pop.newId, channelId, agent: draft.agent, prompt: draft.prompt, rule: draft.rule, timezone: browserZone()});
      if (schedPopRef.current === pop) setSchedPop(null);
      say(scheduledToast(saved.rule, saved.nextAt, Date.now()));
      flows.refresh();
      return true;
    } catch (error) {
      say(flowError(error, 'Could not save the schedule. Try again.'));
      return false;
    }
  }, [ensureAgent, say, flows.refresh]);
  /**
   * The Webhook kind's save. A new webhook keeps the popover open on its URL, shown once with Copy (the URL lives only in
   * this state, never in storage or logs); an edit closes it.
   */
  const saveWebhook = useCallback(async (draft: WebhookDraft, opened: TriggerView | null): Promise<boolean> => {
    const pop = schedPopRef.current;
    if (!pop) return false;
    const {channelId} = pop;
    const current = pop.triggerId ? triggersRef.current.find(t => t.id === pop.triggerId) ?? pop.created : null;
    if (pop.triggerId && !current) return false;
    if (!await ensureAgent(channelId, draft.agent)) return false;
    try {
      if (current) {
        const base = opened ?? current;
        await patchTrigger(current.id, {
          ...(draft.prompt !== base.prompt ? {prompt: draft.prompt} : {}),
          ...(draft.agent !== base.agent ? {agent: draft.agent} : {}),
          ...(draft.label !== base.label ? {label: draft.label} : {}),
        }, current.version);
        if (schedPopRef.current === pop) setSchedPop(null);
      } else {
        const made = await createTrigger({id: pop.newId, channelId, agent: draft.agent, prompt: draft.prompt, label: draft.label});
        setSchedPop(now => now === pop ? {...pop, triggerId: made.trigger.id, created: made.trigger, url: made.url} : now);
      }
      say(scheduledToast({kind: 'webhook'}, null, Date.now()));
      flows.refresh();
      return true;
    } catch (error) {
      say(flowError(error, 'Could not save the webhook. Try again.'));
      return false;
    }
  }, [ensureAgent, say, flows.refresh]);
  /** Rotate URL: the new URL replaces the masked one, shown once. */
  const rotateWebhook = useCallback(async () => {
    const pop = schedPopRef.current;
    if (!pop?.triggerId) return;
    const id = pop.triggerId;
    try {
      const {url} = await rotateTrigger(id);
      setSchedPop(now => now && now.triggerId === id ? {...now, url} : now);
      flows.refresh();
    } catch (error) { say(flowError(error, 'Could not change the URL. Try again.')); }
  }, [say, flows.refresh]);
  const pauseSchedule = useCallback(async (on: boolean) => {
    const pop = schedPopRef.current;
    const current = pop?.scheduleId ? schedulesRef.current.find(s => s.id === pop.scheduleId) : null;
    const hook = pop?.triggerId ? triggersRef.current.find(t => t.id === pop.triggerId) ?? pop.created : null;
    if (!pop || (!current && !hook)) return;
    try {
      if (current) await patchSchedule(current.id, {on}, current.version);
      else await patchTrigger(hook!.id, {on}, hook!.version);
      if (schedPopRef.current === pop) setSchedPop(null);
      flows.refresh();
    } catch (error) { say(flowError(error, on ? 'Could not resume the schedule. Try again.' : 'Could not pause the schedule. Try again.')); }
  }, [say, flows.refresh]);
  const removeSchedule = useCallback(async () => {
    const pop = schedPopRef.current;
    const current = pop?.scheduleId ? schedulesRef.current.find(s => s.id === pop.scheduleId) : null;
    const hook = pop?.triggerId ? triggersRef.current.find(t => t.id === pop.triggerId) ?? pop.created : null;
    if (!pop || (!current && !hook)) return;
    try {
      if (current) await deleteSchedule(current.id, current.version);
      else await deleteTrigger(hook!.id, hook!.version);
      if (schedPopRef.current === pop) setSchedPop(null);
      say(SCHEDULE_DELETED);
      flows.refresh();
    } catch (error) { say(flowError(error, 'Could not delete the schedule. Try again.')); }
  }, [say, flows.refresh]);
  /** A strip's Run now: posts the run at once; the chat shows `↳ Run started by you`. */
  const runJob = useCallback(async (job: ScheduleJob) => {
    if (!job.schedule) return;
    try { await runScheduleNow(job.schedule.id); } catch (error) { say(flowError(error, 'Could not start the run. Try again.')); } finally { flows.refresh(); }
  }, [say, flows.refresh]);
  // Strips and the Setup chip for the open chat. Run now needs the right to manage it and to post here; Edit follows the
  // server (canEdit or canManage, read-only settings without canEdit), so a view-role canvas member gets it only from there.
  const chatJobs = chatShown && chatChannelId ? cardJobs.get(chatChannelId) ?? NO_JOBS : NO_JOBS;
  const chatCanPost = Boolean(chatChannel && chatChannel.canPost !== false && !chatChannel.archivedAt);
  const chatStrips = chatJobs.length ? <>{chatJobs.map(job => scheduleStrip(job, {now: Date.now(), canRun: Boolean(job.schedule?.canManage && chatCanPost), onRunNow: runJob,
    onEdit: job.schedule && (job.schedule.canEdit || job.schedule.canManage) ? (j, anchor) => openSchedule(j.channelId, j.schedule!.id, anchor)
      : job.trigger && (job.trigger.canEdit || job.trigger.canManage) ? (j, anchor) => openSchedule(j.channelId, null, anchor, j.trigger!.id) : undefined}))}</> : null;
  // The header's clock: anyone who can post in the chat, except a view-role member of this canvas (T7-R1).
  const chatSchedule = flowsOn && chatShown && chatChannelId && board && board.canvas.role !== 'view' && chatCanPost
    ? (anchor: HTMLElement) => openSchedule(chatChannelId, null, anchor) : undefined;
  const chatAgents = chatPeople.filter(p => p.subscriberType === 'AGENT' && !isServiceAgent(p.subscriberId, service)).map(p => p.subscriberId);
  const chatOnBoard = openCard?.access === 'open';
  const chatSetup = flowsOn && chatShown && chatChannelId ? <ChatSetup key={chatChannelId} channelId={chatChannelId} loose={!chatOnBoard} links={setupLinks}
    agents={chatAgents} viewer={humanId} schedules={chatStrips} scheduleChip={setupChip(chatJobs)}
    onConnect={canLink ? anchor => openLinkPick(chatChannelId, anchor) : undefined} onOpenLink={openChatLink}/> : null;
  const chatConnect = canLink && chatOnBoard && chatChannelId ? (anchor: HTMLElement) => openLinkPick(chatChannelId, anchor) : undefined;
  // Where it stands: what in the open chat waits on the person, with Approve / Request changes or Run now in place. A refusal
  // (already decided, the link paused, not theirs to decide) is a toast, and the items are read again.
  const chatNeeds = chatShown && chatChannelId ? cardNeeds.get(chatChannelId) : undefined;
  const {approve: approveNeed, requestChanges, runNow, canDecide} = useDigestActions({say, refreshFlows: flows.refresh, rereadReviews, changeRequests,
    links: setupLinks, projects, humanId, chatNeeds, chatKey: chatShown ? `${chatChannelId}:${chatMode}` : ''});
  const chatDigest = chatNeeds ? <ChatDigest key={`digest:${chatChannelId}`} items={chatNeeds} onApprove={approveNeed} onRequestChanges={requestChanges} onRunNow={runNow} canDecide={canDecide}
    agentLine={agentLine(participantRows({participants: chatPeople, pulse: pulses.get(chatChannelId!), needs: [], viewer: username, service}).find(row => row.kind === 'agent'))}/> : null;
  const flowCards = flowPop?.view && board ? {from: board.cards.find(c => c.channelId === flowPop.view!.from), to: board.cards.find(c => c.channelId === flowPop.view!.to)} : null;
  const agentsOf = (card: BoardCard | undefined) => card?.access === 'open'
    ? card.participants.filter(p => p.subscriberType === 'AGENT' && !isServiceAgent(p.subscriberId, service)).map(p => p.subscriberId) : [];
  // Access lost: say so, open the menu on what is left, and stay put (no redirect, so no loop).
  const gone = state.status === 'gone' && state.canvasId === canvasId;
  useEffect(() => {
    if (!gone) return;
    setSwitcherOpen(true);
    void reloadList().catch(() => {});
  }, [gone, reloadList]);
  useEffect(() => { if (switcherOpen) void reloadList().catch(() => {}); }, [switcherOpen, reloadList]);
  useEffect(() => { setSharing(false); }, [canvasId]);

  const schedCount = scheduledCount(canvasJobs);
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
      <PhoneList key={board.canvas.id} board={board} pulses={pulses} loose={shownLoose} titles={titles} projects={projects}
        onOpenChat={openLoose} openChannelId={chatShown ? chatChannelId : null} areaContext={areaContext} onAreaContext={openAreaContext} looseKey={phoneLoose}
        reviews={reviews} flows={flows.needs} onRunNow={runNow} onNeedsShown={setPhoneNeedsOpen}/>
      {humanId ? <div className="canvas-dock"><StartChat key={dockKey} ownerId={humanId} variant="dock" voice schedules={flowsOn} onCreated={created} fileDrop={!chatShown} fileDropAccept={outsideCanvasChat} onFilesDropped={dockFiles}/></div> : null}
    </div>;
  } else {
    // Keyed by canvas so the saved view, gestures and measured card heights start fresh per canvas.
    const canPlace = board.canvas.role !== 'view';
    body = <>
      <div className="canvas-stage">
        <Surface key={board.canvas.id} board={board} humanId={humanId} onApply={applyTracked} pulses={pulses} onNudge={sendNudge}
          onDropChat={canPlace ? dropChat : undefined} controls={controls} onOpenChat={openFromCard} openChannelId={chatShown ? chatChannelId : null}
          onDropAgent={dropAgent} onRemoveAgent={removeAgent} canManageCard={manageable} onSelectCard={setSelectedId} selectedChannelId={selected?.channelId ?? null}
          areaContext={areaContext} onAreaContext={openAreaContext} contextAreaId={panel?.kind === 'area' ? panel.areaId : null} onOpenCanvas={id => onSelectCanvas(id)} onDropFiles={dropFiles}
          needs={cardNeeds} viewer={username} onNotice={say} onAreaCreated={setRenameAreaId} renameAreaId={renameAreaId} onRenameStarted={renameStarted}
          links={shownLinks} onOpenLink={openFlowLink} onToggleFork={toggleFork}
          onNewChat={canPlace ? newChatHere : undefined} onNewChatInArea={canPlace ? newChatInArea : undefined}
          canConnect={canConnect} onConnect={connectCards} onNewStep={canPlace ? dropNewStep : undefined} onLinkPick={openLinkPick} schedules={flowsOn ? cardJobs : undefined}/>
        <AgentTray suggested={tray.suggested} pinned={tray.pinned} pins={shownPins} pinsReady={pins !== null} onTogglePin={toggle}
          agents={roster} humanId={humanId} owners={owners} busy={busy} cards={board.cards} areas={board.areas} open={pickerOpen} onOpenChange={showPicker}/>
        {/* Files dropped on empty canvas start a chat here, beside a split chat or chat windows too; a window takes the drops on itself. */}
        {humanId ? <div className="canvas-dock"><StartChat key={dockKey} ownerId={humanId} variant="dock" voice schedules={flowsOn} onCreated={created} fileDrop
          fileDropAccept={outsideCanvasChat} fileDropOverlay={false} onFilesDropped={dockFiles}/></div> : null}
        {fileDrag ? <p className="canvas-file-hint" role="status">{board.canvas.role === 'view' ? FILE_DRAG_HINT_VIEW : FILE_DRAG_HINT}</p> : null}
      </div>
    </>;
  }

  return <section ref={viewRoot} className="canvas-view" aria-label="Canvas">
    <WorkspaceTopbar onMenu={onMenu} search={canvasId ? <div className="canvas-tools">
      {/* On phones Needs you is a segment of the list instead. */}
      {phone ? null : <NeedsYou pulses={pulses} titles={titles} projects={projects} reviews={reviews} flows={flows.needs} onRunNow={runNow} onOpenChange={setNeedsOpen} onJump={jumpTo}/>}
      {/* Top-bar labels collapse to their icons as the bar narrows (canvas.css); the text stays as the name. */}
      {flowsOn && board ? <button type="button" className="canvas-search-button canvas-sched-button" title="Scheduled jobs on this canvas" aria-haspopup="dialog"
        aria-expanded={Boolean(schedList)} onClick={event => { const button = event.currentTarget; setSchedPop(null); setSchedList(current => current ? null : button); }}>
        <ClockIcon/><span className="canvas-bar-label">Scheduled</span><span className={`cnt${schedCount.hot ? ' hot' : ''}`}>{schedCount.text}</span>
      </button> : null}
      <button type="button" className="canvas-search-button" title="Search the canvas (Ctrl+K)" onClick={() => setSearchOpen(true)}>
        <Search size={16} aria-hidden="true"/><span className="canvas-bar-label">Search</span>
      </button>
    </div> : undefined} leading={canvasId ? <div className="canvas-heading">
      <h1 className="canvas-name" title={name}>{name}</h1>
      <CanvasSwitcher canvases={canvases ?? []} current={current} open={switcherOpen} onOpenChange={setSwitcherOpen}
        onSelect={id => onSelectCanvas(id)} onCreate={createNew} onRename={rename} onDelete={remove}/>
      {board && board.canvas.role === 'owner' ? <button type="button" className="canvas-share-button canvas-share-open" title="Share this canvas" onClick={() => setSharing(true)}>
        <Share2 size={16} aria-hidden="true"/><span className="canvas-bar-label">Share</span>
      </button> : null}
      {board ? <button type="button" className={`canvas-share-button canvas-context-button${contextSummary?.canvas.hasContext ? ' has-context' : ''}`}
        aria-haspopup="dialog" aria-expanded={panel?.kind === 'canvas'} title={`Canvas context: notes and files every chat on ${board.canvas.name} can see`}
        onClick={event => openPanel({kind: 'canvas'}, event.currentTarget)}>
        {/* Narrower windows show the mock's shorter `Context`; the name stays `Canvas context`. */}
        <FileText size={16} aria-hidden="true"/>
        {/* One flex item, so the label and count read as one line. */}
        <span><span className="canvas-context-long">Canvas context</span><span className="canvas-context-short" aria-hidden="true">Context</span>{contextSummary?.canvas.hasContext ? <span className="canvas-context-count"> · {contextLabel(contextSummary.canvas)}</span> : null}</span>
      </button> : null}
      {board ? <LooseToggle count={shownLoose.length} hot={looseHot} open={phone ? undefined : drawerOpen} controls={drawerId} onClick={toggleDrawer} buttonRef={looseButton}/> : null}
      {ownerName ? <span className="canvas-shared-by">Shared by {ownerName}</span> : null}
    </div> : undefined}/>
    {searchOpen && canvasId ? <CanvasSearch items={index} onClose={() => setSearchOpen(false)} onChoose={choose}/> : null}
    <div className={`canvas-body${chatShown ? ` has-chat is-${chatMode}` : ''}`}>
      {sharing && board && board.canvas.role === 'owner' ? <ShareDialog canvasId={board.canvas.id} ownerId={board.canvas.ownerId} humans={humans}
        version={canvasVersion} freshVersion={freshVersion} onSaved={() => { void store.refresh({force: true}); void reloadList().catch(() => {}); }} onClose={() => setSharing(false)}/> : null}
      <CanvasMain inert={chatShown && chatMode === 'focus' && phone}>
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
      {/*
        * Over the left of the canvas, which keeps its full width. Outside the canvas side, so a phone's full-screen chat
        * does not make it inert with it; chat windows sit above it. A press on the canvas leaves it open: it is not a
        * popover.
        */}
      {board && !phone ? <LooseDrawer id={drawerId} open={drawerOpen} chats={loose} count={shownLoose.length} hidden={hidden} showHidden={showHidden} onShowHidden={setShowHidden}
        canPlace={board.canvas.role !== 'view'} draggable onNewArea={newArea} onArchive={hide} onClose={closeDrawer} now={Date.now}
        onOpenChat={openLoose} highlight={highlight} focusKey={drawerFocus}/> : null}
      {chatShown ? <CanvasChat key={chatChannelId} channelId={chatChannelId!} mode={chatMode!}
        win={windowed && floating?.win.channelId === chatChannelId ? floating.win : undefined} bounds={floating?.bounds} onMove={moveFloating} title={chatTitle} sub={chatSub} area={chatArea} onPlace={placeHere} onUseHere={useHere}
        digest={chatDigest} setup={chatSetup} onConnect={chatConnect} onSchedule={chatSchedule}
        announce={memberNotice && board ? {id: memberNotice.id, text: memberNotice.text} : state.notice && state.canvasId === canvasId ? {id: `store:${state.notice}`, text: state.notice} : null}
        onMode={mode => onOpenChat(chatChannelId!, mode)} onClose={() => onCloseChat()} onOpenRegular={() => onOpenRegular(chatChannelId!)}>
        {chat}
      </CanvasChat> : null}
      {panel && board ? <ContextPanel key={`${board.canvas.id}:${panel.kind === 'area' ? panel.areaId : 'canvas'}`} canvasId={board.canvas.id}
        canvasName={board.canvas.name} scope={panel.kind === 'area' ? {kind: 'area', areaId: panel.areaId} : {kind: 'canvas'}} anchor={panel.anchor}
        title={panel.kind === 'area' ? board.areas.find(a => a.id === panel.areaId)?.title : undefined}
        canEdit={board.canvas.role !== 'view'} dropped={areaFiles?.areaId === (panel.kind === 'area' ? panel.areaId : null) ? areaFiles : null} holdsChat={panel.kind === 'canvas' ? board.cards.length > 0 : board.cards.some(card => areaFor(cardCentre(card), board.areas)?.id === panel.areaId)}
        onViewOnlyDrop={() => say(VIEW_ONLY_FILES)} onChanged={() => loadSummary(board.canvas.id)} onClose={() => setPanel(null)}/> : null}
      {linkPick && pickFrom && board ? <LinkPicker key={`pick:${linkPick.from}`} from={pickFrom} cards={board.cards} areas={board.areas} links={board.links} service={service}
        anchor={linkPick.anchor} onPick={to => void connect(linkPick.from, to)} onNewStep={board.canvas.role !== 'view' ? () => pickNewStep(linkPick.from) : undefined}
        onClose={closeLinkPick}/> : null}
      {flowPop?.view && board ? <HandoffPopover key={flowPop.linkId} link={flowPop.view} fromTitle={flowPop.view.fromTitle} toTitle={flowPop.view.toTitle}
        fromAgent={agentsOf(flowCards?.from)[0] ?? null} candidates={flowCards?.to?.access === 'open' ? agentsOf(flowCards.to) : flowPop.view.who ? [flowPop.view.who] : []}
        pinned={shownPins} anchor={flowPop.anchor} editable={flowPop.view.canEdit && board.canvas.role !== 'view'}
        onChange={changeFlow} onLabelDraft={draftFlowLabel} onDisconnect={disconnectFlow} onSendNow={sendFlow} onClose={closeFlowPop}/> : null}
      {schedPop && !schedPopStale && board ? <SchedulePopover key={`${schedPop.channelId}:${schedPop.key}`} chat={{channelId: schedPop.channelId, title: chatTitle}}
        schedule={popSchedule} trigger={popTrigger} webhooks={flows.availability?.webhooks === true} url={schedPop.url}
        agents={chatAgents} pinned={shownPins.filter(name => !isServiceAgent(name, service))} timezone={browserZone()} anchor={schedPop.anchor} now={Date.now}
        onSave={saveSchedule} onSaveWebhook={saveWebhook} onRotate={rotateWebhook}
        onPause={(popSchedule ?? popTrigger)?.canManage ? pauseSchedule : undefined} onDelete={(popSchedule ?? popTrigger)?.canManage ? removeSchedule : undefined} onClose={closeSchedPop}/> : null}
      {schedList && board && flowsOn ? <ScheduledList canvasName={board.canvas.name} jobs={canvasJobs} titles={titles} onCanvas={boardIds} anchor={schedList} now={Date.now}
        onGoto={channelId => { setSchedList(null); jumpTo(channelId); }} onClose={() => setSchedList(null)}/> : null}
    </div>
  </section>;
}

/**
 * The canvas side of the body. Chat windows leave it fully live (pointer, keyboard and screen readers). Behind a phone's
 * full-screen chat it is inert. A layout effect, so that is gone before the closing chat's passive cleanup moves focus
 * back here.
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

/** Where chat windows may sit, relative to `.canvas-body` (the chat's positioned parent): the stage with 16 px gutters, above the bottom box. */
function windowFrame(body: HTMLElement) {
  const b = body.getBoundingClientRect(), stage = body.querySelector('.canvas-stage')?.getBoundingClientRect() ?? b;
  const dock = body.querySelector('.canvas-dock')?.getBoundingClientRect();
  return {body: b, stage, bounds: stageBounds({w: stage.width, h: stage.height}, dock?.height ? dock.top - stage.top : null, {x: stage.left - b.left, y: stage.top - b.top})};
}

const SPLIT_STEP = 2;
/** Another dialog above the chat (manage channel, the tour) takes Escape and Tab for itself, and so does an open context popover. */
const OTHER_DIALOG = '[aria-modal="true"]:not(.canvas-chat), .dialog-backdrop, .canvas-context, .canvas-flow-pop';
/** What a press on a window's header may start a drag from: anything but its controls. */
const NOT_A_HANDLE = 'button, a, input, select, textarea, label, [contenteditable="true"], .canvas-chat-menu';
const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"]), [contenteditable="true"]';

/** A sheet's height while it opens (its CSS min-height): the camera centres at least this much. */
const SHEET_OPEN_HEIGHT = 440;
/**
 * The open chat: a window over the canvas (focus; a phone's fills the body), or on the right with a draggable divider (split).
 * The header holds Split screen, Open in the regular chat view and Close; the chat itself is App's chat workspace.
 */
/** `onCanvas`: a loose chat that can also be placed outside any area (`No area (on the canvas)`). */
type ChatArea = {areas: {id: string; title: string}[]; current: string | null; placed: boolean; onCanvas: boolean; onMove(areaId: string | null): void};
/** The Area picker's value for `No area (on the canvas)`: never an area id, which are UUIDs. */
const ON_CANVAS = 'canvas';
/** Who is in the open chat, and where its card sits and which context it reads. */
type ChatSub = {
  /** `service`: the Switchyard agent, which posts hand-offs and scheduled runs and never replies. */
  people: {agent: boolean; name: string; service?: boolean}[];
  /** An archived or read-only chat says so here (the regular view's header line, which the sheet leaves out). */
  state?: 'Archived' | 'Read-only';
  place: {kind: 'loose'} | {kind: 'card'; area: string | null; sees: ChatSees};
  /** Opens the context the chat sees (its home area's, or the canvas's) under the pressed control. */
  onSees(areaId: string | null, opener: HTMLElement): void;
};
const MAX_SUB_FACES = 5;
const CHAT_CONNECT_TITLE = 'Connect: pass results to another chat';
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
        ? <span key={`a:${person.name}`} className="canvas-chat-face" title={person.service ? `${person.name} · posts hand-offs and scheduled runs; never replies` : person.name}><AgentAvatar name={person.name} size={20}/></span>
        : <span key={`h:${person.name}`} className="canvas-chat-face is-human" title={person.name} aria-hidden="true">{initials(person.name)}</span>)}
      {more ? <span className="canvas-chat-face is-more" aria-hidden="true">+{more}</span> : null}
    </span> : null}
    <span>{where}{sees ? ' · ' : ''}</span>{sees}
    {sub.state ? <span className="canvas-chat-state"> · {sub.state}</span> : null}
  </p>;
}

function CanvasChat({channelId, mode, win, bounds, onMove, onActivate, zIndex, title, sub, area, onPlace, onUseHere, digest, setup, announce, onConnect, onSchedule, onMode, onClose, onOpenRegular, children}: {
  channelId: string; mode: CanvasChatMode;
  /** A desktop focus chat: a window at this top-left (relative to `.canvas-body`), sized from `bounds`. Phones and split screen have none. */
  win?: ChatWindow; bounds?: Bounds;
  /** Dragging the window's header asks for this top-left; the owner clamps it to the bounds. */
  onMove?(at: Point): void;
  /** A press anywhere in the window. */
  onActivate?(): void;
  zIndex?: number;
  title: string; sub?: ChatSub; area?: ChatArea; onPlace?(): void; onUseHere?(): Promise<void>;
  /** Where it stands, above the Setup line (the mock's digest before cfgBlock). */
  digest?: ReactNode;
  /** The Setup line, at the top of the chat body. */
  setup?: ReactNode;
  /**
   * The canvas's newest notice. A phone's full-screen chat makes the canvas behind it inert, notices included, so it
   * carries its own live region that says it too (a window leaves the canvas's own notices readable).
   */
  announce?: {id: number | string; text: string} | null;
  /** A chat on this canvas, with hand-offs set up: the header's connect button opens the chat picker under it. */
  onConnect?(anchor: HTMLElement): void;
  /** Flows set up and the person may schedule here: the header's clock opens the schedule popover under it (loose chats too). */
  onSchedule?(anchor: HTMLElement): void;
  onMode(mode: CanvasChatMode): void; onClose(): void; onOpenRegular(): void; children: ReactNode;
}) {
  const panel = useRef<HTMLElement>(null);
  const [split, setSplit] = useState(readSplit);
  const splitRef = useRef(split); splitRef.current = split;
  const resizing = useRef<number | null>(null);
  const closeRef = useRef(onClose); closeRef.current = onClose;
  const modeRef = useRef(mode); modeRef.current = mode;
  const windowed = Boolean(win);
  const winRef = useRef(win); winRef.current = win;
  const moveRef = useRef(onMove); moveRef.current = onMove;
  // The header drags a window: the pointer's travel since the press, from where the window was, clamped by the owner.
  const drag = useRef<{id: number; x: number; y: number; from: Point} | null>(null);

  // Tab stays inside a phone's full-screen chat (the canvas behind it is inert). It acts only when focus is in the chat,
  // on the page body or in the canvas: focus in any other dialog or portal (the Huddle, Manage channel, a popover) is that
  // dialog's to move, and is never pulled back here. A desktop window traps nothing: the canvas stays usable.
  useEffect(() => {
    if (mode !== 'focus' || windowed) return;
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
  }, [mode, windowed]);

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

  // Escape closes a focus chat, after any inner popup (the mention picker) has had it. A window closes only while focus is
  // in it or on the page body: Escape elsewhere on the live canvas (a card, the tray, the drawer) is theirs.
  useEffect(() => {
    if (mode !== 'focus') return;
    const key = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || document.querySelector(OTHER_DIALOG)) return;
      const active = document.activeElement;
      if (windowed && active && active !== document.body && !panel.current?.contains(active)) return;
      event.preventDefault();
      closeRef.current();
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [mode, windowed]);

  const resizeTo = (clientX: number) => {
    const body = panel.current?.parentElement?.getBoundingClientRect();
    if (body) setSplit(splitAt(clientX, {left: body.left, width: body.width}));
  };
  const finish = () => { if (resizing.current === null) return; resizing.current = null; writeSplit(splitRef.current); };
  const nudge = (delta: number) => { const next = clampSplit(splitRef.current + delta); setSplit(next); writeSplit(next); };

  const endDrag = () => { drag.current = null; };

  const focus = mode === 'focus';
  const sheet = focus && win && bounds ? {...windowVars(win, bounds), ...(zIndex === undefined ? {} : {zIndex})} as CSSProperties : undefined;
  return <section ref={panel} className="canvas-chat" data-mode={mode} data-window={windowed ? 'true' : undefined} tabIndex={-1}
    role={focus ? 'dialog' : 'region'} aria-modal={focus && !windowed ? true : undefined} aria-label={`Open chat ${title}`}
    style={focus ? sheet : {width: `${split}%`}} onPointerDownCapture={windowed ? onActivate : undefined}>
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
    <header className="canvas-chat-bar" onPointerDown={windowed ? event => {
      // Only presses on the header's own DOM: a dialog portaled from its slots (the Huddle) bubbles here through React too.
      const at = winRef.current, target = event.target;
      if (event.button !== 0 || !at || !moveRef.current || !(target instanceof Element) || !event.currentTarget.contains(target) || target.closest(NOT_A_HANDLE)) return;
      // No text selection while dragging. That also skips the press's own focus change, so focus moves into the window
      // here (unless it is already inside), and Escape then closes the window that was just dragged.
      event.preventDefault();
      if (!panel.current?.contains(document.activeElement)) panel.current?.focus({preventScroll: true});
      drag.current = {id: event.pointerId, x: event.clientX, y: event.clientY, from: {x: at.x, y: at.y}};
      try { event.currentTarget.setPointerCapture(event.pointerId); } catch {}
    } : undefined}
      onPointerMove={windowed ? event => {
        const d = drag.current;
        if (d?.id === event.pointerId) moveRef.current?.({x: d.from.x + event.clientX - d.x, y: d.from.y + event.clientY - d.y});
      } : undefined}
      onPointerUp={windowed ? endDrag : undefined} onPointerCancel={windowed ? endDrag : undefined} onLostPointerCapture={windowed ? endDrag : undefined}>
      <div className="canvas-chat-heading">
        <h2 className="canvas-chat-title">{title}</h2>
        {sub ? <ChatSubline sub={sub}/> : null}
      </div>
      <div className="canvas-chat-actions">
        <button type="button" className="canvas-chat-icon" aria-label="Split screen" aria-pressed={!focus}
          title={focus ? 'Split screen: the chat on the right, the canvas stays usable' : 'Float over the canvas instead'}
          onClick={() => onMode(focus ? 'split' : 'focus')}><Columns2 size={16} aria-hidden="true"/></button>
        {onSchedule ? <button type="button" className="canvas-chat-icon canvas-chat-clock" aria-label={SCHEDULE_TITLE} title={SCHEDULE_TITLE}
          aria-haspopup="dialog" onClick={event => onSchedule(event.currentTarget)}><ClockIcon/></button> : null}
        {onConnect ? <button type="button" className="canvas-chat-icon canvas-chat-connect" aria-label={CHAT_CONNECT_TITLE} title={CHAT_CONNECT_TITLE}
          aria-haspopup="dialog" onClick={event => onConnect(event.currentTarget)}><LinkIcon/></button> : null}
        <span ref={setActionsSlot} className="canvas-chat-slot"/>
        <button type="button" className="canvas-chat-icon" aria-label="Open in the regular chat view" title="Open in the regular chat view"
          onClick={onOpenRegular}><SquareArrowOutUpRight size={16} aria-hidden="true"/></button>
        <div ref={menuRef} className="canvas-chat-more">
          <button ref={menuButton} type="button" className="canvas-chat-icon" aria-label="More chat actions" title="More: area, sharing and export"
            aria-expanded={menu} aria-controls={menuId} onClick={() => setMenu(open => !open)}><Ellipsis size={16} aria-hidden="true"/></button>
          <div id={menuId} className="canvas-chat-menu" role="group" aria-label="More chat actions" hidden={!menu}>
            {area ? <label className="canvas-chat-area">
              <span>Area</span>
              <select value={area.current ?? ''} onChange={event => { setMenu(false); area.onMove(event.target.value === ON_CANVAS ? null : event.target.value || null); }}>
                <option value="" disabled={!area.placed}>{area.placed ? 'No area' : 'Not on this canvas'}</option>
                {area.areas.map(option => <option key={option.id} value={option.id}>{option.title || 'Untitled area'}</option>)}
                {/* Last, so a first arrow press (which commits on Windows and Linux) never lands on it. */}
                {!area.placed && area.onCanvas ? <option value={ON_CANVAS}>No area (on the canvas)</option> : null}
              </select>
            </label> : null}
            {onPlace ? <button type="button" className="canvas-chat-menu-item" title="Put this chat on the canvas at the centre of the view"
              onClick={() => { setMenu(false); menuButton.current?.focus({preventScroll: true}); onPlace(); }}>Place on canvas</button> : null}
            {onUseHere ? <button type="button" className="canvas-chat-menu-item" onClick={() => void onUseHere()}>Use this area's context</button> : null}
            <span ref={setMoreSlot} className="canvas-chat-slot"/>
          </div>
        </div>
        <button type="button" className="canvas-chat-icon canvas-chat-close" aria-label="Close" title="Close" onClick={onClose}><X size={16} aria-hidden="true"/></button>
      </div>
    </header>
    <ChatHeaderSlotsContext.Provider value={slots}>
      <div className="canvas-chat-body">{digest}{setup}{children}</div>
      {focus && !windowed ? <div className="canvas-visually-hidden canvas-chat-announce" role="status">{announce ? <span key={announce.id}>{announce.text}</span> : null}</div> : null}
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
