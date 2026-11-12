// Schedules (Phase 3, Task 11): the open chat's clock popover, the card badge, the Setup chip and strips, Run now, a
// missed run, the top bar's Scheduled list with an agent's own booked run, pause and delete, and a view-role member's
// read-only view. Real engine, API, scheduler and WS; the scheduler's clock moves through the harness. Synthetic data only.
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {Locator,Page} from 'playwright';
import type {ScheduleView} from '@nest/schemas';
import {runChatTest,type ChatHarness} from '../support/chat-harness';

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
const schedules=async(h:ChatHarness)=>(await call<{schedules:ScheduleView[]}>(h,'GET','/api/flows/schedules')).schedules;
/** The page reads flows (needs and schedules) on focus and every 15 s: ask it now. */
const refocus=(page:Page)=>page.evaluate(()=>{window.dispatchEvent(new Event('focus'));});
/** The canvas notices on screen, without their Dismiss and Undo buttons. */
const notices=(page:Page)=>page.locator('.canvas-notice > span:first-child').allTextContents();
const text=(locator:Locator)=>locator.innerText().catch(()=>'');
const srcLines=(sheet:Locator)=>sheet.locator('.message-src-line').allInnerTexts();
const CHAT='Synthetic chat project';
const CLOCK='Schedule or trigger: run this on a timer or when something happens';
const RULE='Every Monday, Wednesday at 09:00';

/** A canvas with the harness chat's card; Pom and a loose chat of Pom's that holds Pom's own booked run. */
async function scheduleBoard(h:ChatHarness){
  await call(h,'POST','/api/agents',{name:'Pom',icon:'pom',visibility:'PUBLIC',modelId:'wrapped:none',workspacePath:join(mkdtempSync(join(tmpdir(),'nest-schedules-')),'pom')});
  const {id:canvasId}=await call<{id:string}>(h,'POST','/api/canvases',{id:crypto.randomUUID(),name:'Schedules board'});
  await call(h,'POST',`/api/canvases/${canvasId}/cards`,{cards:[{channelId:h.project.channelId,x:80,y:140}]});
  return canvasId;
}
async function pomRun(h:ChatHarness){
  const pom=await call<{channelId:string}>(h,'POST','/api/projects',{id:crypto.randomUUID(),name:'Error watch',description:'Synthetic loose chat',members:[{subscriberType:'AGENT',subscriberId:'Pom'}]});
  const response=await h.post('/api/events',{type:'agent.scheduled.trigger',source:'agent:Pom',channelId:pom.channelId,deliverAt:Date.now()+2*3_600_000,
    payload:{text:'Look at the error rate again once v3.4.1 is out.',targetAgentName:'Pom'}},{'content-type':'application/json','x-nest-runner-token':'fixture-runner'});
  assert.ok(response.ok,`Pom's run: ${response.status} ${await response.text()}`);
  return pom.channelId;
}
async function openChat(page:Page,base:string,canvasId:string){
  await page.goto(`${base}/?view=canvas&canvas=${canvasId}`);
  await page.getByRole('button',{name:`Open chat ${CHAT}`,exact:true}).click();
  const sheet=page.getByRole('dialog',{name:`Open chat ${CHAT}`,exact:true});
  await sheet.waitFor();
  return sheet;
}

await runChatTest('canvas schedules: the clock, the badge and strip, Run now, a missed run, the Scheduled list, pause and delete',async h=>{
  const {page,base}=h, chat=h.project.channelId;
  const canvasId=await scheduleBoard(h);
  await pomRun(h);
  const sheet=await openChat(page,base,canvasId);
  const zone=await page.evaluate(()=>Intl.DateTimeFormat().resolvedOptions().timeZone);

  // The top bar's Scheduled, before Search, with nothing live yet.
  const scheduled=page.locator('.canvas-sched-button');
  assert.equal(await scheduled.getAttribute('title'),'Scheduled jobs on this canvas');
  assert.equal(await scheduled.evaluate(el=>el.nextElementSibling?.classList.contains('canvas-search-button')&&!el.nextElementSibling.classList.contains('canvas-sched-button')),true,'before Search');

  // The clock: Pip, what to do, every week on Monday (on already) and Wednesday at 09:00.
  await sheet.getByRole('button',{name:CLOCK,exact:true}).click();
  const pop=page.getByRole('dialog',{name:'Schedule',exact:true});
  await pop.waitFor();
  assert.equal(await pop.locator('h2').innerText(),`Schedule · ${CHAT}`);
  assert.deepEqual(await pop.locator('.optrow').nth(1).locator('button').allInnerTexts(),['Once','Every day','Weekdays','Every week','Every month','Every few minutes'],'no Webhook until its form (T11-R1)');
  await pop.locator('.pick',{hasText:'Pip'}).click();
  await pop.getByLabel('What should happen').fill('Post the weekly recap.');
  await pop.getByRole('button',{name:'Every week',exact:true}).click();
  assert.equal(await pop.getByRole('button',{name:'Mon',exact:true}).getAttribute('aria-pressed'),'true','Monday is on, as in the mock');
  await pop.getByRole('button',{name:'Wed',exact:true}).click();
  await pop.getByLabel('Time',{exact:true}).fill('09:00');
  const summary=await pop.locator('.lk-sum').innerText();
  assert.ok(summary.startsWith(`Pip will post the weekly recap · ${RULE}. Next run:`),summary);
  assert.ok(summary.endsWith(`If a run can't start, it shows up in Needs you. Times are in ${zone}.`),summary);
  await pop.getByRole('button',{name:'Schedule it',exact:true}).click();
  await pop.waitFor({state:'detached'});
  await until(()=>notices(page),list=>list.some(t=>new RegExp(`^${RULE}\\. Next run (in \\d+ (min|h|days)|tomorrow)\\.$`).test(t)),'the saved toast');
  const [saved]=await schedules(h);
  assert.deepEqual([saved.agent,saved.prompt,saved.rule,saved.timezone],['Pip','Post the weekly recap.',{kind:'weekly',days:[0,2],time:'09:00'},zone]);

  // The card's badge, the Setup chip, and Switchyard's note in the chat.
  const card=page.locator(`.canvas-card[data-channel-id="${chat}"]`);
  const badge=card.locator('.sch');
  await until(()=>text(badge),t=>t==='Mon Wed 09:00','the card badge');
  assert.equal(await badge.getAttribute('title'),RULE);
  await until(()=>text(sheet.locator('.cfg .sm-chip').filter({hasText:'Mon Wed'})),t=>t==='Mon Wed 09:00','the Setup chip');
  await until(()=>srcLines(sheet),lines=>lines.includes(`Scheduled · ${RULE} · Pip`),'the note in the chat');
  assert.equal(await scheduled.locator('.cnt').innerText(),'2','two live: the schedule and Pom\'s run');

  // Setup: the strip, then Run now keeps focus and the chat shows the run.
  await sheet.locator('.cfg > summary').click();
  const strip=sheet.locator('.sch-strip');
  assert.match(await strip.innerText(),new RegExp(`^${RULE} · Pip · next (in \\d+ (min|h|days)|tomorrow)`));
  const runNow=strip.getByRole('button',{name:'Run now',exact:true});
  await runNow.click();
  assert.equal(await page.evaluate(()=>document.activeElement?.textContent),'Run now','Run now keeps focus');
  await until(()=>srcLines(sheet),lines=>lines.includes('Run started by you'),'the run in the chat');

  // Pip stopped and the scheduler 10 minutes past the run: missed, on the badge, the count, the strip and the list.
  await call(h,'POST','/api/agents/Pip/stop',{});
  h.setFlowsNow(saved.nextAt!+601_000);
  await h.flowsTick();await h.flowsTick();
  await refocus(page);
  await until(()=>text(card.locator('.sch.missed')),t=>t==='missed','the missed badge');
  await until(()=>text(scheduled.locator('.cnt.hot')),t=>t==='1 missed','the top-bar count');
  assert.match(await strip.innerText(),/ · missed \w{3} 09:00: agent stopped/);
  assert.equal(await strip.getAttribute('class'),'sch-strip missed');
  await scheduled.click();
  const list=page.getByRole('dialog',{name:'Scheduled jobs',exact:true});
  await list.waitFor();
  assert.equal(await list.locator('h2').innerText(),'Scheduled on Schedules board');
  assert.equal(await list.locator('.iv-foot .calm').innerText(),'To add one, open a chat and press the clock, or type “every Monday at 9 …” in the bottom box.');
  const missedRow=list.getByRole('region',{name:'Missed',exact:true}).locator('.srow');
  assert.match(await missedRow.innerText(),new RegExp(`^${CHAT}\\s+${RULE}\\s+Missed \\w{3} 09:00\\s+agent stopped$`));

  // Set by agents: Pom's own run, in its loose chat.
  await list.getByRole('button',{name:'Set by agents 1',exact:true}).click();
  const rows=list.locator('.srow');
  assert.equal(await rows.count(),1);
  assert.match(await rows.innerText(),/^Error watch\s+Once · \w{3} \d\d:\d\d · set by Pom · loose chat\s+\w{3} \d\d:\d\d\s+in (1|2) h$/);
  await list.getByRole('button',{name:'Done',exact:true}).click();
  await list.waitFor({state:'detached'});

  // Run now from the missed strip clears it.
  await runNow.click();
  await refocus(page);
  await until(()=>text(badge),t=>t==='Mon Wed 09:00','the badge is back');

  // Edit, Pause: the badge goes grey and the list has the row under Paused.
  await strip.getByRole('button',{name:'Edit',exact:true}).click();
  const edit=page.getByRole('dialog',{name:'Edit schedule',exact:true});
  await edit.waitFor();
  assert.equal(await edit.getByLabel('What should happen').inputValue(),'Post the weekly recap.');
  await edit.getByRole('button',{name:'Pause',exact:true}).click();
  await edit.waitFor({state:'detached'});
  await until(()=>card.locator('.sch.off').count(),n=>n===1,'the paused badge');
  assert.match(await strip.innerText(),new RegExp(`^${RULE} · Pip · paused`));
  await scheduled.click();
  await list.getByRole('region',{name:'Paused',exact:true}).locator('.srow',{hasText:CHAT}).waitFor();
  await list.getByRole('button',{name:'Done',exact:true}).click();

  // Delete: the toast, the strip and badge go, and the past lines stay.
  await strip.getByRole('button',{name:'Edit',exact:true}).click();
  await edit.waitFor();
  await edit.getByRole('button',{name:'Delete',exact:true}).click();
  await until(()=>notices(page),list=>list.includes('Schedule deleted. Past runs stay in the chat.'),'the delete toast');
  await until(()=>strip.count(),n=>n===0,'the strip is gone');
  assert.equal(await card.locator('.sch').count(),0,'no badge');
  const lines=await srcLines(sheet);
  assert.ok(lines.includes(`Scheduled · ${RULE} · Pip`)&&lines.includes('Run started by you'),JSON.stringify(lines));
  assert.equal((await schedules(h)).length,0);
  h.setFlowsNow(null);
},{canvas:true,flows:true});

await runChatTest('canvas schedules: a view-role canvas member sees the badge and strip, gets no clock, and edits nothing',async h=>{
  const {base}=h, chat=h.project.channelId;
  const canvasId=await scheduleBoard(h);
  const mate=await h.loginAs('mate');
  const humans=await call<{id:string;username:string}[]>(h,'GET','/api/humans');
  const {canvas}=await call<{canvas:{version:number}}>(h,'GET',`/api/canvases/${canvasId}/board`);
  await call(h,'PUT',`/api/canvases/${canvasId}/members`,{visibility:'shared',members:[{humanId:humans.find(p=>p.username==='mate')!.id,role:'view'}],version:canvas.version});
  await call(h,'POST','/api/flows/schedules',{id:crypto.randomUUID(),channelId:chat,agent:'Pip',prompt:'Summarise new email.',rule:{kind:'weekdays',time:'08:00'},timezone:'UTC'});

  const page=mate.page;
  const sheet=await openChat(page,base,canvasId);
  await until(()=>text(page.locator(`.canvas-card[data-channel-id="${chat}"] .sch`)),t=>t==='Weekdays 08:00','the badge');
  assert.equal(await sheet.getByRole('button',{name:CLOCK,exact:true}).count(),0,'no clock for a view-role member');
  await sheet.locator('.cfg > summary').click();
  const strip=sheet.locator('.sch-strip');
  assert.match(await strip.innerText(),/^Weekdays at 08:00 · Pip · set by demo-owner · next /);
  // A member of the chat may run and pause it (canManage); only its creator changes it (canEdit).
  await strip.getByRole('button',{name:'Edit',exact:true}).click();
  const edit=page.getByRole('dialog',{name:'Edit schedule',exact:true});
  await edit.waitFor();
  assert.equal(await edit.getByLabel('What should happen').getAttribute('readonly'),'');
  assert.equal(await edit.getByRole('button',{name:'Save',exact:true}).count(),0);
  assert.equal(await edit.getByRole('button',{name:'Pause',exact:true}).count(),1);
  await edit.getByRole('button',{name:'Done',exact:true}).click();
  await page.locator('.canvas-sched-button').click();
  await page.getByRole('dialog',{name:'Scheduled jobs',exact:true}).locator('.srow',{hasText:'set by demo-owner'}).waitFor();
},{canvas:true,flows:true});
