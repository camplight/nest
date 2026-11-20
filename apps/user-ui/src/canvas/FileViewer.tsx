// The file viewer: one dialog that shows or plays a file in place (pictures, audio, video, PDFs, text, CSV/TSV) with
// Download and close. It fetches the file itself and makes a typed object URL from an allowlist, because the engine
// sends most files as downloads; HTML and SVG are never rendered. Portalled to the body so the canvas's zoom
// transform cannot move it, and its events stop at its edge so the canvas and cards never see them.
import {useEffect,useState,type DragEvent,type SyntheticEvent} from 'react';
import {Dialog} from 'radix-ui';
import {formatAttachmentSize} from '../attachments';
import {fileTypeLabel} from './context-label';
import {FileTile,type FileTileProps} from './FileTile';
import {VIEWER_MAX_BYTES,returnFocus,startViewerLoad,viewerKind,type ViewerFile,type ViewerKind,type ViewerResult} from './file-viewer';
import './file-tile.css';

export type ViewerState = {status: 'loading'} | ViewerResult;

export const VIEWER_COPY = {
  tooLarge: 'Too large to preview here.',
  failed: 'Could not open this file. Download it instead.',
  none: 'No preview for this file type.',
} as const;

/** What can be decided before any request: nothing to show, known to pass the cap, else loading. */
function firstState(file: ViewerFile, kind: ViewerKind): ViewerState {
  if (kind === 'none') return {status: 'none'};
  if ((file.size ?? 0) > VIEWER_MAX_BYTES) return {status: 'too-large'};
  return {status: 'loading'};
}

/**
 * Loads the file while mounted (the dialog content mounts only while open). Closing or unmounting aborts the request
 * and revokes the object URL; after that no URL is made and no state is set (startViewerLoad).
 */
export function useViewerFile(file: ViewerFile, kind: ViewerKind, fetchFile: typeof fetch, enabled = true): ViewerState {
  const [state, setState] = useState<ViewerState>(() => firstState(file, kind));
  const {name, mime, size, href} = file;
  useEffect(() => {
    const first = firstState({name, mime, size, href}, kind);
    setState(first);
    if (!enabled || first.status !== 'loading') return;
    return startViewerLoad({file: {name, mime, size, href}, kind, fetchFile, onResult: setState});
  }, [name, mime, size, href, kind, fetchFile, enabled]);
  return state;
}

const stop = (event: SyntheticEvent) => event.stopPropagation();
/** A file dragged over the dialog is neither taken by the canvas nor opened by the browser. */
const refuseDrop = (event: DragEvent) => { event.stopPropagation(); event.preventDefault(); event.dataTransfer.dropEffect = 'none'; };
/**
 * The dialog is a React child of a card or tile even though it renders on the body, so its events would bubble to
 * them (canvas pan and drag, file drops, keyboard moves). They stop at its edge. That also keeps pointer presses from
 * the document, where Radix would look for a press outside, so the overlay closes the dialog itself; Escape still
 * closes because Radix listens for it on the document in the capture phase.
 */
const STOP_EVENTS = {
  onPointerDown: stop, onPointerMove: stop, onPointerUp: stop, onPointerCancel: stop, onMouseDown: stop, onMouseUp: stop,
  onClick: stop, onDoubleClick: stop, onContextMenu: stop, onWheel: stop, onKeyDown: stop, onDragStart: stop,
  onDragOver: refuseDrop, onDrop: refuseDrop,
};

export function FileViewerBody({name, kind, state}: {name: string; kind: ViewerKind; state: ViewerState}) {
  switch (state.status) {
    case 'loading': return <p className="file-viewer-note" role="status">Loading…</p>;
    case 'none': return <p className="file-viewer-note">{VIEWER_COPY.none}</p>;
    case 'too-large': return <p className="file-viewer-note">{VIEWER_COPY.tooLarge}</p>;
    case 'failed': return <p className="file-viewer-note" role="alert">{VIEWER_COPY.failed}</p>;
    case 'text': return <pre className="file-viewer-text" tabIndex={0}>{state.text}</pre>;
    case 'table': {
      const [head = [], ...rows] = state.rows;
      return <div className="file-viewer-table">
        <div className="file-viewer-table-scroll" tabIndex={0}>
          <table>
            <thead><tr>{head.map((cell, i) => <th key={i} scope="col">{cell}</th>)}</tr></thead>
            <tbody>{rows.map((row, r) => <tr key={r}>{row.map((cell, i) => <td key={i}>{cell}</td>)}</tr>)}</tbody>
          </table>
        </div>
        {state.cut ? <p className="file-viewer-note">Showing the first 200 rows and 30 columns.</p> : null}
      </div>;
    }
    case 'url':
      if (kind === 'image') return <img className="file-viewer-image" src={state.url} alt={name}/>;
      if (kind === 'audio') return <audio className="file-viewer-audio" src={state.url} controls autoPlay/>;
      if (kind === 'video') return <video className="file-viewer-video" src={state.url} controls autoPlay playsInline/>;
      if (kind === 'pdf') return <iframe className="file-viewer-pdf" src={state.url} title={name}/>;
      return <p className="file-viewer-note">{VIEWER_COPY.none}</p>;
  }
}

/**
 * The dialog's content: title, `type · size`, Download, close and the body. Exported for tests. On close, focus goes
 * back to `opener` (the tile): with no Dialog.Trigger, Radix would otherwise leave it on the body.
 */
export function FileViewerContent({file, fetchFile = fetch, opener}: {file: ViewerFile; fetchFile?: typeof fetch; opener?: HTMLElement | null}) {
  const kind = viewerKind(file.mime, file.name);
  const state = useViewerFile(file, kind, fetchFile);
  const details = [fileTypeLabel(file.mime, file.name), formatAttachmentSize(file.size)].filter(Boolean).join(' · ');
  return <Dialog.Content className="file-viewer" data-kind={kind} {...STOP_EVENTS}
    onCloseAutoFocus={event => { if (returnFocus(opener)) event.preventDefault(); }}>
    <header className="file-viewer-head">
      <div className="file-viewer-heading">
        <Dialog.Title className="file-viewer-title">{file.name}</Dialog.Title>
        <Dialog.Description className="file-viewer-details">{details}</Dialog.Description>
      </div>
      <a className="file-viewer-download" href={file.href} download={file.name}>Download</a>
      <Dialog.Close className="file-viewer-close" aria-label="Close"><span aria-hidden="true">✕</span></Dialog.Close>
    </header>
    <div className="file-viewer-body"><FileViewerBody name={file.name} kind={kind} state={state}/></div>
  </Dialog.Content>;
}

export function FileViewer({file, open, onOpenChange, fetchFile = fetch, opener}: {
  file: ViewerFile; open: boolean; onOpenChange(open: boolean): void; fetchFile?: typeof fetch;
  /** What gets focus back on close, normally the tile's link. */
  opener?: HTMLElement | null;
}) {
  if (!open) return null;
  return <Dialog.Root open onOpenChange={onOpenChange}>
    <Dialog.Portal>
      <Dialog.Overlay className="file-viewer-overlay" {...STOP_EVENTS} onClick={event => { stop(event); onOpenChange(false); }}/>
      <FileViewerContent file={file} fetchFile={fetchFile} opener={opener}/>
    </Dialog.Portal>
  </Dialog.Root>;
}

/** A file tile whose plain click opens the viewer (focus returns to the tile on close); any other click keeps the link. */
export function ViewableFileTile(props: Omit<FileTileProps, 'onOpen'>) {
  const [opener, setOpener] = useState<HTMLElement | null>(null);
  return <>
    <FileTile {...props} onOpen={event => setOpener(event.currentTarget)}/>
    {opener ? <FileViewer file={{name: props.name, mime: props.mime, size: props.size, href: props.href}} open opener={opener}
      onOpenChange={open => { if (!open) setOpener(null); }}/> : null}
  </>;
}
