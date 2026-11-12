// App activity on cards (Phase 2 Task 9): logos from the chat's tool.* events on the real engine, API and WS. Synthetic data.
import assert from 'node:assert/strict';
import type {Page} from 'playwright';
import {agentName,runChatTest,type ChatHarness} from '../support/chat-harness';

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

  // Pip is mid-turn (running and heartbeating), so its row shows the app it is using.
  const now=Date.now();
  h.engineDb.prepare("UPDATE agents SET desired_state='RUNNING', runtime_state='RUNNING', last_heartbeat_at=?, updated_at=? WHERE name=?").run(now,now,agentName);
  const trigger=await h.emit('message.created',{text:'Synthetic trigger'},{source:'human:demo-owner'});
  await h.emit('agent.turn.started',{triggerEventId:trigger.id},{source:`agent:${agentName}`,channelId:h.project.channelId});
  const pipRow=card.locator('.canvas-card-row[data-kind="agent"]');
  await pipRow.locator('.canvas-card-what').getByText('working',{exact:true}).waitFor();

  // A call in flight: the Gmail logo with a live ring, and Pip's row names the app and action only.
  const sendStarted=await h.emit('tool.started',{tool:'shell_run',args:{command:connection('GMAIL_SEND_EMAIL')}});
  const gmail=card.locator('.canvas-card-app').first();
  await gmail.waitFor();
  assert.match(await gmail.getAttribute('class')??'',/is-live/);
  assert.equal(await gmail.locator('img[src$="/gmail.svg"]').count(),1,'the Gmail logo');
  const live=await gmail.evaluate(el=>{const s=getComputedStyle(el,'::after');return {content:s.content,animation:s.animationName};});
  assert.notEqual(live.content,'none','the ring is drawn');
  assert.equal(live.animation,'canvas-app-ring','the ring animates with motion allowed');
  await pipRow.locator('.canvas-card-what').getByText('Gmail · Send email',{exact:true}).waitFor();
  assert.equal(await pipRow.locator('.canvas-card-row-app img[src$="/gmail.svg"]').count(),1,'the row shows the app in use');
  assert.equal(await pipRow.getAttribute('data-state'),'working');
  await card.locator('.canvas-card-apps-name').getByText('Gmail',{exact:true}).waitFor();

  // Done: no ring, and the title counts the change.
  await h.emit('tool.executed',{tool:'shell_run',args:{command:connection('GMAIL_SEND_EMAIL')},output:'Dear Alice, SYNTHETIC-SECRET-BODY'},{parentEventId:sendStarted.id});
  await page.waitForFunction(id=>{const el=document.querySelector(`.canvas-card[data-channel-id="${id}"] .canvas-card-app`);return !!el&&!el.classList.contains('is-live');},h.project.channelId);
  assert.equal(await gmail.getAttribute('title'),'Gmail: 0 reads · 1 change');
  assert.equal(await gmail.getAttribute('aria-label'),'Gmail: 0 reads · 1 change');
  // The call is done: the row is back to the turn's own activity, with no app.
  await pipRow.locator('.canvas-card-what').getByText('working',{exact:true}).waitFor();
  assert.equal(await pipRow.locator('.canvas-card-row-app').count(),0);

  // A read, a gh read and a non-app command: the count and a second logo; the shell command adds nothing.
  await h.emit('tool.started',{tool:'shell_run',args:{command:connection('GMAIL_FETCH_EMAILS')}});
  await h.emit('tool.executed',{tool:'shell_run',args:{command:connection('GMAIL_FETCH_EMAILS')},output:'x'});
  await h.emit('tool.started',{tool:'shell_run',args:{command:'gh pr view 5 -R acme/web'}});
  await h.emit('tool.executed',{tool:'shell_run',args:{command:'gh pr view 5 -R acme/web'},output:'y'});
  await h.emit('tool.started',{tool:'shell_run',args:{command:'ls -la'}});
  await h.emit('tool.executed',{tool:'shell_run',args:{command:'ls -la'},output:'z'});
  await card.locator('.canvas-card-app[title="GitHub: 1 read · 0 changes"]').waitFor();
  assert.equal(await gmail.getAttribute('title'),'Gmail: 1 read · 1 change');
  assert.equal(await card.locator('.canvas-card-app').count(),2);
  await card.locator('.canvas-card-app.is-live').waitFor({state:'detached'});
  await card.locator('.canvas-card-apps-name').getByText('2 apps',{exact:true}).waitFor();

  // Five apps: four logos, then `5 apps` (the mock's c-apps); its title names every app.
  for(const slug of ['SLACK_LIST_CHANNELS','TRELLO_LIST_BOARDS','MIRO_GET_BOARD'])await h.emit('tool.executed',{tool:'shell_run',args:{command:connection(slug)}});
  await card.locator('.canvas-card-apps-name').getByText('5 apps',{exact:true}).waitFor();
  assert.equal(await card.locator('.canvas-card-app').count(),4);
  assert.match(await card.locator('.canvas-card-apps-name').getAttribute('title')??'',/^Apps used in this chat: .*Miro/);
  // The generic mark stands in for an app with no logo, and it still has its name.
  await h.emit('tool.executed',{tool:'shell_run',args:{command:connection('NOTION_UPDATE_PAGE')}});
  await card.locator('.canvas-card-apps-name').getByText('6 apps',{exact:true}).waitFor();

  // Privacy: no command text or output reaches the page.
  const text=await page.evaluate(()=>document.body.innerHTML);
  for(const leak of ['SYNTHETIC-SECRET-BODY','connections.mjs','args.json','acme/web'])assert.ok(!text.includes(leak),`${leak} is not in the page`);

  // A reload seeds the same counts from the chat's events.
  await openCanvas(page,base,canvas);
  await page.locator(`.canvas-card[data-channel-id="${h.project.channelId}"] .canvas-card-app[title="Gmail: 1 read · 1 change"]`).waitFor();

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
  await bar.getByText('1 read · 2 changes outside Nest',{exact:true}).waitFor();
  assert.equal(await bar.getByText('Apps here',{exact:true}).count(),1);
  await bar.locator('[title="Gmail: 1 read · 1 change"]').waitFor();
  await bar.locator('[title="GitHub: 0 reads · 1 change"]').waitFor();
  assert.equal(await bar.locator('img[src$="/gmail.svg"]').count(),1,'the Gmail logo');
  assert.equal(await bar.getByText('Codex and Claude Code agents',{exact:false}).count(),0,'no limitation line without a wrapped agent');

  // A call still running counts, with a live chip.
  await h.emit('tool.started',{tool:'shell_run',args:{command:'node scripts/connections.mjs execute c1 SLACK_SEND_MESSAGE < a.json'}});
  await bar.getByText('1 read · 3 changes outside Nest',{exact:true}).waitFor();
  assert.equal(await bar.locator('.apps-here-chip.is-live').count(),1);

  // Each app call is a slim line (the mock's .act): agent, a lowercase clause and app, `changed` on writes, time.
  const lines=page.locator('.app-line');
  assert.equal(await lines.count(),4,'one line per app call, none as an icon chip');
  assert.equal(await page.locator('.trace-chip[aria-label*="Gmail"]').count(),0,'app calls are not chips');
  const text=async(line:ReturnType<typeof lines.filter>)=>(await line.locator('.app-line-text').innerText()).replace(/\s+/g,' ');
  const sendLine=lines.filter({hasText:'sent an email · Gmail'});
  assert.equal(await text(sendLine),'Pip sent an email · Gmail');
  assert.equal(await sendLine.locator('.app-line-changed').innerText(),'changed');
  assert.equal(await sendLine.locator('img[src$="/gmail.svg"]').count(),1,'the app icon');
  const sendTime=(await sendLine.locator('.app-line-time').innerText()).trim();
  assert.ok(sendTime.length>0,'the time');
  const sendButton=sendLine.getByRole('button');
  assert.equal(await sendButton.getAttribute('aria-expanded'),'false');
  const readLine=lines.filter({hasText:'fetched emails · Gmail'});
  assert.equal(await text(readLine),'Pip fetched emails · Gmail');
  assert.equal(await readLine.locator('.app-line-changed').count(),0,'a read has no changed tag');
  assert.equal(await readLine.locator('.app-line-failed, .app-line-live').count(),0);
  assert.equal(await text(lines.filter({hasText:'GitHub'})),'Pip merged a PR in acme/web · GitHub');
  const runningLine=lines.filter({hasText:'Slack'});
  assert.equal(await text(runningLine),'Pip sending a message · Slack');
  assert.equal(await runningLine.locator('.app-line-live').innerText(),'running');
  assert.equal(await runningLine.locator('.app-line-dot').count(),1,'a live dot');
  // Expanding shows plain words, with the line's own time format.
  assert.equal(await sendLine.locator('.app-line-details').count(),0);
  await sendButton.click();
  assert.equal(await sendButton.getAttribute('aria-expanded'),'true');
  const shown=await sendLine.locator('.app-line-details').innerText();
  assert.equal(shown,`Gmail · sent an email\nchanged something outside Nest · done at ${sendTime}`);
  const html=await page.evaluate(()=>document.body.innerHTML);
  for(const leak of ['a.json','connections.mjs','SYNTHETIC-SECRET-BODY'])assert.ok(!html.includes(leak),`${leak} is not in the page`);
  for(const leak of ['a.json','connections.mjs','shell_run','SYNTHETIC-SECRET-BODY'])assert.ok(!shown.includes(leak),`${leak} is not in the details`);
  await sendButton.click();
  assert.equal(await sendLine.locator('.app-line-details').count(),0,'a second click collapses it');

  // The same call also runs as a process (R22). In production every shell_run is tool.started, process.started,
  // process.output, process.exited, tool.executed: the line stands for all of it, so no chip is drawn for the
  // call's process, and its output never reaches the page. A plain shell process keeps its chips and details.
  const appCommand='node scripts/connections.mjs execute c1 GMAIL_SEND_EMAIL < proc-args.json';
  const proc=(type:string,payload:Record<string,unknown>)=>h.emit(type,{...payload,ownerAgentName:'Pip',targetAgentName:'Pip'},{source:'system:process-runner'});
  await h.emit('tool.started',{tool:'shell_run',args:{command:appCommand}});
  await proc('process.started',{processId:'app-proc',cmd:appCommand,executionMode:'SYNC'});
  await proc('process.output',{processId:'app-proc',seq:1,stream:'STDOUT',text:'SYNTHETIC-PROCESS-OUTPUT'});
  await proc('process.exited',{processId:'app-proc',exitCode:0,signal:null,timedOut:false});
  await h.emit('tool.executed',{tool:'shell_run',args:{command:appCommand},output:'SYNTHETIC-PROCESS-OUTPUT'});
  await proc('process.started',{processId:'plain-proc',cmd:'ls -la plain-dir',executionMode:'SYNC'});
  await proc('process.output',{processId:'plain-proc',seq:1,stream:'STDOUT',text:'PLAIN-LISTING'});
  // Output whose start is not loaded may belong to an app call: still a chip, still redacted.
  await proc('process.output',{processId:'orphan-proc',seq:1,stream:'STDOUT',text:'SYNTHETIC-ORPHAN-OUTPUT'});
  const chips=(name:string)=>page.getByRole('button',{name,exact:true});
  await chips('Agent output').nth(1).waitFor();
  await lines.nth(4).waitFor();
  assert.equal(await lines.count(),5,'the new call is one more line');
  assert.equal(await chips('Agent output').count(),2,'only the plain and the orphan output are chips');
  assert.equal(await chips('Agent process started').count(),1,'only the plain start is a chip');
  assert.equal(await chips('Agent process finished').count(),0,'the call\'s exit has no chip');
  const pageHtml=()=>page.evaluate(()=>document.body.innerHTML);
  const opened=async(name:string,index:number)=>{
   await chips(name).nth(index).click();
   const card=page.locator('.trace-detail-card');
   await card.locator('summary').click();
   return card.locator('pre').innerText();
  };
  assert.match(await opened('Agent output',0),/PLAIN-LISTING/,'a plain process still shows its output');
  assert.match(await opened('Agent process started',0),/ls -la plain-dir/,'and its command');
  const orphan=await opened('Agent output',1);
  assert.match(orphan,/Load earlier messages/,'an output without its start stays redacted');
  const html2=await pageHtml();
  for(const leak of ['proc-args.json','connections.mjs','SYNTHETIC-PROCESS-OUTPUT','SYNTHETIC-ORPHAN-OUTPUT'])assert.ok(!html2.includes(leak),`${leak} is not in the page`);

  // The composer has the mic with the flag on.
  assert.equal(await page.getByRole('button',{name:'Record a voice note',exact:true}).count(),1);
  // Flows are not set up (no service token), so no message offers Fork from here.
  assert.equal(await page.locator('.fork-btn, .forked').count(),0,'no forks without flows');

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

await runChatTest('canvas flag off: no voice notes, no Apps here bar, no file tiles, and the timeline as before Phase 2 (R20)',async h=>{
  const {page,base}=h;
  const send='node scripts/connections.mjs execute c1 GMAIL_SEND_EMAIL < a.json';
  await h.emit('tool.executed',{tool:'shell_run',args:{command:'node scripts/connections.mjs execute c1 GMAIL_FETCH_EMAILS < a.json'}});
  await h.emit('tool.executed',{tool:'shell_run',args:{command:send}});
  await h.emit('process.started',{processId:'off-proc',cmd:send,executionMode:'SYNC',ownerAgentName:'Pip',targetAgentName:'Pip'},{source:'system:process-runner'});
  await h.emit('process.output',{processId:'off-proc',seq:1,stream:'STDOUT',text:'OFF-OUTPUT',ownerAgentName:'Pip',targetAgentName:'Pip'},{source:'system:process-runner'});
  // A wrapped agent would show the limitation line with the flag on.
  await h.post('/api/agents',{name:'Wren',icon:'pip',visibility:'PUBLIC',modelId:'wrapped:none',workspacePath:`/tmp/wren-${Date.now()}`,mode:'WRAPPED',assignedRunnerId:'fixture-runner',desiredState:'STOPPED'});
  await h.post(`/api/channels/${h.project.channelId}/subscribe`,{subscriberType:'AGENT',subscriberId:'Wren'});
  const xlsx='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  const report=await h.emit('message.created',{text:'Synthetic flag-off report',attachments:[{fileId:'synthetic-off-file',name:'Q3 model.xlsx',mime:xlsx,size:5*1024}]},{source:'agent:Pip'});
  // A scheduled run that is already due: with the flag on it reads as a `↳ Scheduled run …` line (Phase 3).
  await h.emit('agent.scheduled.trigger',{text:'Scheduled run · Every day at 09:00 · set up by demo-owner\n\nSynthetic flag-off prompt',targetAgentName:'Pip',
    nestSwitchyard:{kind:'schedule',scheduleId:'synthetic-off-schedule'}},{source:'agent:Switchyard'});
  const scheduledQueries:string[]=[];
  page.on('request',request=>{if(request.url().includes('agent.scheduled.trigger'))scheduledQueries.push(request.url());});
  await page.reload();
  const chips=(name:string)=>page.getByRole('button',{name,exact:true});
  await chips('shell_run completed').nth(1).waitFor();
  await chips('Agent output').waitFor();
  // No scheduled-run query and no `↳` line: the chat reads as before Phase 3.
  assert.deepEqual(scheduledQueries,[],'no scheduled-run query');
  assert.equal(await page.locator('.message-src').count(),0,'no scheduled-run line');
  assert.equal(await page.getByText('Scheduled run · Every day',{exact:false}).count(),0,'no scheduled-run text');

  // Files keep the Attachments list, with its type and size line, and never become tiles.
  const message=page.locator(`#message-${report.id}`);
  await message.locator('.message-attachments').getByText('Attachments',{exact:true}).waitFor();
  assert.equal(await message.getByRole('link',{name:'Q3 model.xlsx',exact:true}).count(),1);
  await message.getByText(`${xlsx} • 5.0 KB`,{exact:true}).waitFor();
  assert.equal(await page.locator('.message-files, .canvas-file-tile').count(),0,'no file tiles');

  // No Apps here bar, no wrapped-agent line, no app-call titles and no mic.
  assert.equal(await page.getByRole('region',{name:'Apps here',exact:true}).count(),0,'no Apps here bar');
  assert.equal(await page.getByText('Codex and Claude Code agents',{exact:false}).count(),0,'no wrapped-agent line');
  assert.equal(await page.getByRole('button',{name:/· Gmail ·/}).count(),0,'no app-call titles');
  assert.equal(await page.locator('.app-line').count(),0,'no app lines');
  assert.equal(await page.getByRole('button',{name:'Record a voice note',exact:true}).count(),0,'no mic in the composer');
  // No forks (Phase 3): no Fork from here on the agent's message and no fork chips.
  await message.waitFor();
  assert.equal(await page.getByRole('button',{name:'Fork from here',exact:true}).count(),0,'no Fork from here');
  assert.equal(await page.locator('.fork-btn, .forked').count(),0,'no fork chips');

  // Details show the recorded payload exactly as before Phase 2.
  await chips('shell_run completed').nth(1).click();
  const card=page.locator('.trace-detail-card');
  await card.locator('summary').click();
  assert.match(await card.locator('pre').innerText(),/GMAIL_SEND_EMAIL < a\.json/);
  await chips('Agent output').click();
  await card.locator('summary').click();
  assert.match(await card.locator('pre').innerText(),/OFF-OUTPUT/);

  // The Projects page's new-project composer has no mic either.
  await page.goto(`${base}/?view=projects&create=project`);
  await page.getByRole('textbox',{name:'Message',exact:true}).waitFor();
  assert.equal(await page.getByRole('button',{name:'Record a voice note',exact:true}).count(),0,'no mic when starting a project');
  // No typed-repeat chip (Phase 3): a rule in the message is just text.
  await page.getByRole('textbox',{name:'Message',exact:true}).fill('every Monday at 9 post the recap');
  await page.getByRole('button',{name:'Send',exact:true}).waitFor();
  assert.equal(await page.locator('.pchip, .project-start-dock-chips').count(),0,'no schedule chip');
  assert.equal(await page.getByRole('button',{name:'Don\'t repeat',exact:true}).count(),0,'no Don\'t repeat');
  assert.equal(await page.getByText('Every Monday at 09:00',{exact:false}).count(),0,'no rule text');
});
