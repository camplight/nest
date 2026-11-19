// Single source of the chat's display rules (spec 8.2, 6.3, 6.5, 7.1.2): engine events in, timeline items and ThreadMessageLike out.
import type {EventRow} from '../types';
import type {ThreadMessageLike} from './aui';

export type AuthorKind='human'|'agent'|'system'|'activity';
export type MessageAttachment={fileId:string;name:string;mime?:string;size?:number};
export type ChatMeta={eventId:string;authorKind:AuthorKind;authorName:string;isMine:boolean;
 displayAt:number;targetAgents:string[];inReplyTo?:string;detached?:boolean;
 /** Activity only: the reply this group belongs to, shown inside that reply. */
 belongsTo?:string};
export type TimelineItem=
 |{kind:'message';id:string;meta:ChatMeta;text:string;markdown:boolean;attachments:MessageAttachment[];event:EventRow}
 |{kind:'activity';id:string;meta:ChatMeta;tone:'agent'|'system';events:EventRow[]};
type BuildOptions={currentUsername:string;detachedIds?:ReadonlySet<string>};

// Ported from classic App.tsx (MARKDOWN_HINT_RE, URL_RE).
const MARKDOWN_HINT_RE=
 /(^|\n)\s{0,3}(#{1,6}\s|[-*+]\s|\d+\.\s|>\s)|`{1,3}[^`]|(\*\*|__)[^*_]+(\*\*|__)|(\*|_)[^*_]+(\*|_)|\[[^\]]+\]\([^)]+\)|!\[[^\]]*\]\([^)]+\)|(^|\n)\|.+\|/m;
const URL_RE=/(https?:\/\/[^\s<]+)/i;
const TRACE_TYPES=new Set([
 'agent.turn.started','agent.turn.phase','agent.turn.completed','agent.turn.failed',
 'wrapper.turn.started','wrapper.turn.completed','wrapper.turn.failed',
 'process.started','process.output','process.exited',
 'tool.started','tool.executed','tool.failed',
 'telemetry.context.window.updated',
 'agent.turn.cancel_requested','agent.context.compacted',
 'telemetry.nest.connection.action',
]);
const TURN_STARTS=new Set(['agent.turn.started','wrapper.turn.started']);
const TURN_ENDS=new Set(['agent.turn.completed','agent.turn.failed','wrapper.turn.completed','wrapper.turn.failed']);
const isTurnEvent=(event:EventRow)=>event.type.startsWith('agent.turn.')||event.type.startsWith('wrapper.turn.');
// Events that say only that an agent woke up and went back to sleep. Every message in a chat wakes each agent in
// it; a turn made of nothing else, with no reply, has nothing to show (spec: agent activity lines).
const QUIET_TYPES=new Set(['agent.turn.started','agent.turn.phase','agent.turn.completed','wrapper.turn.started','wrapper.turn.completed',
 'telemetry.context.window.updated','agent.context.compacted']);
const quiet=(event:EventRow)=>{
 if(QUIET_TYPES.has(event.type))return event.type!=='agent.turn.completed'||record(event.payload)?.cancelled!==true;
 if(event.type!=='process.exited')return false;
 const payload=record(event.payload);
 return payload?.exitCode===0&&payload.timedOut!==true;
};
const CONTINUATION_MS=5*60_000;

const record=(payload:unknown):Record<string,unknown>|undefined=>
 payload&&typeof payload==='object'&&!Array.isArray(payload)?payload as Record<string,unknown>:undefined;

function messageText(event:EventRow){
 if(event.payloadTruncated)return '[Message too large to display. The original content is retained.]';
 const payload=record(event.payload);
 if(!payload)return '';
 if(event.type==='agent.turn.failed')return typeof payload.error==='string'?`Agent error: ${payload.error}`:'Agent failed to respond.';
 return typeof payload.text==='string'?payload.text:'';
}

function shouldRenderMarkdown(text:string){
 const trimmed=text.trim();
 if(!trimmed)return false;
 return MARKDOWN_HINT_RE.test(trimmed)||URL_RE.test(trimmed);
}

function sourceLabel(source:string){
 if(source.startsWith('human:'))return source.slice('human:'.length)||'Human';
 if(source.startsWith('agent:'))return source.slice('agent:'.length)||'Agent';
 return source||'System';
}

function authorKind(source:string):AuthorKind{
 if(source.startsWith('human:'))return 'human';
 if(source.startsWith('agent:'))return 'agent';
 return 'system';
}

const displayTime=(event:EventRow)=>event.deliverAt??event.createdAt??0;

function parseMessageAttachments(payload:unknown):MessageAttachment[]{
 const attachments=record(payload)?.attachments;
 if(!Array.isArray(attachments))return [];
 const result:MessageAttachment[]=[];
 for(const entry of attachments){
  const item=record(entry);
  if(!item)continue;
  const fileId=typeof item.fileId==='string'?item.fileId.trim():'';
  if(!fileId)continue;
  const name=typeof item.name==='string'&&item.name.trim()?item.name.trim():fileId;
  const mime=typeof item.mime==='string'&&item.mime.trim()?item.mime.trim():undefined;
  const size=typeof item.size==='number'&&Number.isFinite(item.size)?Math.max(0,item.size):undefined;
  result.push({fileId,name,...(mime===undefined?{}:{mime}),...(size===undefined?{}:{size})});
 }
 return result;
}

function targetAgents(payload:unknown):string[]{
 const data=record(payload);
 if(!data)return [];
 if(Array.isArray(data.targetAgentNames))return data.targetAgentNames.map(String);
 if(data.targetAgentName!==undefined&&data.targetAgentName!==null)return [String(data.targetAgentName)];
 return [];
}

export function isTraceEvent(event:EventRow):boolean{
 return TRACE_TYPES.has(event.type);
}

// Sort key ported from classic mergeEventsChronologically: deliverAt ?? createdAt, then createdAt, then id.
export function upsertEvents(current:EventRow[],incoming:EventRow[]):EventRow[]{
 const byId=new Map<string,EventRow>();
 for(const event of current)byId.set(event.id,event);
 for(const event of incoming)byId.set(event.id,event);
 return [...byId.values()].sort((left,right)=>{
  const primary=displayTime(left)-displayTime(right);
  if(primary!==0)return primary;
  const created=(left.createdAt??0)-(right.createdAt??0);
  if(created!==0)return created;
  return left.id.localeCompare(right.id);
 });
}

function messageItem(event:EventRow,opts:BuildOptions,previousMessageId?:string):TimelineItem{
 const kind=authorKind(event.source);
 const authorName=sourceLabel(event.source);
 const payload=record(event.payload);
 const text=messageText(event);
 const meta:ChatMeta={eventId:event.id,authorKind:kind,authorName,isMine:kind==='human'&&authorName===opts.currentUsername,
  displayAt:displayTime(event),targetAgents:targetAgents(payload)};
 if(typeof payload?.inReplyTo==='string')meta.inReplyTo=payload.inReplyTo;
 // An agent's reply names the message that started its turn. When other messages came in between, the reply
 // shows which one it answers; directly after its question it needs no link.
 else if(kind==='agent'&&event.parentEventId&&event.parentEventId!==previousMessageId)meta.inReplyTo=event.parentEventId;
 if(opts.detachedIds?.has(event.id))meta.detached=true;
 return {kind:'message',id:event.id,meta,text,markdown:shouldRenderMarkdown(text),attachments:parseMessageAttachments(payload),event};
}

function activityItem(events:EventRow[],id:string,opts:BuildOptions,belongsTo?:string):TimelineItem{
 const first=events[0]!;
 const tone=events.some(event=>event.type==='agent.turn.failed'||event.type==='tool.failed')?'system':'agent';
 const meta:ChatMeta={eventId:first.id,authorKind:'activity',authorName:sourceLabel(first.source),isMine:false,
  displayAt:displayTime(first),targetAgents:[]};
 if(belongsTo)meta.belongsTo=belongsTo;
 if(events.some(event=>opts.detachedIds?.has(event.id)))meta.detached=true;
 return {kind:'activity',id,meta,tone,events};
}

// A group keeps the id of the earliest previous activity item that shares one of its events and is not yet taken
// (a group split by a new message keeps the id in its first part); otherwise its earliest event id not yet taken;
// failing that, `<first event id>~<n>` with the smallest free n. So no id repeats (assistant-ui rejects duplicates).
function groupId(events:EventRow[],previousActivity:readonly TimelineItem[],taken:ReadonlySet<string>){
 const ids=new Set(events.map(event=>event.id));
 const match=previousActivity.find(item=>item.kind==='activity'&&!taken.has(item.id)&&item.events.some(event=>ids.has(event.id)));
 if(match)return match.id;
 const free=events.find(event=>!taken.has(event.id));
 if(free)return free.id;
 let suffix=1;
 while(taken.has(`${events[0]!.id}~${suffix}`))suffix++;
 return `${events[0]!.id}~${suffix}`;
}

const sameEvent=(left:EventRow,right:EventRow)=>left===right&&left.id===right.id&&left.status===right.status;

function sameMeta(left:ChatMeta,right:ChatMeta){
 return left.eventId===right.eventId&&left.authorKind===right.authorKind&&left.authorName===right.authorName&&
  left.isMine===right.isMine&&left.displayAt===right.displayAt&&left.inReplyTo===right.inReplyTo&&left.belongsTo===right.belongsTo&&
  Boolean(left.detached)===Boolean(right.detached)&&left.targetAgents.length===right.targetAgents.length&&
  left.targetAgents.every((name,index)=>name===right.targetAgents[index]);
}

function unchanged(prev:TimelineItem,next:TimelineItem){
 if(!sameMeta(prev.meta,next.meta))return false;
 if(prev.kind==='message'&&next.kind==='message')return sameEvent(prev.event,next.event);
 if(prev.kind==='activity'&&next.kind==='activity')
  return prev.events.length===next.events.length&&prev.events.every((event,index)=>sameEvent(event,next.events[index]!));
 return false;
}

export function buildTimeline(events:EventRow[],opts:BuildOptions,previous?:readonly TimelineItem[]):TimelineItem[]{
 const previousById=new Map((previous??[]).map(item=>[item.id,item]));
 const previousActivity=(previous??[]).filter(item=>item.kind==='activity');
 const items:TimelineItem[]=[];
 const taken=new Set<string>();
 const reuse=(item:TimelineItem)=>{
  const prev=previousById.get(item.id);
  taken.add(item.id);
  items.push(prev&&unchanged(prev,item)?prev:item);
 };
 // A turn's events go with the agent's reply in that turn (spec: agent activity lines). Slots keep the
 // display order; a group sits directly after the reply it belongs to and records it, so ChatThread shows it inside.
 type Group={events:EventRow[]};
 type Slot={message:EventRow}|{group:Group;reply?:string};
 // A wrapped agent's turn is reported twice, by the engine (agent.turn.*) and by its wrapper (wrapper.turn.*), for
 // the same trigger. Both layers make one turn; it ends when every layer that started has ended.
 type Turn={group:Group;reply?:EventRow;slotted?:boolean;trigger?:unknown;layers:Set<string>};
 const slots:Slot[]=[];
 const open=new Map<string,Turn>();
 const replyGroups=new Map<string,Group>(); // reply event id → its group
 const lastReply=new Map<string,EventRow>(); // agent → most recent reply
 let loose:Group|undefined; // consecutive events with no known agent and no earlier reply
 // History loads each event type in its own pages, so older tool and action events can arrive without their
 // turn's boundaries. Before the oldest loaded turn event, an agent's events are taken as a turn whose start
 // is not loaded: they go with that agent's next reply, or stay where they are when it has none.
 const turnsFrom=Math.min(...events.filter(isTurnEvent).map(event=>event.createdAt??0));
 const placeAfter=(reply:EventRow,group:Group)=>{
  const index=slots.findIndex(slot=>'message' in slot&&slot.message===reply);
  slots.splice(index+1,0,{group,reply:reply.id});
  replyGroups.set(reply.id,group);
 };
 const finish=(agent:string)=>{
  const turn=open.get(agent);
  if(!turn)return;
  open.delete(agent);
  if(turn.slotted&&turn.reply)slots.splice(slots.findIndex(slot=>'group' in slot&&slot.group===turn.group),1);
  const existing=turn.reply&&replyGroups.get(turn.reply.id);
  if(existing)existing.events.push(...turn.group.events);
  else if(turn.reply)placeAfter(turn.reply,turn.group);
  else if(!turn.slotted)slots.push({group:turn.group});
 };
 const agentOf=(event:EventRow):string|undefined=>{
  const payload=record(event.payload);
  // Actions name the agent; process, Stop and wrapped-turn events name it as owner or target.
  for(const key of ['agentName','ownerAgentName','targetAgentName']){
   const named=payload?.[key];
   if(typeof named==='string'&&named)return named;
  }
  if(event.source.startsWith('agent:'))return event.source.slice(6);
  // Runner events that name no agent belong to the most recently started open turn.
  return [...open.keys()].at(-1);
 };
 for(const event of events){
  if(event.type==='message.created'){
   loose=undefined;
   slots.push({message:event});
   const agent=event.source.startsWith('agent:')?event.source.slice(6):undefined;
   if(agent){lastReply.set(agent,event);const turn=open.get(agent);if(turn)turn.reply=event;}
   continue;
  }
  if(!isTraceEvent(event))continue;
  const agent=agentOf(event);
  const layer=event.type.split('.')[0]!;
  if(TURN_STARTS.has(event.type)&&agent){
   const trigger=record(event.payload)?.triggerEventId;
   const current=open.get(agent);
   if(current&&trigger!==undefined&&current.trigger===trigger&&!current.layers.has(layer)){
    current.layers.add(layer);
    current.group.events.push(event);
    continue;
   }
   finish(agent);
   loose=undefined;
   open.set(agent,{group:{events:[event]},trigger,layers:new Set([layer])});
   continue;
  }
  const turn=agent?open.get(agent):undefined;
  if(turn){
   turn.group.events.push(event);
   if(TURN_ENDS.has(event.type)){
    turn.layers.delete(layer);
    if(turn.layers.size===0)finish(agent!);
   }
   continue;
  }
  if(agent&&(event.createdAt??0)<turnsFrom){
   const group={events:[event]};
   slots.push({group});
   open.set(agent,{group,slotted:true,layers:new Set()});
   continue;
  }
  const reply=agent?lastReply.get(agent):undefined;
  if(reply){
   const group=replyGroups.get(reply.id);
   if(group)group.events.push(event);else placeAfter(reply,{events:[event]});
   continue;
  }
  if(!loose){loose={events:[]};slots.push({group:loose});}
  loose.events.push(event);
 }
 for(const agent of [...open.keys()])finish(agent);
 let previousMessageId:string|undefined;
 for(const slot of slots){
  if('message' in slot){reuse(messageItem(slot.message,opts,previousMessageId));previousMessageId=slot.message.id;}
  else if(slot.group.events.length&&(slot.reply||!slot.group.events.every(quiet)))reuse(activityItem(slot.group.events,groupId(slot.group.events,previousActivity,taken),opts,slot.reply));
 }
 return items;
}

/** A group is shown inside the message it belongs to when it follows it directly, both loaded, same day. */
export function attachesTo(previous:TimelineItem|undefined,item:TimelineItem|undefined):boolean{
 return item?.kind==='activity'&&previous?.kind==='message'&&item.meta.belongsTo===previous.id&&
  !previous.meta.detached&&!item.meta.detached&&dayKey(previous.meta.displayAt)===dayKey(item.meta.displayAt);
}

export function dayKey(ts:number):string{
 const date=new Date(ts);
 const pad=(value:number)=>String(value).padStart(2,'0');
 return `${date.getFullYear()}-${pad(date.getMonth()+1)}-${pad(date.getDate())}`;
}

export function isContinuation(prev:TimelineItem|undefined,item:TimelineItem):boolean{
 if(!prev||prev.kind!=='message'||item.kind!=='message')return false;
 if(prev.meta.authorKind!==item.meta.authorKind||prev.meta.authorName!==item.meta.authorName)return false;
 if(dayKey(prev.meta.displayAt)!==dayKey(item.meta.displayAt))return false;
 const gap=item.meta.displayAt-prev.meta.displayAt;
 return gap>=0&&gap<CONTINUATION_MS;
}

// One item, one message (spec 8.2): never set status (it would mark a run active) or attachments (rejected on assistant messages).
export function toThreadMessage(item:TimelineItem):ThreadMessageLike{
 const base={id:item.id,createdAt:new Date(item.meta.displayAt),metadata:{custom:item.meta}};
 if(item.kind==='activity')
  return {...base,role:'assistant',content:[{type:'data-nest-activity',data:{events:item.events,tone:item.tone}}]};
 return {...base,role:item.meta.authorKind==='human'?'user':'assistant',content:[
  {type:'text',text:item.text},
  ...(item.attachments.length>0?[{type:'data-nest-attachments' as const,data:item.attachments}]:[]),
 ]};
}
