import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp as createEngine } from '../../../vendor/orgops/apps/api/src/app';
import { createOrgOpsClient } from '@nest/orgops-client';
import { createApp } from './app';

describe('project workflow against the unchanged engine',()=>{
  let dir:string, engine:ReturnType<typeof createEngine>, product:ReturnType<typeof createApp>, client:ReturnType<typeof createOrgOpsClient>;
  let headers:Record<string,string>, channelId:string, projectId:string, taskId:string;
  let loseDispatchResponse=false;
  let loseChannelResponse=false;
  let loseSubscriptionResponse=false;
  const request=(path:string,body?:unknown,h=headers)=>product.app.request(path,{method:body===undefined?'GET':'POST',headers:h,...(body!==undefined?{body:JSON.stringify(body)}:{})});
  const taskPath=()=>`/api/projects/${projectId}/tasks/${taskId}`;
  beforeEach(async()=>{
    dir=mkdtempSync(join(tmpdir(),'nest-project-test-'));
    const previous=process.env.ORGOPS_PROJECT_ROOT;process.env.ORGOPS_PROJECT_ROOT=dir;
    engine=createEngine({dbPath:join(dir,'engine.sqlite'),dataDir:dir,adminUser:'owner',adminPass:'password',runnerToken:'runner-secret'});
    if(previous===undefined)delete process.env.ORGOPS_PROJECT_ROOT;else process.env.ORGOPS_PROJECT_ROOT=previous;
    client=createOrgOpsClient('http://engine',(async(url,init)=>{
      const response=await engine.app.fetch(new Request(url,init));
      if(loseDispatchResponse&&new URL(String(url)).pathname==='/api/events'&&init?.method==='POST'){loseDispatchResponse=false;throw new Error('Lost response after engine commit');}
      if(loseChannelResponse&&new URL(String(url)).pathname==='/api/channels'&&init?.method==='POST'){loseChannelResponse=false;throw new Error('Lost channel response');}
      if(loseSubscriptionResponse&&new URL(String(url)).pathname.endsWith('/subscribe')&&init?.method==='POST'){loseSubscriptionResponse=false;throw new Error('Lost subscription response');}
      return response;
    }) as typeof fetch);
    product=createApp({orgops:client,dbPath:join(dir,'product.sqlite')});
    const login=await request('/api/auth/login',{username:'owner',password:'password'},{'content-type':'application/json'});
    headers={'content-type':'application/json',cookie:login.headers.get('set-cookie')!.split(';')[0]};
    const channel=await request('/api/channels',{name:'Project room',visibility:'PRIVATE'});channelId=(await channel.json()).id;
    expect((await request('/api/agents',{name:'Builder',modelId:'test',workspacePath:join(dir,'workspace')})).status).toBe(201);
    projectId=randomUUID();taskId=randomUUID();
    expect((await request('/api/projects',{id:projectId,name:'Launch',description:'Ship a useful result',channelId})).status).toBe(201);
    expect((await request(`/api/projects/${projectId}/tasks`,{id:taskId,title:'Build page',instructions:'Produce an accessible page',acceptanceCriteria:'Keyboard accessible; tests pass',agentName:'Builder'})).status).toBe(201);
  });
  afterEach(()=>{vi.unstubAllEnvs();product.store.close();engine.db.close();rmSync(dir,{recursive:true,force:true});});
  async function dispatch(version=0){const r=await request(`${taskPath()}/dispatch`,{version});expect(r.status).toBe(200);return r.json();}
  async function response(text='Deliverable: https://example.com/pr/1',source='agent:Builder',channel=channelId){
    const r=await request('/api/events',{type:'message.created',source,channelId:channel,payload:{text}},{'content-type':'application/json','x-nest-runner-token':'runner-secret'});
    expect(r.status).toBe(201);return r.json();
  }
  async function submit(version:number,eventId:string){const r=await request(`${taskPath()}/deliverables`,{version,eventId});expect(r.status).toBe(200);return r.json();}
  it('summarizes approved work and pending reviews without exposing deliverable text',async()=>{
    let summary=await (await request('/api/projects/dashboard')).json();
    expect(summary.tasks).toEqual({total:1,finished:0,needsReview:0,changesRequested:0});
    expect(summary.projects[0]).toMatchObject({totalTasks:1,finishedTasks:0,assignedAgents:1});
    const task=await dispatch();const event=await response('Private deliverable text');const pending=await submit(task.version,event.id);
    summary=await (await request('/api/projects/dashboard')).json();
    expect(summary.tasks.needsReview).toBe(1);
    expect(summary.reviews).toEqual([{id:taskId,projectId,title:'Build page',agentName:'Builder',updatedAt:pending.updatedAt,status:'needs_review'}]);
    expect(JSON.stringify(summary)).not.toContain('Private deliverable text');
    await request(`${taskPath()}/reviews`,{version:pending.version,decision:'approve'});
    summary=await (await request('/api/projects/dashboard')).json();
    expect(summary.tasks).toEqual({total:1,finished:1,needsReview:0,changesRequested:0});
    expect(summary.reviews).toEqual([]);
  });
  it('distinguishes changes requested from operational incidents',async()=>{
    const task=await dispatch();const event=await response();const pending=await submit(task.version,event.id);
    await request(`${taskPath()}/reviews`,{version:pending.version,decision:'request_changes',feedback:'Needs keyboard access'});
    const summary=await (await request('/api/projects/dashboard')).json();
    expect(summary.tasks.changesRequested).toBe(1);expect(summary.changes[0]).toMatchObject({id:taskId,status:'changes_requested'});
    expect(summary).not.toHaveProperty('issues');
  });
  it('suggests only the pinned, currently owned personal agent and validates invitations against engine membership',async()=>{
    const human=await (await request('/api/auth/me')).json();
    await product.app.request('/api/agents/Builder',{method:'PATCH',headers,body:JSON.stringify({visibility:'PRIVATE'})});
    const agent=await (await request('/api/agents/Builder')).json();
    product.store.db.prepare('INSERT INTO product_personal_agents(owner_id,id,name,character,brief,model_id,runner_id,workspace_path,agent_id,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)').run(human.id,randomUUID(),'Builder','puff','','test','runner',join(dir,'workspace'),agent.id,Date.now());
    expect((await (await request('/api/projects/members')).json()).personalAgent).toMatchObject({subscriberType:'AGENT',subscriberId:'Builder'});
    product.store.db.prepare('UPDATE product_personal_agents SET agent_id=?').run(randomUUID());
    expect((await (await request('/api/projects/members')).json()).personalAgent).toBeNull();
    loseSubscriptionResponse=true;
    expect((await request(`/api/projects/${projectId}/members`,{subscriberType:'AGENT',subscriberId:'Builder'})).status).toBe(200);
    expect((await request(`/api/projects/${projectId}/members`,{subscriberType:'AGENT',subscriberId:'Builder'})).status).toBe(200);
    const channels=await (await request('/api/channels')).json();
    expect(channels.find((c:any)=>c.id===channelId).participants.filter((m:any)=>m.subscriberId==='Builder')).toHaveLength(1);
    expect((await request(`/api/projects/${projectId}/members`,{subscriberType:'AGENT',subscriberId:'Missing'})).status).toBe(400);
    expect((await request(`/api/projects/${projectId}/members`,{subscriberType:'AGENT',subscriberId:'Builder',channelId:'override'})).status).toBe(400);
    expect((await request(`/api/projects/${randomUUID()}/members`,{subscriberType:'AGENT',subscriberId:'Builder'})).status).toBe(404);
  });
  it('creates a private project chat once, including concurrent retries',async()=>{
    const body={id:randomUUID(),name:'Automatic project',description:'One workspace'};
    const results=await Promise.all([request('/api/projects',body),request('/api/projects',body)]);
    expect(results.some(r=>r.status===201)).toBe(true);
    expect(results.every(r=>[200,201,409].includes(r.status))).toBe(true);
    const project=await (await request('/api/projects',body)).json();
    const channels=await (await request('/api/channels')).json();
    const chats=channels.filter((c:any)=>c.id===project.channelId);
    expect(chats).toHaveLength(1);
    expect(chats[0]).toMatchObject({id:project.channelId,visibility:'PRIVATE',canManage:true});
    expect(chats[0].participants).toContainEqual({subscriberType:'HUMAN',subscriberId:'owner'});
    expect((await request('/api/projects',{...body,name:'Changed'})).status).toBe(409);
  });
  it('isolates project titles from globally unique engine chat names',async()=>{
    expect((await request('/api/channels',{name:'after-the-last-engineer',visibility:'PUBLIC'})).status).toBe(201);
    const ids:string[]=[];
    for(let i=0;i<2;i++) {
      const body={id:randomUUID(),name:'after-the-last-engineer'};
      const created=await request('/api/projects',body);
      expect(created.status).toBe(201);
      const project=await created.json();ids.push(project.channelId);
      expect(project.name).toBe(body.name);
      expect((await request('/api/projects',body)).status).toBe(200);
    }
    expect(new Set(ids).size).toBe(2);
    const channels=await(await request('/api/channels')).json();
    for(const id of ids) expect(channels.find((c:any)=>c.id===id)).toMatchObject({visibility:'PRIVATE',canManage:true});
    expect(channels.filter((c:any)=>c.name==='after-the-last-engineer')).toHaveLength(1);
  });
  it('creates the selected team, distinguishes people and agents with the same name, and preserves completed membership changes',async()=>{
    expect((await request('/api/humans/invite',{username:'Builder',tempPassword:'password'})).status).toBe(201);
    const agent={subscriberType:'AGENT',subscriberId:'Builder'},person={subscriberType:'HUMAN',subscriberId:'Builder'};
    const body={id:randomUUID(),name:'A team project',collaboration:'team',members:[person,agent,agent,{subscriberType:'HUMAN',subscriberId:'owner'}]};
    const created=await request('/api/projects',body);expect(created.status).toBe(201);
    const project=await created.json();expect(project).not.toHaveProperty('members');
    const channel=(await (await request('/api/channels')).json()).find((channel:any)=>channel.id===project.channelId);
    expect(channel.participants).toEqual(expect.arrayContaining([agent,person,{subscriberType:'HUMAN',subscriberId:'owner'}]));
    expect(channel.participants).toHaveLength(3);
    engine.db.prepare("UPDATE humans SET must_change_password=0 WHERE username='Builder'").run();
    const login=await request('/api/auth/login',{username:'Builder',password:'password'});
    const invitedHeaders={'content-type':'application/json',cookie:login.headers.get('set-cookie')!.split(';')[0]};
    const invitedChannels=await (await request('/api/channels',undefined,invitedHeaders)).json();
    expect(invitedChannels.find((item:any)=>item.id===channel.id)).toMatchObject({canPost:true,canManage:false});
    expect((await (await request('/api/projects',undefined,invitedHeaders)).json()).map((item:any)=>item.id)).toEqual([project.id]);
    expect((await request(`/api/projects/${project.id}`,undefined,invitedHeaders)).status).toBe(200);
    expect((await product.app.request(`/api/projects/${project.id}`,{method:'PATCH',headers:invitedHeaders,body:JSON.stringify({name:'Not mine',description:'',expected:{name:project.name,description:project.description}})})).status).toBe(404);
    expect((await request(`/api/projects/${projectId}`,undefined,invitedHeaders)).status).toBe(404);
    expect((await (await request('/api/projects/dashboard',undefined,invitedHeaders)).json()).projects.map((item:any)=>item.project.id)).toEqual([project.id]);
    await request(`/api/channels/${channel.id}/unsubscribe`,person);
    expect((await request(`/api/channels/${channel.id}/share`,{viewerType:'HUMAN',viewerId:'Builder'})).ok).toBe(true);
    expect((await (await request('/api/channels',undefined,invitedHeaders)).json()).some((item:any)=>item.id===channel.id)).toBe(true);
    expect((await request(`/api/projects/${project.id}`,undefined,invitedHeaders)).status).toBe(404);
    expect((await (await request('/api/projects/dashboard',undefined,invitedHeaders)).json()).projects).toEqual([]);
    await request(`/api/channels/${channel.id}/subscribe`,person);
    expect((await request('/api/projects',{...body,members:[agent,person]})).status).toBe(200);
    expect((await request('/api/projects',{...body,members:[]})).status).toBe(409);
    await request(`/api/channels/${channel.id}/unsubscribe`,agent);
    expect((await request('/api/projects',body)).status).toBe(200);
    const after=(await (await request('/api/channels')).json()).find((item:any)=>item.id===channel.id);
    expect(after.participants).not.toContainEqual(agent);
  });
  it('finishes partially applied invitations after a lost response and product restart without duplicates',async()=>{
    await request('/api/humans/invite',{username:'teammate',tempPassword:'password'});
    const body={id:randomUUID(),name:'Recovered team',members:[{subscriberType:'AGENT',subscriberId:'Builder'},{subscriberType:'HUMAN',subscriberId:'teammate'}]};
    loseSubscriptionResponse=true;
    expect((await request('/api/projects',body)).status).toBe(502);
    expect(product.store.projects.project(body.id)).toBeUndefined();
    product.store.close();product=createApp({orgops:client,dbPath:join(dir,'product.sqlite')});
    expect((await request('/api/projects',body)).status).toBe(201);
    expect((await request('/api/projects',body)).status).toBe(200);
    const project=product.store.projects.project(body.id)!;
    const channels=await (await request('/api/channels')).json();
    expect(channels.filter((channel:any)=>channel.metadata?.nestProjectChat)).toHaveLength(1);
    const channel=channels.find((channel:any)=>channel.id===project.channelId);
    expect(channel.participants).toHaveLength(3);
    expect(channel.participants).toEqual(expect.arrayContaining(body.members));
  });
  it('filters the picker and rejects unavailable or other-owner private agents before creating a conversation',async()=>{
    const other=await (await request('/api/humans/invite',{username:'other',tempPassword:'password'})).json();
    const privateAgent=await request('/api/agents',{name:'Private teammate',visibility:'PRIVATE',ownerHumanId:other.id,modelId:'test',workspacePath:join(dir,'private-other')});
    expect(privateAgent.status).toBe(201);
    const options=await (await request('/api/projects/members')).json();
    expect(options.members).toContainEqual({subscriberType:'HUMAN',subscriberId:'other'});
    expect(options.members.some((member:any)=>member.subscriberId==='Builder'&&member.subscriberType==='AGENT')).toBe(true);
    expect(options.members.some((member:any)=>member.subscriberId==='Private teammate'||member.subscriberId==='owner')).toBe(false);
    const before=await (await request('/api/channels')).json();
    for(const member of [{subscriberType:'AGENT',subscriberId:'Private teammate'},{subscriberType:'HUMAN',subscriberId:'missing'}]){
      const created=await request('/api/projects',{id:randomUUID(),name:'Rejected',members:[member]});expect(created.status).toBe(400);
      expect(await created.json()).toMatchObject({canEdit:true});
    }
    expect(await (await request('/api/channels')).json()).toEqual(before);
    expect((await request('/api/projects/members',undefined,{})).status).toBe(401);
    expect((await request('/api/projects/members',undefined,{'x-nest-runner-token':'runner-secret'})).status).toBe(401);
  });
  it('recovers chat creation after a lost engine response and product restart',async()=>{
    const body={id:randomUUID(),name:'Recovered chat'};
    loseChannelResponse=true;
    expect((await request('/api/projects',body)).status).toBe(502);
    product.store.close();product=createApp({orgops:client,dbPath:join(dir,'product.sqlite')});
    expect((await request('/api/projects',body)).status).toBe(201);
    expect((await request('/api/projects',body)).status).toBe(200);
    const channels=await (await request('/api/channels')).json();
    expect(channels.filter((c:any)=>c.metadata?.nestProjectChat)).toHaveLength(1);
  });
  it('dispatches a targeted brief, snapshots a real agent deliverable and requires human approval',async()=>{
    const task=await dispatch();expect(task).toMatchObject({status:'working',attempt:1,version:1});
    const brief=await (await request(`/api/events/${task.dispatchEventId}`)).json();
    expect(brief.source).toBe('human:owner');expect(brief.payload).toMatchObject({targetAgentName:'Builder',nestTaskId:taskId});
    expect(brief.payload.text).toContain('Keyboard accessible');
    expect(engine.db.prepare('SELECT * FROM event_receipts WHERE event_id=? AND agent_name=?').get(brief.id,'Builder')).toBeTruthy();
    const result=await response();
    expect(product.store.projects.task(taskId)?.status).toBe('working');
    const candidates=await (await request(`${taskPath()}/responses`)).json();expect(candidates.map((e:any)=>e.id)).toContain(result.id);
    const pending=await submit(task.version,result.id);expect(pending.status).toBe('needs_review');
    const approved=await request(`${taskPath()}/reviews`,{version:pending.version,decision:'approve',feedback:'Meets criteria'});expect(approved.status).toBe(200);
    expect((await approved.json()).status).toBe('done');
    const detail=await (await request(`/api/projects/${projectId}`)).json();expect(detail.deliverables[0].text).toContain('https://example.com/pr/1');expect(detail.reviews[0].decision).toBe('approve');
    expect(engine.db.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'product_%'").all()).toEqual([]);
  });
  it('rejects a conflicting pre-existing dispatch key instead of claiming the brief was sent',async()=>{
    await request('/api/events',{type:'message.created',source:'human:owner',channelId,idempotencyKey:`nest:task:${taskId}:attempt:1`,payload:{text:'Unrelated message'}});
    expect((await request(`${taskPath()}/dispatch`,{version:0})).status).toBe(409);
    expect(product.store.projects.task(taskId)?.status).toBe('queued');
  });
  it('keeps the submitted snapshot after conversation messages are cleared',async()=>{
    const task=await dispatch();const original=await response('Original deliverable');await submit(task.version,original.id);
    const edited=await product.app.request(`/api/channels/${channelId}/messages`,{method:'DELETE',headers});
    expect(edited.status).toBe(200);
    product.store.close();product=createApp({orgops:client,dbPath:join(dir,'product.sqlite')});
    const detail=await (await request(`/api/projects/${projectId}`)).json();
    expect(detail.deliverables[0].text).toBe('Original deliverable');
    expect(detail.tasks[0].status).toBe('needs_review');
  });
  it('retains requested changes, dispatches a new attempt and rejects an older response',async()=>{
    const task=await dispatch();const original=await response('First attempt');const pending=await submit(task.version,original.id);
    expect((await request(`${taskPath()}/reviews`,{version:pending.version,decision:'request_changes',feedback:''})).status).toBe(400);
    const changed=await (await request(`${taskPath()}/reviews`,{version:pending.version,decision:'request_changes',feedback:'Add keyboard focus styles'})).json();
    expect(changed).toMatchObject({status:'changes_requested',attempt:2,version:3});
    const revision=await dispatch(changed.version);const brief=await (await request(`/api/events/${revision.dispatchEventId}`)).json();expect(brief.payload.text).toContain('Add keyboard focus styles');
    expect((await request(`${taskPath()}/deliverables`,{version:revision.version,eventId:original.id})).status).toBe(400);
    const next=await response('Second attempt, corrected');const submitted=await submit(revision.version,next.id);
    expect((await request(`${taskPath()}/reviews`,{version:submitted.version,decision:'approve'})).status).toBe(200);
    const detail=await (await request(`/api/projects/${projectId}`)).json();expect(detail.deliverables).toHaveLength(2);expect(detail.reviews).toHaveLength(2);
  });
  it('recovers an ambiguous dispatch after restart without posting a second brief',async()=>{
    loseDispatchResponse=true;expect((await request(`${taskPath()}/dispatch`,{version:0})).status).toBe(502);
    expect(product.store.projects.task(taskId)?.status).toBe('queued');
    const earlyResult=await response('Completed before retry');
    product.store.close();product=createApp({orgops:client,dbPath:join(dir,'product.sqlite')});
    await dispatch();
    expect((await (await request(`${taskPath()}/responses`)).json()).map((e:any)=>e.id)).toContain(earlyResult.id);
    expect(engine.db.prepare('SELECT id FROM events WHERE idempotency_key=?').all(`nest:task:${taskId}:attempt:1`)).toHaveLength(1);
    expect((await request(`${taskPath()}/dispatch`,{version:0})).status).toBe(409);
  });
  it('makes creation retryable and rejects reused IDs with different content',async()=>{
    expect((await request('/api/projects',{id:projectId,name:'Launch',description:'Ship a useful result',channelId})).status).toBe(200);
    expect((await request('/api/projects',{id:projectId,name:'Different',channelId})).status).toBe(409);
    expect((await request(`/api/projects/${projectId}/tasks`,{id:taskId,title:'Build page',instructions:'Produce an accessible page',acceptanceCriteria:'Keyboard accessible; tests pass',agentName:'Builder'})).status).toBe(200);
  });
  it('rejects stale or repeated reviews without duplicate decisions',async()=>{
    const task=await dispatch();const result=await response();const pending=await submit(task.version,result.id);
    const decisions=await Promise.all(['approve','request_changes'].map(decision=>request(`${taskPath()}/reviews`,{version:pending.version,decision,feedback:'Review feedback'})));
    expect(decisions.map(r=>r.status).sort()).toEqual([200,409]);expect(product.store.projects.detail(product.store.projects.project(projectId)!).reviews).toHaveLength(1);
  });
  it('does not accept human messages, another agent or another channel as the deliverable',async()=>{
    const task=await dispatch();
    for(const source of ['human:owner','agent:SomeoneElse']){const event=await response('Unrelated',source);expect((await request(`${taskPath()}/deliverables`,{version:task.version,eventId:event.id})).status).toBe(400);}
    const other=await (await request('/api/channels',{name:'Other',visibility:'PRIVATE'})).json();const event=await response('Other channel','agent:Builder',other.id);
    expect((await request(`${taskPath()}/deliverables`,{version:task.version,eventId:event.id})).status).toBe(400);
    expect((await request(`${taskPath()}/reviews`,{version:task.version,decision:'approve'})).status).toBe(409);
  });
  it('denies runner/anonymous project access and does not elevate another human with runner headers',async()=>{
    expect((await request('/api/projects',undefined,{})).status).toBe(401);
    expect((await request('/api/projects',undefined,{'x-nest-runner-token':'runner-secret'})).status).toBe(401);
    const owner=engine.db.prepare('SELECT * FROM humans LIMIT 1').get() as any;
    engine.db.prepare('INSERT INTO humans (id,username,password_hash,must_change_password,created_at,updated_at) VALUES (?,?,?,0,?,?)').run('other','other',owner.password_hash,owner.created_at+1,owner.created_at+1);
    const login=await request('/api/auth/login',{username:'other',password:'password'});
    const otherHeaders={'content-type':'application/json',cookie:login.headers.get('set-cookie')!.split(';')[0],'x-nest-runner-token':'runner-secret'};
    expect(await (await request('/api/projects',undefined,otherHeaders)).json()).toEqual([]);
    const overview=await (await request('/api/projects/dashboard',undefined,otherHeaders)).json();
    expect(overview.projects).toEqual([]);expect(overview.tasks.total).toBe(0);
    expect((await request('/api/projects/dashboard',undefined,{})).status).toBe(401);
    expect((await request('/api/projects/dashboard',undefined,{'x-nest-runner-token':'runner-secret'})).status).toBe(401);
    expect((await request(`/api/projects/${projectId}`,undefined,otherHeaders)).status).toBe(404);
    expect((await request(`${taskPath()}/dispatch`,{version:0},otherHeaders)).status).toBe(404);
    expect((await request('/api/projects',{id:randomUUID(),name:'Forbidden',channelId},otherHeaders)).status).toBe(403);
  });
  it('hides projects whose engine conversation has been archived',async()=>{
    expect((await request(`/api/channels/${channelId}/archive`,{})).status).toBe(200);
    const overview=await (await request('/api/projects/dashboard')).json();
    expect(overview.projects).toEqual([]);expect(overview.reviews).toEqual([]);expect(overview.tasks.total).toBe(0);
    expect(await (await request('/api/projects')).json()).toEqual([]);
    expect((await request(`${taskPath()}/dispatch`,{version:0})).status).toBe(404);
  });
  it('rejects malformed input and reserves unknown product routes',async()=>{
    expect((await request('/api/projects',{name:'Missing identity'})).status).toBe(400);
    expect((await request('/api/projects/unrecognized/path')).status).toBe(404);
  });
  it('lets the owner edit product metadata without changing the engine channel or task history and rejects stale edits',async()=>{
    const patch=(body:unknown,h=headers)=>product.app.request(`/api/projects/${projectId}`,{method:'PATCH',headers:h,body:JSON.stringify(body)});
    const expected={name:'Launch',description:'Ship a useful result'};
    const body={name:'Autumn launch',description:'New project brief',expected};
    expect((await patch({...body,ownerId:'someone'})).status).toBe(400);
    expect((await patch(body,{'content-type':'application/json','x-nest-runner-token':'runner-secret'})).status).toBe(401);
    const results=await Promise.all([patch(body),patch({...body,name:'Other edit'})]);
    expect(results.map(r=>r.status).sort()).toEqual([200,409]);
    const edited=await product.store.projects.project(projectId)!;
    expect(edited.channelId).toBe(channelId);expect(product.store.projects.tasks(projectId)).toHaveLength(1);
    expect((await (await request('/api/channels')).json()).find((ch:any)=>ch.id===channelId).name).toBe('Project room');
    expect((await patch(body)).status).toBe(409);
    expect(product.store.db.prepare("SELECT actor_id FROM product_audit WHERE type='audit.project.updated'").all()).toEqual([{actor_id:edited.ownerId}]);
  });

  it('recovers the original creation intent after metadata edits without applying old names again',async()=>{
    const body={id:randomUUID(),name:'First message title',description:'First message brief',collaboration:'team'};
    expect((await request('/api/projects',body)).status).toBe(201);
    const edit=await product.app.request(`/api/projects/${body.id}`,{method:'PATCH',headers,body:JSON.stringify({name:'Edited title',description:'Edited brief',expected:{name:body.name,description:body.description}})});
    expect(edit.status).toBe(200);
    const retried=await request('/api/projects',body);expect(retried.status).toBe(200);
    expect(await retried.json()).toMatchObject({name:'Edited title',description:'Edited brief'});
    expect((await request('/api/projects',{...body,name:'Edited title'})).status).toBe(409);
  });

  async function namingSetup(namer:import('./project-naming').ProjectNamer) {
    await request('/api/models',{id:'naming-model',provider:'openrouter',modelName:'fixture',enabled:true});
    product.store.close();product=createApp({orgops:client,dbPath:join(dir,'product.sqlite'),projectNamingModelId:'naming-model',projectNamer:namer});
    const messageRequestId=randomUUID();
    expect((await request('/api/messages',{id:messageRequestId,channelId,text:'Plan an autumn website launch with a clear owner review.'})).status).toBe(201);
    return {messageRequestId,expected:{name:'Launch',description:'Ship a useful result'}};
  }
  it('generates AI metadata only from a confirmed owner message and applies it once',async()=>{
    const namer=vi.fn(async()=>({name:'Autumn website launch',description:'Goal: launch the updated website. Outcome: owner-reviewed release. Open question: target date.'}));
    const body=await namingSetup(namer);
    const path=`/api/projects/${projectId}/suggest-details`;
    expect((await request(path,{...body,messageRequestId:randomUUID()})).status).toBe(400);
    const result=await request(path,body);expect(await result.json()).toEqual({status:'named'});
    expect(namer).toHaveBeenCalledWith(expect.objectContaining({model:'openrouter:fixture',text:'Plan an autumn website launch with a clear owner review.'}));
    expect(product.store.projects.project(projectId)?.name).toBe('Autumn website launch');
    expect(await (await request(path,body)).json()).toEqual({status:'kept'});expect(namer).toHaveBeenCalledTimes(1);
    expect((await request(path,body,{'content-type':'application/json','x-nest-runner-token':'runner-secret'})).status).toBe(401);
  });
  it('keeps manual settings ahead of an in-flight AI result, including a same-value manual save',async()=>{
    let started!:()=>void,release!:(value:{name:string;description:string})=>void;
    const begun=new Promise<void>(resolve=>{started=resolve;});
    const result=new Promise<{name:string;description:string}>(resolve=>{release=resolve;});
    const body=await namingSetup(async()=>{started();return result;});
    const pending=request(`/api/projects/${projectId}/suggest-details`,body);await begun;
    expect(await (await request(`/api/projects/${projectId}/suggest-details`,body)).json()).toEqual({status:'pending'});
    expect((await product.app.request(`/api/projects/${projectId}`,{method:'PATCH',headers,body:JSON.stringify({...body.expected,expected:body.expected})})).status).toBe(200);
    release({name:'AI must not overwrite',description:'Generated after the owner saved'});
    expect(await (await pending).json()).toEqual({status:'kept'});
    expect(product.store.projects.project(projectId)?.name).toBe('Launch');
  });
  it('keeps chat and fallback metadata usable on a provider failure without exposing diagnostics',async()=>{
    const body=await namingSetup(async()=>{throw Error('fixture-secret-must-not-be-returned');});
    const response=await request(`/api/projects/${projectId}/suggest-details`,body);
    expect(await response.json()).toEqual({status:'unavailable'});
    expect(product.store.projects.project(projectId)?.name).toBe('Launch');
    expect((await request(`/api/projects/${projectId}`)).status).toBe(200);
  });
  it('resolves only the required provider key from the configured system agent over engine HTTP',async()=>{
    vi.stubEnv('ORGOPS_MASTER_KEY',Buffer.alloc(32,7).toString('base64'));vi.stubEnv('OPENROUTER_API_KEY','');
    await request('/api/secrets',{name:'OPENROUTER_API_KEY',value:'fixture-provider-key',scopeType:'public'});
    await request('/api/secrets',{name:'UNRELATED_SECRET',value:'must-not-reach-model',scopeType:'public'});
    const agent=await (await request('/api/agents/Builder')).json();
    const env=await client.projectNamingEnv({token:'runner-secret',agentName:'Builder',agentId:agent.id,model:'openrouter:fixture'});
    expect(env.OPENROUTER_API_KEY).toBe('fixture-provider-key');expect(env).not.toHaveProperty('UNRELATED_SECRET');
    await expect(client.projectNamingEnv({token:'runner-secret',agentName:'Builder',agentId:'wrong',model:'openrouter:fixture'})).rejects.toThrow('unavailable');
    await product.app.request('/api/agents/Builder',{method:'PATCH',headers,body:JSON.stringify({visibility:'PRIVATE',ownerHumanId:(await (await request('/api/auth/me')).json()).id,allowOwnerHumanSecrets:true})});
    await expect(client.projectNamingEnv({token:'runner-secret',agentName:'Builder',model:'openrouter:fixture'})).rejects.toThrow('unavailable');
  });

});
