import {afterEach, expect, it} from 'vitest';
import {mkdtempSync, readFileSync, readdirSync, rmSync, statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApp} from '../vendor/orgops/apps/api/src/app';
import {reconcileNestSystemBridge} from './reconcile-nestsystem-bridge.mjs';

const cleanups = [];
afterEach(() => {for (const cleanup of cleanups.splice(0)) cleanup();});
const legacy = '/app/.nest-data/codex-runtime/nestsystem-bridge.mjs';
const canonical = '/app/deploy/nestsystem-bridge.mjs';
async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'nest-bridge-reconcile-'));
  const engine = createApp({dbPath:join(dir,'engine.sqlite'),projectRoot:dir,dataDir:dir,runnerToken:'fixture-runner',adminUser:'owner',adminPass:'password'});
  cleanups.push(() => {engine.db.close(); rmSync(dir,{recursive:true,force:true});});
  const headers = {'x-orgops-runner-token':'fixture-runner','content-type':'application/json'};
  const config = {
    kind:'codex',harness:'command',sessionScope:'channel',
    runtime:{command:`# nest-orgops-env-v1\nexport NEST_WRAPPED_MESSAGE="\${ORGOPS_WRAPPED_MESSAGE:-}"\nnode ${legacy}`,parse:'text',timeoutMs:0,cwd:'/existing/workspace'},
    setup:{command:`node -e 'const fs=require("fs");fs.writeFileSync("${legacy}",Buffer.from("b2xkIGJyaWRnZQ==","base64"),{mode:0o644});fs.mkdirSync("/existing/workspace",{recursive:true});'`},
  };
  const response = await engine.app.request('/api/agents',{method:'POST',headers,body:JSON.stringify({name:'NestSystem',modelId:'wrapped:none',workspacePath:'/existing/workspace',mode:'WRAPPED',wrappedConfig:config})});
  expect(response.status,await response.clone().text()).toBe(201);
  const agent = await response.json();
  const options = {agentName:'NestSystem',agentId:agent.id,apiUrl:'http://engine',token:'fixture-runner',dataDir:dir,fetchImpl:(url,init)=>engine.app.fetch(new Request(url,init))};
  const get = async () => (await engine.app.request('/api/agents/NestSystem',{headers})).json();
  return {dir,engine,config,agent,options,get,headers};
}

it('migrates the pinned agent through real HTTP, preserves settings, and backs up the previous recipe privately',async()=>{
  const f=await fixture();
  expect(await reconcileNestSystemBridge(f.options)).toBe('migrated');
  const saved=await f.get();
  expect(saved).toMatchObject({id:f.agent.id,workspacePath:'/existing/workspace',mode:'WRAPPED'});
  expect(saved.wrappedConfig.runtime).toEqual({...f.config.runtime,command:f.config.runtime.command.replace(legacy,canonical)});
  expect(saved.wrappedConfig.setup.command).toContain('fs.mkdirSync("/existing/workspace"');
  expect(saved.wrappedConfig.setup.command).not.toContain('Buffer.from');
  const backups=join(f.dir,'codex-runtime','bridge-config-backups');
  const files=readdirSync(backups); expect(files).toHaveLength(1);
  expect(JSON.parse(readFileSync(join(backups,files[0]),'utf8'))).toEqual({agentId:f.agent.id,wrappedConfig:f.config});
  expect(statSync(join(backups,files[0])).mode & 0o777).toBe(0o600);
  expect(await reconcileNestSystemBridge(f.options)).toBe('current');
  expect(readdirSync(backups)).toEqual(files);
});

it('does not touch agents without an explicit matching identity',async()=>{
  const f=await fixture();
  expect(await reconcileNestSystemBridge({...f.options,agentId:undefined})).toBe('not-configured');
  expect(await reconcileNestSystemBridge({...f.options,agentId:'different-agent'})).toBe('not-managed');
  expect((await f.get()).wrappedConfig).toEqual(f.config);
});

it('leaves custom startup recipes for operator review',async()=>{
  const f=await fixture();
  const custom={...f.config,setup:{command:'custom installer --preserve-me'}};
  await f.engine.app.request('/api/agents/NestSystem',{method:'PATCH',headers:f.headers,body:JSON.stringify({wrappedConfig:custom})});
  expect(await reconcileNestSystemBridge(f.options)).toBe('needs-review');
  expect((await f.get()).wrappedConfig).toEqual(custom);
});

it('keeps the original configuration when authorization fails',async()=>{
  const f=await fixture();
  await expect(reconcileNestSystemBridge({...f.options,token:'wrong-token'})).rejects.toThrow('reconciliation failed');
  expect((await f.get()).wrappedConfig).toEqual(f.config);
});

it('recovers a committed migration after a lost HTTP response without replacing the backup',async()=>{
  const f=await fixture();
  const loseResponse=async(url,init)=>{
    const response=await f.options.fetchImpl(url,init);
    if(init.method==='PATCH') throw Error('Synthetic lost response');
    return response;
  };
  await expect(reconcileNestSystemBridge({...f.options,fetchImpl:loseResponse})).rejects.toThrow('Synthetic lost response');
  const backups=join(f.dir,'codex-runtime','bridge-config-backups');
  const before=readdirSync(backups);
  expect(await reconcileNestSystemBridge(f.options)).toBe('current');
  expect(readdirSync(backups)).toEqual(before);
  expect(before).toHaveLength(1);
});
