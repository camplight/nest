// A context file as an artifact tile (the mock's `.art`): a type glyph over the name, linking to the download.
import type {ReactNode} from 'react';
import {fileKind,type FileKind} from './context-label';

const GLYPHS: Record<FileKind, ReactNode> = {
  doc: <path d="M5 6h14M5 10h14M5 14h10M5 18h12"/>,
  sheet: <><rect x="4" y="4" width="16" height="16" rx="2"/><path d="M4 9h16M4 14h16M10 4v16"/></>,
  image: <><rect x="3.5" y="5" width="17" height="14" rx="2"/><circle cx="9" cy="10" r="1.6"/><path d="m4 17 5-5 4 4 2.5-2.5L20 17"/></>,
  audio: <path d="M4 12v0M7 9v6M10 6v12M13 9v6M16 7v10M19 11v2"/>,
  video: <><circle cx="12" cy="12" r="8.5"/><path d="m10 8.5 5.5 3.5-5.5 3.5z"/></>,
};

export function FileGlyph({mime, name}: {mime: string; name: string}) {
  const kind = fileKind(mime, name);
  return <svg className="canvas-file-glyph" data-kind={kind} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {GLYPHS[kind]}
  </svg>;
}

export function FileTile({name, mime, href, onRemove}: {name: string; mime: string; href: string; onRemove?(): void}) {
  return <li className="canvas-file-tile" title={name}>
    <a href={href} download={name}>
      <FileGlyph mime={mime} name={name}/>
      <span className="canvas-file-name">{name}</span>
    </a>
    {onRemove ? <button type="button" className="canvas-file-remove" aria-label={`Remove ${name}`} onClick={onRemove}><span aria-hidden="true">✕</span></button> : null}
  </li>;
}
