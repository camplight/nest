import {describe,expect,it} from 'vitest';
import type {MentionNotification} from '@nest/schemas';
import type {Agent,EventRow} from '../types';
import {QUIET_AFTER_MS,areaSummaries,cardPulse,oneLine,type CardPulse} from './pulse';
import type {AppCall} from '../app-activity';

const now=Date.UTC(2026,10,8,12,0,0);
const min=60_000;
const ev=(id:string,type:string,source:string,createdAt:number,payload:Record<string,unknown>={},channelId='c1'):EventRow=>({id,type,source,createdAt,channelId,payload});
// Real event shapes: the runner's turn events carry the triggering message id and the agent as source.
const started=(id:string,agent:string,trigger:string,at:number,channelId='c1')=>ev(id,'agent.turn.started',`agent:${agent}`,at,{triggerEventId:trigger},channelId);
const ended=(id:string,type:'agent.turn.completed'|'agent.turn.failed',agent:string,trigger:string,at:number)=>ev(id,type,`agent:${agent}`,at,{triggerEventId:trigger});
const message=(id:string,source:string,at:number,attachments:{fileId:string;name:string;mime?:string}[]=[],channelId='c1')=>ev(id,'message.created',source,at,{text:'Synthetic message',attachments},channelId);
// A running agent whose runner keeps heartbeating: its row is refreshed after the turn began.
const running=(name:string):Agent=>({name,desiredState:'RUNNING',runtimeState:'RUNNING',updatedAt:now-1000});
const cards=[{channelId:'c1',agentNames:['Pom']}];
const pulse=(events:EventRow[],options:{agents?:Agent[];starts?:Record<string,number>;mentions?:MentionNotification[];cards?:{channelId:string;agentNames:string[]}[]}={})=>
  cardPulse({events,agents:options.agents??[running('Pom')],starts:options.starts??{},mentions:options.mentions??[],cards:options.cards??cards,now});
const mention=(id:string,channelId:string,readAt:number|null,createdAt:number):MentionNotification=>({id,channelId,channelName:'Synthetic',sender:'demo-owner',text:'@me look',createdAt,readAt});

describe('cardPulse',()=>{
  it('quiet starts after 20 minutes',()=>{
    expect(QUIET_AFTER_MS).toBe(20*min);
  });

  it('a turn started 5 minutes ago is working',()=>{
    const result=pulse([message('m1','human:demo-owner',now-6*min),started('s1','Pom','m1',now-5*min)]);
    expect(result.get('c1')!.agents).toEqual([{name:'Pom',state:'working',since:now-5*min}]);
  });

  it('a turn started 25 minutes ago with no later signal is quiet while the agent heartbeats, never done',()=>{
    const result=pulse([message('m1','human:demo-owner',now-26*min),started('s1','Pom','m1',now-25*min)]);
    const [pom]=result.get('c1')!.agents;
    expect(pom).toMatchObject({name:'Pom',state:'quiet',quietMinutes:25});
    expect(pom.state).not.toBe('done');
  });

  it('a later signal from the agent keeps the turn working',()=>{
    const result=pulse([started('s1','Pom','m1',now-25*min),ev('p1','agent.turn.phase','agent:Pom',now-2*min,{triggerEventId:'m1',phase:'thinking'})]);
    expect(result.get('c1')!.agents[0].state).toBe('working');
  });

  it('a restart after the turn began is interrupted',()=>{
    const result=pulse([started('s1','Pom','m1',now-25*min)],{starts:{Pom:now-10*min}});
    expect(result.get('c1')!.agents[0]).toMatchObject({name:'Pom',state:'interrupted'});
  });

  it('the latest ending decides done or failed',()=>{
    const done=pulse([started('s1','Pom','m1',now-30*min),ended('e1','agent.turn.completed','Pom','m1',now-29*min)]);
    expect(done.get('c1')!.agents[0]).toEqual({name:'Pom',state:'done',since:now-29*min});
    const failed=pulse([started('s1','Pom','m1',now-30*min),ended('e1','agent.turn.failed','Pom','m1',now-29*min)]);
    expect(failed.get('c1')!.agents[0]).toEqual({name:'Pom',state:'failed',since:now-29*min});
    const idle=pulse([]);
    expect(idle.get('c1')!.agents[0]).toMatchObject({name:'Pom',state:'idle'});
  });

  it('a stopped agent with no turn is unavailable',()=>{
    const result=pulse([],{agents:[{name:'Pom',desiredState:'STOPPED',runtimeState:'STOPPED',updatedAt:now-min}]});
    expect(result.get('c1')!.agents[0]).toMatchObject({name:'Pom',state:'unavailable'});
    const crashed=pulse([ended('e1','agent.turn.completed','Pom','m1',now-29*min)],{agents:[{name:'Pom',desiredState:'RUNNING',runtimeState:'CRASHED',updatedAt:now-min}]});
    expect(crashed.get('c1')!.agents[0].state).toBe('unavailable');
  });

  it('lists the card agents in roster order',()=>{
    const result=pulse([started('s1','Pip','m1',now-min)],{agents:[running('Pip'),running('Pom')],cards:[{channelId:'c1',agentNames:['Pom','Pip']}]});
    expect(result.get('c1')!.agents.map(a=>[a.name,a.state])).toEqual([['Pom','idle'],['Pip','working']]);
  });

  it('artifacts are deduplicated by file across messages, newest first, at most 6',()=>{
    const files=(...ids:string[])=>ids.map(id=>({fileId:id,name:`${id}.txt`,mime:'text/plain'}));
    const result=pulse([
      message('m1','agent:Pom',now-10*min,files('b','c','d','e','f','g')),
      message('m2','human:demo-owner',now-5*min,files('a','b')),
    ]);
    const card=result.get('c1')!;
    expect(card.artifacts.map(a=>a.fileId)).toEqual(['a','b','c','d','e','f']);
    expect(card.artifacts[0]).toEqual({fileId:'a',name:'a.txt',mime:'text/plain'});
    expect(card.lastActivityAt).toBe(now-5*min);
  });

  it('unread mentions for the channel need you; read ones do not',()=>{
    const result=pulse([],{mentions:[mention('n1','c1',null,now-3*min),mention('n2','c1',now-min,now-4*min),mention('n3','c2',null,now-2*min)]});
    expect(result.get('c1')!.needsYou).toEqual([{kind:'mention',id:'n1',at:now-3*min,sender:'demo-owner',text:'@me look'}]);
    expect(result.get('c1')!.lastActivityAt).toBeNull();
  });

  it('a working agent carries its turn\'s latest progress line, and its newest running app call (app and action only)',()=>{
    const phase=(id:string,at:number,text:string)=>ev(id,'agent.turn.phase','agent:Pom',at,{triggerEventId:'m1',phase:'codex-progress',text});
    const call=(id:string,at:number,state:'running'|'done'):AppCall=>({id,channelId:'c1',agent:'Pom',at,app:'gmail',appName:'Gmail',action:'Fetch emails',kind:'read',label:null,state});
    const events=[started('s1','Pom','m1',now-5*min),phase('p1',now-4*min,'Reading the brief'),phase('p2',now-3*min,'## Drafting **the** post\nsecond line')];
    const working=cardPulse({events,agents:[running('Pom')],starts:{},mentions:[],cards,now,apps:new Map([['c1',[call('a1',now-2*min,'running'),call('a0',now-3*min,'done')]]])});
    expect(working.get('c1')!.agents[0]).toEqual({name:'Pom',state:'working',since:now-5*min,activity:'Drafting the post',app:{app:'gmail',appName:'Gmail',action:'Fetch emails'}});
    const finished=cardPulse({events,agents:[running('Pom')],starts:{},mentions:[],cards,now,apps:new Map([['c1',[call('a0',now-3*min,'done')]]])});
    expect(finished.get('c1')!.agents[0].app).toBeUndefined();
  });

  it('keeps each agent\'s and person\'s latest message line, and how many files a person\'s carried',()=>{
    const result=pulse([
      message('m1','human:demo-owner',now-9*min),
      ev('m2','message.created','agent:Pom',now-8*min,{text:'> Posted the summary\nmore'}),
      message('m3','human:mate',now-7*min,[{fileId:'f1',name:'a.txt'},{fileId:'f2',name:'b.txt'}]),
      started('s1','Pom','m1',now-30*min),ended('e1','agent.turn.completed','Pom','m1',now-29*min),
    ]);
    const card=result.get('c1')!;
    expect(card.agents[0]).toEqual({name:'Pom',state:'done',since:now-29*min,said:'Posted the summary'});
    expect(card.people).toEqual([{name:'demo-owner',at:now-9*min,said:'Synthetic message',files:0},{name:'mate',at:now-7*min,said:'Synthetic message',files:2}]);
  });

  it('ignores events from channels that are not cards',()=>{
    const result=pulse([started('s1','Pom','m1',now-min,'c2'),message('m1','agent:Pom',now-min,[{fileId:'x',name:'x.txt'}],'c2')]);
    expect([...result.keys()]).toEqual(['c1']);
    expect(result.get('c1')).toEqual({agents:[{name:'Pom',state:'idle',since:0}],people:[],lastActivityAt:null,artifacts:[],needsYou:[],apps:{apps:[],reads:0,changes:0}});
  });
});

describe('areaSummaries',()=>{
  const area=(id:string,x:number,y:number,w:number,h:number)=>({id,canvasId:'cv',title:id,x,y,w,h,tint:'moss' as const,version:1});
  const p=(state:'working'|'idle'|'quiet',needs:number):CardPulse=>({agents:[{name:'Pom',state,since:1}],people:[],lastActivityAt:null,artifacts:[],needsYou:Array.from({length:needs},(_,i)=>({kind:'mention' as const,id:`n${i}`,at:1,sender:'x',text:'hi'})),apps:{apps:[],reads:0,changes:0}});
  const placed=(channelId:string,x:number,y:number)=>({channelId,x,y,w:280});
  it('counts cards that need you, are moving or have gone quiet, including nested areas',()=>{
    const outer=area('outer',0,0,2000,1000),inner=area('inner',100,100,800,600),apart=area('apart',3000,0,600,600);
    const result=areaSummaries(
      [placed('a',200,200),placed('b',1200,200),placed('c',1200,600),placed('d',3100,100),placed('e',400,300)],
      [outer,inner,apart],
      new Map([['a',p('working',1)],['b',p('idle',2)],['c',p('working',0)],['d',p('idle',0)],['e',p('quiet',0)]]),
    );
    expect(result.get('inner')).toEqual({needYou:1,moving:1,quiet:1,chats:2});
    expect(result.get('outer')).toEqual({needYou:2,moving:2,quiet:1,chats:4});
    expect(result.get('apart')).toEqual({needYou:0,moving:0,quiet:0,chats:1});
  });
  it('counts a card\'s Needs you items (mentions and reviews) when given, instead of its mentions alone',()=>{
    const only=area('only',0,0,1000,1000);
    const result=areaSummaries([placed('a',100,100),placed('b',500,100)],[only],new Map([['a',p('idle',1)],['b',p('idle',0)]]),new Map([['b',[{}]]]));
    expect(result.get('only')).toEqual({needYou:1,moving:0,quiet:0,chats:2});
  });
});

describe('oneLine',()=>{
  it('keeps the first non-empty line without Markdown marks, at most 140 characters',()=>{
    expect(oneLine('\n\n- **Done:** shipped `v2`\nnext')).toBe('Done: shipped v2');
    expect(oneLine('x'.repeat(200))).toHaveLength(140);
    expect(oneLine(undefined)).toBe('');
  });
});
