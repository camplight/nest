import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
  afterEach(()=>{product.store.close();engine.db.close();rmSync(dir,{recursive:true,force:true});});
  async function dispatch(version=0){const r=await request(`${taskPath()}/dispatch`,{version});expect(r.status).toBe(200);return r.json();}
  async function response(text='Deliverable: https://example.com/pr/1',source='agent:Builder',channel=channelId){
    const r=await request('/api/events',{type:'message.created',source,channelId:channel,payload:{text}},{'content-type':'application/json','x-nest-runner-token':'runner-secret'});
    expect(r.status).toBe(201);return r.json();
  }
  async function submit(version:number,eventId:string){const r=await request(`${taskPath()}/deliverables`,{version,eventId});expect(r.status).toBe(200);return r.json();}
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
    expect((await request(`/api/projects/${projectId}`,undefined,otherHeaders)).status).toBe(404);
    expect((await request(`${taskPath()}/dispatch`,{version:0},otherHeaders)).status).toBe(404);
    expect((await request('/api/projects',{id:randomUUID(),name:'Forbidden',channelId},otherHeaders)).status).toBe(403);
  });
  it('hides projects whose engine conversation has been archived',async()=>{
    expect((await request(`/api/channels/${channelId}/archive`,{})).status).toBe(200);
    expect(await (await request('/api/projects')).json()).toEqual([]);
    expect((await request(`${taskPath()}/dispatch`,{version:0})).status).toBe(404);
  });
  it('rejects malformed input and reserves unknown product routes',async()=>{
    expect((await request('/api/projects',{name:'Missing identity'})).status).toBe(400);
    expect((await request('/api/projects/unrecognized/path')).status).toBe(404);
  });
});
