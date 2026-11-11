// An area ("nest") on the surface: inline rename, a title bar to move it, a corner to resize it and a menu, plus its
// context: the `◱` chip, `↳` link chips, a file shelf when it holds no chats and a "Used by …" footer.
import {memo,useEffect,useRef,useState,type KeyboardEvent} from 'react';
import type {CanvasArea,ContextLink,ContextSummary} from '@nest/schemas';
import {contextFileHref} from './context-api';
import {contextLabel,linkElsewhere,usedByList} from './context-label';
import {FileTile} from './FileTile';

/** Counts for the compact summary line. Task 6 supplies them from live card state. */
export type AreaSummary = {needYou: number; moving: number};
/** The area's context markers from the board's context summary. */
export type AreaContext = Omit<ContextSummary['areas'][number], 'areaId'>;
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
  /** A dragged card or pile chat (`chat`), or a file drag (`files`), would land in this area if dropped now. */
  dropTarget?: 'chat' | 'files' | null;
  /** The area holds no cards: its context files show on a shelf. */
  empty?: boolean;
  /** This area's context popover is open (the chip is its expanded opener). */
  contextOpen?: boolean;
  onRename(areaId: string, title: string): void;
  onDelete(areaId: string): void;
  /** Notes and files here (the chip, the shelf), the areas whose context this one uses (`↳` chips) and its users (the footer). */
  context?: AreaContext;
  /** Opens (or closes) this area's context popover under `opener`; offered to viewers too, read-only. */
  onContext?(areaId: string, opener: HTMLElement): void;
  /** A `↳`/`↗` link chip is pressed: show its source (the mock's goref). Without it the chip opens this area's context. */
  onLinkOpen?(areaId: string, link: ContextLink, opener: HTMLElement): void;
  /** A link chip is hovered or focused (sourceAreaId), or no longer is (null). */
  onLinkHover?(areaId: string, sourceAreaId: string | null): void;
};

export const Area = memo(function Area({area, dx, dy, w, h, canEdit, compact, summary, dropTarget = null, empty = false, contextOpen = false, onRename, onDelete, context, onContext, onLinkOpen, onLinkHover}: AreaProps) {
  const [editing, setEditing] = useState(false);
  const [menu, setMenu] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  // Enter commits and unmounts the input; a blur that follows must not commit again.
  const committed = useRef(false);

  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuId = `canvas-area-actions-${area.id}`;

  // A disclosure of plain buttons: Tab moves through them, Escape closes and returns focus to the trigger.
  useEffect(() => {
    if (!menu) return;
    const outside = (event: PointerEvent) => { if (!menuRef.current?.contains(event.target as Node)) setMenu(false); };
    const escape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      const inside = menuRef.current?.contains(document.activeElement);
      setMenu(false);
      if (inside) triggerRef.current?.focus();
    };
    window.addEventListener('pointerdown', outside, true);
    window.addEventListener('keydown', escape);
    return () => { window.removeEventListener('pointerdown', outside, true); window.removeEventListener('keydown', escape); };
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

  const title = area.title || 'Untitled area';
  const label = context ? contextLabel(context, canEdit ? 'Add context' : 'No context') : null;
  const usedBy = context ? usedByList(context.usedBy) : '';
  const shelf = !compact && empty && context?.files.length ? context.files : null;
  return <section
    className={`canvas-area${dropTarget ? ' is-drop-target' : ''}`}
    aria-label={`Area ${area.title}`}
    data-area-id={area.id}
    data-tint={area.tint}
    style={{width: w, height: h, transform: `translate(${area.x + dx}px, ${area.y + dy}px)`}}>
    <div className="canvas-area-bar" data-drag={canEdit ? 'area' : undefined}>
      {editing
        ? <input className="canvas-area-input" aria-label="Area title" defaultValue={area.title} maxLength={120} autoFocus
            onFocus={event => event.currentTarget.select()} onKeyDown={key} onBlur={event => commit(event.currentTarget.value)}/>
        : <h3 className="canvas-area-title" onDoubleClick={canEdit ? edit : undefined}>{area.title}</h3>}
      {label && onContext && !compact ? <button type="button" className={`canvas-area-ctx${context!.hasContext ? ' has-context' : ''}`}
        aria-label={`Context for ${title}: ${label}`} aria-haspopup="dialog" aria-expanded={contextOpen}
        title="Notes and files every chat in this area can see" onClick={event => onContext(area.id, event.currentTarget)}>
        <span aria-hidden="true">◱</span> {label}
      </button> : null}
      {context?.links.length && !compact ? <div className="canvas-context-chips">
        {context.links.map(link => {
          const other = linkElsewhere(link, area.canvasId);
          return <button key={link.sourceAreaId} type="button" className={`canvas-context-chip${link.available ? '' : ' is-unavailable'}`}
            title={link.available ? `Uses ${other && link.canvasName ? `${link.canvasName} › ` : ''}${link.title}'s context (linked, not copied)` : `${link.title} is unavailable`}
            onClick={event => onLinkOpen ? onLinkOpen(area.id, link, event.currentTarget) : onContext?.(area.id, event.currentTarget)}
            onPointerEnter={() => onLinkHover?.(area.id, link.sourceAreaId)} onPointerLeave={() => onLinkHover?.(area.id, null)}
            onFocus={() => onLinkHover?.(area.id, link.sourceAreaId)} onBlur={() => onLinkHover?.(area.id, null)}>
            {other ? '↗' : '↳'} {link.title}{link.available ? null : <span className="canvas-context-tag"> unavailable</span>}
          </button>;
        })}
      </div> : null}
      {canEdit ? <div className="canvas-area-menu" ref={menuRef}
        onBlur={event => { if (!menuRef.current?.contains(event.relatedTarget as Node | null)) setMenu(false); }}>
        <button ref={triggerRef} type="button" className="canvas-area-more" aria-label="Area options" aria-expanded={menu} aria-controls={menu ? menuId : undefined}
          onClick={() => setMenu(open => !open)}>
          <span aria-hidden="true">⋯</span>
        </button>
        {menu ? <div id={menuId} className="canvas-menu">
          <button type="button" onClick={() => { setMenu(false); edit(); }}>Rename area</button>
          <button type="button" onClick={() => { setMenu(false); onDelete(area.id); }}>Delete area</button>
        </div> : null}
      </div> : null}
    </div>
    {compact ? <p className="canvas-area-summary">{summary ? `${summary.needYou} need you · ${summary.moving} moving` : ''}</p> : null}
    {shelf ? <ul className="canvas-area-shelf canvas-file-tiles" aria-label={`Files in ${title}`}>
      {shelf.map(file => <FileTile key={file.id} name={file.name} mime={file.mime} href={contextFileHref(area.canvasId, file.id)}/>)}
      {context!.fileCount > shelf.length && onContext ? <li className="canvas-file-tile is-more">
        <button type="button" onClick={event => onContext(area.id, event.currentTarget)}>+{context!.fileCount - shelf.length} more</button>
      </li> : null}
    </ul> : null}
    {usedBy && !compact ? <p className="canvas-area-usedby">Used by {usedBy}. Edit here once, they all see it.</p> : null}
    {canEdit ? <div className="canvas-area-resize" data-drag="area-resize" aria-hidden="true"/> : null}
    {dropTarget ? <p className="canvas-area-drop-hint" aria-hidden="true">
      {dropTarget === 'files' ? `Add to ${title}'s context` : `Place in ${title} · shares its context`}
    </p> : null}
  </section>;
});
