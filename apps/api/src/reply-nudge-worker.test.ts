import {afterEach,beforeEach,describe,it,expect,vi} from 'vitest';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApp as createEngine} from '../../../vendor/orgops/apps/api/src/app';
import {createOrgOpsClient} from '@nest/orgops-client';
import {createApp} from './app';

let dir:string,engine:ReturnType<typeof createEngine>,product:ReturnType<typeof createApp>,headers:Record<string,string>,channelId:string,clockOffset:number;
const runner={'content-type':'application/json','x-nest-runner-token':'runner-secret'};
const call=(path:string,method='GET',body?:unknown,h:Record<string,string>=headers)=>product.app.request(path,{method,headers:h,...(body===undefined?{}:{body:JSON.stringify(body)})});
const engineCall=(path:string)=>engine.app.fetch(new Request('http://engine'+path,{headers:{'x-orgops-runner-token':'runner-secret'}}));
const post=async(event:Record<string,unknown>,h:Record<string,string>=runner)=>{
  const response=await call('/api/events','POST',{channelId,...event},h);
  expect(response.status).toBe(201);
  return (await response.json()).id as string;
};
const ask=(text:string,extra:Record<string,unknown>={})=>post({type:'message.created',source:'human:owner',payload:{text,...extra}},headers);
const say=(text:string,agent='Pip')=>post({type:'message.created',source:`agent:${agent}`,payload:{text}});
/** A runner turn for one trigger: started, an optional tool call and reply, and completed (or failed). */
async function turn(triggerEventId:string,{agent='Pip',reply,cancelled,failed,tool,end={}}:{agent?:string;reply?:string;cancelled?:boolean;failed?:boolean;tool?:boolean;end?:Record<string,unknown>}={}) {
  await post({type:'agent.turn.started',source:`agent:${agent}`,payload:{triggerEventId,eventCount:1}});
  if(tool)await post({type:'tool.executed',source:`agent:${agent}`,payload:{tool:'shell_run',args:{},output:'board read'}});
  if(reply)await say(reply,agent);
  if(failed)return post({type:'agent.turn.failed',source:`agent:${agent}`,payload:{triggerEventId,eventCount:1,error:'boom'}});
  return post({type:'agent.turn.completed',source:`agent:${agent}`,payload:{triggerEventId,eventCount:1,...(cancelled?{cancelled:true}:{noReply:true}),...end}});
}
type Nudge={id:string;source:string;parentEventId?:string;payload:{text:string;targetAgentName:string;nestReplyNudge:{triggerEventId:string;requestedFor:string}}};
const nudges=async()=>((await (await engineCall(`/api/events?channelId=${channelId}&type=message.created&source=system:nest`)).json()) as Nudge[]);
const tick=()=>product.replyNudges.tick();

beforeEach(async()=>{
  vi.stubEnv('ORGOPS_MASTER_KEY',Buffer.alloc(32,7).toString('base64'));
  dir=mkdtempSync(join(tmpdir(),'nest-reply-nudge-'));clockOffset=0;
  engine=createEngine({projectRoot:dir,dataDir:dir,dbPath:join(dir,'engine.sqlite'),adminUser:'owner',adminPass:'password',runnerToken:'runner-secret'});
  const client=createOrgOpsClient('http://engine',async(url,init)=>engine.app.fetch(new Request(url,init)));
  product=createApp({orgops:client,dbPath:join(dir,'product.sqlite'),connections:null,compaction:{engineToken:'runner-secret',now:()=>Date.now()+clockOffset}});
  const login=await call('/api/auth/login','POST',{username:'owner',password:'password'},{'content-type':'application/json'});
  headers={'content-type':'application/json',cookie:login.headers.getSetCookie()[0]!.split(';')[0]!};
  await call('/api/models','POST',{id:'default-model',provider:'openrouter',modelName:'fixture-model',enabled:true});
  for(const name of ['Pip','Rex'])expect((await call('/api/agents','POST',{name,modelId:'default-model',workspacePath:join(dir,name)})).status).toBe(201);
  channelId=(await (await call('/api/channels','POST',{name:'launch',visibility:'PRIVATE'})).json()).id;
  await call(`/api/channels/${channelId}/subscribe`,'POST',{subscriberType:'AGENT',subscriberId:'Pip'});
  // The first pass only sets the starting point.
  await tick();
});
afterEach(()=>{vi.unstubAllEnvs();product.store.close();engine.db.close();rmSync(dir,{recursive:true,force:true});});

describe('Asking an agent to reply when it ended without answering',()=>{
  it('asks the only agent in a chat once when it worked on a question and ended without replying',async()=>{
    const question=await ask('What is on the Miro board?');
    await turn(question,{tool:true});
    await tick();
    const [nudge,...others]=await nudges();
    expect(others).toEqual([]);
    expect(nudge).toMatchObject({source:'system:nest',parentEventId:question,payload:{targetAgentName:'Pip',nestReplyNudge:{triggerEventId:question,requestedFor:'human:owner'}}});
    expect(nudge!.payload.text).toBe("You ended your turn without replying to owner. Reply to them now, or say why you can't.");
    await tick();
    // A restarted or second API process reads the same completion again.
    product.store.replyNudges.setCursor(0);
    await tick();
    expect(await nudges()).toHaveLength(1);
  });

  it('asks an @mentioned agent in a group chat but not an agent nobody addressed',async()=>{
    await call(`/api/channels/${channelId}/subscribe`,'POST',{subscriberType:'AGENT',subscriberId:'Rex'});
    const forPip=await ask('@Pip what is on the board?',{mentions:[{kind:'AGENT',name:'Pip',start:0,end:4}],targetAgentName:'Pip'});
    await turn(forPip);await tick();
    // Each pass runs before the person's next message, which would count as a follow-up.
    const general=await ask('Morning everyone');
    await turn(general);await turn(general,{agent:'Rex'});await tick();
    const forRex=await ask('@Rex can you check?',{mentions:[{kind:'AGENT',name:'Rex',start:0,end:4}],targetAgentName:'Rex'});
    await turn(forRex);await tick();
    const found=await nudges();
    expect(found.map(n=>[n.payload.targetAgentName,n.parentEventId])).toEqual([['Pip',forPip]]);
  });

  it('leaves the only agent alone when it rightly let a message pass without doing anything',async()=>{
    const thanks=await ask('Thanks!');
    await turn(thanks);
    await tick();
    expect(await nudges()).toEqual([]);
  });

  it('does not ask about a turn that scheduled a retry, or a turn that ended long ago',async()=>{
    const retry=await ask('Check the board again');
    await turn(retry,{tool:true,end:{scheduledContinuation:true}});await tick();
    const old=await ask('And the other board?');
    await turn(old,{tool:true});
    clockOffset=11*60_000;
    await tick();
    expect(await nudges()).toEqual([]);
  });

  it('does not ask the only agent when the person addressed someone else',async()=>{
    const toAlice=await ask('@alice can you look?',{mentions:[{kind:'HUMAN',name:'alice',humanId:'h1',start:0,end:6}]});
    await turn(toAlice);
    await tick();
    expect(await nudges()).toEqual([]);
  });

  it('leaves replied, stopped, failed and followed-up turns alone',async()=>{
    // A pass after each case, so the next question does not count as a follow-up.
    const replied=await ask('One');await turn(replied,{reply:'Here it is'});await tick();
    const stopped=await ask('Two');await turn(stopped,{cancelled:true});await tick();
    const failed=await ask('Three');await turn(failed,{failed:true});await tick();
    const followed=await ask('Four');await turn(followed);await ask('so?');
    await tick();
    expect(await nudges()).toEqual([]);
  });

  it("does not ask again after the nudge's own turn",async()=>{
    const question=await ask('What is on the board?');
    await turn(question,{tool:true});await tick();
    const [nudge]=await nudges();
    await turn(nudge!.id);await tick();
    expect(await nudges()).toHaveLength(1);
  });

  it('starts from the newest completion and leaves older turns alone',async()=>{
    product.store.close();
    const question=await ask('Old question');await turn(question);
    product=createApp({orgops:createOrgOpsClient('http://engine',async(url,init)=>engine.app.fetch(new Request(url,init))),dbPath:join(dir,'fresh.sqlite'),connections:null,compaction:{engineToken:'runner-secret'}});
    await tick();await tick();
    expect(await nudges()).toEqual([]);
  });
});
