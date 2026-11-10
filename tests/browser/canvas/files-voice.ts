// Files (and, in Task 8, voice) on the canvas: drops on cards and areas, on the real engine, API and WS. Synthetic data.
import assert from 'node:assert/strict';
import type {Page} from 'playwright';
import {agentName,runChatTest,type ChatHarness} from '../support/chat-harness';
import {dragFiles,dropFile} from './drop';

async function call<T>(h:ChatHarness,method:string,path:string,body?:unknown):Promise<T>{
  const response=await fetch(h.apiUrl+path,{method,headers:{cookie:h.cookie,'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
  if(!response.ok)throw Error(`${method} ${path}: ${response.status} ${await response.text()}`);
  return response.status===204||response.headers.get('content-length')==='0'?undefined as T:await response.json().catch(()=>undefined) as T;
}
type Message={id:string;payload?:{text?:string;attachments?:{name:string}[]}};
/** The chat's `message.created` events as the engine holds them. */
const messages=(h:ChatHarness,channelId:string)=>call<Message[]>(h,'GET',`/api/events?type=message.created&channelId=${encodeURIComponent(channelId)}&order=asc&limit=100`);
async function messageWith(h:ChatHarness,channelId:string,names:string[]){
  for(let attempt=0;attempt<80;attempt++){
    const found=(await messages(h,channelId)).find(m=>JSON.stringify((m.payload?.attachments??[]).map(a=>a.name))===JSON.stringify(names));
    if(found)return found;
    await new Promise(resolve=>setTimeout(resolve,100));
  }
  throw Error(`no message.created with attachments ${names.join(', ')}`);
}
async function standaloneChat(h:ChatHarness,name:string){
  const {id}=await call<{id:string}>(h,'POST','/api/channels',{name,visibility:'PRIVATE'});
  await call(h,'POST',`/api/channels/${id}/subscribe`,{subscriberType:'HUMAN',subscriberId:'demo-owner'});
  await call(h,'POST',`/api/channels/${id}/subscribe`,{subscriberType:'AGENT',subscriberId:agentName});
  return id;
}
const cardAt=(page:Page,channelId:string)=>page.locator(`.canvas-card[data-channel-id="${channelId}"]`);
const openChat=(page:Page)=>page.locator('.canvas-chat');
const dock=(page:Page)=>page.getByRole('region',{name:'Start a chat',exact:true});
const areaOf=(page:Page,title:string)=>page.getByRole('region',{name:`Area ${title}`,exact:true});
const WARNING='Everyone in these chats, including their agents, can see this.';
const quiet=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));

await runChatTest('canvas files: a file dropped on a card is posted into that chat',async h=>{
  const {page,base}=h;
  const chatId=await standaloneChat(h,'Synthetic drop chat');
  const {id}=await call<{id:string}>(h,'POST','/api/canvases',{id:crypto.randomUUID(),name:'Drops'});
  await call(h,'POST',`/api/canvases/${id}/cards`,{cards:[{channelId:chatId,x:120,y:120}]});
  await page.goto(`${base}/?view=canvas&canvas=${id}`);
  const card=cardAt(page,chatId);
  await card.waitFor();
  const chat=openChat(page);
  const attachments=chat.locator('.composer-attachments');

  // A file drag over the card lights it up; leaving, dropping elsewhere and Escape each clear it.
  await dragFiles(page,`.canvas-card[data-channel-id="${chatId}"]`,['hover.txt'],'dragover');
  await page.locator(`.canvas-card[data-channel-id="${chatId}"].is-drop-target`).waitFor();
  await dragFiles(page,`.canvas-card[data-channel-id="${chatId}"]`,['hover.txt'],'dragleave');
  await page.locator(`.canvas-card[data-channel-id="${chatId}"].is-drop-target`).waitFor({state:'detached'});
  await dragFiles(page,`.canvas-card[data-channel-id="${chatId}"]`,['hover.txt'],'dragover');
  await page.locator(`.canvas-card[data-channel-id="${chatId}"].is-drop-target`).waitFor();
  await page.keyboard.press('Escape');
  await page.locator(`.canvas-card[data-channel-id="${chatId}"].is-drop-target`).waitFor({state:'detached'});
  assert.equal(await chat.count(),0,'a hover opens nothing');
  assert.equal((await messages(h,chatId)).length,0);

  // The drop opens the chat in split screen and sends the file once it is uploaded; the bottom box gets nothing.
  await dropFile(page,`.canvas-card[data-channel-id="${chatId}"]`,'brief.txt');
  await chat.waitFor();
  assert.equal(await chat.getAttribute('data-mode'),'split');
  const sent=await messageWith(h,chatId,['brief.txt']);
  assert.ok(sent.payload?.text,'the message has text');
  await chat.locator('.messages-panel').getByText('brief.txt').first().waitFor();
  assert.equal(await attachments.count(),0,'the composer is empty after the send');
  assert.equal(await dock(page).locator('.composer-attachments').count(),0,'the bottom box gets nothing');
  assert.equal((await messages(h,chatId)).length,1,'exactly one message');

  // A second drop with the chat already open posts again, and keeps the current mode.
  await dropFile(page,`.canvas-card[data-channel-id="${chatId}"]`,'again.txt');
  await messageWith(h,chatId,['again.txt']);
  assert.equal(await chat.getAttribute('data-mode'),'split');
},{canvas:true});

await runChatTest('canvas files: typing or removing a file cancels the auto-send, and more files join an upload in flight',async h=>{
  const {page,base}=h;
  const chatId=await standaloneChat(h,'Synthetic cancel chat');
  const {id}=await call<{id:string}>(h,'POST','/api/canvases',{id:crypto.randomUUID(),name:'Cancel'});
  await call(h,'POST',`/api/canvases/${id}/cards`,{cards:[{channelId:chatId,x:120,y:120}]});
  await page.goto(`${base}/?view=canvas&canvas=${id}`);
  const target=`.canvas-card[data-channel-id="${chatId}"]`;
  await cardAt(page,chatId).waitFor();
  const chat=openChat(page);
  const box=chat.getByRole('textbox',{name:'Message',exact:true});

  // Typing while an upload is in flight leaves the file queued for a manual Send.
  let held=h.holdNext('/api/files');
  await dropFile(page,target,'typed.txt');
  await held.started;
  await box.waitFor();
  await box.pressSequentially('see this');
  held.release();
  await chat.locator('.composer-attachments').getByText('typed.txt').first().waitFor();
  await chat.getByRole('button',{name:'Send',exact:true}).waitFor();
  await quiet(900);
  assert.equal((await messages(h,chatId)).length,0,'nothing was sent');
  await chat.getByRole('button',{name:'Send',exact:true}).click();
  const manual=await messageWith(h,chatId,['typed.txt']);
  assert.equal(manual.payload?.text,'see this');

  // Removing a file cancels too: the other file stays queued.
  held=h.holdNext('/api/files');
  await dragFiles(page,target,['keep.txt','drop-me.txt']);
  await held.started;
  await chat.getByRole('button',{name:'Remove drop-me.txt',exact:true}).click();
  held.release();
  await chat.locator('.composer-attachments').getByText('keep.txt').first().waitFor();
  await quiet(900);
  assert.equal((await messages(h,chatId)).length,1,'nothing more was sent');
  await chat.getByRole('button',{name:'Remove keep.txt',exact:true}).click();

  // A second drop while the first is uploading joins it: one message with both files.
  held=h.holdNext('/api/files');
  await dropFile(page,target,'first.txt');
  await held.started;
  await dropFile(page,target,'second.txt');
  await chat.locator('.composer-attachments').getByText('second.txt').first().waitFor();
  held.release();
  const both=await messageWith(h,chatId,['first.txt','second.txt']);
  assert.ok(both.id);
  assert.equal((await messages(h,chatId)).length,2,'one message for both drops');
},{canvas:true});

/** Opens `chatId`'s card in split screen and returns its chat panel. */
async function splitOpen(page:Page,chatId:string){
  await cardAt(page,chatId).locator('.canvas-card-title').click();
  const chat=openChat(page);
  await chat.waitFor();
  await chat.getByRole('button',{name:'Split screen',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('.canvas-chat')?.getAttribute('data-mode')==='split');
  return chat;
}
const humanMessages=async(h:ChatHarness,channelId:string)=>(await messages(h,channelId)).filter(m=>(m as Message&{source?:string}).source?.startsWith('human:'));

await runChatTest('canvas files: a drop on a chat with a draft or queued files queues without sending',async h=>{
  const {page,base}=h;
  const chatId=await standaloneChat(h,'Synthetic busy chat');
  const {id}=await call<{id:string}>(h,'POST','/api/canvases',{id:crypto.randomUUID(),name:'Busy'});
  await call(h,'POST',`/api/canvases/${id}/cards`,{cards:[{channelId:chatId,x:120,y:120}]});
  await page.goto(`${base}/?view=canvas&canvas=${id}`);
  await cardAt(page,chatId).waitFor();
  const target=`.canvas-card[data-channel-id="${chatId}"]`;
  const chat=await splitOpen(page,chatId);
  const box=chat.getByRole('textbox',{name:'Message',exact:true});

  // A message being written stays, and the file waits for the person's Send.
  await box.fill('half written');
  await dropFile(page,target,'with-draft.txt');
  await chat.locator('.composer-attachments').getByText('with-draft.txt').first().waitFor();
  await chat.getByRole('button',{name:'Send',exact:true}).waitFor();
  await quiet(900);
  assert.equal((await humanMessages(h,chatId)).length,0,'nothing was sent');
  assert.equal(await box.inputValue(),'half written','the draft stays');
  await chat.getByRole('button',{name:'Remove with-draft.txt',exact:true}).click();
  await box.fill('');

  // Files already queued stay queued too.
  await chat.locator('input[type=file]').setInputFiles({name:'pre.txt',mimeType:'text/plain',buffer:Buffer.from('synthetic')});
  await chat.locator('.composer-attachments').getByText('pre.txt').first().waitFor();
  await dropFile(page,target,'later.txt');
  await chat.locator('.composer-attachments').getByText('later.txt').first().waitFor();
  await chat.getByRole('button',{name:'Send',exact:true}).waitFor();
  await quiet(900);
  assert.equal((await humanMessages(h,chatId)).length,0,'nothing was sent');
  await chat.getByRole('button',{name:'Send',exact:true}).click();
  await messageWith(h,chatId,['pre.txt','later.txt']);
  assert.equal((await humanMessages(h,chatId)).length,1,'the human filter sees the manual send');
},{canvas:true});

await runChatTest('canvas files: a Quote during the upload, or opening another chat, cancels the auto-send',async h=>{
  const {page,base}=h;
  const first=await standaloneChat(h,'Synthetic first chat'),second=await standaloneChat(h,'Synthetic second chat');
  const {id}=await call<{id:string}>(h,'POST','/api/canvases',{id:crypto.randomUUID(),name:'Switch'});
  await call(h,'POST',`/api/canvases/${id}/cards`,{cards:[{channelId:first,x:120,y:120},{channelId:second,x:520,y:120}]});
  const quoted=await h.emit('message.created',{text:'Synthetic agent line to quote'},{channelId:first});
  await page.goto(`${base}/?view=canvas&canvas=${id}`);
  await cardAt(page,first).waitFor();
  const chat=await splitOpen(page,first);
  const sel=`.canvas-card[data-channel-id="${first}"]`;

  // A change to the draft that is not typing (Quote) cancels: the quote and the file wait for a manual Send.
  let held=h.holdNext('/api/files');
  await dropFile(page,sel,'quoted.txt');
  await held.started;
  const message=chat.locator(`#message-${quoted.id}`);
  await message.hover();
  await message.getByRole('button',{name:'Quote',exact:true}).click();
  held.release();
  await chat.locator('.composer-attachments').getByText('quoted.txt').first().waitFor();
  await chat.getByRole('button',{name:'Send',exact:true}).waitFor();
  await quiet(900);
  assert.equal((await humanMessages(h,first)).length,0,'the quote was not sent on its own');
  await chat.getByRole('button',{name:'Remove quoted.txt',exact:true}).click();
  await chat.getByRole('textbox',{name:'Message',exact:true}).fill('');

  // Opening another chat during the upload: nothing goes to either chat.
  held=h.holdNext('/api/files');
  await dropFile(page,sel,'moving.txt');
  await held.started;
  await cardAt(page,second).locator('.canvas-card-title').click();
  await page.waitForFunction(second=>new URL(location.href).searchParams.get('chat')===second,second);
  held.release();
  await quiet(1200);
  assert.equal((await humanMessages(h,first)).length,0,'not posted to the first chat');
  assert.equal((await humanMessages(h,second)).length,0,'and never to the second');
  assert.equal(await openChat(page).locator('.composer-attachments').getByText('moving.txt').count(),0,'the second chat has no such file');
},{canvas:true});

await runChatTest('canvas files: more than 20 files are cut with the existing error and wait for a manual send',async h=>{
  const {page,base}=h;
  const chatId=await standaloneChat(h,'Synthetic many chat');
  const {id}=await call<{id:string}>(h,'POST','/api/canvases',{id:crypto.randomUUID(),name:'Many'});
  await call(h,'POST',`/api/canvases/${id}/cards`,{cards:[{channelId:chatId,x:120,y:120}]});
  await page.goto(`${base}/?view=canvas&canvas=${id}`);
  await cardAt(page,chatId).waitFor();
  await dragFiles(page,`.canvas-card[data-channel-id="${chatId}"]`,Array.from({length:21},(_,n)=>`bulk-${n}.txt`));
  const chat=openChat(page);
  await chat.getByText(/You can attach up to 20 files/).waitFor();
  assert.equal(await dock(page).locator('.composer-attachments').count(),0,'the bottom box gets nothing');
  await chat.getByRole('button',{name:'Send',exact:true}).waitFor();
  await quiet(900);
  assert.equal((await messages(h,chatId)).length,0,'a cut drop is not sent on its own');
  await chat.getByRole('button',{name:'Send',exact:true}).click();
  await messageWith(h,chatId,Array.from({length:20},(_,n)=>`bulk-${n}.txt`));
},{canvas:true});

await runChatTest('canvas files: a file dropped on an area joins its context; empty canvas still feeds the bottom box',async h=>{
  const {page,base}=h;
  const chatId=await standaloneChat(h,'Synthetic area chat');
  const {id}=await call<{id:string}>(h,'POST','/api/canvases',{id:crypto.randomUUID(),name:'Area drops'});
  const areaId=crypto.randomUUID(),emptyId=crypto.randomUUID();
  await call(h,'POST',`/api/canvases/${id}/areas`,{id:areaId,title:'Launch',x:0,y:0,w:640,h:420});
  await call(h,'POST',`/api/canvases/${id}/areas`,{id:emptyId,title:'Quiet',x:800,y:0,w:420,h:320});
  await call(h,'POST',`/api/canvases/${id}/cards`,{cards:[{channelId:chatId,x:40,y:100}]});
  await page.goto(`${base}/?view=canvas&canvas=${id}`);
  await cardAt(page,chatId).waitFor();

  // The area lights up under a file drag and clears on dragleave.
  await dragFiles(page,'.canvas-area[data-area-id="'+areaId+'"]',['hover.txt'],'dragover');
  await page.locator('.canvas-area.is-drop-target').waitFor();
  await dragFiles(page,'.canvas-area[data-area-id="'+areaId+'"]',['hover.txt'],'dragleave');
  await page.locator('.canvas-area.is-drop-target').waitFor({state:'detached'});

  // A drop opens that area's panel with the upload, and the panel carries the warning.
  await dropFile(page,'.canvas-area[data-area-id="'+areaId+'"]','spec.txt');
  const panel=page.getByRole('complementary',{name:'Context for Launch',exact:true});
  await panel.waitFor();
  await panel.getByText(WARNING,{exact:true}).waitFor();
  await panel.locator('.canvas-context-file').getByText('spec.txt').first().waitFor();
  await page.locator('.canvas-area.is-drop-target').waitFor({state:'detached'});
  assert.equal(await dock(page).locator('.composer-attachments').count(),0,'the bottom box gets nothing');
  const files=await call<{files:{name:string}[]}>(h,'GET',`/api/canvases/${id}/areas/${areaId}/context`);
  assert.deepEqual(files.files.map(f=>f.name),['spec.txt']);
  assert.equal((await messages(h,chatId)).length,0,'a context drop posts no message');

  // Another area while the panel is open: the panel moves there, without the warning (no chat inside).
  await dropFile(page,'.canvas-area[data-area-id="'+emptyId+'"]','notes.txt');
  const quietPanel=page.getByRole('complementary',{name:'Context for Quiet',exact:true});
  await quietPanel.waitFor();
  await quietPanel.locator('.canvas-context-file').getByText('notes.txt').first().waitFor();
  assert.equal(await quietPanel.getByText(WARNING,{exact:true}).count(),0);
  await quietPanel.getByRole('button',{name:'Close',exact:true}).click();
  await quietPanel.waitFor({state:'detached'});

  // Empty canvas: the bottom box takes it, as before.
  await dropFile(page,'.canvas-surface','dock-drop.txt');
  await dock(page).locator('.composer-attachments').getByText('dock-drop.txt').first().waitFor();
  assert.equal(await page.getByRole('complementary',{name:/^Context for/}).count(),0,'no panel opened');
},{canvas:true});

await runChatTest('canvas files: on a view-only canvas an area drop does nothing and a card drop still posts',async h=>{
  const {page,base}=h;
  const {id}=await call<{id:string}>(h,'POST','/api/canvases',{id:crypto.randomUUID(),name:'Read only'});
  const areaId=crypto.randomUUID();
  await call(h,'POST',`/api/canvases/${id}/areas`,{id:areaId,title:'Launch',x:0,y:0,w:640,h:420});
  await call(h,'POST',`/api/canvases/${id}/areas`,{id:crypto.randomUUID(),title:'Other',x:800,y:0,w:420,h:320});
  await call(h,'POST',`/api/canvases/${id}/cards`,{cards:[{channelId:h.project.channelId,x:40,y:100}]});
  const mate=await h.loginAs('mate');
  await page.goto(`${base}/?view=canvas&canvas=${id}`);
  await page.getByRole('button',{name:'Share',exact:true}).click();
  const dialog=page.getByRole('dialog',{name:'Share canvas',exact:true});
  await dialog.getByRole('radio',{name:'Shared with chosen people',exact:true}).check();
  await dialog.getByRole('checkbox',{name:'mate',exact:true}).check();
  await dialog.getByRole('combobox',{name:'Access for mate',exact:true}).selectOption({label:'Can view'});
  const saved=page.waitForResponse(r=>r.request().method()==='PUT'&&r.url().endsWith('/members'));
  await dialog.getByRole('button',{name:'Save',exact:true}).click();
  assert.equal((await saved).status(),200);

  const theirs=mate.page;
  await theirs.goto(`${base}/?view=canvas&canvas=${id}`);
  await cardAt(theirs,h.project.channelId).waitFor();
  await areaOf(theirs,'Launch').waitFor();
  const uploads:string[]=[];
  theirs.on('request',request=>{if(request.method()==='POST'&&/\/context\/files$/.test(new URL(request.url()).pathname))uploads.push(request.url());});
  await dragFiles(theirs,'.canvas-area[data-area-id="'+areaId+'"]',['nope.txt'],'dragover');
  assert.equal(await theirs.locator('.canvas-area.is-drop-target').count(),0,'a viewer sees no area highlight');
  await dropFile(theirs,'.canvas-area[data-area-id="'+areaId+'"]','nope.txt');
  await quiet(700);
  assert.equal(await theirs.getByRole('complementary',{name:/^Context for/}).count(),0,'no panel for a viewer');
  assert.equal(await dock(theirs).locator('.composer-attachments').count(),0,'and not the bottom box either');
  assert.deepEqual(uploads,[]);

  await dropFile(theirs,`.canvas-card[data-channel-id="${h.project.channelId}"]`,'viewer.txt');
  await messageWith(h,h.project.channelId,['viewer.txt']);
},{canvas:true});

// Voice notes. The harness has no speech model, so the transcription answer (and only that) is stubbed; recording uses
// Chromium's fake microphone, and /api/files and message sending are real.
const TRANSCRIPT='Plan the spring launch';
async function stubVoice(page:Page){
  await page.route('**/api/voice/config',route=>route.fulfill({json:{transcription:{enabled:true,modelId:'stub'}}}));
  await page.route('**/api/voice/transcribe',route=>route.fulfill({json:{text:TRANSCRIPT,modelId:'stub'}}));
}
/** Records about two seconds and stops, inside `scope`. */
async function recordNote(scope:import('playwright').Locator,page:Page){
  await scope.getByRole('button',{name:'Record a voice note',exact:true}).click();
  const stop=scope.getByRole('button',{name:/^Stop recording \(\d:\d\d\)$/});
  await stop.waitFor();
  await quiet(2100);
  await stop.click();
}

await runChatTest('canvas voice: a note in the bottom box becomes an editable transcript and one audio attachment',async h=>{
  const {page,base}=h;
  await stubVoice(page);
  const {id}=await call<{id:string}>(h,'POST','/api/canvases',{id:crypto.randomUUID(),name:'Voice dock'});
  await page.goto(`${base}/?view=canvas&canvas=${id}`);
  const box=dock(page).getByRole('textbox',{name:'Message',exact:true});
  await box.waitFor();
  await recordNote(dock(page),page);
  await page.waitForFunction(()=>(document.querySelector('.project-start-dock textarea') as HTMLTextAreaElement|null)?.value==='Plan the spring launch');
  await dock(page).locator('.composer-attachments').getByText('Voice note.webm').first().waitFor();
  assert.equal(await dock(page).getByRole('button',{name:'Record a voice note',exact:true}).count(),1,'the mic is back');

  // Nothing is sent until Send, and the person can edit first.
  await quiet(500);
  assert.equal((await messages(h,h.project.channelId)).filter(m=>m.payload?.attachments?.length).length,0);
  await box.fill('Plan the spring launch with Sam');
  await dock(page).getByRole('button',{name:'Send',exact:true}).click();
  let found:Message|undefined;
  for(let attempt=0;attempt<100&&!found;attempt++){
    const all=await call<Message[]>(h,'GET','/api/events?type=message.created&order=desc&limit=50');
    found=all.find(m=>m.payload?.text==='Plan the spring launch with Sam');
    if(!found)await quiet(100);
  }
  assert.ok(found,'the new chat has the edited text');
  assert.deepEqual((found.payload?.attachments??[]).map(a=>a.name),['Voice note.webm']);
},{canvas:true,fakeMedia:true});

await runChatTest('canvas voice: the same flow works in an open chat, Cancel discards, and the chat header has Huddle',async h=>{
  const {page,base}=h;
  await stubVoice(page);
  const chatId=await standaloneChat(h,'Synthetic voice chat');
  const {id}=await call<{id:string}>(h,'POST','/api/canvases',{id:crypto.randomUUID(),name:'Voice chat'});
  await call(h,'POST',`/api/canvases/${id}/cards`,{cards:[{channelId:chatId,x:120,y:120}]});
  await page.goto(`${base}/?view=canvas&canvas=${id}`);
  await cardAt(page,chatId).waitFor();
  const chat=await splitOpen(page,chatId);
  await chat.getByRole('button',{name:'Huddle',exact:true}).waitFor();
  const box=chat.getByRole('textbox',{name:'Message',exact:true});

  // Cancel: nothing is attached or inserted, and the status clears.
  await chat.getByRole('button',{name:'Record a voice note',exact:true}).click();
  await chat.getByRole('button',{name:/^Stop recording/}).waitFor();
  await chat.getByRole('button',{name:'Cancel recording',exact:true}).click();
  await chat.getByRole('button',{name:'Record a voice note',exact:true}).waitFor();
  await quiet(500);
  assert.equal(await chat.locator('.composer-attachments').count(),0);
  assert.equal(await box.inputValue(),'');

  await recordNote(chat,page);
  await page.waitForFunction(()=>(document.querySelector('.canvas-chat textarea') as HTMLTextAreaElement|null)?.value==='Plan the spring launch');
  await chat.locator('.composer-attachments').getByText('Voice note.webm').first().waitFor();
  await box.fill('Plan the spring launch, edited');
  await chat.getByRole('button',{name:'Send',exact:true}).click();
  const sent=await messageWith(h,chatId,['Voice note.webm']);
  assert.equal(sent.payload?.text,'Plan the spring launch, edited');
  assert.equal((await humanMessages(h,chatId)).length,1);
},{canvas:true,fakeMedia:true});
