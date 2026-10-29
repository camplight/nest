// Single source of the chat's display rules (spec 8.2, 6.3, 6.5, 7.1.2): engine events in, timeline items and ThreadMessageLike out.
import type {EventRow} from '../types';
import type {ThreadMessageLike} from './aui';

export type AuthorKind='human'|'agent'|'system'|'activity';
export type MessageAttachment={fileId:string;name:string;mime?:string;size?:number};
export type ChatMeta={eventId:string;authorKind:AuthorKind;authorName:string;isMine:boolean;
 displayAt:number;targetAgents:string[];inReplyTo?:string;detached?:boolean};
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
]);
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

function messageItem(event:EventRow,opts:BuildOptions):TimelineItem{
 const kind=authorKind(event.source);
 const authorName=sourceLabel(event.source);
 const payload=record(event.payload);
 const text=messageText(event);
 const meta:ChatMeta={eventId:event.id,authorKind:kind,authorName,isMine:kind==='human'&&authorName===opts.currentUsername,
  displayAt:displayTime(event),targetAgents:targetAgents(payload)};
 if(typeof payload?.inReplyTo==='string')meta.inReplyTo=payload.inReplyTo;
 if(opts.detachedIds?.has(event.id))meta.detached=true;
 return {kind:'message',id:event.id,meta,text,markdown:shouldRenderMarkdown(text),attachments:parseMessageAttachments(payload),event};
}

function activityItem(events:EventRow[],id:string,opts:BuildOptions):TimelineItem{
 const first=events[0]!;
 const tone=events.some(event=>event.type==='agent.turn.failed'||event.type==='tool.failed')?'system':'agent';
 const meta:ChatMeta={eventId:first.id,authorKind:'activity',authorName:sourceLabel(first.source),isMine:false,
  displayAt:displayTime(first),targetAgents:[]};
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
  left.isMine===right.isMine&&left.displayAt===right.displayAt&&left.inReplyTo===right.inReplyTo&&
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
 let trace:EventRow[]=[];
 const flush=()=>{
  if(trace.length===0)return;
  reuse(activityItem(trace,groupId(trace,previousActivity,taken),opts));
  trace=[];
 };
 for(const event of events){
  if(event.type==='message.created'){
   flush();
   reuse(messageItem(event,opts));
  }else if(isTraceEvent(event))trace.push(event);
 }
 flush();
 return items;
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
