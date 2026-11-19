// The words the canvas uses for context: chip labels, "Used by …" sentences, file kinds and type names, and what an open chat sees.
import type {BoardCard,ContextCounts,ContextLink,ContextUse} from '@nest/schemas';

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** `Notes · 2 files · 1 link`, `Notes`, `1 file`, or `empty` (`Add context` for editors) when there is nothing. */
export function contextLabel(counts: ContextCounts, empty = 'Add context') {
  return [counts.notes ? 'Notes' : '', counts.fileCount ? plural(counts.fileCount, 'file') : '', counts.linkCount ? plural(counts.linkCount, 'link') : ''].filter(Boolean).join(' · ') || empty;
}

/** `A`, `A and B`, `A, B and C`. */
export function joinNames(names: string[]) {
  return names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/** The areas using an area, with those the viewer cannot open counted but never named. Empty when nothing uses it. */
export function usedByList(uses: ContextUse[]) {
  const names = uses.flatMap(use => use.title === null ? [] : [use.title || 'Untitled area']);
  const hidden = uses.length - names.length;
  return joinNames([...names, ...(hidden ? [`${plural(hidden, 'area')} you can't open`] : [])]);
}

/** A link's second line in the popover: the other canvas, if any, then its counts or why it shows none. */
export function linkDetail(link: ContextLink, canvasId: string) {
  const where = link.canvasName && link.canvasId !== canvasId ? `on ${link.canvasName}` : '';
  const what = !link.available ? 'unavailable' : link.counts ? contextLabel(link.counts, 'Nothing yet') : '';
  return [where, what].filter(Boolean).join(' · ');
}

/** True when the link's source lives on another canvas than the one shown (`↗` rather than `↳`). */
export const linkElsewhere = (link: ContextLink, canvasId: string) => link.canvasId !== null && link.canvasId !== canvasId;

export type FileKind = 'doc' | 'sheet' | 'slides' | 'image' | 'audio' | 'video';
// Extensions decide first: the agent upload tool sends no specific type for Office files.
const EXTENSION_KIND: Record<string, FileKind> = {
  pdf: 'doc', doc: 'doc', docx: 'doc', odt: 'doc', rtf: 'doc', txt: 'doc', md: 'doc',
  xls: 'sheet', xlsx: 'sheet', ods: 'sheet', csv: 'sheet', tsv: 'sheet',
  ppt: 'slides', pptx: 'slides', odp: 'slides',
  png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image', svg: 'image', avif: 'image', bmp: 'image', heic: 'image',
  mp3: 'audio', wav: 'audio', m4a: 'audio', aac: 'audio', flac: 'audio', oga: 'audio', opus: 'audio',
  mov: 'video', m4v: 'video', mkv: 'video', avi: 'video',
};
/** Extensions that hold either sound or pictures (an MP4 can be audio only): the type decides, else these. */
const EITHER: Record<string, 'audio' | 'video'> = {webm: 'video', ogg: 'audio', mp4: 'video'};
/** `.key` is a Keynote deck only with no type or a Keynote one; a key file (`server.key`, PEM or PGP) is a document. */
const keynote = (ext: string, type: string) =>
  ext === 'key' && (type === '' || type === 'application/octet-stream' || /keynote/.test(type));
const extension = (name: string) => /\.([a-z0-9]{1,8})$/i.exec(name)?.[1].toLowerCase() ?? '';
const mediaKind = (mime: string): 'image' | 'audio' | 'video' | null =>
  mime.startsWith('image/') ? 'image' : mime.startsWith('audio/') ? 'audio' : mime.startsWith('video/') ? 'video' : null;

/** The tile glyph for a file: its extension first, then its type. Anything unrecognised is a document. */
export function fileKind(mime: string | undefined, name: string): FileKind {
  const ext = extension(name), type = (mime ?? '').toLowerCase();
  if (EXTENSION_KIND[ext]) return EXTENSION_KIND[ext];
  if (keynote(ext, type)) return 'slides';
  const media = mediaKind(type);
  if (media) return media;
  if (EITHER[ext]) return EITHER[ext];
  if (/sheet|csv|excel/.test(type)) return 'sheet';
  if (/presentation|powerpoint/.test(type)) return 'slides';
  return 'doc';
}

const EXTENSION_LABEL: Record<string, string> = {
  pdf: 'PDF', doc: 'Word document', docx: 'Word document', odt: 'OpenDocument text', rtf: 'Rich text', txt: 'Text', md: 'Markdown',
  xls: 'Excel spreadsheet', xlsx: 'Excel spreadsheet', ods: 'OpenDocument spreadsheet', csv: 'CSV', tsv: 'TSV',
  ppt: 'PowerPoint slides', pptx: 'PowerPoint slides', odp: 'OpenDocument slides',
};
const MIME_LABEL: [RegExp, string][] = [
  [/^application\/pdf$/, 'PDF'], [/wordprocessingml|msword/, 'Word document'], [/spreadsheetml|ms-excel/, 'Excel spreadsheet'],
  [/presentationml|ms-powerpoint/, 'PowerPoint slides'], [/^text\/csv$/, 'CSV'], [/^text\/markdown$/, 'Markdown'], [/^text\/plain$/, 'Text'],
];
const MEDIA_LABEL: Record<'image' | 'audio' | 'video', string> = {image: 'Image', audio: 'Audio', video: 'Video'};

/**
 * What a person calls the file's type (`PDF`, `Excel spreadsheet`, `Image`), never a raw MIME type: its extension
 * first, then its type, else the extension in capitals, else `File`.
 */
export function fileTypeLabel(mime: string | undefined, name: string): string {
  const ext = extension(name), type = (mime ?? '').toLowerCase();
  if (EXTENSION_LABEL[ext]) return EXTENSION_LABEL[ext];
  if (keynote(ext, type)) return 'Keynote slides';
  const kind = EXTENSION_KIND[ext];
  if (kind === 'image' || kind === 'audio' || kind === 'video') return MEDIA_LABEL[kind];
  const media = mediaKind(type);
  if (media) return MEDIA_LABEL[media];
  if (EITHER[ext]) return MEDIA_LABEL[EITHER[ext]];
  const known = MIME_LABEL.find(([pattern]) => pattern.test(type));
  if (known) return known[1];
  return ext ? ext.toUpperCase() : 'File';
}

/** What the open chat's header says after `in {area}`: where its context comes from (home semantics, Phase 2). */
export type ChatSees =
  /** Home here: the canvas, the home area (when there is one) and that area's available links. */
  | {kind: 'sees'; areaId: string | null; names: string[]}
  /** Home is another area or canvas. */
  | {kind: 'from'; label: string}
  /** The home's setter lost its canvas, so agents read nothing (R21). */
  | {kind: 'unavailable'}
  /** No home yet (only a member's placement gives one). */
  | {kind: 'none'};

/**
 * Home semantics for an open card: a chat reads the canvas, its home area and that area's available links only
 * when this card is its home. `area` is the area under the card; `links` that area's links from the board summary.
 */
export function chatSees(card: Extract<BoardCard, {access: 'open'}>, canvasName: string, area: {id: string; title: string} | null, links: ContextLink[]): ChatSees {
  const home = card.home;
  if (home?.available === false) return {kind: 'unavailable'};
  if (!home) return {kind: 'none'};
  if (!home.isHere) return home.label ? {kind: 'from', label: home.label} : {kind: 'none'};
  if (!area) return {kind: 'sees', areaId: null, names: [canvasName]};
  return {kind: 'sees', areaId: area.id, names: [canvasName, area.title || 'Untitled area', ...links.filter(link => link.available).map(link => link.title)]};
}

/** A pasted link's host, for its second line. Stored links are normalized, so the parse only fails on bad data. */
export function webLinkHost(url: string) {
  try { return new URL(url).host; } catch { return url; }
}
/** The address without its schemeand a trailing lone slash: `a.com/x?y=1`, shown when a link has no title. */
export const webLinkAddress = (url: string) => url.replace(/^https?:\/\//i, '').replace(/\/$/, '');
