// What the file viewer may show for a file and how: its kind from the type or extension, the allowlisted type its
// object URL gets, the size cap and a small CSV/TSV reader. HTML and SVG are never shown, only offered as a download.

export type ViewerKind = 'image' | 'audio' | 'video' | 'pdf' | 'text' | 'table' | 'none';

/** Files over this are not loaded into the viewer; the dialog offers Download instead. */
export const VIEWER_MAX_BYTES = 25 * 1024 * 1024;
/** Text past this many characters is not shown (a huge <pre> freezes the tab); Download has the rest. */
export const TEXT_DISPLAY_MAX = 1024 * 1024;

/** The first `max` characters of a text and whether anything was left out. */
export function truncateText(text: string, max = TEXT_DISPLAY_MAX): {text: string; cut: boolean} {
  return text.length > max ? {text: text.slice(0, max), cut: true} : {text, cut: false};
}

/** Marks the viewer's overlay and dialog, so popovers that close on an outside press or Escape can leave it alone. */
export const FILE_VIEWER_ATTR = 'data-file-viewer';
/** True when an event's target is inside the file viewer. */
export const insideFileViewer = (target: EventTarget | null) =>
  typeof (target as Element | null)?.closest === 'function' && (target as Element).closest(`[${FILE_VIEWER_ATTR}]`) !== null;
/** True while a file viewer is open: Escape then belongs to it, not to the popover or menu beneath. */
export const fileViewerOpen = (root: Pick<Document, 'querySelector'> = document) => root.querySelector(`[${FILE_VIEWER_ATTR}]`) !== null;
/** For window capture listeners that close popovers: true when the event is the viewer's (a press in it, or any key while open). */
export const fileViewerOwns = (event: Event) =>
  insideFileViewer(event.target) || (typeof document !== 'undefined' && fileViewerOpen());

const RASTER_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif']);
const TEXT_TYPES = new Set(['text/plain', 'text/markdown', 'application/json']);
const TABLE_TYPES = new Set(['text/csv', 'text/tab-separated-values']);
/** Types that could run script or style if rendered: never shown, whatever the file is called. */
const UNSAFE_TYPES = new Set(['image/svg+xml', 'text/html', 'application/xhtml+xml']);

/** The extension's allowlisted object-URL type for each kind that gets one. */
const EXTENSION_TYPES: Record<'image' | 'audio' | 'video', Record<string, string>> = {
  image: {png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif'},
  audio: {
    mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg',
    wav: 'audio/wav', flac: 'audio/flac', webm: 'audio/webm',
  },
  video: {mp4: 'video/mp4', mov: 'video/quicktime', m4v: 'video/mp4', webm: 'video/webm'},
};
const TEXT_EXTENSIONS = new Set(['txt', 'md', 'markdown', 'json', 'log', 'yaml', 'yml']);
const TABLE_EXTENSIONS = new Set(['csv', 'tsv']);

const extension = (name: string) => /\.([a-z0-9]{1,10})$/i.exec(name)?.[1].toLowerCase() ?? '';
/** The bare, lower-case type (`audio/webm;codecs=opus` → `audio/webm`); empty for none or octet-stream. */
const knownType = (mime: string | undefined) => {
  const type = (mime ?? '').split(';')[0].trim().toLowerCase();
  return type === 'application/octet-stream' ? '' : type;
};

function kindOfType(type: string): ViewerKind | null {
  if (UNSAFE_TYPES.has(type)) return 'none';
  if (RASTER_TYPES.has(type)) return 'image';
  if (type.startsWith('image/')) return 'none';
  if (type.startsWith('audio/')) return 'audio';
  if (type.startsWith('video/')) return 'video';
  if (type === 'application/pdf') return 'pdf';
  if (TEXT_TYPES.has(type)) return 'text';
  if (TABLE_TYPES.has(type)) return 'table';
  return null;
}

function kindOfExtension(ext: string): ViewerKind {
  if (EXTENSION_TYPES.image[ext]) return 'image';
  if (ext === 'webm') return 'video'; // audio only when the type says audio/webm, decided above
  if (EXTENSION_TYPES.audio[ext]) return 'audio';
  if (EXTENSION_TYPES.video[ext]) return 'video';
  if (ext === 'pdf') return 'pdf';
  if (TEXT_EXTENSIONS.has(ext)) return 'text';
  if (TABLE_EXTENSIONS.has(ext)) return 'table';
  return 'none';
}

/**
 * How the viewer shows a file: its known type first (ignoring none and `application/octet-stream`, which the agent
 * upload tool sends for most files), else its extension. SVG and HTML are `none` by either.
 */
export function viewerKind(mime: string | undefined, name: string): ViewerKind {
  const type = knownType(mime);
  return (type ? kindOfType(type) : null) ?? kindOfExtension(extension(name));
}

/**
 * The type the viewer's object URL gets, from an allowlist: a raster image, audio or video keeps its known type when
 * that matches the kind, else takes its extension's; a PDF is always `application/pdf`. Text, tables and anything
 * else get no object URL (null): text is read as text.
 */
export function blobType(kind: ViewerKind, mime: string | undefined, name: string): string | null {
  if (kind === 'pdf') return 'application/pdf';
  if (kind !== 'image' && kind !== 'audio' && kind !== 'video') return null;
  const type = knownType(mime);
  const matches = kind === 'image' ? RASTER_TYPES.has(type) : type.startsWith(`${kind}/`);
  if (matches && /^[a-z]+\/[a-z0-9.+-]+$/.test(type)) return type;
  return EXTENSION_TYPES[kind][extension(name)] ?? null;
}

/**
 * A CSV or TSV file as rows of cells: quoted fields may hold the separator, doubled quotes and line breaks. Only the
 * first `maxRows` rows and `maxCols` columns are kept; `cut` says something was left out.
 */
export function parseTable(text: string, separator: ',' | '\t', maxRows = 200, maxCols = 30): {rows: string[][]; cut: boolean} {
  const rows: string[][] = [];
  let row: string[] = [], field = '', quoted = false, started = false, cut = false, i = 0;
  const endField = () => {
    if (row.length < maxCols) row.push(field);
    else cut = true;
    field = '';
  };
  const endRow = () => {
    endField();
    rows.push(row);
    row = [];
    started = false;
  };
  while (i < text.length) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i += 2; continue; }
      if (c === '"') quoted = false;
      else field += c;
      i++;
      continue;
    }
    started = true;
    if (c === '"' && field === '') { quoted = true; i++; continue; }
    if (c === separator) { endField(); i++; continue; }
    if (c === '\r' || c === '\n') {
      endRow();
      i += c === '\r' && text[i + 1] === '\n' ? 2 : 1;
      if (rows.length >= maxRows) {
        if (/\S/.test(text.slice(i))) cut = true;
        return {rows, cut};
      }
      continue;
    }
    field += c;
    i++;
  }
  if (started) endRow();
  return {rows, cut};
}

type ClickLike = {button: number; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; altKey: boolean; defaultPrevented: boolean};
/** Only an unmodified primary click opens the viewer; Ctrl/Cmd/Shift/Alt and middle clicks follow the link. */
export const isPlainClick = (event: ClickLike) =>
  event.button === 0 && !event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey && !event.defaultPrevented;

export type ViewerFile = {name: string; mime?: string; size?: number; href: string};
export type ViewerLoad =
  | {status: 'none'}
  | {status: 'too-large'}
  | {status: 'text'; text: string; cut: boolean}
  | {status: 'table'; rows: string[][]; cut: boolean}
  /** The file's bytes, typed from the allowlist (blobType), for an object URL. */
  | {status: 'media'; blob: Blob};

/** The body, or null as soon as it passes the cap, so a file sent without a length is never read in full. */
async function readCapped(response: Response): Promise<Blob | null> {
  const reader = response.body?.getReader();
  if (!reader) {
    const blob = await response.blob();
    return blob.size > VIEWER_MAX_BYTES ? null : blob;
  }
  const chunks: BlobPart[] = [];
  let total = 0;
  for (;;) {
    const {done, value} = await reader.read();
    if (done) return new Blob(chunks);
    total += value.byteLength;
    if (total > VIEWER_MAX_BYTES) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
}

/**
 * Fetches a file for the viewer (with the person's session, as apiFetch does: the API may be on another origin) unless it is known to pass the cap: by its
 * known size, then the response's `content-length`, then the bytes read. Throws when the request fails or is aborted.
 */
export async function loadViewerFile(file: ViewerFile, kind: ViewerKind, fetchFile: typeof fetch, signal?: AbortSignal): Promise<ViewerLoad> {
  const type = blobType(kind, file.mime, file.name);
  if (kind === 'none' || (kind !== 'text' && kind !== 'table' && !type)) return {status: 'none'};
  if ((file.size ?? 0) > VIEWER_MAX_BYTES) return {status: 'too-large'};
  const response = await fetchFile(file.href, {credentials: 'include', signal});
  if (!response.ok) throw new Error(`The file request failed with ${response.status}.`);
  if (Number(response.headers.get('content-length') ?? 0) > VIEWER_MAX_BYTES) {
    await response.body?.cancel().catch(() => undefined);
    return {status: 'too-large'};
  }
  const body = await readCapped(response);
  if (!body) return {status: 'too-large'};
  if (kind === 'text') return {status: 'text', ...truncateText(await body.text())};
  if (kind === 'table') {
    const tsv = knownType(file.mime) === 'text/tab-separated-values' || extension(file.name) === 'tsv';
    return {status: 'table', ...parseTable(await body.text(), tsv ? '\t' : ',')};
  }
  return {status: 'media', blob: body.slice(0, body.size, type!)};
}

/** What a load ends in: an object URL for media, the text or table, or why nothing is shown. */
export type ViewerResult =
  | {status: 'none'}
  | {status: 'too-large'}
  | {status: 'failed'}
  | {status: 'url'; url: string}
  | {status: 'text'; text: string; cut: boolean}
  | {status: 'table'; rows: string[][]; cut: boolean};

export type ObjectUrls = {createObjectURL(blob: Blob): string; revokeObjectURL(url: string): void};

/**
 * Starts loading a file and reports the result once; the returned stop aborts the request and revokes the object URL.
 * After stop nothing is reported and no URL is made, even when the request settles later.
 */
export function startViewerLoad({file, kind, fetchFile, onResult, urls = URL}: {
  file: ViewerFile; kind: ViewerKind; fetchFile: typeof fetch; onResult(result: ViewerResult): void; urls?: ObjectUrls;
}): () => void {
  const controller = new AbortController();
  let live = true, url: string | null = null;
  loadViewerFile(file, kind, fetchFile, controller.signal).then(result => {
    if (!live) return;
    if (result.status !== 'media') { onResult(result); return; }
    url = urls.createObjectURL(result.blob);
    onResult({status: 'url', url});
  }).catch(() => { if (live) onResult({status: 'failed'}); });
  return () => {
    live = false;
    controller.abort();
    if (url) urls.revokeObjectURL(url);
    url = null;
  };
}

/** Focus goes back to the tile that opened the viewer, when it is still on the page; true when it did. */
export function returnFocus(opener: {isConnected: boolean; focus(options?: FocusOptions): void} | null | undefined): boolean {
  if (!opener?.isConnected) return false;
  opener.focus({preventScroll: true});
  return true;
}
