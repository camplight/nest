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
let headers:Record<string,string>,token:string,channelId:string,eventId:string,ownerId:string,lose=false,loseInvite=false,mutate:(()=>Promise<void>)|undefined;
const input={name:'EU Tenders',description:'Find relevant EU tender opportunities and rank eligibility.',systemInstructions:'Use official procurement sources. Check eligibility, deadlines and evidence before ranking opportunities. Do not submit bids or contact buyers without approval.'};
const call=(path:string,body?:unknown,h=headers)=>product.app.request(path,{headers:h,method:body===undefined?'GET':'POST',...(body===undefined?{}:{body:JSON.stringify(body)})});
const management=(body?:unknown,credential=token)=>call('/api/agent-management/'+(body===undefined?'context':'agents'),body,{'content-type':'application/json',authorization:'Bearer '+credential});
beforeEach(async()=>{
 dir=mkdtempSync(join(tmpdir(),'nest-management-'));
 lose=false;loseInvite=false;mutate=undefined;
 engine=createEngine({projectRoot:dir,dataDir:dir,dbPath:join(dir,'engine.sqlite'),adminUser:'owner',adminPass:'password',runnerToken:'runner-secret'});
 client=createOrgOpsClient('http://engine',async(url,init)=>{
  const path=new URL(String(url)).pathname;
  const response=await engine.app.fetch(new Request(url,init));
  if(path.endsWith('/subscribe')&&init?.method==='POST'&&loseInvite){loseInvite=false;throw Error('Lost subscription response');}
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
 expect(context).toMatchObject({requester:'owner',model:'openrouter:fixture-multimodal',operations:['agents:create','agents:get-owned','projects:members:list','projects:members:add']});
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

it('finds the requester’s existing private agent from a later retry without recreating or overwriting',async()=>{
 expect((await management(input)).status).toBe(201);
 const before=await (await call('/api/agents/EU%20Tenders')).json();
 const retryEvent=await (await call('/api/events',{type:'message.created',source:'human:owner',channelId,payload:{text:'@NestSystem can you retry',targetAgentName:'NestSystem'}})).json();
 const env=managementEnvironment({ORGOPS_RUNNER_TOKEN:'runner-secret',ORGOPS_WRAPPED_AGENT_NAME:'NestSystem',ORGOPS_WRAPPED_CHANNEL_ID:channelId,ORGOPS_WRAPPED_TRIGGER_EVENT_ID:retryEvent.id});
 const transport=async(url:URL,init:RequestInit)=>product.app.fetch(new Request(url,init));
 await expect(run(['create'],env,transport,()=>JSON.stringify(input))).rejects.toThrow('already exists; its settings were kept');
 const found=await run(['get',input.name],env,transport);
 expect(found).toEqual({existing:true,agent:{id:before.id,name:input.name,modelId:before.modelId,visibility:'PRIVATE',settingsUrl:'/?view=agents&agent=EU%20Tenders'}});
 const after=await (await call('/api/agents/EU%20Tenders')).json();
 expect(after).toEqual(before);
 const agents=await (await call('/api/agents')).json();expect(agents.filter((a:any)=>a.name===input.name)).toHaveLength(1);
 expect(product.store.db.prepare("SELECT COUNT(*) AS count FROM product_audit WHERE type='audit.agent.management.created'").get()).toMatchObject({count:1});
});

it('does not disclose another owner’s agent, a public agent or a missing name through lookup',async()=>{
 const invited=await call('/api/humans/invite',{username:'other'});expect(invited.ok).toBe(true);
 const other=(await (await call('/api/humans')).json()).find((human:any)=>human.username==='other');
 expect(other?.id).toBeTruthy();
 const created=await call('/api/agents',{...input,ownerHumanId:other.id,visibility:'PRIVATE',modelId:'openrouter:fixture-multimodal',workspacePath:join(dir,'other')});
 expect(created.status).toBe(201);
 const lookup=(name:string)=>call('/api/agent-management/agents/'+encodeURIComponent(name),undefined,{authorization:'Bearer '+token});
 const hidden=await lookup(input.name),missing=await lookup('Missing');
 expect(hidden.status).toBe(404);expect(missing.status).toBe(404);
 expect(await hidden.json()).toEqual(await missing.json());
 const publicAgent=await call('/api/agents',{...input,name:'Public helper',visibility:'PUBLIC',modelId:'openrouter:fixture-multimodal',workspacePath:join(dir,'public')});
 expect(publicAgent.status).toBe(201);
 expect((await lookup('Public helper')).status).toBe(404);
});

it('revalidates current membership for owner-scoped lookup and rejects forged lookup capabilities',async()=>{
 await management(input);
 const lookup=(credential=token)=>call('/api/agent-management/agents/EU%20Tenders',undefined,{authorization:'Bearer '+credential});
 expect((await lookup(token+'x')).status).toBe(401);
 mutate=async()=>{await call(`/api/channels/${channelId}/unsubscribe`,{subscriberType:'AGENT',subscriberId:'NestSystem'});};
 expect((await lookup()).status).toBe(403);
});

it('prints only known safe helper conflict reasons and never arbitrary response contents',async()=>{
 const env={NEST_MANAGEMENT_TOKEN:token};
 await expect(run(['get'],env)).rejects.toThrow('Use context');
 await expect(run(['get',input.name],env,async()=>Response.json({error:'private-credential-must-not-be-printed'},{status:403}))).rejects.toThrow(/^Nest management returned 403\. The lookup was denied or unavailable\.$/);
 await expect(run(['create'],env,async()=>Response.json({error:'Agent creation is in progress. Retry the same request.'},{status:409}),()=>JSON.stringify(input))).rejects.toThrow('creation is in progress');
});

async function teamProject(collaboration='team') {
 const result=await call('/api/projects',{id:crypto.randomUUID(),name:'Team invitations',channelId,collaboration});
 expect(result.status).toBe(201);return result.json();
}
const projectMembers=(body?:unknown,credential=token)=>call('/api/agent-management/project/members',body,{'content-type':'application/json',authorization:'Bearer '+credential});
it('invites exact people and agent identities through the helper into the owner’s current project and reconciles lost responses',async()=>{
 const project=await teamProject();
 await call('/api/humans/invite',{username:'Naska',tempPassword:'password'});
 await call('/api/agents',{name:'Naska',visibility:'PUBLIC',modelId:'default-model',workspacePath:join(dir,'naska')});
 const env={NEST_MANAGEMENT_TOKEN:token};const transport=async(url:URL,init:RequestInit)=>product.app.fetch(new Request(url,init));
 const roster=await run(['project-members'],env,transport);
 expect(roster.project).toMatchObject({id:project.id,name:'Team invitations'});
 expect(roster.availableMembers).toEqual(expect.arrayContaining([{subscriberType:'HUMAN',subscriberId:'Naska'},{subscriberType:'AGENT',subscriberId:'Naska'}]));
 for(const subscriberType of ['HUMAN','AGENT']){
  loseInvite=true;
  const invited=await run(['invite'],env,transport,()=>JSON.stringify({subscriberType,subscriberId:'Naska'}));
  expect(invited).toMatchObject({project:{id:project.id,url:`/?view=projects&project=${project.id}&tab=chat`},member:{subscriberType,subscriberId:'Naska'},alreadyMember:false});
  expect((await run(['invite'],env,transport,()=>JSON.stringify({subscriberType,subscriberId:'Naska'}))).alreadyMember).toBe(true);
 }
 const members=(await (await projectMembers()).json()).members;
 expect(members.filter((m:any)=>m.subscriberId==='Naska')).toHaveLength(2);
 const audit=product.store.db.prepare("SELECT actor_id,payload_json FROM product_audit WHERE type='audit.project.member.invited'").all() as any[];
 expect(audit).toHaveLength(2);expect(audit.every(row=>row.actor_id===ownerId&&!row.payload_json.includes(token))).toBe(true);
});
it('limits invitations to the requesting project and owner, rejecting arbitrary channel IDs, missing people and hidden agents',async()=>{
 await teamProject();
 await call('/api/humans/invite',{username:'other',tempPassword:'password'});
 const other=(await (await call('/api/humans')).json()).find((h:any)=>h.username==='other');
 await call('/api/agents',{name:'Hidden agent',visibility:'PRIVATE',ownerHumanId:other.id,modelId:'default-model',workspacePath:join(dir,'hidden')});
 const roster=await (await projectMembers()).json();
 expect(roster.availableMembers.some((m:any)=>m.subscriberId==='Hidden agent')).toBe(false);
 for(const member of [{subscriberType:'HUMAN',subscriberId:'missing'},{subscriberType:'AGENT',subscriberId:'Hidden agent'},{subscriberType:'HUMAN',subscriberId:'other',channelId:'somewhere-else'}])expect((await projectMembers(member)).status).toBe(400);
 expect((await projectMembers({subscriberType:'HUMAN',subscriberId:'other'},token+'x')).status).toBe(401);
 await call(`/api/channels/${channelId}/subscribe`,{subscriberType:'HUMAN',subscriberId:'other'});
 engine.db.prepare('UPDATE humans SET must_change_password=0 WHERE id=?').run(other.id);
 const event=await (await call('/api/events',{type:'message.created',source:'human:other',channelId,payload:{text:'Add someone',targetAgentName:'NestSystem'}},{'content-type':'application/json','x-nest-runner-token':'runner-secret'})).json();
 const nonOwner=createManagementCapability({agentName:'NestSystem',channelId,triggerEventId:event.id},'runner-secret');
 expect((await projectMembers(undefined,nonOwner)).status).toBe(403);
 expect((await projectMembers({subscriberType:'AGENT',subscriberId:'Hidden agent'},nonOwner)).status).toBe(403);
});
it('rejects legacy private projects and standalone chats without changing their membership',async()=>{
 expect((await projectMembers()).status).toBe(403);
 await teamProject('private');
 expect((await projectMembers({subscriberType:'HUMAN',subscriberId:'owner'})).status).toBe(403);
});
it('rechecks management membership after target lookup before inviting and does not depend on model availability',async()=>{
 await teamProject();await management(input);
 config.defaultModelId='missing';
 expect((await projectMembers()).status).toBe(200);
 mutate=async()=>{await call(`/api/channels/${channelId}/unsubscribe`,{subscriberType:'AGENT',subscriberId:'NestSystem'});};
 expect((await projectMembers({subscriberType:'AGENT',subscriberId:input.name})).status).toBe(403);
 const channel=(await (await call('/api/channels')).json()).find((ch:any)=>ch.id===channelId);
 expect(channel.participants.some((m:any)=>m.subscriberId===input.name)).toBe(false);
});

it('creates managed agents with the built-in GLM default without a registry preset',async()=>{
 config.defaultModelId='openrouter:z-ai/glm-5.3';
 expect((await management(input)).status).toBe(201);
 expect(await (await call('/api/agents/EU%20Tenders')).json()).toMatchObject({modelId:'openrouter:z-ai/glm-5.3'});
});
