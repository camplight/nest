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
// The connections skill declares the app-change event; its shapes import zod, so read them from the repo.
process.env.ORGOPS_SKILL_ROOTS=join(process.cwd(),'skills');
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
 const original=await post('/api/events',{type:'message.created',source:'human:demo-owner',channelId:project.channelId,payload:{text:'Prepare a launch draft for review.'}},headers);
 const originalId=(await original.json()).id;assert(originalId);
 await emit('agent.turn.started',{triggerEventId:originalId});await emit('telemetry.context.window.updated',{agentName:'Demo',modelId:'fixture',estimatedUsedTokens:1200,contextWindowTokens:32000,estimatedAvailableTokens:30800,utilizationPct:3.75,messageCount:1,systemChars:0,systemContextChars:0,historyChars:120});await emit('tool.started',{tool:'Search',args:{query:'Demo launch ideas'}});await emit('tool.executed',{tool:'Search',output:'Found three demo references'});await emit('process.output',{stream:'STDERR',text:'Synthetic diagnostic output'});await emit('process.exited',{exitCode:1});
 const appChange=async(title:string,outcome:string,requestId:string)=>{const response=await post('/api/events',{type:'telemetry.nest.connection.action',source:'system:nest-connections',channelId:project.channelId,status:'DELIVERED',payload:{agentName:'Demo',connectionId:'synthetic-connection',app:'miro',tool:'MIRO_SYNTHETIC',title,change:'create',outcome,requestId}},{'content-type':'application/json','x-nest-runner-token':'test-runner'});assert.equal(response.status,201,await response.text());};
 await appChange('Create sticky note item','ok','synthetic-1');await appChange('Delete card','unknown','synthetic-2');
 await emit('message.created',{text:'Synthetic retained history. '.repeat(3000)});
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
  await page.getByText('[Message too large to display. The original content is retained.]',{exact:true}).waitFor();
  await page.locator('.working-row[data-agent=Demo][data-turn-state=working]').waitFor();
  const sharing=page.getByRole('button',{name:'Chat settings',exact:true});
  await sharing.waitFor({state:'visible'});
  assert.equal(await page.locator('.chat-header-actions').getByRole('button',{name:'Huddle',exact:true}).count(),1);
  await sharing.focus();await page.keyboard.press('Enter');
  await page.getByRole('heading',{name:'Chat settings',exact:true}).waitFor();
  await page.getByLabel('Visibility',{exact:true}).selectOption('PUBLIC');
  await page.getByRole('button',{name:'Save',exact:true}).click();
  await page.getByRole('heading',{name:'Chat settings',exact:true}).waitFor({state:'hidden'});
  const channelList=await product.app.request('/api/channels',{headers});
  assert.equal(channelList.status,200);
  assert.equal((await channelList.json()).find((channel:{id:string})=>channel.id===project.channelId).visibility,'PUBLIC');
  await sharing.click();
  await page.getByLabel('Visibility',{exact:true}).selectOption('PRIVATE');
  await page.getByRole('button',{name:'Save',exact:true}).click();
  await page.getByRole('heading',{name:'Chat settings',exact:true}).waitFor({state:'hidden'});
  if(process.env.CI)console.log('SHARING_DESKTOP_JPEG:'+(await page.screenshot({type:'jpeg',quality:65})).toString('base64'));

  // Deleting asks inside the dialog, never with a native browser confirm.
  const nativeDialogs:string[]=[];page.on('dialog',dialog=>{nativeDialogs.push(dialog.message());void dialog.dismiss();});
  const doomed=await(await post('/api/channels',{name:'Channel to delete',visibility:'PRIVATE'},headers)).json();
  await page.goto(base+'/?channel='+doomed.id);
  await page.getByRole('button',{name:'Chat settings',exact:true}).click();
  await page.getByRole('heading',{name:'Chat settings',exact:true}).waitFor();
  // Archive acts at once: the header shows the Archived tag, and Unarchive brings the chat back.
  await page.getByRole('button',{name:'Archive chat',exact:true}).click();
  await page.getByRole('button',{name:'Unarchive chat',exact:true}).waitFor();
  await page.getByRole('button',{name:'Close dialog',exact:true}).click();
  await page.locator('.chat-header-actions .chat-archived-tag').getByText('Archived',{exact:true}).waitFor();
  await page.locator('.chat-header-actions').getByRole('button',{name:'Unarchive',exact:true}).click();
  await page.locator('.chat-header-actions .chat-archived-tag').waitFor({state:'detached'});
  await page.getByRole('button',{name:'Chat settings',exact:true}).click();
  await page.getByRole('heading',{name:'Chat settings',exact:true}).waitFor();
  await page.getByRole('button',{name:'Delete chat',exact:true}).click();
  const confirmDelete=page.getByRole('group',{name:'Confirm chat deletion'});
  await confirmDelete.getByText('Permanently delete',{exact:false}).first().waitFor();
  await page.screenshot({path:join(screenshots,'delete-confirm-desktop.png')});
  await confirmDelete.getByRole('button',{name:'Cancel',exact:true}).click();
  await confirmDelete.waitFor({state:'hidden'});
  await page.getByRole('button',{name:'Delete chat',exact:true}).click();
  await confirmDelete.getByRole('button',{name:'Delete permanently',exact:true}).click();
  await page.getByRole('heading',{name:'Chat settings',exact:true}).waitFor({state:'hidden'});
  const afterDelete=await(await product.app.request('/api/channels?includeArchived=1',{headers})).json() as {id:string}[];
  assert(!afterDelete.some(channel=>channel.id===doomed.id),'the confirmed channel is deleted');
  assert.deepEqual(nativeDialogs,[],'no native confirm dialog appears');
  await page.goto(chatUrl);
  await page.getByRole('textbox',{name:'Message',exact:true}).waitFor();

  // The sidebar width can be dragged or set with the keyboard, is remembered per browser and resets on double-click.
  const sidebarWidth=async()=>Math.round((await page.locator('aside.sidebar').boundingBox())!.width);
  const resizer=page.getByRole('separator',{name:'Resize sidebar'});
  assert.equal(await sidebarWidth(),248);
  const handle=(await resizer.boundingBox())!;
  await page.mouse.move(handle.x+handle.width/2,handle.y+300);await page.mouse.down();
  await page.mouse.move(handle.x+handle.width/2+80,handle.y+300,{steps:4});await page.mouse.up();
  assert.equal(await sidebarWidth(),328,'dragging widens the sidebar');
  await resizer.focus();await page.keyboard.press('ArrowLeft');
  assert.equal(await sidebarWidth(),312,'arrow keys resize');
  await page.reload();await page.getByRole('textbox',{name:'Message',exact:true}).waitFor();
  assert.equal(await sidebarWidth(),312,'the width survives a reload');
  await page.screenshot({path:join(screenshots,'sidebar-resized-desktop.png')});
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  // The agent/standalone chat layout uses a different shell grid; it must follow the same width.
  await page.goto(base+'/?channel='+other.id);
  await page.getByPlaceholder(/Message to # Other demo chat/).waitFor();
  assert.equal(await sidebarWidth(),312,'the chat layout uses the chosen width');
  await resizer.focus();await page.keyboard.press('ArrowRight');
  assert.equal(await sidebarWidth(),328,'resizing works in the chat layout');
  await resizer.dblclick();
  assert.equal(await sidebarWidth(),248,'double-click resets');
  await page.goto(chatUrl);await page.getByRole('textbox',{name:'Message',exact:true}).waitFor();
  await page.setViewportSize({width:390,height:844});
  assert.equal(await resizer.isVisible(),false,'phones keep the drawer without a resize handle');
  await page.setViewportSize({width:1440,height:1000});
  // A short window makes the thread scroll; the header row gets a divider only while messages pass under it.
  await page.setViewportSize({width:1440,height:560});
  const panel=page.locator('.messages-panel');
  assert(await panel.evaluate(node=>node.scrollHeight>node.clientHeight+10),'the thread scrolls in a short window');
  await panel.evaluate(node=>{node.scrollTop=node.scrollHeight;});
  await page.locator('.nest-chat.is-scrolled').waitFor();
  assert.notEqual(await page.locator('.chat-header-actions').evaluate(node=>getComputedStyle(node).borderBottomColor),'rgba(0, 0, 0, 0)','scrolled messages show where the header row ends');
  await page.waitForTimeout(200);
  await page.screenshot({path:join(screenshots,'header-divider-scrolled-desktop.png')});
  await panel.evaluate(node=>{node.scrollTop=0;});
  await page.waitForFunction(()=>!document.querySelector('.nest-chat.is-scrolled'));
  await page.setViewportSize({width:1440,height:1000});

  await page.screenshot({path:join(screenshots,'interrupted-before-desktop.png'),fullPage:true});
  await page.screenshot({path:join(screenshots,'retained-message-desktop.png'),fullPage:true});
  await page.setViewportSize({width:390,height:844});
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  const projectDetails=page.locator('.project-context-disclosure');
  const detailsWereOpen=await projectDetails.getAttribute('open')!==null;
  if(detailsWereOpen)await projectDetails.locator('summary').click();
  assert(await sharing.isVisible());
  assert((await sharing.boundingBox())!.height>=44);
  await sharing.click();await page.getByLabel('Visibility',{exact:true}).waitFor();
  if(process.env.CI)console.log('SHARING_MOBILE_JPEG:'+(await page.screenshot({type:'jpeg',quality:65})).toString('base64'));
  await page.getByRole('button',{name:'Close dialog',exact:true}).click();

  await page.getByText('[Message too large to display. The original content is retained.]',{exact:true}).waitFor();
  await page.screenshot({path:join(screenshots,'retained-message-mobile.png'),fullPage:true});
  if(detailsWereOpen)await projectDetails.locator('summary').click();
  await page.setViewportSize({width:1440,height:1000});
  // An actual lifecycle event in a different channel interrupts pre-restart work.
  const reboot=await post('/api/events',{type:'agent.lifecycle.started',source:'system:runner',channelId:other.id,payload:{targetAgentName:'Demo',text:'Synthetic restart',startedAt:Date.now()}},{'content-type':'application/json','x-nest-runner-token':'test-runner'});
  assert.equal(reboot.status,201);await page.reload();
  const interrupted=page.locator('.working-row[data-agent=Demo][data-turn-state=interrupted]');await interrupted.waitFor();
  assert.equal(await interrupted.locator('.animate-pulse').count(),0);
  await interrupted.getByRole('button',{name:'Review request',exact:true}).click();
  await page.waitForURL(url=>url.searchParams.get('message')===originalId);
  assert.equal(sends,0,'Reviewing interrupted work must never resend it');
  await page.screenshot({path:join(screenshots,'interrupted-desktop.png'),fullPage:true});
  await page.setViewportSize({width:390,height:844});
  const details=page.locator('.project-context-disclosure');if(await details.getAttribute('open')!==null)await details.locator('summary').click();
  await interrupted.scrollIntoViewIfNeeded();assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await page.screenshot({path:join(screenshots,'interrupted-mobile.png'),fullPage:true});
  await page.setViewportSize({width:1440,height:1000});
  // A new turn after the restart stays active until its own terminal event.
  await emit('agent.turn.started',{triggerEventId:'fresh-trigger'});await page.reload();
  await page.locator('.working-row[data-agent=Demo][data-turn-state=working]').waitFor();
  // Before the first action the ring says nothing has happened yet instead of showing an empty card.
  await page.locator('.working-row[data-agent=Demo][data-turn-state=working]').hover();
  await page.locator('.working-ring').getByText('No actions yet. Tools and apps Demo uses will appear here.',{exact:true}).waitFor();
  assert.equal(await page.locator('.working-ring .working-ring-orbit').count(),1);
  await page.waitForTimeout(400);await page.screenshot({path:join(screenshots,'working-ring-empty.png'),fullPage:true});
  await page.mouse.move(5,5);await page.locator('.working-ring').waitFor({state:'hidden'});
  // Hovering or focusing the working row opens the live ring: action names only, never arguments or output.
  await emit('tool.started',{tool:'shell_run',args:{cmd:'echo synthetic-secret-arg'}});
  await emit('tool.executed',{tool:'shell_run',args:{cmd:'echo synthetic-secret-arg'},output:'synthetic-secret-output'});
  await appChange('Create card','ok','synthetic-ring-1');
  await appChange('Create card','ok','synthetic-ring-2');
  await page.reload();
  const workingRow=page.locator('.working-row[data-agent=Demo][data-turn-state=working]');
  await workingRow.hover();
  const ring=page.locator('.working-ring');await ring.waitFor();
  assert.equal(await ring.locator('.ring-pulse').count(),0,'Actions from before the card opened never pulse');
  for(const text of ['Shell · ran a command','Miro · Create card','3 actions','Demo is thinking…'])await ring.getByText(text,{exact:true}).waitFor();
  // Repeats in a row share one line with a count.
  assert.equal(await ring.locator('.working-ring-feed li',{hasText:'Miro · Create card'}).count(),1);
  await ring.locator('.working-ring-feed li',{hasText:'Miro · Create card'}).getByText('×2',{exact:true}).waitFor();
  assert.equal(await ring.locator('.working-ring-station',{hasText:'Shell'}).count(),1);
  assert.equal(await ring.locator('.working-ring-station',{hasText:'Miro'}).count(),1);
  const ringText=await ring.innerText();
  assert(!ringText.includes('synthetic-secret-arg')&&!ringText.includes('synthetic-secret-output'),'The ring never shows arguments or output');
  await page.waitForTimeout(400);await page.screenshot({path:join(screenshots,'working-ring-desktop.png'),fullPage:true});
  // On a laptop-height window the card never covers the composer and keeps its place as actions arrive.
  await page.setViewportSize({width:1440,height:900});await page.mouse.move(5,5);await ring.waitFor({state:'hidden'});
  await workingRow.scrollIntoViewIfNeeded();await workingRow.hover();await ring.waitFor();await page.waitForTimeout(400);
  const composerBox=(await page.locator('.nest-chat-composer').boundingBox())!;
  const ringBefore=(await ring.boundingBox())!;
  assert(ringBefore.y+ringBefore.height<=composerBox.y,`The ring covers the composer (${ringBefore.y+ringBefore.height} > ${composerBox.y})`);
  await emit('tool.started',{tool:'fs_read',args:{path:'/synthetic-secret-path'}});await emit('tool.executed',{tool:'fs_read',output:'synthetic-secret-output'});
  await ring.getByText('4 actions',{exact:true}).waitFor();await page.waitForTimeout(300);
  const ringAfter=(await ring.boundingBox())!;
  assert.deepEqual([ringAfter.y,ringAfter.height],[ringBefore.y,ringBefore.height],'The ring keeps its size and place while actions arrive');
  // A running command names itself in the header with how long it has run.
  await emit('tool.started',{tool:'shell_run',args:{cmd:'sleep synthetic-secret-arg'}});
  await ring.getByText(/^Demo is waiting on a command · \d+s$/).waitFor();
  await emit('tool.executed',{tool:'shell_run',output:'synthetic-secret-output'});
  await ring.getByText('Demo is thinking…',{exact:true}).waitFor();
  await page.setViewportSize({width:1440,height:1000});
  await page.keyboard.press('Escape');await ring.waitFor({state:'hidden'});
  await page.mouse.move(5,5);
  await workingRow.focus();await ring.waitFor();
  await page.evaluate(()=>localStorage.setItem('nest-theme','dark'));await page.reload();
  await workingRow.hover();await ring.waitFor();await ring.getByText('Shell · ran a command',{exact:true}).first().waitFor();
  await page.waitForTimeout(400);await page.screenshot({path:join(screenshots,'working-ring-dark.png'),fullPage:true});
  await page.evaluate(()=>localStorage.removeItem('nest-theme'));await page.mouse.move(5,5);
  await emit('agent.turn.completed',{triggerEventId:'fresh-trigger'});await page.reload();
  await page.getByRole('textbox',{name:'Message',exact:true}).waitFor();
  await page.getByText('[Message too large to display. The original content is retained.]',{exact:true}).waitFor();
  await page.locator('.working-row[data-agent=Demo]').waitFor({state:'hidden'});
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
  await page.getByPlaceholder(/Message to # Other demo chat/).waitFor();
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
  // App changes read as lines under the reply; the raw event boxes wait behind Details.
  await page.goto(chatUrl);
  const turn=page.locator('.turn-activity').filter({hasText:'Miro · Create sticky note item'});
  await turn.getByText('Miro · Create sticky note item',{exact:true}).waitFor();
  await turn.getByText('Miro · Delete card may not have finished. Check Miro before trying again',{exact:true}).waitFor();
  assert.equal(await turn.locator('.trace-chip').count(),0,'Raw events stay hidden until Details is opened');
  // Hovering the agent's avatar on a finished reply shows that turn's ring, still.
  await page.locator('article.message',{has:turn}).locator('.reply-ring-trigger').hover();
  const finishedRing=page.locator('.working-ring');await finishedRing.waitFor();
  await finishedRing.getByText(/^Demo (worked for|failed after|stopped after) \d+s$/).waitFor();
  await finishedRing.locator('.working-ring-feed').getByText('Miro · Create sticky note item',{exact:true}).waitFor();
  assert.equal(await finishedRing.locator('.ring-pulse').count(),0,'A finished ring never pulses');
  await page.waitForTimeout(400);await page.screenshot({path:join(screenshots,'reply-ring-desktop.png'),fullPage:true});
  await page.mouse.move(5,5);await finishedRing.waitFor({state:'hidden'});
  assert.equal(await page.locator('.message-human .turn-activity').count(),0,"Activity never sits under the person's question");
  // A turn that never replied stands on its own, so its control names the agent (spec: under the agent's name).
  await page.locator('.turn-activity-details > summary',{hasText:'Demo · Details'}).first().waitFor();
  assert.equal(await turn.locator('.turn-activity-details > summary').innerText(),'Details','Inside a reply, the control stays short');
  await turn.scrollIntoViewIfNeeded();
  await page.screenshot({path:join(screenshots,'activity-lines-desktop.png'),fullPage:true});
  await turn.locator('.turn-activity-details > summary').click();
  // Tiny event boxes retain the original footprint; names are opt-in.
  const activity=page.getByRole('article',{name:'Agent activity'}).filter({has:page.getByRole('button',{name:'Agent process stopped with an error',exact:true})});
  await activity.getByRole('button',{name:'Agent process stopped with an error',exact:true}).waitFor();
  await activity.scrollIntoViewIfNeeded();
  assert.equal(await activity.locator('.trace-chip').count(),8);
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
  const mobileTurn=mobile.locator('.turn-activity').filter({hasText:'Miro · Create sticky note item'});
  await mobileTurn.getByText('Miro · Delete card may not have finished. Check Miro before trying again',{exact:true}).waitFor();
  await mobileTurn.scrollIntoViewIfNeeded();
  await mobile.screenshot({path:join(screenshots,'activity-lines-mobile.png'),fullPage:true});
  await mobileTurn.locator('.turn-activity-details > summary').tap();
  const mobileActivity=mobile.getByRole('article',{name:'Agent activity'}).filter({has:mobile.getByRole('button',{name:'Agent process stopped with an error',exact:true})}),mobileFailure=mobileActivity.getByRole('button',{name:'Agent process stopped with an error',exact:true});
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
  // An agent adding someone to the chat updates People & agents live: the engine posts no join event, so the tool result does.
  assert.equal((await post('/api/agents',{name:'LateDemo',visibility:'PUBLIC',modelId:'test-model',workspacePath:join(dir,'late-agent')},headers)).status,201);
  assert.equal((await post(`/api/channels/${preview.channelId}/subscribe`,{subscriberType:'AGENT',subscriberId:'LateDemo'},headers)).status,200);
  assert.equal(await page.locator('.project-assignee',{hasText:'LateDemo'}).count(),0,'The page has not reloaded the members yet');
  assert.equal((await post('/api/events',{type:'tool.executed',source:'agent:PuffDemo',channelId:preview.channelId,payload:{tool:'events_channel_participant_add',args:{channelId:preview.channelId,subscriberType:'AGENT',subscriberId:'LateDemo'},output:{ok:true}}},{'content-type':'application/json','x-nest-runner-token':'test-runner'})).status,201);
  await page.locator('.project-assignee',{hasText:'LateDemo'}).waitFor({state:'attached',timeout:25_000});
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
  // A turn that fails without replying stands on its own under the agent's name, never inside the question.
  const question=await post('/api/events',{type:'message.created',source:'human:demo-owner',channelId:project.channelId,payload:{text:'Synthetic question before a failed turn'}},headers);
  assert.equal(question.status,201);const questionId=((await question.json()) as {id:string}).id;
  await emit('agent.turn.started',{triggerEventId:questionId});
  await emit('agent.turn.failed',{triggerEventId:questionId,error:'Error: Invalid image input for this synthetic model. More detail.'});
  await page.goto(chatUrl);
  const failedTurn=page.getByText("Demo couldn't finish: this model can't read images.",{exact:true});await failedTurn.waitFor();
  assert.equal(await page.locator('.message-human .turn-activity').count(),0,"A failed turn never sits inside the person's question");
  assert.equal(await page.locator('.turn-activity',{has:failedTurn}).locator('.turn-activity-details > summary').innerText(),'Demo · Details');
  // Three agent messages collapse without changing stored history; links reveal hidden replies.
  const foldReply=async(text:string,agentName='PuffDemo')=>{
   const response=await post('/api/events',{type:'message.created',source:'agent:'+agentName,channelId:preview.channelId,payload:{text}},{'content-type':'application/json','x-nest-runner-token':'test-runner'});
   assert.equal(response.status,201);return (await response.json()).id as string;
  };
  assert.equal((await post('/api/agents',{name:'NestSystem',visibility:'PUBLIC',modelId:'test-model',workspacePath:join(dir,'fold-agent')},headers)).status,201);
  assert.equal((await post('/api/projects/'+preview.id+'/members',{subscriberType:'AGENT',subscriberId:'NestSystem'},headers)).status,200);
  const hiddenReply=await foldReply('The layout review is ready.','NestSystem');
  await foldReply('Final recommendation: simplify the homepage and keep the primary action visible.');
  const foldUrl=base+'/?view=projects&project='+preview.id+'&tab=chat';
  await page.setViewportSize({width:1440,height:1000});await page.goto(foldUrl);
  const expand=page.getByRole('button',{name:'Show 2 earlier agent messages',exact:true});
  await expand.waitFor();assert.equal(await expand.getAttribute('aria-expanded'),'false');
  assert.equal(await expand.locator('.agent-portrait').count(),2,'Repeated agents appear once in the avatar stack');
  assert((await expand.locator('.agent-portrait img').first().getAttribute('src'))?.endsWith('/design/avatars/pom.png'),'Fold portraits respect configured avatars');
  assert.equal(await expand.getAttribute('title'),'Participants: PuffDemo, NestSystem');
  assert.equal(await page.getByText('The layout review is ready.',{exact:true}).count(),0);
  await page.getByText('Final recommendation: simplify the homepage and keep the primary action visible.',{exact:true}).waitFor();
  if(process.env.CI)console.log('AGENT_FOLD_DESKTOP_JPEG:'+(await page.screenshot({type:'jpeg',quality:65})).toString('base64'));
  await expand.focus();await page.keyboard.press('Enter');
  await page.getByText('The layout review is ready.',{exact:true}).waitFor();
  const collapse=page.getByRole('button',{name:'Hide 2 earlier agent messages',exact:true});
  assert.equal(await collapse.getAttribute('aria-expanded'),'true');await collapse.click();
  await expand.waitFor();
  await page.setViewportSize({width:390,height:844});
  if(await page.locator('.project-context-disclosure').getAttribute('open')!==null)await page.locator('.project-context-disclosure > summary').click();
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  if(process.env.CI)console.log('AGENT_FOLD_MOBILE_JPEG:'+(await page.screenshot({type:'jpeg',quality:65})).toString('base64'));
  await page.goto(foldUrl+'&message='+hiddenReply);
  await page.locator(`[data-message-id="${hiddenReply}"].message-highlight`).waitFor();
  await page.getByText('The layout review is ready.',{exact:true}).waitFor();
  await page.getByRole('button',{name:'Hide 2 earlier agent messages',exact:true}).click();
  await expand.waitFor();
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
 }catch(error){console.error('CHAT_BROWSER_FAILURE',error);throw error;}finally{releaseUpload?.();await browser.close();}
}finally{server.kill('SIGTERM');engine.db.close();product.store.db.close();rmSync(dir,{recursive:true,force:true});}
