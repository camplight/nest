// The action bar of one message.created item (spec 7.2): Copy message, Copy link, Quote. Desktop reveals it on
// hover and keyboard focus within the message article (`group`); touch toggles it with a tap on the article, since
// assistant-ui's hover state is mouse only. Hidden is display none. Copies only the raw text and a link (spec 5.6).
import {useEffect,useRef,useState} from 'react';
import {CheckIcon,CopyIcon,LinkIcon,TextQuoteIcon} from 'lucide-react';
import {messageLink} from './export';
import type {TimelineItem} from './timeline';
import {useCopyToClipboard} from './ui/hooks/use-copy-to-clipboard';
import {cn} from './ui/lib/utils';
import {TooltipIconButton} from './ui/tooltip-icon-button';

// Taps on these keep their own meaning (a link still navigates) and never toggle the bar.
const INTERACTIVE='a,button,input,textarea,select,summary,label,[role="button"],[contenteditable="true"]';

// `className` places the bar: inline beside the time on a message's header line, or at the top edge of a run's
// follow-up line, which has no header.
export function MessageActions({item,onQuote,className}:{item:Extract<TimelineItem,{kind:'message'}>;onQuote():void;className?:string}):JSX.Element|null{
 const ref=useRef<HTMLDivElement|null>(null);
 // touch: the last pointer was a finger, so hover and focus no longer drive the bar; open: toggled by taps.
 const [touch,setTouch]=useState(false);
 const [open,setOpen]=useState(false);
 const text=useCopyToClipboard(),link=useCopyToClipboard();
 useEffect(()=>{
  const article=ref.current?.closest<HTMLElement>('[data-message-id]');
  if(!article)return;
  const pointerdown=(event:PointerEvent)=>{
   const isTouch=event.pointerType==='touch'||event.pointerType==='pen';
   setTouch(isTouch);
   if(!isTouch)setOpen(false);
  };
  const tap=(event:PointerEvent)=>{
   if(event.pointerType!=='touch'&&event.pointerType!=='pen')return;
   if(event.target instanceof Element&&event.target.closest(INTERACTIVE))return;
   setOpen(value=>!value);
  };
  // A tap anywhere outside this message closes its bar.
  const outside=(event:PointerEvent)=>{if(!(event.target instanceof Node&&article.contains(event.target)))setOpen(false);};
  article.addEventListener('pointerdown',pointerdown);
  article.addEventListener('pointerup',tap);
  document.addEventListener('pointerdown',outside);
  return()=>{
   article.removeEventListener('pointerdown',pointerdown);
   article.removeEventListener('pointerup',tap);
   document.removeEventListener('pointerdown',outside);
  };
 },[]);
 if(item.kind!=='message')return null;
 return <div ref={ref} data-slot="message-actions"
  className={cn('aui-message-action-bar h-4 items-center gap-1 text-muted-foreground [&>button]:size-4 [&>button]:p-0 [&>button]:rounded-sm [&_svg]:size-3',className,
   touch?(open?'flex':'hidden'):'hidden group-hover:flex group-focus-within:flex')}>
  <TooltipIconButton tooltip="Copy message" side="top" onClick={()=>text.copyToClipboard(item.text)}>
   {text.isCopied?<CheckIcon aria-hidden="true"/>:<CopyIcon aria-hidden="true"/>}
  </TooltipIconButton>
  <TooltipIconButton tooltip="Copy link" side="top" onClick={()=>link.copyToClipboard(messageLink(item.meta.eventId,window.location.href))}>
   {link.isCopied?<CheckIcon aria-hidden="true"/>:<LinkIcon aria-hidden="true"/>}
  </TooltipIconButton>
  <TooltipIconButton tooltip="Quote" side="top" onClick={onQuote}>
   <TextQuoteIcon aria-hidden="true"/>
  </TooltipIconButton>
 </div>;
}
