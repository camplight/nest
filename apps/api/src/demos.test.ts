import {afterEach,beforeEach,describe,expect,it} from 'vitest';
import {mkdtemp,mkdir,writeFile,rm,symlink} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Hono} from 'hono';
import {createOrgOpsClient} from '../../../packages/orgops-client/src/index';
import {registerDemoRoutes} from './demos';
describe('restricted demo namespaces',()=>{
 let dir:string,root:string,restricted:string,policy:string,app:Hono,revoked:boolean;
 const paths=['/demo/2026-presentations/report','/demo/2026-presentations/report/','/demo/2026-presentations/report.html','/demo/2026-presentations/report/index.html','/demo/2026-presentations/report/style.css'];
 const headers={cookie:'nest_session=allowed'};
 beforeEach(async()=>{
  dir=await mkdtemp(join(tmpdir(),'restricted-demo-'));root=join(dir,'demos');restricted=join(dir,'restricted-demos');revoked=false;
  await mkdir(join(root,'example'),{recursive:true});await writeFile(join(root,'example','index.html'),'ordinary');
  await mkdir(join(restricted,'2026-presentations','report'),{recursive:true});
  await writeFile(join(restricted,'2026-presentations','report','index.html'),'confidential');await writeFile(join(restricted,'2026-presentations','report','style.css'),'body{}');
  policy=join(restricted,'2026-presentations','.access.json');await writeFile(policy,JSON.stringify({version:1,allowedHumanIds:['human-allowed']}));
  const orgops=createOrgOpsClient('http://engine',(async(_url,init)=>{
   const h=new Headers(init?.headers),session=h.get('cookie')?.split('=')[1];
   if(revoked||!['allowed','outsider','setup'].includes(session??''))return new Response('{}',{status:401});
   return Response.json({id:'human-'+session,username:session+'@example.test',mustChangePassword:session==='setup'});
  }) as typeof fetch);
  app=new Hono();registerDemoRoutes(app,{orgops,root,restrictedRoot:restricted});
 });
 afterEach(async()=>{await rm(dir,{recursive:true,force:true});});
 it('authorizes all aliases and assets against live human identity',async()=>{
  for(const path of paths){
   const response=await app.request(path,{headers});expect(response.status).toBe(200);expect(response.headers.get('cache-control')).toBe('private, no-store');
   for(const h of [{},{cookie:'nest_session=invalid'},{'x-nest-runner-token':'secret'},{authorization:'Bearer secret'}])expect((await app.request(path,{headers:h})).status).toBe(401);
   expect((await app.request(path,{headers:{cookie:'nest_session=outsider'}})).status).toBe(404);
   expect((await app.request(path,{headers:{cookie:'nest_session=setup'}})).status).toBe(403);
  }
  expect(await(await app.request(paths[0],{method:'HEAD',headers})).text()).toBe('');
  expect((await app.request(paths[0],{method:'POST',headers})).status).toBe(405);
  revoked=true;expect((await app.request(paths[0],{headers})).status).toBe(401);
 });
 it('fails closed for missing or malformed policy and rechecks membership',async()=>{
  for(const value of ['{','{}','{"version":1,"allowedHumanIds":[]}','{"version":1,"allowedHumanIds":[null]}','{"version":2,"allowedHumanIds":["human-allowed"]}','{"version":1,"allowedHumanIds":["outsider"]}']){
   await writeFile(policy,value);for(const path of paths)expect((await app.request(path,{headers})).status).toBe(404);
  }
  await rm(policy);expect((await app.request(paths[0],{headers})).status).toBe(404);
 });
 it('denies hidden files, traversal and symlinks and omits restricted listing',async()=>{
  for(const path of ['/demo/2026-presentations/.access.json','/demo/2026-presentations/report/%2e%2e%2f.access.json'])expect((await app.request(path,{headers})).status).toBe(404);
  await symlink(join(restricted,'2026-presentations','report','index.html'),join(root,'example','escape.html'));
  expect((await app.request('/demo/example/escape.html',{headers:{cookie:'nest_session=outsider'}})).status).toBe(404);
  await symlink('index.html',join(restricted,'2026-presentations','report','alias.html'));
  expect((await app.request('/demo/2026-presentations/report/alias.html',{headers})).status).toBe(404);
  for(const cookie of ['nest_session=allowed','nest_session=outsider']){
   const {items}=await(await app.request('/api/artifacts',{headers:{cookie}})).json();expect(items.map((item:{url:string})=>item.url)).toEqual(['/demo/example']);
  }
  expect(await(await app.request('/demo/example',{headers})).text()).toBe('ordinary');
 });
 it('rejects symlink policies and namespaces and preserves login return',async()=>{
  await rm(policy);await writeFile(join(dir,'policy.json'),JSON.stringify({version:1,allowedHumanIds:['human-allowed']}));await symlink(join(dir,'policy.json'),policy);
  expect((await app.request(paths[0],{headers})).status).toBe(404);
  await symlink(join(restricted,'2026-presentations'),join(restricted,'alias'));expect((await app.request('/demo/alias/report',{headers})).status).toBe(404);
  const response=await app.request(paths[0]+'?view=1',{headers:{Accept:'text/html'}});expect(response.status).toBe(302);expect(response.headers.get('location')).toBe('/?returnTo=%2Fdemo%2F2026-presentations%2Freport%3Fview%3D1');
 });
 it('fails closed when roots overlap directly or through symlinks',async()=>{
  for(const overlapping of [root,join(root,'private')]){
   const orgops=createOrgOpsClient('http://engine',(async()=>Response.json({id:'human-allowed',username:'allowed',mustChangePassword:false})) as typeof fetch);
   const unsafe=new Hono();unsafe.onError((_e,c)=>c.text('Unavailable',503));registerDemoRoutes(unsafe,{orgops,root,restrictedRoot:overlapping});
   for(const path of ['/demo/example','/api/artifacts'])expect((await unsafe.request(path,{headers})).status).toBe(503);
  }
  await symlink(root,join(dir,'alias-root'));
  const orgops=createOrgOpsClient('http://engine',(async()=>Response.json({id:'human-allowed',username:'allowed',mustChangePassword:false})) as typeof fetch);
  const unsafe=new Hono();unsafe.onError((_e,c)=>c.text('Unavailable',503));registerDemoRoutes(unsafe,{orgops,root,restrictedRoot:join(dir,'alias-root')});
  expect((await unsafe.request('/demo/example',{headers})).status).toBe(503);
 });

});
