import {describe,expect,it} from 'vitest';
import {createChannelEventsCore} from './channel-events';
import {chatQueryUrls} from './history';
import type {EventRow} from '../types';

const ev=(id:string,type:string,createdAt:number,extra:Partial<EventRow>={}):EventRow=>
 ({id,type,source:'agent:Pip',payload:{},createdAt,channelId:'c1',...extra});

function deferred(){
 let resolve!:()=>void;
 const promise=new Promise<void>(done=>{resolve=done;});
 return {promise,resolve};
}

// Fake engine (vendor events route): listing by channelId, type or typePrefix, strict before/after on createdAt,
// desc, limit; GET /api/events/<id> rejects like apiJson on a 404. URLs matching a hold wait for its release.
function fakeApi(initial:EventRow[]){
 const rows=[...initial];
 const requests:string[]=[];
 const holds:Array<{match:(url:string)=>boolean;gate:Promise<void>}>=[];
 let fail:((url:string)=>boolean)|null=null;
 const fetchJson=async <T,>(url:string):Promise<T>=>{
  requests.push(url);
  for(const hold of holds)if(hold.match(url))await hold.gate;
  if(fail?.(url))throw new Error('Request failed: 500');
  const parsed=new URL(url,'http://nest.test');
  if(parsed.pathname.startsWith('/api/events/')){
   const row=rows.find(entry=>entry.id===decodeURIComponent(parsed.pathname.slice('/api/events/'.length)));
   if(!row)throw new Error('Not found');
   return {...row} as T;
  }
  const params=parsed.searchParams;
  const type=params.get('type'),prefix=params.get('typePrefix'),channel=params.get('channelId');
  const before=params.get('before'),after=params.get('after');
  const limit=Number(params.get('limit')??100);
  const matched=rows.filter(row=>(!channel||row.channelId===channel)&&(!type||row.type===type)&&
   (!prefix||row.type.startsWith(prefix))&&(before===null||(row.createdAt??0)<Number(before))&&
   (after===null||(row.createdAt??0)>Number(after)));
  const sorted=[...matched].sort((left,right)=>(left.createdAt??0)-(right.createdAt??0)||left.id.localeCompare(right.id));
  if(params.get('order')==='desc')sorted.reverse();
  return sorted.slice(0,limit).map(row=>({...row})) as T;
 };
 return {
  fetchJson,requests,rows,
  hold(match:(url:string)=>boolean){const gate=deferred();holds.push({match,gate:gate.promise});return gate.resolve;},
  failWhen(match:((url:string)=>boolean)|null){fail=match;},
 };
}
const setup=(rows:EventRow[])=>{
 const api=fakeApi(rows);
 return {api,core:createChannelEventsCore({fetchJson:api.fetchJson,limit:()=>30})};
};
const ids=(events:EventRow[])=>events.map(event=>event.id);
const messages=(count:number,start:number)=>Array.from({length:count},(_,index)=>ev(`m${start+index}`,'message.created',start+index));

describe('createChannelEventsCore',()=>{
 it('switch loads first page',async()=>{
  const {api,core}=setup([
   ev('m2','message.created',300),
   ev('t1','tool.started',200),
   ev('m1','message.created',100),
   ev('d1','message.created',150,{deliverAt:400}),
   ev('a1','agent.turn.started',200),
   ev('x1','message.created',250,{channelId:'c2'}),
  ]);
  await core.switchTo('c1');
  expect([...api.requests].sort()).toEqual(chatQueryUrls('c1',30).map(entry=>entry.url).sort());
  const snapshot=core.snapshot();
  expect(snapshot.channelId).toBe('c1');
  expect(ids(snapshot.events)).toEqual(['m1','a1','t1','m2','d1']);
  expect(snapshot.loading).toBe(false);
  expect(snapshot.hasOlder).toBe(false);
  expect(snapshot.error).toBeNull();
 });

 it('late response from the previous channel is dropped',async()=>{
  const {api,core}=setup([ev('m1','message.created',100),ev('m2','message.created',200,{channelId:'c2'})]);
  const release=api.hold(url=>url.includes('channelId=c1&'));
  const first=core.switchTo('c1');
  await core.switchTo('c2');
  expect(ids(core.snapshot().events)).toEqual(['m2']);
  release();
  await first;
  const snapshot=core.snapshot();
  expect(snapshot.channelId).toBe('c2');
  expect(snapshot.events.some(event=>event.channelId==='c1')).toBe(false);
  expect(ids(snapshot.events)).toEqual(['m2']);
  expect(snapshot.loading).toBe(false);
 });

 it('seen classifies',()=>{
  const {core}=setup([]);
  expect(core.seen('e1','PENDING')).toBe('new');
  expect(core.seen('e1','PENDING')).toBe('duplicate');
  expect(core.seen('e1','DELIVERED')).toBe('update');
  expect(core.seen('e1','DELIVERED')).toBe('duplicate');
  expect(core.seen('e2')).toBe('new');
  expect(core.seen('e2')).toBe('duplicate');
 });

 it('lookup does not mutate',async()=>{
  const {core}=setup([...messages(35,1000),ev('far','message.created',10)]);
  await core.switchTo('c1');
  const before=core.snapshot();
  expect(before.events.some(event=>event.id==='far')).toBe(false);
  const found=await core.lookup('far');
  expect(found).toMatchObject({id:'far',type:'message.created',createdAt:10});
  expect(core.snapshot()).toBe(before);
  expect(await core.lookup('m1030')).toMatchObject({id:'m1030'});
  expect(await core.lookup('nope')).toBeNull();
  expect(core.snapshot()).toBe(before);
 });

 it('ingest upserts',async()=>{
  const {core}=setup([ev('m1','message.created',100)]);
  await core.switchTo('c1');
  let notified=0;
  core.subscribe(()=>{notified++;});
  expect(core.ingest(ev('e1','message.created',200,{status:'PENDING'}))).toEqual({accepted:true});
  expect(core.ingest(ev('e1','message.created',200,{status:'DELIVERED'}))).toEqual({accepted:true});
  const copies=core.snapshot().events.filter(event=>event.id==='e1');
  expect(copies).toHaveLength(1);
  expect(copies[0]!.status).toBe('DELIVERED');
  expect(ids(core.snapshot().events)).toEqual(['m1','e1']);
  expect(notified).toBe(2);
 });

 it('ingest rejects other channels and non-timeline types',async()=>{
  const {core}=setup([ev('m1','message.created',100)]);
  await core.switchTo('c1');
  const before=core.snapshot();
  expect(ids(before.events)).toEqual(['m1']);
  expect(core.ingest(ev('o1','message.created',200,{channelId:'c2'}))).toEqual({accepted:false});
  expect(core.ingest(ev('o2','channel.updated',200))).toEqual({accepted:false});
  expect(core.ingest(ev('o3','message.created',200,{channelId:undefined}))).toEqual({accepted:false});
  expect(core.snapshot()).toBe(before);
 });

 it('refresh reports new timeline events',async()=>{
  const {api,core}=setup([ev('m1','message.created',100),ev('t1','tool.started',110)]);
  await core.switchTo('c1');
  api.rows.push(ev('t2','tool.started',200));
  expect(await core.refresh()).toEqual({newTimeline:true,newestMessageAt:100});
  expect(ids(core.snapshot().events)).toEqual(['m1','t1','t2']);
  expect(await core.refresh()).toEqual({newTimeline:false,newestMessageAt:100});
 });

 it('focus outside the window adds a detached event',async()=>{
  const {api,core}=setup(messages(40,1000));
  await core.switchTo('c1');
  expect(core.snapshot().hasOlder).toBe(true);
  expect(core.snapshot().events.some(event=>event.id==='m1005')).toBe(false);
  expect(await core.focus('m1005')).toBe('loaded');
  let snapshot=core.snapshot();
  expect(snapshot.detachedIds.has('m1005')).toBe(true);
  expect(snapshot.events.filter(event=>event.id==='m1005')).toHaveLength(1);
  api.requests.length=0;
  await core.loadOlder();
  const olderMessages=api.requests.filter(url=>url.includes('type=message.created')&&!url.includes('after='));
  expect(olderMessages).toEqual(['/api/events?channelId=c1&limit=30&order=desc&type=message.created&before=1010']);
  expect(api.requests.some(url=>url.includes('before=1005')||url.includes('before=1006'))).toBe(false);
  snapshot=core.snapshot();
  expect(snapshot.detachedIds.has('m1005')).toBe(false);
  expect(snapshot.events.filter(event=>event.id==='m1005')).toHaveLength(1);
  expect(ids(snapshot.events)).toEqual(ids(messages(40,1000)));
  expect(snapshot.hasOlder).toBe(false);
 });

 it("focus in another channel returns 'other-channel'",async()=>{
  const {core}=setup([ev('m1','message.created',100),ev('o1','message.created',100,{channelId:'c2'})]);
  await core.switchTo('c1');
  const before=core.snapshot();
  expect(await core.focus('o1')).toBe('other-channel');
  expect(await core.focus('gone')).toBe('missing');
  expect(core.snapshot()).toBe(before);
  expect(await core.focus('m1')).toBe('loaded');
  expect(core.snapshot().detachedIds.size).toBe(0);
 });

 it('loadOlder failure sets the error text',async()=>{
  const {api,core}=setup(messages(40,1000));
  await core.switchTo('c1');
  api.failWhen(url=>url.includes('before=1010'));
  await core.loadOlder();
  const snapshot=core.snapshot();
  expect(snapshot.error).toBe('Unable to load previous messages');
  expect(snapshot.loadingOlder).toBe(false);
  expect(snapshot.events).toHaveLength(30);
 });

 // Frozen additions from T5-V1 (R1 to R3): every request that started before a switch is dropped, not only switchTo's.
 it('a held refresh of the previous channel is dropped',async()=>{
  const {api,core}=setup([ev('m1','message.created',100),ev('m2','message.created',300,{channelId:'c2'})]);
  await core.switchTo('c1');
  api.rows.push(ev('m3','message.created',200));
  const release=api.hold(url=>url.includes('channelId=c1&'));
  const pending=core.refresh();
  await core.switchTo('c2');
  release();
  expect(await pending).toEqual({newTimeline:false,newestMessageAt:0});
  const snapshot=core.snapshot();
  expect(snapshot.channelId).toBe('c2');
  expect(ids(snapshot.events)).toEqual(['m2']);
 });

 it('a held loadOlder of the previous channel is dropped',async()=>{
  const {api,core}=setup([...messages(40,1000),ev('o1','message.created',300,{channelId:'c2'})]);
  await core.switchTo('c1');
  const release=api.hold(url=>url.includes('channelId=c1&')&&url.includes('before='));
  const pending=core.loadOlder();
  await core.switchTo('c2');
  release();
  await pending;
  const snapshot=core.snapshot();
  expect(snapshot.channelId).toBe('c2');
  expect(ids(snapshot.events)).toEqual(['o1']);
  expect(snapshot.loadingOlder).toBe(false);
 });

 it('a held focus in the previous channel is dropped',async()=>{
  const {api,core}=setup([...messages(40,1000),ev('o1','message.created',300,{channelId:'c2'})]);
  await core.switchTo('c1');
  const release=api.hold(url=>url==='/api/events/m1001');
  const pending=core.focus('m1001');
  await core.switchTo('c2');
  release();
  await pending;
  const snapshot=core.snapshot();
  expect(snapshot.channelId).toBe('c2');
  expect(ids(snapshot.events)).toEqual(['o1']);
  expect(snapshot.detachedIds.size).toBe(0);
 });
});

// Frozen additions from T5-V2 (P1 to P3): a held c1 failure released after switchTo('c2') must not touch the c2 snapshot.
describe('createChannelEventsCore stale error paths',()=>{
 it('a held failing switchTo of the previous channel leaves the next clean',async()=>{
  const {api,core}=setup([ev('m1','message.created',100),ev('o1','message.created',300,{channelId:'c2'})]);
  api.failWhen(url=>url.includes('channelId=c1&'));
  const release=api.hold(url=>url.includes('channelId=c1&'));
  const pending=core.switchTo('c1');
  await core.switchTo('c2');
  release();
  await pending;
  const snapshot=core.snapshot();
  expect(snapshot.channelId).toBe('c2');
  expect(ids(snapshot.events)).toEqual(['o1']);
  expect(snapshot.error).toBeNull();
 });

 it('a held failing refresh of the previous channel leaves the next clean',async()=>{
  const {api,core}=setup([ev('m1','message.created',100),ev('o1','message.created',300,{channelId:'c2'})]);
  await core.switchTo('c1');
  api.failWhen(url=>url.includes('channelId=c1&'));
  const release=api.hold(url=>url.includes('channelId=c1&'));
  const pending=core.refresh();
  await core.switchTo('c2');
  release();
  await pending;
  const snapshot=core.snapshot();
  expect(snapshot.channelId).toBe('c2');
  expect(snapshot.error).toBeNull();
 });

 it('a held failing loadOlder of the previous channel leaves the next clean',async()=>{
  const {api,core}=setup([...messages(40,1000),ev('o1','message.created',300,{channelId:'c2'})]);
  await core.switchTo('c1');
  api.failWhen(url=>url.includes('channelId=c1&')&&url.includes('before='));
  const release=api.hold(url=>url.includes('channelId=c1&')&&url.includes('before='));
  const pending=core.loadOlder();
  await core.switchTo('c2');
  const loadingOlder=core.snapshot().loadingOlder;
  release();
  await pending;
  const snapshot=core.snapshot();
  expect(snapshot.channelId).toBe('c2');
  expect(snapshot.error).toBeNull();
  expect(snapshot.loadingOlder).toBe(loadingOlder);
 });
});

// Frozen additions from T5-V2 (T5 brief section 4): the snapshot stays the same object when nothing changed.
describe('createChannelEventsCore snapshot identity',()=>{
 it('a no-change refresh keeps the snapshot object',async()=>{
  const {core}=setup([ev('m1','message.created',100),ev('m2','message.created',200)]);
  await core.switchTo('c1');
  const before=core.snapshot();
  await core.refresh();
  expect(core.snapshot()).toBe(before);
 });

 it('an ingest of an identical event keeps the snapshot object',async()=>{
  const {core}=setup([ev('m1','message.created',100),ev('m2','message.created',200)]);
  await core.switchTo('c1');
  const before=core.snapshot();
  expect(core.ingest(ev('m2','message.created',200))).toEqual({accepted:true});
  expect(core.snapshot()).toBe(before);
 });
});

describe('history recovery',()=>{
 it('initializes pagination when refresh recovers a failed first load',async()=>{
  const {api,core}=setup(messages(60,1));
  api.failWhen(()=>true);await core.switchTo('c1');
  api.failWhen(null);await core.refresh();
  expect(core.snapshot().error).toBeNull();expect(core.snapshot().hasOlder).toBe(true);
  await core.loadOlder();
  expect(core.snapshot().events).toHaveLength(60);
 });

 it('bridges multiple missed pages independently for messages and activity',async()=>{
  const initial=[...messages(30,1),ev('old-tool','tool.started',1)];
  const {api,core}=setup(initial);await core.switchTo('c1');
  api.rows.push(...messages(65,31),...Array.from({length:71},(_,i)=>ev(`tool${i}`,'tool.started',i+2)));
  await core.refresh();
  expect(new Set(ids(core.snapshot().events))).toEqual(new Set(ids(api.rows)));
  await core.loadOlder();expect(core.snapshot().hasOlder).toBe(false);
  const count=api.requests.length;
  await core.refresh();
  // An idle refresh fetches the usual head + its timestamp boundaries, not all history.
  expect(api.requests.length-count).toBeLessThanOrEqual(14);
 });

 it('recovers all new history when the previously loaded channel was empty',async()=>{
  const {api,core}=setup([]);await core.switchTo('c1');
  api.rows.push(...messages(80,1));await core.refresh();
  expect(core.snapshot().events).toHaveLength(80);expect(core.snapshot().hasOlder).toBe(false);
 });

 it('retries a failed gap fetch without claiming the partial head is complete',async()=>{
  const {api,core}=setup(messages(30,1));await core.switchTo('c1');
  api.rows.push(...messages(70,31));
  api.failWhen(url=>new URL(url,'http://fixture').searchParams.get('before')==='71');
  await core.refresh();
  expect(core.snapshot().error).not.toBeNull();expect(core.snapshot().events).toHaveLength(30);
  api.failWhen(null);await core.refresh();
  expect(core.snapshot().events).toHaveLength(100);expect(core.snapshot().error).toBeNull();
 });

 it('deduplicates overlapping refreshes and discards a gap response after a channel switch',async()=>{
  const {api,core}=setup(messages(30,1));await core.switchTo('c1');
  api.rows.push(...messages(70,31));
  const release=api.hold(url=>new URL(url,'http://fixture').searchParams.get('before')==='71');
  const first=core.refresh(),second=core.refresh();
  await new Promise(resolve=>setTimeout(resolve,0));
  await core.switchTo('c2');release();await Promise.all([first,second]);
  expect(core.snapshot().channelId).toBe('c2');expect(core.snapshot().events).toEqual([]);
  expect(api.requests.filter(url=>new URL(url,'http://fixture').searchParams.get('before')==='71')).toHaveLength(1);
 });
});
