import {afterEach,beforeEach,describe,expect,it} from 'vitest';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {createApp as createEngine} from '../../../vendor/orgops/apps/api/src/app';
import {createOrgOpsClient} from '@nest/orgops-client';
import {createApp} from './app';
const submission=(name='review-result',version='1.0.0',extra='')=>{
  const manifest={name,title:'Review Result',description:'Review supplied evidence against acceptance criteria.',version,category:'skill',license:'Proprietary',tags:['review','quality'],runtimes:['generic']};
  return {schemaVersion:1,manifest,files:[{path:'SKILL.md',encoding:'utf8',executable:false,content:`---\nname: ${name}\ndescription: ${manifest.description}\nlicense: Proprietary\n---\n\nRead the supplied criteria and provide evidence for each conclusion. ${extra}\n`}]};
};
describe('private tenant community',()=>{
  let dir:string,engine:ReturnType<typeof createEngine>,product:ReturnType<typeof createApp>,orgops:ReturnType<typeof createOrgOpsClient>,headers:Record<string,string>;
  const req=(path:string,body?:unknown,h=headers,method=body===undefined?'GET':'POST')=>product.app.request(path,{method,headers:h,...(body===undefined?{}:{body:JSON.stringify(body)})});
  beforeEach(async()=>{
    dir=mkdtempSync(join(tmpdir(),'nest-community-test-'));const prev=process.env.ORGOPS_PROJECT_ROOT;process.env.ORGOPS_PROJECT_ROOT=dir;
    engine=createEngine({dbPath:join(dir,'engine.sqlite'),dataDir:dir,adminUser:'owner',adminPass:'password',runnerToken:'runner-secret'});
    if(prev===undefined)delete process.env.ORGOPS_PROJECT_ROOT;else process.env.ORGOPS_PROJECT_ROOT=prev;
    orgops=createOrgOpsClient('http://engine',(async(url,init)=>engine.app.fetch(new Request(url,init))) as typeof fetch);
    product=createApp({orgops,dbPath:join(dir,'product.sqlite')});
    const login=await req('/api/auth/login',{username:'owner',password:'password'},{'content-type':'application/json'});
    headers={'content-type':'application/json',cookie:login.headers.get('set-cookie')!.split(';')[0]};
    expect((await req('/api/agents',{name:'Builder',modelId:'test',workspacePath:join(dir,'workspace')})).status).toBe(201);
  });
  afterEach(()=>{product.store.close();engine.db.close();rmSync(dir,{recursive:true,force:true});});
  async function otherHuman(){const owner=engine.db.prepare('SELECT * FROM humans LIMIT 1').get() as any;engine.db.prepare('INSERT INTO humans (id,username,password_hash,must_change_password,created_at,updated_at) VALUES (?,?,?,0,?,?)').run('other','other',owner.password_hash,owner.created_at+1,owner.created_at+1);const login=await req('/api/auth/login',{username:'other',password:'password'},{'content-type':'application/json'});return {'content-type':'application/json',cookie:login.headers.get('set-cookie')!.split(';')[0],'x-nest-runner-token':'runner-secret'};}
  async function issue(){const response=await req('/api/community/tokens',{agentName:'Builder'});expect(response.status).toBe(201);return response.json();}
  it('requires human sign-in or a tenant contribution token for every catalog read',async()=>{
    await req('/api/community/skills',submission());
    for(const path of ['/api/community/skills','/api/community/skills/review-result','/api/community/skills/review-result/download','/api/community/tokens']){
      expect((await req(path,undefined,{})).status).toBe(401);
      expect((await req(path,undefined,{'x-nest-runner-token':'runner-secret'})).status).toBe(401);
    }
    expect((await req('/api/community/skills',undefined,{authorization:'Bearer fake'})).status).toBe(401);
  });
  it('publishes and indexes immutable versions with idempotent retries and persistent history',async()=>{
    const body=submission();const response=await req('/api/community/skills',body);expect(response.status).toBe(201);const first=await response.json();expect(first.skill.author).toEqual({kind:'human',name:'owner'});
    expect((await req('/api/community/skills',body)).status).toBe(200);
    expect((await req('/api/community/skills',submission('review-result','1.0.0','changed'))).status).toBe(409);
    expect((await req('/api/community/skills',submission('review-result','1.0.10','New evidence requirements'))).status).toBe(201);
    expect((await req('/api/community/skills',submission('review-result','1.0.2'))).status).toBe(409);
    product.store.close();product=createApp({orgops,dbPath:join(dir,'product.sqlite')});
    const detail=await (await req('/api/community/skills/review-result')).json();expect(detail.skill.version).toBe('1.0.10');expect(detail.versions).toHaveLength(2);
    const old=await (await req('/api/community/skills/review-result?version=1.0.0')).json();expect(old.files[0].content).toBe(body.files[0].content);expect(old.skill.digest).toBe(first.skill.digest);
    expect(product.store.db.prepare("SELECT * FROM product_audit WHERE type='audit.community.published'").all()).toHaveLength(2);
    expect(engine.db.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'community_%'").all()).toEqual([]);
  });
  it('searches tags and paginates the private index without treating wildcard input as syntax',async()=>{
    for(const name of ['first','second','third'])expect((await req('/api/community/skills',submission(name))).status).toBe(201);
    const result=await (await req('/api/community/skills?q=quality&limit=2&offset=1')).json();expect(result.total).toBe(3);expect(result.skills).toHaveLength(2);
    expect((await (await req('/api/community/skills?q=%25')).json()).total).toBe(0);
    expect((await (await req('/api/community/skills?category=automation')).json()).total).toBe(0);
    expect((await req('/api/community/skills?limit=500')).status).toBe(400);
  });
  it('allows tenant members to reuse packages without overwriting another publisher',async()=>{
    await req('/api/community/skills',submission());const other=await otherHuman();
    const detail=await (await req('/api/community/skills/review-result',undefined,other)).json();expect(detail.skill.canPublish).toBe(false);
    expect((await req('/api/community/skills',submission('review-result','1.0.1'),other)).status).toBe(403);
    expect((await req('/api/community/skills',submission('other-skill'),other)).status).toBe(201);
    expect((await req('/api/community/tokens',{agentName:'Builder'},other)).status).toBe(403);
  });
  it('attributes agent publications to the authorized agent and limits tokens to community operations',async()=>{
    const issued=await issue();const agent={'content-type':'application/json',authorization:`Bearer ${issued.token}`};
    const response=await req('/api/community/skills',submission('agent-skill'),agent);expect(response.status).toBe(201);expect((await response.json()).skill.author).toEqual({kind:'agent',name:'Builder'});
    expect((await req('/api/community/tokens',{agentName:'Builder'},agent)).status).toBe(403);
    expect((await req('/api/projects',undefined,agent)).status).toBe(401);
    await req('/api/community/skills',submission('human-skill'));
    expect((await req('/api/community/skills',submission('human-skill','1.0.1'),agent)).status).toBe(403);
    expect((await req('/api/community/skills',submission('agent-skill','1.0.1'))).status).toBe(201);
    const stored=product.store.db.prepare('SELECT * FROM community_tokens').get() as any;expect(JSON.stringify(stored)).not.toContain(issued.token);expect(stored.token_hash).toHaveLength(64);
    const listing=await (await req('/api/community/tokens')).json();expect(JSON.stringify(listing)).not.toContain('token_hash');expect(JSON.stringify(listing)).not.toContain(issued.token);
    expect((await req(`/api/community/tokens/${issued.id}`,undefined,headers,'DELETE')).status).toBe(200);
    expect((await req('/api/community/skills',undefined,agent)).status).toBe(401);
  });
  it('rejects expired tokens and isolates another tenant database',async()=>{
    const issued=await issue();const agent={authorization:`Bearer ${issued.token}`};await req('/api/community/skills',submission());
    const tenant=createApp({orgops,dbPath:join(dir,'another-tenant.sqlite')});
    try{expect((await tenant.app.request('/api/community/skills',{headers:agent})).status).toBe(401);const result=await tenant.app.request('/api/community/skills',{headers});expect((await result.json()).total).toBe(0);}finally{tenant.store.close();}
    product.store.db.prepare('UPDATE community_tokens SET expires_at=0 WHERE id=?').run(issued.id);
    expect((await req('/api/community/skills',undefined,agent)).status).toBe(401);
  });
  it('rejects path traversal, file collisions, invalid instructions and oversized files',async()=>{
    for(const path of ['../escape','/absolute','scripts/../../secret','scripts/.env']){
      const body=submission();body.files.push({...body.files[0],path});expect((await req('/api/community/skills',body)).status).toBe(400);
    }
    const collision=submission();collision.files.push({...collision.files[0],path:'scripts/file'},{...collision.files[0],path:'scripts/file/nested'});expect((await req('/api/community/skills',collision)).status).toBe(400);
    const bad=submission();bad.files[0].content='No frontmatter';expect((await req('/api/community/skills',bad)).status).toBe(400);
    const oversized=submission();oversized.files[0].content='x'.repeat(70000);expect((await req('/api/community/skills',oversized)).status).toBe(400);
    expect((await (await req('/api/community/skills')).json()).total).toBe(0);
  });
  it('exports exact file hashes and never runs published scripts',async()=>{
    const body=submission();body.files.push({path:'scripts/test.sh',encoding:'utf8',executable:true,content:'#!/bin/sh\nexit 99\n'});
    expect((await req('/api/community/skills',body)).status).toBe(201);
    const response=await req('/api/community/skills/review-result/download?version=1.0.0');expect(response.headers.get('content-disposition')).toContain('attachment;');
    const bundle=await response.json();expect(bundle.manifest.version).toBe('1.0.0');expect(bundle.files).toHaveLength(2);
    for(const file of bundle.files)expect(file.sha256).toBe(createHash('sha256').update(file.content).digest('hex'));
    const metadata=bundle.files.map(({content,...file}:any)=>file);expect(bundle.digest).toBe(createHash('sha256').update(JSON.stringify({manifest:bundle.manifest,files:metadata})).digest('hex'));
  });
});
