// Links between chats (Phase 3, Task 6): the mock's link lines and labels, the Hand-off popover (what, when, pause,
// resume, disconnect), a real hand-off posted by the stopped Switchyard agent and its line in the target chat, on the
// real engine, API, worker and WS. Synthetic data only.
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {Page} from 'playwright';
import type {FlowNeed,Link} from '@nest/schemas';
import {agentName,runChatTest,type ChatHarness} from '../support/chat-harness';

type EngineEvent={id:string;type:string;source:string;payload?:{text?:string;nestSwitchyard?:{kind?:string}}};

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
/** The stored link, as the link API lists it for the source chat. */
const linkOf=async(h:ChatHarness,from:string,id:string)=>(await call<{links:Link[]}>(h,'GET',`/api/flows/links?channelId=${encodeURIComponent(from)}`)).links.find(l=>l.id===id);
/** The hand-offs Switchyard has posted into a chat. */
const handoffs=async(h:ChatHarness,channelId:string)=>(await call<EngineEvent[]>(h,'GET',`/api/events?channelId=${encodeURIComponent(channelId)}&type=message.created&limit=200`))
  .filter(event=>event.source==='agent:Switchyard'&&event.payload?.nestSwitchyard?.kind==='handoff');
/** One Pip turn in a chat: started, its message, completed (as the runner emits them). */
async function turn(h:ChatHarness,channelId:string,text:string){
  const triggerEventId=crypto.randomUUID();
  await h.emit('agent.turn.started',{triggerEventId,eventCount:1},{channelId});
  await h.emit('message.created',{text},{channelId});
  await h.emit('agent.turn.completed',{triggerEventId,eventCount:1},{channelId});
}
/** Pom, the Blog post project (Pom in it), a canvas with both cards side by side, and a link from the harness chat to Blog post. */
async function linkedBoard(h:ChatHarness){
  await call(h,'POST','/api/agents',{name:'Pom',icon:'pom',visibility:'PUBLIC',modelId:'wrapped:none',workspacePath:join(mkdtempSync(join(tmpdir(),'nest-links-')),'pom')});
  const blog=await call<{channelId:string}>(h,'POST','/api/projects',{id:crypto.randomUUID(),name:'Blog post',description:'Synthetic blog project',members:[{subscriberType:'AGENT',subscriberId:'Pom'}]});
  const {id:canvasId}=await call<{id:string}>(h,'POST','/api/canvases',{id:crypto.randomUUID(),name:'Flows board'});
  await call(h,'POST',`/api/canvases/${canvasId}/cards`,{cards:[{channelId:h.project.channelId,x:80,y:140},{channelId:blog.channelId,x:640,y:140}]});
  const link=await call<Link>(h,'POST','/api/flows/links',{id:crypto.randomUUID(),from:h.project.channelId,to:blog.channelId});
  return {canvasId,blog:blog.channelId,link};
}
async function openCanvas(page:Page,base:string,id:string){
  await page.goto(`${base}/?view=canvas&canvas=${id}`);
  await page.locator('.canvas-card').first().waitFor();
}
const labelText=(page:Page)=>page.locator('.canvas-world > .lab').innerText();

await runChatTest('canvas links: the line and label, the Hand-off popover, pause, a delivered hand-off and disconnect',async h=>{
  const {page,base}=h, from=h.project.channelId;
  const {canvasId,blog,link}=await linkedBoard(h);
  await openCanvas(page,base,canvasId);

  // One live line with its moving flow, and a label reading the link's name.
  await page.locator('.canvas-links .lk.on').waitFor({state:'attached'});
  assert.equal(await page.locator('.canvas-links .lk').count(),1);
  assert.equal(await page.locator('.canvas-links .lk-flow').count(),1);
  const label=page.locator('.canvas-world > .lab');
  await label.waitFor();
  assert.equal(await labelText(page),'results');
  assert.equal(await label.getAttribute('title'),'Click to change what passes along, when, and to whom');
  assert.equal(await label.evaluate(el=>getComputedStyle(el.parentElement!.querySelector('.lk-flow')!).animationName),'canvas-link-flow');

  // Switchyard joined both chats, but it is never a card row, a tray face or a picker entry.
  assert.equal(await page.locator('.canvas-card [data-agent="Switchyard"]').count(),0,'no card row');
  await page.locator(`.canvas-card[data-channel-id="${from}"] [data-agent="${agentName}"]`).waitFor();
  const tray=page.getByRole('region',{name:'Agents',exact:true});
  await tray.locator('[data-agent]').first().waitFor();
  assert.equal(await tray.locator('[data-agent="Switchyard"]').count(),0,'no tray face');
  await tray.getByRole('button',{name:/^All \d+ agents$/}).click();
  await page.locator('.canvas-picker-row').first().waitFor();
  assert.deepEqual((await page.locator('.canvas-picker-row').evaluateAll(rows=>rows.map(row=>row.getAttribute('data-agent')))).sort(),[agentName,'Pom'],'picker rows');
  await page.keyboard.press('Escape');
  await page.locator('.canvas-picker-row').first().waitFor({state:'detached'});

  // The label opens the Hand-off popover.
  await label.click();
  const pop=page.getByRole('dialog',{name:'Hand-off between chats',exact:true});
  await pop.getByRole('heading',{name:'Hand-off',exact:true}).waitFor();
  await pop.getByText('Synthetic chat project → Blog post',{exact:true}).waitFor();
  await pop.getByText('Who picks it up in “Blog post”',{exact:true}).waitFor();
  const summary=pop.locator('.lk-sum');
  assert.equal(await summary.innerText(),`When ${agentName} finishes something in Synthetic chat project, its results and files go to Blog post and it waits there as context for whoever is in it.`);
  assert.equal(await pop.locator('.opt.on').count(),2,'one what and one when chosen');
  assert.deepEqual(await pop.locator('.pick').evaluateAll(list=>list.map(p=>p.textContent?.trim())),['Pom','Nobody, just context','+ Someone else']);

  // After I approve it: saved at once, and the label says so.
  await pop.getByRole('button',{name:/^After I approve it/}).click();
  await until(()=>labelText(page),text=>text==='results · needs OK','label after approve');
  await until(()=>linkOf(h,from,link.id),l=>l?.when==='approve','server link when:approve');
  assert.match(await summary.innerText(),/and you approve it, /);

  // Pick Pom: the summary names who picks it up.
  await pop.getByRole('button',{name:'Pom',exact:true}).click();
  await until(()=>linkOf(h,from,link.id),l=>l?.who==='Pom','server link who:Pom');
  await until(()=>summary.innerText(),text=>text.includes('and Pom picks it up.'),'summary names Pom');

  // Each time it finishes something: a turn would hand off at once, so the paused check below is a real one.
  await pop.getByRole('button',{name:/^Each time it finishes something/}).click();
  await until(()=>linkOf(h,from,link.id),l=>l?.when==='done','server link when:done');
  await until(()=>labelText(page),text=>text==='results','label back to results');

  // Pause: a dashed line, a dashed label, and the summary says so.
  await pop.getByRole('button',{name:'Pause',exact:true}).click();
  await page.locator('.canvas-links .lk.off').waitFor({state:'attached'});
  assert.equal(await page.locator('.canvas-links .lk-flow').count(),0,'no flow while paused');
  await page.locator('.canvas-world > .lab.off').waitFor();
  await until(()=>labelText(page),text=>text==='results · paused','paused label');
  await until(()=>summary.innerText(),text=>text.endsWith('Paused right now.'),'summary ends paused');
  await until(()=>linkOf(h,from,link.id),l=>l?.on===false,'server link off');

  // A finished Pip turn while paused hands nothing off, and nothing waits for approval either.
  await turn(h,from,'Synthetic outline while paused');
  for(let n=0;n<3;n++)await h.flowsTick();
  await page.waitForTimeout(600);
  assert.equal((await handoffs(h,blog)).length,0,'no hand-off while paused');
  const needs=await call<{items:FlowNeed[]}>(h,'GET','/api/flows/needs');
  assert.equal(needs.items.filter(n=>n.gate.kind==='approval'&&n.gate.linkId===link.id).length,0,'no approval waiting while paused');

  // Resume: the next turn arrives in Blog post.
  await pop.getByRole('button',{name:'Resume',exact:true}).click();
  await page.locator('.canvas-links .lk.on').waitFor({state:'attached'});
  await until(()=>linkOf(h,from,link.id),l=>l?.on===true&&l.when==='done','server link on and done');
  await turn(h,from,'Synthetic draft ready for the blog');
  const [posted]=await until(()=>handoffs(h,blog),list=>list.length===1,'one hand-off posted');
  assert.match(posted.payload?.text??'',/^Hand-off from Synthetic chat project · set up by demo-owner\n\nSynthetic draft ready for the blog$/);
  await pop.getByRole('button',{name:'Done',exact:true}).click();
  await pop.waitFor({state:'detached'});

  // The target chat shows it as a Switchyard line: `↳` and muted italics, then the result, with no portrait or To line.
  await page.getByRole('button',{name:'Open chat Blog post',exact:true}).click();
  const sheet=page.getByRole('dialog',{name:'Open chat Blog post',exact:true});
  const line=sheet.locator('.message-src').first();
  await line.waitFor();
  assert.equal(await line.locator('.message-src-line').innerText(),'Hand-off from Synthetic chat project · set up by demo-owner');
  // Italic for real: Inter ships no italic face here, and the page turns font synthesis off.
  assert.deepEqual(await line.locator('.message-src-line').evaluate(el=>[getComputedStyle(el).fontStyle,getComputedStyle(el).getPropertyValue('font-synthesis-style')]),['italic','auto']);
  await line.getByText('Synthetic draft ready for the blog',{exact:true}).waitFor();
  assert.equal(await line.locator('.agent-portrait, .message-author, .message-target').count(),0,'no portrait, author or To line');
  assert.equal(await line.locator('[aria-hidden="true"]').first().innerText(),'↳');
  // Its face is in the chat's sub-line, saying what it is.
  await sheet.locator('.canvas-chat-face[title="Switchyard · posts hand-offs and scheduled runs; never replies"]').waitFor();
  await sheet.getByRole('button',{name:'Close',exact:true}).click();
  await sheet.waitFor({state:'detached'});

  // Disconnect: the line goes, the toast says Blog post keeps what it got, and the hand-off stays in the chat.
  await label.click();
  await pop.getByRole('button',{name:'Disconnect',exact:true}).click();
  await page.getByRole('status').filter({hasText:'Disconnected. "Blog post" keeps what it already got.'}).waitFor();
  await pop.waitFor({state:'detached'});
  await until(()=>page.locator('.canvas-links .lk').count(),n=>n===0,'line gone');
  assert.equal(await page.locator('.canvas-world > .lab').count(),0,'label gone');
  assert.equal((await handoffs(h,blog)).length,1,'the hand-off stays');
  await page.getByRole('button',{name:'Open chat Blog post',exact:true}).click();
  await page.getByRole('dialog',{name:'Open chat Blog post',exact:true}).locator('.message-src').getByText('Synthetic draft ready for the blog',{exact:true}).waitFor();
},{canvas:true,flows:true});

await runChatTest('canvas links: reduced motion stills the flow; Escape and an outside press close the popover',async h=>{
  const {page,base}=h;
  const {canvasId,link}=await linkedBoard(h);
  await openCanvas(page,base,canvasId);
  const flow=page.locator('.canvas-links .lk-flow');
  await flow.waitFor({state:'attached'});
  assert.equal(await flow.evaluate(el=>getComputedStyle(el).animationName),'none');

  const label=page.locator('.canvas-world > .lab');
  const pop=page.getByRole('dialog',{name:'Hand-off between chats',exact:true});
  await label.click();
  await pop.waitFor();
  // The mock's popAt: 170 px left of the label and 10 px under it, kept 16 px inside the window and 76 px from the top.
  const [box,at,size]=[await pop.boundingBox(),await label.boundingBox(),page.viewportSize()!];
  assert.ok(box&&at);
  const expected={x:Math.max(16,Math.min(size.width-box.width-16,at.x-170)),y:Math.max(76,Math.min(size.height-box.height-16,at.y+at.height+10))};
  assert.ok(Math.abs(box.x-expected.x)<=1&&Math.abs(box.y-expected.y)<=1,`popover placed as popAt: ${JSON.stringify({box,at,expected})}`);
  // A name typed and closed at once with Escape (inside the 600 ms save delay) still saves.
  await pop.locator('#lk-label').fill('Synthetic outline');
  await page.keyboard.press('Escape');
  await pop.waitFor({state:'detached'});
  await until(()=>linkOf(h,h.project.channelId,link.id),l=>l?.label==='Synthetic outline','server label after Escape');
  await until(()=>labelText(page),text=>text==='Synthetic outline','line label after Escape');
  // Focus goes back to the label.
  assert.equal(await page.evaluate(()=>document.activeElement?.classList.contains('lab')),true);
  await label.click();
  await pop.waitFor();
  const surface=(await page.locator('.canvas-surface').boundingBox())!;
  await page.mouse.click(surface.x+surface.width-40,surface.y+surface.height-200);
  await pop.waitFor({state:'detached'});
},{canvas:true,flows:true,reducedMotion:'reduce'});
