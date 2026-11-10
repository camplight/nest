// App activity on cards (Phase 2 Task 9): logos from the chat's tool.* events on the real engine, API and WS. Synthetic data.
import assert from 'node:assert/strict';
import type {Page} from 'playwright';
import {runChatTest,type ChatHarness} from '../support/chat-harness';

async function call<T>(h:ChatHarness,method:string,path:string,body?:unknown):Promise<T>{
  const response=await fetch(h.apiUrl+path,{method,headers:{cookie:h.cookie,'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
  if(!response.ok)throw Error(`${method} ${path}: ${response.status} ${await response.text()}`);
  return response.status===204?undefined as T:await response.json() as T;
}
async function openCanvas(page:Page,base:string,id:string){
  await page.goto(`${base}/?view=canvas&canvas=${id}`);
  await page.locator('.canvas-surface .canvas-world').waitFor({state:'attached'});
}
const connection=(slug:string)=>`node scripts/connections.mjs execute c1 ${slug} < args.json`;

await runChatTest('canvas apps: logos, live ring, read/change counts, no command or output in the page',async h=>{
  const {page,base}=h;
  const canvas=(await call<{id:string}>(h,'POST','/api/canvases',{id:crypto.randomUUID(),name:'Apps'})).id;
  await call(h,'POST',`/api/canvases/${canvas}/cards`,{cards:[{channelId:h.project.channelId,x:40,y:100}]});
  await openCanvas(page,base,canvas);
  const card=page.locator(`.canvas-card[data-channel-id="${h.project.channelId}"]`);
  await card.waitFor();
  assert.equal(await card.locator('.canvas-card-apps').count(),0,'no apps row before any app call');

  // A call in flight: the Gmail logo with a live ring.
  const sendStarted=await h.emit('tool.started',{tool:'shell_run',args:{command:connection('GMAIL_SEND_EMAIL')}});
  const gmail=card.locator('.canvas-card-app').first();
  await gmail.waitFor();
  assert.match(await gmail.getAttribute('class')??'',/is-live/);
  assert.equal(await gmail.locator('img[src$="/gmail.svg"]').count(),1,'the Gmail logo');
  const live=await gmail.evaluate(el=>{const s=getComputedStyle(el,'::after');return {content:s.content,animation:s.animationName};});
  assert.notEqual(live.content,'none','the ring is drawn');
  assert.equal(live.animation,'canvas-app-ring','the ring animates with motion allowed');

  // Done: no ring, and the title counts the change.
  await h.emit('tool.executed',{tool:'shell_run',args:{command:connection('GMAIL_SEND_EMAIL')},output:'Dear Alice, SYNTHETIC-SECRET-BODY'},{parentEventId:sendStarted.id});
  await page.waitForFunction(id=>{const el=document.querySelector(`.canvas-card[data-channel-id="${id}"] .canvas-card-app`);return !!el&&!el.classList.contains('is-live');},h.project.channelId);
  assert.equal(await gmail.getAttribute('title'),'Gmail: 0 reads · 1 changes');
  assert.equal(await gmail.getAttribute('aria-label'),'Gmail: 0 reads · 1 changes');

  // A read, a gh read and a non-app command: the count and a second logo; the shell command adds nothing.
  await h.emit('tool.started',{tool:'shell_run',args:{command:connection('GMAIL_FETCH_EMAILS')}});
  await h.emit('tool.executed',{tool:'shell_run',args:{command:connection('GMAIL_FETCH_EMAILS')},output:'x'});
  await h.emit('tool.started',{tool:'shell_run',args:{command:'gh pr view 5 -R acme/web'}});
  await h.emit('tool.executed',{tool:'shell_run',args:{command:'gh pr view 5 -R acme/web'},output:'y'});
  await h.emit('tool.started',{tool:'shell_run',args:{command:'ls -la'}});
  await h.emit('tool.executed',{tool:'shell_run',args:{command:'ls -la'},output:'z'});
  await card.locator('.canvas-card-app[title="GitHub: 1 reads · 0 changes"]').waitFor();
  assert.equal(await gmail.getAttribute('title'),'Gmail: 1 reads · 1 changes');
  assert.equal(await card.locator('.canvas-card-app').count(),2);
  assert.equal(await card.locator('.canvas-card-app.is-live').count(),0);

  // Five apps: four logos, then +1.
  for(const slug of ['SLACK_LIST_CHANNELS','TRELLO_LIST_BOARDS','MIRO_GET_BOARD'])await h.emit('tool.executed',{tool:'shell_run',args:{command:connection(slug)}});
  await card.locator('.canvas-card-apps-more').getByText('+1',{exact:true}).waitFor();
  assert.equal(await card.locator('.canvas-card-app').count(),4);
  // The generic mark stands in for an app with no logo, and it still has its name.
  await h.emit('tool.executed',{tool:'shell_run',args:{command:connection('NOTION_UPDATE_PAGE')}});
  await card.locator('.canvas-card-apps-more').getByText('+2',{exact:true}).waitFor();

  // Privacy: no command text or output reaches the page.
  const text=await page.evaluate(()=>document.body.innerHTML);
  for(const leak of ['SYNTHETIC-SECRET-BODY','connections.mjs','args.json','acme/web'])assert.ok(!text.includes(leak),`${leak} is not in the page`);

  // A reload seeds the same counts from the chat's events.
  await openCanvas(page,base,canvas);
  await page.locator(`.canvas-card[data-channel-id="${h.project.channelId}"] .canvas-card-app[title="Gmail: 1 reads · 1 changes"]`).waitFor();

  // Compact (zoomed out) cards drop the logos like the other card detail.
  for(let i=0;i<4;i++)await page.getByRole('button',{name:'Zoom out',exact:true}).click();
  await page.getByLabel('Zoom level',{exact:true}).getByText('41%',{exact:true}).waitFor();
  await card.locator('.canvas-card-apps').waitFor({state:'hidden'});
  for(let i=0;i<4;i++)await page.getByRole('button',{name:'Zoom in',exact:true}).click();
  await card.locator('.canvas-card-apps').waitFor();

  // Reduced motion: the ring is still drawn but does not animate.
  await h.emit('tool.started',{tool:'shell_run',args:{command:connection('SLACK_SEND_MESSAGE')}});
  await card.locator('.canvas-card-app.is-live').waitFor();
  await page.emulateMedia({reducedMotion:'reduce'});
  const still=await card.locator('.canvas-card-app.is-live').evaluate(el=>getComputedStyle(el,'::after').animationName);
  assert.equal(still,'none','no animation under prefers-reduced-motion');
},{canvas:true});

await runChatTest('chat apps bar: counts, honest timeline lines without the command, wrapped-agent limit',async h=>{
  const {page}=h;
  const bar=page.getByRole('region',{name:'Apps here',exact:true});
  assert.equal(await bar.count(),0,'no bar before any app call or wrapped agent');

  await h.emit('tool.executed',{tool:'shell_run',args:{command:'node scripts/connections.mjs execute c1 GMAIL_SEND_EMAIL < a.json'},output:'SYNTHETIC-SECRET-BODY'});
  await h.emit('tool.executed',{tool:'shell_run',args:{command:'node scripts/connections.mjs execute c1 GMAIL_FETCH_EMAILS < a.json'},output:'x'});
  await h.emit('tool.executed',{tool:'shell_run',args:{command:'gh pr merge 5 -R acme/web'},output:'y'});
  await bar.waitFor();
  await bar.getByText('1 reads · 2 changes outside Nest',{exact:true}).waitFor();
  assert.equal(await bar.getByText('Apps here',{exact:true}).count(),1);
  await bar.locator('[title="Gmail: 1 reads · 1 changes"]').waitFor();
  await bar.locator('[title="GitHub: 0 reads · 1 changes"]').waitFor();
  assert.equal(await bar.locator('img[src$="/gmail.svg"]').count(),1,'the Gmail logo');
  assert.equal(await bar.getByText('Codex and Claude Code agents',{exact:false}).count(),0,'no limitation line without a wrapped agent');

  // A call still running counts, with a live chip.
  await h.emit('tool.started',{tool:'shell_run',args:{command:'node scripts/connections.mjs execute c1 SLACK_SEND_MESSAGE < a.json'}});
  await bar.getByText('1 reads · 3 changes outside Nest',{exact:true}).waitFor();
  assert.equal(await bar.locator('.apps-here-chip.is-live').count(),1);

  // The timeline line is honest, and its details never show the command or output.
  const line=page.getByRole('button',{name:'Pip · Gmail · Send email · changed',exact:true});
  await line.first().click();
  const detail=page.locator('.trace-detail-card');
  await detail.getByText('Pip · Gmail · Send email · changed',{exact:true}).waitFor();
  await detail.locator('summary').click();
  const shown=await detail.innerText();
  assert.match(shown,/Send email/);
  assert.match(shown,/"kind": "change"/);
  const html=await page.evaluate(()=>document.body.innerHTML);
  for(const leak of ['a.json','connections.mjs','SYNTHETIC-SECRET-BODY','acme/web'])assert.ok(!html.includes(leak),`${leak} is not in the page`);
  assert.ok(!shown.includes('a.json'));

  // A wrapped agent in the chat shows the limitation.
  await h.post('/api/agents',{name:'Wren',icon:'pip',visibility:'PUBLIC',modelId:'wrapped:none',workspacePath:`/tmp/wren-${Date.now()}`,mode:'WRAPPED',assignedRunnerId:'fixture-runner',desiredState:'STOPPED'});
  await h.post(`/api/channels/${h.project.channelId}/subscribe`,{subscriberType:'AGENT',subscriberId:'Wren'});
  await page.reload();
  await bar.getByText("Codex and Claude Code agents only report their messages, so their app use isn't shown here.",{exact:true}).waitFor();
},{canvas:true});

await runChatTest('chat apps bar: a phone keeps the composer on screen',async h=>{
  const {page}=h;
  for(const slug of ['GMAIL_SEND_EMAIL','SLACK_SEND_MESSAGE','TRELLO_CREATE_CARD','MIRO_GET_BOARD','NOTION_UPDATE_PAGE'])await h.emit('tool.executed',{tool:'shell_run',args:{command:`node scripts/connections.mjs execute c1 ${slug} < a.json`}});
  const bar=page.getByRole('region',{name:'Apps here',exact:true});
  await bar.waitFor();
  const box=await page.getByRole('textbox',{name:'Message',exact:true}).boundingBox();
  const viewport=page.viewportSize()!;
  assert.ok(box&&box.y+box.height<=viewport.height,'the composer is inside the viewport');
  const width=await bar.evaluate(el=>({scroll:el.scrollWidth,client:el.clientWidth}));
  assert.ok(width.scroll<=width.client,'the bar does not scroll sideways');
},{canvas:true,viewport:{width:375,height:700},hasTouch:true});

await runChatTest('chat apps bar: the regular chat view, without the canvas flag',async h=>{
  const {page}=h;
  const bar=page.getByRole('region',{name:'Apps here',exact:true});
  assert.equal(await bar.count(),0,'no bar before any app call');
  await h.emit('tool.executed',{tool:'shell_run',args:{command:'node scripts/connections.mjs execute c1 GMAIL_FETCH_EMAILS < a.json'}});
  await h.emit('tool.executed',{tool:'shell_run',args:{command:'node scripts/connections.mjs execute c1 GMAIL_SEND_EMAIL < a.json'}});
  await bar.getByText('1 reads · 1 changes outside Nest',{exact:true}).waitFor();
  await bar.locator('[title="Gmail: 1 reads · 1 changes"]').waitFor();
  assert.equal(await bar.getByText('Codex and Claude Code agents',{exact:false}).count(),0);
  // A reload seeds the bar from the chat's history.
  await page.reload();
  await bar.getByText('1 reads · 1 changes outside Nest',{exact:true}).waitFor();
  assert.ok(!(await page.evaluate(()=>document.body.innerHTML)).includes('a.json'));
});
