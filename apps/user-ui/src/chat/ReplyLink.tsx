// "Replying to <author>" above a reply (spec 7.3): resolved with core.lookup (a loaded event, else GET /api/events/<id>),
// never core.focus, so resolving never changes the snapshot. Only a message.created in this channel renders; another
// channel, a non-message, a 404 or an error renders nothing. A click runs the deep link through onFocusMessage.
import {useEffect,useState} from 'react';
import {CornerUpLeftIcon} from 'lucide-react';
import type {ChannelEventsCore} from './channel-events';
import {buildTimeline} from './timeline';

export function ReplyLink({inReplyTo,channelId,core,onFocusMessage}:{inReplyTo:string;channelId:string;core:ChannelEventsCore;onFocusMessage(eventId:string):void}):JSX.Element|null{
 const [author,setAuthor]=useState<string|null>(null);
 useEffect(()=>{
  let live=true;
  setAuthor(null);
  void core.lookup(inReplyTo).then(event=>{
   if(!live||!event||event.type!=='message.created'||event.channelId!==channelId)return;
   const item=buildTimeline([event],{currentUsername:''})[0];
   if(item?.kind==='message')setAuthor(item.meta.authorName);
  });
  return()=>{live=false;};
 },[inReplyTo,channelId,core]);
 if(author===null)return null;
 return <button type="button" data-slot="reply-link" onClick={()=>onFocusMessage(inReplyTo)}
  className="mt-1 flex max-w-full items-center gap-1.5 rounded-md px-1.5 py-0.5 -ms-1.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
  <CornerUpLeftIcon aria-hidden="true" className="size-3.5 shrink-0"/>
  <span className="truncate">Replying to <strong className="font-medium">{author}</strong></span>
 </button>;
}
