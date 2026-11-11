// The Hand-off popover (the mock's renderLink): what passes along, when, who picks it up and the name on the line,
// with a plain-language summary and Disconnect / Send now / Pause / Done. Anchored under the line's label (the mock's
// popAt) and kept inside the window. Each option press saves at once; the name saves 600 ms after typing stops.
// Only the link's creator changes the settings; a member of the receiving chat may pause or disconnect it.
import {useEffect,useLayoutEffect,useRef,useState,type CSSProperties} from 'react';
import type {LinkWhat,LinkWhen} from '@nest/schemas';
import {AgentAvatar} from '../components/AgentAvatar';
import type {LinkView} from './flows-api';

export type HandoffChange = {what?: LinkWhat; when?: LinkWhen; who?: string | null; label?: string; on?: boolean};
export type HandoffPopoverProps = {
  link: LinkView;
  fromTitle: string;
  toTitle: string;
  /** The first agent in the source chat, named in the summary (`someone` without one). */
  fromAgent: string | null;
  /** The agents in the receiving chat. */
  candidates: readonly string[];
  /** The person's pinned agents, offered by `+ Someone else`. */
  pinned: readonly string[];
  /** The label the popover sits under; focus returns there on close. */
  anchor: HTMLElement | null;
  /** The creator, on a canvas they may edit: the settings can change. */
  editable: boolean;
  onChange(change: HandoffChange): void;
  /** The name as typed, before it saves: the line's label follows it (the mock's renderLinks on input). */
  onLabelDraft?(label: string): void;
  onDisconnect(): void;
  onSendNow(): void;
  onClose(): void;
};

export const WHAT: Record<LinkWhat, [string, string]> = {
  results: ['Results and files', 'Drafts, files and links it produces'],
  summary: ['A short summary', 'A few lines on what changed'],
  all: ['The whole conversation', 'Everything, including the back-and-forth'],
};
export const WHEN: Record<LinkWhen, [string, string]> = {
  done: ['Each time it finishes something', 'Hands off automatically'],
  approve: ['After I approve it', 'Shows up in Needs you first'],
  manual: ['Only when I press Send now', 'Nothing moves on its own'],
};
const GOES: Record<LinkWhat, string> = {results: 'its results and files go', summary: 'a short summary goes', all: 'the whole conversation goes'};
export const LABEL_SAVE_MS = 600;
/** The mock's popAt margins: 16 px from the sides and bottom, 76 px from the top. */
const SIDE = 16, TOP = 76;

export function HandoffPopover({link, fromTitle, toTitle, fromAgent, candidates, pinned, anchor, editable, onChange, onLabelDraft, onDisconnect, onSendNow, onClose}: HandoffPopoverProps) {
  const [more, setMore] = useState(false);
  const [label, setLabel] = useState(link.label);
  const pending = useRef<ReturnType<typeof setTimeout> | null>(null);
  const changeRef = useRef(onChange); changeRef.current = onChange;
  const labelRef = useRef(label); labelRef.current = label;
  const saveLabel = () => {
    if (pending.current) { clearTimeout(pending.current); pending.current = null; }
    const value = labelRef.current.trim() || 'results';
    if (value !== link.label) changeRef.current({label: value});
  };
  const saveRef = useRef(saveLabel); saveRef.current = saveLabel;
  // A name still waiting to save goes when the popover closes.
  useEffect(() => () => { if (pending.current) saveRef.current(); }, []);

  // Focus moves to the heading; on close it returns to the label, else to what was focused before.
  const ref = useRef<HTMLDivElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const anchorRef = useRef(anchor); anchorRef.current = anchor;
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null;
    heading.current?.focus({preventScroll: true});
    return () => {
      const view = ref.current?.closest<HTMLElement>('.canvas-view') ?? document;
      [anchorRef.current, previous, view.querySelector<HTMLElement>('.canvas-surface')].find(element => element?.isConnected)?.focus({preventScroll: true});
    };
  }, []);

  // Under the label (r.left - 170, r.bottom + 10), inside the window. Re-placed as its content or the window changes.
  const [place, setPlace] = useState<{left: number; top: number} | null>(null);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const measure = () => {
      const r = anchorRef.current?.isConnected ? anchorRef.current.getBoundingClientRect() : null;
      const x = r ? r.left - 170 : (window.innerWidth - element.offsetWidth) / 2, y = r ? r.bottom + 10 : TOP;
      const left = Math.max(SIDE, Math.min(window.innerWidth - element.offsetWidth - SIDE, x));
      const top = Math.max(TOP, Math.min(window.innerHeight - element.offsetHeight - SIDE, y));
      setPlace(current => current?.left === left && current.top === top ? current : {left, top});
    };
    measure();
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(measure) : null;
    observer?.observe(element);
    window.addEventListener('resize', measure);
    return () => { observer?.disconnect(); window.removeEventListener('resize', measure); };
  }, [anchor]);

  // Escape (before an open chat's own Escape) and a press outside close it; the label it came from leaves it open.
  const closeRef = useRef(onClose); closeRef.current = onClose;
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      event.preventDefault();
      closeRef.current();
    };
    const outside = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (!target || ref.current?.contains(target) || anchorRef.current?.contains(target)) return;
      closeRef.current();
    };
    window.addEventListener('keydown', key, true);
    window.addEventListener('pointerdown', outside, true);
    return () => { window.removeEventListener('keydown', key, true); window.removeEventListener('pointerdown', outside, true); };
  }, []);

  const shownTo = toTitle.slice(0, 30);
  const picks = [...new Set([...candidates, ...(more ? pinned : [])])];
  const by = fromAgent ?? 'someone';
  const option = <K extends 'what' | 'when'>(key: K, map: Record<string, [string, string]>) => Object.entries(map).map(([value, [title, small]]) =>
    <button key={value} type="button" className={`opt${link[key] === value ? ' on' : ''}`} aria-pressed={link[key] === value} disabled={!editable}
      onClick={() => { if (link[key] !== value) onChange({[key]: value} as HandoffChange); }}>
      <span>{title}<small>{small}</small></span>
    </button>);
  const style = place ? {'--flow-pop-left': `${place.left}px`, '--flow-pop-top': `${place.top}px`} as CSSProperties : undefined;

  return <div ref={ref} role="dialog" aria-label="Hand-off between chats" className={`canvas-flow-pop invite wide${place ? ' is-placed' : ''}`} style={style}>
    <div className="iv-h"><div><h2 ref={heading} tabIndex={-1}>Hand-off</h2><small>{fromTitle} → {toTitle}</small></div></div>
    <div className="iv-l" id={`lk-what-${link.id}`}>What passes along</div>
    <div role="group" aria-labelledby={`lk-what-${link.id}`}>{option('what', WHAT)}</div>
    <div className="iv-l" id={`lk-when-${link.id}`}>When</div>
    <div role="group" aria-labelledby={`lk-when-${link.id}`}>{option('when', WHEN)}</div>
    <div className="iv-l" id={`lk-who-${link.id}`}>Who picks it up in “{shownTo}”</div>
    <div className="optrow" role="group" aria-labelledby={`lk-who-${link.id}`}>
      {picks.map(name => <button key={name} type="button" className={`pick${link.who === name ? ' on' : ''}`} aria-pressed={link.who === name} disabled={!editable}
        onClick={() => { if (link.who !== name) onChange({who: name}); }}><AgentAvatar name={name} size={20}/>{name}</button>)}
      <button type="button" className={`pick txt${link.who === null ? ' on' : ''}`} aria-pressed={link.who === null} disabled={!editable}
        onClick={() => { if (link.who !== null) onChange({who: null}); }}>Nobody, just context</button>
      {more || !editable ? null : <button type="button" className="pick txt" onClick={() => setMore(true)}>+ Someone else</button>}
    </div>
    <div className="iv-l" id={`lk-label-${link.id}`}>Name on the line</div>
    <input className="iv-in" id="lk-label" aria-labelledby={`lk-label-${link.id}`} value={label} maxLength={60} readOnly={!editable}
      onChange={event => {
        setLabel(event.target.value);
        onLabelDraft?.(event.target.value.trim() || 'results');
        if (pending.current) clearTimeout(pending.current);
        pending.current = setTimeout(() => saveRef.current(), LABEL_SAVE_MS);
      }}
      onBlur={() => { if (pending.current) saveLabel(); }}/>
    <div className="lk-sum" role="status">
      {link.when === 'manual' ? 'When you press Send now' : <>When {by} finishes something in <b>{fromTitle}</b>{link.when === 'approve' ? ' and you approve it' : ''}</>}
      , {GOES[link.what]} to <b>{toTitle}</b> and {link.who ? <><b>{link.who}</b> picks it up</> : 'it waits there as context for whoever is in it'}.
      {link.on ? null : <> <b>Paused right now.</b></>}
    </div>
    <div className="iv-foot">
      {link.canManage ? <button type="button" className="btn" style={{marginRight: 'auto'}} onClick={onDisconnect}>Disconnect</button> : null}
      {link.canManage && link.when === 'manual' ? <button type="button" className="btn" onClick={onSendNow}>Send now</button> : null}
      {link.canManage ? <button type="button" className="btn" onClick={() => onChange({on: !link.on})}>{link.on ? 'Pause' : 'Resume'}</button> : null}
      <button type="button" className="btn pri" onClick={onClose}>Done</button>
    </div>
  </div>;
}
