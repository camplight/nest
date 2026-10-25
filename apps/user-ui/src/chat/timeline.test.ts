import {describe,expect,it} from 'vitest';
import {buildTimeline,dayKey,isContinuation,isTraceEvent,toThreadMessage,upsertEvents} from './timeline';
import type {EventRow} from '../types';
const opts={currentUsername:'alek'};
const msg=(id:string,source:string,payload:Record<string,unknown>={text:'Hi'},createdAt=1000,extra:Partial<EventRow>={}):EventRow=>({id,type:'message.created',source,payload,createdAt,...extra});
const tr=(id:string,type:string,createdAt:number):EventRow=>({id,type,source:'agent:Pip',payload:{},createdAt});
const at=(d:number,h:number,min:number)=>new Date(2026,0,d,h,min).getTime();
const e1=msg('e1','human:alek',{text:'Hi'},1000);
const t1=tr('t1','agent.turn.started',1100);
const t2=tr('t2','tool.started',1200);
const e2=msg('e2','agent:Pip',{text:'Done'},1300);

describe('buildTimeline',()=>{
 it('human message becomes user role',()=>{
  const items=buildTimeline([e1],opts);
  expect(items).toMatchObject([{kind:'message',id:'e1',meta:{eventId:'e1',authorKind:'human',authorName:'alek',isMine:true,displayAt:1000,targetAgents:[]}}]);
  expect(items[0]!.meta).toEqual({eventId:'e1',authorKind:'human',authorName:'alek',isMine:true,displayAt:1000,targetAgents:[]});
  expect(items[0]).toMatchObject({text:'Hi',markdown:false,attachments:[]});
  expect(items[0]!.kind==='message'&&items[0]!.event).toBe(e1);
  expect(toThreadMessage(items[0]!).role).toBe('user');
  expect(buildTimeline([msg('e9','human:bob')],opts)).toMatchObject([{meta:{authorKind:'human',authorName:'bob',isMine:false}}]);
 });
 it('agent, system and runner messages become assistant role',()=>{
  const items=buildTimeline([msg('a1','agent:Pip',{text:'a'},1000),msg('s1','system',{text:'b'},1001),msg('r1','system:runner:wrapper',{text:'c'},1002)],opts);
  expect(items).toMatchObject([
   {id:'a1',meta:{authorKind:'agent',authorName:'Pip',isMine:false}},
   {id:'s1',meta:{authorKind:'system',authorName:'system',isMine:false}},
   {id:'r1',meta:{authorKind:'system',authorName:'system:runner:wrapper',isMine:false}},
  ]);
  expect(items.map(item=>toThreadMessage(item).role)).toEqual(['assistant','assistant','assistant']);
  expect(buildTimeline([msg('a2','agent:alek')],opts)).toMatchObject([{meta:{authorKind:'agent',isMine:false}}]);
 });
 it('trace events form one activity item',()=>{
  const items=buildTimeline([e1,t1,t2,e2],opts);
  expect(items.map(item=>item.id)).toEqual(['e1','t1','e2']);
  expect(items[1]).toMatchObject({kind:'activity',id:'t1',tone:'agent',meta:{eventId:'t1',authorKind:'activity',isMine:false,displayAt:1100,targetAgents:[]}});
  expect(items[1]!.kind==='activity'&&items[1]!.events).toEqual([t1,t2]);
  expect(items[1]!.kind==='activity'&&items[1]!.events[0]).toBe(t1);
  expect(buildTimeline([e1,t1,t2,tr('t3','tool.failed',1250),e2],opts)).toMatchObject([{id:'e1'},{id:'t1',kind:'activity',tone:'system'},{id:'e2'}]);
  expect(buildTimeline([t1,msg('e3','agent:Pip'),t2],opts).map(item=>item.id)).toEqual(['t1','e3','t2']);
  expect(buildTimeline([e1,{id:'x1',type:'channel.updated',source:'system',payload:{},createdAt:1050},t1,t2],opts).map(item=>item.id)).toEqual(['e1','t1']);
  expect(buildTimeline([tr('t0','telemetry.context.window.updated',1),tr('t9','process.output',2)],opts)).toMatchObject([{id:'t0',kind:'activity',tone:'agent'}]);
 });
 it('activity id stays when the group grows',()=>{
  const previous=buildTimeline([e1,t1,t2,e2],opts);
  const t3=tr('t3','tool.executed',1250);
  expect(buildTimeline([e1,t1,t2,t3,e2],opts,previous).map(item=>item.id)).toEqual(['e1','t1','e2']);
  const t0=tr('t0','agent.turn.phase',1050);
  expect(buildTimeline([e1,t0,t1,t2,e2],opts).map(item=>item.id)).toEqual(['e1','t0','e2']);
  const grown=buildTimeline([e1,t0,t1,t2,e2],opts,previous);
  expect(grown.map(item=>item.id)).toEqual(['e1','t1','e2']);
  expect(grown[1]!.kind==='activity'&&grown[1]!.events).toEqual([t0,t1,t2]);
  expect(grown[1]!.meta).toMatchObject({displayAt:1050});
  const split=buildTimeline([t1,e2,tr('t5','tool.started',1400)],opts);
  expect(buildTimeline([t1,tr('t5','tool.started',1400)],opts,split).map(item=>item.id)).toEqual(['t1']);
 });
 it('unchanged items keep object identity',()=>{
  const events=[e1,t1,t2,e2];
  const previous=buildTimeline(events,opts);
  const same=buildTimeline(events,opts,previous);
  expect(same).toHaveLength(3);
  same.forEach((item,index)=>expect(item).toBe(previous[index]));
  const e3=msg('e3','human:alek',{text:'More'},1400);
  const appended=buildTimeline([...events,e3],opts,previous);
  expect(appended).toHaveLength(4);
  expect(appended[0]).toBe(previous[0]);
  expect(appended[1]).toBe(previous[1]);
  expect(appended[2]).toBe(previous[2]);
  const delivered={...e1,status:'DELIVERED'};
  const republished=buildTimeline([delivered,t1,t2,e2],opts,previous);
  expect(republished[0]).not.toBe(previous[0]);
  expect(republished[0]!.kind==='message'&&republished[0]!.event).toBe(delivered);
  expect(republished[2]).toBe(previous[2]);
  const grown=buildTimeline([e1,t1,t2,tr('t3','tool.failed',1250),e2],opts,previous);
  expect(grown[1]).not.toBe(previous[1]);
  expect(grown[1]).toMatchObject({id:'t1',tone:'system'});
  const detached=buildTimeline(events,{currentUsername:'alek',detachedIds:new Set(['e1'])},previous);
  expect(detached[0]).not.toBe(previous[0]);
  expect(detached[0]!.meta.detached).toBe(true);
 });
 it('agent.turn.failed is only an activity chip',()=>{
  const failed:EventRow={id:'f1',type:'agent.turn.failed',source:'agent:Pip',payload:{error:'boom'},createdAt:1100};
  const items=buildTimeline([e1,failed],opts);
  expect(items).toMatchObject([{kind:'message',id:'e1'},{kind:'activity',id:'f1',tone:'system'}]);
  expect(items).toHaveLength(2);
  expect(items.filter(item=>item.kind==='message').map(item=>item.id)).toEqual(['e1']);
 });
 it('deliverAt wins for display time',()=>{
  expect(buildTimeline([msg('e1','human:alek',{text:'Hi'},1000,{deliverAt:5000})],opts)).toMatchObject([{meta:{displayAt:5000}}]);
  expect(buildTimeline([{...t1,deliverAt:7000}],opts)).toMatchObject([{meta:{displayAt:7000}}]);
 });
 it('targets',()=>{
  expect(buildTimeline([msg('e1','human:alek',{text:'Hi',targetAgentName:'Pip'})],opts)).toMatchObject([{meta:{targetAgents:['Pip']}}]);
  expect(buildTimeline([msg('e1','human:alek',{text:'Hi',targetAgentNames:['A','B']})],opts)).toMatchObject([{meta:{targetAgents:['A','B']}}]);
 });
 it('inReplyTo copied',()=>{
  expect(buildTimeline([msg('e2','agent:Pip',{text:'Yes',inReplyTo:'e1'})],opts)).toMatchObject([{meta:{inReplyTo:'e1'}}]);
 });
 it('detachedIds sets meta.detached',()=>{
  const items=buildTimeline([e1,e2],{currentUsername:'alek',detachedIds:new Set(['e1'])});
  expect(items).toMatchObject([{id:'e1',meta:{detached:true}},{id:'e2'}]);
  expect(items[1]!.meta.detached).toBeFalsy();
 });
 it('markdown flag',()=>{
  const flag=(text:string)=>buildTimeline([msg('m','agent:Pip',{text})],opts).map(item=>item.kind==='message'&&item.markdown);
  expect(flag('plain words')).toEqual([false]);
  expect(flag('see https://x.test')).toEqual([true]);
  expect(flag('**bold**')).toEqual([true]);
 });
 it('attachments keep only entries with a non-empty fileId',()=>{
  const items=buildTimeline([msg('e1','agent:Pip',{text:'x',attachments:[{fileId:'f1',name:'a.txt',mime:'text/plain',size:3},{fileId:'',name:'b'},{name:'c'},{fileId:'f2'}]})],opts);
  expect(items.map(item=>item.kind==='message'&&item.attachments)).toEqual([[{fileId:'f1',name:'a.txt',mime:'text/plain',size:3},{fileId:'f2',name:'f2'}]]);
 });
});

describe('upsertEvents',()=>{
 it('upsertEvents replaces by id',()=>{
  const delivered={...e1,status:'DELIVERED'};
  const merged=upsertEvents([{...e1,status:'PENDING'}],[delivered]);
  expect(merged).toEqual([delivered]);
  expect(merged[0]).toBe(delivered);
 });
 it('keeps chronological order by deliverAt, createdAt, id',()=>{
  const a=msg('a','agent:Pip',{text:'a'},3000);
  const b=msg('b','agent:Pip',{text:'b'},1000,{deliverAt:4000});
  const c=msg('c','agent:Pip',{text:'c'},2000);
  const d=msg('d','agent:Pip',{text:'d'},2000);
  expect(upsertEvents([b,d],[a,c]).map(event=>event.id)).toEqual(['c','d','a','b']);
 });
 it('isTraceEvent knows the trace types',()=>{
  expect(['agent.turn.started','tool.failed','wrapper.turn.completed','process.exited','telemetry.context.window.updated'].map(type=>isTraceEvent(tr('x',type,1)))).toEqual([true,true,true,true,true]);
  expect(isTraceEvent(e1)).toBe(false);
 });
});

describe('toThreadMessage',()=>{
 it('toThreadMessage parts',()=>{
  const att={fileId:'f1',name:'a.txt'};
  const [item]=buildTimeline([msg('e2','agent:Pip',{text:'Done',attachments:[att]},1300)],opts);
  expect(item).toBeDefined();
  const message=toThreadMessage(item!);
  expect(message).toMatchObject({role:'assistant',id:'e2'});
  expect(message.content).toEqual([{type:'text',text:'Done'},{type:'data-nest-attachments',data:[{fileId:'f1',name:'a.txt'}]}]);
  expect('attachments' in message).toBe(false);
  expect('status' in message).toBe(false);
  expect(message.metadata?.custom).toEqual(item!.meta);
  const [plain]=buildTimeline([e1],opts);
  const plainMessage=toThreadMessage(plain!);
  expect(plainMessage).toMatchObject({role:'user',id:'e1'});
  expect(plainMessage.content).toEqual([{type:'text',text:'Hi'}]);
  expect('attachments' in plainMessage).toBe(false);
  expect('status' in plainMessage).toBe(false);
  const activity=buildTimeline([t1,tr('t3','tool.failed',1250)],opts)[0];
  expect(activity).toMatchObject({kind:'activity'});
  const activityMessage=toThreadMessage(activity!);
  expect(activityMessage).toMatchObject({role:'assistant',id:'t1'});
  expect(activityMessage.content).toEqual([{type:'data-nest-activity',data:{events:[t1,tr('t3','tool.failed',1250)],tone:'system'}}]);
  expect(activityMessage.metadata?.custom).toEqual(activity!.meta);
  expect('status' in activityMessage).toBe(false);
 });
});

describe('isContinuation',()=>{
 it('isContinuation',()=>{
  const [a,b4,b6,bob,late,early]=buildTimeline([
   msg('a','human:alek',{text:'1'},at(5,10,0)),
   msg('b4','human:alek',{text:'2'},at(5,10,4)),
   msg('b6','human:alek',{text:'3'},at(5,10,10)),
   msg('bob','human:bob',{text:'4'},at(5,10,11)),
   msg('late','human:alek',{text:'5'},at(5,23,58)),
   msg('early','human:alek',{text:'6'},at(6,0,1)),
  ],opts);
  expect([a,b4,b6,bob,late,early].every(Boolean)).toBe(true);
  expect(isContinuation(a,b4!)).toBe(true);
  expect(isContinuation(b4,b6!)).toBe(false);
  expect(isContinuation(b6,bob!)).toBe(false);
  expect(isContinuation(late,early!)).toBe(false);
  expect(isContinuation(undefined,a!)).toBe(false);
  const [m1,activity,m2]=buildTimeline([msg('m1','human:alek',{text:'1'},at(5,10,0)),tr('t1','tool.started',at(5,10,1)),msg('m2','human:alek',{text:'2'},at(5,10,2))],opts);
  expect(activity).toMatchObject({kind:'activity'});
  expect(isContinuation(activity,m2!)).toBe(false);
  expect(isContinuation(m1,activity!)).toBe(false);
  const [p1,p2]=buildTimeline([msg('p1','agent:Pip',{text:'1'},at(5,10,0)),msg('p2','system',{text:'2'},at(5,10,1))],opts);
  expect(isContinuation(p1,p2!)).toBe(false);
  expect(dayKey(at(5,23,59))).toBe('2026-01-05');
  expect(dayKey(at(6,0,0))).toBe('2026-01-06');
 });
});

describe('additions',()=>{
 it('a republished copy with the same id and status is a new item',()=>{
  const previous=buildTimeline([e1,t1,t2,e2],opts);
  const copy={...e1,payload:{text:'Edited'}};
  const next=buildTimeline([copy,{...t1},t2,e2],opts,previous);
  expect(next).toHaveLength(3);
  expect(next[0]).not.toBe(previous[0]);
  expect(next[0]).toMatchObject({text:'Edited'});
  expect(next[1]).not.toBe(previous[1]);
  expect(next[2]).toBe(previous[2]);
 });
 it('a group split by a new message keeps unique ids',()=>{
  const previous=buildTimeline([e1,t1,t2],opts);
  expect(buildTimeline([e1,t1,msg('m','agent:Pip',{text:'x'},1150),t2],opts,previous).map(item=>item.id)).toEqual(['e1','t1','m','t2']);
 });
 it('thread message carries the item id, the exact meta and the raw text',()=>{
  const previous=buildTimeline([e1,t1,t2,e2],opts);
  const grown=buildTimeline([e1,tr('t0','agent.turn.phase',1050),t1,t2,e2],opts,previous);
  expect(grown.map(item=>toThreadMessage(item).id)).toEqual(['e1','t1','e2']);
  expect(grown.map(item=>toThreadMessage(item).metadata?.custom)).toEqual(grown.map(item=>item.meta));
  expect(toThreadMessage(grown[0]!).metadata?.custom).toMatchObject({isMine:true,authorKind:'human'});
  const [spaced]=buildTimeline([msg('s','agent:Pip',{text:'  spaced  '})],opts);
  expect(spaced).toBeDefined();
  expect(toThreadMessage(spaced!).content).toEqual([{type:'text',text:'  spaced  '}]);
 });
 it('a grown group split by a message keeps unique ids',()=>{
  const t0=tr('t0','agent.turn.phase',1050);
  const first=buildTimeline([e1,t1,t2],opts);
  const grown=buildTimeline([e1,t0,t1,t2],opts,first);
  expect(grown.map(item=>item.id)).toEqual(['e1','t1']);
  const split=buildTimeline([e1,t0,msg('m','agent:Pip',{text:'x'},1075),t1,t2],opts,grown);
  expect(split.map(item=>item.id)).toEqual(['e1','t1','m','t2']);
  const single=buildTimeline([e1,t0,t1],opts,buildTimeline([e1,t1],opts));
  expect(buildTimeline([e1,t0,msg('m','agent:Pip',{text:'x'},1075),t1],opts,single).map(item=>item.id)).toEqual(['e1','t1','m','t1~1']);
 });
 it('a group needing a second suffix skips the taken one',()=>{
  const x=tr('x','tool.started',300),p=tr('p','tool.started',100),r=tr('r','tool.started',250);
  const m1=msg('m1','agent:Pip',{text:'x'},200),m2=msg('m2','agent:Pip',{text:'x'},260);
  const b1=buildTimeline([x],opts);
  const b2=buildTimeline([p,x],opts,b1);
  const b3=buildTimeline([p,m1,x],opts,b2);
  const b4=buildTimeline([p,m1,r,x],opts,b3);
  const b5=buildTimeline([p,m1,r,m2,x],opts,b4);
  expect(b5.map(item=>item.id)).toEqual(['x','m1','x~1','m2','x~2']);
  const q=tr('q','tool.started',270),m3=msg('m3','agent:Pip',{text:'x'},280);
  const b6=buildTimeline([p,m1,r,m2,q,x],opts,b5);
  expect(buildTimeline([p,m1,r,m2,q,m3,x],opts,b6).map(item=>item.id)).toEqual(['x','m1','x~1','m2','x~2','m3','x~3']);
 });
 it('the suffix counts from the first event of the group',()=>{
  const x=tr('x','tool.started',300),p=tr('p','tool.started',100),r=tr('r','tool.started',250),q=tr('q','tool.started',270),z=tr('z','tool.started',310);
  const m1=msg('m1','agent:Pip',{text:'x'},200),m2=msg('m2','agent:Pip',{text:'x'},260),m3=msg('m3','agent:Pip',{text:'x'},280);
  const chain=buildTimeline([p,m1,r,x],opts,buildTimeline([p,m1,x],opts,buildTimeline([p,x],opts,buildTimeline([x],opts))));
  expect(chain.map(item=>item.id)).toEqual(['x','m1','x~1']);
  const named=buildTimeline([q,z],opts,buildTimeline([z],opts));
  expect(named.map(item=>item.id)).toEqual(['z']);
  expect(buildTimeline([p,m1,r,m2,q,m3,x,z],opts,[...chain,...named]).map(item=>item.id)).toEqual(['x','m1','x~1','m2','z','m3','x~2']);
 });
});
