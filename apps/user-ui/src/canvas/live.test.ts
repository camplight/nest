import {describe,expect,it,vi} from 'vitest';
import type {EventRow} from '../types';
import {createCanvasLive,nudgeMessage} from './live';

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

describe('nudgeMessage',()=>{
  it('targets the agent with a mention of its name',()=>{
    const message=nudgeMessage('c1','Pip','id-1');
    expect(message).toEqual({id:'id-1',channelId:'c1',text:'@Pip are you still on this? Please post a short status update.',
      mentions:[{kind:'AGENT',name:'Pip',start:0,end:4}],attachments:[],targetAgentName:'Pip'});
  });
});
