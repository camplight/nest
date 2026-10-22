import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp as createEngine } from '../../../vendor/orgops/apps/api/src/app';
import { createOrgOpsClient, engineHeaders } from '@nest/orgops-client';
import { openProductDb } from '@nest/db';
import { DEFAULT_BRANDING } from '@nest/schemas';
import { createApp } from './app';

describe('Nest product over unchanged OrgOps', () => {
  let dir: string;
  let engine: ReturnType<typeof createEngine>;
  let product: ReturnType<typeof createApp>;
  let cookie: string;
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'nest-product-'));
    const previousRoot = process.env.ORGOPS_PROJECT_ROOT;
    process.env.ORGOPS_PROJECT_ROOT = dir;
    engine = createEngine({dbPath: join(dir, 'engine.sqlite'), dataDir: dir, adminUser: 'owner', adminPass: 'password', runnerToken: 'runner-secret'});
    if (previousRoot === undefined) delete process.env.ORGOPS_PROJECT_ROOT; else process.env.ORGOPS_PROJECT_ROOT = previousRoot;
    const client = createOrgOpsClient('http://engine', (async (url, init) => engine.app.fetch(new Request(url, init))) as typeof fetch);
    product = createApp({demoRoot: join(dir, 'demos'), defaultAgentModelId:'default-test', orgops: client, dbPath: join(dir, 'product.sqlite')});
    const login = await product.app.request('http://nest/api/auth/login', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({username: 'owner', password: 'password'})});
    expect(login.status).toBe(200);
    cookie = login.headers.get('set-cookie')!.split(';')[0];
  });
  afterEach(() => { product.store.close(); engine.db.close(); rmSync(dir, {recursive: true, force: true}); });
  it('lists actual published artifacts for signed-in humans without exposing aliases or symlinks',async()=>{
    expect((await product.app.request('/api/artifacts')).status).toBe(401);
    expect((await product.app.request('/api/artifacts',{headers:{'x-nest-runner-token':'runner-secret'}})).status).toBe(401);
    expect(await(await product.app.request('/api/artifacts',{headers:{cookie}})).json()).toEqual({items:[]});
    mkdirSync(join(dir,'demos','report'),{recursive:true});writeFileSync(join(dir,'demos','report','index.html'),'<!doctype html><h1>Report</h1>');
    symlinkSync('report/index.html',join(dir,'demos','report.html'));
    mkdirSync(join(dir,'demos','incomplete'));mkdirSync(join(dir,'demos','escape'));writeFileSync(join(dir,'outside.html'),'private');symlinkSync(join(dir,'outside.html'),join(dir,'demos','escape','index.html'));
    const response=await product.app.request('/api/artifacts',{headers:{cookie}});expect(response.status).toBe(200);expect(response.headers.get('cache-control')).toBe('private, no-store');
    const {items}=await response.json();expect(items).toHaveLength(1);expect(items[0]).toMatchObject({name:'report',url:'/demo/report'});expect(items[0]).not.toHaveProperty('path');
    await product.app.request('/api/auth/logout',{method:'POST',headers:{cookie}});expect((await product.app.request('/api/artifacts',{headers:{cookie}})).status).toBe(401);
  });
  it('gates all demo aliases and assets on a live human session', async () => {
    mkdirSync(join(dir, 'demos', 'example'), {recursive:true});
    writeFileSync(join(dir, 'demos', 'example', 'index.html'), '<!doctype html><title>Private demo</title>');
    writeFileSync(join(dir, 'demos', 'example', 'asset.css'), 'body{color:red}');
    writeFileSync(join(dir, 'secret.txt'), 'outside');
    symlinkSync(join(dir, 'secret.txt'), join(dir, 'demos', 'example', 'escape.txt'));
    for (const path of ['/demo/example', '/demo/example/', '/demo/example.html', '/demo/example/index.html', '/demo/example/asset.css', '/demo/future']) {
      for (const headers of [{}, {cookie:'nest_session=invalid'}, {'x-nest-runner-token':'runner-secret'}] as HeadersInit[]) {
        const denied = await product.app.request(path, {headers});
        expect(denied.status).toBe(401);
        expect(denied.headers.get('cache-control')).toBe('private, no-store');
      }
    }
    const navigation = await product.app.request('/demo/example?campaign=test', {headers:{Accept:'text/html,application/xhtml+xml'}});
    expect(navigation.status).toBe(302);
    expect(navigation.headers.get('location')).toBe('/?returnTo=%2Fdemo%2Fexample%3Fcampaign%3Dtest');
    expect(navigation.headers.get('cache-control')).toBe('private, no-store');
    expect(navigation.headers.get('vary')).toBe('Cookie, Accept');
    for (const path of ['/demo/example', '/demo/example/', '/demo/example.html', '/demo/example/index.html']) {
      const response = await product.app.request(path, {headers:{cookie}});
      expect(response.status).toBe(200);
      expect(await response.text()).toContain('Private demo');
      expect(response.headers.get('cache-control')).toBe('private, no-store');
    }
    expect((await product.app.request('/demo/example/asset.css', {headers:{cookie}})).status).toBe(200);
    const head=await product.app.request('/demo/example', {method:'HEAD',headers:{cookie}});
    expect(head.status).toBe(200);
    expect(await head.text()).toBe('');
    expect(head.headers.get('etag')).toBeTruthy();
    expect((await product.app.request('/demo/example', {method:'HEAD',headers:{cookie}})).headers.get('etag')).toBe(head.headers.get('etag'));
    writeFileSync(join(dir, 'demos', 'example', 'index.html'), '<!doctype html><title>Updated demo</title>');
    expect((await product.app.request('/demo/example', {method:'HEAD',headers:{cookie}})).headers.get('etag')).not.toBe(head.headers.get('etag'));
    for (const path of ['/demo/future', '/demo/example/escape.txt', '/demo/example/.publish.lock', '/demo/example/%2e%2e%2f%2e%2e%2fsecret.txt']) {
      expect((await product.app.request(path, {headers:{cookie}})).status).toBe(404);
    }
    await product.app.request('/api/auth/logout', {method:'POST',headers:{cookie}});
    expect((await product.app.request('/demo/example', {headers:{cookie}})).status).toBe(401);
  });
  it('translates login cookies and revokes the actual engine session on logout', async () => {
    expect(cookie).toMatch(/^nest_session=/);
    const result = await product.app.request('/api/auth/me', {headers: {cookie}});
    expect((await result.json()).username).toBe('owner');
    expect((await product.app.request('/api/auth/logout', {method: 'POST', headers: {cookie}})).status).toBe(200);
    expect((await product.app.request('/api/auth/me', {headers: {cookie}})).status).toBe(401);
  });
  it('persists agent settings through the adapter and rejects private non-owner edits', async () => {
    const headers = {cookie, 'content-type': 'application/json'};
    const name = 'SettingsAgent';
    const created = await product.app.request('/api/agents', {method:'POST', headers, body:JSON.stringify({name, modelId:'test-model', workspacePath:join(dir, 'workspace'), visibility:'PRIVATE', description:'Original', systemInstructions:'Original instructions'})});
    expect(created.status).toBe(201);
    const path = `/api/agents/${encodeURIComponent(name)}`;
    expect((await product.app.request(path, {method:'PATCH', headers, body:JSON.stringify({description:'Changed', systemInstructions:'New instructions',modelId:'openrouter:updated'})})).status).toBe(200);
    expect(await (await product.app.request(path, {headers})).json()).toMatchObject({name, description:'Changed', soulContents:'New instructions', systemInstructions:'New instructions', modelId:'openrouter:updated'});
    expect(await (await engine.app.request(path, {headers:engineHeaders(headers)})).json()).toMatchObject({soulContents:'New instructions'});
    const owner = engine.db.prepare('SELECT * FROM humans LIMIT 1').get() as any;
    engine.db.prepare('INSERT INTO humans (id, username, password_hash, must_change_password, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?)').run('viewer', 'viewer', owner.password_hash, owner.created_at + 1, owner.created_at + 1);
    const login = await product.app.request('/api/auth/login', {method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({username:'viewer',password:'password'})});
    const viewerCookie = login.headers.get('set-cookie')!.split(';')[0];
    expect((await product.app.request(path, {method:'PATCH', headers:{cookie:viewerCookie, 'content-type':'application/json'}, body:JSON.stringify({description:'Unauthorized',modelId:'openrouter:unauthorized'})})).status).toBe(403);
    expect(await (await product.app.request(path, {headers})).json()).toMatchObject({description:'Changed',modelId:'openrouter:updated'});
  });
  it('keeps canonical instructions authoritative and preserves them on unrelated settings edits', async () => {
    const headers = {cookie, 'content-type':'application/json'};
    const path = '/api/agents/Canonical';
    expect((await product.app.request('/api/agents', {method:'POST',headers,body:JSON.stringify({name:'Canonical',modelId:'test-model',workspacePath:join(dir,'canonical'),systemInstructions:'Stale alias',soulContents:'Canonical instructions'})})).status).toBe(201);
    expect((await product.app.request(path, {method:'PATCH',headers,body:JSON.stringify({description:'New description'})})).status).toBe(200);
    expect(await (await product.app.request(path,{headers})).json()).toMatchObject({soulContents:'Canonical instructions',systemInstructions:'Canonical instructions',description:'New description'});
    expect(await (await product.app.request('/api/agents',{headers})).json()).toEqual(expect.arrayContaining([expect.objectContaining({name:'Canonical',soulContents:'Canonical instructions',systemInstructions:'Canonical instructions'})]));
    expect((await product.app.request(path,{method:'PATCH',headers,body:JSON.stringify({systemInstructions:''})})).status).toBe(200);
    expect(await (await product.app.request(path,{headers})).json()).toMatchObject({soulContents:'',systemInstructions:''});
  });
  it('resolves enabled defaults for new native agents while preserving explicit and wrapped models', async () => {
    const headers = {cookie, 'content-type':'application/json'};
    const post = (path:string, body:unknown, h:HeadersInit=headers) => product.app.request(path,{method:'POST',headers:h,body:JSON.stringify(body)});
    expect((await product.app.request('/api/agent-models')).status).toBe(401);
    expect((await post('/api/agents',{name:'Anonymous',workspacePath:join(dir,'anonymous')},{})).status).toBe(401);
    expect((await post('/api/agents',{name:'NoDefault',workspacePath:join(dir,'none')})).status).toBe(503);
    for (const model of [
      {id:'default-test',provider:'openrouter',modelName:'moonshotai/kimi-k3',enabled:true},
      {id:'off',provider:'openrouter',modelName:'disabled',enabled:false},
      {id:'unsupported',provider:'unsupported',modelName:'test',enabled:true}
    ]) expect((await post('/api/models',model)).status).toBe(201);
    const catalog = await product.app.request('/api/agent-models',{headers});
    expect(catalog.headers.get('cache-control')).toBe('no-store');
    expect(await catalog.json()).toEqual({models:[{id:'default-test',provider:'openrouter',name:'moonshotai/kimi-k3',reference:'openrouter:moonshotai/kimi-k3'}],defaultModel:'openrouter:moonshotai/kimi-k3'});
    for (const [name,mode,explicit,expected] of [
      ['Default','CLASSIC',undefined,'openrouter:moonshotai/kimi-k3'],
      ['Blank','CLASSIC','','openrouter:moonshotai/kimi-k3'],
      ['Repl','RLM_REPL',undefined,'openrouter:moonshotai/kimi-k3'],
      ['Explicit','CLASSIC','openrouter:other','openrouter:other'],
      ['Wrapped','WRAPPED','wrapped:none','wrapped:none']
    ]) {
      expect((await post('/api/agents',{name,mode,modelId:explicit,workspacePath:join(dir,name!)})).status).toBe(201);
      expect(await (await product.app.request(`/api/agents/${name}`,{headers})).json()).toMatchObject({modelId:expected});
    }
    await product.app.request('/api/models/default-test',{method:'PATCH',headers,body:JSON.stringify({enabled:false})});
    expect((await post('/api/agents',{name:'Disabled',workspacePath:join(dir,'disabled')})).status).toBe(503);
    expect(await (await product.app.request('/api/agents/Default',{headers})).json()).toMatchObject({modelId:'openrouter:moonshotai/kimi-k3'});
  });
  it('stores branding and audit in the product DB only and retains them after reopen', async () => {
    expect(await (await product.app.request('/api/branding')).json()).toEqual(DEFAULT_BRANDING);
    const value = {...DEFAULT_BRANDING, displayName: 'Camplight'};
    const response = await product.app.request('/api/branding', {method: 'PUT', headers: {cookie, 'content-type': 'application/json'}, body: JSON.stringify(value)});
    expect(response.status).toBe(200);
    expect(engine.db.prepare("SELECT name FROM sqlite_master WHERE name IN ('product_settings','instance_settings','product_audit')").all()).toEqual([]);
    expect(product.store.db.prepare('SELECT actor_id, type FROM product_audit').all()).toHaveLength(1);
    product.store.close(); product.store = openProductDb(join(dir, 'product.sqlite'));
    expect(product.store.branding()).toEqual(value);
  });
  it('does not elevate anonymous requests or runner credentials to owner', async () => {
    expect((await product.app.request('/api/agents')).status).toBe(401);
    const response = await product.app.request('/api/branding', {method: 'PUT', headers: {'x-nest-runner-token': 'runner-secret', 'content-type': 'application/json'}, body: JSON.stringify(DEFAULT_BRANDING)});
    expect(response.status).toBe(401);
    expect((await product.app.request('/api/agents', {headers: {'x-nest-runner-token': 'runner-secret'}})).status).toBe(200);
  });
  it('denies other human accounts even when they supply a runner header', async () => {
    const owner = engine.db.prepare('SELECT * FROM humans LIMIT 1').get() as any;
    engine.db.prepare('INSERT INTO humans (id, username, password_hash, must_change_password, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?)').run('other-human', 'other', owner.password_hash, owner.created_at + 1, owner.created_at + 1);
    const login = await product.app.request('/api/auth/login', {method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({username:'other',password:'password'})});
    const otherCookie = login.headers.get('set-cookie')!.split(';')[0];
    const headers = {cookie:otherCookie, 'x-nest-runner-token':'runner-secret', 'content-type':'application/json'};
    expect(await (await product.app.request('/api/branding/access',{headers})).json()).toEqual({canManage:false});
    expect((await product.app.request('/api/branding',{method:'PUT',headers,body:JSON.stringify(DEFAULT_BRANDING)})).status).toBe(403);
  });
  it('streams multipart uploads and returns identical binary bytes', async () => {
    const bytes = new Uint8Array([0, 1, 127, 128, 255]);
    const body = new FormData(); body.set('file', new Blob([bytes], {type:'application/octet-stream'}), 'sample.bin');
    const uploaded = await product.app.request('/api/files', {method:'POST',headers:{cookie},body});
    expect(uploaded.status).toBe(201);
    const {id} = await uploaded.json();
    const downloaded = await product.app.request(`/api/files/${id}`,{headers:{cookie}});
    expect(downloaded.status).toBe(200);
    expect(new Uint8Array(await downloaded.arrayBuffer())).toEqual(bytes);
  });
  it('retains owner access after a username change', async () => {
    const r = await product.app.request('/api/auth/profile', {method: 'PATCH', headers: {cookie,'content-type':'application/json'},body:JSON.stringify({username:'renamed'})});
    expect(r.status).toBe(200);
    expect(await (await product.app.request('/api/branding/access', {headers:{cookie}})).json()).toEqual({canManage:true});
  });
  it('rejects malformed branding and oversized bodies', async () => {
    const put = (body:string) => product.app.request('/api/branding', {method:'PUT',headers:{cookie,'content-type':'application/json'},body});
    expect((await put('{')).status).toBe(400);
    expect((await put(JSON.stringify({...DEFAULT_BRANDING,logoUrl:'javascript:alert(1)'}))).status).toBe(400);
    expect((await put('x'.repeat(360_001))).status).toBe(413);
  });
});

it('prefers Nest credentials over conflicting legacy headers/cookies', () => {
  const h = engineHeaders({'x-nest-runner-token':'new','x-orgops-runner-token':'old',cookie:'orgops_session=old; nest_session=new; other=keep'});
  expect(h.get('x-orgops-runner-token')).toBe('new');
  expect(h.get('cookie')).toBe('other=keep; orgops_session=new');
});

it('reports engine downtime without serving a healthy status', async () => {
  const store = openProductDb(':memory:');
  const orgops = createOrgOpsClient('http://engine', (async () => {throw new Error('offline');}) as typeof fetch);
  const {app} = createApp({store,orgops});
  expect((await app.request('/health')).status).toBe(503);
  const demo = await app.request('/demo/example');
  expect(demo.status).toBe(502);
  expect(demo.headers.get('cache-control')).toBe('private, no-store');
  expect((await app.request('/api/agents')).status).toBe(502);
  expect((await app.request('/api/branding')).status).toBe(200);
  store.close();
});
