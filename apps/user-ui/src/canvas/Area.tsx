// An area ("nest") on the surface: inline rename, a title bar to move it, a corner to resize it and a menu.
import {memo,useEffect,useRef,useState,type KeyboardEvent} from 'react';
import type {CanvasArea} from '@nest/schemas';

/** Counts for the compact summary line. Task 6 supplies them from live card state. */
export type AreaSummary = {needYou: number; moving: number};
export type AreaProps = {
  area: CanvasArea;
  /** Drag and resize previews in canvas units. */
  dx: number;
  dy: number;
  w: number;
  h: number;
  canEdit: boolean;
  compact: boolean;
  summary?: AreaSummary;
  onRename(areaId: string, title: string): void;
  onDelete(areaId: string): void;
};

export const Area = memo(function Area({area, dx, dy, w, h, canEdit, compact, summary, onRename, onDelete}: AreaProps) {
  const [editing, setEditing] = useState(false);
  const [menu, setMenu] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  // Enter commits and unmounts the input; a blur that follows must not commit again.
  const committed = useRef(false);

  useEffect(() => {
    if (!menu) return;
    const close = (event: Event) => {
      if ('key' in event ? event.key === 'Escape' : !menuRef.current?.contains(event.target as Node)) setMenu(false);
    };
    window.addEventListener('pointerdown', close, true);
    window.addEventListener('keydown', close);
    return () => { window.removeEventListener('pointerdown', close, true); window.removeEventListener('keydown', close); };
  }, [menu]);

  function edit() { committed.current = false; setEditing(true); }
  function commit(value: string) {
    if (committed.current) return;
    committed.current = true;
    setEditing(false);
    const title = value.trim().slice(0, 120);
    if (title && title !== area.title) onRename(area.id, title);
  }
  function key(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Enter') commit(event.currentTarget.value);
    else if (event.key === 'Escape') { committed.current = true; setEditing(false); }
  }

  return <section
    className="canvas-area"
    aria-label={`Area ${area.title}`}
    data-area-id={area.id}
    data-tint={area.tint}
    style={{width: w, height: h, transform: `translate(${area.x + dx}px, ${area.y + dy}px)`}}>
    <div className="canvas-area-bar" data-drag={canEdit ? 'area' : undefined}>
      {editing
        ? <input className="canvas-area-input" aria-label="Area title" defaultValue={area.title} maxLength={120} autoFocus
            onFocus={event => event.currentTarget.select()} onKeyDown={key} onBlur={event => commit(event.currentTarget.value)}/>
        : <h3 className="canvas-area-title" onDoubleClick={canEdit ? edit : undefined}>{area.title}</h3>}
      {canEdit ? <div className="canvas-area-menu" ref={menuRef}>
        <button type="button" className="canvas-area-more" aria-label="Area options" aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu(open => !open)}>
          <span aria-hidden="true">⋯</span>
        </button>
        {menu ? <div role="menu" className="canvas-menu">
          <button type="button" role="menuitem" onClick={() => { setMenu(false); edit(); }}>Rename area</button>
          <button type="button" role="menuitem" onClick={() => { setMenu(false); onDelete(area.id); }}>Delete area</button>
        </div> : null}
      </div> : null}
    </div>
    {compact ? <p className="canvas-area-summary">{summary ? `${summary.needYou} need you · ${summary.moving} moving` : ''}</p> : null}
    {canEdit ? <div className="canvas-area-resize" data-drag="area-resize" aria-hidden="true"/> : null}
  </section>;
});
