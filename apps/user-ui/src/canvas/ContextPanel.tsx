// The context popover: notes, files and linked areas for the canvas or one area, anchored under the control that
// opened it (an area's `◱` chip, a `↳` chip, the chat header's "sees N contexts" or the Canvas context button). It
// floats over the canvas, so an open chat stays open beside it; on phones it is a bottom sheet. Notes are a plain
// textarea (no rich text, spec section 4); edits never post to a chat.
import {useCallback,useEffect,useLayoutEffect,useRef,useState,type CSSProperties,type DragEvent} from 'react';
import {MAX_LINKS_PER_AREA,type ContextReader,type ScopeContext} from '@nest/schemas';
import type {PendingAttachment} from '../attachments';
import {ChatAttachments} from '../components/ChatAttachments';
import {
  addContextLink,contextFileHref,deleteContextFile,errorText,getContext,getContextReaders,getContextSources,
  putNotes,putNotesKeepalive,removeContextLink,uploadContextFile,type ContextSource,type PanelScope,
} from './context-api';
import {useNotesAutosave} from './notes-autosave';
import {contextLabel,linkDetail,linkElsewhere,usedByList} from './context-label';
import {FileTile} from './FileTile';

export const CONTEXT_WARNING = 'Everyone in these chats, including their agents, can see this.';

export type ContextPanelProps = {
  canvasId: string;
  /** This canvas's name: the canvas scope's heading, and the picker's "On {canvas}" group. */
  canvasName: string;
  scope: PanelScope;
  /** The control that opened the popover: it sits under it, and focus goes back to it on close. */
  anchor: HTMLElement | null;
  /** The area's title (area scope) for the heading. */
  title?: string;
  /** False for view-only members: everything shows, nothing changes. */
  canEdit: boolean;
  /** Files dropped on this area while its popover is open: uploaded here, with progress, once it has loaded. A new id is a new drop. */
  dropped?: {id: number; files: File[]} | null;
  /** The scope holds a chat card, so its people and agents can see this context. */
  holdsChat: boolean;
  /** Notes emptied or filled, files or links changed: the board's chips and dots need a fresh summary. */
  onChanged?(): void;
  onClose(): void;
};

const carriesFiles = (event: DragEvent) => Array.from(event.dataTransfer.types).includes('Files');

/** Room kept between the popover and the window's edges, and between it and its opener. */
const EDGE = 16, GAP = 8;
/** Phones get a bottom sheet instead (the 760 px canvas breakpoint, see canvas.css). */
const SHEET_QUERY = '(max-width: 760px)';

export function ContextPanel({canvasId, canvasName, scope, anchor, title, canEdit, dropped, holdsChat, onChanged, onClose}: ContextPanelProps) {
  const areaId = scope.kind === 'area' ? scope.areaId : null;
  const [context, setContext] = useState<ScopeContext | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [uploads, setUploads] = useState<PendingAttachment[]>([]);
  const [fileError, setFileError] = useState<string | null>(null);
  const [dropping, setDropping] = useState(false);
  const [picker, setPicker] = useState(false);
  const [sources, setSources] = useState<ContextSource[] | null>(null);
  const [linkError, setLinkError] = useState<string | null>(null);
  const [readers, setReaders] = useState<ContextReader[] | null>(null);

  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const changedRef = useRef(onChanged); changedRef.current = onChanged;
  const changed = () => changedRef.current?.();
  const fileInput = useRef<HTMLInputElement>(null);

  const loadReaders = useCallback(() => {
    if (!areaId) return;
    getContextReaders(canvasId, areaId).then(rows => { if (mounted.current) setReaders(rows); }).catch(() => {});
  }, [canvasId, areaId]);

  // Notes: saved 800 ms after typing stops, on close, and (keepalive) when the page goes away.
  const {text: notes, status, conflict, notes: autosave} = useNotesAutosave({
    save: (text, version) => putNotes(canvasId, scope, text, version),
    keep: (text, version) => putNotesKeepalive(canvasId, scope, text, version),
    onSaved: ({wasEmpty, next}) => { if (wasEmpty !== (next.notes.length === 0)) { changed(); loadReaders(); } },
  });

  useEffect(() => {
    let current = true;
    getContext(canvasId, scope).then(loaded => {
      if (!current) return;
      setContext(loaded);
      autosave.load(loaded.notes, loaded.version);
    }).catch(() => { if (current) setLoadFailed(true); });
    loadReaders();
    return () => { current = false; };
    // The panel is keyed by scope, so it loads once.
  }, []);

  // Focus moves to the heading on open. On close it returns to the opener, else to what was focused before, else the canvas.
  const panelRef = useRef<HTMLDivElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const anchorRef = useRef(anchor); anchorRef.current = anchor;
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null;
    headingRef.current?.focus({preventScroll: true});
    return () => {
      const view = panelRef.current?.closest<HTMLElement>('.canvas-view') ?? document;
      const target = [anchorRef.current, previous, view.querySelector<HTMLElement>('.canvas-surface')].find(element => element?.isConnected);
      target?.focus({preventScroll: true});
    };
  }, []);

  // Anchored under the opener and kept inside the window (the mock's openCtx): flipped above it when there is no
  // room below. Re-measured when the popover's content or the window changes size; phones use a bottom sheet.
  const [place, setPlace] = useState<{left: number; top: number} | null>(null);
  useLayoutEffect(() => {
    const element = panelRef.current;
    if (!element) return;
    const measure = () => {
      if (typeof matchMedia === 'function' && matchMedia(SHEET_QUERY).matches) { setPlace(null); return; }
      const box = element.getBoundingClientRect(), at = anchorRef.current?.isConnected ? anchorRef.current.getBoundingClientRect() : null;
      const width = box.width, height = box.height, maxLeft = window.innerWidth - width - EDGE, maxTop = window.innerHeight - height - EDGE;
      const left = Math.max(EDGE, Math.min(maxLeft, at ? at.left : (window.innerWidth - width) / 2));
      const below = at ? at.bottom + GAP : EDGE * 4, above = at ? at.top - GAP - height : -1;
      const top = below <= maxTop ? below : above >= EDGE ? above : Math.max(EDGE, maxTop);
      setPlace(current => current?.left === left && current.top === top ? current : {left, top});
    };
    measure();
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(measure) : null;
    observer?.observe(element);
    window.addEventListener('resize', measure);
    return () => { observer?.disconnect(); window.removeEventListener('resize', measure); };
  }, [anchor]);

  // A press anywhere outside closes it; the opener toggles it itself.
  const closeRef = useRef(onClose); closeRef.current = onClose;
  useEffect(() => {
    const outside = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (!target || panelRef.current?.contains(target) || anchorRef.current?.contains(target)) return;
      closeRef.current();
    };
    window.addEventListener('pointerdown', outside, true);
    return () => window.removeEventListener('pointerdown', outside, true);
  }, []);

  function addFiles(files: File[]) {
    if (!canEdit || !files.length) return;
    setFileError(null);
    const items = files.map(file => ({localId: crypto.randomUUID(), name: file.name || 'upload', mime: file.type || 'application/octet-stream', size: file.size, status: 'uploading' as const, progress: 0, file}));
    setUploads(current => [...current, ...items]);
    items.forEach(item => {
      uploadContextFile(canvasId, scope, item.file, progress => {
        if (mounted.current) setUploads(current => current.map(row => row.localId === item.localId && row.status === 'uploading' ? {...row, progress} : row));
      }).then(file => {
        changed();
        loadReaders();
        if (!mounted.current) return;
        setUploads(current => current.filter(row => row.localId !== item.localId));
        setContext(current => current && {...current, files: [...current.files.filter(f => f.id !== file.id), file]});
      }).catch(error => {
        if (mounted.current) setUploads(current => current.map(row => row.localId === item.localId ? {...row, status: 'error', error: errorText(error, 'Upload failed')} : row));
      });
    });
  }
  async function removeFile(fileId: string, name: string) {
    try {
      await deleteContextFile(canvasId, scope, fileId);
      changed();
      if (mounted.current) setContext(current => current && {...current, files: current.files.filter(f => f.id !== fileId)});
    } catch (error) {
      if (mounted.current) setFileError(`Could not remove ${name}. ${errorText(error, 'Try again.')}`);
    }
  }
  // Dropped on the canvas: waits for the context to load, because an upload that finished first would have no list to join.
  const handledDrop = useRef(0);
  useEffect(() => {
    if (!dropped || !context || dropped.id === handledDrop.current) return;
    handledDrop.current = dropped.id;
    addFiles(dropped.files);
  }, [dropped, context]);
  function drop(event: DragEvent) {
    if (!canEdit || !carriesFiles(event)) return;
    event.preventDefault();
    setDropping(false);
    addFiles(Array.from(event.dataTransfer.files));
  }

  function togglePicker() {
    setLinkError(null);
    setPicker(open => !open);
    if (!picker) getContextSources().then(rows => { if (mounted.current) setSources(rows); }).catch(() => { if (mounted.current) setLinkError('Could not load areas. Try again.'); });
  }
  async function link(sourceAreaId: string) {
    if (!areaId) return;
    setLinkError(null);
    try {
      const next = await addContextLink(canvasId, areaId, sourceAreaId);
      changed();
      loadReaders();
      if (!mounted.current) return;
      // Only the links change here; an upload that finished meanwhile stays listed.
      setContext(current => current && {...current, links: next.links, usedBy: next.usedBy});
      setPicker(false);
    } catch (error) {
      if (mounted.current) setLinkError(errorText(error, 'Could not use that area. Try again.'));
    }
  }
  async function unlink(sourceAreaId: string) {
    if (!areaId) return;
    setLinkError(null);
    try {
      await removeContextLink(canvasId, areaId, sourceAreaId);
      changed();
      if (mounted.current) setContext(current => current && {...current, links: current.links.filter(l => l.sourceAreaId !== sourceAreaId)});
    } catch (error) {
      if (mounted.current) setLinkError(errorText(error, 'Could not remove the link. Try again.'));
    }
  }

  const name = scope.kind === 'canvas' ? canvasName || 'this canvas' : title || 'Untitled area';
  const label = scope.kind === 'canvas' ? 'Canvas context' : `Context for ${title || 'Untitled area'}`;
  const linked = new Set(context?.links.map(l => l.sourceAreaId) ?? []);
  const choices = (sources ?? []).filter(source => source.areaId !== areaId && !linked.has(source.areaId));
  const here = choices.filter(choice => choice.canvasId === canvasId), elsewhere = choices.filter(choice => choice.canvasId !== canvasId);
  const usedBy = usedByList(context?.usedBy ?? []);
  const unconfigured = readers?.some(reader => reader.state === 'unconfigured');
  const style = place ? {'--context-left': `${place.left}px`, '--context-top': `${place.top}px`} as CSSProperties : undefined;

  return <div ref={panelRef} role="dialog" className={`canvas-context${dropping ? ' is-dropping' : ''}${place ? ' is-placed' : ''}`} aria-label={label} style={style}
    // Escape folds the area picker first, then closes the popover.
    onKeyDown={event => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      event.preventDefault();
      if (picker) setPicker(false); else onClose();
    }}
    onDragOver={event => { if (canEdit && carriesFiles(event)) { event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; setDropping(true); } }}
    onDragLeave={event => { if (!(event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget))) setDropping(false); }}
    onDrop={drop}>
    <header className="canvas-context-head">
      <h2 ref={headingRef} tabIndex={-1}>Context · {name}</h2>
      <p className="canvas-context-explainer">
        {scope.kind === 'canvas' ? 'Every chat on this canvas sees this.' : 'Every chat in this area sees this, on top of the canvas context.'} Agents read it as files.
      </p>
    </header>
    <div className="canvas-context-body">
      {loadFailed ? <p className="canvas-context-error" role="alert">Could not load this context. Close and try again.</p> : !context ? <p className="canvas-context-muted">Loading…</p> : <>
        {holdsChat || context?.inChats ? <p className="canvas-context-warning">{CONTEXT_WARNING}</p> : null}
        {!canEdit ? <p className="canvas-context-muted">You can view this canvas but not change it.</p> : null}

        <section className="canvas-context-section">
          <div className="canvas-context-section-head">
            <h3 className="canvas-context-label">Notes</h3>
            {canEdit ? <span className="canvas-context-status" role="status">
              {status === 'saving' ? 'Saving…' : status === 'saved' ? 'Saved' : status === 'error' ? 'Not saved' : ''}
            </span> : null}
          </div>
          <textarea className="canvas-context-notes" aria-label="Notes" value={notes} readOnly={!canEdit} maxLength={20_000} rows={3}
            placeholder={canEdit ? 'What should everyone here know?' : ''} onChange={event => autosave.type(event.target.value)}
            onBlur={() => { if (canEdit) void autosave.flush(); }}/>
          {conflict ? <div className="canvas-context-conflict" role="alert">
            <span>Someone else changed these notes.</span>
            <button type="button" className="canvas-chat-action" onClick={autosave.loadTheirs}>Load their version</button>
          </div> : null}
          {status === 'error' ? <div className="canvas-context-conflict" role="alert">
            <span>Could not save the notes.</span>
            <button type="button" className="canvas-chat-action" onClick={() => void autosave.retry()}>Try again</button>
          </div> : null}
        </section>

        <section className="canvas-context-section">
          <h3 className="canvas-context-label">Files</h3>
          {context.files.length ? <ul className="canvas-file-tiles" aria-label="Files">
            {context.files.map(file => <FileTile key={file.id} name={file.name} mime={file.mime} href={contextFileHref(canvasId, file.id)}
              onRemove={canEdit ? () => void removeFile(file.id, file.name) : undefined}/>)}
          </ul> : !uploads.length ? <p className="canvas-context-muted">{canEdit ? 'No files yet. Drop some here or use Add files.' : 'No files.'}</p> : null}
          <ChatAttachments items={uploads} error={fileError} onRemove={id => setUploads(current => current.filter(row => row.localId !== id))}/>
        </section>

        {scope.kind === 'area' ? <section className="canvas-context-section">
          <h3 className="canvas-context-label">Also uses</h3>
          {context.links.length ? <ul className="canvas-context-refs">
            {context.links.map(link => {
              const detail = linkDetail(link, canvasId), other = linkElsewhere(link, canvasId);
              return <li key={link.sourceAreaId} className={`canvas-context-ref${link.available ? '' : ' is-unavailable'}`}>
                <span className="canvas-context-ref-icon" data-kind={other ? 'canvas' : 'area'} aria-hidden="true">{other ? '↗' : '↳'}</span>
                <span className="canvas-context-ref-text">
                  <span className="canvas-context-ref-title">{link.title}</span>
                  {detail ? <small className={link.available ? undefined : 'canvas-context-tag'}>{detail}</small> : null}
                </span>
                {canEdit ? <button type="button" className="canvas-context-unlink" aria-label={`Stop using ${link.title}`} title="Stop using" onClick={() => void unlink(link.sourceAreaId)}>
                  <span aria-hidden="true">✕</span>
                </button> : null}
              </li>;
            })}
          </ul> : <p className="canvas-context-muted">Nothing linked.{canEdit ? ' Link another area instead of copying its files here.' : ''}</p>}
          {canEdit && context.links.length < MAX_LINKS_PER_AREA
            ? <button type="button" className="canvas-context-add" aria-expanded={picker} onClick={togglePicker}>+ Use context from another area</button> : null}
          {picker ? <div className="canvas-context-picker" role="group" aria-label="Areas you can use">
            {sources === null ? <p className="canvas-context-muted">Loading areas…</p>
              : !choices.length ? <p className="canvas-context-muted">No other areas to use yet.</p>
              : <>
                {here.length ? <p className="canvas-context-picker-group">On {canvasName || 'this canvas'}</p> : null}
                {here.map(source => <button key={source.areaId} type="button" onClick={() => void link(source.areaId)}>
                  <span className="canvas-context-picker-title">{source.title || 'Untitled area'}</span>
                  <small>{contextLabel(source.counts, 'Nothing yet')}</small>
                </button>)}
                {elsewhere.length ? <p className="canvas-context-picker-group">Other canvases</p> : null}
                {elsewhere.map(source => <button key={source.areaId} type="button" onClick={() => void link(source.areaId)}>
                  <span className="canvas-context-picker-title">{source.canvasName} › {source.title || 'Untitled area'}</span>
                  <small>{contextLabel(source.counts, 'Nothing yet')}</small>
                </button>)}
              </>}
          </div> : null}
          {linkError ? <p className="canvas-context-error" role="alert">{linkError}</p> : null}
          {usedBy ? <p className="canvas-context-used">Used by {usedBy}. Changes here reach them right away.</p> : null}
        </section> : null}

        {scope.kind === 'area' && readers?.length ? <section className="canvas-context-section">
          <h3 className="canvas-context-label">Agents</h3>
          <ul className="canvas-context-readers">
            {readers.filter(reader => reader.state !== 'unconfigured').map(reader => <li key={reader.agentName}>
              {reader.state === 'ready' ? `${reader.agentName} can read this` : `${reader.agentName} can't read context yet (wrapped agent)`}
            </li>)}
            {unconfigured ? <li>Agents can't read context on this server yet</li> : null}
          </ul>
        </section> : null}
      </>}
    </div>
    <footer className="canvas-context-foot">
      {canEdit && context ? <>
        <button type="button" className="canvas-chat-action" onClick={() => fileInput.current?.click()}>Add files</button>
        <input ref={fileInput} className="composer-file-input" type="file" multiple hidden
          onChange={event => { addFiles(Array.from(event.currentTarget.files ?? [])); event.currentTarget.value = ''; }}/>
      </> : null}
      <button type="button" className="canvas-button canvas-context-done" onClick={onClose}>Done</button>
    </footer>
  </div>;
}
