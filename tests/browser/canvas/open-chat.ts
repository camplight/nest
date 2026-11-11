// Opening a chat from the canvas (Task 8): focus, split screen and the regular view on the real engine, API and WS. Synthetic data.
import assert from 'node:assert/strict';
import type {Locator,Page} from 'playwright';
import {agentName,runChatTest,type ChatHarness} from '../support/chat-harness';
import {dropFile} from './drop';

async function call<T>(h:ChatHarness,method:string,path:string,body?:unknown):Promise<T>{
  const response=await fetch(h.apiUrl+path,{method,headers:{cookie:h.cookie,'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
  if(!response.ok)throw Error(`${method} ${path}: ${response.status} ${await response.text()}`);
  return response.status===204||response.headers.get('content-length')==='0'?undefined as T:await response.json().catch(()=>undefined) as T;
}
/** A plain (non-project) chat with the owner and Pip, so the regular view is `?channel=<id>`. */
async function standaloneChat(h:ChatHarness,name:string){
  const {id}=await call<{id:string}>(h,'POST','/api/channels',{name,visibility:'PRIVATE'});
  await call(h,'POST',`/api/channels/${id}/subscribe`,{subscriberType:'HUMAN',subscriberId:'demo-owner'});
  await call(h,'POST',`/api/channels/${id}/subscribe`,{subscriberType:'AGENT',subscriberId:agentName});
  return id;
}
async function canvasWith(h:ChatHarness,cards:{channelId:string;x:number;y:number}[]){
  const {id}=await call<{id:string}>(h,'POST','/api/canvases',{id:crypto.randomUUID(),name:'Open launch'});
  await call(h,'POST',`/api/canvases/${id}/cards`,{cards});
  return id;
}
const cardAt=(page:Page,channelId:string)=>page.locator(`.canvas-card[data-channel-id="${channelId}"]`);
const openChat=(page:Page)=>page.locator('.canvas-chat');
const composer=(chat:Locator)=>chat.getByRole('textbox',{name:'Message',exact:true});
const dock=(page:Page)=>page.getByRole('region',{name:'Start a chat',exact:true});
function params(page:Page){
  const url=new URL(page.url());
  return {view:url.searchParams.get('view'),chat:url.searchParams.get('chat'),mode:url.searchParams.get('mode'),channel:url.searchParams.get('channel')};
}
async function drag(page:Page,from:{x:number;y:number},to:{x:number;y:number}){
  await page.mouse.move(from.x,from.y);
  await page.mouse.down();
  await page.mouse.move((from.x+to.x)/2,(from.y+to.y)/2,{steps:4});
  await page.mouse.move(to.x,to.y,{steps:4});
  await page.mouse.up();
}
await runChatTest('canvas chat: focus, send, reload, realtime, split screen, file drops, Space and Escape',async h=>{
  const {page,base}=h;
  const chatId=await standaloneChat(h,'Synthetic canvas chat');
  const id=await canvasWith(h,[{channelId:chatId,x:120,y:120}]);
  await page.goto(`${base}/?view=canvas&canvas=${id}`);
  const card=cardAt(page,chatId);
  await card.waitFor();

  // A click on the card body opens the chat in focus over the canvas.
  await card.locator('.canvas-card-title').click();
  const chat=openChat(page);
  await chat.waitFor();
  assert.equal(await chat.getAttribute('data-mode'),'focus');
  await page.locator('.canvas-chat-backdrop').waitFor();
  assert.deepEqual(params(page),{view:'canvas',chat:chatId,mode:'focus',channel:null});
  assert.equal(await chat.locator('.workspace-topbar').count(),0,'no workspace top bar inside the canvas chat');
  for(const name of ['Split screen','Open in the regular chat view','Close'])await chat.getByRole('button',{name,exact:true}).waitFor();
  await composer(chat).fill('Hello from canvas');
  const sent=page.waitForResponse(r=>r.request().method()==='POST'&&r.url().endsWith('/api/messages'));
  await composer(chat).press('Enter');
  assert.equal((await sent).ok(),true);
  await chat.locator('.messages-panel').getByText('Hello from canvas',{exact:true}).waitFor();

  // A reload restores the same open chat.
  await page.reload();
  await chat.waitFor();
  assert.equal(await chat.getAttribute('data-mode'),'focus');
  await chat.locator('.messages-panel').getByText('Hello from canvas',{exact:true}).waitFor();

  // An agent message reaches the open chat live.
  const navigations:string[]=[];
  page.on('framenavigated',frame=>{if(frame===page.mainFrame())navigations.push(frame.url());});
  await h.emit('message.created',{text:'Synthetic agent reply on the canvas'},{channelId:chatId});
  await chat.locator('.messages-panel').getByText('Synthetic agent reply on the canvas',{exact:true}).waitFor();
  assert.deepEqual(navigations,[],'no reload');

  // Escape inside the mention picker closes only the picker.
  await composer(chat).fill('@');
  const picker=chat.getByRole('listbox',{name:'Mention people and agents',exact:true});
  await picker.waitFor();
  await composer(chat).press('Escape');
  await picker.waitFor({state:'hidden'});
  assert.equal(await chat.count(),1,'the chat stays open');
  await composer(chat).fill('');

  // Split screen: the canvas on the left stays usable beside the chat.
  await chat.getByRole('button',{name:'Split screen',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('.canvas-chat')?.getAttribute('data-mode')==='split');
  assert.deepEqual(params(page),{view:'canvas',chat:chatId,mode:'split',channel:null});
  assert.equal(await page.locator('.canvas-chat-backdrop').count(),0,'no backdrop in split screen');
  await page.locator('.canvas-surface').waitFor();
  await chat.locator('.messages-panel').getByText('Hello from canvas',{exact:true}).waitFor();
  const surfaceBox=(await page.locator('.canvas-surface').boundingBox())!,chatBox=(await chat.boundingBox())!;
  const bodyBox=(await page.locator('.canvas-body').boundingBox())!;
  assert.ok(chatBox.x>=surfaceBox.x+surfaceBox.width-1,'the chat sits right of the canvas');
  assert.ok(chatBox.x>=bodyBox.x+bodyBox.width*0.4-1,`the canvas keeps at least 40%: chat starts at ${chatBox.x}`);
  const before=(await card.boundingBox())!;
  const moved=page.waitForResponse(r=>r.request().method()==='PATCH'&&r.url().includes(`/api/canvases/${id}/cards/`));
  await drag(page,{x:before.x+40,y:before.y+16},{x:before.x+140,y:before.y+76});
  assert.equal((await moved).ok(),true,'a card still moves in split screen');
  const after=(await card.boundingBox())!;
  assert.ok(Math.abs(after.x-before.x-100)<=2&&Math.abs(after.y-before.y-60)<=2,`card moved by the drag: ${after.x-before.x},${after.y-before.y}`);
  assert.equal(params(page).chat,chatId,'a drag does not open or close a chat');

  // The divider resizes the chat and the width is remembered.
  const divider=page.getByRole('separator',{name:'Resize chat',exact:true});
  const line=(await divider.boundingBox())!,body=(await page.locator('.canvas-body').boundingBox())!;
  const target=body.x+body.width*0.7;
  await drag(page,{x:line.x+line.width/2,y:line.y+200},{x:target,y:line.y+200});
  const stored=Number(await page.evaluate(()=>localStorage.getItem('nest-canvas-split')));
  assert.ok(Math.abs(stored-30)<=0.5,`stored chat width ${stored}%`);
  const narrow=(await chat.boundingBox())!;
  assert.ok(Math.abs(narrow.width-body.width*stored/100)<=2,`chat width follows the divider: ${narrow.width}`);
  await drag(page,{x:target,y:line.y+200},{x:body.x+20,y:line.y+200});
  const widest=Number(await page.evaluate(()=>localStorage.getItem('nest-canvas-split')));
  assert.equal(widest,60,'the canvas keeps 40%');
  assert.ok((await page.locator('.canvas-stage').boundingBox())!.width>=body.width*0.4-2,'the canvas keeps 40% of the width');

  // Space types a space in the split-screen composer, and is not swallowed in the thread.
  await composer(chat).click();
  await page.keyboard.type('a b');
  assert.equal(await composer(chat).inputValue(),'a b');
  await composer(chat).fill('');
  const thread=chat.locator('.messages-panel');
  await thread.evaluate(el=>{el.tabIndex=el.tabIndex<0?-1:el.tabIndex;(el as HTMLElement).focus();});
  const box=(await page.locator('.canvas-surface').boundingBox())!;
  await page.mouse.move(box.x+box.width-30,box.y+box.height/2);
  assert.equal(await thread.evaluate(el=>el.dispatchEvent(new KeyboardEvent('keydown',{key:' ',code:'Space',bubbles:true,cancelable:true}))),true,'Space in the thread is not prevented');
  assert.equal(await page.locator('.canvas-surface.is-panning-key').count(),0,'the canvas did not arm panning');
  await thread.evaluate(el=>el.dispatchEvent(new KeyboardEvent('keyup',{key:' ',code:'Space',bubbles:true})));
  // With focus on the canvas, Space still arms panning.
  await page.locator('.canvas-surface').focus();
  await page.keyboard.down(' ');
  await page.locator('.canvas-surface.is-panning-key').waitFor();
  await page.keyboard.up(' ');
  await page.locator('.canvas-surface.is-panning-key').waitFor({state:'detached'});

  // With a split chat open, a file dropped on the chat goes to it; one dropped on empty canvas goes to the bottom box.
  await dropFile(page,'.canvas-chat .chat-stack','split-drop.txt');
  await chat.locator('.composer-attachments').getByText('split-drop.txt').first().waitFor();
  assert.equal(await dock(page).locator('.composer-attachments').count(),0,'the bottom box gets nothing');
  await chat.getByRole('button',{name:'Remove split-drop.txt',exact:true}).click();
  await dropFile(page,'.canvas-surface','canvas-drop.txt');
  await dock(page).locator('.composer-attachments').getByText('canvas-drop.txt').first().waitFor();
  assert.equal(await chat.locator('.composer-attachments').count(),0,'the open chat gets nothing');
  await dock(page).getByRole('button',{name:'Remove canvas-drop.txt',exact:true}).click();

  // Back to focus; Escape closes it.
  await chat.getByRole('button',{name:'Split screen',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('.canvas-chat')?.getAttribute('data-mode')==='focus');
  await composer(chat).click();
  await page.keyboard.press('Escape');
  await chat.waitFor({state:'detached'});
  assert.equal(params(page).chat,null,'the URL drops the chat');

  // With no chat open, the bottom box takes dropped files.
  await dropFile(page,'.canvas-surface','dock-drop.txt');
  await dock(page).locator('.composer-attachments').getByText('dock-drop.txt').first().waitFor();
},{canvas:true});

await runChatTest('canvas chat: the regular view and Back, and unavailable cards never open',async h=>{
  const {page,base}=h;
  const chatId=await standaloneChat(h,'Synthetic regular chat');
  const goneId=await standaloneChat(h,'Synthetic gone chat');
  const id=await canvasWith(h,[{channelId:chatId,x:120,y:120},{channelId:goneId,x:480,y:120}]);
  await call(h,'DELETE',`/api/channels/${goneId}`);
  await page.goto(`${base}/?view=canvas&canvas=${id}`);
  const card=cardAt(page,chatId);
  await card.waitFor();
  const chat=openChat(page);

  // An unavailable card does not open.
  const gone=cardAt(page,goneId);
  await page.waitForFunction(goneId=>document.querySelector(`.canvas-card[data-channel-id="${goneId}"]`)?.getAttribute('data-access')==='unavailable',goneId);
  await gone.locator('.canvas-card-title').click();
  await page.waitForTimeout(300);
  assert.equal(await chat.count(),0,'no chat for an unavailable card');
  assert.equal(params(page).chat,null);

  // Closing returns focus to the card's Open button: after a keyboard open and Escape, and after a mouse open and Close.
  const openButton=card.getByRole('button',{name:'Open chat Synthetic regular chat',exact:true});
  const focusedOpen=()=>page.evaluate(chatId=>document.activeElement?.matches(`.canvas-card[data-channel-id="${chatId}"] .canvas-card-open`)??false,chatId);
  await openButton.focus();
  await page.keyboard.press('Enter');
  await chat.waitFor();
  assert.equal(await chat.getAttribute('data-mode'),'focus');
  await page.keyboard.press('Escape');
  await chat.waitFor({state:'detached'});
  await page.waitForFunction(chatId=>document.activeElement?.matches(`.canvas-card[data-channel-id="${chatId}"] .canvas-card-open`)??false,chatId,{timeout:2000}).catch(()=>{});
  assert.equal(await focusedOpen(),true,`Escape returns focus to the Open button, not ${await page.evaluate(()=>document.activeElement?.outerHTML.slice(0,80))}`);
  await card.locator('.canvas-card-title').click();
  await chat.waitFor();
  await chat.getByRole('button',{name:'Close',exact:true}).click();
  await chat.waitFor({state:'detached'});
  await page.waitForFunction(chatId=>document.activeElement?.matches(`.canvas-card[data-channel-id="${chatId}"] .canvas-card-open`)??false,chatId,{timeout:2000}).catch(()=>{});
  assert.equal(await focusedOpen(),true,`Close after a mouse open returns focus to the Open button, not ${await page.evaluate(()=>document.activeElement?.outerHTML.slice(0,80))}`);

  // Focus, then the regular view, then Back to the same open chat.
  await card.locator('.canvas-card-title').click();
  await chat.waitFor();
  await chat.getByRole('button',{name:'Open in the regular chat view',exact:true}).click();
  await page.waitForFunction(chatId=>new URL(location.href).searchParams.get('channel')===chatId,chatId);
  assert.equal(params(page).view,null);
  await page.getByRole('textbox',{name:'Search channels',exact:true}).waitFor();
  await page.getByRole('textbox',{name:'Message',exact:true}).waitFor();
  assert.equal(await page.locator('.canvas-view').count(),0,'left the canvas');
  await page.goBack();
  await chat.waitFor();
  assert.equal(await chat.getAttribute('data-mode'),'focus');
  assert.deepEqual(params(page),{view:'canvas',chat:chatId,mode:'focus',channel:null});
  await composer(chat).waitFor();

  // Split screen, regular view, Back: split again. Close, regular view from elsewhere, Back: closed.
  await chat.getByRole('button',{name:'Split screen',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('.canvas-chat')?.getAttribute('data-mode')==='split');
  await chat.getByRole('button',{name:'Open in the regular chat view',exact:true}).click();
  await page.waitForFunction(chatId=>new URL(location.href).searchParams.get('channel')===chatId,chatId);
  await page.goBack();
  await page.waitForFunction(()=>document.querySelector('.canvas-chat')?.getAttribute('data-mode')==='split');
  await chat.getByRole('button',{name:'Close',exact:true}).click();
  await chat.waitFor({state:'detached'});
  assert.equal(params(page).chat,null);
  await page.goBack();
  await page.waitForFunction(()=>document.querySelector('.canvas-chat')?.getAttribute('data-mode')==='split');
  await page.goForward();
  await chat.waitFor({state:'detached'});
  await card.waitFor();
},{canvas:true});
