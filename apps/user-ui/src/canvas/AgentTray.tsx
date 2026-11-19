// The agent tray (bottom left) and the All agents picker. Faces are dragged onto a card to invite that agent;
// the surface takes the drop. The tray shows this person's pins (suggestions for the selected chat first); a star
// in the picker pins or unpins. Who shows where is decided in tray.ts.
import {useEffect,useMemo,useRef,useState,type DragEvent as ReactDragEvent} from 'react';
import type {BoardCard,CanvasArea} from '@nest/schemas';
import type {Agent} from '../types';
import {AgentAvatar} from '../components/AgentAvatar';
import {AGENT_DRAG_TYPE} from './Surface';
import {oneLine} from './pulse';
import {areaAgentNames,busyLabel,pickerGroups,type PickerFilter} from './tray';

/** The tray's heading: suggestions for the open chat when there are any, else the pinned agents. The Legend's hint names the visible one. */
export const TRAY_SUGGESTED = 'Suggested for this chat';
export const TRAY_PINNED = 'Pinned';
export const trayHeading = (hasSuggested: boolean) => hasSuggested ? TRAY_SUGGESTED : TRAY_PINNED;
const FILTERS: {value: PickerFilter; label: string}[] = [
  {value: 'all', label: 'All'}, {value: 'yours', label: 'Yours'}, {value: 'free', label: 'Free now'}, {value: 'working', label: 'Working'},
];
/** Another dialog above the canvas (manage channel, the tour) or a phone's full-screen chat takes Escape for itself; a desktop chat window does not. */
const OTHER_DIALOG = '[aria-modal="true"], .dialog-backdrop, .canvas-chat[data-mode="focus"]:not([data-window])';

function startDrag(event: ReactDragEvent, name: string) {
  event.dataTransfer.setData(AGENT_DRAG_TYPE, name);
  event.dataTransfer.effectAllowed = 'copy';
}
/** The agent's role: the first line of its engine description. */
const roleOf = (agent: Agent) => oneLine(agent.description);

export type AgentTrayProps = {
  /** Up to three agents from the selected chat's area, shown first. */
  suggested: Agent[];
  /** The person's pins in order (the seed before they save any), minus the suggestions. */
  pinned: Agent[];
  /** The pin list the picker's stars show: saved pins, or the seed before the person saves any. */
  pins: readonly string[];
  /** False while the pins load: stars are disabled so a press is never lost. */
  pinsReady: boolean;
  onTogglePin(name: string): void;
  agents: Agent[];
  humanId: string;
  /** Engine human id to username, for the picker's owner groups and search. */
  owners: ReadonlyMap<string, string>;
  /** Placed cards on this canvas each agent is working on now. */
  busy: ReadonlyMap<string, number>;
  cards: BoardCard[];
  areas: CanvasArea[];
  /** Whether the picker is open. The canvas keeps it and the Loose chats drawer from both being open at once. */
  open: boolean;
  onOpenChange(open: boolean): void;
};

export function AgentTray({suggested, pinned, pins, pinsReady, onTogglePin, agents, humanId, owners, busy, cards, areas, open, onOpenChange}: AgentTrayProps) {
  const button = useRef<HTMLButtonElement>(null);
  const close = () => { onOpenChange(false); button.current?.focus({preventScroll: true}); };
  const face = (agent: Agent) => {
    const role = roleOf(agent);
    return <li key={agent.name}>
      <span className="canvas-tray-face" data-agent={agent.name} draggable="true" role="img" aria-label={agent.name}
        title={`${agent.name}${role ? ` · ${role}` : ''}. Drag onto a chat to add.`} onDragStart={event => startDrag(event, agent.name)}>
        <AgentAvatar name={agent.name} size={34}/>
      </span>
    </li>;
  };
  return <>
    <section className="canvas-tray" aria-label="Agents">
      <div className="canvas-chrome canvas-tray-strip">
        <div className="canvas-tray-scroll">
          {suggested.length ? <>
            <span className="canvas-tray-sugg">{TRAY_SUGGESTED}</span>
            <ul className="canvas-tray-faces" data-group="suggested" aria-label="Suggested for this chat">{suggested.map(face)}</ul>
            <span className="canvas-tray-sep" aria-hidden="true"/>
          </> : <span className="canvas-tray-label">{TRAY_PINNED}</span>}
          {pinned.length ? <ul className="canvas-tray-faces" data-group="pinned" aria-label="Pinned">{pinned.map(face)}</ul> : null}
        </div>
        <button ref={button} type="button" className="canvas-tray-all" aria-expanded={open} aria-haspopup="dialog"
          aria-label={`All ${agents.length} agents`} title="Search all agents" onClick={() => open ? close() : onOpenChange(true)}>All {agents.length}</button>
      </div>
    </section>
    {open ? <AgentPicker agents={agents} humanId={humanId} owners={owners} busy={busy} pins={pins} pinsReady={pinsReady} onTogglePin={onTogglePin}
      cards={cards} areas={areas} onClose={close}/> : null}
  </>;
}

/**
 * Searchable list of every agent, grouped by owner, with chip and area filters, each row's live status and a pin
 * star. Not modal: the canvas stays reachable, so rows drag straight onto a card. While a row is dragged the panel
 * lets drops through to the cards below.
 */
function AgentPicker({agents, humanId, owners, busy, pins, pinsReady, onTogglePin, cards, areas, onClose}: {
  agents: Agent[]; humanId: string; owners: ReadonlyMap<string, string>; busy: ReadonlyMap<string, number>;
  pins: readonly string[]; pinsReady: boolean; onTogglePin(name: string): void; cards: BoardCard[]; areas: CanvasArea[]; onClose(): void;
}) {
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<PickerFilter>('all');
  const [areaId, setAreaId] = useState('');
  const [dragging, setDragging] = useState(false);
  const search = useRef<HTMLInputElement>(null);
  const closeRef = useRef(onClose); closeRef.current = onClose;
  useEffect(() => { search.current?.focus({preventScroll: true}); }, []);
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || document.querySelector(OTHER_DIALOG)) return;
      event.preventDefault();
      closeRef.current();
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, []);
  // A row that re-renders away mid-drag sends no dragend of its own: any drag ending lets the panel back in.
  useEffect(() => {
    if (!dragging) return;
    const end = () => setDragging(false);
    window.addEventListener('dragend', end, true);
    window.addEventListener('drop', end, true);
    return () => { window.removeEventListener('dragend', end, true); window.removeEventListener('drop', end, true); };
  }, [dragging]);
  // A deleted area falls back to every area.
  const area = areas.find(a => a.id === areaId) ?? null;
  const inArea = useMemo(() => area ? areaAgentNames(area.id, cards, areas) : null, [area, cards, areas]);
  const groups = useMemo(() => pickerGroups({agents, humanId, owners, query, filter, inArea, busy}), [agents, humanId, owners, query, filter, inArea, busy]);
  const pinned = new Set(pins);
  return <div className={`canvas-picker${dragging ? ' is-dragging' : ''}`} role="dialog" aria-label="All agents">
    <header className="canvas-picker-head">
      <h2>Agents · {agents.length}</h2>
      <button type="button" className="canvas-picker-close" aria-label="Close" title="Close" onClick={onClose}><span aria-hidden="true">✕</span></button>
    </header>
    <div className="canvas-picker-find">
      <input ref={search} type="search" className="canvas-picker-search" aria-label="Search agents" placeholder="Search by name, role or owner"
        autoComplete="off" value={query} onChange={event => setQuery(event.target.value)}/>
      <select className="canvas-picker-area" aria-label="Area" title="Only agents in this area's chats" value={area?.id ?? ''} onChange={event => setAreaId(event.target.value)}>
        <option value="">All areas</option>
        {areas.map(a => <option key={a.id} value={a.id}>{a.title}</option>)}
      </select>
    </div>
    <div className="canvas-picker-chips" role="group" aria-label="Show">
      {FILTERS.map(option => <button key={option.value} type="button" className="canvas-picker-chip" aria-pressed={filter === option.value}
        onClick={() => setFilter(option.value)}>{option.label}</button>)}
    </div>
    {groups.length ? <div className="canvas-picker-list">
      {groups.map(group => <section key={group.label} className="canvas-picker-group" aria-label={group.label}>
        <h3 className="canvas-picker-group-head">{group.label} · {group.agents.length}</h3>
        <ul>
          {group.agents.map(agent => {
            const count = busy.get(agent.name) ?? 0, on = pinned.has(agent.name), role = roleOf(agent);
            return <li key={agent.name} className="canvas-picker-row" data-agent={agent.name} draggable="true"
              onDragStart={event => { startDrag(event, agent.name); setTimeout(() => setDragging(true), 0); }}
              onDragEnd={() => setDragging(false)}>
              <AgentAvatar name={agent.name} size={30}/>
              <span className="canvas-picker-body">
                <span className="canvas-picker-name">{agent.name}</span>
                {role ? <span className="canvas-picker-role" title={role}>{role}</span> : null}
              </span>
              <span className={`canvas-picker-status${count ? ' is-busy' : ''}`}>{busyLabel(count)}</span>
              <button type="button" className={`canvas-picker-star${on ? ' is-on' : ''}`} aria-pressed={on}
                aria-label={`Pin ${agent.name} to tray`} title={on ? 'Unpin' : 'Pin to tray'} aria-disabled={pinsReady ? undefined : true}
                onClick={() => { if (pinsReady) onTogglePin(agent.name); }}>
                <span aria-hidden="true">{on ? '★' : '☆'}</span>
              </button>
            </li>;
          })}
        </ul>
      </section>)}
    </div> : <p className="canvas-picker-empty">No agents match.</p>}
    <p className="canvas-picker-foot">Drag any agent onto a chat · ☆ pins it to the tray</p>
  </div>;
}
