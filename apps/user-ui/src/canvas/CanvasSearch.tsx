// Ctrl/Cmd+K search across this canvas's cards and areas, the loose chats and the person's canvases.
import {useEffect,useId,useMemo,useState,type KeyboardEvent} from 'react';
import {Modal} from './CanvasSwitcher';
import {KIND_ORDER,rank,type SearchItem} from './search';

const GROUPS: Record<SearchItem['kind'], string> = {card: 'On this canvas', area: 'Areas', loose: 'Chats elsewhere', canvas: 'Canvases'};

export type CanvasSearchProps = {
  items: SearchItem[];
  onClose(): void;
  /** The chosen result. The caller closes the dialog. */
  onChoose(item: SearchItem): void;
};

export function CanvasSearch({items, onClose, onChoose}: CanvasSearchProps) {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const base = useId();
  // Grouped in the dialog's order, and the keyboard walks them in that same order.
  const groups = useMemo(() => {
    const found = rank(items, query);
    return KIND_ORDER.map(kind => ({kind, results: found.filter(item => item.kind === kind)})).filter(group => group.results.length);
  }, [items, query]);
  const flat = useMemo(() => groups.flatMap(group => group.results), [groups]);
  const current = flat.length ? Math.min(active, flat.length - 1) : -1;
  const optionId = (item: SearchItem) => `${base}-${item.kind}-${item.id}`;
  // aria-activedescendant does not scroll: keep the active option inside the results box.
  const activeId = flat[current] ? optionId(flat[current]) : null;
  useEffect(() => { if (activeId) document.getElementById(activeId)?.scrollIntoView({block: 'nearest'}); }, [activeId]);

  const key = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!flat.length) return;
      setActive((current + (event.key === 'ArrowDown' ? 1 : -1) + flat.length) % flat.length);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      if (flat[current]) onChoose(flat[current]);
    }
  };

  return <Modal label="Search the canvas" onClose={onClose}>
    <div className="canvas-search">
      <input type="text" className="canvas-search-input" role="combobox" aria-label="Search" aria-expanded={flat.length > 0} aria-controls={`${base}-results`}
        aria-activedescendant={flat[current] ? optionId(flat[current]) : undefined} aria-autocomplete="list" autoComplete="off" spellCheck={false}
        placeholder="Search cards, areas, chats and canvases" value={query}
        onChange={event => { setQuery(event.target.value); setActive(0); }} onKeyDown={key}/>
      <div id={`${base}-results`} role="listbox" aria-label="Results" className="canvas-search-results">
        {groups.map(group => <div key={group.kind} role="group" aria-label={GROUPS[group.kind]} className="canvas-search-group">
          <p className="canvas-search-heading" aria-hidden="true">{GROUPS[group.kind]}</p>
          {group.results.map(item => <div key={item.id} id={optionId(item)} role="option" aria-selected={flat[current] === item} className="canvas-search-option"
            onMouseMove={() => setActive(flat.indexOf(item))} onClick={() => onChoose(item)}>
            <span className="canvas-search-label">{item.label}</span>
            <span className="canvas-search-detail">{item.detail}</span>
          </div>)}
        </div>)}
        {query.trim() && !flat.length ? <p className="canvas-search-empty" role="status">No matches.</p> : null}
      </div>
    </div>
  </Modal>;
}
