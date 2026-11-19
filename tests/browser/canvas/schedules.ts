// Schedules (Phase 3, Task 11): the open chat's clock popover, the card badge, the Setup chip and strips, Run now, a
// missed run, the top bar's Scheduled list with an agent's own booked run, pause and delete, and a view-role member's
// read-only view; typed repeats (Task 12); webhooks (Task 13). Real engine, API, scheduler and WS; the scheduler's clock
// moves through the harness. Synthetic data only.
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

  // The clock: Escape closes its popover and focus goes back to it.
  const clock=sheet.getByRole('button',{name:CLOCK,exact:true});
  await clock.click();
  const pop=page.getByRole('dialog',{name:'Schedule',exact:true});
  await pop.waitFor();
  await page.keyboard.press('Escape');
  await pop.waitFor({state:'detached'});
  assert.equal(await clock.evaluate(el=>document.activeElement===el),true,'focus is back on the clock');
  assert.equal(await sheet.count(),1,'Escape closed the popover, not the chat');
  // Pip, what to do, every week on Monday (on already) and Wednesday at 09:00.
  await clock.click();
  await pop.waitFor();
  assert.equal(await pop.locator('h2').innerText(),`Schedule · ${CHAT}`);
  assert.deepEqual(await pop.locator('.optrow').nth(1).locator('button').allInnerTexts(),['Once','Every day','Weekdays','Every week','Every month','Every few minutes','Webhook'],'the mock\'s kinds, Webhook last; App event follows it only when app events are available (this env has no Composio secret)');
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
  assert.equal(await scheduled.evaluate(el=>document.activeElement===el),true,'Done returns focus to Scheduled');

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
  await page.keyboard.press('Escape');
  await list.waitFor({state:'detached'});
  assert.equal(await scheduled.evaluate(el=>document.activeElement===el),true,'Escape returns focus to Scheduled');

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
  await sheet.getByRole('button',{name:'Split screen',exact:true}).waitFor();
  assert.equal(await sheet.getByRole('button',{name:CLOCK,exact:true}).count(),0,'no clock for a view-role member, beside a rendered header');
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
  const row=page.getByRole('dialog',{name:'Scheduled jobs',exact:true}).locator('.srow',{hasText:'set by demo-owner'});
  await row.waitFor();
  // A row goes to its chat, which keeps focus (the list closing does not pull it back to Scheduled).
  await row.click();
  await page.getByRole('dialog',{name:'Scheduled jobs',exact:true}).waitFor({state:'detached'});
  await until(()=>page.evaluate(()=>Boolean(document.activeElement?.closest('.canvas-chat, .canvas-card'))),inside=>inside,'focus on the chat');
},{canvas:true,flows:true});

// A webhook URL as the popover shows it once (Task 13).
const HOOK_URL=/^http:\/\/127\.0\.0\.1:\d+\/api\/hooks\/nest_hook_[A-Za-z0-9_-]{43}$/;

await runChatTest('canvas schedules: a phone has Scheduled in its top bar, text only, and its list opens the chat',async h=>{
  const {page,base}=h, chat=h.project.channelId;
  const canvasId=await scheduleBoard(h);
  await call(h,'POST','/api/flows/schedules',{id:crypto.randomUUID(),channelId:chat,agent:'Pip',prompt:'Summarise new email.',rule:{kind:'weekdays',time:'08:00'},timezone:'UTC'});
  await page.goto(`${base}/?view=canvas&canvas=${canvasId}`);
  // A phone shows the canvas, with the top bar's List toggle beside Scheduled and Search.
  await page.locator('.canvas-surface').waitFor();
  await page.getByRole('button',{name:'List',exact:true}).waitFor();
  const scheduled=page.locator('.canvas-sched-button');
  await until(()=>text(scheduled.locator('.cnt')),t=>t==='1','the count');
  assert.equal(await scheduled.locator('svg').evaluate(el=>getComputedStyle(el).display),'none','text only, like Search');
  assert.equal(await scheduled.locator('.canvas-bar-label').evaluate(el=>el.getBoundingClientRect().width>1),true,'the label shows');
  const viewport=page.viewportSize()!;
  const box=(await scheduled.boundingBox())!;
  assert.ok(box.x>=0&&box.x+box.width<=viewport.width,`inside the window: ${JSON.stringify(box)}`);
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'no horizontal page scroll');
  await scheduled.tap();
  const list=page.getByRole('dialog',{name:'Scheduled jobs',exact:true});
  await list.waitFor();
  const shown=(await list.boundingBox())!;
  assert.ok(shown.x>=0&&shown.x+shown.width<=viewport.width,`the list fits: ${JSON.stringify(shown)}`);
  // A row opens its chat full screen, which takes focus (not the Scheduled button the list closed back to).
  await list.locator('.srow',{hasText:CHAT}).tap();
  const sheet=page.getByRole('dialog',{name:`Open chat ${CHAT}`,exact:true});
  await sheet.waitFor();
  await list.waitFor({state:'detached'});
  await until(()=>sheet.evaluate(el=>el.contains(document.activeElement)),inside=>inside,'focus in the opened chat');

  // The webhook popover in its widest state, after Rotate URL (full URL, Copy, the note), fits the phone (Task 13).
  await call(h,'POST','/api/flows/triggers',{id:crypto.randomUUID(),channelId:chat,agent:'Pip',prompt:'Triage the new issue.',label:'Sentry'});
  await refocus(page);
  await sheet.locator('.cfg > summary').tap();
  const hookStrip=sheet.locator('.sch-strip[data-trigger-id]');
  await hookStrip.waitFor();
  await hookStrip.getByRole('button',{name:'Edit',exact:true}).tap();
  const edit=page.getByRole('dialog',{name:'Edit schedule',exact:true});
  await edit.getByRole('button',{name:'Rotate URL',exact:true}).tap();
  const hookUrl=edit.getByLabel('Webhook URL',{exact:true});
  await until(()=>hookUrl.inputValue(),value=>HOOK_URL.test(value),'the rotated URL');
  for(const [what,part] of [['popover',edit],['URL',hookUrl],['Copy',edit.getByRole('button',{name:'Copy',exact:true})],['note',edit.locator('.sched-hook-note')]] as const){
    const at=(await part.boundingBox())!;
    assert.ok(at.x>=0&&at.x+at.width<=viewport.width+0.5,`the webhook ${what} fits: ${JSON.stringify(at)}`);
  }
  assert.ok(await edit.evaluate(el=>el.scrollWidth<=el.clientWidth+1),'no sideways scroll in the popover');
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'no horizontal page scroll with the webhook popover');
  await edit.getByRole('button',{name:'Done',exact:true}).tap();
  await edit.waitFor({state:'detached'});

  // The bottom box's typed-repeat chip takes its own line above the message, inside the window (Task 12).
  await page.keyboard.press('Escape');
  await sheet.waitFor({state:'detached'});
  const message=page.getByRole('region',{name:'Start a chat',exact:true}).getByRole('textbox',{name:'Message',exact:true});
  await message.fill('every Monday at 9 post the recap');
  const chip=page.locator('.project-start-dock .pchip.sch2');
  await chip.waitFor();
  const [chipBox,boxBox]=[(await chip.boundingBox())!,(await message.boundingBox())!];
  assert.ok(chipBox.x>=0&&chipBox.x+chipBox.width<=viewport.width,`the chip fits: ${JSON.stringify(chipBox)}`);
  assert.ok(chipBox.y+chipBox.height<=boxBox.y+1,`the chip sits above the message: ${JSON.stringify({chipBox,boxBox})}`);
  assert.ok(boxBox.width>=150,`the message keeps its width: ${boxBox.width}`);
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'no horizontal page scroll with the chip');
},{canvas:true,flows:true,viewport:{width:375,height:740},hasTouch:true});

// Task 13: a webhook from the clock. Its URL is shown once, a call from outside (no cookie) lands in the chat, the URL is
// masked afterwards, and Rotate URL makes a new one. Synthetic payloads only.
await runChatTest('canvas schedules: a webhook shows its URL once, a call lands in the chat, and Rotate URL replaces it',async h=>{
  const {page,base}=h;
  const canvasId=await scheduleBoard(h);
  const sheet=await openChat(page,base,canvasId);
  await sheet.getByRole('button',{name:CLOCK,exact:true}).click();
  const pop=page.getByRole('dialog',{name:'Schedule',exact:true});
  await pop.waitFor();
  await pop.locator('.pick',{hasText:'Pip'}).click();
  await pop.getByLabel('What should happen').fill('Triage the new issue.');
  await pop.getByRole('button',{name:'Webhook',exact:true}).click();
  assert.equal(await pop.getByRole('button',{name:'Webhook',exact:true}).getAttribute('aria-pressed'),'true');
  assert.equal(await pop.getByLabel('Time',{exact:true}).count(),0,'no time for a webhook');
  assert.equal(await pop.getByRole('button',{name:'Schedule it',exact:true}).getAttribute('aria-disabled'),'true','a name is needed first');
  await pop.getByLabel('Name',{exact:true}).fill('Sentry');
  assert.equal(await pop.locator('.lk-sum').innerText(),'Pip will triage the new issue · When the webhook is called. Runs each time it happens. If a run can\'t start, it shows up in Needs you.');
  await pop.getByRole('button',{name:'Schedule it',exact:true}).click();

  // Made: the same popover, now the webhook's, with its full URL focused and selected, Copy, and the once-only note.
  const edit=page.getByRole('dialog',{name:'Edit schedule',exact:true});
  const url=edit.getByLabel('Webhook URL',{exact:true});
  await url.waitFor();
  const full=await url.inputValue();
  assert.match(full,HOOK_URL);
  // The dev proxy (Vite's changeOrigin) forwards no host, so the URL names the API itself; behind Caddy it is the forwarded host.
  assert.equal(await url.evaluate(el=>document.activeElement===el&&(el as HTMLInputElement).selectionEnd===(el as HTMLInputElement).value.length),true,'focused and selected');
  assert.equal(await url.evaluate(el=>getComputedStyle(el).fontFamily.includes('monospace')),true,'the mock\'s monospace input');
  assert.equal(await edit.locator('.sched-hook-note').innerText(),'Copy it now. It is shown only once.');
  assert.equal(await edit.getByRole('button',{name:'Copy',exact:true}).count(),1);
  await until(()=>notices(page),list=>list.includes('When the webhook is called. Runs each time it happens.'),'the saved toast');
  await until(()=>srcLines(sheet),lines=>lines.includes('Webhook · Sentry · Pip'),'the note in the chat');
  assert.equal(await page.locator('.canvas-sched-button .cnt').innerText(),'1');

  // A call from outside: no cookie, through the same origin the URL names.
  const called=await fetch(full,{method:'POST',headers:{'content-type':'application/json','x-github-delivery':'synthetic-1'},body:'{"issue":42}'});
  assert.equal(called.status,202);
  await until(()=>srcLines(sheet),lines=>lines.includes('Webhook · Sentry · set up by demo-owner'),'the ↳ Webhook line');
  await edit.getByRole('button',{name:'Done',exact:true}).click();
  await edit.waitFor({state:'detached'});

  // The strip: waiting, then the last call; the Setup chip and the badge say `webhook`; the list has it under events.
  await refocus(page);
  await sheet.locator('.cfg > summary').click();
  const strip=sheet.locator('.sch-strip');
  await until(()=>text(strip),t=>/^When the webhook is called · Sentry · Pip · waiting for it · last run \w{3} \d\d:\d\d ✓/.test(t),'the strip');
  assert.equal(await strip.getByRole('button',{name:'Run now',exact:true}).count(),0,'a webhook runs when called');
  assert.equal(await page.locator(`.canvas-card[data-channel-id="${h.project.channelId}"] .sch`).innerText(),'webhook');
  await page.locator('.canvas-sched-button').click();
  const list=page.getByRole('dialog',{name:'Scheduled jobs',exact:true});
  const row=list.getByRole('region',{name:'Starts when something happens',exact:true}).locator('.srow');
  await row.waitFor();
  assert.match(await row.innerText(),new RegExp(`^${CHAT}\\s+When the webhook is called · Sentry\\s+On event\\s*last \\w{3} \\d\\d:\\d\\d$`));
  await page.keyboard.press('Escape');
  await list.waitFor({state:'detached'});

  // Reopened: the URL is masked to its last 4 characters. Rotate URL shows a new one once; the old one stops working.
  await strip.getByRole('button',{name:'Edit',exact:true}).click();
  await edit.waitFor();
  assert.equal(await url.inputValue(),`…/api/hooks/nest_hook_••••${full.slice(-4)}`);
  assert.equal(await edit.locator('.sched-hook-note').count(),0);
  assert.equal(await edit.getByLabel('Name',{exact:true}).inputValue(),'Sentry');
  await edit.getByRole('button',{name:'Rotate URL',exact:true}).click();
  const rotated=await until(()=>url.inputValue(),value=>HOOK_URL.test(value),'the new URL');
  assert.notEqual(rotated,full);
  assert.equal(await edit.locator('.sched-hook-note').innerText(),'Copy it now. It is shown only once.');
  assert.equal((await fetch(full,{method:'POST',body:'{}'})).status,404,'the old URL');
  assert.equal((await fetch(rotated,{method:'POST',body:'{"issue":43}'})).status,202,'the new URL');
  await edit.getByRole('button',{name:'Done',exact:true}).click();
  await edit.waitFor({state:'detached'});

  // Pause from the popover: the call is refused like an unknown URL, and the strip says paused.
  await strip.getByRole('button',{name:'Edit',exact:true}).click();
  await edit.getByRole('button',{name:'Pause',exact:true}).click();
  await edit.waitFor({state:'detached'});
  await until(()=>text(strip),t=>t.startsWith('When the webhook is called · Sentry · Pip · paused'),'the paused strip');
  assert.equal((await fetch(rotated,{method:'POST',body:'{}'})).status,404,'paused');
  assert.ok(!(await srcLines(sheet)).some(line=>line.includes('nest_hook_')),'no URL in the chat');
},{canvas:true,flows:true});

// Task 12: a repeat typed in the bottom box. Synthetic text and agents only.
const TYPED='Every Monday at 09:00';
const dock=(page:Page)=>page.getByRole('region',{name:'Start a chat',exact:true});
async function pickPip(page:Page,box:Locator){
  await box.pressSequentially('@Pi');
  await page.getByRole('listbox',{name:'Mention people and agents'}).getByRole('option').filter({hasText:'Pip'}).click();
}
async function typedBoard(h:ChatHarness){
  const {id}=await call<{id:string}>(h,'POST','/api/canvases',{id:crypto.randomUUID(),name:'Typed schedules'});
  await h.page.goto(`${h.base}/?view=canvas&canvas=${id}`);
  const box=dock(h.page).getByRole('textbox',{name:'Message',exact:true});
  await box.waitFor();
  return box;
}

await runChatTest('canvas schedules: a repeat typed in the bottom box shows a chip, ✕ drops it, and Send saves it for the mentioned agent',async h=>{
  const {page}=h;
  const box=await typedBoard(h);
  const chip=dock(page).locator('.pchip.sch2');
  const status=dock(page).locator('[role="status"].canvas-visually-hidden');
  // A positive control, then `every time` reads as no rule: the chip goes.
  await box.fill('every day');
  await chip.waitFor();
  await box.fill('do it every time');
  await chip.waitFor({state:'detached'});
  assert.equal(await status.innerText(),'','nothing to announce');

  // Pip picked from the mention list, then the rule: the chip comes first, before the message, and is announced.
  await box.fill('');
  await pickPip(page,box);
  await box.pressSequentially('every Monday at 9 post the recap');
  assert.equal(await box.inputValue(),'@Pip every Monday at 9 post the recap');
  await chip.waitFor();
  assert.equal(await chip.locator(':scope > span').innerText(),TYPED);
  assert.equal(await chip.getAttribute('title'),'Will repeat. You can change it in the chat.');
  assert.equal(await status.textContent(),`Will repeat: ${TYPED}`);
  assert.equal(await chip.evaluate(el=>{const row=el.closest('.project-start-dock-row')!;return [...row.querySelectorAll('.pchip, .mention-input')][0]===el;}),true,'first, before the message');
  // ✕ shows keyboard focus (Shift+Tab from the message), then drops the chip and returns focus to the message.
  const x=chip.getByRole('button',{name:'Don\'t repeat',exact:true});
  await box.focus();
  await page.keyboard.press('Shift+Tab');
  assert.equal(await x.evaluate(el=>document.activeElement===el),true,'✕ is next before the message');
  const ring=await x.evaluate(el=>{const s=getComputedStyle(el);return {style:s.outlineStyle,width:s.outlineWidth};});
  assert.ok(ring.style==='solid'&&ring.width!=='0px',`✕ shows its focus: ${JSON.stringify(ring)}`);
  await page.keyboard.press('Enter');
  await chip.waitFor({state:'detached'});
  assert.equal(await box.evaluate(el=>document.activeElement===el),true,'focus back on the message');
  assert.equal(await box.inputValue(),'@Pip every Monday at 9 post the recap','the text stays');

  // Still the same rule: still dropped. Retyped (the text read as no rule in between): the chip is back.
  await box.press('End');
  await box.press('Backspace');
  assert.equal(await chip.count(),0,'editing the rest of the text keeps it dropped');
  await box.fill('');
  await pickPip(page,box);
  await box.pressSequentially('every Monday at 9 post the recap');
  await chip.waitFor();
  assert.equal(await chip.locator(':scope > span').innerText(),TYPED);
  // Send opens the new chat, says so, and saves the weekly schedule for Pip.
  const zone=await page.evaluate(()=>Intl.DateTimeFormat().resolvedOptions().timeZone);
  await dock(page).getByRole('button',{name:'Send',exact:true}).click();
  const sheet=page.locator('.canvas-chat');
  await sheet.waitFor();
  await until(()=>notices(page),list=>list.includes(`Scheduled: ${TYPED}. First run now, then on schedule.`),'the scheduled toast');
  const [saved]=await until(()=>schedules(h),list=>list.length===1,'the schedule');
  assert.deepEqual([saved.agent,saved.prompt,saved.rule,saved.timezone],['Pip','every Monday at 9 post the recap',{kind:'weekly',days:[0],time:'09:00'},zone]);
  const made=await call<Array<{channelId:string;name:string}>>(h,'GET','/api/projects');
  assert.equal(made.find(p=>p.channelId===saved.channelId)?.name,'every Monday at 9 post the recap','in the chat the send made');
  await until(()=>srcLines(sheet),lines=>lines.includes(`Scheduled · ${TYPED} · Pip`),'the note in the new chat');
  assert.equal(await box.inputValue(),'','the box starts over');
  assert.equal(await chip.count(),0,'with no chip');
},{canvas:true,flows:true});

await runChatTest('canvas schedules: a typed repeat with no agent, or one too long to repeat, keeps the chat and says why',async h=>{
  const {page}=h;
  const box=await typedBoard(h);
  const chip=dock(page).locator('.pchip.sch2');
  assert.equal(await dock(page).getByRole('button',{name:'Start without my agent',exact:true}).count(),0,'no assistant agent joins');
  await box.fill('every day check the synthetic build');
  await chip.waitFor();
  await dock(page).getByRole('button',{name:'Send',exact:true}).click();
  await until(()=>notices(page),list=>list.includes('Not scheduled: mention an agent to run it.'),'the no-agent notice');
  await page.locator('.canvas-chat').waitFor();

  // Too long to repeat (over 4000 characters): not scheduled, and the chat and its message stay.
  await box.fill('');
  await pickPip(page,box);
  await box.evaluate((el,tail)=>{const area=el as HTMLTextAreaElement;const set=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value')!.set!;set.call(area,area.value+tail);area.dispatchEvent(new Event('input',{bubbles:true}));},'every day '+'synthetic '.repeat(410));
  await chip.waitFor();
  const before=(await call<Array<{channelId:string}>>(h,'GET','/api/projects')).length;
  await dock(page).getByRole('button',{name:'Send',exact:true}).click();
  await until(()=>notices(page),list=>list.includes('Not scheduled: the message is too long to repeat.'),'the too-long notice, not the API\'s validation text');
  assert.equal((await call<unknown[]>(h,'GET','/api/projects')).length,before+1,'the chat was made all the same');
  assert.equal((await schedules(h)).length,0,'nothing scheduled');
},{canvas:true,flows:true});

await runChatTest('canvas schedules: with flows not set up, a rule typed in the bottom box is just text',async h=>{
  const {page}=h;
  const {enabled}=await call<{enabled:boolean}>(h,'GET','/api/flows/availability');
  assert.equal(enabled,false,'flows are off here');
  const box=await typedBoard(h);
  await box.fill('every Monday at 9 post the recap');
  await dock(page).getByRole('button',{name:'Send',exact:true}).waitFor();
  assert.equal(await dock(page).locator('.pchip, [role="status"].canvas-visually-hidden').count(),0,'no chip and no announcement');
},{canvas:true});
