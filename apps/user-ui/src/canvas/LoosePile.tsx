// The Loose chats pile: the person's chats that are not on this canvas, with search, filters,
// multi-select, bulk place/area/hide and drag onto the surface. The list is windowed by hand:
// fixed 56 px rows, and only the rows in view (plus a few) are in the DOM.
import {memo,useCallback,useEffect,useLayoutEffect,useMemo,useRef,useState,type DragEvent as ReactDragEvent,type MouseEvent as ReactMouseEvent} from 'react';
import {filterLoose,type LooseAge,type LooseChat} from './loose';
import {CHAT_DRAG_TYPE} from './Surface';

export const PILE_ROW_HEIGHT = 56;
const OVERSCAN = 4;
/** Before the list is measured: enough rows for a tall panel, still far below 40. */
const FALLBACK_HEIGHT = 720;
/** Bulk endpoints take at most 100 channel ids per call. */
export const MAX_BULK = 100;

export type LoosePileProps = {
  /** Loose chats, newest first; hidden ones are included only while Show hidden is on. */
  chats: LooseChat[];
  /** How many loose chats are not hidden; the badge count. */
  count: number;
  hidden: ReadonlySet<string>;
  showHidden: boolean;
  onShowHidden(show: boolean): void;
  /** Viewers of a shared canvas cannot place cards; they can still hide chats for themselves. */
  canPlace: boolean;
  onPlace(channelIds: string[], withArea: boolean): Promise<boolean>;
  onHide(channelIds: string[], hidden: boolean): Promise<boolean>;
  open: boolean;
  onOpen(open: boolean): void;
  now(): number;
};

const AGES: {value: LooseAge; label: string}[] = [
  {value: 'any', label: 'Any time'}, {value: 'today', label: 'Today'}, {value: 'week', label: 'This week'}, {value: 'older', label: 'Older'},
];

function ago(at: number | null, now: number) {
  if (at === null) return '';
  const minutes = Math.max(0, Math.floor((now - at) / 60_000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.floor(hours / 24)} d ago`;
}

type RowProps = {
  chat: LooseChat; index: number; top: number; selected: boolean; hidden: boolean; draggable: boolean; now: number; size: number;
  onToggle(index: number, channelId: string, checked: boolean, range: boolean): void;
  onUnhide(channelId: string): void;
};
const Row = memo(function Row({chat, index, top, selected, hidden, draggable, now, size, onToggle, onUnhide}: RowProps) {
  const start = (event: ReactDragEvent<HTMLLIElement>) => {
    event.dataTransfer.setData(CHAT_DRAG_TYPE, chat.channelId);
    event.dataTransfer.setData('text/plain', chat.title);
    event.dataTransfer.effectAllowed = 'move';
  };
  const agents = chat.agents.length ? chat.agents.slice(0, 2).join(', ') + (chat.agents.length > 2 ? ` +${chat.agents.length - 2}` : '') : 'No agents';
  return <li className="canvas-pile-row" style={{transform: `translateY(${top}px)`}} aria-setsize={size} aria-posinset={index + 1}
    data-channel-id={chat.channelId} data-hidden={hidden || undefined} draggable={draggable && !hidden} onDragStart={draggable && !hidden ? start : undefined}>
    <input type="checkbox" aria-label={`Select ${chat.title}`} checked={selected}
      onClick={(event: ReactMouseEvent<HTMLInputElement>) => onToggle(index, chat.channelId, event.currentTarget.checked, event.shiftKey)}
      onChange={() => {}}/>
    <span className="canvas-pile-main">
      <span className="canvas-pile-title" title={chat.title}>{chat.title || 'Untitled chat'}</span>
      <span className="canvas-pile-meta">{agents}{chat.lastActivityAt !== null ? <> · {ago(chat.lastActivityAt, now)}</> : null}</span>
    </span>
    {chat.needsYou ? <span className="canvas-pile-needs" role="img" aria-label="Needs you" title="Needs you"/> : null}
    {hidden ? <button type="button" className="canvas-pile-unhide" onClick={() => onUnhide(chat.channelId)}>Unhide</button> : null}
  </li>;
});

export function LoosePile({chats, count, hidden, showHidden, onShowHidden, canPlace, onPlace, onHide, open, onOpen, now}: LoosePileProps) {
  const [query, setQuery] = useState('');
  const [needsYou, setNeedsYou] = useState(false);
  const [agent, setAgent] = useState<string | null>(null);
  const [age, setAge] = useState<LooseAge>('any');
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const anchor = useRef<number | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [height, setHeight] = useState(0);

  // Ages and "ago" labels move by the minute, so rows re-render at most once a minute for time alone.
  const minute = Math.floor(now() / 60_000), time = minute * 60_000;
  const shown = useMemo(() => filterLoose(chats, {query, needsYou, agent, age}, time), [chats, query, needsYou, agent, age, time]);
  const shownRef = useRef(shown); shownRef.current = shown;
  const agents = useMemo(() => [...new Set(chats.flatMap(c => c.agents))].sort((a, b) => a.localeCompare(b)), [chats]);
  // Selection only counts chats still listed: placed or hidden ones drop out of it.
  const picked = useMemo(() => shown.filter(c => selected.has(c.channelId)).map(c => c.channelId), [shown, selected]);
  useEffect(() => { anchor.current = null; }, [query, needsYou, agent, age, showHidden]);

  useLayoutEffect(() => {
    const element = listRef.current;
    if (!element) return;
    const read = () => setHeight(element.clientHeight);
    read();
    const watch = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(read);
    watch?.observe(element);
    return () => watch?.disconnect();
  }, [open]);
  // A narrower result can leave the old offset past the end.
  const total = shown.length * PILE_ROW_HEIGHT;
  const viewport = height || FALLBACK_HEIGHT;
  const offset = Math.min(scrollTop, Math.max(0, total - viewport));
  const first = Math.max(0, Math.floor(offset / PILE_ROW_HEIGHT) - OVERSCAN);
  const last = Math.min(shown.length, Math.ceil((offset + viewport) / PILE_ROW_HEIGHT) + OVERSCAN);

  const toggle = useCallback((index: number, channelId: string, checked: boolean, range: boolean) => {
    const list = shownRef.current;
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
  const hideRef = useRef(onHide); hideRef.current = onHide;
  const unhide = useCallback((channelId: string) => void runRef.current(() => hideRef.current([channelId], false), 'Could not unhide that chat. Try again.', false), []);

  return <aside className={`canvas-pile${open ? ' is-open' : ''}`} aria-label="Loose chats">
    <div className="canvas-pile-head">
      <button type="button" className="canvas-pile-toggle" aria-expanded={open} onClick={() => onOpen(!open)}>
        <span>Loose chats</span><span className="canvas-pile-count">{count}</span>
      </button>
    </div>
    {open ? <>
      <div className="canvas-pile-filters">
        <input type="search" className="canvas-pile-search" aria-label="Search loose chats" placeholder="Search" value={query} onChange={event => setQuery(event.target.value)}/>
        <div className="canvas-pile-chips">
          <button type="button" className="canvas-pile-chip" aria-pressed={needsYou} onClick={() => setNeedsYou(v => !v)}>Needs you</button>
          <select className="canvas-pile-chip" aria-label="Agent" value={agent ?? ''} onChange={event => setAgent(event.target.value || null)}>
            <option value="">All agents</option>
            {agents.map(name => <option key={name} value={name}>{name}</option>)}
          </select>
          <select className="canvas-pile-chip" aria-label="Age" value={age} onChange={event => setAge(event.target.value as LooseAge)}>
            {AGES.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
        </div>
        <label className="canvas-pile-hidden"><input type="checkbox" checked={showHidden} onChange={event => onShowHidden(event.target.checked)}/>Show hidden</label>
      </div>
      {picked.length ? <div className="canvas-pile-bulk" role="toolbar" aria-label="Selected chats">
        <span>{picked.length} selected</span>
        <button type="button" disabled={busy || !canPlace || tooMany} title={placeTitle} onClick={() => void run(() => onPlace(picked, false), 'Could not place those chats. Try again.')}>Place on canvas</button>
        <button type="button" disabled={busy || !canPlace || tooMany} title={placeTitle} onClick={() => void run(() => onPlace(picked, true), 'Could not make that area. Try again.')}>New area from these</button>
        <button type="button" disabled={busy || tooMany} title={tooMany ? `Select up to ${MAX_BULK} chats` : 'Hide from your loose chats. The chat itself is not archived.'} onClick={() => void run(() => onHide(picked, true), 'Could not hide those chats. Try again.')}>Hide</button>
        <button type="button" className="canvas-pile-clear" disabled={busy} onClick={() => setSelected(new Set())}>Clear</button>
      </div> : null}
      {error ? <p className="canvas-pile-error" role="alert">{error}</p> : null}
      <div ref={listRef} className="canvas-pile-list" onScroll={event => setScrollTop(event.currentTarget.scrollTop)}>
        {shown.length ? <ul style={{height: total}}>
          {shown.slice(first, last).map((chat, i) => <Row key={chat.channelId} chat={chat} index={first + i} top={(first + i) * PILE_ROW_HEIGHT}
            selected={selected.has(chat.channelId)} hidden={hidden.has(chat.channelId)} draggable={canPlace} now={time} size={shown.length}
            onToggle={toggle} onUnhide={unhide}/>)}
        </ul> : <p className="canvas-pile-empty">{chats.length ? 'No loose chats match.' : 'Every chat you are in is on this canvas.'}</p>}
      </div>
    </> : null}
  </aside>;
}
