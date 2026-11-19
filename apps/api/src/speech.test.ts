import {beforeEach,afterEach,it,expect,vi} from 'vitest';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createApp as createEngine} from '../../../vendor/orgops/apps/api/src/app';
import {createOrgOpsClient} from '@nest/orgops-client';
import {createApp} from './app';
import type {SpeechProvider} from './fish-audio';
let engine:ReturnType<typeof createEngine>, product:ReturnType<typeof createApp>,dir:string;
let owner:Record<string,string>,other:Record<string,string>,channel:string,message:string;
const speech=vi.fn<SpeechProvider>();
const settings={enabled:true,voiceId:'fixture-voice',style:'calm',speed:1.25};
const call=(path:string,method='GET',body?:unknown,headers=owner)=>product.app.request(path,{method,headers,...(body===undefined?{}:{body:JSON.stringify(body)})});
async function emit(text:string,source='agent:Puff',type='message.created') {
  const r=await engine.app.request('/api/events',{method:'POST',headers:{'content-type':'application/json','x-orgops-runner-token':'runner'},body:JSON.stringify({type,source,channelId:channel,payload:{text}})});
  expect(r.status).toBe(201);return (await r.json()).id as string;
}
beforeEach(async()=>{
  dir=mkdtempSync(join(tmpdir(),'nest-speech-'));
  engine=createEngine({dbPath:join(dir,'engine.sqlite'),projectRoot:dir,dataDir:dir,adminUser:'owner',adminPass:'password',runnerToken:'runner'});
  speech.mockReset();speech.mockResolvedValue(new Uint8Array([1,2,3]));
  product=createApp({dbPath:join(dir,'product.sqlite'),connections:null,speech,orgops:createOrgOpsClient('http://engine',async(url,init)=>engine.app.fetch(new Request(url,init)))});
  const login=async(username:string)=>{
    const r=await call('/api/auth/login','POST',{username,password:'password'},{'content-type':'application/json'});
    return {'content-type':'application/json',cookie:r.headers.getSetCookie()[0].split(';')[0]};
  };
  owner=await login('owner');
  expect((await call('/api/humans/invite','POST',{username:'other',tempPassword:'password'})).ok).toBe(true);
  engine.db.prepare("UPDATE humans SET must_change_password=0 WHERE username='other'").run();
  other=await login('other');
  expect((await call('/api/agents','POST',{name:'Puff',modelId:'openrouter:test',workspacePath:join(dir,'Puff')})).status).toBe(201);
  const r=await call('/api/channels','POST',{name:'private-speech',visibility:'PRIVATE'});channel=(await r.json()).id;
  expect((await call('/api/channels/'+channel+'/subscribe','POST',{subscriberType:'AGENT',subscriberId:'Puff'})).ok).toBe(true);
  message=await emit('Hello **world**');
});
afterEach(()=>{product.store.close();engine.db.close();rmSync(dir,{recursive:true,force:true});});
it('defaults off; persists owner settings and uses saved text, not caller overrides',async()=>{
  expect((await (await call('/api/speech/agents/Puff')).json()).settings.enabled).toBe(false);
  expect((await call('/api/speech/messages/'+message,'POST')).status).toBe(409);
  expect((await call('/api/speech/agents/Puff','PUT',settings)).status).toBe(200);
  expect((await (await call('/api/speech/agents/Puff')).json()).settings).toEqual(settings);
  const r=await call('/api/speech/messages/'+message,'POST',{text:'Override',voiceId:'other'});
  expect(r.status).toBe(200);expect(r.headers.get('content-type')).toBe('audio/mpeg');expect(r.headers.get('cache-control')).toBe('no-store');
  expect(speech.mock.calls[0][0]).toBe('Hello world');expect(speech.mock.calls[0][1]).toEqual(settings);
});
it('rejects unauthenticated and non-owner settings and private-message listeners',async()=>{
  expect((await call('/api/speech/agents/Puff','PUT',settings,{})).status).toBe(401);
  expect((await call('/api/speech/agents/Puff','PUT',settings,other)).status).toBe(403);
  expect((await call('/api/speech/agents/Puff','PUT',settings,{'x-nest-runner-token':'runner'})).status).toBe(401);
  await call('/api/speech/agents/Puff','PUT',settings);
  expect((await call('/api/speech/messages/'+message,'POST',undefined,other)).status).toBe(404);
  expect(speech).not.toHaveBeenCalled();
  await call('/api/channels/'+channel+'/subscribe','POST',{subscriberType:'HUMAN',subscriberId:'other'});
  expect((await call('/api/speech/messages/'+message,'POST',undefined,other)).status).toBe(200);
});
it('validates settings and rejects non-message events and excessive text',async()=>{
  for(const bad of [{...settings,voiceId:''},{...settings,speed:5},{...settings,style:'unknown'},{...settings,apiKey:'not-accepted'}])expect((await call('/api/speech/agents/Puff','PUT',bad)).status).toBe(400);
  await call('/api/speech/agents/Puff','PUT',settings);
  expect((await call('/api/speech/messages/'+await emit('x'.repeat(5001)),'POST')).status).toBe(400);
  expect((await call('/api/speech/messages/'+await emit('','agent:Puff','agent.turn.started'),'POST')).status).toBe(400);
  expect(speech).not.toHaveBeenCalled();
});
it('sanitizes failures, releases in-flight slots and throttles repeated requests',async()=>{
  await call('/api/speech/agents/Puff','PUT',settings);
  speech.mockRejectedValueOnce(Error('private provider body'));
  const failed=await call('/api/speech/messages/'+message,'POST');expect(failed.status).toBe(502);expect(await failed.text()).not.toContain('private');
  for(let i=0;i<9;i++)expect((await call('/api/speech/messages/'+message,'POST')).status).toBe(200);
  expect((await call('/api/speech/messages/'+message,'POST')).status).toBe(429);
});
it('allows saving preferences without a provider and gives an actionable playback error',async()=>{
  const without=createApp({store:product.store,orgops:product.orgops,speech:null,connections:null});
  await call('/api/speech/agents/Puff','PUT',settings);
  expect((await without.app.request('/api/speech/messages/'+message,{method:'POST',headers:owner})).status).toBe(503);
});
