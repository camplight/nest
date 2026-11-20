// Loose chats: the top-bar toggle and the drawer it opens over the left of the canvas (the mock's `#loose-btn` and
// `.drawer`). The person's chats that are not on this canvas, in day groups, with search, an agent filter, Needs you /
// Working / Done chips, multi-select, New area from these and Archive, and drag onto the surface. The list is windowed
// by hand: fixed-height headers and rows, and only those in view (plus a few) are in the DOM.
import {memo,useCallback,useEffect,useId,useLayoutEffect,useMemo,useRef,useState,type DragEvent as ReactDragEvent,type MouseEvent as ReactMouseEvent,type Ref} from 'react';
import {GalleryVerticalEnd} from 'lucide-react';
import {AgentAvatar} from '../components/AgentAvatar';
import {ago,shortAgo} from './Card';
import {DRAWER_GROUP_HEIGHT,DRAWER_ROW_HEIGHT,drawerLayout,filterLoose,looseCounts,type DrawerItem,type LooseChat,type LooseStateFilter} from './loose';
import {CHAT_DRAG_TYPE} from './Surface';

/** Rows (in pixels) kept mounted above and below the visible part of the list. */
const OVERSCAN = 4 * DRAWER_ROW_HEIGHT;
/** Before the list is measured: enough for a tall drawer, still far below 40 rows. */
const FALLBACK_HEIGHT = 720;
/** Bulk endpoints take at most 100 channel ids per call. */
export const MAX_BULK = 100;
const CHIPS: {value: LooseStateFilter; label: string}[] = [
  {value: 'all', label: 'All'}, {value: 'need', label: 'Needs you'}, {value: 'working', label: 'Working'}, {value: 'done', label: 'Done'},
];
/**
 * Open things that take Escape before the drawer: another dialog, a popover or menu, the canvas search, the agent
 * picker, the Needs you list and an armed Area tool.
 */
const DRAWER_YIELDS = '[aria-modal="true"]:not(.canvas-chat), [data-file-viewer], .dialog-backdrop, .canvas-context, .canvas-chat-menu:not([hidden]), .canvas-menu, .canvas-picker, .canvas-needs-panel, .canvas-tool[aria-pressed="true"]';
/**
 * Whether the open chat takes this Escape before the drawer: a phone's full-screen chat always; a desktop chat window
 * only while focus is in it or on the page body (or nowhere), the same rule the window closes by. Otherwise Escape with
 * focus on the canvas would reach neither.
 */
export function chatTakesEscape(chat: {matches(selector: string): boolean; contains(node: unknown): boolean} | null, active: unknown, body: unknown): boolean {
  if (!chat) return false;
  if (!chat.matches('[data-window="true"]')) return true;
  return !active || active === body || chat.contains(active);
}
const typing = (element: Element) => element instanceof HTMLElement && (element.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(element.tagName));

/**
 * The top-bar button: `Loose chats {n}`, the count coral while any loose chat needs the person. Phones show the icon and
 * count, and have no drawer (`open` undefined): there it selects the phone list's Loose chats segment.
 */
export function LooseToggle({count, hot, open, controls, onClick, buttonRef}: {
  count: number; hot: boolean; open?: boolean; controls: string; onClick(): void; buttonRef?: Ref<HTMLButtonElement>;
}) {
  return <button ref={buttonRef} type="button" className="canvas-share-button canvas-loose-button" aria-expanded={open} aria-controls={open ? controls : undefined}
    title="Plain chats that aren't on the canvas yet" onClick={onClick}>
    <GalleryVerticalEnd size={16} aria-hidden="true"/>
    <span className="canvas-loose-label">Loose chats</span>{' '}
    <span className={`canvas-loose-count${hot ? ' is-hot' : ''}`} data-hot={hot || undefined}>{count}</span>
    {hot ? <span className="canvas-visually-hidden">, some need you</span> : null}
  </button>;
}

export type LooseDrawerProps = {
  /** The drawer's element id, for the toggle's aria-controls. */
  id: string;
  open: boolean;
  /** Loose chats, newest first; archived (hidden) ones are included only while Show archived is on. */
  chats: LooseChat[];
  /** How many loose chats are not archived: the header count. */
  count: number;
  hidden: ReadonlySet<string>;
  showHidden: boolean;
  onShowHidden(show: boolean): void;
  /** Viewers of a shared canvas cannot place cards; they can still archive chats for themselves. */
  canPlace: boolean;
  /** Rows drag onto the surface (not on phones, which have none). */
  draggable: boolean;
  onNewArea(channelIds: string[]): Promise<boolean>;
  /** The spec's "archive (hide)": a personal hide from loose chats, never an engine archive. */
  onArchive(channelIds: string[], archived: boolean): Promise<boolean>;
  /** ✕ or Escape. `returnFocus` when focus was in the drawer, so it goes back to the toggle. */
  onClose(returnFocus: boolean): void;
  now(): number;
  /** Clicking a row opens that chat in focus. */
  onOpenChat?(channelId: string): void;
  /** A chat to point out (a jump from Needs you or search): filters clear and the list scrolls to it. `n` repeats a jump. */
  highlight?: {id: string; n: number} | null;
  /** Changes each time the toggle opens the drawer; focus then moves to the search field. */
  focusKey: number;
};

type RowProps = {
  chat: LooseChat; index: number; top: number; selected: boolean; hidden: boolean; draggable: boolean; now: number; size: number; highlighted: boolean;
  onOpenChat?(channelId: string): void;
  /** What a drag of this row carries: every selected chat when this row is one of them, else just this one. */
  dragIds(channelId: string): string[];
  onToggle(index: number, channelId: string, checked: boolean, range: boolean): void;
  onUnhide(channelId: string): void;
};
const Row = memo(function Row({chat, index, top, selected, hidden, draggable, now, size, highlighted, onOpenChat, dragIds, onToggle, onUnhide}: RowProps) {
  const drag = draggable && !hidden;
  const start = (event: ReactDragEvent<HTMLLIElement>) => {
    const ids = dragIds(chat.channelId);
    event.dataTransfer.setData(CHAT_DRAG_TYPE, ids.join('\n'));
    event.dataTransfer.setData('text/plain', ids.length > 1 ? `${ids.length} chats` : chat.title);
    event.dataTransfer.effectAllowed = 'move';
  };
  const title = chat.title || 'Untitled chat';
  // A press anywhere on the row opens it, except on its checkbox and buttons. The title area is a focusable
  // role="button" element rather than a <button>: Firefox starts no drag from a <button> inside a draggable row.
  const press = (event: ReactMouseEvent<HTMLLIElement>) => {
    if (!onOpenChat || (event.target instanceof Element && event.target.closest('input, button'))) return;
    onOpenChat(chat.channelId);
  };
  const text = <>
    <span className="canvas-drawer-title">{title}</span>
    {chat.reason !== null ? <span className="canvas-drawer-line is-hot">Needs you: {chat.reason}</span>
      : <span className="canvas-drawer-line">{chat.line}</span>}
  </>;
  return <li className="canvas-drawer-row" style={{transform: `translateY(${top}px)`}} aria-setsize={size} aria-posinset={index + 1}
    data-channel-id={chat.channelId} data-selected={selected || undefined} data-hidden={hidden || undefined} data-highlight={highlighted || undefined}
    title={onOpenChat ? drag ? 'Click to open · drag onto the canvas to place' : 'Click to open' : undefined}
    draggable={drag} onDragStart={drag ? start : undefined} onClick={press}>
    <input type="checkbox" className="canvas-drawer-check" aria-label={`Select ${title}`} checked={selected}
      onClick={(event: ReactMouseEvent<HTMLInputElement>) => onToggle(index, chat.channelId, event.currentTarget.checked, event.shiftKey)}
      onChange={() => {}}/>
    {chat.agents[0] ? <span className="canvas-drawer-face" aria-hidden="true"><AgentAvatar name={chat.agents[0]} size={26}/></span> : null}
    {onOpenChat ? <span role="button" tabIndex={0} className="canvas-drawer-main canvas-drawer-open" onKeyDown={event => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      if (!event.repeat) onOpenChat(chat.channelId);
    }}>{text}</span>
      : <span className="canvas-drawer-main">{text}</span>}
    {chat.lastActivityAt !== null ? <span className="canvas-drawer-time" title={`Active ${ago(chat.lastActivityAt, now)}`}>
      <span className="canvas-visually-hidden">Active {ago(chat.lastActivityAt, now)}</span><span aria-hidden="true">{shortAgo(chat.lastActivityAt, now)}</span>
    </span> : null}
    {hidden ? <button type="button" className="canvas-drawer-unhide" onClick={() => onUnhide(chat.channelId)}>Unarchive</button> : null}
  </li>;
});

export function LooseDrawer({id, open, chats, count, hidden, showHidden, onShowHidden, canPlace, draggable, onNewArea, onArchive, onClose, now, onOpenChat, highlight = null, focusKey}: LooseDrawerProps) {
  const [query, setQuery] = useState('');
  const [state, setState] = useState<LooseStateFilter>('all');
  const [agent, setAgent] = useState<string | null>(null);
  const [olderOpen, setOlderOpen] = useState(false);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const limitId = useId();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const anchor = useRef<number | null>(null);
  const root = useRef<HTMLElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [height, setHeight] = useState(0);

  // Day groups and ages move by the minute, so rows re-render at most once a minute for time alone.
  const minute = Math.floor(now() / 60_000), time = minute * 60_000;
  const filtered = useMemo(() => filterLoose(chats, {query, state, agent}), [chats, query, state, agent]);
  // Older folds behind Show only in the plain list: no search, the All chip and every agent.
  const foldOlder = !query.trim() && state === 'all' && agent === null;
  const layout = useMemo(() => drawerLayout(filtered, time, foldOlder, olderOpen), [filtered, time, foldOlder, olderOpen]);
  const rowsRef = useRef(layout.rows); rowsRef.current = layout.rows;
  // The chips count what the header counts: archived chats are listed under Show archived but never counted.
  const counts = useMemo(() => looseCounts(chats.filter(chat => !hidden.has(chat.channelId))), [chats, hidden]);
  const agents = useMemo(() => [...new Set(chats.flatMap(c => c.agents))].sort((a, b) => a.localeCompare(b)), [chats]);
  // Selection only counts chats still listed: placed or archived ones drop out of it.
  const picked = useMemo(() => layout.rows.filter(c => selected.has(c.channelId)).map(c => c.channelId), [layout.rows, selected]);
  useEffect(() => { anchor.current = null; }, [query, state, agent, showHidden, olderOpen]);
  const pickedRef = useRef(picked); pickedRef.current = picked;
  // Dragging a selected row carries the whole selection (up to the bulk limit); any other row goes alone.
  const dragIds = useCallback((channelId: string) => {
    const all = pickedRef.current;
    return all.includes(channelId) && all.length > 1 && all.length <= MAX_BULK ? all : [channelId];
  }, []);

  useLayoutEffect(() => {
    const element = listRef.current;
    if (!element) return;
    // Each open is a new list element at the top (as the mock re-renders it); the offset kept from the last open must
    // not window rows that are no longer in view.
    element.scrollTop = 0;
    setScrollTop(0);
    const read = () => setHeight(element.clientHeight);
    read();
    const watch = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(read);
    watch?.observe(element);
    return () => watch?.disconnect();
  }, [open]);
  // Opened from the toggle: focus goes to the search field.
  const focused = useRef(focusKey);
  useEffect(() => {
    if (!open || focused.current === focusKey) return;
    focused.current = focusKey;
    search.current?.focus({preventScroll: true});
  }, [open, focusKey]);

  // A narrower result can leave the old offset past the end.
  const viewport = height || FALLBACK_HEIGHT;
  const offset = Math.min(scrollTop, Math.max(0, layout.height - viewport));
  const sizeOf = (item: DrawerItem) => item.kind === 'group' ? DRAWER_GROUP_HEIGHT : DRAWER_ROW_HEIGHT;
  const mounted = layout.items.filter(item => item.top + sizeOf(item) >= offset - OVERSCAN && item.top <= offset + viewport + OVERSCAN);

  // A jump to a chat: clear the filters that could hide it (and unfold Older), then scroll it to the middle of the list.
  const pointed = useRef(-1);
  const hiddenRef = useRef(hidden); hiddenRef.current = hidden;
  const showRef = useRef(onShowHidden); showRef.current = onShowHidden;
  useEffect(() => {
    if (!highlight) return;
    pointed.current = -1;
    setQuery(''); setState('all'); setAgent(null); setOlderOpen(true);
    if (hiddenRef.current.has(highlight.id)) showRef.current(true);
  }, [highlight]);
  useEffect(() => {
    if (!highlight || !open || pointed.current === highlight.n || query || state !== 'all' || agent !== null) return;
    const item = layout.items.find(entry => entry.kind === 'row' && entry.chat.channelId === highlight.id);
    if (!item) return;
    pointed.current = highlight.n;
    const target = Math.max(0, item.top - (viewport - DRAWER_ROW_HEIGHT) / 2);
    if (listRef.current) listRef.current.scrollTop = target;
    setScrollTop(target);
  }, [highlight, open, layout, viewport, query, state, agent]);

  // Escape closes the drawer and nothing else in the same press. With focus in the drawer (or on its toggle) it goes
  // first, before an open chat; elsewhere popovers, menus, fields and an active chat window that would take it (focus in
  // it or on the page body) keep Escape, and the drawer closes once focus is on the canvas or nowhere. Captured, so it
  // runs before the window's own.
  const closeRef = useRef(onClose); closeRef.current = onClose;
  useEffect(() => {
    if (!open) return;
    const key = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || document.querySelector(DRAWER_YIELDS)) return;
      const active = document.activeElement;
      const inside = Boolean(active && (root.current?.contains(active) || active.closest(`[aria-controls="${CSS.escape(id)}"]`)));
      if (!inside) {
        if (chatTakesEscape(document.querySelector('.canvas-chat[data-mode="focus"]:not(.is-passive)'), active, document.body)) return;
        if (active && active !== document.body && (!active.closest('.canvas-main') || typing(active))) return;
      }
      event.preventDefault();
      closeRef.current(inside);
    };
    window.addEventListener('keydown', key, true);
    return () => window.removeEventListener('keydown', key, true);
  }, [open, id]);

  const toggle = useCallback((index: number, channelId: string, checked: boolean, range: boolean) => {
    const list = rowsRef.current;
    setSelected(current => {
      const next = new Set(current);
      const from = range && anchor.current !== null ? Math.min(anchor.current, index) : index;
      const to = range && anchor.current !== null ? Math.max(anchor.current, index) : index;
      for (const chat of list.slice(from, to + 1)) if (checked) next.add(chat.channelId); else next.delete(chat.channelId);
      if (!range) { if (checked) next.add(channelId); else next.delete(channelId); }
      return next;
    });
    anchor.current = index;
  }, []);
  async function run(action: () => Promise<boolean>, failure: string, clear = true) {
    if (busy) return;
    setBusy(true); setError('');
    try {
      const ok = await action();
      if (ok && clear) setSelected(new Set());
      if (!ok) setError(failure);
    } catch { setError(failure); } finally { setBusy(false); }
  }
  const tooMany = picked.length > MAX_BULK;
  const placeTitle = !canPlace ? 'You can view this canvas but not change it.' : tooMany ? `Select up to ${MAX_BULK} chats` : undefined;
  const runRef = useRef(run); runRef.current = run;
  const archiveRef = useRef(onArchive); archiveRef.current = onArchive;
  const unhide = useCallback((channelId: string) => void runRef.current(() => archiveRef.current([channelId], false), 'Could not unarchive that chat. Try again.', false), []);

  if (!open) return null;
  return <aside ref={root} id={id} className="canvas-drawer" aria-label="Loose chats">
    <header className="canvas-drawer-head">
      <h2>Loose chats · {count}</h2>
      <button type="button" className="canvas-drawer-close" aria-label="Close" title="Close" onClick={() => onClose(true)}><span aria-hidden="true">✕</span></button>
    </header>
    <div className="canvas-drawer-find">
      <input ref={search} type="search" className="canvas-drawer-search" aria-label="Search loose chats" placeholder="Search loose chats"
        autoComplete="off" value={query} onChange={event => setQuery(event.target.value)}/>
      <select className="canvas-drawer-agent" aria-label="Agent" title="Only chats with this agent" value={agent ?? ''} onChange={event => setAgent(event.target.value || null)}>
        <option value="">All agents</option>
        {agents.map(name => <option key={name} value={name}>{name}</option>)}
      </select>
    </div>
    <div className="canvas-drawer-chips" role="group" aria-label="Show">
      {CHIPS.map(chip => <button key={chip.value} type="button" className="canvas-drawer-chip" aria-pressed={state === chip.value}
        onClick={() => setState(chip.value)}>{chip.label} <b>{counts[chip.value]}</b></button>)}
    </div>
    {error ? <p className="canvas-drawer-error" role="alert">{error}</p> : null}
    <div ref={listRef} className="canvas-drawer-list" onScroll={event => setScrollTop(event.currentTarget.scrollTop)}>
      {layout.items.length ? <ul style={{height: layout.height}}>
        {mounted.map(item => item.kind === 'group'
          ? <li key={`group:${item.name}`} className="canvas-drawer-group" role="presentation" style={{transform: `translateY(${item.top}px)`}}>
            <span>{item.name} · {item.count}</span>
            {item.fold ? <button type="button" aria-expanded={item.fold === 'hide'} aria-label={`${item.fold === 'show' ? 'Show' : 'Hide'} older chats`}
              onClick={() => setOlderOpen(value => !value)}>{item.fold === 'show' ? 'Show' : 'Hide'}</button> : null}
          </li>
          : <Row key={item.chat.channelId} chat={item.chat} index={item.index} top={item.top} size={layout.rows.length}
            selected={selected.has(item.chat.channelId)} hidden={hidden.has(item.chat.channelId)} draggable={draggable && canPlace} now={time}
            highlighted={highlight?.id === item.chat.channelId} onOpenChat={onOpenChat} dragIds={dragIds} onToggle={toggle} onUnhide={unhide}/>)}
      </ul> : <p className="canvas-drawer-empty">{chats.length ? 'Nothing matches.' : 'Every chat you are in is on this canvas.'}</p>}
    </div>
    {picked.length ? <div className="canvas-drawer-bulk" role="toolbar" aria-label="Selected chats">
      <b>{picked.length} selected</b>
      {tooMany ? <span id={limitId} className="canvas-drawer-limit">Select up to {MAX_BULK}</span> : null}
      <button type="button" className="is-primary" disabled={busy || !canPlace || tooMany} title={placeTitle} aria-describedby={tooMany ? limitId : undefined}
        onClick={() => void run(() => onNewArea(picked), 'Could not make that area. Try again.')}>New area from these</button>
      <button type="button" disabled={busy || tooMany} title={tooMany ? `Select up to ${MAX_BULK} chats` : 'Hide from your loose chats. The chat itself is not changed.'}
        aria-describedby={tooMany ? limitId : undefined} onClick={() => void run(() => onArchive(picked, true), 'Could not archive those chats. Try again.')}>Archive</button>
      <button type="button" className="canvas-drawer-clear" disabled={busy} onClick={() => setSelected(new Set())}>Clear</button>
    </div> : null}
    <p className="canvas-drawer-foot">
      <span>Tick chats to act on several at once</span>
      <label><input type="checkbox" checked={showHidden} onChange={event => onShowHidden(event.target.checked)}/>Show archived</label>
    </p>
  </aside>;
}
