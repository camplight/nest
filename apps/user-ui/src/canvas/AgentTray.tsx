// The pinned agent tray (bottom left) and the All agents picker. Faces are dragged onto a card to invite
// that agent; the surface takes the drop. Who shows where is decided in tray.ts.
import {useEffect,useId,useMemo,useRef,useState,type DragEvent as ReactDragEvent} from 'react';
import type {BoardCard,CanvasArea} from '@nest/schemas';
import type {Agent} from '../types';
import {AgentAvatar} from '../components/AgentAvatar';
import {AGENT_DRAG_TYPE} from './Surface';
import {areaAgentNames,pickerAgents,type OwnerFilter,type TrayAgent} from './tray';

const OWNERS: {value: OwnerFilter; label: string}[] = [{value: 'all', label: 'All'}, {value: 'yours', label: 'Yours'}, {value: 'team', label: 'Team'}];
/** Another dialog above the canvas (manage channel, the tour) or a focus chat takes Escape for itself. */
const OTHER_DIALOG = '[aria-modal="true"], .dialog-backdrop, .canvas-chat[data-mode="focus"]';

function startDrag(event: ReactDragEvent, name: string) {
  event.dataTransfer.setData(AGENT_DRAG_TYPE, name);
  event.dataTransfer.effectAllowed = 'copy';
}

export type AgentTrayProps = {
  /** Up to TRAY_MAX faces: suggestions for the selected card first. */
  tray: TrayAgent[];
  /** The selected card's title, when its suggestions lead the tray. */
  suggestedFor: string | null;
  agents: Agent[];
  humanId: string;
  cards: BoardCard[];
  areas: CanvasArea[];
};

export function AgentTray({tray, suggestedFor, agents, humanId, cards, areas}: AgentTrayProps) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const close = () => { setOpen(false); button.current?.focus({preventScroll: true}); };
  const suggested = tray.filter(agent => agent.suggested), rest = tray.filter(agent => !agent.suggested);
  const face = (agent: TrayAgent) => <li key={agent.name}>
    <span className="canvas-tray-face" data-agent={agent.name} draggable="true" role="img" aria-label={agent.name}
      title={`${agent.name}: drag onto a chat to add`} onDragStart={event => startDrag(event, agent.name)}>
      <AgentAvatar name={agent.name} size={34}/>
    </span>
  </li>;
  return <>
    <section className="canvas-tray" aria-label="Agents">
      {suggested.length && suggestedFor ? <p className="canvas-tray-label">Suggested for {suggestedFor}</p> : null}
      <div className="canvas-chrome canvas-tray-strip">
        {tray.length ? <div className="canvas-tray-scroll">
          {suggested.length ? <ul className="canvas-tray-faces" data-group="suggested">{suggested.map(face)}</ul> : null}
          {rest.length ? <ul className="canvas-tray-faces">{rest.map(face)}</ul> : null}
        </div> : null}
        <button ref={button} type="button" className="canvas-tray-all" aria-expanded={open} aria-haspopup="dialog"
          onClick={() => open ? close() : setOpen(true)}>All agents ({agents.length})</button>
      </div>
    </section>
    {open ? <AgentPicker agents={agents} humanId={humanId} cards={cards} areas={areas} onClose={close}/> : null}
  </>;
}

/**
 * Searchable list of every agent, with Yours/Team and area filters. Not modal: the canvas stays reachable,
 * so rows drag straight onto a card. While a row is dragged the panel lets drops through to the cards below.
 */
function AgentPicker({agents, humanId, cards, areas, onClose}: {
  agents: Agent[]; humanId: string; cards: BoardCard[]; areas: CanvasArea[]; onClose(): void;
}) {
  const [query, setQuery] = useState('');
  const [owner, setOwner] = useState<OwnerFilter>('all');
  const [areaId, setAreaId] = useState('');
  const [dragging, setDragging] = useState(false);
  const search = useRef<HTMLInputElement>(null);
  const areaField = useId();
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
  const shown = useMemo(() => pickerAgents({agents, humanId, query, owner, inArea}), [agents, humanId, query, owner, inArea]);
  return <div className={`canvas-picker${dragging ? ' is-dragging' : ''}`} role="dialog" aria-label="All agents">
    <header className="canvas-picker-head">
      <h2>All agents</h2>
      <button type="button" className="canvas-picker-close" onClick={onClose}>Close</button>
    </header>
    <input ref={search} type="search" className="canvas-picker-search" aria-label="Search agents" placeholder="Search"
      value={query} onChange={event => setQuery(event.target.value)}/>
    <div className="canvas-picker-filters">
      <div role="radiogroup" aria-label="Owner" className="canvas-picker-owners">
        {OWNERS.map(option => <label key={option.value}>
          <input type="radio" name="canvas-picker-owner" value={option.value} checked={owner === option.value} onChange={() => setOwner(option.value)}/>
          <span>{option.label}</span>
        </label>)}
      </div>
      <div className="canvas-picker-area">
        <label htmlFor={areaField}>Area</label>
        <select id={areaField} value={area?.id ?? ''} onChange={event => setAreaId(event.target.value)}>
          <option value="">All areas</option>
          {areas.map(a => <option key={a.id} value={a.id}>{a.title}</option>)}
        </select>
      </div>
    </div>
    <p className="canvas-picker-hint">Drag an agent onto a chat to add it.</p>
    {shown.length ? <ul className="canvas-picker-list" aria-label={`${shown.length} agents`}>
      {shown.map(agent => <li key={agent.name} className="canvas-picker-row" data-agent={agent.name} draggable="true"
        onDragStart={event => { startDrag(event, agent.name); setTimeout(() => setDragging(true), 0); }}
        onDragEnd={() => setDragging(false)}>
        <AgentAvatar name={agent.name} size={30}/>
        <span className="canvas-picker-name">{agent.name}</span>
        <span className="canvas-picker-owner">{agent.ownerHumanId === humanId ? 'Yours' : 'Team'}</span>
      </li>)}
    </ul> : <p className="canvas-picker-empty">No agents match.</p>}
  </div>;
}
