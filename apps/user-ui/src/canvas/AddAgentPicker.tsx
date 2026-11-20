// The Add agent… picker in the open chat's More menu: the keyboard and touch way to do what dragging a face onto a card does.
import {useEffect,useId,useRef,useState} from 'react';
import type {Agent} from '../types';
import {AgentAvatar} from '../components/AgentAvatar';
import {oneLine} from './pulse';
import {fileViewerOwns} from './file-viewer';

/** Agents whose name or role contains the typed text, in any case; blank text keeps them all. */
export const filterAgents = (agents: Agent[], query: string): Agent[] => {
  const needle = query.trim().toLowerCase();
  return needle ? agents.filter(a => a.name.toLowerCase().includes(needle) || oneLine(a.description).toLowerCase().includes(needle)) : agents;
};

export type AddAgentPickerProps = {
  agents: Agent[];
  /** Agent names already in the chat: shown, disabled. */
  members: readonly string[];
  onPick(name: string): void;
  onClose(): void;
};

export function AddAgentPicker({agents, members, onPick, onClose}: AddAgentPickerProps) {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const listId = useId();
  const shown = filterAgents(agents, query);
  const here = new Set(members);
  const choose = (name: string) => { if (!here.has(name)) onPick(name); };
  useEffect(() => { search.current?.focus({preventScroll: true}); }, []);
  useEffect(() => {
    const press = (event: PointerEvent) => { if (!fileViewerOwns(event) && !(event.target instanceof Node && root.current?.contains(event.target))) onClose(); };
    window.addEventListener('pointerdown', press, true);
    return () => window.removeEventListener('pointerdown', press, true);
  }, [onClose]);
  const at = Math.min(active, Math.max(shown.length - 1, 0));
  const key = (event: React.KeyboardEvent) => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose(); }
    else if (event.key === 'ArrowDown') { event.preventDefault(); setActive(shown.length ? (at + 1) % shown.length : 0); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); setActive(shown.length ? (at - 1 + shown.length) % shown.length : 0); }
    else if (event.key === 'Enter' && shown[at]) { event.preventDefault(); choose(shown[at].name); }
  };
  return <div ref={root} className="canvas-add-agent" role="dialog" aria-label="Add agent" onKeyDown={key}>
    <input ref={search} type="search" className="canvas-picker-search" aria-label="Search agents" placeholder="Search agents" autoComplete="off"
      role="combobox" aria-expanded="true" aria-controls={listId} aria-activedescendant={shown[at] ? `${listId}-${at}` : undefined}
      value={query} onChange={event => { setQuery(event.target.value); setActive(0); }}/>
    {shown.length ? <ul id={listId} className="canvas-add-agent-list" role="listbox" aria-label="Agents">
      {shown.map((agent, index) => {
        const member = here.has(agent.name), role = oneLine(agent.description);
        return <li key={agent.name} id={`${listId}-${index}`} role="option" aria-selected={index === at} aria-disabled={member || undefined}>
          <button type="button" tabIndex={-1} className={`canvas-add-agent-row${index === at ? ' is-active' : ''}`} disabled={member}
            onMouseEnter={() => setActive(index)} onClick={() => choose(agent.name)}>
            <AgentAvatar name={agent.name} size={26}/>
            <span className="canvas-picker-body">
              <span className="canvas-picker-name">{agent.name}</span>
              {role ? <span className="canvas-picker-role" title={role}>{role}</span> : null}
            </span>
            {member ? <span className="canvas-picker-status">In this chat</span> : null}
          </button>
        </li>;
      })}
    </ul> : <p className="canvas-picker-empty">No agents match.</p>}
  </div>;
}
