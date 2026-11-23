// The chat picker (the mock's renderLinkPick): connect one chat to another chat on this canvas, found by name and grouped
// by area, or add a new step after it. Anchored under the button that opened it (the mock's popAt, 120 px left and 8 px
// down) and kept inside the window; Escape, Cancel and a press outside close it.
import {useEffect,useMemo,useRef,useState} from 'react';
import {areaFor,type BoardCard,type BoardLink,type CanvasArea} from '@nest/schemas';
import {AgentAvatar} from '../components/AgentAvatar';
import {cardCentre} from './geometry';
import {cardTitle} from './Card';
import {popStyle,usePopDismiss,usePopPlacement} from './HandoffPopover';

export type LinkPickerProps = {
  /** The chat whose results would pass along: an open card on this canvas. */
  from: Extract<BoardCard, {access: 'open'}>;
  cards: readonly BoardCard[];
  areas: readonly CanvasArea[];
  links: readonly BoardLink[];
  /** The service agent's name, never a row's face. */
  service: string | null;
  /** The button the picker sits under; focus returns there on close. */
  anchor: HTMLElement | null;
  onPick(to: string): void;
  /** Editors only (and not on a phone); without it there is no `A new step after this one`. */
  onNewStep?(): void;
  onClose(): void;
};

type Open = Extract<BoardCard, {access: 'open'}>;
export const PICK_HINT = 'Pick the chat that should get its results. Or drag the + on a card\'s right edge onto another card.';
const NO_AREA = 'Not in an area';
const initials = (name: string) => name.replace(/[^\p{L}\p{N}]+/gu, ' ').trim().split(' ').filter(Boolean).slice(0, 2).map(word => word[0]).join('').toUpperCase() || '?';

/** The chats it can pass to, in the mock's groups: each area in order, then `Not in an area`; empty groups are left out. */
export function pickGroups(from: string, cards: readonly BoardCard[], areas: readonly CanvasArea[], query: string): [string, Open[]][] {
  const q = query.trim().toLowerCase();
  const shown = cards.filter((card): card is Open => card.access === 'open' && card.channelId !== from && !card.archived && (!q || cardTitle(card).toLowerCase().includes(q)));
  const inAreas = [...areas];
  const home = new Map(shown.map(card => [card.channelId, areaFor(cardCentre(card), inAreas)?.id ?? null]));
  return [
    ...areas.map(area => [area.title || 'Untitled area', shown.filter(card => home.get(card.channelId) === area.id)] as [string, Open[]]),
    [NO_AREA, shown.filter(card => home.get(card.channelId) === null)] as [string, Open[]],
  ].filter(([, list]) => list.length);
}

/** The mock's avFor: the chat's first agent, else its first person. */
function Face({card, service}: {card: Open; service: string | null}) {
  const agent = card.participants.find(p => p.subscriberType === 'AGENT' && p.subscriberId !== service);
  if (agent) return <AgentAvatar name={agent.subscriberId} size={28}/>;
  const person = card.participants.find(p => p.subscriberType === 'HUMAN');
  return <span className="lp-face" aria-hidden="true">{initials(person?.subscriberId ?? cardTitle(card))}</span>;
}

export function LinkPicker({from, cards, areas, links, service, anchor, onPick, onNewStep, onClose}: LinkPickerProps) {
  const [query, setQuery] = useState('');
  const groups = useMemo(() => pickGroups(from.channelId, cards, areas, query), [from.channelId, cards, areas, query]);
  const linked = useMemo(() => new Set(links.filter(l => l.kind === 'link' && l.from === from.channelId).map(l => l.to)), [links, from.channelId]);
  const ref = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const anchorRef = useRef(anchor); anchorRef.current = anchor;
  const place = usePopPlacement(ref, anchor, 120, 8);
  usePopDismiss(ref, anchorRef, onClose);
  // The search takes focus (the mock's $('#lp-q').focus()); on close focus returns to the opener.
  useEffect(() => {
    input.current?.focus({preventScroll: true});
    return () => {
      const view = ref.current?.closest<HTMLElement>('.canvas-view') ?? document;
      [anchorRef.current, view.querySelector<HTMLElement>('.canvas-surface')].find(element => element?.isConnected)?.focus({preventScroll: true});
    };
  }, []);

  return <div ref={ref} role="dialog" aria-label="Connect chats" className={`canvas-flow-pop canvas-link-pick invite wide${place ? ' is-placed' : ''}`} style={popStyle(place)}>
    <div className="iv-h"><div><h2>Connect “{cardTitle(from).slice(0, 34)}”</h2><small>{PICK_HINT}</small></div></div>
    <input ref={input} className="iv-in" id="lp-q" aria-label="Find a chat" placeholder="Find a chat…" value={query} autoComplete="off"
      onChange={event => setQuery(event.target.value)}/>
    <div className="lpick">
      {groups.length ? groups.map(([title, list]) => <div key={title} role="group" aria-label={title}>
        <div className="grp" aria-hidden="true">{title}</div>
        {list.map(card => <button key={card.channelId} type="button" data-to={card.channelId} onClick={() => onPick(card.channelId)}>
          <Face card={card} service={service}/>{cardTitle(card)}<small>{linked.has(card.channelId) ? 'connected' : ''}</small>
        </button>)}
      </div>) : <div className="calm">No chat with that name.</div>}
      {onNewStep ? <>
        <div className="grp" aria-hidden="true">Or</div>
        <button type="button" onClick={onNewStep}><span className="pl-ic" aria-hidden="true">+</span>A new step after this one</button>
      </> : null}
    </div>
    <div className="iv-foot"><button type="button" className="btn" onClick={onClose}>Cancel</button></div>
  </div>;
}
