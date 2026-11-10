// The context side panel: notes, files and linked areas for the canvas or one area. It sits where a
// split-screen chat would. Notes are a plain textarea (no rich text, spec section 4); edits never post to a chat.
import {useCallback,useEffect,useRef,useState,type DragEvent} from 'react';
import {MAX_LINKS_PER_AREA,type ContextReader,type ScopeContext} from '@nest/schemas';
import {formatAttachmentSize,type PendingAttachment} from '../attachments';
import {ChatAttachments} from '../components/ChatAttachments';
import {
  addContextLink,contextFileHref,deleteContextFile,errorText,getContext,getContextReaders,getContextSources,
  putNotes,putNotesKeepalive,removeContextLink,uploadContextFile,type ContextSource,type PanelScope,
} from './context-api';
import {useNotesAutosave} from './notes-autosave';

export const CONTEXT_WARNING = 'Everyone in these chats, including their agents, can see this.';

export type ContextPanelProps = {
  canvasId: string;
  scope: PanelScope;
  /** The area's title (area scope) for the heading. */
  title?: string;
  /** False for view-only members: everything shows, nothing changes. */
  canEdit: boolean;
  /** Files dropped on this area from the canvas: uploaded through the Files section once the panel has loaded. A new id is a new drop. */
  dropped?: {id: number; files: File[]} | null;
  /** The scope holds a chat card, so its people and agents can see this context. */
  holdsChat: boolean;
  /** Notes emptied or filled, files or links changed: the board's chips and dots need a fresh summary. */
  onChanged?(): void;
  onClose(): void;
};

const carriesFiles = (event: DragEvent) => Array.from(event.dataTransfer.types).includes('Files');

export function ContextPanel({canvasId, scope, title, canEdit, dropped, holdsChat, onChanged, onClose}: ContextPanelProps) {
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

  // Focus moves to the heading on open. On close it returns to the opener: the Canvas context button, or the
  // area's options button (its Context… item is gone with the menu), else the canvas.
  const panelRef = useRef<HTMLElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null;
    headingRef.current?.focus({preventScroll: true});
    return () => {
      const view = panelRef.current?.closest<HTMLElement>('.canvas-view') ?? document;
      const opener = areaId
        ? view.querySelector<HTMLElement>(`.canvas-area[data-area-id="${CSS.escape(areaId)}"] .canvas-area-more`)
        : view.querySelector<HTMLElement>('.canvas-context-button');
      const target = [previous, opener, view.querySelector<HTMLElement>('.canvas-surface')].find(element => element?.isConnected);
      // A chat opening in this slot takes focus itself, after this cleanup.
      target?.focus({preventScroll: true});
    };
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

  const heading = scope.kind === 'canvas' ? 'Canvas context' : title || 'Untitled area';
  const label = scope.kind === 'canvas' ? 'Canvas context' : `Context for ${title || 'Untitled area'}`;
  const linked = new Set(context?.links.map(l => l.sourceAreaId) ?? []);
  const choices = (sources ?? []).filter(source => source.areaId !== areaId && !linked.has(source.areaId));
  const groups = [...new Set(choices.map(c => c.canvasId))].map(id => ({name: choices.find(c => c.canvasId === id)!.canvasName, areas: choices.filter(c => c.canvasId === id)}));
  const usedBy = context?.usedBy ?? [];
  const usedByNames = usedBy.flatMap(use => use.title === null ? [] : [use.title || 'Untitled area']);
  const hiddenUses = usedBy.length - usedByNames.length;
  const unconfigured = readers?.some(reader => reader.state === 'unconfigured');

  return <aside ref={panelRef} className={`canvas-context${dropping ? ' is-dropping' : ''}`} aria-label={label}
    // Escape folds the area picker first, then closes the panel.
    onKeyDown={event => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      event.preventDefault();
      if (picker) setPicker(false); else onClose();
    }}
    onDragOver={event => { if (canEdit && carriesFiles(event)) { event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; setDropping(true); } }}
    onDragLeave={event => { if (!(event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget))) setDropping(false); }}
    onDrop={drop}>
    <header className="canvas-context-bar">
      <div className="canvas-context-heading">
        {scope.kind === 'area' ? <span className="canvas-context-eyebrow">Context</span> : null}
        <h2 ref={headingRef} tabIndex={-1}>{heading}</h2>
      </div>
      <button type="button" className="canvas-chat-action" onClick={onClose}>Close</button>
    </header>
    <div className="canvas-context-body">
      {loadFailed ? <p className="canvas-context-error" role="alert">Could not load this context. Close and try again.</p> : !context ? <p className="canvas-context-muted">Loading…</p> : <>
        {holdsChat ? <p className="canvas-context-warning">{CONTEXT_WARNING}</p> : null}
        {!canEdit ? <p className="canvas-context-muted">You can view this canvas but not change it.</p> : null}

        <section className="canvas-context-section">
          <div className="canvas-context-section-head">
            <h3>Notes</h3>
            {canEdit ? <span className="canvas-context-status" role="status">
              {status === 'saving' ? 'Saving…' : status === 'saved' ? 'Saved' : status === 'error' ? 'Not saved' : ''}
            </span> : null}
          </div>
          <textarea className="canvas-context-notes" aria-label="Notes" value={notes} readOnly={!canEdit} maxLength={20_000}
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
          <div className="canvas-context-section-head">
            <h3>Files</h3>
            {canEdit ? <>
              <button type="button" className="canvas-chat-action" onClick={() => fileInput.current?.click()}>Add files</button>
              <input ref={fileInput} className="composer-file-input" type="file" multiple hidden
                onChange={event => { addFiles(Array.from(event.currentTarget.files ?? [])); event.currentTarget.value = ''; }}/>
            </> : null}
          </div>
          {context.files.length ? <ul className="canvas-context-list">
            {context.files.map(file => <li key={file.id} className="canvas-context-file">
              <a href={contextFileHref(canvasId, file.id)} download={file.name}>{file.name}</a>
              <span className="canvas-context-muted">{formatAttachmentSize(file.size) ?? ''}</span>
              {canEdit ? <button type="button" className="canvas-context-remove" aria-label={`Remove ${file.name}`} onClick={() => void removeFile(file.id, file.name)}>Remove</button> : null}
            </li>)}
          </ul> : !uploads.length ? <p className="canvas-context-muted">{canEdit ? 'No files yet. Add some or drop them here.' : 'No files.'}</p> : null}
          <ChatAttachments items={uploads} error={fileError} onRemove={id => setUploads(current => current.filter(row => row.localId !== id))}/>
        </section>

        {scope.kind === 'area' ? <section className="canvas-context-section">
          <div className="canvas-context-section-head">
            <h3>Linked areas</h3>
            {canEdit && context.links.length < MAX_LINKS_PER_AREA
              ? <button type="button" className="canvas-chat-action" aria-expanded={picker} onClick={togglePicker}>Use context from another area</button> : null}
          </div>
          {picker ? <div className="canvas-context-picker" role="group" aria-label="Areas you can use">
            {sources === null ? <p className="canvas-context-muted">Loading areas…</p>
              : !groups.length ? <p className="canvas-context-muted">No other areas to use yet.</p>
              : groups.map(group => <div key={group.name + group.areas[0].canvasId} className="canvas-context-picker-group">
                {group.areas.map(source => <button key={source.areaId} type="button" onClick={() => void link(source.areaId)}>
                  <span className="canvas-context-picker-title">{source.title || 'Untitled area'}</span>
                  <span className="canvas-context-picker-canvas">{source.canvasName}</span>
                </button>)}
              </div>)}
          </div> : null}
          {linkError ? <p className="canvas-context-error" role="alert">{linkError}</p> : null}
          {context.links.length ? <ul className="canvas-context-list">
            {context.links.map(link => <li key={link.sourceAreaId} className={`canvas-context-link${link.available ? '' : ' is-unavailable'}`}>
              <span className="canvas-context-chip">↳ {link.title}</span>
              {link.canvasName ? <span className="canvas-context-muted">{link.canvasName}</span> : null}
              {link.available ? null : <span className="canvas-context-tag">unavailable</span>}
              {canEdit ? <button type="button" className="canvas-context-remove" aria-label={`Remove link to ${link.title}`} onClick={() => void unlink(link.sourceAreaId)}>Remove</button> : null}
            </li>)}
          </ul> : !picker ? <p className="canvas-context-muted">This area uses only its own context.</p> : null}
          {usedBy.length ? <p className="canvas-context-used">
            {usedByNames.length
              ? `Used by ${usedByNames.join(', ')}${hiddenUses ? ` and ${hiddenUses} more` : ''}`
              : `Used by ${hiddenUses} ${hiddenUses === 1 ? 'area' : 'areas'} you can't open`}
          </p> : null}
        </section> : null}

        {scope.kind === 'area' && readers?.length ? <section className="canvas-context-section">
          <h3>Agents</h3>
          <ul className="canvas-context-list canvas-context-readers">
            {readers.filter(reader => reader.state !== 'unconfigured').map(reader => <li key={reader.agentName}>
              {reader.state === 'ready' ? `${reader.agentName} can read this` : `${reader.agentName} can't read context yet (wrapped agent)`}
            </li>)}
            {unconfigured ? <li>Agents can't read context on this server yet</li> : null}
          </ul>
        </section> : null}
      </>}
    </div>
  </aside>;
}
