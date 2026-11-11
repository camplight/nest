// Card rows, Needs you pill and area summaries (design alignment, batch B) on the real engine, API and WS. Synthetic data.
import assert from 'node:assert/strict';
import {dirname,join} from 'node:path';
import Database from 'better-sqlite3';
import type {Page} from 'playwright';
import {agentName,runChatTest,type ChatHarness} from '../support/chat-harness';

async function call<T>(h:ChatHarness,method:string,path:string,body?:unknown):Promise<T>{
  const response=await fetch(h.apiUrl+path,{method,headers:{cookie:h.cookie,'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
  if(!response.ok)throw Error(`${method} ${path}: ${response.status} ${await response.text()}`);
  return response.status===204?undefined as T:await response.json() as T;
}
const newProject=(h:ChatHarness,name:string)=>call<{id:string;channelId:string}>(h,'POST','/api/projects',
  {id:crypto.randomUUID(),name,description:'Synthetic test project',members:[{subscriberType:'AGENT',subscriberId:agentName}]});
const newArea=async(h:ChatHarness,canvasId:string,area:{title:string;x:number;y:number;w:number;h:number})=>{
  const id=crypto.randomUUID();
  await call(h,'POST',`/api/canvases/${canvasId}/areas`,{id,...area});
  return id;
};
const cardAt=(page:Page,channelId:string)=>page.locator(`.canvas-card[data-channel-id="${channelId}"]`);
const agentRow=(page:Page,channelId:string)=>cardAt(page,channelId).locator('.canvas-card-row[data-kind="agent"]');
/** Pip running and heartbeating now, so a turn begun earlier is still live. */
function pipRunning(h:ChatHarness){
  const at=Date.now();
  h.engineDb.prepare("UPDATE agents SET desired_state='RUNNING', runtime_state='RUNNING', last_heartbeat_at=?, updated_at=? WHERE name=?").run(at,at,agentName);
}
async function startTurn(h:ChatHarness,channelId:string,ageMs=0){
  const trigger=await h.emit('message.created',{text:'Synthetic trigger'},{source:'human:demo-owner',channelId});
  const turn=await h.emit('agent.turn.started',{triggerEventId:trigger.id},{source:`agent:${agentName}`,channelId});
  if(ageMs)h.engineDb.prepare('UPDATE events SET created_at=? WHERE id IN (?,?)').run(Date.now()-ageMs,trigger.id,turn.id);
  pipRunning(h);
  return trigger.id;
}
/** A task by Pip in the project awaiting review: created through the product API, then marked submitted in the product database. */
async function reviewTask(h:ChatHarness,projectId:string,title:string){
  const task=await call<{id:string}>(h,'POST',`/api/projects/${projectId}/tasks`,{id:crypto.randomUUID(),title,instructions:'Synthetic instructions',acceptanceCriteria:'Synthetic criteria',agentName});
  const product=new Database(join(dirname(h.engineDb.name),'product.sqlite'));
  try{
    const row=product.prepare('SELECT data_json FROM product_tasks WHERE id=?').get(task.id) as {data_json:string};
    product.prepare('UPDATE product_tasks SET data_json=? WHERE id=?').run(JSON.stringify({...JSON.parse(row.data_json),status:'needs_review',updatedAt:Date.now()}),task.id);
  }finally{product.close();}
}
/** Zooms with the buttons until the zoom level (in percent) satisfies `done`; the first view may be fitted, so it starts anywhere. */
async function zoomUntil(page:Page,button:'Zoom out'|'Zoom in',done:(percent:number)=>boolean){
  const level=page.getByLabel('Zoom level',{exact:true});
  for(let i=0;i<12;i++){
    const before=await level.innerText();
    if(done(parseInt(before,10)))return;
    await page.getByRole('button',{name:button,exact:true}).click();
    await page.waitForFunction(text=>document.querySelector('[aria-label="Zoom level"]')?.textContent!==text,before);
  }
  throw Error(`zoom never reached the target (${await level.innerText()})`);
}

await runChatTest('canvas rows: each participant shows live activity and the app in use, a review waits on you, and the pill opens the chat',async h=>{
  const {page,base}=h;
  const {id:canvas}=await call<{id:string}>(h,'POST','/api/canvases',{id:crypto.randomUUID(),name:'Rows'});
  await call(h,'POST',`/api/canvases/${canvas}/cards`,{cards:[{channelId:h.project.channelId,x:120,y:120}]});
  const trigger=await startTurn(h,h.project.channelId);
  await page.goto(`${base}/?view=canvas&canvas=${canvas}`);
  const card=cardAt(page,h.project.channelId),pip=agentRow(page,h.project.channelId);
  await card.waitFor();

  // Pip's row: face, name, what it is doing and a working dot; the owner's row reads You with what they posted.
  await pip.locator('.canvas-card-what').getByText('working',{exact:true}).waitFor();
  assert.equal(await pip.getAttribute('data-state'),'working');
  assert.equal(await pip.locator('.canvas-card-who').innerText(),agentName);
  assert.equal(await pip.locator('.canvas-card-dot').count(),1);
  const you=card.locator('.canvas-card-row[data-kind="human"]').filter({has:page.locator('.canvas-card-who',{hasText:/^You$/})});
  await you.locator('.canvas-card-what').getByText('Synthetic trigger',{exact:true}).waitFor();

  // A progress line from the turn becomes the row's activity (first line, no Markdown marks).
  await h.emit('agent.turn.phase',{triggerEventId:trigger,phase:'codex-progress',text:'**Drafting** the launch post\nfrom the brief'},{source:`agent:${agentName}`});
  await pip.locator('.canvas-card-what').getByText('Drafting the launch post',{exact:true}).waitFor();

  // A running app call shows the app's logo and action on the row, never the command; when it ends the row returns.
  const command='node scripts/connections.mjs execute c1 GMAIL_FETCH_EMAILS < private-args.json';
  const started=await h.emit('tool.started',{tool:'shell_run',args:{command}});
  await pip.locator('.canvas-card-what').getByText('Gmail · Fetch emails',{exact:true}).waitFor();
  assert.equal(await pip.locator('.canvas-card-row-app img[src$="/gmail.svg"]').count(),1);
  const html=await page.evaluate(()=>document.body.innerHTML);
  for(const leak of ['connections.mjs','private-args.json'])assert.ok(!html.includes(leak),`${leak} is not in the page`);
  await h.emit('tool.executed',{tool:'shell_run',args:{command},output:'SYNTHETIC-OUTPUT'},{parentEventId:started.id});
  await pip.locator('.canvas-card-what').getByText('Drafting the launch post',{exact:true}).waitFor();
  assert.equal(await pip.locator('.canvas-card-row-app').count(),0);
  await card.locator('.canvas-card-calm').getByText('Moving',{exact:true}).waitFor();
  assert.equal(await card.evaluate(el=>el.classList.contains('needs-you')),false,'no coral border while nothing needs you');

  // The turn ends; a task of Pip's awaits the owner's review. Pip now waits on you, the card turns coral and the
  // footer shows the reason. A message that only mentions review does not count: the rule reads Needs you items only.
  await h.emit('message.created',{text:'Could you review this?'},{source:`agent:${agentName}`});
  await h.emit('agent.turn.completed',{triggerEventId:trigger},{source:`agent:${agentName}`});
  await pip.locator('.canvas-card-what').getByText('Could you review this?',{exact:true}).waitFor();
  assert.equal(await pip.getAttribute('data-state'),'done','a message asking for review is not a wait');
  await card.locator('.canvas-card-calm').getByText('All quiet',{exact:true}).waitFor();
  await reviewTask(h,h.project.id,'Synthetic launch post');
  await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
  await pip.locator('.canvas-card-what').getByText('needs your review · Synthetic launch post',{exact:true}).waitFor();
  assert.equal(await pip.getAttribute('data-state'),'waiting');
  assert.equal(await pip.locator(`[data-agent="${agentName}"]`).getAttribute('aria-label'),`${agentName}, waiting on you`);
  assert.equal(await card.evaluate(el=>el.classList.contains('needs-you')),true,'the coral border');
  const pill=card.getByRole('button',{name:'Needs you: Review Synthetic launch post. Open the chat',exact:true});
  await pill.waitFor();
  assert.equal(await pill.innerText(),'Review Synthetic launch post');
  assert.equal(await page.getByRole('button',{name:'Needs you (1)',exact:true}).count(),1,'the top bar counts the same item');

  // The pill opens the chat.
  await pill.click();
  await page.locator('.canvas-chat').waitFor();
  assert.equal(new URL(page.url()).searchParams.get('chat'),h.project.channelId);
},{canvas:true,viewport:{width:1440,height:900}});

await runChatTest('canvas rows: area summaries at compact zoom leave out zeros, count quiet and say all quiet; a drawn area is named at once',async h=>{
  const {page,base}=h;
  const {id:canvas}=await call<{id:string}>(h,'POST','/api/canvases',{id:crypto.randomUUID(),name:'Summaries'});
  await newArea(h,canvas,{title:'Launch',x:0,y:0,w:1100,h:480});
  await newArea(h,canvas,{title:'Ideas',x:1300,y:0,w:500,h:480});
  const brand=await newArea(h,canvas,{title:'Brand kit',x:0,y:800,w:500,h:400});
  const research=await newArea(h,canvas,{title:'Research',x:700,y:800,w:500,h:400});
  await call(h,'POST',`/api/canvases/${canvas}/areas/${research}/context/links`,{sourceAreaId:brand});
  const quiet=await newProject(h,'Synthetic quiet chat');
  await call(h,'POST',`/api/canvases/${canvas}/cards`,{cards:[{channelId:h.project.channelId,x:40,y:100},{channelId:quiet.channelId,x:400,y:100}]});
  await startTurn(h,h.project.channelId);
  await startTurn(h,quiet.channelId,25*60_000+5_000);
  await page.goto(`${base}/?view=canvas&canvas=${canvas}`);
  await agentRow(page,quiet.channelId).locator('.canvas-card-what').getByText('quiet for 25 min',{exact:true}).waitFor();
  await page.locator('[aria-label="Area Launch"]').waitFor();
  await zoomUntil(page,'Zoom out',percent=>percent<50);
  await page.locator('.canvas-world.is-compact').waitFor({state:'attached'});
  const summary=(title:string)=>page.locator(`[aria-label="Area ${title}"] .canvas-area-summary`);
  await summary('Launch').getByText('1 moving · 1 quiet',{exact:true}).waitFor();
  assert.equal(await summary('Ideas').innerText(),'all quiet');
  assert.equal(await summary('Brand kit').innerText(),'Shared resources','an area with no chats that another area uses');
  assert.equal(await summary('Research').innerText(),'all quiet');
  // The summary sits under the title, above the area.
  const [titleBox,sumBox,areaBox]=await Promise.all([page.locator('[aria-label="Area Launch"] .canvas-area-title').boundingBox(),summary('Launch').boundingBox(),page.locator('[aria-label="Area Launch"]').boundingBox()]);
  assert.ok(titleBox&&sumBox&&areaBox&&sumBox.y>=titleBox.y+titleBox.height-1&&sumBox.y+sumBox.height<=areaBox.y+1,'under the title and above the area');

  // A review makes one card need you: the count leads, in coral and bold.
  await reviewTask(h,h.project.id,'Synthetic launch post');
  await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
  await summary('Launch').getByText('1 need you · 1 moving · 1 quiet',{exact:true}).waitFor();
  const need=summary('Launch').locator('b');
  assert.equal(await need.innerText(),'1 need you');
  const [needColour,mutedColour]=await Promise.all([need.evaluate(el=>getComputedStyle(el).color),summary('Launch').evaluate(el=>getComputedStyle(el).color)]);
  assert.notEqual(needColour,mutedColour,'the need count has its own (coral) colour');
  // The compact card: a coral dot for the card that needs you, `quiet` for the quiet one.
  await cardAt(page,h.project.channelId).locator('.canvas-card-far[data-kind="needs"]').waitFor();
  await cardAt(page,quiet.channelId).locator('.canvas-card-far[data-kind="quiet"]').getByText('quiet',{exact:true}).waitFor();

  // Drawing around a card: the title opens for typing and the toast says how its chats share context.
  await zoomUntil(page,'Zoom in',percent=>percent>=50);
  // An empty 300 px square on screen: nothing but the surface under any of its corners or its centre.
  // A string, so the bundler adds no helpers to the page function.
  const spot=await page.evaluate(`(() => {
    const surface = document.querySelector('.canvas-surface').getBoundingClientRect();
    const corners = [[0,0],[300,0],[0,300],[300,300],[150,150]];
    for (let y = surface.top + 80; y < surface.bottom - 320; y += 40) for (let x = surface.left + 80; x < surface.right - 320; x += 40) {
      if (corners.every(([dx, dy]) => { const el = document.elementFromPoint(x + dx, y + dy); return !!el && (el.classList.contains('canvas-surface') || el.classList.contains('canvas-world')); })) return {x, y};
    }
    return null;
  })()`) as {x:number;y:number}|null;
  assert.ok(spot,'an empty spot to draw in');
  await page.getByRole('button',{name:'Area',exact:true}).click();
  await page.mouse.move(spot.x,spot.y);
  await page.mouse.down();
  await page.mouse.move(spot.x+150,spot.y+150,{steps:4});
  await page.mouse.move(spot.x+300,spot.y+300,{steps:4});
  await page.mouse.up();
  const title=page.getByRole('textbox',{name:'Area title',exact:true});
  await title.waitFor();
  assert.equal(await title.evaluate(el=>document.activeElement===el),true);
  await page.locator('.canvas-notice').getByText('New area. Name it, then drop chats into it.',{exact:true}).waitFor();
  await page.keyboard.type('Later');
  await page.keyboard.press('Enter');
  await page.locator('[aria-label="Area Later"]').waitFor();
  const launch=(await cardAt(page,h.project.channelId).boundingBox())!;
  await page.getByRole('button',{name:'Area',exact:true}).click();
  await page.mouse.move(launch.x-20,launch.y-24);
  await page.mouse.down();
  await page.mouse.move(launch.x+launch.width/2,launch.y+launch.height/2,{steps:4});
  await page.mouse.move(launch.x+launch.width+20,launch.y+launch.height+24,{steps:4});
  await page.mouse.up();
  await title.waitFor();
  await page.locator('.canvas-notice').getByText('New area around 1 conversation. Name it. Chats share its context once a member moves them in or picks "Use this area\'s context".',{exact:true}).waitFor();
},{canvas:true,viewport:{width:1440,height:900}});
