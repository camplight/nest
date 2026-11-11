// Phones (760 px wide or less): a list in place of the free canvas. Areas expand to their chats, and
// Needs you and Loose chats sit beside them. Tapping a chat opens it in focus. No surface, tray or drag.
import {useEffect,useId,useMemo,useRef,useState,useSyncExternalStore,type KeyboardEvent} from 'react';
import type {BoardCard,CanvasBoard,Project} from '@nest/schemas';
import {ago,cardTitle,statusText} from './Card';
import {filterLoose,type LooseChat} from './loose';
import {needsYouItems} from './needs';
import {useReviews} from './NeedsYou';
import {NO_AREA,phoneGroups} from './phone';
import type {CardPulse} from './pulse';
import type {AreaContext} from './Area';
import {contextLabel} from './context-label';
import {contextFileHref} from './context-api';
import {FileTile} from './FileTile';

/** The existing phone breakpoint. */
export const PHONE_QUERY = '(max-width: 760px)';
const phoneNow = () => typeof matchMedia === 'function' && matchMedia(PHONE_QUERY).matches;
function onPhoneChange(notify: () => void) {
  if (typeof matchMedia !== 'function') return () => {};
  const query = matchMedia(PHONE_QUERY);
  query.addEventListener('change', notify);
  return () => query.removeEventListener('change', notify);
}
/** Whether the viewport is phone sized. It follows resizes and rotation. */
export function usePhoneLayout() {
  return useSyncExternalStore(onPhoneChange, phoneNow, () => false);
}

type Segment = 'areas' | 'needs' | 'loose';
const SEGMENTS: {id: Segment; label: string}[] = [{id: 'areas', label: 'Areas'}, {id: 'needs', label: 'Needs you'}, {id: 'loose', label: 'Loose chats'}];
const ANY_LOOSE = {state: 'all', agent: null} as const;

export type PhoneListProps = {
  board: CanvasBoard;
  pulses: ReadonlyMap<string, CardPulse>;
  /** The person's loose chats, hidden ones left out. */
  loose: LooseChat[];
  /** The chats the person can see (open cards and loose chats) with their titles, for Needs you. */
  titles: ReadonlyMap<string, string>;
  projects: Project[];
  onOpenChat(channelId: string): void;
  openChannelId: string | null;
  /** Each area's context counts, for the `◱` button in an expanded area. */
  areaContext?: ReadonlyMap<string, AreaContext>;
  /** Opens an area's context (a bottom sheet on phones) under the pressed button. */
  onAreaContext?(areaId: string, opener: HTMLElement): void;
  /** Changes each time the top bar's Loose chats toggle is pressed: the Loose chats segment is selected and scrolled into view. */
  looseKey?: number;
};

const agentList = (names: string[]) => names.length ? names.slice(0, 2).join(', ') + (names.length > 2 ? ` +${names.length - 2}` : '') : 'No agents';

/** A card's row. Only open cards are buttons; locked and unavailable rows never open. */
function CardRow({card, pulse, open, onOpen}: {card: BoardCard; pulse?: CardPulse; open: boolean; onOpen(channelId: string): void}) {
  const title = cardTitle(card);
  if (card.access !== 'open') return <li className="canvas-phone-row" data-access={card.access}>
    <span className="canvas-phone-main">
      <span className="canvas-phone-title">{title}</span>
      {card.access === 'locked' ? <span className="canvas-phone-meta">Owner: {card.ownerLabel}</span> : null}
    </span>
  </li>;
  const agents = pulse?.agents ?? card.participants.filter(p => p.subscriberType === 'AGENT').map(p => ({name: p.subscriberId, state: 'idle' as const, since: 0}));
  const busy = agents.find(agent => statusText(agent) !== null);
  const needs = pulse?.needsYou.length ?? 0;
  return <li>
    <button type="button" className="canvas-phone-row" aria-current={open ? 'true' : undefined} onClick={() => onOpen(card.channelId)}>
      <span className="canvas-phone-main">
        <span className="canvas-phone-title">{title}</span>
        <span className="canvas-phone-meta" data-state={busy?.state}>{busy ? statusText(busy) : agentList(agents.map(agent => agent.name))}</span>
      </span>
      {needs ? <span className="canvas-phone-needs" role="img" aria-label={`Needs you: ${needs}`}>{needs}</span> : null}
    </button>
  </li>;
}

export function PhoneList({board, pulses, loose, titles, projects, onOpenChat, openChannelId, areaContext, onAreaContext, looseKey = 0}: PhoneListProps) {
  const base = useId();
  const [segment, setSegment] = useState<Segment>('areas');
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const [query, setQuery] = useState('');
  const tabs = useRef(new Map<Segment, HTMLButtonElement>());
  // The top bar's Loose chats toggle: phones have no drawer, so it selects this list's own segment, brings the
  // segments into view and puts focus on the tab.
  const shownKey = useRef(looseKey);
  useEffect(() => {
    if (shownKey.current === looseKey) return;
    shownKey.current = looseKey;
    setSegment('loose');
    const tab = tabs.current.get('loose');
    tab?.focus({preventScroll: true});
    tab?.closest('.canvas-phone-segments')?.scrollIntoView({block: 'start'});
  }, [looseKey]);
  const groups = useMemo(() => phoneGroups(board.cards, board.areas), [board.cards, board.areas]);
  const reviews = useReviews(segment === 'needs');
  const needs = useMemo(() => needsYouItems({pulses, titles, reviews, projects}), [pulses, titles, reviews, projects]);
  const now = Date.now();
  const shownLoose = useMemo(() => filterLoose(loose, {query, ...ANY_LOOSE}), [loose, query]);
  const counts: Record<Segment, number> = {areas: board.areas.length, needs: needs.length, loose: loose.length};

  // Tabs: arrow keys, Home and End move between the segments.
  function key(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const last = SEGMENTS.length - 1;
    const next = event.key === 'ArrowRight' ? (index + 1) % SEGMENTS.length : event.key === 'ArrowLeft' ? (index + last) % SEGMENTS.length
      : event.key === 'Home' ? 0 : event.key === 'End' ? last : null;
    if (next === null) return;
    event.preventDefault();
    setSegment(SEGMENTS[next].id);
    tabs.current.get(SEGMENTS[next].id)?.focus();
  }
  const toggle = (id: string) => setExpanded(current => {
    const next = new Set(current);
    if (!next.delete(id)) next.add(id);
    return next;
  });

  let panel;
  if (segment === 'areas') {
    panel = groups.length ? <ul className="canvas-phone-areas">
      {groups.map(group => {
        const open = expanded.has(group.id), listId = `${base}-area-${group.id}`;
        const waiting = group.cards.reduce((sum, card) => sum + (card.access === 'open' ? pulses.get(card.channelId)?.needsYou.length ?? 0 : 0), 0);
        return <li key={group.id}>
          <button type="button" className="canvas-phone-area" data-tint={group.tint ?? undefined} aria-expanded={open} aria-controls={open ? listId : undefined} onClick={() => toggle(group.id)}>
            <span className="canvas-phone-area-title">{group.title}</span>
            <span className="canvas-phone-meta">{group.cards.length === 1 ? '1 chat' : `${group.cards.length} chats`}{waiting ? ` · ${waiting} need you` : ''}</span>
          </button>
          {open && group.id !== NO_AREA && onAreaContext ? (() => {
            const context = areaContext?.get(group.id);
            const label = context ? contextLabel(context, board.canvas.role === 'view' ? 'No context' : 'Add context') : 'Context';
            return <button type="button" className="canvas-area-ctx canvas-phone-ctx" aria-haspopup="dialog" aria-label={`Context for ${group.title}: ${label}`}
              onClick={event => onAreaContext(group.id, event.currentTarget)}><span aria-hidden="true">◱</span> {label}</button>;
          })() : null}
          {open ? group.cards.length
            ? <ul id={listId} className="canvas-phone-rows" aria-label={group.id === NO_AREA ? 'Chats not in an area' : `Chats in ${group.title}`}>
              {group.cards.map(card => <CardRow key={card.channelId} card={card} pulse={card.access === 'open' ? pulses.get(card.channelId) : undefined}
                open={card.channelId === openChannelId} onOpen={onOpenChat}/>)}
            </ul>
            : <>
              <p id={listId} className="canvas-phone-empty">No chats in this area yet.</p>
              {/* As on the canvas, an area with no chats shows its context files. */}
              {areaContext?.get(group.id)?.files.length ? <ul className="canvas-file-tiles canvas-phone-shelf" aria-label={`Files in ${group.title}`}>
                {areaContext.get(group.id)!.files.map(file => <FileTile key={file.id} name={file.name} mime={file.mime} href={contextFileHref(board.canvas.id, file.id)}/>)}
              </ul> : null}
            </> : null}
        </li>;
      })}
    </ul> : <p className="canvas-phone-empty">Nothing on this canvas yet. Start a chat below, or lay out chats on a larger screen.</p>;
  } else if (segment === 'needs') {
    panel = needs.length ? <ul className="canvas-phone-rows" aria-label="Needs you">
      {needs.map(item => <li key={item.key}>
        <button type="button" className="canvas-phone-row" onClick={() => onOpenChat(item.channelId)}>
          <span className="canvas-phone-main">
            <span className="canvas-phone-title">{item.chatTitle}</span>
            <span className="canvas-phone-meta">{item.detail}</span>
          </span>
          <span className="canvas-phone-age">{ago(item.at, now)}</span>
        </button>
      </li>)}
    </ul> : <p className="canvas-phone-empty">Nothing needs you right now.</p>;
  } else {
    panel = <>
      <input type="search" className="canvas-phone-search" aria-label="Search loose chats" placeholder="Search" value={query} onChange={event => setQuery(event.target.value)}/>
      {shownLoose.length ? <ul className="canvas-phone-rows" aria-label="Loose chats">
        {shownLoose.map(chat => <li key={chat.channelId}>
          <button type="button" className="canvas-phone-row" aria-current={chat.channelId === openChannelId ? 'true' : undefined} onClick={() => onOpenChat(chat.channelId)}>
            <span className="canvas-phone-main">
              <span className="canvas-phone-title">{chat.title || 'Untitled chat'}</span>
              <span className="canvas-phone-meta">{agentList(chat.agents)}{chat.lastActivityAt !== null ? ` · ${ago(chat.lastActivityAt, now)}` : ''}</span>
            </span>
            {chat.needsYou ? <span className="canvas-phone-dot" role="img" aria-label="Needs you"/> : null}
          </button>
        </li>)}
      </ul> : <p className="canvas-phone-empty">{loose.length ? 'No loose chats match.' : 'Every chat of yours is on this canvas.'}</p>}
    </>;
  }

  return <section className="canvas-phone" aria-label="Canvas list">
    <div className="canvas-phone-segments" role="tablist" aria-label="Sections">
      {SEGMENTS.map((item, index) => <button key={item.id} ref={element => { if (element) tabs.current.set(item.id, element); else tabs.current.delete(item.id); }}
        type="button" role="tab" id={`${base}-tab-${item.id}`} aria-selected={segment === item.id} aria-controls={`${base}-panel`}
        tabIndex={segment === item.id ? 0 : -1} onClick={() => setSegment(item.id)} onKeyDown={event => key(event, index)}>
        {item.label}{counts[item.id] ? <span className="canvas-phone-count">{counts[item.id]}</span> : null}
      </button>)}
    </div>
    <div id={`${base}-panel`} className="canvas-phone-panel" role="tabpanel" aria-labelledby={`${base}-tab-${segment}`}>{panel}</div>
  </section>;
}
