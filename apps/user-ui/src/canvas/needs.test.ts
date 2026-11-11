import {describe,expect,it} from 'vitest';
import type {DashboardTask,Project} from '@nest/schemas';
import type {CardPulse} from './pulse';
import {needsByChannel,needsYouItems} from './needs';

const pulse=(...ids:string[]):CardPulse=>({agents:[],people:[],lastActivityAt:null,artifacts:[],needsYou:ids.map((id,i)=>({kind:'mention' as const,id,at:100+i,sender:'demo-bob',text:`ping ${id}`})),apps:{apps:[],reads:0,changes:0}});
const project=(id:string,channelId:string):Project=>({id,ownerId:'h1',channelId,name:id,description:'',createdAt:1});
const review=(id:string,projectId:string,updatedAt:number):DashboardTask=>({id,projectId,title:`Task ${id}`,agentName:'Pip',updatedAt,status:'needs_review'} as DashboardTask);

describe('needsYouItems',()=>{
  const titles=new Map([['c1','Invoices'],['c2','Launch']]);
  it('counts every unread mention and review as its own item, newest first',()=>{
    const items=needsYouItems({pulses:new Map([['c1',pulse('m1','m2')],['c2',pulse()]]),titles,reviews:[review('t1','p2',500)],projects:[project('p2','c2')]});
    expect(items.map(i=>[i.kind,i.channelId,i.chatTitle])).toEqual([['review','c2','Launch'],['mention','c1','Invoices'],['mention','c1','Invoices']]);
    expect(items[1].detail).toContain('demo-bob');
    expect(items[0].detail).toContain('Task t1');
  });
  it('leaves out chats the person cannot see: locked, unavailable and unknown',()=>{
    const items=needsYouItems({pulses:new Map([['locked',pulse('m1')],['c1',pulse('m2')]]),titles,reviews:[review('t1','p9',9),review('t2','p3',8)],projects:[project('p9','locked'),project('p3','gone')]});
    expect(items.map(i=>i.channelId)).toEqual(['c1']);
  });
  it('skips reviews of projects that are not in the projects list',()=>{
    expect(needsYouItems({pulses:new Map(),titles,reviews:[review('t1','nope',1)],projects:[]})).toEqual([]);
  });
  it('says who each item is from and gives the card pill its short reason',()=>{
    const items=needsYouItems({pulses:new Map([['c1',pulse('m1')]]),titles,reviews:[review('t1','p2',500)],projects:[project('p2','c2')]});
    expect(items.map(i=>[i.from,i.short,i.reason])).toEqual([['Pip','Review Task t1','Task t1'],['demo-bob','demo-bob: ping m1','ping m1']]);
  });
  it('groups items per chat and keeps an unchanged chat\'s array',()=>{
    const items=needsYouItems({pulses:new Map([['c1',pulse('m1','m2')],['c2',pulse('m3')]]),titles,reviews:[],projects:[]});
    const first=needsByChannel(items);
    expect(first.get('c1')!.map(i=>i.key)).toEqual(['mention:m2','mention:m1']);
    const next=needsByChannel(needsYouItems({pulses:new Map([['c1',pulse('m1','m2')],['c2',pulse('m3','m4')]]),titles,reviews:[],projects:[]}),first);
    expect(next.get('c1')).toBe(first.get('c1'));
    expect(next.get('c2')).not.toBe(first.get('c2'));
  });
});
