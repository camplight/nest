import {it,expect} from 'vitest';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createWrappedProgressPublisher} from './wrapped-progress.mjs';
import {createCodexOutput} from '../../../deploy/nestsystem-bridge.mjs';
import {createClaudeOutput} from '../../../deploy/claude-code-bridge.mjs';
import {createApp} from '../../../vendor/orgops/apps/api/src/app';
import {shouldHandleEventForAgent} from '../../../vendor/orgops/apps/agent-runner/src/event-routing';

const env={ORGOPS_WRAPPED_AGENT_NAME:'NestSystem',ORGOPS_WRAPPED_CHANNEL_ID:'room',ORGOPS_WRAPPED_TRIGGER_EVENT_ID:'trigger',ORGOPS_RUNNER_TOKEN:'fixture-runner',ORGOPS_API_URL:'http://engine'};

it('streams to the real engine, reconciles a lost response and never wakes another agent',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'nest-progress-'));
  const engine=createApp({dbPath:join(dir,'engine.sqlite'),projectRoot:dir,dataDir:dir,adminUser:'owner',adminPass:'password',runnerToken:env.ORGOPS_RUNNER_TOKEN});
  try{
    const headers={'content-type':'application/json','x-orgops-runner-token':env.ORGOPS_RUNNER_TOKEN};
    const login=await engine.app.request('/api/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:'owner',password:'password'})});
    const humanHeaders={'content-type':'application/json',cookie:login.headers.getSetCookie()[0].split(';')[0]};
    const post=async(path,body)=>{const r=await engine.app.request(path,{method:'POST',headers:humanHeaders,body:JSON.stringify(body)});expect(r.ok,await r.clone().text()).toBe(true);return r.json();};
    const channel=await post('/api/channels',{name:'Synthetic progress room',visibility:'PRIVATE'});
    const other=await post('/api/channels',{name:'Unrelated room',visibility:'PRIVATE'});
    const trigger=await post('/api/events',{type:'message.created',source:'human:owner',channelId:channel.id,payload:{text:'Check release'}});
    let lose=true,calls=0;
    const publish=createWrappedProgressPublisher({env:{...env,ORGOPS_WRAPPED_CHANNEL_ID:channel.id,ORGOPS_WRAPPED_TRIGGER_EVENT_ID:trigger.id},fetchImpl:async(url,init)=>{
      calls++;expect(new Headers(init.headers).get('x-orgops-runner-token')).toBe(env.ORGOPS_RUNNER_TOKEN);
      expect(init.redirect).toBe('error');
      const response=await engine.app.fetch(new Request(url,init));
      if(lose){lose=false;throw Error('Lost committed response');}return response;
    }});
    const output=createCodexOutput({publishProgress:publish});
    for(const event of [
      {type:'item.completed',item:{id:'update',type:'agent_message',text:'Waiting for release checks.'}},
      {type:'item.started',item:{id:'check',type:'command_execution',command:'private command'}},
      {type:'item.completed',item:{id:'final',type:'agent_message',text:'Checks passed.'}},
    ])output.write(JSON.stringify(event)+'\n');
    expect((await output.finish()).finalText).toBe('Checks passed.');
    expect(calls).toBe(2);
    const events=await(await engine.app.request(`/api/events?channelId=${channel.id}&type=agent.turn.phase`,{headers})).json();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({source:'agent:NestSystem',channelId:channel.id,parentEventId:trigger.id,status:'DELIVERED',payload:{phase:'codex-progress',text:'Waiting for release checks.',triggerEventId:trigger.id}});
    expect(shouldHandleEventForAgent({name:'Teammate'},events[0])).toBe(false);
    expect(shouldHandleEventForAgent({name:'NestSystem'},events[0])).toBe(false);
    expect(await(await engine.app.request(`/api/events?channelId=${other.id}`,{headers})).json()).toEqual([]);
  }finally{engine.db.close();rmSync(dir,{recursive:true,force:true});}
});

it('bounds stalled requests and reports only a generic error without losing credentials to logs',async()=>{
  let calls=0;
  const publish=createWrappedProgressPublisher({env,timeoutMs:10,fetchImpl:async(_url,init)=>{
    calls++;return new Promise((_resolve,reject)=>init.signal.addEventListener('abort',()=>reject(Error('private response')),{once:true}));
  }});
  await expect(publish({id:'update',text:'Working.'})).rejects.toThrow('Wrapped progress unavailable');expect(calls).toBe(2);
});

it('does not retry authorization errors or send credentials through redirects',async()=>{
  let calls=0;
  const publish=createWrappedProgressPublisher({env,fetchImpl:async(_url,init)=>{
    calls++;expect(init.redirect).toBe('error');return new Response('private response',{status:403});
  }});
  await expect(publish({id:'update',text:'Working.'})).rejects.toThrow('Wrapped progress unavailable');expect(calls).toBe(1);
  expect(()=>createWrappedProgressPublisher({env:{...env,ORGOPS_WRAPPED_CHANNEL_ID:''}})).toThrow('context missing');
  expect(()=>createWrappedProgressPublisher({env:{...env,ORGOPS_API_URL:'https://user:secret@engine/'}})).toThrow('HTTP origin');
});

it('publishes Claude Code progress with the runtime-neutral phase without waking agents',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'nest-claude-progress-'));
  const engine=createApp({dbPath:join(dir,'engine.sqlite'),projectRoot:dir,dataDir:dir,adminUser:'owner',adminPass:'password',runnerToken:env.ORGOPS_RUNNER_TOKEN});
  try{
    const headers={'content-type':'application/json','x-orgops-runner-token':env.ORGOPS_RUNNER_TOKEN};
    const login=await engine.app.request('/api/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:'owner',password:'password'})});
    const humanHeaders={'content-type':'application/json',cookie:login.headers.getSetCookie()[0].split(';')[0]};
    const post=async(path,body)=>{const r=await engine.app.request(path,{method:'POST',headers:humanHeaders,body:JSON.stringify(body)});expect(r.ok,await r.clone().text()).toBe(true);return r.json();};
    const channel=await post('/api/channels',{name:'Synthetic Claude room',visibility:'PRIVATE'});
    const trigger=await post('/api/events',{type:'message.created',source:'human:owner',channelId:channel.id,payload:{text:'Run the tests'}});
    const publish=createWrappedProgressPublisher({phase:'wrapped-progress',env:{...env,ORGOPS_WRAPPED_AGENT_NAME:'Claude',ORGOPS_WRAPPED_CHANNEL_ID:channel.id,ORGOPS_WRAPPED_TRIGGER_EVENT_ID:trigger.id},fetchImpl:(url,init)=>engine.app.fetch(new Request(url,init))});
    const output=createClaudeOutput({publishProgress:publish});
    const assistant=(id,block)=>({type:'assistant',session_id:'s',message:{id,content:[block]}});
    for(const event of [
      assistant('m1',{type:'text',text:'Running the tests.'}),
      assistant('m1',{type:'tool_use',id:'t',name:'Bash',input:{command:'private command'}}),
      {type:'user',message:{content:[{type:'tool_result',tool_use_id:'t',content:'private output'}]}},
      assistant('m2',{type:'text',text:'Tests pass.'}),
      {type:'result',subtype:'success',is_error:false,num_turns:2,result:'Tests pass.',session_id:'s'},
    ])output.write(JSON.stringify(event)+'\n');
    expect((await output.finish()).finalText).toBe('Tests pass.');
    const events=await(await engine.app.request(`/api/events?channelId=${channel.id}&type=agent.turn.phase`,{headers})).json();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({source:'agent:Claude',parentEventId:trigger.id,payload:{phase:'wrapped-progress',text:'Running the tests.',triggerEventId:trigger.id}});
    expect(events[0].idempotencyKey).toMatch(/^nest:wrapped-progress:/);
    expect(shouldHandleEventForAgent({name:'Claude'},events[0])).toBe(false);
  }finally{engine.db.close();rmSync(dir,{recursive:true,force:true});}
});

it('rejects unknown progress phases before any request',()=>{
  expect(()=>createWrappedProgressPublisher({env,phase:'private-phase'})).toThrow('Unknown wrapped progress phase');
});
