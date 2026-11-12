import {describe,expect,it} from 'vitest';
import type {DashboardTask,FlowNeed,Project} from '@nest/schemas';
import type {CardPulse} from './pulse';
import {needsByChannel,needsYouItems} from './needs';

const pulse=(...ids:string[]):CardPulse=>({agents:[],people:[],lastActivityAt:null,artifacts:[],fileCount:0,needsYou:ids.map((id,i)=>({kind:'mention' as const,id,at:100+i,sender:'demo-bob',text:`ping ${id}`})),apps:{apps:[],reads:0,changes:0}});
const project=(id:string,channelId:string):Project=>({id,ownerId:'h1',channelId,name:id,description:'',createdAt:1});
const review=(id:string,projectId:string,updatedAt:number):DashboardTask=>({id,projectId,title:`Task ${id}`,agentName:'Pip',updatedAt,status:'needs_review'} as DashboardTask);

const approval=(id:string,channelId:string,at:number):FlowNeed=>({key:`approval:${id}`,kind:'approval',channelId,at,from:'Pip',short:'Approve hand-off to Launch',reason:'Approve hand-off to Launch',
  detail:'Pip finished something in Invoices. It goes to Launch after your OK.',gate:{kind:'approval',deliveryId:id,linkId:'l1'}});
const missed=(id:string,channelId:string,at:number):FlowNeed=>({key:`missed:${id}`,kind:'missed',channelId,at,from:'Pip',short:'Missed run · runner offline',reason:'runner offline',
  detail:'The 08:00 run did not start.',gate:{kind:'missed',scheduleId:'s1',runId:id}});

describe('needsYouItems',()=>{
  const titles=new Map([['c1','Invoices'],['c2','Launch']]);
  it('counts every unread mention and review as its own item, newest first',()=>{
    const items=needsYouItems({pulses:new Map([['c1',pulse('m1','m2')],['c2',pulse()]]),titles,reviews:[review('t1','p2',500)],projects:[project('p2','c2')],flows:[]});
    expect(items.map(i=>[i.kind,i.channelId,i.chatTitle])).toEqual([['review','c2','Launch'],['mention','c1','Invoices'],['mention','c1','Invoices']]);
    expect(items[1].detail).toContain('demo-bob');
    expect(items[0].detail).toContain('Task t1');
  });
  it('leaves out chats the person cannot see: locked, unavailable and unknown',()=>{
    const items=needsYouItems({pulses:new Map([['locked',pulse('m1')],['c1',pulse('m2')]]),titles,reviews:[review('t1','p9',9),review('t2','p3',8)],projects:[project('p9','locked'),project('p3','gone')],flows:[]});
    expect(items.map(i=>i.channelId)).toEqual(['c1']);
  });
  it('skips reviews of projects that are not in the projects list',()=>{
    expect(needsYouItems({pulses:new Map(),titles,reviews:[review('t1','nope',1)],projects:[],flows:[]})).toEqual([]);
  });
  it('says who each item is from and gives the card pill its short reason',()=>{
    const items=needsYouItems({pulses:new Map([['c1',pulse('m1')]]),titles,reviews:[review('t1','p2',500)],projects:[project('p2','c2')],flows:[]});
    expect(items.map(i=>[i.from,i.short,i.reason])).toEqual([['Pip','Review Task t1','Task t1'],['demo-bob','demo-bob: ping m1','ping m1']]);
  });
  it('groups items per chat and keeps an unchanged chat\'s array',()=>{
    const items=needsYouItems({pulses:new Map([['c1',pulse('m1','m2')],['c2',pulse('m3')]]),titles,reviews:[],projects:[],flows:[]});
    const first=needsByChannel(items);
    expect(first.get('c1')!.map(i=>i.key)).toEqual(['mention:m2','mention:m1']);
    const next=needsByChannel(needsYouItems({pulses:new Map([['c1',pulse('m1','m2')],['c2',pulse('m3','m4')]]),titles,reviews:[],projects:[],flows:[]}),first);
    expect(next.get('c1')).toBe(first.get('c1'));
    expect(next.get('c2')).not.toBe(first.get('c2'));
  });
  it('merges flow items (approvals, paused links, missed runs) newest first with mentions and reviews',()=>{
    const items=needsYouItems({pulses:new Map([['c1',pulse('m1')]]),titles,reviews:[review('t1','p2',50)],projects:[project('p2','c2')],
      flows:[approval('d1','c1',300),missed('r1','c2',75)]});
    expect(items.map(i=>[i.key,i.kind,i.chatTitle])).toEqual([['approval:d1','approval','Invoices'],['mention:m1','mention','Invoices'],['missed:r1','missed','Launch'],['review:t1','review','Launch']]);
    expect(items[0]).toMatchObject({from:'Pip',short:'Approve hand-off to Launch',reason:'Approve hand-off to Launch',detail:'Pip finished something in Invoices. It goes to Launch after your OK.'});
  });
  it('drops a flow item only when neither titles nor the server name its chat',()=>{
    expect(needsYouItems({pulses:new Map(),titles,reviews:[],projects:[],flows:[approval('d1','locked',9),missed('r1','gone',8)]})).toEqual([]);
    expect(needsYouItems({pulses:new Map(),titles,reviews:[],projects:[],flows:[{...missed('r1','gone',8),chatTitle:''}]})).toEqual([]);
  });
  it('keeps a Nest-made pause in a chat the person can no longer open, under the server\'s title, and does not let it jump',()=>{
    const deleted:FlowNeed={key:'schedule-paused:s1',kind:'paused',channelId:'gone',at:20,from:null,short:'Schedule paused · this chat is no longer available',
      reason:'this chat is no longer available',detail:'Every day at 09:00 · Pip does not run until you resume it.',gate:{kind:'schedule-paused',scheduleId:'s1'},chatTitle:'a chat you can no longer open'};
    const lost:FlowNeed={key:'paused:l1',kind:'paused',channelId:'archived',at:10,from:null,short:'Hand-off to Launch paused · access changed',
      reason:'access changed',detail:'Nothing passes from Old to Launch until you resume it.',gate:{kind:'paused',linkId:'l1'},chatTitle:'Old'};
    const items=needsYouItems({pulses:new Map(),titles,reviews:[],projects:[],flows:[lost,deleted,{...approval('d1','c1',5),chatTitle:'Stale name'}]});
    expect(items.map(i=>[i.key,i.chatTitle,i.short,i.canOpen])).toEqual([
      ['schedule-paused:s1','a chat you can no longer open','Schedule paused · this chat is no longer available',false],
      ['paused:l1','Old','Hand-off to Launch paused · access changed',false],
      // The client's own title wins for a chat it shows.
      ['approval:d1','Invoices','Approve hand-off to Launch',true],
    ]);
  });
  it('passes each item\'s gate through, and gives a review its project and task',()=>{
    const items=needsYouItems({pulses:new Map([['c1',pulse('m1')]]),titles,reviews:[review('t1','p2',500)],projects:[project('p2','c2')],flows:[approval('d1','c1',300),missed('r1','c2',200)]});
    expect(Object.fromEntries(items.map(i=>[i.key,i.gate??null]))).toEqual({
      'review:t1':{kind:'review',projectId:'p2',taskId:'t1'},
      'approval:d1':{kind:'approval',deliveryId:'d1',linkId:'l1'},
      'missed:r1':{kind:'missed',scheduleId:'s1',runId:'r1'},
      'mention:m1':null,
    });
  });
});
