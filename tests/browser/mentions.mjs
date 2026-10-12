import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {createRequire} from 'node:module';
const req=createRequire(join(process.cwd(),'apps/user-ui/package.json'));
const server=spawn(process.execPath,[join(dirname(req.resolve('vite/package.json')),'bin/vite.js'),'--host','127.0.0.1','--port','5307','--strictPort'],{cwd:join(process.cwd(),'apps/user-ui'),stdio:'pipe'});
const screenshots=mkdtempSync(join(tmpdir(),'nest-mentions-'));
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
  const participants=[{subscriberType:'AGENT',subscriberId:'PuffVitaliy'},{subscriberType:'AGENT',subscriberId:'PuffNaska'},{subscriberType:'HUMAN',subscriberId:'vitaliy@example.com'}];
  await page.routeWebSocket('**/ws',()=>{});
  await page.route('**/api/**',async route=>{
   const r=route.request(),u=new URL(r.url());let data=[];
   if(r.method()!=='GET'){
    assert.equal(u.pathname,'/api/events');writes.push(r.postDataJSON());data={id:`event-${writes.length}`};
   } else if(u.pathname==='/api/auth/me')data={id:'me',username:'demo'};
   else if(u.pathname==='/api/branding')data={displayName:'Camplight',logoUrl:'/brand/camplight-logo-white.svg',primaryColor:'#350956',accentColor:'#ff7557',backgroundColor:'#f8f4ff'};
   else if(u.pathname==='/api/agents')data=agents;
   else if(u.pathname==='/api/humans')data=[{username:'vitaliy@example.com'},{username:'naska@example.com'}];
   else if(u.pathname==='/api/channels')data=[{id:'chat',name:'Product planning',visibility:'PUBLIC',canPost:true,participants},{id:'readonly',name:'Read only',visibility:'PUBLIC',canPost:false,participants}];
   await route.fulfill({json:data});
  });
  await page.goto('http://127.0.0.1:5307/?channel=chat');
  const input=page.getByRole('textbox',{name:'Message',exact:true});
  await input.fill('@');
  const popup=page.getByRole('listbox',{name:'Mention people and agents'});
  await popup.waitFor();assert.equal(await popup.getByRole('option').count(),5);
  assert.equal(await popup.getByText('SecretAgent').count(),0);
  await input.fill('@pffvtly');assert.equal(await popup.getByRole('option').count(),1);
  await input.press('Enter');assert.equal(await input.inputValue(),'@PuffVitaliy ');assert.equal(writes.length,0);
  await input.press('Enter');await page.waitForFunction(()=>document.querySelector('textarea[aria-label="Message"]').value==='');
  assert.equal(writes.at(-1).payload.text,'@PuffVitaliy');assert.equal(writes.at(-1).channelId,'chat');
  await input.fill('@puff');await input.press('ArrowDown');await input.press('Tab');assert.equal(await input.inputValue(),'@PuffVitaliy ');assert.equal(writes.length,1);
  await input.fill('@naska');await popup.getByRole('option').filter({hasText:'naska@example.com'}).click();assert.equal(await input.inputValue(),'@naska@example.com ');
  // Selection restores the caret on the next animation frame. Finish that UI
  // interaction before replacing the draft for the next independent scenario.
  await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(resolve)));
  await input.fill('Email vitaliy@example.com');assert.equal(await popup.count(),0);
  await input.fill('Hello @pu, thanks');await input.press('Home');for(let i=0;i<9;i++)await input.press('ArrowRight');
  await popup.getByRole('option').filter({hasText:'PuffVitaliy'}).click();assert.equal(await input.inputValue(),'Hello @PuffVitaliy, thanks');
  await input.fill('@notfound');await page.getByText('No matches. Try another name.').waitFor();await input.press('Enter');assert.equal(writes.length,1);
  await input.press('Escape');assert.equal(await popup.count(),0);assert.equal(await input.inputValue(),'@notfound');
  await input.fill('@pu');await input.dispatchEvent('keydown',{key:'Enter',code:'Enter',isComposing:true});assert.equal(writes.length,1);assert.equal(await input.inputValue(),'@pu');
  await input.press('Escape');await input.press('Shift+Enter');assert.equal(await input.inputValue(),'@pu\n');
  await input.fill('@');await popup.waitFor();
  await page.screenshot({path:join(screenshots,'mentions-desktop.png'),fullPage:true,animations:'disabled'});
  await page.setViewportSize({width:390,height:844});await page.screenshot({path:join(screenshots,'mentions-mobile.png'),fullPage:true,animations:'disabled'});
  const box=await popup.boundingBox();assert(box && box.x>=0 && box.x+box.width<=390 && box.y>=0);
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await popup.getByRole('option').filter({hasText:'PuffNaska'}).click();assert.equal(await input.inputValue(),'@PuffNaska ');
  await page.goto('http://127.0.0.1:5307/?channel=readonly');assert(await input.isDisabled());assert.equal(await popup.count(),0);
  assert.deepEqual(errors,[]);console.log(`PASS: fuzzy mentions, filtered visibility, keyboard/click, caret and text preservation, no accidental send, IME, read-only and responsive UI. Screenshots: ${screenshots}`);
 }finally{await browser.close();}
}finally{server.kill('SIGTERM');}
