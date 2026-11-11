// A file as an artifact tile (the mock's `.art`): a typed glyph, or an image's own preview, over the file name. Cards,
// chat messages (canvas flag on), area shelves and the context popover all use this one tile.
import {useState,type MouseEvent,type ReactNode} from 'react';
import {formatAttachmentSize} from '../attachments';
import {fileKind,fileTypeLabel,type FileKind} from './context-label';
import './file-tile.css';

/** The mock's `ART` glyphs; colours come from file-tile.css so each theme keeps 3:1 against the tile. */
const GLYPHS: Record<FileKind, ReactNode> = {
  doc: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"><path d="M5 6h14M5 10h14M5 14h10M5 18h12"/></svg>,
  sheet: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><rect x="4" y="4" width="16" height="16" rx="2"/><path d="M4 9h16M4 14h16M10 4v16"/></svg>,
  slides: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><rect x="3" y="5" width="13" height="11" rx="2"/><rect x="8" y="9" width="13" height="11" rx="2" fill="var(--file-tile-bg)"/></svg>,
  image: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><rect x="3.5" y="5" width="17" height="14" rx="2"/><circle cx="9" cy="10" r="1.6"/><path d="m4 17 5-5 4 4 2.5-2.5L20 17"/></svg>,
  audio: <svg viewBox="0 0 40 24" fill="currentColor">{[6, 12, 18, 9, 15, 20, 11, 7, 16, 10, 5].map((h, i) => <rect key={i} x={i * 3.6 + 1} y={12 - h / 2} width="2" height={h} rx="1"/>)}</svg>,
  video: <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" fill="rgba(255,255,255,.12)"/><path d="M10 8l6 4-6 4z" fill="currentColor"/></svg>,
};

export function FileGlyph({kind}: {kind: FileKind}) {
  return <span className="canvas-file-glyph" data-kind={kind} aria-hidden="true">{GLYPHS[kind]}</span>;
}

// Previews only for the raster types the chat previews; an SVG is never loaded as a picture.
const PREVIEW_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const previewable = (mime: string | undefined, name: string) =>
  PREVIEW_TYPES.has((mime ?? '').toLowerCase()) || /\.(png|jpe?g|gif|webp)$/i.test(name);

export const TILE_SIZE = 56;
export const TILE_GAP = 6;
/**
 * How many of a row's files show as tiles in `width` px, and the `+N` that stands for the rest: when they do not all
 * fit, the last slot becomes `+N`. `listed` caps the tiles at the files actually known (the card pulse keeps 6).
 */
export function fileSlots(width: number, total: number, listed = total): {shown: number; more: number} {
  const slots = Math.max(1, Math.floor((width + TILE_GAP) / (TILE_SIZE + TILE_GAP)));
  const shown = Math.min(listed, total <= slots ? total : slots - 1);
  return {shown, more: total - shown};
}

export type FileTileProps = {
  name: string; mime?: string; href: string;
  /** Bytes, when known. */
  size?: number;
  /** A chat message's tile: named `{name}, {type}, {size}` with `type · size` as its tooltip. Else the tooltip is `name · type`. */
  detailed?: boolean;
  /** Download the file (context files) instead of opening it in a new tab. */
  download?: boolean;
  /** The file arrived while the canvas was open: the tile pops in once (the mock's `.art.new`). */
  fresh?: boolean;
  /** The pop finished, so the tile can drop `fresh` and never replay it. */
  onPopped?(): void;
  /** A plain click on an image preview; any other click follows the link. */
  onPreview?(event: MouseEvent<HTMLAnchorElement>): void;
  onRemove?(): void;
};

export function FileTile({name, mime, href, size, detailed = false, download = false, fresh = false, onPopped, onPreview, onRemove}: FileTileProps) {
  const [failed, setFailed] = useState(false);
  const kind = fileKind(mime, name), type = fileTypeLabel(mime, name), bytes = formatAttachmentSize(size);
  // A picture that fails to load gives its tile the image glyph back.
  const preview = kind === 'image' && previewable(mime, name) && !failed;
  const title = detailed ? [type, bytes].filter(Boolean).join(' · ') : `${name} · ${type}`;
  return <li className={`canvas-file-tile${fresh ? ' is-new' : ''}`} data-kind={kind}>
    <a className={`canvas-file-art${preview ? ' has-preview' : ''}`} href={href} title={title}
      aria-label={detailed ? [name, type, bytes].filter(Boolean).join(', ') : undefined}
      {...(download ? {download: name} : {target: '_blank', rel: 'noreferrer'})}
      onClick={preview && onPreview ? onPreview : undefined} onAnimationEnd={fresh ? onPopped : undefined}>
      <FileGlyph kind={kind}/>
      {/* Loaded only when the tile is near the viewport; the caption names the link, so the picture is decorative. */}
      {preview ? <img className="canvas-file-preview" src={href} alt="" loading="lazy" decoding="async" onError={() => setFailed(true)}/> : null}
      <span className="canvas-file-name">{name}</span>
    </a>
    {onRemove ? <button type="button" className="canvas-file-remove" aria-label={`Remove ${name}`} onClick={onRemove}><span aria-hidden="true">✕</span></button> : null}
  </li>;
}
