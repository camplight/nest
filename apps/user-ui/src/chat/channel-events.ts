// Live events of the active channel (spec 3.3, 6.1, 6.2, 8.3): first page, older pages, refresh, deep-link focus,
// realtime dedup and merge. Framework-free; useChannelEvents binds it to React. One core per authenticated session.
import type {EventRow} from '../types';
import {fetchChannelPage,type Cursors} from './history';
import {isTraceEvent,upsertEvents} from './timeline';
import {agentLifecycleStart,mergeAgentStarts,type AgentStarts} from './lifecycles';

export type ChannelEventsSnapshot={channelId:string|null;events:EventRow[];detachedIds:ReadonlySet<string>;
 loading:boolean;loadingOlder:boolean;hasOlder:boolean;error:string|null;agentStarts?:AgentStarts;activityUnavailable?:boolean};
export type RefreshResult={newTimeline:boolean;newestMessageAt:number};
type Deps={fetchJson:<T>(url:string)=>Promise<T>;limit:()=>number;loadAgentStarts?:()=>Promise<AgentStarts>};

const LOAD_ERROR='Unable to load messages';
const OLDER_ERROR='Unable to load previous messages';
// Ported from classic rememberWsEvent: the oldest remembered id is dropped past this size.
const SEEN_LIMIT=3000;
const NO_REFRESH:RefreshResult={newTimeline:false,newestMessageAt:0};
const EMPTY:ChannelEventsSnapshot={channelId:null,events:[],detachedIds:new Set(),loading:false,loadingOlder:false,hasOlder:false,error:null};

const isTimelineEvent=(event:EventRow)=>event.type==='message.created'||isTraceEvent(event);
const isMessageEvent=(event:EventRow)=>event.type==='message.created'||event.type==='agent.turn.failed';
const newestCreatedAt=(events:EventRow[],include:(event:EventRow)=>boolean)=>
 events.reduce((newest,event)=>include(event)?Math.max(newest,event.createdAt??0):newest,0);

// Events compare by id and status, as seen() does; the order is part of the comparison.
const sameEvents=(left:EventRow[],right:EventRow[])=>left===right||(left.length===right.length&&
 left.every((event,index)=>event.id===right[index].id&&event.status===right[index].status));
const sameSnapshot=(left:ChannelEventsSnapshot,right:ChannelEventsSnapshot)=>
 left.channelId===right.channelId&&left.detachedIds===right.detachedIds&&left.loading===right.loading&&
 left.loadingOlder===right.loadingOlder&&left.hasOlder===right.hasOlder&&left.error===right.error&&
 left.agentStarts===right.agentStarts&&left.activityUnavailable===right.activityUnavailable&&
 sameEvents(left.events,right.events);

// A window page that holds a detached event reattaches it: the cursors now cover it.
function reattach(detached:ReadonlySet<string>,rows:EventRow[]):ReadonlySet<string>{
 if(detached.size===0||!rows.some(row=>detached.has(row.id)))return detached;
 const next=new Set(detached);
 for(const row of rows)next.delete(row.id);
 return next;
}

export function createChannelEventsCore(deps:Deps){
 let state=EMPTY;
 // Window cursors come only from page results (spec 8.3): focus never moves them.
 let cursors:Cursors|undefined;
 let newest:Cursors|undefined;
 let refreshing:Promise<RefreshResult>|undefined;
 // Bumped by every switchTo; a response whose generation is stale is dropped.
 let generation=0;
 const listeners=new Set<()=>void>();
 const seenStatus=new Map<string,string|undefined>();
 const newestTimelineAt=new Map<string,number>();

 // The snapshot stays the same object when nothing changed (no re-render per idle poll).
 const update=(patch:Partial<ChannelEventsSnapshot>)=>{
  const next={...state,...patch};
  if(sameSnapshot(state,next))return;
  state=next;
  for(const listener of [...listeners])listener();
 };
 const page=(channelId:string,from?:Cursors)=>fetchChannelPage(channelId,deps.limit(),from,deps.fetchJson);
 const head=async(channelId:string)=>{
  const [latest,activity]=await Promise.all([page(channelId),deps.loadAgentStarts?.()
   .then(starts=>({starts,unavailable:false})).catch(()=>({starts:{},unavailable:true}))]);
  return {...latest,activity};
 };
 const activityPatch=(activity:{starts:AgentStarts;unavailable:boolean}|undefined)=>activity
  ?{agentStarts:mergeAgentStarts(state.agentStarts??{},activity.starts),activityUnavailable:activity.unavailable}:{};
 const eventUrl=(eventId:string)=>`/api/events/${encodeURIComponent(eventId)}`;
 // True when timeline events newer than any loaded before arrived; the channel's first load never counts.
 function noteTimeline(channelId:string,events:EventRow[]){
  const previous=newestTimelineAt.get(channelId)??0;
  const next=newestCreatedAt(events,isTimelineEvent);
  if(next>previous)newestTimelineAt.set(channelId,next);
  return previous>0&&next>previous;
 }
 const merged=(rows:EventRow[])=>({events:upsertEvents(state.events,rows),detachedIds:reattach(state.detachedIds,rows)});

 return {
  async switchTo(channelId:string|null):Promise<void>{
   const token=++generation;
   cursors=undefined;newest=undefined;refreshing=undefined;
   update({...EMPTY,channelId,loading:channelId!==null});
   if(channelId===null)return;
   try{
    const first=await head(channelId);
    if(token!==generation)return;
    cursors=first.cursors;newest=first.newest;
    noteTimeline(channelId,first.events);
    update({...merged(first.events),...activityPatch(first.activity),hasOlder:first.hasMore,loading:false});
   }catch{
    if(token===generation)update({loading:false,error:LOAD_ERROR});
   }
  },

  async refresh():Promise<RefreshResult>{
   const channelId=state.channelId;
   if(channelId===null||state.loading)return NO_REFRESH;
   if(refreshing)return refreshing;
   const token=generation;
   const task=(async()=>{
   // Each failed refresh reports again, as the classic poll did.
   if(state.error!==null)update({error:null});
   try{
    const latest=await head(channelId);
    if(token!==generation)return NO_REFRESH;
    let rows=latest.events;
    if(cursors===undefined){
     // The first request may have failed. A successful refresh establishes a window.
     cursors=latest.cursors;newest=latest.newest;
     const newTimeline=noteTimeline(channelId,rows);
     update({...merged(rows),...activityPatch(latest.activity),hasOlder:latest.hasMore});
     return {newTimeline,newestMessageAt:newestCreatedAt(rows,isMessageEvent)};
    }
    // A reconnect can skip more than one page. Walk each event stream back to its
    // previous high-water mark before committing the new head. Keep the old history
    // cursors: they still describe the bottom of the contiguous loaded window.
    let bridge=latest.cursors;
    for(;;){
     const missing=Object.fromEntries(Object.entries(bridge).map(([key,before])=>
      [key,before!==null&&before>(newest?.[key]??-Infinity)?before:null]));
     if(!Object.values(missing).some(before=>before!==null))break;
     const older=await page(channelId,missing);
     if(token!==generation)return NO_REFRESH;
     rows=upsertEvents(rows,older.events);
     bridge=older.cursors;
    }
    newest=latest.newest;
    const newTimeline=noteTimeline(channelId,rows);
    update({...merged(rows),...activityPatch(latest.activity)});
    return {newTimeline,newestMessageAt:newestCreatedAt(rows,isMessageEvent)};
   }catch{
    if(token===generation)update({error:LOAD_ERROR});
    return NO_REFRESH;
   }
   })();
   refreshing=task;
   try{return await task;}finally{if(refreshing===task)refreshing=undefined;}
  },

  async loadOlder():Promise<void>{
   const channelId=state.channelId;
   if(channelId===null||!cursors||!state.hasOlder||state.loading||state.loadingOlder)return;
   const token=generation;
   update({loadingOlder:true,error:null});
   try{
    const older=await page(channelId,cursors);
    if(token!==generation)return;
    cursors=older.cursors;
    update({...merged(older.events),hasOlder:older.hasMore,loadingOlder:false});
   }catch{
    if(token===generation)update({loadingOlder:false,error:OLDER_ERROR});
   }
  },

  async focus(eventId:string):Promise<'loaded'|'missing'|'other-channel'>{
   const channelId=state.channelId;
   if(state.events.some(event=>event.id===eventId))return 'loaded';
   const token=generation;
   let event:EventRow;
   try{
    event=await deps.fetchJson<EventRow>(eventUrl(eventId));
   }catch{
    return 'missing';
   }
   if(token!==generation||channelId===null||event.channelId!==channelId)return 'other-channel';
   if(state.events.some(loaded=>loaded.id===event.id))return 'loaded';
   update({events:upsertEvents(state.events,[event]),detachedIds:new Set([...state.detachedIds,event.id])});
   return 'loaded';
  },

  seen(eventId:string,status?:string):'new'|'update'|'duplicate'{
   if(!seenStatus.has(eventId)){
    seenStatus.set(eventId,status);
    if(seenStatus.size>SEEN_LIMIT){
     const first=seenStatus.keys().next();
     if(!first.done)seenStatus.delete(first.value);
    }
    return 'new';
   }
   if(status===undefined||seenStatus.get(eventId)===status)return 'duplicate';
   seenStatus.set(eventId,status);
   return 'update';
  },

  async lookup(eventId:string):Promise<EventRow|null>{
   const loaded=state.events.find(event=>event.id===eventId);
   if(loaded)return loaded;
   try{
    return await deps.fetchJson<EventRow>(eventUrl(eventId));
   }catch{
    return null;
   }
  },

  observeLifecycle(event:EventRow):void{
   const start=agentLifecycleStart(event);
   if(start&&state.channelId!==null)update({agentStarts:mergeAgentStarts(state.agentStarts??{},{[start.agent]:start.at})});
  },

  ingest(event:EventRow):{accepted:boolean}{
   const channelId=state.channelId;
   if(channelId===null||event.channelId!==channelId||!isTimelineEvent(event))return {accepted:false};
   noteTimeline(channelId,[event]);
   update({events:upsertEvents(state.events,[event])});
   return {accepted:true};
  },

  snapshot():ChannelEventsSnapshot{
   return state;
  },

  subscribe(listener:()=>void):()=>void{
   listeners.add(listener);
   return ()=>{listeners.delete(listener);};
  },
 };
}
export type ChannelEventsCore=ReturnType<typeof createChannelEventsCore>;
