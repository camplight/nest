// Canvas context (Phase 2 Task 5): the context panel, ↳ link chips and link lines on the real engine, API and WS. Synthetic data.
import assert from 'node:assert/strict';
import type {Page} from 'playwright';
import {runChatTest,type ChatHarness} from '../support/chat-harness';

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
const areaOf=(page:Page,title:string)=>page.getByRole('region',{name:`Area ${title}`,exact:true});
async function openAreaContext(page:Page,title:string){
  await areaOf(page,title).getByRole('button',{name:'Area options',exact:true}).click();
  await areaOf(page,title).getByRole('button',{name:'Context…',exact:true}).click();
  const panel=page.getByRole('complementary',{name:`Context for ${title}`,exact:true});
  await panel.waitFor();
  return panel;
}
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
  await page.getByRole('button',{name:'Canvas context',exact:true}).click();
  const canvasPanel=page.getByRole('complementary',{name:'Canvas context',exact:true});
  await canvasPanel.waitFor();
  // Focus moves into the panel, onto its heading.
  assert.deepEqual(await focused(page).then(f=>[f.tag,f.text,f.inPanel]),['H2','Canvas context',true]);
  await canvasPanel.getByText(WARNING,{exact:true}).waitFor();
  const saved=page.waitForResponse(response=>response.request().method()==='PUT'&&new URL(response.url()).pathname===`/api/canvases/${roadmap}/context`);
  await canvasPanel.getByRole('textbox',{name:'Notes',exact:true}).fill('Launch on Friday. Keep the copy short.');
  assert.equal((await saved).status(),200);
  await canvasPanel.getByText('Saved',{exact:true}).waitFor();
  await page.reload();
  await page.locator('.canvas-surface .canvas-world').waitFor({state:'attached'});
  await page.getByRole('button',{name:'Canvas context',exact:true}).click();
  const reloaded=page.getByRole('complementary',{name:'Canvas context',exact:true}).getByRole('textbox',{name:'Notes',exact:true});
  await page.waitForFunction(()=>(document.querySelector('.canvas-context textarea') as HTMLTextAreaElement|null)?.value==='Launch on Friday. Keep the copy short.');
  assert.equal(await reloaded.inputValue(),'Launch on Friday. Keep the copy short.');
  // Someone else saves first: the stale write shows the conflict and their version can be loaded.
  const stored=await call<{version:number}>(h,'GET',`/api/canvases/${roadmap}/context`);
  await call(h,'PUT',`/api/canvases/${roadmap}/context`,{notes:'Launch moved to Monday.',version:stored.version});
  const conflicted=page.waitForResponse(response=>response.request().method()==='PUT'&&new URL(response.url()).pathname===`/api/canvases/${roadmap}/context`);
  await reloaded.fill('Launch on Friday. Keep the copy short and plain.');
  assert.equal((await conflicted).status(),409);
  const reloadedPanel=page.getByRole('complementary',{name:'Canvas context',exact:true});
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
  await reloadedPanel.getByRole('button',{name:'Close',exact:true}).click();
  assert.equal((await flushed).status(),200);
  page.off('request',countPut);
  await reloadedPanel.waitFor({state:'detached'});
  // Focus returns to the button that opened the panel.
  assert.deepEqual(await focused(page).then(f=>[f.tag,f.text]),['BUTTON','Canvas context']);
  await page.reload();
  await page.locator('.canvas-surface .canvas-world').waitFor({state:'attached'});
  await page.getByRole('button',{name:'Canvas context',exact:true}).click();
  await notesValue(page,'Launch moved to Monday. Bring the deck.');

  // A reload inside the window: the leaving page sends the save with keepalive.
  await reloaded.fill('Launch moved to Monday. Bring the deck and the brief.');
  await page.reload();
  await page.locator('.canvas-surface .canvas-world').waitFor({state:'attached'});
  await page.getByRole('button',{name:'Canvas context',exact:true}).click();
  await notesValue(page,'Launch moved to Monday. Bring the deck and the brief.');
  // Escape closes the panel and gives focus back to its opener.
  await reloadedPanel.getByRole('heading',{name:'Canvas context',exact:true}).waitFor();
  await page.keyboard.press('Escape');
  await reloadedPanel.waitFor({state:'detached'});
  assert.deepEqual(await focused(page).then(f=>[f.tag,f.text]),['BUTTON','Canvas context']);

  // The area panel: focus on its heading, and Escape returns it to the area's options button.
  const first=await openAreaContext(page,'Launch');
  assert.deepEqual(await focused(page).then(f=>[f.tag,f.text,f.inPanel]),['H2','Launch',true]);
  await page.keyboard.press('Escape');
  await first.waitFor({state:'detached'});
  assert.deepEqual(await focused(page).then(f=>[f.label,f.area]),['Area options','Area Launch']);

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
  await areaOf(page,'Launch').locator('.canvas-area-context-dot').waitFor();
  assert.equal(await areaOf(page,'Research').locator('.canvas-area-context-dot').count(),0,'an area without notes or files has no dot');

  // Readers: the harness server has no service token, so agents cannot be given context keys.
  await panel.getByText("Agents can't read context on this server yet",{exact:true}).waitFor();

  // Links: an area on another canvas, and one on this canvas.
  const link=async(title:string)=>{
    await panel.getByRole('button',{name:'Use context from another area',exact:true}).click();
    await panel.getByRole('group',{name:'Areas you can use',exact:true}).getByRole('button',{name:new RegExp(`^${title}\\b`)}).click();
    await panel.getByRole('listitem').filter({hasText:`↳ ${title}`}).waitFor();
  };
  await link('Brand kit');
  const bar=areaOf(page,'Launch').locator('.canvas-area-bar');
  await bar.getByRole('button',{name:'↳ Brand kit',exact:true}).waitFor();
  // The picker leaves out this area and areas already linked.
  await panel.getByRole('button',{name:'Use context from another area',exact:true}).click();
  const picker=panel.getByRole('group',{name:'Areas you can use',exact:true});
  await picker.waitFor();
  assert.deepEqual((await picker.getByRole('button').allInnerTexts()).map(text=>text.split('\n')[0].trim()),['Research']);
  await panel.getByRole('button',{name:'Use context from another area',exact:true}).click();
  await link('Research');
  const chip=bar.getByRole('button',{name:'↳ Research',exact:true});
  await chip.waitFor();
  assert.equal(await page.locator('.canvas-context-line').count(),0,'no link line until a chip is hovered');
  await chip.hover();
  await page.locator('.canvas-context-line').waitFor();
  await bar.getByRole('button',{name:'↳ Brand kit',exact:true}).hover();
  // Brand kit is on another canvas: no line to draw.
  await page.locator('.canvas-context-line').waitFor({state:'detached'});
  // Remove takes a link off again.
  await panel.getByRole('button',{name:'Remove link to Research',exact:true}).click();
  await chip.waitFor({state:'detached'});

  // Used by: the source area's panel names the area that uses it.
  await openCanvas(page,base,brand);
  const source=await openAreaContext(page,'Brand kit');
  await source.getByText('Used by Launch',{exact:true}).waitFor();
  assert.equal(await source.getByText(WARNING,{exact:true}).count(),0,'no chat in Brand kit, so no warning');

  // No wake-ups: notes, a file and links posted nothing to the chat.
  assert.equal(await chatEvents(h),events,'context edits never reach the chat');

  // View-only: a teammate sees everything read-only.
  const mate=await h.loginAs('mate');
  const mateId=(await call<{id:string;username:string}[]>(h,'GET','/api/humans')).find(person=>person.username==='mate')!.id;
  const version=(await call<{id:string;version:number}[]>(h,'GET','/api/canvases')).find(canvas=>canvas.id===roadmap)!.version;
  await call(h,'PUT',`/api/canvases/${roadmap}/members`,{visibility:'shared',members:[{humanId:mateId,role:'view'}],version});
  await openCanvas(mate.page,base,roadmap);
  await mate.page.getByRole('button',{name:'Canvas context',exact:true}).click();
  const theirs=mate.page.getByRole('complementary',{name:'Canvas context',exact:true});
  const notes=theirs.getByRole('textbox',{name:'Notes',exact:true});
  await notes.waitFor();
  await notesValue(mate.page,'Launch moved to Monday. Bring the deck and the brief.');
  assert.equal(await notes.getAttribute('readonly'),'','the notes are read-only');
  assert.equal(await theirs.getByRole('button',{name:'Add files',exact:true}).count(),0);
  await theirs.getByRole('button',{name:'Close',exact:true}).click();
  const theirArea=await openAreaContext(mate.page,'Launch');
  await theirArea.getByRole('link',{name:'brief.txt',exact:true}).waitFor();
  // The mate cannot read the Brand canvas, so its area is never named to them.
  await theirArea.getByRole('listitem').filter({hasText:'↳ Unavailable area'}).waitFor();
  assert.equal(await theirArea.getByText('Brand kit').count(),0);
  assert.equal(await theirArea.getByRole('textbox',{name:'Notes',exact:true}).getAttribute('readonly'),'');
  for(const name of ['Add files','Use context from another area','Remove brief.txt','Remove link to Unavailable area']){
    assert.equal(await theirArea.getByRole('button',{name,exact:true}).count(),0,`no ${name} for a viewer`);
  }
},{canvas:true});
