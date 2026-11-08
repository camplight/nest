import {describe,expect,it,vi} from 'vitest';
import type {EventRow} from '../types';
import {createCanvasLive,nudgeMessage,toSignal} from './live';

const now=Date.UTC(2026,10,8,12,0,0);
const min=60_000;
const started=(id:string,agent:string,channelId:string,at:number):EventRow=>({id,type:'agent.turn.started',source:`agent:${agent}`,createdAt:at,channelId,payload:{triggerEventId:`m-${id}`}});

function harness(seed:Record<string,unknown>={}){
  const urls:string[]=[];
  const fetchJson=vi.fn(async(url:string)=>{
    urls.push(url);
    for(const [prefix,value] of Object.entries(seed))if(url.startsWith(prefix))return value;
    if(url==='/api/mentions')return {items:[]};
    return [];
  }) as unknown as <T>(url:string)=>Promise<T>;
  const frames:(()=>void)[]=[];
  const live=createCanvasLive({fetchJson,now:()=>now,frame:callback=>{frames.push(callback);}});
  const flush=()=>{for(const callback of frames.splice(0))callback();};
  return {live,urls,frames,flush};
}

describe('createCanvasLive',()=>{
  it('seeds turn events, messages, lifecycle starts, agents and mentions',async()=>{
    const {live,urls}=harness({'/api/agents':[{name:'Pom',desiredState:'RUNNING',runtimeState:'RUNNING'}],'/api/events?typePrefix=agent.turn.':[started('s1','Pom','c1',now-5*min)]});
    live.setCards([{channelId:'c1',agentNames:['Pom']}]);
    await live.refresh();
    expect(urls).toEqual(expect.arrayContaining([
      '/api/events?typePrefix=agent.turn.&order=desc&limit=1000',
      '/api/events?type=message.created&order=desc&limit=500',
      '/api/events?type=agent.lifecycle.started&limit=100&order=desc',
      '/api/agents',
      '/api/mentions',
    ]));
    expect(live.snapshot().get('c1')!.agents).toEqual([{name:'Pom',state:'working',since:now-5*min}]);
  });

  it('coalesces ingested events to one recompute per frame and keeps unchanged pulses identical',async()=>{
    const {live,frames,flush}=harness({'/api/agents':[{name:'Pom',desiredState:'RUNNING',runtimeState:'RUNNING'},{name:'Pip',desiredState:'RUNNING',runtimeState:'RUNNING'}]});
    live.setCards([{channelId:'c1',agentNames:['Pom']},{channelId:'c2',agentNames:['Pip']}]);
    await live.refresh();
    flush();
    const before=live.snapshot(),other=before.get('c2');
    const listener=vi.fn();
    live.subscribe(listener);
    live.ingest(started('s1','Pom','c1',now-min));
    live.ingest({id:'p1',type:'agent.turn.phase',source:'agent:Pom',createdAt:now-30_000,channelId:'c1',payload:{triggerEventId:'m-s1',phase:'thinking'}});
    expect(frames).toHaveLength(1);
    expect(live.snapshot()).toBe(before);
    flush();
    expect(listener).toHaveBeenCalledTimes(1);
    const after=live.snapshot();
    expect(after).not.toBe(before);
    expect(after.get('c1')!.agents[0].state).toBe('working');
    expect(after.get('c2')).toBe(other);
    // A status republish of the same event changes nothing visible: no new snapshot.
    live.ingest({...started('s1','Pom','c1',now-min),status:'DELIVERED'});
    flush();
    expect(live.snapshot()).toBe(after);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('a lifecycle start recomputes the agent as interrupted',async()=>{
    const {live,flush}=harness({'/api/agents':[{name:'Pom',desiredState:'RUNNING',runtimeState:'RUNNING'}],'/api/events?typePrefix=agent.turn.':[started('s1','Pom','c1',now-5*min)]});
    live.setCards([{channelId:'c1',agentNames:['Pom']}]);
    await live.refresh();
    live.ingest({id:'l1',type:'agent.lifecycle.started',source:'system:runner',createdAt:now-min,payload:{targetAgentName:'Pom'}});
    flush();
    expect(live.snapshot().get('c1')!.agents[0].state).toBe('interrupted');
  });

  it('ignores events for channels without a card until one is added',async()=>{
    const {live,frames,flush}=harness({'/api/agents':[{name:'Pom',desiredState:'RUNNING',runtimeState:'RUNNING'}]});
    live.setCards([{channelId:'c1',agentNames:['Pom']}]);
    await live.refresh();
    flush();
    live.ingest(started('s1','Pom','loose',now-min));
    expect(frames).toHaveLength(0);
    live.setCards([{channelId:'c1',agentNames:['Pom']},{channelId:'loose',agentNames:['Pom']}]);
    flush();
    expect(live.snapshot().get('loose')!.agents[0].state).toBe('working');
  });
});

describe('agent signals between turn events (Ruling R13)',()=>{
  const running={'/api/agents':[{name:'Pom',desiredState:'RUNNING',runtimeState:'RUNNING'}]};
  const tool=(id:string,at:number,channelId='c1'):EventRow=>({id,type:'tool.executed',source:'agent:Pom',createdAt:at,channelId,payload:{tool:'shell',output:'synthetic tool output'}});

  it('seeds tool events, so a long tool-heavy turn reads working straight after seeding',async()=>{
    const {live,urls,flush}=harness({...running,'/api/events?typePrefix=agent.turn.':[started('s1','Pom','c1',now-25*min)],'/api/events?typePrefix=tool.':[tool('t1',now-min)]});
    live.setCards([{channelId:'c1',agentNames:['Pom']}]);
    await live.refresh();
    flush();
    expect(urls).toContain('/api/events?typePrefix=tool.&order=desc&limit=500');
    expect(live.snapshot().get('c1')!.agents[0].state).toBe('working');
  });

  it('a refresh keeps a live tool signal newer than the seed, so the card does not flap back to quiet',async()=>{
    const {live,flush}=harness({...running,'/api/events?typePrefix=agent.turn.':[started('s1','Pom','c1',now-25*min)]});
    live.setCards([{channelId:'c1',agentNames:['Pom']}]);
    await live.refresh();
    flush();
    expect(live.snapshot().get('c1')!.agents[0].state).toBe('quiet');
    live.ingest(tool('t1',now-min));
    flush();
    expect(live.snapshot().get('c1')!.agents[0].state).toBe('working');
    await live.refresh();
    flush();
    expect(live.snapshot().get('c1')!.agents[0].state).toBe('working');
  });

  it('a refresh keeps live turn events newer than a full seed page and drops older ones',async()=>{
    // The turn page is full (limit 1000) and reaches back 10 minutes: a live start 2 minutes old is kept.
    const page=Array.from({length:1000},(_,i)=>({id:`x${i}`,type:'agent.turn.phase',source:'agent:Other',createdAt:now-10*min+i,channelId:'elsewhere',payload:{}}));
    const {live,flush}=harness({...running,'/api/events?typePrefix=agent.turn.':page});
    live.setCards([{channelId:'c1',agentNames:['Pom']},{channelId:'c2',agentNames:['Pom']}]);
    live.ingest(started('s1','Pom','c1',now-2*min));
    // Older than the page reaches: the seed would hold its ending if it had one, so it is not kept.
    live.ingest(started('s2','Pom','c2',now-20*min));
    await live.refresh();
    flush();
    expect(live.snapshot().get('c1')!.agents[0].state).toBe('working');
    expect(live.snapshot().get('c2')!.agents[0].state).toBe('idle');
  });

  it('hundreds of tool events do not evict the turn start',async()=>{
    const {live,flush}=harness({...running,'/api/events?typePrefix=agent.turn.':[started('s1','Pom','c1',now-25*min)]});
    live.setCards([{channelId:'c1',agentNames:['Pom']}]);
    await live.refresh();
    for(let i=0;i<450;i++)live.ingest(tool(`t${i}`,now-24*min+i*3000));
    flush();
    expect(live.snapshot().get('c1')!.agents[0]).toMatchObject({state:'working'});
  });

  it('a flood of progress phases does not evict the turn start',async()=>{
    const {live,flush}=harness({...running,'/api/events?typePrefix=agent.turn.':[started('s1','Pom','c1',now-5*min)]});
    live.setCards([{channelId:'c1',agentNames:['Pom']}]);
    await live.refresh();
    for(let i=0;i<450;i++)live.ingest({id:`p${i}`,type:'agent.turn.phase',source:'agent:Pom',createdAt:now-4*min+i*100,channelId:'c1',payload:{triggerEventId:'m-other',phase:'thinking'}});
    flush();
    expect(live.snapshot().get('c1')!.agents[0]).toMatchObject({state:'working',since:now-5*min});
  });

  it('stores only the timestamp fields of a tool event, never its arguments or output',()=>{
    expect(toSignal(tool('t1',now-min))).toEqual({id:'t1',type:'tool.executed',source:'agent:Pom',channelId:'c1',createdAt:now-min});
  });
});

describe('nudgeMessage',()=>{
  it('targets the agent with a mention of its name',()=>{
    const message=nudgeMessage('c1','Pip','id-1');
    expect(message).toEqual({id:'id-1',channelId:'c1',text:'@Pip are you still on this? Please post a short status update.',
      mentions:[{kind:'AGENT',name:'Pip',start:0,end:4}],attachments:[],targetAgentName:'Pip'});
  });
});
