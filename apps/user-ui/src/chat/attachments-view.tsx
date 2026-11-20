// A message's attachments (spec 6.6): file link, mime and size, inline previews that zoom on a plain click (spec 7.1.4),
// and a Play button for audio. With the canvas flag on, files are artifact tiles instead (MessageFiles) that open the
// file viewer; audio keeps the classic list.
import {useEffect,useRef,useState} from 'react';
import {fileHref,formatAttachmentSize} from '../attachments';
import {fileKind} from '../canvas/context-label';
import {VIEWER_COPY,ViewableFileTile} from '../canvas/FileViewer';
import {isPlainClick,startViewerLoad} from '../canvas/file-viewer';
import {VoicePlayer} from '../canvas/VoicePlayer';
import type {MessageAttachment} from './timeline';
import {Button} from './ui/button';
import {ImageZoom} from './ui/ImageZoom';

// SVG is never previewed: it stays a link only.
const previewTypes=new Set(['image/png','image/jpeg','image/gif','image/webp']);

type AudioState={status:'idle'|'loading'|'too-large'|'failed'}|{status:'ready';url:string};

/** A callback ref that focuses its element once when `pending.current` is set (the button it replaces had focus). */
export const focusWhenPending=(pending:{current:boolean})=>(element:HTMLElement|null)=>{
 if(!element||!pending.current)return;
 pending.current=false;
 element.focus({preventScroll:true});
};

/**
 * A voice note or other audio file: a Play button that fetches the file on first press (the viewer's rules and cap,
 * so a long history never downloads every recording), then a player that starts at once. The URL is revoked on unmount. Keyboard focus follows from the button to
 * the player (or the message saying why there is none); while loading the button stays focusable (aria-disabled).
 */
export function InlineAudio({name,mime,href,size,fetchFile=fetch}:{name:string;mime?:string;href:string;size?:number;fetchFile?:typeof fetch}):JSX.Element{
 const [state,setState]=useState<AudioState>({status:'idle'});
 const [load,setLoad]=useState(false);
 const hadFocus=useRef(false);
 const takeFocus=focusWhenPending(hadFocus);
 useEffect(()=>{
  if(!load)return;
  setState({status:'loading'});
  return startViewerLoad({file:{name,mime,size,href},kind:'audio',fetchFile,onResult:result=>setState(
   result.status==='url'?{status:'ready',url:result.url}:{status:result.status==='too-large'?'too-large':'failed'})});
 },[load,name,mime,size,href,fetchFile]);
 if(state.status==='ready')return <VoicePlayer src={state.url} name={name} size="compact" autoPlay buttonRef={takeFocus}
  onFailed={()=>setState({status:'failed'})}/>;
 if(state.status==='too-large'||state.status==='failed')
  return <span ref={takeFocus} tabIndex={-1} className="text-xs text-muted-foreground" role={state.status==='failed'?'alert':undefined}>{state.status==='failed'?VIEWER_COPY.failed:VIEWER_COPY.tooLarge}</span>;
 const loading=state.status==='loading';
 return <Button variant="outline" size="sm" className="rounded-full" type="button" aria-disabled={loading||undefined}
  onClick={event=>{if(loading)return;hadFocus.current=document.activeElement===event.currentTarget;setLoad(true);}}>
  {loading?`Loading ${name}…`:`Play ${name}`}
 </Button>;
}

function AttachmentItem({attachment}:{attachment:MessageAttachment}):JSX.Element{
 const [failed,setFailed]=useState(false);
 const [zoom,setZoom]=useState(false);
 const url=fileHref(attachment.fileId);
 const size=formatAttachmentSize(attachment.size);
 const preview=previewTypes.has(attachment.mime??'')&&!failed;
 const audio=fileKind(attachment.mime,attachment.name)==='audio';
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
  {audio&&<InlineAudio name={attachment.name} mime={attachment.mime} href={url} size={attachment.size}/>}
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

/** One tile; a plain click opens it in the file viewer, any other click follows its link. */
function MessageFileTile({attachment}:{attachment:MessageAttachment}):JSX.Element{
 return <ViewableFileTile name={attachment.name} mime={attachment.mime} href={fileHref(attachment.fileId)} size={attachment.size} detailed/>;
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
