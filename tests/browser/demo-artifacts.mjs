import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdirSync, mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {createRequire} from 'node:module';
const req=createRequire(join(process.cwd(),'apps/user-ui/package.json'));
const server=spawn(process.execPath,[join(dirname(req.resolve('vite/package.json')),'bin/vite.js'),'--host','127.0.0.1','--port','5307','--strictPort'],{cwd:join(process.cwd(),'apps/user-ui'),stdio:'pipe'});
const screenshots=join(process.cwd(),'docs/images/validation/demo-artifacts');mkdirSync(screenshots,{recursive:true});
try{
 await new Promise((resolve,reject)=>{
  const timer=setTimeout(()=>reject(Error('Vite timeout')),20000);
  server.stdout.on('data',c=>{if(c.toString().includes('5307')){clearTimeout(timer);resolve();}});
  server.on('error',reject);
 });
 const browser=await chromium.launch();
 try{
  const page=await browser.newPage({viewport:{width:1440,height:1000}});page.setDefaultTimeout(10000);
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  const writes=[];
  const agents=[{name:'PuffVitaliy',visibility:'PUBLIC'},{name:'PuffNaska',visibility:'PUBLIC'},{name:'Moss',visibility:'PUBLIC'},{name:'SecretAgent',visibility:'PRIVATE',ownerHumanId:'someone-else'}];
  const participants=[{subscriberType:'AGENT',subscriberId:'PuffVitaliy'},{subscriberType:'AGENT',subscriberId:'PuffNaska'},{subscriberType:'HUMAN',subscriberId:'vitaliy@example.com'},{subscriberType:'HUMAN',subscriberId:'naska@example.com'}];
  await page.routeWebSocket('**/ws',()=>{});
  await page.route('**/api/**',async route=>{
   const r=route.request(),u=new URL(r.url());let data=[];
   if(r.method()!=='GET'){
    assert.equal(u.pathname,'/api/messages');writes.push(r.postDataJSON());data={id:`event-${writes.length}`};
   } else if(u.pathname==='/api/auth/me')data={id:'me',username:'demo'};
   else if(u.pathname==='/api/branding')data={displayName:'Camplight',logoUrl:'/brand/camplight-logo-white.svg',primaryColor:'#350956',accentColor:'#ff7557',backgroundColor:'#f8f4ff'};
   else if(u.pathname==='/api/agents')data=agents;
   else if(u.pathname==='/api/humans')data=[{username:'vitaliy@example.com'},{username:'naska@example.com'}];
   else if(u.pathname==='/api/events' && u.searchParams.get('type')==='message.created') data=[{id:'demo-message',channelId:'chat',source:'agent:PuffVitaliy',type:'message.created',createdAt:Date.now(),payload:{text:'Here is the [launch demo](http://127.0.0.1:5307/demo/launch). Tell me what to change.'}}];
   else if(u.pathname==='/api/mentions')data={items:[]};
   else if(u.pathname==='/api/channels')data=[{id:'chat',name:'Product planning',visibility:'PUBLIC',canPost:true,participants},{id:'readonly',name:'Read only',visibility:'PUBLIC',canPost:false,participants}];
   await route.fulfill({json:data});
  });
  await page.goto('http://127.0.0.1:5307/?channel=chat');
  let publishedRevision=1, headRequests=0;
  await page.route('**/demo/launch?*',route=>{if(route.request().method()==='HEAD')headRequests++;return route.fulfill({headers:{etag:String(publishedRevision)},contentType:'text/html',body:'<!doctype html><html><body style="font-family:system-ui;padding:30px;background:#f6f0ff"><small>PRODUCT LAUNCH</small><h1>Build something great.</h1><p>Your next idea starts here.</p><button onclick="this.textContent=\'Started\'">Get started</button></body></html>'});});
  await page.getByRole('button',{name:'Preview launch'}).click();
  const panel=page.getByRole('complementary',{name:'Demo artifact preview'});
  await panel.waitFor();
  await panel.getByText('Auto-refresh on',{exact:true}).waitFor();
  await page.waitForTimeout(200);
  assert.equal(await panel.locator('iframe').getAttribute('sandbox'),'allow-scripts');
  await page.frameLocator('iframe[title="Demo preview"]').getByRole('button',{name:'Get started'}).click();
  await page.frameLocator('iframe[title="Demo preview"]').getByRole('button',{name:'Started',exact:true}).waitFor();
  const initialHeads=headRequests;
  await page.waitForFunction(()=>true);
  await new Promise(resolve=>setTimeout(resolve,3500));
  assert(headRequests>initialHeads);
  await page.frameLocator('iframe[title="Demo preview"]').getByRole('button',{name:'Started',exact:true}).waitFor();
  publishedRevision++;
  await page.frameLocator('iframe[title="Demo preview"]').getByRole('button',{name:'Get started',exact:true}).waitFor();
  const input=page.getByRole('textbox',{name:'Message',exact:true});
  await input.fill('Keep the colors.');
  await panel.getByRole('button',{name:'Request changes'}).click();
  assert.equal(await input.inputValue(),'Keep the colors.\n\nPlease update http://127.0.0.1:5307/demo/launch: ');
  assert.equal(writes.length,0);
  await panel.getByRole('button',{name:'Refresh preview'}).click();
  await page.frameLocator('iframe[title="Demo preview"]').getByRole('button',{name:'Get started'}).waitFor();
  await page.screenshot({path:join(screenshots,'desktop.png'),fullPage:true});
  await panel.getByRole('button',{name:'Phone width'}).click();
  assert.equal(await panel.getByRole('button',{name:'Phone width'}).getAttribute('aria-pressed'),'true');
  await page.setViewportSize({width:390,height:844});
  await panel.scrollIntoViewIfNeeded();
  await page.frameLocator('iframe[title="Demo preview"]').getByRole('heading',{name:'Build something great.'}).waitFor();
  await page.waitForTimeout(400);
  await page.screenshot({path:join(screenshots,'mobile.png'),fullPage:true});
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await panel.getByRole('button',{name:'Close artifact preview'}).click();
  assert.equal(await panel.count(),0);
  await page.goto('http://127.0.0.1:5307/?channel=readonly');
  assert.equal(await panel.count(),0);
  await page.getByRole('button',{name:'Preview launch'}).click();
  assert(await panel.getByRole('button',{name:'Request changes'}).isDisabled());
  assert.deepEqual(errors,[]);console.log('PASS: preview, isolated interaction, draft preservation, no automatic send, refresh, phone width, close, responsive layouts. Synthetic screenshots.');

 }finally{await browser.close();}
}finally{server.kill('SIGTERM');}
