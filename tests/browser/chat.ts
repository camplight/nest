import {chromium,type Route,type Page} from 'playwright';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {createRequire} from 'node:module';
import {createEngine} from './engine';
import {createOrgOpsClient} from '../../packages/orgops-client/src/index';
import {createApp} from '../../apps/api/src/app';
const dir=mkdtempSync(join(tmpdir(),'nest-chat-test-')),screenshots=mkdtempSync(join(tmpdir(),'nest-chat-screenshots-'));
const engine=createEngine({dbPath:join(dir,'engine.sqlite'),projectRoot:dir,dataDir:dir,adminUser:'demo-owner',adminPass:'password',runnerToken:'test-runner'});
const product=createApp({orgops:createOrgOpsClient('http://engine',async(url,init)=>engine.app.fetch(new Request(url,init))),dbPath:join(dir,'product.sqlite'),connections:null});
const req=createRequire(join(process.cwd(),'apps/user-ui/package.json'));
const server=spawn(process.execPath,[join(dirname(req.resolve('vite/package.json')),'bin/vite.js'),'--host','127.0.0.1','--port','5314','--strictPort'],{cwd:join(process.cwd(),'apps/user-ui'),stdio:'pipe'});
server.stderr.on('data',chunk=>process.stderr.write(chunk));
const base='http://127.0.0.1:5314';
try{
 await new Promise<void>((resolve,reject)=>{const timeout=setTimeout(()=>reject(Error('Vite timeout')),20000);server.on('error',reject);server.on('exit',code=>reject(Error(`Vite exited ${code}`)));server.stdout.on('data',c=>{if(c.toString().includes('5314')){clearTimeout(timeout);resolve();}});});
 const post=(path:string,body:unknown,headers:Record<string,string>)=>product.app.request(path,{method:'POST',headers,body:JSON.stringify(body)});
 const login=await post('/api/auth/login',{username:'demo-owner',password:'password'},{'content-type':'application/json'});
 const cookie=login.headers.getSetCookie()[0].split(';')[0],headers={cookie,'content-type':'application/json'};
 await product.app.request('/api/branding',{method:'PUT',headers,body:JSON.stringify({displayName:'Camplight',logoUrl:'/brand/camplight-logo-white.svg',primaryColor:'#350956',accentColor:'#ff7557',backgroundColor:'#f8f4ff'})});
 const project=await(await post('/api/projects',{id:crypto.randomUUID(),name:'Demo launch planning',description:'Synthetic test project'},headers)).json();
 assert(project.channelId);
 const other=await(await post('/api/channels',{name:'Other demo chat',visibility:'PRIVATE'},headers)).json();
 const emit=async(type:string,payload:unknown)=>{const response=await post('/api/events',{type,source:'agent:Demo',channelId:project.channelId,payload},{'content-type':'application/json','x-nest-runner-token':'test-runner'});assert.equal(response.status,201,await response.text());};
 await emit('agent.turn.started',{triggerEventId:'fixture-trigger'});await emit('telemetry.context.window.updated',{agentName:'Demo',modelId:'fixture',estimatedUsedTokens:1200,contextWindowTokens:32000,estimatedAvailableTokens:30800,utilizationPct:3.75,messageCount:1,systemChars:0,systemContextChars:0,historyChars:120});await emit('tool.started',{tool:'Search',args:{query:'Demo launch ideas'}});await emit('tool.executed',{tool:'Search',output:'Found three demo references'});await emit('process.output',{stream:'STDERR',text:'Synthetic diagnostic output'});await emit('process.exited',{exitCode:1});
 let uploads=0,sends=0,failNext=false,holdNext=false,releaseUpload:(()=>void)|undefined,uploadStarted:(()=>void)|undefined;
 const browser=await chromium.launch();
 try{
  const context=await browser.newContext({viewport:{width:1440,height:1000}});
  await context.addCookies([{name:'nest_session',value:cookie.slice('nest_session='.length),url:base,httpOnly:true}]);
  await context.routeWebSocket('**/ws',socket=>socket.close());
  const relay=async(route:Route)=>{
   const request=route.request(),u=new URL(request.url());
   if(u.pathname==='/api/files'&&request.method()==='POST'){
    uploads++;if(failNext){failNext=false;await route.fulfill({status:503,json:{error:'Synthetic upload outage'}});return;}
    if(holdNext){holdNext=false;uploadStarted?.();await new Promise<void>(resolve=>{releaseUpload=resolve;});}
   }
   if(u.pathname==='/api/messages'&&request.method()==='POST')sends++;
   const response=await product.app.request(u.pathname+u.search,{method:request.method(),headers:request.headers(),...(request.postDataBuffer()?{body:new Uint8Array(request.postDataBuffer()!)}:{})});
   await route.fulfill({status:response.status,headers:Object.fromEntries(response.headers),body:Buffer.from(await response.arrayBuffer())});
  };
  await context.route('**/api/**',relay);
  const page=await context.newPage();page.setDefaultTimeout(15000);const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
  const chatUrl=base+'/?view=projects&project='+project.id;
  await page.goto(chatUrl);
  await page.getByRole('textbox',{name:'Message',exact:true}).waitFor();
  // Plain text drags preserve normal editor/browser behaviour.
  assert.equal(await page.evaluate(()=>{const d=new DataTransfer();d.setData('text/plain','hello');return window.dispatchEvent(new DragEvent('drop',{dataTransfer:d,bubbles:true,cancelable:true}));}),true);
  async function drag(page:Page,target:string,names:string[],type='drop'){
   const data=await page.evaluateHandle(names=>{const data=new DataTransfer();for(const name of names)data.items.add(new File(['demo file bytes: '+name],name,{type:'text/plain'}));return data;},names);
   await page.locator(target).first().dispatchEvent(type,{dataTransfer:data});await data.dispose();
  }
  await drag(page,'.workspace-topbar',['brief.txt'],'dragenter');
  await page.getByText('Drop files to attach',{exact:true}).waitFor();
  await page.screenshot({path:join(screenshots,'drop-desktop.png'),fullPage:true});
  await page.keyboard.press('Escape');await page.locator('.chat-file-drop').waitFor({state:'hidden'});
  const targets=['.workspace-topbar','.messages-panel','.composer','nav[aria-label="Main navigation"]','.project-about'];
  for(let i=0;i<targets.length;i++)await drag(page,targets[i],[`demo-${i}.txt`]);
  await page.waitForFunction(()=>document.querySelectorAll('.composer-attachments article').length===5&&Array.from(document.querySelectorAll('.composer-attachments article')).every(el=>el.textContent?.includes('Ready')));
  assert.equal(sends,0,'Dropping never sends messages');
  await page.reload();await page.getByRole('button',{name:'Remove demo-4.txt',exact:true}).waitFor();
  await page.screenshot({path:join(screenshots,'attachments-desktop.png'),fullPage:true});
  await page.setViewportSize({width:390,height:844});
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await page.locator('.project-context-disclosure > summary').click();
  await page.screenshot({path:join(screenshots,'attachments-mobile.png'),fullPage:true});
  await page.setViewportSize({width:1440,height:1000});
  await page.getByRole('button',{name:'Send',exact:true}).click();
  await page.locator('.message-attachments a').filter({hasText:'demo-0.txt'}).waitFor();
  assert.equal(sends,1);
  const first=await page.locator('.message-attachments a').filter({hasText:'demo-0.txt'}).getAttribute('href');
  assert.equal(await(await product.app.request(first!,{headers})).text(),'demo file bytes: demo-0.txt','Uploaded bytes survive the real engine boundary');
  // Folders are explained and ignored; no accidental zero-byte upload.
  const beforeFolder=uploads;
  await page.evaluate("(()=>{const d=new DataTransfer();d.items.add(new File([''],'demo-folder'));const original=DataTransferItem.prototype.webkitGetAsEntry;DataTransferItem.prototype.webkitGetAsEntry=()=>({isDirectory:true});try{window.dispatchEvent(new DragEvent('drop',{dataTransfer:d,bubbles:true,cancelable:true}));}finally{DataTransferItem.prototype.webkitGetAsEntry=original;}})()");
  await page.getByRole('alert').filter({hasText:'Folders can’t be attached directly'}).waitFor();assert.equal(uploads,beforeFolder);
  await page.getByRole('button',{name:'Dismiss attachment notice'}).click();
  // Failure is actionable and blocks silent partial sends.
  failNext=true;await drag(page,'.composer',['retry.txt']);
  await page.getByRole('alert').filter({hasText:'Synthetic upload outage'}).waitFor();
  await page.getByRole('textbox',{name:'Message',exact:true}).fill('Keep my message');
  assert(await page.getByRole('button',{name:'Send',exact:true}).isDisabled());
  await page.getByRole('button',{name:'Remove retry.txt',exact:true}).click();
  // Picker and drop share the same 20-file allowance.
  await page.locator('input[type=file]').setInputFiles({name:'picker.txt',mimeType:'text/plain',buffer:Buffer.from('picker bytes')});
  await page.getByRole('textbox',{name:'Message',exact:true}).evaluate(el=>{const data=new DataTransfer();data.items.add(new File(['synthetic image bytes'],'pasted.png',{type:'image/png'}));el.dispatchEvent(new ClipboardEvent('paste',{clipboardData:data,bubbles:true,cancelable:true}));});
  await drag(page,'.composer',Array.from({length:21},(_,i)=>`limit-${i}.txt`));
  await page.getByRole('alert').filter({hasText:'You can attach up to 20 files'}).waitFor();
  await page.waitForFunction(()=>document.querySelectorAll('.composer-attachments article').length===20&&Array.from(document.querySelectorAll('.composer-attachments article')).every(el=>el.textContent?.includes('Ready')));
  while(await page.locator('.composer-attachment-remove').count())await page.locator('.composer-attachment-remove').first().click();
  await page.getByRole('textbox',{name:'Message',exact:true}).fill('');
  // Late upload results must not attach to a different channel.
  holdNext=true;const started=new Promise<void>(resolve=>{uploadStarted=resolve;});
  await drag(page,'.composer',['slow.txt']);await started;
  await page.evaluate(id=>{history.pushState({},'', '/?channel='+id);dispatchEvent(new PopStateEvent('popstate'));},other.id);
  await page.getByPlaceholder(/Message # Other demo chat/).waitFor();
  const lateMeta=page.waitForResponse(response=>/\/api\/files\/[^/]+\/meta$/.test(new URL(response.url()).pathname));
  releaseUpload!();await lateMeta;await page.evaluate(()=>new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve()))));assert.equal(await page.locator('.composer-attachments article').count(),0);
  // A new project accepts file-only first messages without creating an empty project on drop.
  await page.goto(base+'/?view=projects&create=project');
  await page.getByRole('heading',{name:'What are we working on?',exact:true}).waitFor();
  const before=(await(await product.app.request('/api/projects',{headers})).json()).length;
  await drag(page,'.project-start-composer',['launch-notes.txt']);
  await page.waitForFunction(()=>document.querySelector('.composer-attachments')?.textContent?.includes('Ready'));
  assert.equal((await(await product.app.request('/api/projects',{headers})).json()).length,before);
  await page.reload();await page.getByRole('button',{name:'Remove launch-notes.txt',exact:true}).waitFor();
  await page.getByRole('button',{name:'Send',exact:true}).click();
  await page.locator('.message-attachments a').filter({hasText:'launch-notes.txt'}).waitFor();
  assert.equal(sends,2);
  // Tiny event boxes retain the original footprint; names are opt-in.
  await page.goto(chatUrl);
  const activity=page.getByRole('article',{name:'Agent activity'});
  await activity.getByRole('button',{name:'Agent process stopped with an error',exact:true}).waitFor();
  await activity.scrollIntoViewIfNeeded();
  assert.equal(await activity.locator('.trace-chip').count(),6);
  assert.equal(await activity.locator('pre').count(),0);
  assert.equal((await activity.innerText()).trim(),'','No always-visible activity prose');
  const failure=activity.getByRole('button',{name:'Agent process stopped with an error',exact:true});
  const box=await failure.boundingBox();assert(box&&box.width===22&&box.height===22);
  await failure.hover();await page.getByRole('tooltip').filter({hasText:'Agent process stopped with an error'}).waitFor();
  await page.screenshot({path:join(screenshots,'activity-tooltip-desktop.png'),fullPage:true});
  await page.mouse.move(0,0);await failure.focus();
  await page.getByRole('tooltip').filter({hasText:'Agent process stopped with an error'}).waitFor();
  await failure.press('Enter');
  await activity.locator('.trace-detail-card').getByText('Agent process stopped with an error',{exact:true}).waitFor();
  assert.equal(await activity.locator('pre:visible').count(),0);
  await activity.getByText('Details',{exact:true}).click();assert.match(await activity.locator('pre').innerText(),/"exitCode": 1/);
  await page.screenshot({path:join(screenshots,'activity-detail-desktop.png'),fullPage:true});
  await failure.click();assert.equal(await activity.locator('pre').count(),0);
  await page.mouse.move(0,0);await page.screenshot({path:join(screenshots,'activity-desktop.png'),fullPage:true});
  const mobileContext=await browser.newContext({viewport:{width:390,height:844},hasTouch:true,isMobile:true});
  await mobileContext.addCookies([{name:'nest_session',value:cookie.slice('nest_session='.length),url:base,httpOnly:true}]);
  await mobileContext.route('**/api/**',relay);await mobileContext.routeWebSocket('**/ws',socket=>socket.close());
  const mobile=await mobileContext.newPage();mobile.on('pageerror',e=>errors.push(e.message));await mobile.goto(chatUrl);
  const mobileActivity=mobile.getByRole('article',{name:'Agent activity'}),mobileFailure=mobileActivity.getByRole('button',{name:'Agent process stopped with an error',exact:true});
  await mobileFailure.waitFor();assert.equal(await mobile.getByRole('tooltip').count(),0);
  assert(await mobile.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await mobile.screenshot({path:join(screenshots,'activity-mobile.png'),fullPage:true});
  await mobileFailure.tap();await mobileActivity.locator('.trace-detail-card').getByText('Agent process stopped with an error',{exact:true}).waitFor();
  assert.equal(await mobileActivity.locator('pre:visible').count(),0,'Touch shows the label without verbose raw output');
  await mobile.screenshot({path:join(screenshots,'activity-label-mobile.png'),fullPage:true});
  await mobileActivity.getByText('Details',{exact:true}).tap();await mobileActivity.locator('pre').waitFor();
  await mobile.screenshot({path:join(screenshots,'activity-detail-mobile.png'),fullPage:true});
  await mobileFailure.tap();assert.equal(await mobileActivity.locator('.trace-detail-card').count(),0);
  await mobileContext.close();
  // Message avatars use persisted agent choices and recorded human identities.
  const agentResponse=await post('/api/agents',{name:'PuffDemo',icon:'pom',visibility:'PUBLIC',modelId:'test-model',workspacePath:join(dir,'avatar-agent')},headers);assert.equal(agentResponse.status,201);
  const preview=await(await post('/api/projects',{id:crypto.randomUUID(),name:'Demo design review',description:'Synthetic chat avatar preview'},headers)).json();
  const humanName='sarah.mason.design.team@example.test';
  assert.equal((await post('/api/humans/invite',{username:humanName,tempPassword:'test-only-password'},headers)).status,201);
  for(const [subscriberType,subscriberId] of [['AGENT','PuffDemo'],['HUMAN',humanName]])assert.equal((await post('/api/projects/'+preview.id+'/members',{subscriberType,subscriberId},headers)).status,200);
  for(const [source,text] of [['human:'+humanName,'Can you review the homepage direction?'],['agent:PuffDemo','Yes — I’ll review the layout, accessibility and mobile experience.']])assert.equal((await post('/api/events',{type:'message.created',source,channelId:preview.channelId,payload:{text}},{'content-type':'application/json','x-nest-runner-token':'test-runner'})).status,201);
  await page.goto(base+'/?view=projects&project='+preview.id);
  const agentMessage=page.locator('.message-agent'),humanMessage=page.locator('.message-human');
  await agentMessage.getByText('PuffDemo',{exact:true}).waitFor();
  const avatar=agentMessage.locator('.agent-portrait img');
  assert((await avatar.getAttribute('src'))?.endsWith('/design/avatars/pom.png'),'Chat respects the configured character instead of the name-derived Puff avatar');
  await page.waitForFunction(()=>{const img=document.querySelector<HTMLImageElement>('.message-agent .agent-portrait img');return !!img&&img.complete&&img.naturalWidth>0;});
  assert.equal(await humanMessage.locator('.message-human-avatar').innerText(),'SA');
  assert.equal(await humanMessage.locator('.message-human-avatar').getAttribute('aria-hidden'),'true');
  await humanMessage.getByText(humanName,{exact:true}).waitFor();
  await page.screenshot({path:join(screenshots,'avatars-desktop.png'),fullPage:true});
  await page.setViewportSize({width:390,height:844});
  if(await page.locator('.project-context-disclosure').getAttribute('open')!==null)await page.locator('.project-context-disclosure > summary').click();
  for(const message of [humanMessage,agentMessage]){
    const bounds=await message.boundingBox();assert(bounds&&bounds.x>=0&&bounds.x+bounds.width<=390);
    assert(await message.evaluate(el=>el.scrollWidth<=el.clientWidth),'Long sender names and avatars fit within the message');
  }
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await page.screenshot({path:join(screenshots,'avatars-mobile.png'),fullPage:true});
  await page.route('**/design/avatars/pom.png',route=>route.fulfill({status:404,body:''}));
  await page.reload();await agentMessage.locator('.agent-portrait > span').waitFor();
  assert.equal(await agentMessage.locator('.agent-portrait > span').innerText(),'PU','Missing portraits retain the existing initials fallback');
  await page.unroute('**/design/avatars/pom.png');
  assert.equal((await post('/api/events',{type:'message.created',source:'agent:PuffDemo',channelId:other.id,payload:{text:'Standalone chat avatar preview'}},{'content-type':'application/json','x-nest-runner-token':'test-runner'})).status,201);
  await page.goto(base+'/?channel='+other.id);await page.locator('.message-agent .agent-portrait img').waitFor();
  assert((await page.locator('.message-agent .agent-portrait img').getAttribute('src'))?.endsWith('/design/avatars/pom.png'));
  await page.goto(chatUrl);
  // Archive guard: no upload request is made and a reason is visible.
  assert.equal((await post('/api/channels/'+project.channelId+'/archive',{},headers)).status,200);
  await page.goto(base+'/?channel='+project.channelId);await page.getByRole('textbox',{name:'Message',exact:true}).waitFor();
  const beforeBlocked=uploads;await drag(page,'.messages-panel',['blocked.txt']);
  await page.getByRole('alert').filter({hasText:'Restore this conversation before attaching files.'}).waitFor();
  assert.equal(uploads,beforeBlocked,'Archived chat cannot upload');
  assert.equal((await post('/api/humans/invite',{username:'demo-reader',tempPassword:'password'},headers)).status,201);
  engine.db.prepare("UPDATE humans SET must_change_password=0 WHERE username='demo-reader'").run();
  assert.equal((await post('/api/channels/'+other.id+'/share',{viewerType:'HUMAN',viewerId:'demo-reader'},headers)).status,200);
  const readerLogin=await post('/api/auth/login',{username:'demo-reader',password:'password'},{'content-type':'application/json'});
  const readerCookie=readerLogin.headers.getSetCookie()[0].split(';')[0];
  await context.addCookies([{name:'nest_session',value:readerCookie.slice('nest_session='.length),url:base,httpOnly:true}]);
  await page.goto(base+'/?channel='+other.id);await page.getByRole('textbox',{name:'Message',exact:true}).waitFor();
  assert(await page.getByRole('textbox',{name:'Message',exact:true}).isDisabled());
  await drag(page,'.messages-panel',['readonly.txt']);await page.getByRole('alert').filter({hasText:'This conversation is read-only.'}).waitFor();assert.equal(uploads,beforeBlocked);
  await page.goto(base+'/?view=projects');await page.getByRole('heading',{name:'Projects',exact:true}).waitFor();
  const beforeOffScreen=uploads;
  assert.equal(await page.evaluate(()=>{const data=new DataTransfer();data.items.add(new File(['demo'],'not-in-chat.txt'));return window.dispatchEvent(new DragEvent('drop',{dataTransfer:data,bubbles:true,cancelable:true}));}),true);
  assert.equal(uploads,beforeOffScreen,'Other product screens do not intercept file drops');
  assert.deepEqual(errors,[]);
  console.log(`PASS: whole-screen drops, picker, limits, upload failure, draft reload, late-result isolation, file-only project creation, real file bytes, compact activity, configured agent/human chat avatars, long sender names, missing-image fallback and responsive layouts. Uploads: ${uploads}. Screenshots: ${screenshots}`);
 }finally{releaseUpload?.();await browser.close();}
}finally{server.kill('SIGTERM');engine.db.close();product.store.db.close();rmSync(dir,{recursive:true,force:true});}
