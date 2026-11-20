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

  // A click on the card body opens the chat in focus, in place over its card.
  await card.locator('.canvas-card-title').click();
  const chat=openChat(page);
  await chat.waitFor();
  assert.equal(await chat.getAttribute('data-mode'),'focus');
  await page.locator('.canvas-chat[data-place="card"]').waitFor();
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

type Box={x:number;y:number;width:number;height:number};
const boxOf=async(locator:Locator)=>{const b=await locator.boundingBox();if(!b)throw Error('not on screen');return b;};
/** Polls from Node (a page-side async predicate would resolve at once) until two reads 50 ms apart match. */
async function settled(read:()=>Promise<string>,what:string,timeout=4000){
  const end=Date.now()+timeout;
  let last='';
  while(Date.now()<end){
    const now=await read();
    if(now===last)return now;
    last=now;
    await new Promise(resolve=>setTimeout(resolve,50));
  }
  throw Error(`${what} did not settle: ${last}`);
}
async function until(check:()=>Promise<boolean>,what:string,timeout=4000){
  const end=Date.now()+timeout;
  while(Date.now()<end){if(await check())return;await new Promise(resolve=>setTimeout(resolve,50));}
  throw Error(`timed out waiting for ${what}`);
}
const opacity=(locator:Locator)=>locator.evaluate(el=>Number(getComputedStyle(el).opacity));
const overlap=(a:Box,b:Box)=>a.x<b.x+b.width&&b.x<a.x+a.width&&a.y<b.y+b.height&&b.y<a.y+a.height;

await runChatTest('canvas chat: opens in place over its card, dims the rest, and a plain chat sits over the bottom box',async h=>{
  const {page,base}=h;
  const chatId=await standaloneChat(h,'Synthetic in-place chat');
  const neighbourId=await standaloneChat(h,'Synthetic neighbour chat');
  const looseId=await standaloneChat(h,'Synthetic plain chat');
  await h.emit('message.created',{text:'Synthetic first note in place'},{channelId:chatId});
  const id=await canvasWith(h,[{channelId:chatId,x:120,y:120},{channelId:neighbourId,x:520,y:160}]);
  await page.goto(`${base}/?view=canvas&canvas=${id}`);
  const card=cardAt(page,chatId),neighbour=cardAt(page,neighbourId);
  await card.waitFor();
  // Zoomed out first: opening brings the card to 100%.
  await page.getByRole('button',{name:'Zoom out',exact:true}).click();
  await page.getByRole('button',{name:'Zoom out',exact:true}).click();
  // Behind a sheet the canvas is hidden from screen readers, so its controls are found by CSS here.
  const zoom=page.locator('.canvas-zoom output');
  await until(async()=>await zoom.textContent()!=='100%','zoomed out');

  await card.locator('.canvas-card-title').click();
  const chat=openChat(page);
  await page.locator('.canvas-chat[data-place="card"]').waitFor();
  await until(async()=>await zoom.textContent()==='100%','the camera at 100%');
  await settled(async()=>JSON.stringify([await boxOf(chat),await boxOf(card)]),'the sheet over its card');
  const sheet=await boxOf(chat),under=await boxOf(card),body=await boxOf(page.locator('.canvas-body'));
  const stageOf=()=>boxOf(page.locator('.canvas-stage')),dockOf=()=>boxOf(page.locator('.canvas-dock'));
  assert.ok(Math.abs(sheet.x-under.x)<=24&&Math.abs(sheet.y-under.y)<=24,`the sheet starts on its card: ${JSON.stringify(sheet)} over ${JSON.stringify(under)}`);
  assert.ok(overlap(sheet,under),'the sheet covers its card');
  assert.ok(sheet.width<=640&&sheet.width>=480,`a card-sized sheet, not a page-wide one: ${sheet.width}`);
  assert.ok(sheet.y-body.y>=48,`room above the card for an area title: ${sheet.y-body.y}px`);
  assert.ok(sheet.y+sheet.height<=(await dockOf()).y-7,`the sheet stays above the bottom box: ${sheet.y+sheet.height} vs ${(await dockOf()).y}`);
  // One compact header (the mock's .ch-head): messages start within about 110 px of the sheet's top.
  const firstMessage=await boxOf(chat.locator('.messages-panel').getByText('Synthetic first note in place',{exact:true}));
  const thread=await boxOf(chat.locator('.messages-panel'));
  assert.ok(thread.y-sheet.y<=110,`the thread starts ${thread.y-sheet.y}px below the sheet's top`);
  assert.ok(firstMessage.y>thread.y-1);
  assert.equal(await chat.locator('.workspace-header').isVisible(),false,'no second header row');
  assert.equal(await chat.locator('.chat-header-actions').count(),0,'no Settings / Huddle / Export row');
  for(const name of ['Split screen','Huddle','Open in the regular chat view','More chat actions','Close']){
    const button=chat.locator('.canvas-chat-bar').getByRole('button',{name,exact:true});
    const b=await boxOf(button);
    assert.ok(b.width<=32&&b.height<=32,`${name} is a 30 px icon button: ${b.width}x${b.height}`);
    assert.ok(await button.getAttribute('title'),`${name} has a title`);
  }
  // Everything else on the canvas dims; the open card stays (under the sheet).
  await until(async()=>await opacity(neighbour)<0.5,'the neighbour card dimmed');
  assert.equal(await opacity(card),1,'the open card is not dimmed');
  // No scrim: around the sheet the canvas itself is under the pointer.
  assert.equal(await page.locator('.canvas-chat-backdrop').count(),0,'no backdrop');
  const beside={x:body.x+12,y:body.y+body.height/2};
  assert.equal(await page.evaluate(({x,y})=>document.elementFromPoint(x,y)?.className.split(' ')[0],beside),'canvas-surface','the live canvas beside the sheet');
  assert.equal(await page.locator('.canvas-main').getAttribute('aria-hidden'),'true','hidden from screen readers');
  assert.equal(await page.locator('.canvas-main[inert]').count(),0,'but not inert');
  assert.equal(await chat.getAttribute('aria-modal'),'true','the sheet is modal for screen readers');

  // The More menu: Area, Sharing and Export chat. Escape closes the menu first, then the sheet.
  const more=chat.getByRole('button',{name:'More chat actions',exact:true});
  await more.click();
  const menu=chat.getByRole('group',{name:'More chat actions',exact:true});
  await menu.getByRole('button',{name:'Settings',exact:true}).waitFor();
  await menu.getByRole('button',{name:'Export chat',exact:true}).waitFor();
  assert.equal(await more.getAttribute('aria-haspopup'),null,'a disclosure, not a menu');
  await page.keyboard.press('Escape');
  await menu.waitFor({state:'hidden'});
  assert.equal(await chat.count(),1,'Escape closed only the menu');
  assert.equal(await page.evaluate(()=>document.activeElement?.getAttribute('aria-label')),'More chat actions','focus back on ⋯');
  // Choosing Settings (portaled from the thread) closes the panel; its dialog takes Escape, and the sheet stays.
  await more.click();
  await menu.getByRole('button',{name:'Settings',exact:true}).click();
  const sharing=page.locator('.participants-dialog');
  await sharing.waitFor();
  await menu.waitFor({state:'hidden'});
  await page.locator('.dialog-backdrop').click({position:{x:5,y:5}});
  await sharing.waitFor({state:'detached'});
  assert.equal(await chat.count(),1,'the sheet stays after Settings');

  // Tab and Shift+Tab stay in the sheet, wrapping at both ends.
  const inSheet=()=>page.evaluate(()=>Boolean(document.activeElement?.closest('.canvas-chat')));
  for(let n=0;n<25;n++){
    await page.keyboard.press('Tab');
    assert.equal(await inSheet(),true,`Tab ${n+1} stays in the sheet`);
  }
  await chat.getByRole('button',{name:'Split screen',exact:true}).focus();
  await page.keyboard.press('Shift+Tab');
  assert.equal(await inSheet(),true,'Shift+Tab from the first control wraps inside the sheet');
  assert.notEqual(await page.evaluate(()=>document.activeElement?.getAttribute('aria-label')),'Split screen');

  // The Huddle opened from the sheet keeps its own Tab order: the sheet's trap never pulls focus back.
  await chat.locator('.canvas-chat-bar').getByRole('button',{name:'Huddle',exact:true}).click();
  const huddle=page.locator('.huddle-dialog');
  await huddle.waitFor();
  await until(async()=>page.evaluate(()=>Boolean(document.activeElement?.closest('.huddle-dialog'))),'focus in the Huddle');
  const seen=new Set<string>();
  for(let n=0;n<3;n++){
    await page.keyboard.press('Tab');
    const at=await page.evaluate(()=>{const el=document.activeElement;return el?.closest('.huddle-dialog')?(el.getAttribute('aria-label')??el.textContent??'')+'|'+Array.from(el.parentElement?.children??[]).indexOf(el):'';});
    assert.ok(at,`Tab ${n+1} stays in the Huddle`);
    seen.add(at);
  }
  assert.ok(seen.size>1,`Tab moves within the Huddle: ${[...seen].join(', ')}`);
  await huddle.getByRole('button',{name:'Close huddle',exact:true}).click();
  await huddle.waitFor({state:'detached'});
  assert.equal(await chat.count(),1,'the sheet stays after the Huddle');

  // The canvas stays live: a wheel zoom, a drag-pan and the zoom bar move the view and the sheet follows its card.
  const follows=async(what:string)=>{
    const [s,c]=JSON.parse(await settled(async()=>JSON.stringify([await boxOf(chat),await boxOf(card)]),what)) as [Box,Box];
    const stage=await stageOf();
    const clampedX=Math.min(Math.max(c.x,stage.x+16),stage.x+stage.width-16-s.width);
    assert.ok(Math.abs(s.x-clampedX)<=24,`${what}: the sheet stays on its card (${s.x} vs ${c.x})`);
    assert.ok(s.x+s.width<=stage.x+stage.width-15,`${what}: inside the stage`);
  };
  await page.mouse.move(beside.x,beside.y);
  await page.mouse.wheel(0,-120);
  await page.keyboard.down('Control');await page.mouse.wheel(0,200);await page.keyboard.up('Control');
  await until(async()=>await zoom.textContent()!=='100%','a wheel zoom');
  assert.equal(await chat.count(),1,'a wheel zoom keeps the sheet');
  await follows('after a wheel zoom');
  await page.mouse.move(beside.x,beside.y);
  await page.mouse.down();
  await page.mouse.move(beside.x+60,beside.y+30,{steps:5});
  await page.mouse.up();
  assert.equal(await chat.count(),1,'a drag-pan keeps the sheet');
  await follows('after a drag-pan');
  await page.locator('.canvas-zoom button[aria-label="Zoom in"]').click();
  assert.equal(await chat.count(),1,'the zoom bar keeps the sheet');
  await follows('after Zoom in');

  // A window resize keeps it on its card, inside the stage and above the bottom box.
  await page.setViewportSize({width:1200,height:800});
  await follows('after a resize');
  const resized=await boxOf(chat);
  assert.ok(resized.y+resized.height<=(await dockOf()).y-7,'still above the bottom box');

  // Drops on the canvas are ignored while the sheet is open; the sheet itself still takes them. The drop handlers run
  // synchronously, so once the sheet's own drop has landed the two earlier ones have been handled too.
  await dropFile(page,`.canvas-card[data-channel-id="${neighbourId}"]`,'ignored.txt');
  await dropFile(page,'.canvas-surface','ignored-too.txt');
  await dropFile(page,'.canvas-chat .chat-stack','sheet-drop.txt');
  await chat.locator('.composer-attachments').getByText('sheet-drop.txt').first().waitFor();
  assert.equal(params(page).chat,chatId,'no other chat opened');
  assert.equal(await page.locator('.composer-attachments').getByText(/ignored/).count(),0,'neither canvas drop was taken');
  await chat.getByRole('button',{name:'Remove sheet-drop.txt',exact:true}).click();

  // The bottom box keeps working beside the sheet.
  await page.locator('.canvas-dock textarea, .canvas-dock input[type="text"]').first().fill('Typed beside the sheet');
  assert.equal(await page.locator('.canvas-dock textarea, .canvas-dock input[type="text"]').first().inputValue(),'Typed beside the sheet');
  await page.locator('.canvas-dock textarea, .canvas-dock input[type="text"]').first().fill('');

  // A press on the canvas while a popover is open closes only the popover; the next one closes the sheet.
  await page.getByRole('button',{name:/^Canvas context/}).click();
  const popover=page.getByRole('dialog',{name:'Canvas context',exact:true});
  await popover.waitFor();
  const empty=await boxOf(page.locator('.canvas-surface'));
  await page.mouse.click(empty.x+12,empty.y+empty.height/2);
  await popover.waitFor({state:'detached'});
  assert.equal(await chat.count(),1,'the sheet stays while the popover closes');
  // A drag that starts in the chat and ends over the canvas keeps it open.
  const inside=await boxOf(chat.locator('.messages-panel'));
  await page.mouse.move(inside.x+40,inside.y+20);
  await page.mouse.down();
  await page.mouse.move(empty.x+12,empty.y+empty.height/2,{steps:4});
  await page.mouse.up();
  assert.equal(await chat.count(),1,'a drag out of the chat keeps it open');
  await page.mouse.click(empty.x+12,empty.y+empty.height/2);
  await chat.waitFor({state:'detached'});
  assert.equal(params(page).chat,null);
  assert.equal(await page.locator('.canvas-main').getAttribute('aria-hidden'),null,'the canvas is back for screen readers');
  assert.equal(await card.getAttribute('data-flash'),'','the card flashes as the chat closes into it');
  await until(async()=>await opacity(neighbour)===1,'the canvas back at full strength');

  // Escape closes it; Fit closes it and fits.
  await card.locator('.canvas-card-title').click();
  await chat.waitFor();
  await composer(chat).click();
  await page.keyboard.press('Escape');
  await chat.waitFor({state:'detached'});
  await card.locator('.canvas-card-title').click();
  await chat.waitFor();
  const world=page.locator('.canvas-world');
  const presented=await settled(async()=>await world.getAttribute('style')??'','the camera on the card');
  await page.locator('.canvas-fit').click();
  await chat.waitFor({state:'detached'});
  await until(async()=>await world.getAttribute('style')!==presented,'Fit moved the view');

  // A chat that is not on this canvas opens as a plain chat over the bottom box, with the canvas faded.
  await page.setViewportSize({width:1440,height:900});
  await page.goto(`${base}/?view=canvas&canvas=${id}&chat=${looseId}&mode=focus`);
  await page.locator('.canvas-chat[data-place="loose"]').waitFor();
  await settled(async()=>JSON.stringify(await boxOf(chat)),'the plain chat');
  const plain=await boxOf(chat),stage=await stageOf(),box=await dockOf();
  assert.ok(Math.abs(plain.x+plain.width/2-(stage.x+stage.width/2))<=2,`centred on the canvas: ${JSON.stringify(plain)} in ${JSON.stringify(stage)}`);
  assert.ok(plain.width<=640,`a plain chat is 560 px at most: ${plain.width}`);
  const gap=box.y-(plain.y+plain.height);
  assert.ok(gap>=7&&gap<=40,`just above the bottom box: ${gap}px`);
  await until(async()=>await opacity(page.locator('.canvas-world'))<0.5,'the canvas faded');
  assert.equal(await chat.locator('.canvas-chat-sub').getByText('Plain chat · not on this canvas').count(),1);

  // A phone has room for one chat at a time: it fills the body.
  await page.setViewportSize({width:390,height:844});
  await until(async()=>{const c=await boxOf(chat),b=await boxOf(page.locator('.canvas-body'));return Math.abs(c.width-b.width)<=1&&Math.abs(c.x-b.x)<=1;},'a full-width chat at 390 px');
  await page.keyboard.press('Escape');
  await chat.waitFor({state:'detached'});
},{canvas:true,viewport:{width:1440,height:900}});

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
