// Canvas context (Phase 2): the anchored context popover, area chips, shelves, ↳ link chips and link lines on the real engine, API and WS. Synthetic data.
import assert from 'node:assert/strict';
import type {Locator,Page} from 'playwright';
import {agentName,runChatTest,type ChatHarness} from '../support/chat-harness';

async function call<T>(h:ChatHarness,method:string,path:string,body?:unknown):Promise<T>{
  const response=await fetch(h.apiUrl+path,{method,headers:{cookie:h.cookie,'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
  if(!response.ok)throw Error(`${method} ${path}: ${response.status} ${await response.text()}`);
  return response.status===204?undefined as T:await response.json() as T;
}
/** Every engine event in the harness chat: messages, turns and anything else an agent would wake on. */
const chatEvents=async(h:ChatHarness)=>(await call<unknown[]>(h,'GET',`/api/events?channelId=${encodeURIComponent(h.project.channelId)}&limit=1000`)).length;
async function openCanvas(page:Page,base:string,id:string){
  await page.goto(`${base}/?view=canvas&canvas=${id}`);
  await page.locator('.canvas-surface .canvas-world').waitFor({state:'attached'});
}
/** Drags a Loose chats row onto the surface at a point on the page (the drawer, opened from the top bar, floats over the canvas's left). */
async function dropRow(page:Page,row:Locator,at:{x:number;y:number}){
  // The events skip hit-testing, so make sure a person could drop there: not under the drawer.
  const drawer=await page.getByRole('complementary',{name:'Loose chats',exact:true}).boundingBox();
  if(drawer)assert.ok(at.x<drawer.x||at.x>drawer.x+drawer.width||at.y<drawer.y||at.y>drawer.y+drawer.height,`the drop point ${at.x},${at.y} is clear of the drawer`);
  const transfer=await page.evaluateHandle(()=>new DataTransfer());
  await row.dispatchEvent('dragstart',{dataTransfer:transfer});
  const surface=page.locator('.canvas-surface');
  await surface.dispatchEvent('dragover',{dataTransfer:transfer,clientX:at.x,clientY:at.y});
  await surface.dispatchEvent('drop',{dataTransfer:transfer,clientX:at.x,clientY:at.y});
}
async function openDrawer(page:Page){
  await page.locator('.canvas-loose-button').click();
  const drawer=page.getByRole('complementary',{name:'Loose chats',exact:true});
  await drawer.waitFor();
  return drawer;
}
const areaOf=(page:Page,title:string)=>page.getByRole('region',{name:`Area ${title}`,exact:true});
/** The area's `◱` chip: one click opens its context popover. */
const chipOf=(page:Page,title:string)=>areaOf(page,title).getByRole('button',{name:new RegExp(`^Context for ${title}: `)});
async function openAreaContext(page:Page,title:string){
  await chipOf(page,title).click();
  const panel=page.getByRole('dialog',{name:`Context for ${title}`,exact:true});
  await panel.waitFor();
  return panel;
}
const canvasButton=(page:Page)=>page.getByRole('button',{name:/^Canvas context/});
const canvasPopover=(page:Page)=>page.getByRole('dialog',{name:'Canvas context',exact:true});
const WARNING='Everyone in these chats, including their agents, can see this.';
/** The focused element, described for assertions. */
const focused=(page:Page)=>page.evaluate(()=>{
  const el=document.activeElement as HTMLElement|null;
  return {tag:el?.tagName??'',text:el?.textContent?.trim()??'',label:el?.getAttribute('aria-label')??'',area:el?.closest<HTMLElement>('[data-area-id]')?.getAttribute('aria-label')??'',inPanel:Boolean(el?.closest('.canvas-context'))};
});
const notesValue=(page:Page,value:string)=>page.waitForFunction(v=>(document.querySelector('.canvas-context textarea') as HTMLTextAreaElement|null)?.value===v,value);

await runChatTest('canvas context: notes, files, links, used by, view-only and no wake-ups',async h=>{
  const {page,base}=h;
  const roadmap=(await call<{id:string}>(h,'POST','/api/canvases',{id:crypto.randomUUID(),name:'Roadmap'})).id;
  const launch=crypto.randomUUID(),research=crypto.randomUUID();
  await call(h,'POST',`/api/canvases/${roadmap}/areas`,{id:launch,title:'Launch',x:0,y:0,w:640,h:420});
  await call(h,'POST',`/api/canvases/${roadmap}/areas`,{id:research,title:'Research',x:800,y:0,w:420,h:320});
  await call(h,'POST',`/api/canvases/${roadmap}/cards`,{cards:[{channelId:h.project.channelId,x:40,y:100}]});
  const brand=(await call<{id:string}>(h,'POST','/api/canvases',{id:crypto.randomUUID(),name:'Brand'})).id;
  await call(h,'POST',`/api/canvases/${brand}/areas`,{id:crypto.randomUUID(),title:'Brand kit',x:0,y:0,w:420,h:320});
  const events=await chatEvents(h);

  // One summary request for the whole board, never one per area.
  const summaries:string[]=[];
  page.on('request',request=>{if(/\/context\/summary$/.test(new URL(request.url()).pathname))summaries.push(request.url());});
  await openCanvas(page,base,roadmap);
  await areaOf(page,'Launch').waitFor();
  await areaOf(page,'Research').waitFor();
  assert.equal(summaries.length,1,`one summary request per board load: ${summaries.length}`);

  // Canvas context: notes autosave and persist across a reload.
  await canvasButton(page).click();
  const canvasPanel=canvasPopover(page);
  await canvasPanel.waitFor();
  // Focus moves into the panel, onto its heading.
  assert.deepEqual(await focused(page).then(f=>[f.tag,f.text,f.inPanel]),['H2','Context · Roadmap',true]);
  await canvasPanel.getByText(WARNING,{exact:true}).waitFor();
  const saved=page.waitForResponse(response=>response.request().method()==='PUT'&&new URL(response.url()).pathname===`/api/canvases/${roadmap}/context`);
  await canvasPanel.getByRole('textbox',{name:'Notes',exact:true}).fill('Launch on Friday. Keep the copy short.');
  assert.equal((await saved).status(),200);
  await canvasPanel.getByText('Saved',{exact:true}).waitFor();
  await page.reload();
  await page.locator('.canvas-surface .canvas-world').waitFor({state:'attached'});
  await canvasButton(page).click();
  const reloaded=canvasPopover(page).getByRole('textbox',{name:'Notes',exact:true});
  await page.waitForFunction(()=>(document.querySelector('.canvas-context textarea') as HTMLTextAreaElement|null)?.value==='Launch on Friday. Keep the copy short.');
  assert.equal(await reloaded.inputValue(),'Launch on Friday. Keep the copy short.');
  // Someone else saves first: the stale write shows the conflict and their version can be loaded.
  const stored=await call<{version:number}>(h,'GET',`/api/canvases/${roadmap}/context`);
  await call(h,'PUT',`/api/canvases/${roadmap}/context`,{notes:'Launch moved to Monday.',version:stored.version});
  const conflicted=page.waitForResponse(response=>response.request().method()==='PUT'&&new URL(response.url()).pathname===`/api/canvases/${roadmap}/context`);
  await reloaded.fill('Launch on Friday. Keep the copy short and plain.');
  assert.equal((await conflicted).status(),409);
  const reloadedPanel=canvasPopover(page);
  await reloadedPanel.getByText('Someone else changed these notes.',{exact:true}).waitFor();
  await reloadedPanel.getByRole('button',{name:'Load their version',exact:true}).click();
  assert.equal(await reloaded.inputValue(),'Launch moved to Monday.');
  await reloadedPanel.getByText('Someone else changed these notes.',{exact:true}).waitFor({state:'detached'});

  // Closing within the 800 ms autosave window still saves what was typed.
  const puts:string[]=[];
  const countPut=(request:import('playwright').Request)=>{if(request.method()==='PUT'&&new URL(request.url()).pathname===`/api/canvases/${roadmap}/context`)puts.push(request.url());};
  page.on('request',countPut);
  const flushed=page.waitForResponse(response=>response.request().method()==='PUT'&&new URL(response.url()).pathname===`/api/canvases/${roadmap}/context`);
  await reloaded.fill('Launch moved to Monday. Bring the deck.');
  assert.equal(puts.length,0,'no save before the autosave delay');
  await reloadedPanel.getByRole('button',{name:'Done',exact:true}).click();
  assert.equal((await flushed).status(),200);
  page.off('request',countPut);
  await reloadedPanel.waitFor({state:'detached'});
  // Focus returns to the button that opened the panel.
  assert.deepEqual(await focused(page).then(f=>[f.tag,f.text.startsWith('Canvas context')]),['BUTTON',true]);
  await page.reload();
  await page.locator('.canvas-surface .canvas-world').waitFor({state:'attached'});
  await canvasButton(page).click();
  await notesValue(page,'Launch moved to Monday. Bring the deck.');

  // A reload inside the window: the leaving page sends the save with keepalive.
  await reloaded.fill('Launch moved to Monday. Bring the deck and the brief.');
  await page.reload();
  await page.locator('.canvas-surface .canvas-world').waitFor({state:'attached'});
  await canvasButton(page).click();
  await notesValue(page,'Launch moved to Monday. Bring the deck and the brief.');
  // Escape closes the popover and gives focus back to its opener.
  await reloadedPanel.getByRole('heading',{name:'Context · Roadmap',exact:true}).waitFor();
  await page.keyboard.press('Escape');
  await reloadedPanel.waitFor({state:'detached'});
  assert.deepEqual(await focused(page).then(f=>[f.tag,f.text.startsWith('Canvas context')]),['BUTTON',true]);

  // The area chip reads the counts (nothing yet: an invitation), and one click opens the popover under it.
  assert.equal(await chipOf(page,'Launch').textContent(),'◱ Add context');
  assert.equal(await chipOf(page,'Launch').getAttribute('title'),'Notes and files every chat in this area can see');
  assert.equal(await areaOf(page,'Launch').getByRole('button',{name:'Context…'}).count(),0,'no Context… menu item any more');
  const first=await openAreaContext(page,'Launch');
  assert.deepEqual(await focused(page).then(f=>[f.tag,f.text,f.inPanel]),['H2','Context · Launch',true]);
  await first.getByText('Every chat in this area sees this, on top of the canvas context. Agents read it as files.',{exact:true}).waitFor();
  // Anchored under the chip, inside the window.
  const chipBox=(await chipOf(page,'Launch').boundingBox())!, popBox=(await first.boundingBox())!;
  assert.ok(popBox.y>=chipBox.y+chipBox.height&&popBox.y<chipBox.y+chipBox.height+24,`popover under the chip: ${popBox.y} vs ${chipBox.y+chipBox.height}`);
  assert.ok(popBox.x>=16&&popBox.x+popBox.width<=page.viewportSize()!.width-16,'popover inside the window');
  assert.equal(await chipOf(page,'Launch').getAttribute('aria-expanded'),'true');
  await page.keyboard.press('Escape');
  await first.waitFor({state:'detached'});
  assert.deepEqual(await focused(page).then(f=>[f.label.startsWith('Context for Launch:'),f.area]),[true,'Area Launch']);
  // An outside click closes it too.
  await openAreaContext(page,'Launch');
  await page.locator('.canvas-surface').click({position:{x:20,y:20}});
  await first.waitFor({state:'detached'});

  // One click with a chat open: the popover opens beside it, and the chat stays open.
  await page.locator(`.canvas-card[data-channel-id="${h.project.channelId}"] .canvas-card-title`).click();
  const chat=page.locator('.canvas-chat');
  await chat.waitFor();
  await chat.getByRole('button',{name:'Split screen',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('.canvas-chat')?.getAttribute('data-mode')==='split');
  // The chat's sub-line: its faces, then where it is and how many contexts it sees (the canvas and Launch).
  const sub=page.locator('.canvas-chat-sub');
  await sub.getByText('in Launch ·',{exact:true}).waitFor();
  await sub.getByRole('button',{name:'sees 2 contexts',exact:true}).waitFor();
  assert.equal(await sub.getByRole('button',{name:'sees 2 contexts',exact:true}).getAttribute('title'),'Sees: Roadmap, Launch');
  assert.match(await sub.getByRole('img').getAttribute('aria-label')??'',new RegExp(`^In this chat: .*${agentName}`));
  await openAreaContext(page,'Launch');
  assert.equal(await chat.isVisible(),true,'opening context leaves the chat open');
  await first.getByRole('button',{name:'Done',exact:true}).click();
  await first.waitFor({state:'detached'});
  // The sub-line's count opens the same popover, under itself; the chat still stays.
  await sub.getByRole('button',{name:'sees 2 contexts',exact:true}).click();
  await first.waitFor();
  assert.equal(await chat.isVisible(),true);
  await page.keyboard.press('Escape');
  await first.waitFor({state:'detached'});
  assert.equal(await chat.isVisible(),true,'Escape closes only the popover');
  // In focus too, with focus left on plain text inside the popover (not on a field): Escape is the popover's, not the chat's.
  await chat.getByRole('button',{name:'Split screen',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('.canvas-chat')?.getAttribute('data-mode')==='focus');
  await sub.getByRole('button',{name:'sees 2 contexts',exact:true}).click();
  await first.waitFor();
  await first.locator('.canvas-context-explainer').click();
  await page.keyboard.press('Escape');
  await first.waitFor({state:'detached'});
  assert.equal(await chat.getAttribute('data-mode'),'focus','the focus chat stays open');
  await chat.getByRole('button',{name:'Split screen',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('.canvas-chat')?.getAttribute('data-mode')==='split');
  // Opening in place brought the card to 100%; Fit shows both areas again.
  await page.getByRole('button',{name:'Fit',exact:true}).click();

  // Area context: the warning (Launch holds the harness chat), then an upload with progress.
  const panel=await openAreaContext(page,'Launch');
  await panel.getByText(WARNING,{exact:true}).waitFor();
  const hold=h.holdNext(`/api/canvases/${roadmap}/areas/${launch}/context/files`);
  const chooser=page.waitForEvent('filechooser');
  await panel.getByRole('button',{name:'Add files',exact:true}).click();
  await (await chooser).setFiles({name:'brief.txt',mimeType:'text/plain',buffer:Buffer.from('Synthetic launch brief')});
  await hold.started;
  await panel.getByRole('progressbar',{name:'Uploading brief.txt',exact:true}).waitFor();
  hold.release();
  await panel.getByRole('link',{name:'brief.txt',exact:true}).waitFor();
  await panel.getByRole('progressbar').waitFor({state:'detached'});
  await areaOf(page,'Launch').getByRole('button',{name:'Context for Launch: 1 file',exact:true}).waitFor();
  assert.equal(await chipOf(page,'Research').textContent(),'◱ Add context','an area without notes or files invites some');
  // Launch holds a chat, so its files stay in the popover rather than on a shelf.
  assert.equal(await areaOf(page,'Launch').locator('.canvas-area-shelf').count(),0);

  // Readers: the harness server has no service token, so agents cannot be given context keys.
  await panel.getByText("Agents can't read context on this server yet",{exact:true}).waitFor();

  // Links: an area on another canvas, and one on this canvas.
  const addArea=panel.getByRole('button',{name:'+ Use context from another area',exact:true});
  await panel.getByText('Nothing linked. Link another area instead of copying its files here.',{exact:true}).waitFor();
  const picker=panel.getByRole('group',{name:'Areas you can use',exact:true});
  const link=async(title:string)=>{
    await addArea.click();
    await picker.locator('button').filter({hasText:title}).click();
    await panel.locator('.canvas-context-ref').filter({hasText:title}).waitFor();
  };
  // The picker groups this canvas's areas and the other canvases', each with its counts.
  await addArea.click();
  await picker.getByText('On Roadmap',{exact:true}).waitFor();
  await picker.getByText('Other canvases',{exact:true}).waitFor();
  assert.deepEqual(await picker.locator('.canvas-context-picker-title').allInnerTexts(),['Research','Brand › Brand kit']);
  assert.deepEqual(await picker.locator('button small').allInnerTexts(),['Nothing yet','Nothing yet']);
  await addArea.click();
  await link('Brand kit');
  const bar=areaOf(page,'Launch').locator('.canvas-area-bar');
  // Brand kit lives on another canvas: `↗`, with the canvas in the tooltip, and "on Brand" in its row.
  const brandChip=bar.getByRole('button',{name:'↗ Brand kit',exact:true});
  await brandChip.waitFor();
  assert.equal(await brandChip.getAttribute('title'),"Uses Brand › Brand kit's context (linked, not copied)");
  await panel.locator('.canvas-context-ref').filter({hasText:'Brand kit'}).getByText('on Brand · Nothing yet',{exact:true}).waitFor();
  // The picker leaves out this area and areas already linked.
  await addArea.click();
  await picker.waitFor();
  assert.deepEqual(await picker.locator('.canvas-context-picker-title').allInnerTexts(),['Research']);
  await addArea.click();
  await link('Research');
  const chip=bar.getByRole('button',{name:'↳ Research',exact:true});
  await chip.waitFor();
  // The open chat now sees the canvas, Launch and both linked areas.
  await sub.getByRole('button',{name:'sees 4 contexts',exact:true}).waitFor();
  // While Launch's popover is open its line to Research (on this canvas) is drawn, as in the mock.
  await page.locator('.canvas-context-line').waitFor();
  await panel.getByRole('button',{name:'Done',exact:true}).click();
  await panel.waitFor({state:'detached'});
  assert.equal(await page.locator('.canvas-context-line').count(),0,'no link line once closed, until a chip is hovered');
  await chip.hover();
  await page.locator('.canvas-context-line').waitFor();
  await brandChip.hover();
  // Brand kit is on another canvas: no line to draw.
  await page.locator('.canvas-context-line').waitFor({state:'detached'});
  // Pressing `↳ Research` (from the keyboard here) frames Launch and Research together and keeps their line drawn a moment.
  await page.mouse.move(1,1);
  await chip.focus();
  await page.keyboard.press('Enter');
  await page.waitForFunction(()=>{
    const surface=document.querySelector('.canvas-surface')!.getBoundingClientRect();
    return [...document.querySelectorAll('.canvas-area')].every(area=>{const box=area.getBoundingClientRect();return box.left>=surface.left-1&&box.right<=surface.right+1&&box.top>=surface.top-1&&box.bottom<=surface.bottom+1;});
  });
  await page.evaluate(()=>(document.activeElement as HTMLElement|null)?.blur());
  assert.equal(await page.locator('.canvas-context-line').count(),1,'the line stays drawn after the chip loses focus');
  await page.locator('.canvas-context-line').waitFor({state:'detached'});
  assert.equal(await page.getByRole('dialog',{name:/^Context for/}).count(),0,'a reveal opens no popover');
  // ✕ stops using a link again.
  await openAreaContext(page,'Launch');
  await panel.getByRole('button',{name:'Stop using Research',exact:true}).click();
  await chip.waitFor({state:'detached'});
  await sub.getByRole('button',{name:'sees 3 contexts',exact:true}).waitFor();
  await panel.getByRole('button',{name:'Done',exact:true}).click();
  await chat.getByRole('button',{name:'Close',exact:true}).click();
  await chat.waitFor({state:'detached'});
  // Pressing `↗ Brand kit` opens the Brand canvas, where that area lives.
  await brandChip.click();
  await page.waitForURL(url=>url.searchParams.get('canvas')===brand);
  await areaOf(page,'Brand kit').waitFor();

  // Used by: the source area says so on the canvas and in its popover; with no chats, its files sit on a shelf.
  const brandArea=(await call<{areas:{id:string}[]}>(h,'GET',`/api/canvases/${brand}/board`)).areas[0].id;
  const shelfFile=new FormData();
  shelfFile.append('file',new File(['Synthetic voice guide'],'voice.md',{type:'text/markdown'}));
  assert.equal((await fetch(`${h.apiUrl}/api/canvases/${brand}/areas/${brandArea}/context/files`,{method:'POST',headers:{cookie:h.cookie},body:shelfFile})).status,201);
  await openCanvas(page,base,brand);
  await areaOf(page,'Brand kit').getByText('Used by Launch. Edit here once, they all see it.',{exact:true}).waitFor();
  const shelf=areaOf(page,'Brand kit').getByRole('list',{name:'Files in Brand kit',exact:true});
  await shelf.getByRole('link',{name:'voice.md',exact:true}).waitFor();
  assert.equal(await chipOf(page,'Brand kit').textContent(),'◱ 1 file');
  const source=await openAreaContext(page,'Brand kit');
  await source.getByText('Used by Launch. Changes here reach them right away.',{exact:true}).waitFor();
  // Launch, which holds the chat, uses Brand kit: that chat's agents read it too.
  await source.getByText(WARNING,{exact:true}).waitFor();

  // No wake-ups: notes, a file and links posted nothing to the chat.
  assert.equal(await chatEvents(h),events,'context edits never reach the chat');

  // View-only: a teammate sees everything read-only.
  const mate=await h.loginAs('mate');
  const mateId=(await call<{id:string;username:string}[]>(h,'GET','/api/humans')).find(person=>person.username==='mate')!.id;
  const version=(await call<{id:string;version:number}[]>(h,'GET','/api/canvases')).find(canvas=>canvas.id===roadmap)!.version;
  await call(h,'PUT',`/api/canvases/${roadmap}/members`,{visibility:'shared',members:[{humanId:mateId,role:'view'}],version});
  await openCanvas(mate.page,base,roadmap);
  await canvasButton(mate.page).click();
  const theirs=canvasPopover(mate.page);
  const notes=theirs.getByRole('textbox',{name:'Notes',exact:true});
  await notes.waitFor();
  await notesValue(mate.page,'Launch moved to Monday. Bring the deck and the brief.');
  assert.equal(await canvasButton(mate.page).innerText(),'Canvas context · Notes');
  assert.equal(await notes.getAttribute('readonly'),'','the notes are read-only');
  assert.equal(await theirs.getByRole('button',{name:'Add files',exact:true}).count(),0);
  await theirs.getByRole('button',{name:'Done',exact:true}).click();
  // A viewer has no area menu (Rename and Delete only), but the chip still opens the context, read-only.
  assert.equal(await areaOf(mate.page,'Launch').getByRole('button',{name:'Area options',exact:true}).count(),0);
  const theirArea=await openAreaContext(mate.page,'Launch');
  await theirArea.getByRole('link',{name:'brief.txt',exact:true}).waitFor();
  // The mate cannot read the Brand canvas, so its area is never named, counted or placed for them.
  await theirArea.locator('.canvas-context-ref').filter({hasText:'Unavailable area'}).waitFor();
  assert.equal(await theirArea.locator('.canvas-context-ref small').count(),0,'no counts or canvas for an unreadable source');
  assert.equal(await theirArea.getByText('Brand kit').count(),0);
  assert.equal(await theirArea.getByRole('textbox',{name:'Notes',exact:true}).getAttribute('readonly'),'');
  for(const name of ['Add files','+ Use context from another area','Remove brief.txt','Stop using Unavailable area']){
    assert.equal(await theirArea.getByRole('button',{name,exact:true}).count(),0,`no ${name} for a viewer`);
  }
  // A file dropped on the read-only popover is taken (the browser never opens it in place of the canvas) and refused.
  const uploads:string[]=[];
  mate.page.on('request',request=>{if(request.method()==='POST'&&/\/context\/files$/.test(new URL(request.url()).pathname))uploads.push(request.url());});
  const prevented=await mate.page.evaluate(()=>{
    const data=new DataTransfer();
    data.items.add(new File(['synthetic bytes'],'nope.txt',{type:'text/plain'}));
    const target=document.querySelector('.canvas-context .canvas-context-explainer')!;
    const over=new DragEvent('dragover',{bubbles:true,cancelable:true,dataTransfer:data}), drop=new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:data});
    target.dispatchEvent(over); target.dispatchEvent(drop);
    return [over.defaultPrevented,drop.defaultPrevented];
  });
  assert.deepEqual(prevented,[true,true],'dragover and drop are prevented');
  await mate.page.locator('.canvas-notice').getByText('You can view this canvas but not add files to its context.',{exact:true}).waitFor();
  assert.equal(new URL(mate.page.url()).searchParams.get('canvas'),roadmap,'still on the canvas');
  await theirArea.waitFor();
  assert.deepEqual(uploads,[]);
},{canvas:true});

/** Drags a card by its title until its centre is over the middle of the area, then drops it. */
async function dragCardInto(page:Page,channelId:string,areaTitle:string){
  const card=page.locator(`.canvas-card[data-channel-id="${channelId}"]`);
  const from=(await card.locator('.canvas-card-title').boundingBox())!, body=(await card.boundingBox())!, into=(await areaOf(page,areaTitle).boundingBox())!;
  const grab={x:from.x+from.width/2,y:from.y+from.height/2}, centre={x:body.x+body.width/2,y:body.y+body.height/2};
  await page.mouse.move(grab.x,grab.y);
  await page.mouse.down();
  await page.mouse.move(into.x+into.width/2+grab.x-centre.x,into.y+into.height/2+grab.y-centre.y,{steps:8});
  await page.mouse.up();
}
type HomeBoard={cards:{channelId:string;x:number;y:number;home?:{isHere:boolean;label:string|null}|null}[]};
const homeOf=async(h:ChatHarness,canvasId:string)=>(await call<HomeBoard>(h,'GET',`/api/canvases/${canvasId}/board`)).cards.find(card=>card.channelId===h.project.channelId);
/** Polls the board through the API until the predicate holds (a page-side async predicate would never wait). */
async function boardUntil(h:ChatHarness,canvasId:string,ok:(board:HomeBoard)=>boolean,what:string){
  for(let attempt=0;attempt<100;attempt++){
    if(ok(await call<HomeBoard>(h,'GET',`/api/canvases/${canvasId}/board`)))return;
    await new Promise(resolve=>setTimeout(resolve,100));
  }
  assert.fail(`board never reached: ${what}`);
}

await runChatTest('canvas homes: labels, Use this area\'s context and the drop warning with Undo',async h=>{
  const {page,base}=h, chat=h.project.channelId;
  const plan=(await call<{id:string}>(h,'POST','/api/canvases',{id:crypto.randomUUID(),name:'Plan'})).id;
  const launch=crypto.randomUUID(),briefing=crypto.randomUUID();
  await call(h,'POST',`/api/canvases/${plan}/areas`,{id:launch,title:'Launch',x:0,y:0,w:420,h:320});
  await call(h,'POST',`/api/canvases/${plan}/areas`,{id:briefing,title:'Briefing',x:480,y:0,w:420,h:320});
  await call(h,'POST',`/api/canvases/${plan}/areas`,{id:crypto.randomUUID(),title:'Quiet',x:0,y:360,w:420,h:240});
  const put=async(path:string,notes:string)=>call(h,'PUT',path,{notes,version:(await call<{version:number}>(h,'GET',path)).version});
  await put(`/api/canvases/${plan}/areas/${briefing}/context`,'Synthetic briefing notes.');
  await call(h,'POST',`/api/canvases/${plan}/cards`,{cards:[{channelId:chat,x:40,y:100}]});
  assert.deepEqual((await homeOf(h,plan))!.home,{isHere:true,label:'Launch'});
  let events=await chatEvents(h);
  await openCanvas(page,base,plan);
  const card=page.locator(`.canvas-card[data-channel-id="${chat}"]`);
  await card.waitFor();
  assert.equal(await card.getByText(/^context from/).count(),0,'a chat in its home area shows no label');
  const notice=page.locator('.canvas-notice');
  const study=(await call<{id:string}>(h,'POST','/api/canvases',{id:crypto.randomUUID(),name:'Study plan'})).id;
  const studyArea=crypto.randomUUID();
  await call(h,'POST',`/api/canvases/${study}/areas`,{id:studyArea,title:'Study',x:0,y:0,w:420,h:320});

  // The warning belongs to its canvas: switching away drops the notice, and coming back finds nothing to undo.
  await dragCardInto(page,chat,'Briefing');
  await notice.getByText(WARNING,{exact:true}).waitFor();
  await openCanvas(page,base,study);
  await notice.getByText(WARNING,{exact:true}).waitFor({state:'detached'});
  await openCanvas(page,base,plan);
  assert.equal(await notice.getByText(WARNING,{exact:true}).count(),0);
  await dragCardInto(page,chat,'Launch');
  await boardUntil(h,plan,board=>board.cards.find(c=>c.channelId===chat)?.home?.label==='Launch','home Launch');
  await card.waitFor();
  const before=(await homeOf(h,plan))!;

  // A move into an area with notes changes the home: the warning appears, and Undo moves the card back.
  await dragCardInto(page,chat,'Briefing');
  await notice.getByText(WARNING,{exact:true}).waitFor();
  assert.deepEqual((await homeOf(h,plan))!.home,{isHere:true,label:'Briefing'});
  await notice.getByRole('button',{name:'Undo',exact:true}).click();
  await notice.getByText(WARNING,{exact:true}).waitFor({state:'detached'});
  await boardUntil(h,plan,board=>{
    const found=board.cards.find(c=>c.channelId===chat);
    return found?.x===before.x&&found?.y===before.y&&found.home?.label==='Launch';
  },'card back at its place with home Launch');
  assert.deepEqual((await homeOf(h,plan))!.home,{isHere:true,label:'Launch'},'the home followed the card back');
  assert.equal(await card.getByText(/^context from/).count(),0);
  // A move into an area with no context changes the home but warns about nothing.
  await dragCardInto(page,chat,'Quiet');
  await boardUntil(h,plan,board=>board.cards.find(c=>c.channelId===chat)?.home?.label==='Quiet','home Quiet');
  await card.waitFor();
  assert.equal(await notice.getByText(WARNING,{exact:true}).count(),0,'no warning when the area has no context');

  // The chat on a second canvas: its card says where the context comes from.
  await call(h,'POST',`/api/canvases/${study}/cards`,{cards:[{channelId:chat,x:40,y:100}]});
  await openCanvas(page,base,study);
  const second=page.locator(`.canvas-card[data-channel-id="${chat}"]`);
  await second.getByText('context from Quiet',{exact:true}).waitFor();
  // Compact cards (zoomed out) keep only the title and faces: the status line is hidden, home label or not.
  assert.equal(await chatEvents(h),events,'drags, Undo and canvas switches never reach the chat');
  const trigger=await h.emit('message.created',{text:'Synthetic trigger'},{source:'human:demo-owner'});
  await h.emit('agent.turn.started',{triggerEventId:trigger.id},{source:`agent:${agentName}`,channelId:chat});
  events=await chatEvents(h);
  const status=second.locator('.canvas-card-row[data-kind="agent"] .canvas-card-what');
  await second.locator('.canvas-card-row[data-kind="agent"][data-state="working"]').waitFor();
  for(let i=0;i<4;i++)await page.getByRole('button',{name:'Zoom out',exact:true}).click();
  await page.getByLabel('Zoom level',{exact:true}).getByText('41%',{exact:true}).waitFor();
  await status.waitFor({state:'hidden'});
  for(let i=0;i<4;i++)await page.getByRole('button',{name:'Zoom in',exact:true}).click();
  await page.getByLabel('Zoom level',{exact:true}).getByText('100%',{exact:true}).waitFor();
  await second.locator('.canvas-card-title').click();
  const header=page.locator('.canvas-chat-bar');
  // Not its home: the sub-line says where its context comes from instead of counting.
  await header.locator('.canvas-chat-sub').getByText('context from Quiet',{exact:true}).waitFor();
  assert.equal(await header.locator('.canvas-chat-sees').count(),0);
  await header.getByRole('button',{name:'More chat actions',exact:true}).click();
  await header.getByRole('button',{name:"Use this area's context",exact:true}).click();
  await header.locator('.canvas-chat-sub').getByRole('button',{name:'sees 2 contexts',exact:true}).waitFor();
  await page.locator('.canvas-notice').getByText("This chat now uses Study's context.",{exact:true}).waitFor();
  await second.getByText(/^context from/).waitFor({state:'detached'});
  await header.getByRole('button',{name:"Use this area's context",exact:true}).waitFor({state:'detached'});
  await openCanvas(page,base,plan);
  await page.locator(`.canvas-card[data-channel-id="${chat}"]`).getByText('context from Study',{exact:true}).waitFor();

  // A first placement from the pile: the warning appears, and Undo takes the card off again and clears the home.
  const title=await page.locator(`.canvas-card[data-channel-id="${chat}"] .canvas-card-title`).innerText();
  for(const canvas of [plan,study]){
    const row=(await call<HomeBoard>(h,'GET',`/api/canvases/${canvas}/board`)).cards.find(c=>c.channelId===chat)!;
    await call(h,'DELETE',`/api/canvases/${canvas}/cards/${chat}?version=${(row as unknown as {version:number}).version}`);
  }
  await openCanvas(page,base,plan);
  const pile=await openDrawer(page);
  const target=(await areaOf(page,'Briefing').boundingBox())!;
  await dropRow(page,pile.locator('.canvas-drawer-row').filter({has:page.getByRole('checkbox',{name:`Select ${title}`,exact:true})}),
    {x:target.x+target.width/2,y:target.y+target.height/2});
  await page.locator('.canvas-notice').getByText(WARNING,{exact:true}).waitFor();
  assert.deepEqual((await homeOf(h,plan))!.home,{isHere:true,label:'Briefing'});
  await page.locator('.canvas-notice').getByRole('button',{name:'Undo',exact:true}).click();
  await page.locator(`.canvas-card[data-channel-id="${chat}"]`).waitFor({state:'detached'});
  await boardUntil(h,plan,board=>!board.cards.some(c=>c.channelId===chat),'card removed');
  // The home is gone: the next placement homes the chat where it lands, not in Briefing.
  await call(h,'POST',`/api/canvases/${study}/cards`,{cards:[{channelId:chat,x:40,y:100}]});
  assert.deepEqual((await homeOf(h,study))!.home,{isHere:true,label:'Study'});
  assert.equal(await chatEvents(h),events,'homes and warnings never reach the chat');
},{canvas:true});

await runChatTest('canvas context: canvas notes warn on a drop, linked chats warn in the panel, an unavailable home says so',async h=>{
  const {page,base}=h, chat=h.project.channelId;
  const board=(await call<{id:string}>(h,'POST','/api/canvases',{id:crypto.randomUUID(),name:'Board'})).id;
  const empty=crypto.randomUUID();
  await call(h,'POST',`/api/canvases/${board}/areas`,{id:empty,title:'Empty',x:0,y:0,w:420,h:320});
  await call(h,'PUT',`/api/canvases/${board}/context`,{notes:'Synthetic canvas notes.',version:0});
  const events=await chatEvents(h);
  await openCanvas(page,base,board);
  await page.locator('.canvas-context-button.has-context').waitFor();
  const notice=page.locator('.canvas-notice');

  // I1: a first placement outside every area, on a canvas with notes, warns (the area under it has none).
  const pile=await openDrawer(page);
  const beside=(await areaOf(page,'Empty').boundingBox())!;
  await dropRow(page,pile.locator('.canvas-drawer-row').filter({hasText:'Synthetic chat project'}).first(),
    {x:beside.x+beside.width+160,y:beside.y+beside.height/2});
  await notice.getByText(WARNING,{exact:true}).waitFor();
  assert.deepEqual((await homeOf(h,board))!.home,{isHere:true,label:'Board'});
  await notice.getByRole('button',{name:'Undo',exact:true}).click();
  await page.locator(`.canvas-card[data-channel-id="${chat}"]`).waitFor({state:'detached'});
  // A move within the home canvas into an area without context brings nothing new: no warning.
  await call(h,'POST',`/api/canvases/${board}/cards`,{cards:[{channelId:chat,x:40,y:380}]});
  await openCanvas(page,base,board);
  await page.locator('.canvas-context-button.has-context').waitFor();
  await page.locator(`.canvas-card[data-channel-id="${chat}"]`).waitFor();
  const moved=page.waitForResponse(response=>response.request().method()==='PATCH'&&new URL(response.url()).pathname===`/api/canvases/${board}/cards/${chat}`);
  await dragCardInto(page,chat,'Empty');
  assert.equal((await moved).status(),200);
  assert.deepEqual((await homeOf(h,board))!.home,{isHere:true,label:'Empty'});
  assert.equal(await notice.getByText(WARNING,{exact:true}).count(),0,'the canvas context was already this chat\'s');

  // Smaller item 3: an area used by an area that holds a chat warns in its panel, with no card of its own.
  const library=(await call<{id:string}>(h,'POST','/api/canvases',{id:crypto.randomUUID(),name:'Library'})).id;
  const sources=crypto.randomUUID();
  await call(h,'POST',`/api/canvases/${library}/areas`,{id:sources,title:'Sources',x:0,y:0,w:420,h:320});
  await openCanvas(page,base,library);
  let panel=await openAreaContext(page,'Sources');
  await panel.getByRole('textbox',{name:'Notes',exact:true}).waitFor();
  assert.equal(await panel.getByText(WARNING,{exact:true}).count(),0,'no chat reads Sources yet');
  await panel.getByRole('button',{name:'Done',exact:true}).click();
  await panel.waitFor({state:'detached'});
  await call(h,'POST',`/api/canvases/${board}/areas/${empty}/context/links`,{sourceAreaId:sources});
  panel=await openAreaContext(page,'Sources');
  await panel.getByText(WARNING,{exact:true}).waitFor();
  await panel.getByRole('button',{name:'Done',exact:true}).click();

  // I2: a teammate in the chat re-homes it on the owner's shared canvas, then loses the canvas.
  const mate=await h.loginAs('mate');
  const mateId=(await call<{id:string;username:string}[]>(h,'GET','/api/humans')).find(person=>person.username==='mate')!.id;
  const share=async(members:{humanId:string;role:string}[])=>{
    const version=(await call<{id:string;version:number}[]>(h,'GET','/api/canvases')).find(canvas=>canvas.id===board)!.version;
    await call(h,'PUT',`/api/canvases/${board}/members`,{visibility:members.length?'shared':'private',members,version});
  };
  await share([{humanId:mateId,role:'edit'}]);
  assert.equal(await mate.page.evaluate(async([id,channel])=>(await fetch(`/api/canvases/${id}/cards/${channel}/home`,{method:'POST',headers:{'content-type':'application/json'},body:'{}'})).status,[board,chat] as const),200);
  await share([]);
  assert.deepEqual((await homeOf(h,board))!.home,{isHere:false,label:null,available:false});
  await openCanvas(page,base,board);
  const card=page.locator(`.canvas-card[data-channel-id="${chat}"]`);
  await card.getByText('context unavailable',{exact:true}).waitFor();
  assert.equal(await card.locator('.canvas-context-tag').innerText(),'unavailable');
  // A member re-homes it: available again, and the label goes.
  await card.locator('.canvas-card-title').click();
  await page.locator('.canvas-chat-bar').getByRole('button',{name:'More chat actions',exact:true}).click();
  await page.locator('.canvas-chat-bar').getByRole('button',{name:"Use this area's context",exact:true}).click();
  await card.getByText('context unavailable',{exact:true}).waitFor({state:'detached'});
  assert.deepEqual((await homeOf(h,board))!.home,{isHere:true,label:'Empty'});
  assert.equal(await chatEvents(h),events,'none of this reaches the chat');
},{canvas:true});
