import {afterEach,beforeEach,describe,it,expect,vi} from 'vitest';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApp as createEngine} from '../../../vendor/orgops/apps/api/src/app';
import {createOrgOpsClient} from '@nest/orgops-client';
import {createApp} from './app';
import type {HistorySummarizer} from './context-compaction';

let dir:string,engine:ReturnType<typeof createEngine>,product:ReturnType<typeof createApp>,headers:Record<string,string>,channelId:string,time:number;
let summarize:ReturnType<typeof vi.fn<HistorySummarizer>>;
const runner={'content-type':'application/json','x-nest-runner-token':'runner-secret'};
const call=(path:string,method='GET',body?:unknown,h:Record<string,string>=headers)=>product.app.request(path,{method,headers:h,...(body===undefined?{}:{body:JSON.stringify(body)})});
const engineCall=(path:string)=>engine.app.fetch(new Request('http://engine'+path,{headers:{'x-orgops-runner-token':'runner-secret'}}));
const say=async(source:string,text:string)=>(await (await call('/api/events','POST',{type:'message.created',source,channelId,payload:{text}},source.startsWith('human:')?headers:runner)).json()).id as string;
const telemetry=(historyChars:number,agentName='Pip',memoryContextMode='FULL_CHANNEL_EVENTS',{as=runner,historyMaxChars=10_000,channel}:{as?:Record<string,string>;historyMaxChars?:number;channel?:string}={})=>call('/api/events','POST',{type:'telemetry.context.window.updated',source:'system:runner:context',status:'DELIVERED',channelId:channel??channelId,
  payload:{agentName,modelId:'default-model',contextWindowTokens:8_000,estimatedUsedTokens:1,estimatedAvailableTokens:1,utilizationPct:1,messageCount:2,systemChars:1,systemContextChars:0,historyChars,historyMaxChars,memoryContextMode}},as);
const compactions=async()=>(await (await engineCall(`/api/events?channelId=${channelId}&type=agent.context.compacted`)).json()) as {id:string;source:string;payload:{summary:string;cutoffEventId:string;cutoffAt:number}}[];
const memoryMode=async()=>(await (await call('/api/agents/Pip')).json()).memoryContextMode;
const tick=()=>product.contextCompaction.tick();

beforeEach(async()=>{
  vi.stubEnv('ORGOPS_MASTER_KEY',Buffer.alloc(32,7).toString('base64'));vi.stubEnv('OPENROUTER_API_KEY','');
  dir=mkdtempSync(join(tmpdir(),'nest-compaction-'));time=1_000_000;
  engine=createEngine({projectRoot:dir,dataDir:dir,dbPath:join(dir,'engine.sqlite'),adminUser:'owner',adminPass:'password',runnerToken:'runner-secret'});
  const client=createOrgOpsClient('http://engine',async(url,init)=>engine.app.fetch(new Request(url,init)));
  summarize=vi.fn<HistorySummarizer>(async({previousSummary,events})=>`${previousSummary?previousSummary+' + ':''}${events.length} older messages`);
  product=createApp({orgops:client,dbPath:join(dir,'product.sqlite'),connections:null,compaction:{engineToken:'runner-secret',summarize,now:()=>time}});
  const login=await call('/api/auth/login','POST',{username:'owner',password:'password'},{'content-type':'application/json'});
  headers={'content-type':'application/json',cookie:login.headers.getSetCookie()[0]!.split(';')[0]!};
  await call('/api/models','POST',{id:'default-model',provider:'openrouter',modelName:'fixture-model',enabled:true});
  await call('/api/secrets','POST',{name:'OPENROUTER_API_KEY',value:'fixture-provider-key',scopeType:'public'});
  expect((await call('/api/agents','POST',{name:'Pip',modelId:'default-model',workspacePath:join(dir,'pip'),memoryContextMode:'FULL_CHANNEL_EVENTS'})).status).toBe(201);
  channelId=(await (await call('/api/channels','POST',{name:'launch',visibility:'PRIVATE'})).json()).id;
  await call(`/api/channels/${channelId}/subscribe`,'POST',{subscriberType:'AGENT',subscriberId:'Pip'});
});
afterEach(()=>{vi.unstubAllEnvs();product.store.close();engine.db.close();rmSync(dir,{recursive:true,force:true});});

async function longChat(count:number,prefix='Message') {
  for(let n=0;n<count;n++)await say(n%2?'agent:Pip':'human:owner',`${prefix} ${n}: ${'detail '.repeat(60)}`);
}

describe('Full history, summarized when long',()=>{
  it('is saved in Nest while the engine keeps reading the full chat',async()=>{
    expect((await call('/api/agents/Pip','PATCH',{memoryContextMode:'FULL_CHANNEL_EVENTS_AUTO_COMPACT'})).status).toBe(200);
    expect(await memoryMode()).toBe('FULL_CHANNEL_EVENTS_AUTO_COMPACT');
    expect((await (await engineCall('/api/agents/Pip')).json()).memoryContextMode).toBe('FULL_CHANNEL_EVENTS');
    expect((await call('/api/agents/Pip','PATCH',{memoryContextMode:'FULL_CHANNEL_EVENTS'})).status).toBe(200);
    expect(await memoryMode()).toBe('FULL_CHANNEL_EVENTS');
  });
  it('is not saved when the engine refuses the change',async()=>{
    expect((await call('/api/agents/Pip','PATCH',{memoryContextMode:'FULL_CHANNEL_EVENTS_AUTO_COMPACT'},{'content-type':'application/json'})).status).toBe(401);
    expect(await memoryMode()).toBe('FULL_CHANNEL_EVENTS');
  });
  it('summarizes the older part of a long chat once and keeps recent messages',async()=>{
    await call('/api/agents/Pip','PATCH',{memoryContextMode:'FULL_CHANNEL_EVENTS_AUTO_COMPACT'});
    await tick();
    await longChat(40);
    const newest=await say('human:owner','What did we decide?');
    await telemetry(9_000);
    await tick();
    expect(summarize).toHaveBeenCalledTimes(1);
    expect(summarize.mock.calls[0]![0]).toMatchObject({model:'openrouter:fixture-model',agentName:'Pip',env:{OPENROUTER_API_KEY:'fixture-provider-key'}});
    const [boundary,...others]=await compactions();
    expect(others).toEqual([]);
    expect(boundary).toMatchObject({source:'agent:Pip',payload:{summary:expect.stringMatching(/older messages$/)}});
    const summarized=summarize.mock.calls[0]![0].events.map(event=>event.id);
    expect(summarized.at(-1)).toBe(boundary!.payload.cutoffEventId);
    expect(summarized).not.toContain(newest);
    // The same reading, and readings during the cooldown, do not compact again.
    await tick();await telemetry(9_500);time+=60_000;await tick();
    expect(summarize).toHaveBeenCalledTimes(1);
  });
  it('merges the previous summary and reads only messages after it',async()=>{
    await call('/api/agents/Pip','PATCH',{memoryContextMode:'FULL_CHANNEL_EVENTS_AUTO_COMPACT'});
    await tick();await longChat(40);await telemetry(9_000);await tick();
    const [first]=await compactions();
    time+=600_000;await longChat(40,'Later');await telemetry(9_000);await tick();
    expect(summarize).toHaveBeenCalledTimes(2);
    const second=summarize.mock.calls[1]![0];
    expect(second.previousSummary).toBe(first!.payload.summary);
    expect(second.events.every(event=>event.createdAt>first!.payload.cutoffAt)).toBe(true);
    expect((await compactions()).length).toBe(2);
  });
  it('leaves chats alone for agents that did not choose it, or below the threshold',async()=>{
    await tick();await longChat(40);await telemetry(9_000);await tick();
    await call('/api/agents/Pip','PATCH',{memoryContextMode:'FULL_CHANNEL_EVENTS_AUTO_COMPACT'});
    await telemetry(7_000);await tick();
    await telemetry(9_000,'Pip','PER_CHANNEL_CROSS_CHANNEL');await tick();
    expect(summarize).not.toHaveBeenCalled();
    expect(await compactions()).toEqual([]);
  });
  it('ignores readings that a person posted, and chats the agent is not in',async()=>{
    await call('/api/agents/Pip','PATCH',{memoryContextMode:'FULL_CHANNEL_EVENTS_AUTO_COMPACT'});
    await tick();await longChat(40);
    expect((await telemetry(9_000,'Pip','FULL_CHANNEL_EVENTS',{as:headers,historyMaxChars:1})).status).toBe(201);
    await tick();
    const other=(await (await call('/api/channels','POST',{name:'elsewhere',visibility:'PRIVATE'})).json()).id;
    await telemetry(9_000,'Pip','FULL_CHANNEL_EVENTS',{channel:other});
    await tick();await tick();
    expect(summarize).not.toHaveBeenCalled();
    expect(await compactions()).toEqual([]);
  });
  it('shows the choice in the agent list for people, and keeps it through admin saves',async()=>{
    await call('/api/agents/Pip','PATCH',{memoryContextMode:'FULL_CHANNEL_EVENTS_AUTO_COMPACT'});
    const listed=async(h:Record<string,string>)=>((await (await call('/api/agents','GET',undefined,h)).json()) as {name:string;memoryContextMode:string}[]).find(agent=>agent.name==='Pip')!.memoryContextMode;
    expect(await listed(headers)).toBe('FULL_CHANNEL_EVENTS_AUTO_COMPACT');
    expect(await listed(runner)).toBe('FULL_CHANNEL_EVENTS');
    // The admin UI saves every field it loaded, including the listed mode.
    expect((await call('/api/agents/Pip','PATCH',{description:'Edited',memoryContextMode:await listed(headers)})).status).toBe(200);
    expect(await memoryMode()).toBe('FULL_CHANNEL_EVENTS_AUTO_COMPACT');
  });
  it('retries a failed summary later without posting anything',async()=>{
    await call('/api/agents/Pip','PATCH',{memoryContextMode:'FULL_CHANNEL_EVENTS_AUTO_COMPACT'});
    summarize.mockRejectedValueOnce(Error('provider said fixture-provider-key is invalid'));
    const errors=vi.spyOn(console,'error');
    await tick();await longChat(40);await telemetry(9_000);await tick();
    expect(await compactions()).toEqual([]);
    expect(JSON.stringify(errors.mock.calls)).not.toContain('fixture-provider-key');
    time+=31_000;await tick();
    expect((await compactions()).length).toBe(1);
  });
});
