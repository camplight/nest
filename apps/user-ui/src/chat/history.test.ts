import {describe,expect,it} from 'vitest';
import {CHAT_EVENT_QUERIES,adaptiveMessageBatchSize,chatQueryUrls,fetchChannelPage,type Cursors} from './history';
import {upsertEvents} from './timeline';
import type {EventRow} from '../types';

const ev=(id:string,type:string,createdAt:number,extra:Partial<EventRow>={}):EventRow=>
 ({id,type,source:'agent:Pip',payload:{},createdAt,channelId:'c1',...extra});
const KEYS=['messages','failed','turns','tools','telemetry','wrapper','process'];
const FILTERS=['type=message.created','type=agent.turn.failed','typePrefix=agent.turn.','typePrefix=tool.',
 'type=telemetry.context.window.updated','typePrefix=wrapper.turn.','typePrefix=process.'];
const allNull=(over:Record<string,number|null>):Cursors=>({...Object.fromEntries(KEYS.map(key=>[key,null])),...over});

// Fake engine listing (vendor events route): channelId, type or typePrefix, strict after/before on createdAt, desc, limit.
function fakeServer(rows:EventRow[]){
 const requests:string[]=[];
 const fetchJson=async <T,>(url:string):Promise<T>=>{
  requests.push(url);
  const params=new URL(url,'http://nest.test').searchParams;
  const type=params.get('type'),prefix=params.get('typePrefix'),channel=params.get('channelId');
  const before=params.get('before'),after=params.get('after');
  const limit=Number(params.get('limit')??100);
  const matched=rows.filter(row=>(!channel||row.channelId===channel)&&(!type||row.type===type)&&
   (!prefix||row.type.startsWith(prefix))&&(before===null||(row.createdAt??0)<Number(before))&&
   (after===null||(row.createdAt??0)>Number(after)));
  const sorted=[...matched].sort((left,right)=>(left.createdAt??0)-(right.createdAt??0)||left.id.localeCompare(right.id));
  if(params.get('order')==='desc')sorted.reverse();
  return sorted.slice(0,limit) as T;
 };
 return {fetchJson,requests};
}
const filterOf=(url:string)=>FILTERS.find(filter=>new URL(url,'http://nest.test').search.includes(`&${filter}`)||url.includes(`?${filter}`));
const mainRequests=(requests:string[])=>requests.filter(url=>!url.includes('after='));

describe('chatQueryUrls',()=>{
 it('seven queries',()=>{
  const urls=chatQueryUrls('c1',30);
  expect(urls.map(entry=>entry.key)).toEqual(KEYS);
  expect(urls.map(entry=>entry.url)).toEqual(FILTERS.map(filter=>`/api/events?channelId=c1&limit=30&order=desc&${filter}`));
  expect(CHAT_EVENT_QUERIES).toHaveLength(7);
 });

 it('per-type cursors',()=>{
  const urls=chatQueryUrls('c1',30,allNull({messages:500,tools:200}));
  expect(urls).toEqual([
   {key:'messages',url:'/api/events?channelId=c1&limit=30&order=desc&type=message.created&before=500'},
   {key:'tools',url:'/api/events?channelId=c1&limit=30&order=desc&typePrefix=tool.&before=200'},
  ]);
 });

 it('treats a key missing from the cursors as not started',()=>{
  const urls=chatQueryUrls('c1',30,{messages:500,tools:null});
  expect(urls.map(entry=>entry.key)).toEqual(['messages','failed','turns','telemetry','wrapper','process']);
  expect(urls.filter(entry=>entry.url.includes('before='))).toEqual([
   {key:'messages',url:'/api/events?channelId=c1&limit=30&order=desc&type=message.created&before=500'},
  ]);
 });

 it('encodes the channel id',()=>{
  expect(chatQueryUrls('a b&c',10)[0]).toEqual({key:'messages',url:'/api/events?channelId=a+b%26c&limit=10&order=desc&type=message.created'});
 });
});

describe('fetchChannelPage',()=>{
 it('cursor after a page',async()=>{
  // 30 tool rows at 120..149 whose deliverAt is older than createdAt, plus older messages in the same page.
  const tools=Array.from({length:30},(_,index)=>ev(`t${index}`,'tool.started',120+index,{deliverAt:50+index}));
  const messages=Array.from({length:5},(_,index)=>ev(`m${index}`,'message.created',10+index));
  const full=fakeServer([...tools,...messages]);
  const page=await fetchChannelPage('c1',30,undefined,full.fetchJson);
  expect(page.cursors).toEqual({messages:null,failed:null,turns:null,tools:120,telemetry:null,wrapper:null,process:null});
  expect(page.hasMore).toBe(true);
  expect(page.events.map(event=>event.id).sort()).toEqual([...tools,...messages].map(event=>event.id).sort());

  const short=fakeServer([...tools.slice(0,29),...messages]);
  const shortPage=await fetchChannelPage('c1',30,undefined,short.fetchJson);
  expect(shortPage.cursors).toEqual(allNull({}));
  expect(shortPage.hasMore).toBe(false);
 });

 it('keeps hasMore from the requested queries only and leaves null cursors null',async()=>{
  const tools=Array.from({length:3},(_,index)=>ev(`t${index}`,'tool.started',100+index));
  const messages=Array.from({length:4},(_,index)=>ev(`m${index}`,'message.created',100+index));
  const server=fakeServer([...tools,...messages]);
  const page=await fetchChannelPage('c1',2,allNull({messages:200}),server.fetchJson);
  expect(mainRequests(server.requests)).toEqual(['/api/events?channelId=c1&limit=2&order=desc&type=message.created&before=200']);
  expect(page.cursors).toEqual(allNull({messages:102}));
  expect(page.hasMore).toBe(true);
  expect(page.events.map(event=>event.id)).toEqual(['m2','m3']);
 });

 it('keeps one row per id across overlapping queries',async()=>{
  // agent.turn.failed matches both type=agent.turn.failed and typePrefix=agent.turn.
  const server=fakeServer([ev('f1','agent.turn.failed',10),ev('m1','message.created',11)]);
  const page=await fetchChannelPage('c1',30,undefined,server.fetchJson);
  expect(page.events.map(event=>event.id)).toEqual(['f1','m1']);
 });

 it('no gap',async()=>{
  const all=Array.from({length:100},(_,index)=>ev(`m${index+1}`,'message.created',index+1));
  const server=fakeServer(all);
  const first=await fetchChannelPage('c1',30,undefined,server.fetchJson);
  expect(first.events.map(event=>event.createdAt)).toEqual(Array.from({length:30},(_,index)=>71+index));
  // A reply link loads an old event outside the window (spec 8.3); the caller merges it.
  let timeline=upsertEvents(first.events,[all[9]!]);
  let cursors=first.cursors;
  const older:EventRow[]=[];
  for(let round=0;round<3;round++){
   const page=await fetchChannelPage('c1',30,cursors,server.fetchJson);
   older.push(...page.events);
   timeline=upsertEvents(timeline,page.events);
   cursors=page.cursors;
   if(round<2)expect(page.hasMore).toBe(true);
  }
  expect(older.map(event=>event.createdAt).sort((left,right)=>(left??0)-(right??0))).toEqual(Array.from({length:70},(_,index)=>index+1));
  expect(timeline.map(event=>event.createdAt)).toEqual(Array.from({length:100},(_,index)=>index+1));
  expect(cursors.messages).toBeNull();
 });

 it('every page uses all 7 queries',async()=>{
  const rows=KEYS.flatMap((_,queryIndex)=>Array.from({length:4},(__,index)=>
   ev(`q${queryIndex}-${index}`,['message.created','agent.turn.failed','agent.turn.started','tool.started',
    'telemetry.context.window.updated','wrapper.turn.started','process.output'][queryIndex]!,100+index)));
  const server=fakeServer(rows);
  const first=await fetchChannelPage('c1',2,undefined,server.fetchJson);
  expect(mainRequests(server.requests).map(filterOf)).toEqual(FILTERS);
  server.requests.length=0;
  const second=await fetchChannelPage('c1',2,first.cursors,server.fetchJson);
  expect(mainRequests(server.requests).map(filterOf)).toEqual(FILTERS);
  expect(mainRequests(server.requests).every(url=>url.includes('&before='))).toBe(true);
  expect(second.hasMore).toBe(true);
 });

 it('keeps rows that share the boundary millisecond',async()=>{
  // 25 tool rows at 151..175 and 8 at 150: the first page of 30 holds only 5 of the 150 rows.
  const tools=[
   ...Array.from({length:25},(_,index)=>ev(`a${index}`,'tool.started',151+index)),
   ...Array.from({length:8},(_,index)=>ev(`b${index}`,'tool.executed',150)),
   ...Array.from({length:10},(_,index)=>ev(`c${index}`,'tool.started',100+index)),
  ];
  const server=fakeServer(tools);
  const first=await fetchChannelPage('c1',30,undefined,server.fetchJson);
  expect(first.cursors.tools).toBe(150);
  expect(first.events.map(event=>event.id).sort()).toEqual(tools.slice(0,33).map(event=>event.id).sort());
  const second=await fetchChannelPage('c1',30,first.cursors,server.fetchJson);
  expect([...first.events,...second.events].map(event=>event.id).sort()).toEqual(tools.map(event=>event.id).sort());
  expect(second.cursors.tools).toBeNull();
 });

 it('pages past a full page that shares one millisecond',async()=>{
  const tools=[...Array.from({length:3},(_,index)=>ev(`s${index}`,'tool.started',90)),ev('o1','tool.started',80)];
  const server=fakeServer(tools);
  const first=await fetchChannelPage('c1',2,undefined,server.fetchJson);
  expect(first.cursors.tools).toBe(90);
  const second=await fetchChannelPage('c1',2,first.cursors,server.fetchJson);
  expect(first.events.map(event=>event.id)).toEqual(['s0','s1','s2']);
  expect(second.events.map(event=>event.id)).toEqual(['o1']);
  expect(second.cursors.tools).toBeNull();
 });
});

describe('adaptiveMessageBatchSize',()=>{
 it('adaptive batch size',()=>{
  expect([{saveData:true},{effectiveType:'2g'},{effectiveType:'3g'},{downlink:10},{downlink:5},{}].map(adaptiveMessageBatchSize))
   .toEqual([12,10,20,50,40,30]);
  expect(adaptiveMessageBatchSize()).toBe(30);
 });
});
