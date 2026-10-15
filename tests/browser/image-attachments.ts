import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {createRequire} from 'node:module';
import {createApp as createEngine} from '../../vendor/orgops/apps/api/src/app';
import {createOrgOpsClient} from '../../packages/orgops-client/src/index';
import {createApp} from '../../apps/api/src/app';
const dir=mkdtempSync(join(tmpdir(),'nest-image-test-'));
const engine=createEngine({dbPath:join(dir,'engine.sqlite'),projectRoot:dir,dataDir:dir,adminUser:'demo-owner',adminPass:'password',runnerToken:'test-runner'});
const product=createApp({orgops:createOrgOpsClient('http://engine',async(url,init)=>engine.app.fetch(new Request(url,init))),dbPath:join(dir,'product.sqlite'),connections:null});
const req=createRequire(join(process.cwd(),'apps/user-ui/package.json'));
const server=spawn(process.execPath,[join(dirname(req.resolve('vite/package.json')),'bin/vite.js'),'--host','127.0.0.1','--port','5320','--strictPort'],{cwd:join(process.cwd(),'apps/user-ui'),stdio:'pipe'});
server.stderr.on('data',chunk=>process.stderr.write(chunk));
const base='http://127.0.0.1:5320';
try{
 await new Promise<void>((resolve,reject)=>{const timeout=setTimeout(()=>reject(Error('Vite timeout')),20000);server.on('error',reject);server.on('exit',code=>reject(Error(`Vite exited ${code}`)));server.stdout.on('data',c=>{if(c.toString().includes('5320')){clearTimeout(timeout);resolve();}});});
 const post=(path:string,body:unknown,headers:Record<string,string>)=>product.app.request(path,{method:'POST',headers,body:JSON.stringify(body)});
 const login=await post('/api/auth/login',{username:'demo-owner',password:'password'},{'content-type':'application/json'});
 const cookie=login.headers.getSetCookie()[0].split(';')[0],headers={cookie,'content-type':'application/json'};
 await product.app.request('/api/branding',{method:'PUT',headers,body:JSON.stringify({displayName:'Camplight',logoUrl:'/brand/camplight-logo-white.svg',primaryColor:'#350956',accentColor:'#ff7557',backgroundColor:'#f8f4ff'})});
 const project=await(await post('/api/projects',{id:crypto.randomUUID(),name:'Demo launch planning',description:'Synthetic test project'},headers)).json();
 assert(project.channelId);
 const emit=async(type:string,payload:unknown)=>{const response=await post('/api/events',{type,source:'agent:Demo',channelId:project.channelId,payload},{'content-type':'application/json','x-nest-runner-token':'test-runner'});assert.equal(response.status,201,await response.text());};

 const browser=await chromium.launch();
 try {
  const context=await browser.newContext({viewport:{width:1440,height:1000}});
  await context.addCookies([{name:'nest_session',value:cookie.slice('nest_session='.length),url:base,httpOnly:true}]);
  await context.routeWebSocket('**/ws',socket=>socket.close());
  await context.route('**/api/**',async route=>{
   const request=route.request(),u=new URL(request.url());
   const response=await product.app.request(u.pathname+u.search,{method:request.method(),headers:request.headers(),...(request.postDataBuffer()?{body:new Uint8Array(request.postDataBuffer()!)}:{})});
   await route.fulfill({status:response.status,headers:Object.fromEntries(response.headers),body:Buffer.from(await response.arrayBuffer())});
  });
  const page=await context.newPage();page.setDefaultTimeout(20000);
  await page.setContent('<div style="width:720px;height:360px;background:#350956;color:white;font:28px sans-serif;padding:35px;box-sizing:border-box"><small>SYNTHETIC TEST ARTWORK</small><h1>From idea to impact</h1><p style="color:#ff7557">Imagine → Build → Improve</p></div>');
  const bytes=await page.locator('div').screenshot();
  const form=new FormData();form.append('file',new Blob([bytes],{type:'image/png'}),'demo-roadmap.png');
  const upload=await product.app.request('/api/files',{method:'POST',headers:{cookie},body:form});assert.equal(upload.status,201);
  const {id}=await upload.json();
  await emit('message.created',{text:'Here is the generated graphic. Open it for the full-size image.',attachments:[{fileId:id,name:'demo-roadmap.png',mime:'image/png',size:bytes.length},{fileId:id,name:'editable-source.svg',mime:'image/svg+xml',size:320}]});
  await page.goto(base+'/?view=projects&project='+project.id);
  const image=page.getByRole('img',{name:'demo-roadmap.png',exact:true});
  await image.waitFor();await image.scrollIntoViewIfNeeded();
  await image.evaluate((img:HTMLImageElement)=>img.decode());
  assert.equal(await page.getByRole('img',{name:'editable-source.svg'}).count(),0);
  assert.equal(await page.getByRole('link',{name:'Open demo-roadmap.png'}).getAttribute('href'),'/api/files/'+id);
  await page.screenshot({path:'docs/screenshots/image-attachments-desktop.png',fullPage:true});
  await page.setViewportSize({width:390,height:844});
  await page.locator('summary').filter({hasText:'Project details'}).click();
  await image.scrollIntoViewIfNeeded();
  assert(await image.evaluate(img=>img.getBoundingClientRect().width<=innerWidth));
  await page.screenshot({path:'docs/screenshots/image-attachments-mobile.png',fullPage:true});
  // A failed image keeps a usable file link and a readable fallback.
  await emit('message.created',{text:'Missing image test',attachments:[{fileId:'missing-demo-image',name:'missing.png',mime:'image/png'}]});
  await page.reload();await page.getByText('Preview unavailable. Open the file using the link above.').waitFor();
  assert.equal(await page.getByRole('link',{name:'missing.png',exact:true}).count(),1);
  console.log('PASS: real uploaded image preview, original file link, SVG link-only, mobile fit, failed-image fallback.');
 } finally { await browser.close(); }
} finally {server.kill('SIGTERM');engine.db.close();product.store.db.close();rmSync(dir,{recursive:true,force:true});}
