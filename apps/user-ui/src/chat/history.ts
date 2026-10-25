// Channel history paging (spec 6.1, 8.3): the 7 event queries, one cursor per query, adaptive page size.
// Cursors come only from each query's own page rows, so events merged from elsewhere (deep links) never move them.
import type {EventRow} from '../types';
import {upsertEvents} from './timeline';

type ChatEventQuery={key:string;type?:string;typePrefix?:string};

// Ported from classic loadMessages; same order and filters, now used for every page.
export const CHAT_EVENT_QUERIES:ReadonlyArray<ChatEventQuery>=[
 {key:'messages',type:'message.created'},
 {key:'failed',type:'agent.turn.failed'},
 {key:'turns',typePrefix:'agent.turn.'},
 {key:'tools',typePrefix:'tool.'},
 {key:'telemetry',type:'telemetry.context.window.updated'},
 {key:'wrapper',typePrefix:'wrapper.turn.'},
 {key:'process',typePrefix:'process.'},
];
// Per query key: oldest createdAt in the contiguous window, null = exhausted. A missing key is not started yet.
export type Cursors=Readonly<Record<string,number|null>>;

// Rows at one millisecond, fetched to complete a full page's oldest millisecond (the engine's before is strict).
const BOUNDARY_LIMIT=500;

function queryUrl(channelId:string,limit:number,query:ChatEventQuery,range:{before?:number;after?:number}){
 const params=new URLSearchParams({channelId,limit:String(limit),order:'desc'});
 if(query.type)params.set('type',query.type);
 if(query.typePrefix)params.set('typePrefix',query.typePrefix);
 if(range.before!==undefined)params.set('before',String(range.before));
 if(range.after!==undefined)params.set('after',String(range.after));
 return `/api/events?${params.toString()}`;
}

function requestedQueries(cursors?:Cursors){
 return CHAT_EVENT_QUERIES.filter(query=>cursors?.[query.key]!==null);
}

export function chatQueryUrls(channelId:string,limit:number,cursors?:Cursors):Array<{key:string;url:string}>{
 return requestedQueries(cursors).map(query=>{
  const before=cursors?.[query.key];
  return {key:query.key,url:queryUrl(channelId,limit,query,typeof before==='number'?{before}:{})};
 });
}

const oldestCreatedAt=(rows:EventRow[])=>Math.min(...rows.map(row=>row.createdAt??0));

export async function fetchChannelPage(channelId:string,limit:number,cursors:Cursors|undefined,
 fetchJson:<T>(url:string)=>Promise<T>):Promise<{events:EventRow[];cursors:Cursors;newest:Cursors;hasMore:boolean}>{
 const next:Record<string,number|null>={};
 for(const query of CHAT_EVENT_QUERIES)next[query.key]=null;
 const queries=requestedQueries(cursors);
 const pages=await Promise.all(chatQueryUrls(channelId,limit,cursors).map(entry=>fetchJson<EventRow[]>(entry.url)));
 const full=queries.flatMap((query,index)=>{
  const rows=pages[index]!;
  return rows.length>0&&rows.length>=limit?[{query,oldest:oldestCreatedAt(rows)}]:[];
 });
 for(const {query,oldest} of full)next[query.key]=oldest;
 // A full page may hold only part of its oldest millisecond; fetch all of it so the next before= skips nothing.
 const boundaries=await Promise.all(full.map(({query,oldest})=>
  fetchJson<EventRow[]>(queryUrl(channelId,BOUNDARY_LIMIT,query,{before:oldest+1,after:oldest-1}))));
 const newest:Record<string,number|null>={};
 for(const query of CHAT_EVENT_QUERIES)newest[query.key]=null;
 for(let index=0;index<queries.length;index++){
  const rows=pages[index]!;
  newest[queries[index]!.key]=rows.length?Math.max(...rows.map(row=>row.createdAt??0)):null;
 }
 const events=[...pages,...boundaries].reduce<EventRow[]>((merged,rows)=>upsertEvents(merged,rows),[]);
 return {events,cursors:next,newest,hasMore:full.length>0};
}

// Ported from classic App.tsx; the caller passes navigator.connection.
export function adaptiveMessageBatchSize(connection?:{downlink?:number;effectiveType?:string;saveData?:boolean}):number{
 if(connection?.saveData)return 12;
 const effectiveType=connection?.effectiveType??'';
 if(effectiveType.includes('2g'))return 10;
 if(effectiveType.includes('3g'))return 20;
 if(typeof connection?.downlink==='number'){
  if(connection.downlink>=10)return 50;
  if(connection.downlink>=5)return 40;
 }
 return 30;
}
