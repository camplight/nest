// "Quote selection" for a selection inside one message body (spec 7.2.4, 7.4.5). Mounted inside ThreadPrimitive.Root:
// its parent is the thread root that scopes the selection. assistant-ui's toolbar root shows and places the bar from
// JavaScript, so its element carries no size, position or transform utilities; it is hidden whenever our own check
// (selectionQuote: one message, no activity) rejects what aui accepts. The author comes from the thread's data.
import {useEffect,useRef,useState} from 'react';
import {TextQuoteIcon} from 'lucide-react';
import {SelectionToolbarPrimitive,useAuiState} from './aui';
import {selectionQuote} from './quote';
import type {ReplyTarget} from './quote-types';
import type {ChatMeta} from './timeline';
import {cn} from './ui/lib/utils';

type Quoted={eventId:string;text:string};

export function SelectionQuote({onQuote}:{onQuote(target:ReplyTarget,quotedText:string):void}):JSX.Element|null{
 const anchor=useRef<HTMLSpanElement|null>(null);
 const messages=useAuiState(state=>state.thread.messages);
 const [quoted,setQuoted]=useState<Quoted|null>(null);
 const read=()=>{
  const root=anchor.current?.parentElement;
  return root?selectionQuote(window.getSelection(),root):null;
 };
 useEffect(()=>{
  const update=()=>setQuoted(current=>{
   const next=read();
   return next?.eventId===current?.eventId&&next?.text===current?.text?current:next;
  });
  document.addEventListener('selectionchange',update);
  return()=>document.removeEventListener('selectionchange',update);
 },[]);
 const author=(eventId:string)=>{
  const meta=messages.find(message=>message.id===eventId)?.metadata.custom as ChatMeta|undefined;
  return meta&&meta.authorKind!=='activity'?meta.authorName:null;
 };
 const quote=()=>{
  const current=read(),name=current&&author(current.eventId);
  if(!current||!name)return;
  window.getSelection()?.removeAllRanges();
  setQuoted(null);
  onQuote({eventId:current.eventId,author:name,excerpt:current.text},current.text);
 };
 const shown=quoted!==null&&author(quoted.eventId)!==null;
 return <>
  <span ref={anchor} hidden/>
  <SelectionToolbarPrimitive.Root data-slot="selection-toolbar"
   className={cn('nest-chat-portal items-center gap-1 rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-md animate-in fade-in duration-150',shown?'flex':'hidden')}>
   {shown&&<button type="button" onClick={quote}
    className="flex items-center gap-1.5 rounded-md px-2.5 py-1 text-sm font-medium transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
    <TextQuoteIcon aria-hidden="true" className="size-4"/>Quote selection
   </button>}
  </SelectionToolbarPrimitive.Root>
 </>;
}
