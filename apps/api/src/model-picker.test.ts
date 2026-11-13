import {beforeEach,afterEach,it,expect,vi} from 'vitest';
import {Hono} from 'hono';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApp as createEngine} from '../../../vendor/orgops/apps/api/src/app';
import {createOrgOpsClient} from '@nest/orgops-client';
import {registerModelPickerRoutes} from './model-picker';
import {createOpenRouterCatalog,normalizeModels} from './openrouter-catalog';
import type {generate} from '@orgops/llm';
let engine:ReturnType<typeof createEngine>, dir:string, cookie:string, app:Hono;
const probe=vi.fn<typeof generate>();
let secretReads=0;
let secretEnv:Record<string,string>={};
let compatibleReads:{apiKey:string;baseUrl:string}[]=[];
beforeEach(async()=>{
 dir=mkdtempSync(join(tmpdir(),'model-picker-'));
 engine=createEngine({projectRoot:dir,dataDir:dir,dbPath:join(dir,'engine.sqlite'),adminUser:'owner',adminPass:'password',runnerToken:'test-runner'});
 const client=createOrgOpsClient('http://engine',async(url,init)=>{
  if(new URL(url.toString()).pathname==='/api/secrets/env'){
   secretReads++;
   expect(new Headers(init?.headers).get('x-orgops-agent-name')).toBe('Private');
   expect(new Headers(init?.headers).get('x-orgops-runner-token')).toBe('test-runner');
   return Response.json(secretEnv);
  }
  return engine.app.fetch(new Request(url,init));
 });
 const login=await client.request('/api/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:'owner',password:'password'})});
 cookie=login.headers.getSetCookie()[0].split(';')[0];
 await client.request('/api/agents',{method:'POST',headers:{cookie,'content-type':'application/json'},body:JSON.stringify({name:'Private',visibility:'PRIVATE',modelId:'openrouter:old/model',workspacePath:join(dir,'workspace')})});
 probe.mockReset();secretReads=0;compatibleReads=[];secretEnv={OPENROUTER_API_KEY:'synthetic-key',UNRELATED_SECRET:'never-forward'};
 probe.mockImplementation(async(_model,_messages,opts)=>{await opts?.tools?.nest_connection_check.execute?.({value:'ok'});return {text:'',toolCalls:[],toolResults:[]};});
 app=new Hono();
 registerModelPickerRoutes(app,client,{engineToken:'test-runner',probe,benchmarks:async key=>{expect(key).toBe('synthetic-key');return {models:[{id:'vendor/model',intelligence:42}],fetchedAt:1,asOf:null,stale:false};},catalog:async()=>({models:[],fetchedAt:1,stale:false}),compatibleCatalog:async env=>{compatibleReads.push(env);return {provider:'Fireworks',models:[{id:'accounts/fireworks/models/glm-5p3',name:'GLM-5.3',description:'',context:1048576,tools:true,vision:false,created:1,route:false}],fetchedAt:1,stale:false};}});
});
afterEach(()=>{engine.db.close();rmSync(dir,{recursive:true,force:true});});
const check=(model='vendor/model',headers:Record<string,string>={cookie})=>app.request('/api/agents/Private/model-check',{method:'POST',headers:{...headers,'content-type':'application/json'},body:JSON.stringify({model})});
it('tests with only provider credentials and a synthetic tool, without changing the agent',async()=>{
 const response=await check();expect(response.status).toBe(200);expect(await response.json()).toMatchObject({reference:'openrouter:vendor/model',tools:true});
 expect(probe).toHaveBeenCalledWith('openrouter:vendor/model',expect.any(Array),expect.objectContaining({maxTokens:256,maxSteps:1,env:{OPENROUTER_API_KEY:'synthetic-key',OPENROUTER_BASE_URL:undefined,OPENROUTER_HTTP_REFERER:undefined,OPENROUTER_APP_TITLE:undefined}}));
 const agent=await engine.app.request('/api/agents/Private',{headers:{cookie}});expect(await agent.json()).toMatchObject({modelId:'openrouter:old/model'});
 expect((await check()).status).toBe(429);expect(secretReads).toBe(1);
});
it('tests an openai-compatible model with only its key and base URL',async()=>{
 secretEnv={OPENAI_COMPATIBLE_API_KEY:'synthetic-compatible-key',OPENAI_COMPATIBLE_BASE_URL:'https://api.fireworks.ai/inference/v1',OPENROUTER_API_KEY:'synthetic-key',UNRELATED_SECRET:'never-forward'};
 const reference='openai-compatible:accounts/fireworks/models/glm-5p3';
 const response=await check(reference);expect(response.status).toBe(200);
 const body=await response.text();expect(JSON.parse(body)).toMatchObject({reference,provider:'Fireworks',tools:true});
 expect(body).not.toContain('api.fireworks.ai');expect(body).not.toContain('synthetic');
 expect(probe).toHaveBeenCalledWith(reference,expect.any(Array),expect.objectContaining({env:{OPENAI_COMPATIBLE_API_KEY:'synthetic-compatible-key',OPENAI_COMPATIBLE_BASE_URL:'https://api.fireworks.ai/inference/v1'}}));
});
it('names the missing openai-compatible keys instead of asking for an OpenRouter key',async()=>{
 secretEnv={OPENAI_COMPATIBLE_API_KEY:'synthetic-compatible-key'};
 const response=await check('openai-compatible:accounts/fireworks/models/glm-5p3');
 expect(response.status).toBe(422);const {error}=await response.json();
 expect(error).toContain('OPENAI_COMPATIBLE_BASE_URL');expect(error).not.toContain('OpenRouter');expect(probe).not.toHaveBeenCalled();
});
it.each(['openai-compatible:','openai-compatible:a:b','openai-compatible:/abs','openai-compatible:https://x.test/m'])('rejects unsupported openai-compatible model %s',async model=>{expect((await check(model)).status).toBe(400);expect(secretReads).toBe(0);});
it('rejects unauthenticated and runner callers before reading secrets',async()=>{
 expect((await check('vendor/model',{})).status).toBe(401);
 expect((await check('vendor/model',{'x-nest-runner-token':'test-runner'})).status).toBe(401);
 expect(secretReads).toBe(0);expect(probe).not.toHaveBeenCalled();
});
it('rejects another human before resolving the private agent credentials',async()=>{
 const owner=engine.db.prepare('SELECT * FROM humans LIMIT 1').get() as any;
 engine.db.prepare('INSERT INTO humans (id,username,password_hash,must_change_password,created_at,updated_at) VALUES (?,?,?,0,?,?)').run('other','other',owner.password_hash,owner.created_at+1,owner.created_at+1);
 const login=await engine.app.request('/api/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:'other',password:'password'})});
 expect([403,404]).toContain((await check('vendor/model',{cookie:login.headers.getSetCookie()[0].split(';')[0]})).status);
 expect([403,404]).toContain((await app.request('/api/agents/Private/model-benchmarks',{headers:{cookie:login.headers.getSetCookie()[0].split(';')[0]}})).status);
 expect(secretReads).toBe(0);
});
it.each(['https://attacker.test/model','vendor/model:free','', 'vendor/model/extra'])('rejects unsupported ID %s',async model=>{expect((await check(model)).status).toBe(400);expect(secretReads).toBe(0);});
it('does not call a text response a successful tool check',async()=>{probe.mockResolvedValue({text:'hello',toolCalls:[],toolResults:[]});expect((await check()).status).toBe(422);});
it('sanitizes provider errors',async()=>{probe.mockRejectedValue(Error('synthetic-key provider response'));const r=await check();expect(r.status).toBe(502);expect(await r.text()).not.toContain('synthetic-key');});
it('requires a human session for the catalog',async()=>{expect((await app.request('/api/openrouter-models')).status).toBe(401);expect((await app.request('/api/openrouter-models',{headers:{cookie}})).status).toBe(200);});
it('normalizes capability data and preserves popularity ordering',()=>{
 const row={id:'vendor/model',name:'Model',architecture:{output_modalities:['text'],input_modalities:['image','text']},supported_parameters:['tools'],pricing:{prompt:'0.000002',completion:'0'}};
 expect(normalizeModels({data:[row,{...row,id:'vendor/model:free'}]})).toEqual([expect.objectContaining({id:'vendor/model',tools:true,vision:true,inputPrice:2,outputPrice:0})]);
});
it('coalesces catalog requests, caches them and marks stale fallback',async()=>{
 let now=1000;const transport=vi.fn<typeof fetch>().mockResolvedValue(Response.json({data:[{id:'vendor/model',architecture:{output_modalities:['text']}}]}));
 const catalog=createOpenRouterCatalog(transport,()=>now);
 await Promise.all([catalog(),catalog()]);expect(transport).toHaveBeenCalledTimes(1);
 now+=16*60_000;transport.mockRejectedValue(Error('offline'));
 expect(await catalog()).toMatchObject({stale:true,fetchedAt:1000});
 now+=24*60*60_000;await expect(catalog()).rejects.toThrow('unavailable');
});

it('guards benchmarks before reading credentials and returns only normalized scores',async()=>{
 const path='/api/agents/Private/model-benchmarks';
 expect((await app.request(path)).status).toBe(401);
 expect((await app.request(path,{headers:{'x-nest-runner-token':'test-runner'}})).status).toBe(401);
 expect(secretReads).toBe(0);
 const response=await app.request(path,{headers:{cookie}});
 expect(response.status).toBe(200);expect(await response.text()).not.toContain('synthetic-key');expect(secretReads).toBe(1);
});
const providers=(headers:Record<string,string>={cookie})=>app.request('/api/agents/Private/model-providers',{headers});
it('lists only the providers whose keys are all configured for the agent, without secrets or the base URL',async()=>{
 secretEnv={OPENROUTER_API_KEY:'synthetic-key',OPENAI_COMPATIBLE_API_KEY:'synthetic-compatible-key',OPENAI_COMPATIBLE_BASE_URL:'https://api.fireworks.ai/inference/v1',UNRELATED_SECRET:'never-forward'};
 const both=await providers();expect(both.status).toBe(200);
 const body=await both.text();
 expect(JSON.parse(body)).toEqual({providers:[{id:'openrouter',label:'OpenRouter'},{id:'openai-compatible',label:'Fireworks'}]});
 expect(body).not.toContain('synthetic');expect(body).not.toContain('api.fireworks.ai');
 secretEnv={OPENAI_COMPATIBLE_API_KEY:'synthetic-compatible-key',OPENAI_COMPATIBLE_BASE_URL:'https://api.fireworks.ai/inference/v1'};
 expect(await (await providers()).json()).toEqual({providers:[{id:'openai-compatible',label:'Fireworks'}]});
 // The engine refuses an openai-compatible call without its base URL, so it is not offered.
 secretEnv={OPENAI_COMPATIBLE_API_KEY:'synthetic-compatible-key'};
 expect(await (await providers()).json()).toEqual({providers:[]});
 secretEnv={OPENAI_COMPATIBLE_API_KEY:'k',OPENAI_COMPATIBLE_BASE_URL:'https://llm.example.test/v1'};
 expect(await (await providers()).json()).toEqual({providers:[{id:'openai-compatible',label:'OpenAI-compatible'}]});
});
it('guards the provider list before reading credentials',async()=>{
 expect((await providers({})).status).toBe(401);
 expect((await providers({'x-nest-runner-token':'test-runner'})).status).toBe(401);
 const owner=engine.db.prepare('SELECT * FROM humans LIMIT 1').get() as any;
 engine.db.prepare('INSERT INTO humans (id,username,password_hash,must_change_password,created_at,updated_at) VALUES (?,?,?,0,?,?)').run('other','other',owner.password_hash,owner.created_at+1,owner.created_at+1);
 const login=await engine.app.request('/api/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:'other',password:'password'})});
 expect([403,404]).toContain((await providers({cookie:login.headers.getSetCookie()[0].split(';')[0]})).status);
 expect(secretReads).toBe(0);
});
const compatibleModels=(headers:Record<string,string>={cookie})=>app.request('/api/agents/Private/compatible-models',{headers});
it('lists the agent’s OpenAI-compatible models with its own key, returning neither the key nor the base URL',async()=>{
 secretEnv={OPENAI_COMPATIBLE_API_KEY:'synthetic-compatible-key',OPENAI_COMPATIBLE_BASE_URL:'https://api.fireworks.ai/inference/v1',OPENROUTER_API_KEY:'synthetic-key'};
 const response=await compatibleModels();expect(response.status).toBe(200);
 const body=await response.text();
 expect(JSON.parse(body)).toMatchObject({provider:'Fireworks',models:[{id:'accounts/fireworks/models/glm-5p3',name:'GLM-5.3'}]});
 expect(body).not.toContain('synthetic');expect(body).not.toContain('api.fireworks.ai');
 expect(compatibleReads).toEqual([{apiKey:'synthetic-compatible-key',baseUrl:'https://api.fireworks.ai/inference/v1'}]);
 secretEnv={OPENAI_COMPATIBLE_API_KEY:'synthetic-compatible-key'};
 expect((await compatibleModels()).status).toBe(422);
});
it('guards the compatible model list before reading credentials',async()=>{
 expect((await compatibleModels({})).status).toBe(401);
 expect((await compatibleModels({'x-nest-runner-token':'test-runner'})).status).toBe(401);
 const owner=engine.db.prepare('SELECT * FROM humans LIMIT 1').get() as any;
 engine.db.prepare('INSERT INTO humans (id,username,password_hash,must_change_password,created_at,updated_at) VALUES (?,?,?,0,?,?)').run('other','other',owner.password_hash,owner.created_at+1,owner.created_at+1);
 const login=await engine.app.request('/api/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:'other',password:'password'})});
 expect([403,404]).toContain((await compatibleModels({cookie:login.headers.getSetCookie()[0].split(';')[0]})).status);
 expect(secretReads).toBe(0);expect(compatibleReads).toEqual([]);
});
