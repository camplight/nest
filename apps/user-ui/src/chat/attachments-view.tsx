// A message's attachments (spec 6.6): file link, mime and size, inline previews that zoom on a plain click (spec 7.1.4).
// With the canvas flag on, files are artifact tiles instead (MessageFiles); audio keeps the classic list.
import {useState,type MouseEvent} from 'react';
import {fileHref,formatAttachmentSize} from '../attachments';
import {fileKind} from '../canvas/context-label';
import {FileTile} from '../canvas/FileTile';
import type {MessageAttachment} from './timeline';
import {ImageZoom} from './ui/ImageZoom';

// SVG is never previewed: it stays a link only.
const previewTypes=new Set(['image/png','image/jpeg','image/gif','image/webp']);

/** Only an unmodified primary click opens the zoom; every other click, and middle click, follows the link. */
const isPlainClick=(event:MouseEvent)=>event.button===0&&!event.ctrlKey&&!event.metaKey&&!event.shiftKey&&!event.altKey&&!event.defaultPrevented;

function AttachmentItem({attachment}:{attachment:MessageAttachment}):JSX.Element{
 const [failed,setFailed]=useState(false);
 const [zoom,setZoom]=useState(false);
 const url=fileHref(attachment.fileId);
 const size=formatAttachmentSize(attachment.size);
 const preview=previewTypes.has(attachment.mime??'')&&!failed;
 return <li className="message-attachment flex min-w-0 flex-col items-start gap-1.5">
  {preview&&<>
   <a className="message-image-link group/preview block max-w-full overflow-hidden rounded-[14px] border border-border bg-muted transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring cursor-zoom-in"
    href={url} target="_blank" rel="noreferrer" aria-label={`Open ${attachment.name}`}
    onClick={event=>{if(!isPlainClick(event))return;event.preventDefault();setZoom(true);}}>
    <img className="block h-auto max-h-[480px] w-auto max-w-[min(100%,680px)] object-contain transition-transform duration-200 group-hover/preview:scale-[1.01]"
     src={url} alt={attachment.name} loading="lazy" onError={()=>setFailed(true)}/>
   </a>
   <ImageZoom src={url} alt={attachment.name} open={zoom} onOpenChange={setZoom}/>
  </>}
  <a className="max-w-full text-sm font-medium text-foreground underline-offset-2 hover:underline [overflow-wrap:anywhere]" href={url} target="_blank" rel="noreferrer">{attachment.name}</a>
  {(attachment.mime||size)&&<span className="text-xs text-muted-foreground">{[attachment.mime,size].filter(Boolean).join(' • ')}</span>}
  {failed&&<span className="text-xs text-muted-foreground">Preview unavailable. Open the file using the link above.</span>}
 </li>;
}

export function MessageAttachments({attachments}:{attachments:MessageAttachment[]}):JSX.Element{
 return <div className="message-attachments mt-2 flex min-w-0 flex-col gap-2 rounded-xl border border-border bg-card p-3 text-card-foreground">
  <strong className="text-xs font-medium text-muted-foreground">Attachments</strong>
  <ul className="flex min-w-0 flex-col gap-3">{attachments.map((attachment,index)=><AttachmentItem key={`${attachment.fileId}-${index}`} attachment={attachment}/>)}</ul>
 </div>;
}

/** One tile; an image preview still zooms on a plain click, like the classic preview. */
function MessageFileTile({attachment}:{attachment:MessageAttachment}):JSX.Element{
 const [zoom,setZoom]=useState(false);
 const url=fileHref(attachment.fileId);
 return <>
  <FileTile name={attachment.name} mime={attachment.mime} href={url} size={attachment.size} detailed
   onPreview={event=>{if(!isPlainClick(event))return;event.preventDefault();setZoom(true);}}/>
  {zoom&&<ImageZoom src={url} alt={attachment.name} open onOpenChange={setZoom}/>}
 </>;
}

/**
 * Canvas flag on: a message's files as a wrapping row of artifact tiles (the mock's `.mfiles`), each named
 * `{name}, {type}, {size}`. Audio, voice notes included, stays in the classic list.
 */
export function MessageFiles({attachments}:{attachments:MessageAttachment[]}):JSX.Element{
 const audio=attachments.filter(attachment=>fileKind(attachment.mime,attachment.name)==='audio');
 const files=attachments.filter(attachment=>!audio.includes(attachment));
 return <>
  {files.length>0&&<ul className="message-files" aria-label="Files">
   {files.map((attachment,index)=><MessageFileTile key={`${attachment.fileId}-${index}`} attachment={attachment}/>)}
  </ul>}
  {audio.length>0&&<MessageAttachments attachments={audio}/>}
 </>;
}
