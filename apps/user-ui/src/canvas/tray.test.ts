import {describe,expect,it} from 'vitest';
import {AGENT_PIN_MAX,type BoardCard,type CanvasArea} from '@nest/schemas';
import type {Agent} from '../types';
import type {AgentPulse,CardPulse} from './pulse';
import {SUGGESTION_MAX,areaAgentNames,busyCounts,busyLabel,pickerGroups,seedPins,trayAgents} from './tray';

const me='h1';
const agent=(name:string,ownerHumanId:string|null='h2',description?:string):Agent=>({name,ownerHumanId,visibility:'PUBLIC',...(description?{description}:{})});
const open=(channelId:string,x:number,agents:string[]):BoardCard=>({
  canvasId:'c1',channelId,x,y:100,w:280,version:0,placedBy:me,placedAt:1,access:'open',title:channelId,projectId:null,
  participants:agents.map(subscriberId=>({subscriberType:'AGENT',subscriberId})),archived:false,canManage:true,
});
const area=(id:string,x:number,w:number):CanvasArea=>({id,canvasId:'c1',title:id,x,y:0,w,h:400,tint:'moss',version:0});
const pulse=(agents:[string,AgentPulse['state']][]):CardPulse=>({agents:agents.map(([name,state])=>({name,state,since:0})),people:[],lastActivityAt:null,artifacts:[],needsYou:[],apps:{} as CardPulse['apps']});
const names=(list:Agent[])=>list.map(a=>a.name);

describe('trayAgents',()=>{
  const roster=[agent('Zed',me),agent('Moss'),agent('Pip'),agent('Ash',me),agent('Kit',me)];
  const areas=[area('review',0,1000),area('later',2000,600)];
  const cards=[open('a',40,['Pip','Kit']),open('b',400,['Moss','Pip']),open('far',2100,['Ash'])];

  it('seeds the tray with the person\'s own agents by name, then the team\'s, until they save pins',()=>{
    const tray=trayAgents({agents:roster,humanId:me,cards,areas,selectedId:null,pins:null});
    expect(names(tray.pinned)).toEqual(['Ash','Kit','Zed','Moss','Pip']);
    expect(tray.suggested).toEqual([]);
  });

  it('caps the seed at the pin limit',()=>{
    const many=Array.from({length:30},(_,n)=>agent(`Helper ${String(n).padStart(2,'0')}`,me));
    expect(AGENT_PIN_MAX).toBe(7);
    expect(seedPins(many,me)).toEqual(many.slice(0,7).map(a=>a.name));
  });

  it('shows exactly the saved pins in their order, an emptied list included, and drops agents not on the roster',()=>{
    expect(names(trayAgents({agents:roster,humanId:me,cards,areas,selectedId:null,pins:['Pip','Gone','Zed']}).pinned)).toEqual(['Pip','Zed']);
    expect(trayAgents({agents:roster,humanId:me,cards,areas,selectedId:null,pins:[]}).pinned).toEqual([]);
  });

  it('leads with the selected card\'s area suggestions and leaves them out of the pins',()=>{
    // Card a has Pip and Kit; card b in the same area brings Moss.
    const tray=trayAgents({agents:roster,humanId:me,cards,areas,selectedId:'a',pins:['Moss','Ash']});
    expect(names(tray.suggested)).toEqual(['Moss']);
    expect(names(tray.pinned)).toEqual(['Ash']);
  });

  it('suggests at most three agents and skips names not on the roster',()=>{
    const crowd=['Ada','Bo','Cy','Di','Nobody'];
    const list=trayAgents({agents:[...roster,...crowd.slice(0,4).map(n=>agent(n))],humanId:me,cards:[open('a',40,[]),open('b',400,crowd)],areas,selectedId:'a',pins:[]});
    expect(SUGGESTION_MAX).toBe(3);
    expect(names(list.suggested)).toEqual(['Ada','Bo','Cy']);
  });
});

describe('busyCounts',()=>{
  it('counts placed open cards where the agent is a participant and working',()=>{
    const cards=[open('a',0,['Pip','Moss']),open('b',400,['Pip']),open('c',800,['Kit'])];
    const pulses=new Map([['a',pulse([['Pip','working'],['Moss','quiet']])],['b',pulse([['Pip','working']])],['c',pulse([['Kit','done']])],
      // A pulse for a chat not on this canvas (a loose chat) never counts.
      ['loose',pulse([['Kit','working']])]]);
    const busy=busyCounts(cards,pulses);
    expect([...busy]).toEqual([['Pip',2]]);
    expect(busyLabel(busy.get('Pip')??0)).toBe('in 2 chats');
    expect(busyLabel(1)).toBe('in 1 chat');
    expect(busyLabel(busy.get('Kit')??0)).toBe('free');
  });
});

describe('pickerGroups',()=>{
  const owners=new Map([[me,'demo'],['h2','Ann'],['h3','Bob']]);
  const roster=[agent('Helper 01',me,'Drafts posts'),agent('Pip','h2','Research'),agent('Moss',me),agent('Kit','h3'),agent('Orphan',null)];
  const none=new Map<string,number>();
  const groups=(over:Partial<Parameters<typeof pickerGroups>[0]>)=>pickerGroups({agents:roster,humanId:me,owners,query:'',filter:'all',inArea:null,busy:none,...over})
    .map(g=>[g.label,names(g.agents)]);

  it('groups by owner, Yours first, then teams by label, each by name',()=>{
    expect(groups({})).toEqual([['Yours',['Helper 01','Moss']],["Ann's team",['Pip']],["Bob's team",['Kit']],['Team',['Orphan']]]);
  });

  it('filters by the chips: Yours, Free now and Working',()=>{
    const busy=new Map([['Pip',1],['Moss',2]]);
    expect(groups({filter:'yours'})).toEqual([['Yours',['Helper 01','Moss']]]);
    expect(groups({filter:'working',busy})).toEqual([['Yours',['Moss']],["Ann's team",['Pip']]]);
    expect(groups({filter:'free',busy})).toEqual([['Yours',['Helper 01']],["Bob's team",['Kit']],['Team',['Orphan']]]);
  });

  it('searches names like mentions, then role and owner name',()=>{
    expect(groups({query:'pi'})).toEqual([["Ann's team",['Pip']]]);
    expect(groups({query:'drafts'})).toEqual([['Yours',['Helper 01']]]);
    expect(groups({query:'bob'})).toEqual([["Bob's team",['Kit']]]);
  });

  it('limits to the agents present in an area\'s cards, nested areas included',()=>{
    const areas=[area('outer',0,1200),{...area('inner',600,500),y:20,h:300}];
    const cards=[open('a',40,['Pip']),open('nested',700,['Kit']),open('out',3000,['Moss'])];
    const inArea=areaAgentNames('outer',cards,areas);
    expect([...inArea].sort()).toEqual(['Kit','Pip']);
    expect(groups({inArea})).toEqual([["Ann's team",['Pip']],["Bob's team",['Kit']]]);
  });
});
