import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
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
    product = createApp({orgops: client, dbPath: join(dir, 'product.sqlite')});
    const login = await product.app.request('http://nest/api/auth/login', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({username: 'owner', password: 'password'})});
    expect(login.status).toBe(200);
    cookie = login.headers.get('set-cookie')!.split(';')[0];
  });
  afterEach(() => { product.store.close(); engine.db.close(); rmSync(dir, {recursive: true, force: true}); });
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
    expect((await product.app.request(path, {method:'PATCH', headers, body:JSON.stringify({description:'Changed', systemInstructions:'New instructions'})})).status).toBe(200);
    expect(await (await product.app.request(path, {headers})).json()).toMatchObject({name, description:'Changed', systemInstructions:'New instructions', modelId:'test-model'});
    const owner = engine.db.prepare('SELECT * FROM humans LIMIT 1').get() as any;
    engine.db.prepare('INSERT INTO humans (id, username, password_hash, must_change_password, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?)').run('viewer', 'viewer', owner.password_hash, owner.created_at + 1, owner.created_at + 1);
    const login = await product.app.request('/api/auth/login', {method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({username:'viewer',password:'password'})});
    const viewerCookie = login.headers.get('set-cookie')!.split(';')[0];
    expect((await product.app.request(path, {method:'PATCH', headers:{cookie:viewerCookie, 'content-type':'application/json'}, body:JSON.stringify({description:'Unauthorized'})})).status).toBe(403);
    expect(await (await product.app.request(path, {headers})).json()).toMatchObject({description:'Changed'});
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
  expect((await app.request('/api/agents')).status).toBe(502);
  expect((await app.request('/api/branding')).status).toBe(200);
  store.close();
});
