// The channel thread on assistant-ui (spec 6.2 to 6.5, 6.13 to 6.17, 7.1.2, 7.1.3, 8.1 to 8.5). Our store and converter
// stay the source of truth: assistant-ui gets one message per timeline item and never owns, edits or sends anything.
import {createContext,useCallback,useContext,useEffect,useImperativeHandle,useLayoutEffect,useMemo,useRef,useState,type ReactNode,type Ref} from 'react';
import {ArrowDownIcon} from 'lucide-react';
import {AgentActivity} from '../components/AgentActivity';
import {AgentAvatar} from '../components/AgentAvatar';
import type {Agent,EventRow} from '../types';
import {AssistantRuntimeProvider,ThreadPrimitive,useAuiState,useExternalStoreRuntime} from './aui';
import type {ChannelEventsCore,ChannelEventsSnapshot} from './channel-events';
import {ExportButton} from './ExportButton';
import {formatTime} from './format';
import {MessageActions} from './MessageActions';
import {MessageBody} from './MessageBody';
import type {ReplyTarget} from './quote-types';
import {SelectionQuote} from './SelectionQuote';
import {buildTimeline,dayKey,isContinuation,isTraceEvent,toThreadMessage,type ChatMeta,type TimelineItem} from './timeline';
import {Button} from './ui/button';
import {DaySeparator} from './ui/day-separator';
import {cn} from './ui/lib/utils';
import {ChatPortalProvider} from './ui/portal';
import {activeTurns,type WorkingTurn} from './working';
import {WorkingRow} from './WorkingRow';
import './chat.css';

export type ChatThreadProps={
 snapshot:ChannelEventsSnapshot;core:ChannelEventsCore;currentUsername:string;agents:Agent[];
 focusedMessageId:string|null;isConversationEmpty:boolean;
 onPreviewDemo(path:string):void;onQuote(target:ReplyTarget,quotedText:string):void;footer?:ReactNode;headerActions?:ReactNode;
 channelLabel:string;onFocusMessage(eventId:string):void;handle?:Ref<ChatThreadHandle>;
};
// What the page may ask of the thread: after a send it follows the new message down (the viewport is the thread's own).
export type ChatThreadHandle={scrollToBottom():void};
type MessageItem=Extract<TimelineItem,{kind:'message'}>;
type ActivityItem=Extract<TimelineItem,{kind:'activity'}>;
type ThreadView={byId:ReadonlyMap<string,TimelineItem>;turns:readonly WorkingTurn[];props:ChatThreadProps;focused(eventId:string):void};

// Ported from classic isMessagesPanelNearBottom.
const NEAR_BOTTOM_PX=80;
const FAR_FROM_BOTTOM_PX=240;
const AUTO_LOAD_PX=120;
const NO_ERROR=()=>Promise.reject(new Error('The Nest composer sends messages'));

// Author branch: agents get their portrait, humans their initials, system sources nothing.
export function authorAvatar(meta:ChatMeta):JSX.Element|null{
 if(meta.authorKind==='agent')return <AgentAvatar name={meta.authorName} size={32}/>;
 if(meta.authorKind==='human')return <span className="message-human-avatar grid size-8 place-items-center rounded-full border border-border bg-muted text-[11px] font-semibold leading-none text-foreground" aria-hidden="true">{meta.authorName.trim().slice(0,2).toUpperCase()}</span>;
 return null;
}
// Continuation branch: avatar and name only on the first message of a run (spec 7.1.2).
export function showsAuthor(previous:TimelineItem|undefined,item:TimelineItem):boolean{
 return !isContinuation(previous,item);
}
// Highlight branch: the deep-linked message is focusable and highlighted.
export function isHighlighted(item:TimelineItem,focusedMessageId:string|null):boolean{
 return focusedMessageId!==null&&item.id===focusedMessageId;
}
// New-content branch: "New messages below" only for content newer than any shown before, while scrolled up (spec 6.13).
export function arrivedWhileAway(previousNewest:number|null,newest:number,nearBottom:boolean):boolean{
 return previousNewest!==null&&newest>previousNewest&&!nearBottom;
}

const newestTimelineAt=(events:EventRow[])=>events.reduce((newest,event)=>
 event.type==='message.created'||isTraceEvent(event)?Math.max(newest,event.createdAt??0):newest,0);
const distanceFromBottom=(panel:HTMLElement)=>panel.scrollHeight-panel.scrollTop-panel.clientHeight;
const dayLabel=(ts:number)=>new Intl.DateTimeFormat(undefined,{weekday:'long',day:'numeric',month:'long',year:'numeric'}).format(new Date(ts));

const ThreadContext=createContext<ThreadView|null>(null);

// The look follows assistant-ui's thread.aui.tsx at @assistant-ui/react@0.15.31 (message roots, load-earlier button,
// scroll-to-bottom button, welcome and history skeleton), laid out left-aligned with an avatar gutter (spec 4.5).
// Utilities are important in chat.css, so they win over the classic rules still bound to .message and .messages-panel.
// Run spacing sits below an item, chosen by its successor, so a prepend that turns the old first message into a
// continuation never moves that message (the viewport restores scrollTop from the content above it).
// Messages carry no bottom padding, so these margins are the whole gap: a small one between authors, tight within a run.
const spaceAfter=(item:TimelineItem,next:TimelineItem|undefined)=>
 !next?'mb-0':item.kind!=='message'||next.kind!=='message'?'mb-3':isContinuation(item,next)?'mb-0.5':'mb-3';
// An activity group directly after a message (same day, both in the loaded window) is shown inside that message,
// under its text; any other group stands on its own in the avatar-gutter column.
const attachesTo=(previous:TimelineItem|undefined,item:TimelineItem|undefined):boolean=>
 item?.kind==='activity'&&previous?.kind==='message'&&!previous.meta.detached&&!item.meta.detached&&
 dayKey(previous.meta.displayAt)===dayKey(item.meta.displayAt);
// The classic rgba backgrounds of .trace-group-agent and -system read as a grey bar in dark mode; token-themed here.
// Chips line up with the message text: no box or inset around the group (the classic .trace-group padding is reset).
const ACTIVITY_RESET='[&>article]:bg-transparent [&>article]:p-0 [&>article]:rounded-none [&>article]:max-w-none';
const ACTIVITY_SLOT=cn('w-full self-start ps-12',ACTIVITY_RESET);
const ACTIVITY_IN_MESSAGE=cn('mt-1',ACTIVITY_RESET);
const SHELL='group relative flex w-full max-w-none min-w-0 gap-3 self-start rounded-xl border-0 bg-transparent px-2 py-0 shadow-none animate-in fade-in duration-150 has-[[data-slot=message-focus]:focus-visible]:ring-2 has-[[data-slot=message-focus]:focus-visible]:ring-ring';
// The content column is the message's Tab stop (spec 7.2): focus in it reveals the actions through group-focus-within,
// and they are the next stops. The article itself stays unfocusable except as a deep-link target. The bar is 16 px
// icons beside the time on the header line (or absolute at a follow-up line's top edge), so showing it never moves content.
const COLUMN='relative min-w-0 flex-1 pb-0 outline-none';
// The current user's own messages sit on the right like a chat app's: no avatar or name, the bubble and its actions
// right-aligned (the operator's call, superseding spec 4.5's left-aligned layout).
const MINE_COLUMN='flex flex-col items-end';

function MessageShell({item,previous,view,spacing,activity}:{item:MessageItem;previous?:TimelineItem;view:ThreadView;spacing:string;activity?:ActivityItem}){
 const {meta}=item,{props}=view;
 const highlighted=isHighlighted(item,props.focusedMessageId);
 const author=showsAuthor(previous,item);
 const mine=meta.isMine&&meta.authorKind==='human';
 // A continuation's time floats right of its first line, in the same column as the time in an author line.
 // The time follows the author's name; a continuation (no name line) shows it in the avatar gutter on hover.
 const time=<time className={cn('shrink-0 whitespace-nowrap text-xs font-normal leading-4 text-muted-foreground tabular-nums',!author&&!mine&&'block pt-1 text-end text-[10px] leading-3 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100')}
  dateTime={new Date(meta.displayAt).toISOString()}>{formatTime(meta.displayAt)}</time>;
 const quote=()=>props.onQuote({eventId:item.id,author:meta.authorName,excerpt:item.text},item.text);
 // Beside the time on a header line; a follow-up line (no header) shows them at its top edge on the empty side.
 const actions=(placement:string)=><MessageActions item={item} onQuote={quote} className={placement}/>;
 const ref=useRef<HTMLElement|null>(null);
 // Deep link: centre and focus the target in the commit that renders it; a re-focus toggles highlighted and runs again.
 useLayoutEffect(()=>{
  const node=ref.current;
  if(!highlighted||!node)return;
  const reveal=()=>{node.scrollIntoView({block:'center'});node.focus({preventScroll:true});};
  reveal();
  view.focused(item.id);
  const frame=window.requestAnimationFrame(reveal);
  return()=>window.cancelAnimationFrame(frame);
 },[highlighted]);
 return <article ref={ref} id={`message-${item.id}`} data-message-id={item.id} tabIndex={highlighted?-1:undefined}
  className={cn('message',`message-${meta.authorKind}`,SHELL,spacing,highlighted&&'message-highlight bg-accent/40 ring-2 ring-ring')}>
  {!mine&&<div className="w-8 shrink-0 pt-0.5">{author?authorAvatar(meta):time}</div>}
  <div data-slot="message-focus" tabIndex={0} role="group" aria-label={`${meta.authorName}, ${formatTime(meta.displayAt)}`} className={cn(COLUMN,mine&&MINE_COLUMN)}>
   {mine?(author?<div className="flex items-center justify-end gap-2">{actions('')}{time}</div>:actions('absolute top-0 start-0 z-10')):author?<div className="flex min-w-0 items-center gap-2">
    <strong className="message-author min-w-0 text-sm font-semibold leading-5 text-foreground [overflow-wrap:anywhere]">{meta.authorName}</strong>
    {time}
    {actions('')}
   </div>:actions('absolute top-0 end-0 z-10')}
   {meta.targetAgents.length>0&&<span className="message-target mt-0.5 mb-0 block text-xs text-muted-foreground">To {meta.targetAgents.map(name=>'@'+name).join(', ')}</span>}
   <MessageBody item={item} channelId={props.snapshot.channelId??''} core={props.core} onPreviewDemo={props.onPreviewDemo}
    onFocusMessage={props.onFocusMessage} onQuote={quote}
    activity={activity&&<div data-aui-quote-selectable="false" className={ACTIVITY_IN_MESSAGE}>
     <AgentActivity events={activity.events} tone={activity.tone} formatTime={formatTime}/>
    </div>}/>
  </div>
 </article>;
}

// Neighbours come from the runtime's list, so separators, grouping and markers change in the commit that renders
// the runtime's new messages, never one commit early (a prepend would shift the reader before it is anchored).
function ThreadItem(){
 const id=useAuiState(state=>state.message.id);
 const [previousId,nextId,afterNextId]=useAuiState(useCallback((state:{thread:{messages:readonly {id:string}[]}})=>{
  const messages=state.thread.messages,index=messages.findIndex(message=>message.id===id);
  return `${messages[index-1]?.id??''}\n${messages[index+1]?.id??''}\n${messages[index+2]?.id??''}`;
 },[id])).split('\n');
 const view=useContext(ThreadContext);
 const item=view?.byId.get(id);
 if(!view||!item)return null;
 const previous=previousId?view.byId.get(previousId):undefined,next=nextId?view.byId.get(nextId):undefined;
 const newDay=!previous||dayKey(previous.meta.displayAt)!==dayKey(item.meta.displayAt);
 return <>
  {newDay&&<DaySeparator className="my-4 px-2" label={dayLabel(item.meta.displayAt)}/>}
  {item.kind==='message'?(attachesTo(item,next)?
    <MessageShell item={item} previous={previous} view={view} activity={next as ActivityItem}
     spacing={spaceAfter(next as ActivityItem,afterNextId?view.byId.get(afterNextId):undefined)}/>:
    <MessageShell item={item} previous={previous} view={view} spacing={spaceAfter(item,next)}/>):
   attachesTo(previous,item)?null:
   <div data-aui-quote-selectable="false" className={cn(ACTIVITY_SLOT,spaceAfter(item,next))}>
    <AgentActivity events={item.events} tone={item.tone} formatTime={formatTime}/>
   </div>}
  {view.turns.filter(turn=>turn.triggerEventId===item.id||(!next&&!view.byId.has(turn.triggerEventId))).map(turn=>
   <WorkingRow key={turn.agent} turn={turn} activityUnavailable={view.props.snapshot.activityUnavailable}
    onReview={()=>view.props.onFocusMessage(turn.triggerEventId)}/>)}
  {item.meta.detached&&next&&!next.meta.detached&&<div data-slot="detached-marker" className="my-3 self-center rounded-full bg-muted/70 px-3 py-1 text-xs text-muted-foreground">Earlier messages not loaded</div>}
 </>;
}
const MESSAGE_COMPONENTS={Message:ThreadItem};

// Reads hasEarlier from the runtime, so the button leaves in the same commit as the prepended messages arrive.
// While loading it stays a disabled hit target (the copied Button would pass pointer events through to the panel).
function LoadOlderButton({loadingOlder,onClick}:{loadingOlder:boolean;onClick():void}){
 const hasEarlier=useAuiState(state=>state.thread.hasEarlier);
 if(!hasEarlier)return null;
 return <Button variant="ghost" size="sm" className="mb-6 shrink-0 self-center rounded-full text-muted-foreground disabled:pointer-events-auto disabled:cursor-not-allowed" disabled={loadingOlder} onClick={onClick}>
  <span className={cn(loadingOlder&&'animate-pulse')}>{loadingOlder?'Loading previous messages...':'Load previous messages'}</span>
 </Button>;
}

// Loading: thread.aui.tsx's ThreadHistorySkeleton, left-aligned, under the visible status text.
function ThreadLoading(){
 return <div role="status" className="flex flex-col gap-6 px-2 pt-2 animate-in fade-in fill-mode-both [animation-delay:150ms] [animation-duration:200ms]">
  <strong className="text-sm font-medium text-muted-foreground">Loading messages...</strong>
  {[['w-11/12','w-4/5','w-3/5'],['w-10/12','w-2/3']].map((lines,index)=><div key={index} className="flex gap-3">
   <span className="size-8 shrink-0 animate-pulse rounded-full bg-accent"/>
   <div className="flex flex-1 flex-col gap-2 pt-1">{lines.map(width=><span key={width} className={cn('h-4 animate-pulse rounded-md bg-accent',width)}/>)}</div>
  </div>)}
 </div>;
}

// Empty: thread.aui.tsx's welcome and the registry's empty-state greeting.
function ThreadEmpty(){
 return <div className="my-auto flex flex-col items-center gap-2 px-4 py-10 text-center">
  <strong className="text-2xl font-medium tracking-tight text-foreground animate-in fade-in slide-in-from-bottom-1 fill-mode-both duration-200">No messages yet</strong>
  <p className="m-0 text-sm text-muted-foreground">Send a short update or request to start the conversation.</p>
 </div>;
}

export function ChatThread(props:ChatThreadProps):JSX.Element{
 const {snapshot,core,currentUsername,focusedMessageId}=props;
 const previousItems=useRef<TimelineItem[]>([]);
 const items=useMemo(()=>{
  const next=buildTimeline(snapshot.events,{currentUsername,detachedIds:snapshot.detachedIds},previousItems.current);
  previousItems.current=next;
  return next;
 },[snapshot.events,snapshot.detachedIds,currentUsername]);
 // Each active turn's row follows its trigger message, or the last item when the trigger is not loaded (spec 7.5.1).
 const turns=useMemo(()=>activeTurns(snapshot.events,props.agents,snapshot.agentStarts),[snapshot.events,props.agents,snapshot.agentStarts]);
 // A deep-link focus is pending until it scrolled into view and the reader then scrolled themselves (spec 8.5).
 const focusedRef=useRef<string|null>(null);
 const focused=useCallback((eventId:string)=>{focusedRef.current=eventId;},[]);
 const view=useMemo<ThreadView>(()=>({byId:new Map(items.map(item=>[item.id,item])),turns,props,focused}),[items,turns,props,focused]);
 const runtime=useExternalStoreRuntime({
  messages:items,convertMessage:toThreadMessage,isRunning:false,onNew:NO_ERROR,
  hasEarlier:snapshot.hasOlder,onLoadEarlier:()=>core.loadOlder(),
 });

 const panelRef=useRef<HTMLDivElement|null>(null);
 const snapshotRef=useRef(snapshot);snapshotRef.current=snapshot;
 const nearBottomRef=useRef(true);
 const [farFromBottom,setFarFromBottom]=useState(false);
 const [hasNew,setHasNew]=useState(false);
 const [focusPending,setFocusPending]=useState(focusedMessageId!==null);
 const focusPendingRef=useRef(focusPending);focusPendingRef.current=focusPending;

 const scrollToBottom=useCallback(()=>{
  const panel=panelRef.current;
  if(!panel)return;
  panel.scrollTo({top:panel.scrollHeight,behavior:'instant'});
  // The runtime renders new messages a commit later; follow them there too.
  window.requestAnimationFrame(()=>panel.scrollTo({top:panel.scrollHeight,behavior:'instant'}));
  nearBottomRef.current=true;
  setHasNew(false);setFarFromBottom(false);
 },[]);
 useImperativeHandle(props.handle,()=>({scrollToBottom}),[scrollToBottom]);
 const loadOlder=useCallback(()=>{
  const current=snapshotRef.current;
  if(!current.hasOlder||current.loading||current.loadingOlder)return;
  // The viewport keeps the previously first message in place across the prepend (it measures and restores
  // scrollTop itself, so this holds without browser scroll anchoring).
  void core.loadOlder();
 },[core]);
 const onScroll=useCallback(()=>{
  const panel=panelRef.current;
  if(!panel)return;
  const distance=distanceFromBottom(panel);
  nearBottomRef.current=distance<NEAR_BOTTOM_PX;
  if(nearBottomRef.current)setHasNew(false);
  setFarFromBottom(distance>=FAR_FROM_BOTTOM_PX);
  if(panel.scrollTop<AUTO_LOAD_PX&&!focusPendingRef.current)loadOlder();
 },[loadOlder]);

 // New content: pinned at the bottom it follows, scrolled up it offers "New messages below".
 const newest=snapshot.loading?null:newestTimelineAt(snapshot.events);
 const newestRef=useRef<number|null>(null);
 useLayoutEffect(()=>{
  const previous=newestRef.current;
  newestRef.current=newest;
  if(newest===null)return;
  if(previous===null){if(!focusedMessageId)scrollToBottom();return;}
  if(arrivedWhileAway(previous,newest,nearBottomRef.current))setHasNew(true);
  else if(newest>previous)scrollToBottom();
 },[newest]);

 useLayoutEffect(()=>{
  focusedRef.current=null;
  setFocusPending(focusedMessageId!==null);
 },[focusedMessageId]);
 useEffect(()=>{
  const panel=panelRef.current;
  if(!panel)return;
  const gesture=(event:Event)=>{
   if(focusedRef.current!==null){focusPendingRef.current=false;setFocusPending(false);}
   // Already at the top a wheel turn scrolls nothing, so no scroll event would start the auto-load.
   if(event instanceof WheelEvent&&event.deltaY<0&&panel.scrollTop<AUTO_LOAD_PX&&!focusPendingRef.current)loadOlder();
  };
  const events=['wheel','touchmove','pointerdown','keydown'] as const;
  for(const name of events)panel.addEventListener(name,gesture,{passive:true});
  return()=>{for(const name of events)panel.removeEventListener(name,gesture);};
 },[loadOlder]);

 // No channel selected yet (the shell is still loading): no conversation, so no empty state either.
 const empty=snapshot.channelId!==null&&!snapshot.loading&&items.length===0;
 return <AssistantRuntimeProvider runtime={runtime}><ChatPortalProvider><ThreadContext.Provider value={view}>
  <div className="nest-chat relative flex min-h-0 flex-1 flex-col">
   {/* Keep Huddle reachable on mobile. Export stays hidden at the existing mobile breakpoint. */}
   <div className="flex shrink-0 items-center justify-end gap-3 px-3 pb-2 empty:hidden">{props.headerActions}<span className="max-[761px]:hidden"><ExportButton items={items} channelLabel={props.channelLabel}/></span></div>
   <ThreadPrimitive.Root className="relative flex min-h-0 flex-1 flex-col">
    <ThreadPrimitive.Viewport ref={panelRef} turnAnchor="bottom" autoScroll={!focusPending} scrollToBottomOnInitialize={!focusedMessageId}
     onScroll={onScroll} className={cn('messages-panel gap-0 px-1 pt-1 pb-4 sm:ps-2 sm:pe-3',(empty||props.isConversationEmpty)&&'messages-panel-empty')}>
     {!snapshot.loading&&<LoadOlderButton loadingOlder={snapshot.loadingOlder} onClick={loadOlder}/>}
     {snapshot.loading?<ThreadLoading/>
      :snapshot.channelId===null?null
      :empty?<ThreadEmpty/>
      :<ThreadPrimitive.Messages components={MESSAGE_COMPONENTS}/>}
    </ThreadPrimitive.Viewport>
    <SelectionQuote onQuote={props.onQuote}/>
    {hasNew?<Button size="sm" className="new-messages-button absolute bottom-4 left-1/2 z-10 m-0 -translate-x-1/2 rounded-full px-4 shadow-md shadow-foreground/10 animate-in fade-in slide-in-from-bottom-1 duration-200"
     onClick={scrollToBottom}><ArrowDownIcon aria-hidden="true"/>New messages below</Button>
     // Placed like aui's ThreadScrollToBottom: centred 48 px above the viewport footer (the composer).
     :farFromBottom&&<div className="absolute inset-x-0 bottom-0 flex flex-col">
      <Button variant="outline" size="icon" aria-label="Scroll to latest" title="Scroll to latest" onClick={scrollToBottom}
       className="absolute -top-12 z-10 self-center rounded-full border border-border bg-card hover:bg-accent dark:bg-background dark:hover:bg-accent animate-in fade-in duration-200">
       <ArrowDownIcon aria-hidden="true"/>
      </Button>
     </div>}
   </ThreadPrimitive.Root>
   {props.footer}
  </div>
 </ThreadContext.Provider></ChatPortalProvider></AssistantRuntimeProvider>;
}
