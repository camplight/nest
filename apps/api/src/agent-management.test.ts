import {afterEach,beforeEach,it,expect} from 'vitest';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApp as createEngine} from '../../../vendor/orgops/apps/api/src/app';
import {createOrgOpsClient} from '@nest/orgops-client';
import {createApp} from './app';
import type {AgentManagementConfig} from './agent-management';
import {createManagementCapability,verifyManagementCapability,managementEnvironment} from '../../../skills/nest-management/scripts/capability.mjs';
import {run} from '../../../skills/nest-management/scripts/manage.mjs';
let dir:string,engine:ReturnType<typeof createEngine>,product:ReturnType<typeof createApp>,client:ReturnType<typeof createOrgOpsClient>,config:AgentManagementConfig;
let headers:Record<string,string>,token:string,channelId:string,eventId:string,ownerId:string,lose=false,mutate:(()=>Promise<void>)|undefined;
const input={name:'EU Tenders',description:'Find relevant EU tender opportunities and rank eligibility.',systemInstructions:'Use official procurement sources. Check eligibility, deadlines and evidence before ranking opportunities. Do not submit bids or contact buyers without approval.'};
const call=(path:string,body?:unknown,h=headers)=>product.app.request(path,{headers:h,method:body===undefined?'GET':'POST',...(body===undefined?{}:{body:JSON.stringify(body)})});
const management=(body?:unknown,credential=token)=>call('/api/agent-management/'+(body===undefined?'context':'agents'),body,{'content-type':'application/json',authorization:'Bearer '+credential});
beforeEach(async()=>{
 dir=mkdtempSync(join(tmpdir(),'nest-management-'));
 lose=false;mutate=undefined;
 engine=createEngine({projectRoot:dir,dataDir:dir,dbPath:join(dir,'engine.sqlite'),adminUser:'owner',adminPass:'password',runnerToken:'runner-secret'});
 client=createOrgOpsClient('http://engine',async(url,init)=>{
  const path=new URL(String(url)).pathname;
  const response=await engine.app.fetch(new Request(url,init));
  if(path==='/api/agents'&&init?.method==='POST'&&lose){lose=false;throw Error('Response lost after commit');}
  if(path==='/api/agents/EU%20Tenders'&&init?.method!=='POST'&&mutate){const change=mutate;mutate=undefined;await change();}
  return response;
 });
 product=createApp({orgops:client,dbPath:join(dir,'product.sqlite')});
 const login=await call('/api/auth/login',{username:'owner',password:'password'},{'content-type':'application/json'});
 headers={'content-type':'application/json',cookie:login.headers.getSetCookie()[0].split(';')[0]};
 ownerId=(await (await call('/api/auth/me')).json()).id;
 await call('/api/models',{id:'default-model',provider:'openrouter',modelName:'fixture-multimodal',enabled:true});
 await call('/api/runners/register',{existingRunnerId:'fixture-runner',displayName:'Fixture'},{'content-type':'application/json','x-nest-runner-token':'runner-secret'});
 const manager=await call('/api/agents',{name:'NestSystem',modelId:'wrapped:none',workspacePath:join(dir,'manager'),assignedRunnerId:'fixture-runner',mode:'WRAPPED',desiredState:'STOPPED'});
 expect(manager.status).toBe(201);
 const managerId=(await manager.json()).id;
 channelId=(await (await call('/api/channels',{name:'manager-chat',visibility:'PRIVATE'})).json()).id;
 await call(`/api/channels/${channelId}/subscribe`,{subscriberType:'AGENT',subscriberId:'NestSystem'});
 eventId=(await (await call('/api/events',{type:'message.created',source:'human:owner',channelId,payload:{text:'@NestSystem Create me an agent for EU tenders',targetAgentName:'NestSystem'}})).json()).id;
 token=createManagementCapability({agentName:'NestSystem',channelId,triggerEventId:eventId},'runner-secret');
 config={agentName:'NestSystem',agentId:managerId,engineToken:'runner-secret',defaultModelId:'default-model',workspaceRoot:join(dir,'managed')};
 product.store.close();product=createApp({orgops:client,dbPath:join(dir,'product.sqlite'),agentManagement:config});
});
afterEach(()=>{product.store.close();engine.db.close();rmSync(dir,{recursive:true,force:true});});
it('creates through the authenticated helper with requester ownership and enforced defaults',async()=>{
 const env=managementEnvironment({ORGOPS_RUNNER_TOKEN:'runner-secret',ORGOPS_WRAPPED_AGENT_NAME:'NestSystem',ORGOPS_WRAPPED_CHANNEL_ID:channelId,ORGOPS_WRAPPED_TRIGGER_EVENT_ID:eventId,NEST_ADMIN_PASS:'must-not-reach-codex'});
 expect(Object.keys(env).sort()).toEqual(['NEST_MANAGEMENT_TOKEN','NEST_MANAGEMENT_URL']);
 expect(JSON.stringify(env)).not.toContain('runner-secret');
 expect(JSON.stringify(env)).not.toContain('must-not-reach-codex');
 const transport=async(url:URL,init:RequestInit)=>product.app.fetch(new Request(url,init));
 const context=await run(['context'],env,transport);
 expect(context).toMatchObject({requester:'owner',model:'openrouter:fixture-multimodal',operations:['agents:create']});
 expect(context).not.toHaveProperty('expiresAt');
 const created=await run(['create'],env,transport,()=>JSON.stringify(input));
 expect(created.agent.settingsUrl).toBe('/?view=agents&agent=EU%20Tenders');
 const agent=await (await call('/api/agents/EU%20Tenders')).json();
 expect(agent).toMatchObject({...input,ownerHumanId:ownerId,visibility:'PRIVATE',mode:'CLASSIC',modelId:'openrouter:fixture-multimodal',assignedRunnerId:'fixture-runner',allowOutsideWorkspace:false,allowOwnerHumanSecrets:false,enabledSkills:[],desiredState:'RUNNING'});
 expect(agent.workspacePath.startsWith(join(dir,'managed',ownerId))).toBe(true);
 const audit=product.store.db.prepare("SELECT actor_id,payload_json FROM product_audit WHERE type='audit.agent.management.created'").get() as any;
 expect(audit.actor_id).toBe(ownerId);expect(audit.payload_json).not.toContain(token);
});
it('keeps management access after session logout and API restart until revoked',async()=>{
 await product.app.request('/api/auth/logout',{method:'POST',headers});
 product.store.close();product=createApp({orgops:client,dbPath:join(dir,'product.sqlite'),agentManagement:config});
 expect((await management()).status).toBe(200);
 product.store.close();product=createApp({orgops:client,dbPath:join(dir,'product.sqlite')});
 expect((await management()).status).toBe(503);
 expect(verifyManagementCapability(token,'rotated-key','NestSystem')).toBeNull();
});
it('rejects absent, forged and other-agent capabilities and does not authorize ordinary engine APIs',async()=>{
 for(const bad of ['',token+'x',createManagementCapability({agentName:'OtherAgent',channelId,triggerEventId:eventId},'runner-secret')])expect((await management(undefined,bad)).status).toBe(401);
 expect((await call('/api/agents',undefined,{authorization:'Bearer '+token})).status).toBe(401);
 expect((await call('/api/agents',input,{authorization:'Bearer '+token,'content-type':'application/json'})).status).toBe(401);
 expect((await call('/api/agent-management/secrets',{}, {authorization:'Bearer '+token,'content-type':'application/json'})).status).toBe(404);
});
it.each(['ownerHumanId','mode','workspacePath','modelId','allowOutsideWorkspace','allowOwnerHumanSecrets','enabledSkills'])('rejects caller-supplied privilege field %s',async field=>{
 expect((await management({...input,[field]:'override'})).status).toBe(400);
 expect((await call('/api/agents/EU%20Tenders')).status).toBe(404);
});
it('requires the pinned manager identity and current participants',async()=>{
 config.agentId='replacement-manager';expect((await management(input)).status).toBe(403);
 config.agentId=(await (await call('/api/agents/NestSystem')).json()).id;
 await product.app.request(`/api/channels/${channelId}/unsubscribe`,{method:'POST',headers,body:JSON.stringify({subscriberType:'AGENT',subscriberId:'NestSystem'})});
 expect((await management(input)).status).toBe(403);
});
it('rejects non-human triggers, mismatched channels and targeting another agent',async()=>{
 for(const fields of [{source:'agent:NestSystem',targetAgentName:'NestSystem'},{source:'human:owner',targetAgentName:'AnotherAgent'}]){
  const r=await call('/api/events',{type:'message.created',source:fields.source,channelId,payload:{text:'Fixture',targetAgentName:fields.targetAgentName}},{'content-type':'application/json','x-nest-runner-token':'runner-secret'});
  const id=(await r.json()).id;
  const credential=createManagementCapability({agentName:'NestSystem',channelId,triggerEventId:id},'runner-secret');
  expect((await management(input,credential)).status).toBe(403);
 }
 const wrong=createManagementCapability({agentName:'NestSystem',channelId:'missing',triggerEventId:eventId},'runner-secret');
 expect((await management(input,wrong)).status).toBe(403);
});
it('recovers a committed creation after response loss, retries and API restart without duplicates',async()=>{
 lose=true;expect((await management(input)).status).toBe(200);
 product.store.close();product=createApp({orgops:client,dbPath:join(dir,'product.sqlite'),agentManagement:config});
 expect((await management(input)).status).toBe(200);
 expect((await management({...input,description:'Different instructions must not overwrite the first creation'})).status).toBe(409);
 const agents=await (await call('/api/agents')).json();expect(agents.filter((a:any)=>a.name===input.name)).toHaveLength(1);
});
it('rechecks membership after lookup before creating and fails closed for disabled models',async()=>{
 mutate=async()=>{await product.app.request(`/api/channels/${channelId}/unsubscribe`,{method:'POST',headers,body:JSON.stringify({subscriberType:'AGENT',subscriberId:'NestSystem'})});};
 expect((await management(input)).status).toBe(403);
 expect((await call('/api/agents/EU%20Tenders')).status).toBe(404);
});
it('rejects missing enabled default model without creating an agent',async()=>{
 config.defaultModelId='missing';expect((await management(input)).status).toBe(503);
});

it('fails closed for an offline assigned runner and preserves an existing unrelated agent',async()=>{
 const created=await call('/api/agents',{...input,modelId:'openrouter:fixture-multimodal',workspacePath:join(dir,'unrelated')});expect(created.status).toBe(201);
 expect((await management(input)).status).toBe(409);
 expect((await (await call('/api/agents/EU%20Tenders')).json()).workspacePath).toBe(join(dir,'unrelated'));
 await product.app.request('/api/agents/NestSystem',{method:'PATCH',headers,body:JSON.stringify({assignedRunnerId:'offline-runner'})});
 expect((await management()).status).toBe(503);
});
it('does not send credentials to unsafe origins or automatically retry failed helper requests',async()=>{
 for(const url of ['http://remote.example','https://user:pass@nest.example','https://nest.example/path'])await expect(run(['context'],{NEST_MANAGEMENT_TOKEN:token,NEST_MANAGEMENT_URL:url})).rejects.toThrow();
 let attempts=0;
 await expect(run(['create'],{NEST_MANAGEMENT_TOKEN:token},async()=>{attempts++;throw Error('Timeout');},()=>JSON.stringify(input))).rejects.toThrow('Timeout');
 expect(attempts).toBe(1);
});

it('serializes concurrent same-name creation and recovers without duplicates',async()=>{
 const results=await Promise.all([management(input),management(input)]);
 expect(results.some(result=>result.ok)).toBe(true);
 expect(results.every(result=>result.ok||result.status===409)).toBe(true);
 expect((await management(input)).status).toBe(200);
 const agents=await (await call('/api/agents')).json();expect(agents.filter((a:any)=>a.name===input.name)).toHaveLength(1);
});
