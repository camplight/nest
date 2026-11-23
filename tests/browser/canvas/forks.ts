// Forks (Phase 3, Task 9): Fork from here on a message in the open chat, the fork's card 360 px under its parent with
// `fork of …`, the dashed fork line and its label toggle, Switchyard's seed in the fork, the forked chip on the parent
// message, findings flowing back until paused, and a view-role member's fork opening as a loose chat. Real engine, API,
// worker and WS; synthetic data only.
import assert from 'node:assert/strict';
import type {Locator,Page} from 'playwright';
import type {BoardCard,CanvasBoard} from '@nest/schemas';
import {runChatTest,type ChatHarness} from '../support/chat-harness';

type EngineEvent={id:string;type:string;source:string;payload?:{text?:string;targetAgentName?:string;nestSwitchyard?:{kind?:string}}};
type OpenCard=Extract<BoardCard,{access:'open'}>;

async function call<T>(h:ChatHarness,method:string,path:string,body?:unknown):Promise<T>{
  const response=await fetch(h.apiUrl+path,{method,headers:{cookie:h.cookie,'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
  if(!response.ok)throw Error(`${method} ${path}: ${response.status} ${await response.text()}`);
  return response.status===204?undefined as T:await response.json() as T;
}
/** Polls a condition from Node (a page-side waitForFunction with an async callback resolves at once). */
async function until<T>(read:()=>Promise<T>,ok:(value:T)=>boolean,what:string,tries=100):Promise<T>{
  let value=await read();
  for(let attempt=0;attempt<tries&&!ok(value);attempt++){await new Promise(resolve=>setTimeout(resolve,100));value=await read();}
  assert.ok(ok(value),`${what}: ${JSON.stringify(value)}`);
  return value;
}
const board=(h:ChatHarness,canvasId:string)=>call<CanvasBoard>(h,'GET',`/api/canvases/${canvasId}/board`);
const messages=async(h:ChatHarness,channelId:string)=>call<EngineEvent[]>(h,'GET',`/api/events?channelId=${encodeURIComponent(channelId)}&type=message.created&limit=200`);
/** What Switchyard posted into a chat, by kind. */
const switchyard=async(h:ChatHarness,channelId:string,kind:string)=>(await messages(h,channelId)).filter(e=>e.source==='agent:Switchyard'&&e.payload?.nestSwitchyard?.kind===kind);
/** One Pip turn in a chat: started, its message, completed (as the runner emits them). */
async function turn(h:ChatHarness,channelId:string,text:string){
  const triggerEventId=crypto.randomUUID();
  await h.emit('agent.turn.started',{triggerEventId,eventCount:1},{channelId});
  await h.emit('message.created',{text},{channelId});
  await h.emit('agent.turn.completed',{triggerEventId,eventCount:1},{channelId});
}
const opacity=(locator:Locator)=>locator.evaluate(el=>getComputedStyle(el).opacity);
/** The canvas notices on screen, without their Dismiss and Undo buttons. */
const notices=(page:Page)=>page.locator('.canvas-notice > span:first-child').allTextContents();
const PIP_TEXT='Agreed on more data. I will go deep on competitors in a fork.';
const FORK_TITLE='Fork: Agreed on more data';
const PARENT='Synthetic chat project';

/** A canvas with the harness chat's card, and Pip's message in that chat. */
async function forkBoard(h:ChatHarness){
  const {id:canvasId}=await call<{id:string}>(h,'POST','/api/canvases',{id:crypto.randomUUID(),name:'Forks board'});
  await call(h,'POST',`/api/canvases/${canvasId}/cards`,{cards:[{channelId:h.project.channelId,x:80,y:140}]});
  const message=await h.emit('message.created',{text:PIP_TEXT});
  return {canvasId,message};
}
async function openParent(page:Page,base:string,canvasId:string){
  await page.goto(`${base}/?view=canvas&canvas=${canvasId}`);
  await page.getByRole('button',{name:`Open chat ${PARENT}`,exact:true}).click();
  const sheet=page.getByRole('dialog',{name:`Open chat ${PARENT}`,exact:true});
  await sheet.waitFor();
  return sheet;
}

await runChatTest('canvas forks: Fork from here places the fork under its parent, seeds it, chips the message, and findings flow back until paused',async h=>{
  const {page,base}=h, parent=h.project.channelId;
  const {canvasId,message}=await forkBoard(h);
  const mine=await h.emit('message.created',{text:'My own synthetic note'},{source:'human:demo-owner'});
  const sheet=await openParent(page,base,canvasId);

  // Fork from here: hidden until the message is hovered, or has keyboard focus within; offered on your own messages too.
  const pip=sheet.locator(`#message-${message.id}`);
  const button=pip.getByRole('button',{name:'Fork from here',exact:true});
  await button.waitFor({state:'attached'});
  await page.mouse.move(1,1);
  await until(()=>opacity(button),value=>value==='0','hidden before hover');
  await pip.locator('[data-slot="message-focus"]').focus();
  await until(()=>opacity(button),value=>value==='1','shown on focus within');
  await sheet.locator(`#message-${mine.id}`).getByRole('button',{name:'Fork from here',exact:true}).waitFor({state:'attached'});
  await pip.hover();
  await until(()=>opacity(button),value=>value==='1','shown on hover');
  assert.deepEqual(await button.evaluate(el=>{const s=getComputedStyle(el);return [s.position,s.top,s.right];}),['absolute','6px','6px']);
  await button.click();

  // The fork's card, 40 px right and 360 px below its parent, says what it was forked from; the chat closed onto it.
  const fork=await until(async()=>(await board(h,canvasId)).cards.find((c):c is OpenCard=>c.access==='open'&&c.title===FORK_TITLE),c=>Boolean(c),'the fork on the board');
  assert.deepEqual([fork!.x,fork!.y],[120,500]);
  const child=fork!.channelId;
  const card=page.locator(`.canvas-card[data-channel-id="${child}"]`);
  assert.equal(await card.locator('.c-fork').innerText(),`fork of ${PARENT}`);
  await sheet.waitFor({state:'detached'});
  await until(()=>notices(page),list=>list.includes(`Forked. The new conversation sees "${PARENT}" up to that message.`),'fork toast');
  await until(()=>page.evaluate(()=>document.activeElement?.closest('.canvas-card')?.getAttribute('data-channel-id')??document.activeElement?.tagName),id=>id===child,'focus on the fork');

  // A dashed fork line from the parent, labelled as the mock's.
  const line=page.locator('.canvas-links .lk.fork');
  await line.waitFor({state:'attached'});
  assert.equal(await line.evaluate(el=>getComputedStyle(el).strokeDasharray),'10px, 4px, 2px, 4px');
  const label=page.locator('.canvas-world > .lab');
  await until(()=>label.innerText(),text=>text==='fork · findings flow back','fork label');

  // Switchyard's seed in the fork: one line for Pip, as a `↳` line with no Fork from here.
  const [seed,...more]=await switchyard(h,child,'fork-seed');
  assert.equal(more.length,0,'one seed');
  assert.equal(seed.payload?.targetAgentName,'Pip');
  assert.match(seed.payload?.text??'',new RegExp(`^Forked from "${PARENT}" · Pip, \\d\\d:\\d\\d · set up by demo-owner\\n\\n[\\s\\S]*\\n\\n> ${PIP_TEXT.replace(/\./g,'\\.')}$`));
  await card.getByRole('button',{name:`Open chat ${FORK_TITLE}`,exact:true}).click();
  const forkSheet=page.getByRole('dialog',{name:`Open chat ${FORK_TITLE}`,exact:true});
  const src=forkSheet.locator('.message-src').first();
  await src.waitFor();
  assert.match(await src.locator('.message-src-line').innerText(),new RegExp(`^Forked from "${PARENT}" · Pip, \\d\\d:\\d\\d · set up by demo-owner$`));
  assert.equal(await src.locator('[aria-hidden="true"]').first().innerText(),'↳');
  assert.equal(await src.locator('.fork-btn').count(),0,'no Fork from here on a Switchyard line');
  await forkSheet.getByRole('button',{name:'Close',exact:true}).click();
  await forkSheet.waitFor({state:'detached'});

  // The parent message carries a chip that opens the fork.
  const again=await openParent(page,base,canvasId);
  const chip=again.locator(`#message-${message.id} .forked`);
  await chip.waitFor();
  assert.equal(await chip.innerText(),FORK_TITLE);
  await chip.click();
  await page.getByRole('dialog',{name:`Open chat ${FORK_TITLE}`,exact:true}).waitFor();
  await page.getByRole('dialog',{name:`Open chat ${FORK_TITLE}`,exact:true}).getByRole('button',{name:'Close',exact:true}).click();

  // Findings flow back: a finished Pip turn in the fork is handed to the parent.
  await turn(h,child,'Synthetic finding: three competitors charge per seat');
  const [found]=await until(()=>switchyard(h,parent,'handoff'),list=>list.length===1,'one finding back in the parent');
  assert.match(found.payload?.text??'',/Synthetic finding: three competitors charge per seat$/);

  // The fork label pauses it, with the toast; a later turn in the fork delivers nothing.
  await label.click();
  await until(()=>label.innerText(),text=>text==='fork · findings flow back · paused','paused label');
  await until(()=>notices(page),list=>list.includes(`Paused: findings from "${FORK_TITLE}" no longer flow back to "${PARENT}".`),'pause toast');
  await page.locator('.canvas-links .lk.fork.off').waitFor({state:'attached'});
  await turn(h,child,'Synthetic finding while paused');
  for(let n=0;n<3;n++)await h.flowsTick();
  assert.equal((await switchyard(h,parent,'handoff')).length,1,'nothing more flows back while paused');
},{canvas:true,flows:true});

await runChatTest('canvas forks: a view-role member\'s fork opens as a loose chat and leaves the canvas alone',async h=>{
  const {base}=h;
  const mate=await h.loginAs('mate');
  const {canvasId,message}=await forkBoard(h);
  const humans=await call<{id:string;username:string}[]>(h,'GET','/api/humans');
  const {canvas}=await board(h,canvasId);
  await call(h,'PUT',`/api/canvases/${canvasId}/members`,{visibility:'shared',members:[{humanId:humans.find(p=>p.username==='mate')!.id,role:'view'}],version:canvas.version});

  const page=mate.page;
  const sheet=await openParent(page,base,canvasId);
  const pip=sheet.locator(`#message-${message.id}`);
  await pip.hover();
  await pip.getByRole('button',{name:'Fork from here',exact:true}).click();
  const forkSheet=page.getByRole('dialog',{name:`Open chat ${FORK_TITLE}`,exact:true});
  await forkSheet.waitFor();
  await forkSheet.getByText('Plain chat · not on this canvas',{exact:false}).waitFor();
  await forkSheet.locator('.message-src').first().waitFor();
  // The toast is said inside the focus sheet too (the canvas behind it is hidden from screen readers).
  await forkSheet.getByRole('status').filter({hasText:`Forked. The new conversation sees "${PARENT}" up to that message.`}).waitFor({state:'attached'});
  assert.equal((await board(h,canvasId)).cards.length,1,'the canvas is unchanged');
},{canvas:true,flows:true});
