// One message's parts (spec 6.5 to 6.7), each through its slot: text, demo previews, attachments, reply link, activity.
import type {ReactNode} from 'react';
import {demoArtifacts} from '../demo-artifacts';
import {MessageAttachments} from './attachments-view';
import type {ChannelEventsCore} from './channel-events';
import {ReplyLink} from './ReplyLink';
import type {TimelineItem} from './timeline';
import {Button} from './ui/button';
import {cn} from './ui/lib/utils';
import {MarkdownText} from './ui/MarkdownText';

type MessageItem=Extract<TimelineItem,{kind:'message'}>;

// Text styling after assistant-ui's thread.aui.tsx (0.15.31): agent and system text sits on the page like
// AssistantMessage's content, a human's text in UserMessage's muted bubble, kept left-aligned (spec 4.5).
// The bubble's rounded-2xl is chat.css's --radius-2xl alias (aui's 1rem --composer-radius).
// The [&_p] utilities neutralise the classic `.message p` rule (size, colour, margin) inside the chat.
const TEXT='text-base leading-relaxed text-foreground [overflow-wrap:anywhere] [&_p]:text-[length:inherit] [&_p]:leading-[inherit] [&_p]:text-inherit';
const BUBBLE='w-fit max-w-full rounded-2xl bg-bubble px-4 py-2';

// `activity` is the agent activity group that directly follows this message; it renders under the message's own parts.
export function MessageBody({item,channelId,core,onPreviewDemo,onFocusMessage,onQuote,activity}:{
 item:MessageItem;channelId:string;core:ChannelEventsCore;
 onPreviewDemo(path:string):void;onFocusMessage(eventId:string):void;onQuote():void;activity?:ReactNode;
}):JSX.Element{
 return <>
  <div className={cn(TEXT,item.meta.authorKind==='human'?cn(BUBBLE,'mt-0.5',item.meta.isMine&&'max-w-[85%]'):'mt-0')}>
   {item.markdown?<MarkdownText text={item.text}/>:<p className="m-0 whitespace-pre-wrap">{item.text}</p>}
  </div>
  {demoArtifacts(item.text,window.location.origin).map(path=>
   <Button variant="outline" size="sm" className="demo-open me-2 mt-2 rounded-full" type="button" key={path} onClick={()=>onPreviewDemo(path)}>Preview {path.slice(6)}</Button>)}
  {item.attachments.length>0&&<MessageAttachments attachments={item.attachments}/>}
  {item.meta.inReplyTo&&<ReplyLink inReplyTo={item.meta.inReplyTo} channelId={channelId} core={core} onFocusMessage={onFocusMessage}/>}
  {activity}
 </>;
}
