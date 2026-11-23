// Links between chats (Phase 3, Tasks 6-8): the mock's link lines and labels, the Hand-off popover (what, when, pause,
// resume, disconnect), a real hand-off posted by the stopped Switchyard agent and its line in the target chat, connecting
// chats, and approvals in Needs you with Approve / Request changes in the open chat, on the real engine, API, worker and
// WS. Synthetic data only.
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname,join} from 'node:path';
import Database from 'better-sqlite3';
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

/** Pom, the Blog post project (Pom in it) and a canvas with the harness chat and Blog post side by side, not linked. */
async function twoCards(h:ChatHarness){
  await call(h,'POST','/api/agents',{name:'Pom',icon:'pom',visibility:'PUBLIC',modelId:'wrapped:none',workspacePath:join(mkdtempSync(join(tmpdir(),'nest-links-')),'pom')});
  const blog=await call<{channelId:string}>(h,'POST','/api/projects',{id:crypto.randomUUID(),name:'Blog post',description:'Synthetic blog project',members:[{subscriberType:'AGENT',subscriberId:'Pom'}]});
  const {id:canvasId}=await call<{id:string}>(h,'POST','/api/canvases',{id:crypto.randomUUID(),name:'Flows board'});
  await call(h,'POST',`/api/canvases/${canvasId}/cards`,{cards:[{channelId:h.project.channelId,x:80,y:140},{channelId:blog.channelId,x:640,y:140}]});
  return {canvasId,blog:blog.channelId};
}
const cardOf=(page:Page,channelId:string)=>page.locator(`.canvas-card[data-channel-id="${channelId}"]`);
const centre=(box:{x:number;y:number;width:number;height:number})=>({x:box.x+box.width/2,y:box.y+box.height/2});
/** Presses A's + port and moves to a point in steps, without releasing. */
async function dragPort(page:Page,channelId:string,to:{x:number;y:number}){
  const card=cardOf(page,channelId);
  await card.hover();
  const port=card.locator('[data-port]');
  await until(()=>port.evaluate(el=>getComputedStyle(el).opacity),o=>o==='1','the port shows on hover');
  const at=centre((await port.boundingBox())!);
  await page.mouse.move(at.x,at.y);
  await page.mouse.down();
  await page.mouse.move(at.x+20,at.y+4,{steps:3});
  await page.mouse.move(to.x,to.y,{steps:8});
}

await runChatTest('canvas links: drag the + port onto a card, or onto empty canvas for a new step',async h=>{
  const {page,base}=h, from=h.project.channelId;
  const {canvasId,blog}=await twoCards(h);
  await openCanvas(page,base,canvasId);
  const card=cardOf(page,from);
  const port=card.locator('[data-port]');
  assert.equal(await port.getAttribute('title'),'Drag to another chat to pass results along');
  assert.equal(await port.evaluate(el=>getComputedStyle(el,'::before').content),'"+"');

  // Onto Blog post: a dashed accent line follows the pointer, and the card under it is outlined.
  await dragPort(page,from,centre((await cardOf(page,blog).boundingBox())!));
  await page.locator('.canvas-links .lk.temp').waitFor({state:'attached'});
  assert.match((await page.locator('.canvas-links .lk.temp').getAttribute('d'))??'',/^M[\d.-]+ [\d.-]+C/);
  assert.deepEqual(await page.locator('.canvas-card.linktarget').evaluateAll(els=>els.map(el=>el.getAttribute('data-channel-id'))),[blog]);
  await page.mouse.up();
  const pop=page.getByRole('dialog',{name:'Hand-off between chats',exact:true});
  await pop.getByText('Synthetic chat project → Blog post',{exact:true}).waitFor();
  assert.equal(await page.locator('.canvas-links .lk.temp, .canvas-card.linktarget').count(),0,'the drag marks are gone');
  const links=await until(()=>call<{links:Link[]}>(h,'GET',`/api/flows/links?channelId=${encodeURIComponent(from)}`),r=>r.links.length===1,'one link');
  assert.deepEqual([links.links[0].from,links.links[0].to],[from,blog]);
  // The line leaves the source card at its measured middle (cards stay measured under StrictMode).
  const startY=Number(/^M[\d.-]+ ([\d.-]+)C/.exec((await page.locator('.canvas-links .lk').first().getAttribute('d'))??'')?.[1]);
  const middle=140+await card.evaluate(el=>(el as HTMLElement).offsetHeight)/2;
  assert.ok(Math.abs(startY-middle)<=1,`the line starts at the card's middle: ${startY} vs ${middle}`);
  await pop.getByRole('button',{name:'Done',exact:true}).click();
  await pop.waitFor({state:'detached'});

  // Onto empty canvas, above the cards: a new chat is placed where the pointer was released, linked, with its note.
  const box=(await card.boundingBox())!;
  const release={x:box.x+box.width/2,y:box.y-150};
  assert.equal(await page.evaluate(({x,y})=>document.elementFromPoint(x,y)?.className,release),'canvas-surface','the release point is empty canvas');
  await dragPort(page,from,release);
  assert.equal(await page.locator('.canvas-card.linktarget').count(),0,'no card outlined over empty canvas');
  await page.mouse.up();
  const title='Next step after "Synthetic chat project"';
  const step=page.locator('.canvas-card').filter({has:page.getByRole('heading',{name:title,exact:true})});
  await step.waitFor();
  const placed=(await step.boundingBox())!;
  assert.ok(release.x>=placed.x&&release.x<=placed.x+placed.width&&release.y>=placed.y&&release.y<=placed.y+placed.height,`placed at the release point: ${JSON.stringify({release,placed})}`);
  await pop.getByText(`Synthetic chat project → ${title}`,{exact:true}).waitFor();
  await page.getByRole('status').filter({hasText:'New step added. Pick who picks it up.'}).waitFor();
  const stepId=(await step.getAttribute('data-channel-id'))!;
  await until(()=>call<{links:Link[]}>(h,'GET',`/api/flows/links?channelId=${encodeURIComponent(stepId)}`),r=>r.links.some(l=>l.from===from&&l.to===stepId),'the new step is linked');
  await pop.getByRole('button',{name:'Done',exact:true}).click();
  await pop.waitFor({state:'detached'});
  await page.getByRole('button',{name:`Open chat ${title}`,exact:true}).click();
  const sheet=page.getByRole('dialog',{name:`Open chat ${title}`,exact:true});
  await until(()=>sheet.locator('.message-src-line').allInnerTexts(),texts=>texts.includes('Picks up what "Synthetic chat project" produces.'),'the new step\'s note');
  await sheet.getByRole('button',{name:'Close',exact:true}).click();
  await sheet.waitFor({state:'detached'});

  // A release over chrome (the zoom controls) does nothing: a connect or new step would send its request during pointerup.
  const cards=await page.locator('.canvas-card').count();
  const writes:string[]=[];
  const record=(request:{method():string;url():string})=>{if(request.method()==='POST'&&/\/api\/(projects|flows\/links)\b/.test(request.url()))writes.push(request.url());};
  page.on('request',record);
  await dragPort(page,from,centre((await page.locator('.canvas-zoom').boundingBox())!));
  await page.mouse.up();
  // A round trip after the release: anything the release sent has reached the network by now.
  await page.evaluate(async()=>{await fetch('/api/flows/availability');});
  page.off('request',record);
  assert.deepEqual(writes,[],'no connect or new step over the zoom controls');
  assert.equal(await page.locator('.canvas-card').count(),cards,'no new card');
  assert.equal(await pop.count(),0,'no popover over chrome');
},{canvas:true,flows:true});

await runChatTest('canvas links: the chat picker, the Setup line and its links row, and loose chats',async h=>{
  const {page,base}=h, from=h.project.channelId;
  const {canvasId,blog}=await twoCards(h);
  const notes=await call<{channelId:string}>(h,'POST','/api/projects',{id:crypto.randomUUID(),name:'Research notes',description:'Synthetic research',members:[]});
  await call(h,'POST',`/api/canvases/${canvasId}/cards`,{cards:[{channelId:notes.channelId,x:80,y:560}]});
  const loose=await call<{channelId:string}>(h,'POST','/api/projects',{id:crypto.randomUUID(),name:'Loose idea',description:'Synthetic loose chat',members:[{subscriberType:'AGENT',subscriberId:'Pom'}]});
  await call(h,'POST','/api/flows/links',{id:crypto.randomUUID(),from,to:blog});
  await openCanvas(page,base,canvasId);

  // The card's connect button opens the picker: every other chat on the canvas, the linked one marked, and a new step.
  const connect=cardOf(page,from).getByRole('button',{name:'Connect: pass this chat\'s results to another chat',exact:true});
  assert.equal(await connect.getAttribute('title'),'Connect: pass this chat\'s results to another chat');
  await connect.click();
  const picker=page.getByRole('dialog',{name:'Connect chats',exact:true});
  await picker.getByRole('heading',{name:'Connect “Synthetic chat project”',exact:true}).waitFor();
  await picker.getByText('Pick the chat that should get its results. Or drag the + on a card\'s right edge onto another card.',{exact:true}).waitFor();
  const search=picker.getByPlaceholder('Find a chat…');
  assert.equal(await page.evaluate(()=>(document.activeElement as HTMLInputElement|null)?.placeholder),'Find a chat…','the search has focus');
  const rows=picker.locator('.lpick button[data-to]');
  // Each row: the chat's face (its first agent, else its first person's initials), its title, and `connected` when linked.
  const rowTexts=()=>rows.evaluateAll(els=>els.map(el=>[...el.childNodes].filter(n=>!(n instanceof Element&&(n.classList.contains('lp-face')||n.classList.contains('agent-portrait')))).map(n=>n.textContent).join(' ').trim()));
  assert.deepEqual((await rowTexts()).sort(),['Blog post connected','Research notes']);
  assert.equal(await rows.filter({hasText:'Blog post'}).locator('.agent-portrait').count(),1,'Blog post shows Pom');
  await picker.getByRole('button',{name:'A new step after this one'}).waitFor();
  await search.fill('blo');
  assert.deepEqual(await rowTexts(),['Blog post connected']);
  await search.fill('nothing like this');
  await picker.getByText('No chat with that name.',{exact:true}).waitFor();
  await picker.getByRole('button',{name:'A new step after this one'}).waitFor();
  await picker.getByRole('button',{name:'Cancel',exact:true}).click();
  await picker.waitFor({state:'detached'});

  // The open chat: the Setup line reads its agent and how many chats it is connected to.
  await page.getByRole('button',{name:'Open chat Synthetic chat project',exact:true}).click();
  const sheet=page.getByRole('dialog',{name:'Open chat Synthetic chat project',exact:true});
  const setup=sheet.locator('details.cfg');
  await setup.waitFor();
  await until(()=>setup.locator('summary .sm-chip').allInnerTexts().then(t=>t.map(s=>s.trim()).join(' · ')),t=>t===`${agentName} · 1 connected`,'the Setup summary');
  assert.equal(await setup.locator('summary .more').innerText(),'Setup');
  await sheet.getByRole('button',{name:'Connect: pass results to another chat',exact:true}).waitFor();
  await setup.locator('summary').click();
  const row=setup.locator('.links-row');
  await row.waitFor();
  assert.deepEqual((await row.locator(':scope > *').allInnerTexts()).map(t=>t.trim()),['Passes to','→ Blog post','+ Connect']);
  const chip=row.getByRole('button',{name:'→ Blog post',exact:true});
  assert.equal(await chip.getAttribute('title'),'Passes results to Blog post');

  // The chip opens the Hand-off popover; pausing strikes it through.
  await chip.click();
  const pop=page.getByRole('dialog',{name:'Hand-off between chats',exact:true});
  await pop.getByRole('button',{name:'Pause',exact:true}).click();
  await until(()=>chip.getAttribute('class'),c=>/\boff\b/.test(c??''),'the chip is paused');
  assert.match(await chip.evaluate(el=>getComputedStyle(el).textDecorationLine),/line-through/);
  await pop.getByRole('button',{name:'Done',exact:true}).click();
  await pop.waitFor({state:'detached'});

  // + Connect opens the picker for this chat.
  await row.getByRole('button',{name:'+ Connect',exact:true}).click();
  await picker.getByRole('heading',{name:'Connect “Synthetic chat project”',exact:true}).waitFor();
  await page.keyboard.press('Escape');
  await picker.waitFor({state:'detached'});
  await sheet.getByRole('button',{name:'Close',exact:true}).click();
  await sheet.waitFor({state:'detached'});

  // Setup stays open for this person after a reload.
  await page.reload();
  await page.locator('.canvas-card').first().waitFor();
  await page.getByRole('button',{name:'Open chat Synthetic chat project',exact:true}).click();
  await sheet.locator('details.cfg[open] .links-row').waitFor();
  await sheet.getByRole('button',{name:'Close',exact:true}).click();
  await sheet.waitFor({state:'detached'});

  // A loose chat has a Setup line but no connect button and no links row.
  await page.goto(`${base}/?view=canvas&canvas=${canvasId}&chat=${loose.channelId}&mode=focus`);
  const plain=page.getByRole('dialog',{name:'Open chat Loose idea',exact:true});
  await plain.locator('details.cfg').waitFor();
  await until(()=>plain.locator('details.cfg summary .sm-chip').allInnerTexts(),t=>t.join('|')==='Pom','the loose chat\'s agent');
  assert.equal(await plain.getByRole('button',{name:'Connect: pass results to another chat',exact:true}).count(),0,'no connect button');
  assert.equal(await plain.locator('.links-row').count(),0,'no links row');
},{canvas:true,flows:true});

await runChatTest('canvas links: a phone has no port, and the Setup line still shows in the chat',async h=>{
  const {page,base}=h, from=h.project.channelId;
  const {canvasId,blog}=await twoCards(h);
  await call(h,'POST','/api/flows/links',{id:crypto.randomUUID(),from,to:blog});
  await page.goto(`${base}/?view=canvas&canvas=${canvasId}`);
  // The phone's canvas shows no port (touch never drags it; the chat picker connects instead).
  await page.locator(`.canvas-card[data-channel-id="${from}"]`).waitFor();
  assert.equal(await page.locator('[data-port]').evaluateAll(els=>els.filter(el=>getComputedStyle(el).display!=='none').length),0,'no port on a phone');
  // The rest goes through the list.
  await page.getByRole('button',{name:'List',exact:true}).tap();
  const list=page.getByRole('region',{name:'Canvas list',exact:true});
  await list.waitFor();
  await list.getByRole('button',{name:/^Not in an area/}).tap();
  await list.getByRole('list',{name:'Chats not in an area',exact:true}).getByRole('button',{name:/^Synthetic chat project/}).tap();
  const chat=page.locator('.canvas-chat');
  await chat.locator('details.cfg').waitFor();
  await until(()=>chat.locator('details.cfg summary .sm-chip').allInnerTexts().then(t=>t.map(s=>s.trim()).join(' · ')),t=>t===`${agentName} · 1 connected`,'the phone Setup summary');
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'no horizontal page scroll at 390 px');

  // + Connect opens the picker, which offers a new step on a phone too; it lands beside the chat's card.
  await chat.locator('details.cfg summary').tap();
  await chat.getByRole('button',{name:'+ Connect',exact:true}).tap();
  const picker=page.getByRole('dialog',{name:'Connect chats',exact:true});
  await picker.waitFor();
  const fits=async(dialog:typeof picker)=>{const b=(await dialog.boundingBox())!;return b.x>=0&&b.x+b.width<=390;};
  assert.ok(await fits(picker),'the picker fits the phone');
  await picker.getByRole('button',{name:'A new step after this one'}).tap();
  const pop=page.getByRole('dialog',{name:'Hand-off between chats',exact:true});
  const title='Next step after "Synthetic chat project"';
  await pop.getByText(`Synthetic chat project → ${title}`,{exact:true}).waitFor();
  assert.ok(await fits(pop),'the popover fits the phone');
  type Card={channelId:string;x:number;y:number;w:number;access:string;title?:string};
  const board=await until(()=>call<{cards:Card[]}>(h,'GET',`/api/canvases/${canvasId}/board`),b=>b.cards.some(c=>c.title===title),'the new step on the board');
  const source=board.cards.find(c=>c.channelId===from)!,step=board.cards.find(c=>c.title===title)!;
  assert.deepEqual({x:step.x,y:step.y},{x:source.x+source.w+120,y:source.y},'placed 120 px right of the chat (the mock\'s lp-new, its top 60 px above from.y + 60)');
},{canvas:true,flows:true,viewport:{width:390,height:844},hasTouch:true});

await runChatTest('canvas links: a view-role member cannot connect, but keeps the chips to pause a link into their chat',async h=>{
  const {base}=h, from=h.project.channelId;
  const mate=await h.loginAs('mate');
  await call(h,'POST','/api/agents',{name:'Pom',icon:'pom',visibility:'PUBLIC',modelId:'wrapped:none',workspacePath:join(mkdtempSync(join(tmpdir(),'nest-links-')),'pom')});
  const blog=await call<{channelId:string}>(h,'POST','/api/projects',{id:crypto.randomUUID(),name:'Blog post',description:'Synthetic blog project',
    members:[{subscriberType:'AGENT',subscriberId:'Pom'},{subscriberType:'HUMAN',subscriberId:'mate'}]});
  const {id:canvasId}=await call<{id:string}>(h,'POST','/api/canvases',{id:crypto.randomUUID(),name:'Flows board'});
  await call(h,'POST',`/api/canvases/${canvasId}/cards`,{cards:[{channelId:from,x:80,y:140},{channelId:blog.channelId,x:640,y:140}]});
  await call(h,'POST','/api/flows/links',{id:crypto.randomUUID(),from,to:blog.channelId});
  const humans=await call<{id:string;username:string}[]>(h,'GET','/api/humans');
  const {canvas}=await call<{canvas:{version:number}}>(h,'GET',`/api/canvases/${canvasId}/board`);
  await call(h,'PUT',`/api/canvases/${canvasId}/members`,{visibility:'shared',members:[{humanId:humans.find(p=>p.username==='mate')!.id,role:'view'}],version:canvas.version});

  const page=mate.page;
  await openCanvas(page,base,canvasId);
  const card=cardOf(page,blog.channelId);
  await card.locator('.canvas-card-title').waitFor();
  await card.hover();
  assert.equal(await page.locator('[data-port]').count(),0,'no port');
  assert.equal(await page.getByRole('button',{name:'Connect: pass this chat\'s results to another chat',exact:true}).count(),0,'no card connect button');

  await page.getByRole('button',{name:'Open chat Blog post',exact:true}).click();
  const sheet=page.getByRole('dialog',{name:'Open chat Blog post',exact:true});
  await sheet.locator('details.cfg').waitFor();
  assert.equal(await sheet.getByRole('button',{name:'Connect: pass results to another chat',exact:true}).count(),0,'no header connect button');
  await sheet.locator('details.cfg summary').click();
  const row=sheet.locator('.links-row');
  const chip=row.locator('.lnk');
  await chip.waitFor();
  assert.equal(await chip.count(),1,'the link into Blog post');
  assert.match(await chip.innerText(),/^← /);
  assert.equal(await row.getByRole('button',{name:'+ Connect',exact:true}).count(),0,'no + Connect');
  // As a member of the receiving chat, the chip's popover still pauses the link (S10).
  await chip.click();
  const pop=page.getByRole('dialog',{name:'Hand-off between chats',exact:true});
  await pop.getByRole('button',{name:'Pause',exact:true}).click();
  await until(()=>chip.getAttribute('class'),c=>/\boff\b/.test(c??''),'the viewer paused the chip');
  assert.equal(await page.getByRole('dialog',{name:'Connect chats',exact:true}).count(),0,'no picker');
},{canvas:true,flows:true});

/** The deliveries on a link, newest first, read from the product database (fixtures only). */
function deliveries(h:ChatHarness,linkId:string){
  const product=new Database(join(dirname(h.engineDb.name),'product.sqlite'),{readonly:true});
  try{return product.prepare('SELECT status FROM product_link_deliveries WHERE link_id=? ORDER BY created_at DESC, rowid DESC').all(linkId) as {status:string}[];}
  finally{product.close();}
}
/** A Pip turn in the source chat, then worker ticks until its hand-off waits for the creator's OK. */
async function awaitingTurn(h:ChatHarness,from:string,text:string){
  await turn(h,from,text);
  await until(async()=>{await h.flowsTick();return (await call<{items:FlowNeed[]}>(h,'GET','/api/flows/needs')).items.filter(n=>n.kind==='approval').length;},n=>n===1,'one approval waits');
}
/** The page reads Needs you on focus (and every 15 s): ask it now. */
const refocus=(page:Page)=>page.evaluate(()=>{window.dispatchEvent(new Event('focus'));});
/** Whether a status region with this text is exposed: no aria-hidden or inert ancestor (a focus sheet hides the canvas). */
async function announced(page:Page,text:string){
  const region=page.getByRole('status').filter({hasText:text});
  await region.first().waitFor({state:'attached'});
  return region.evaluateAll(els=>els.some(el=>!el.closest('[aria-hidden="true"], [inert]')));
}
/** The human messages posted in a chat. */
const humanTexts=async(h:ChatHarness,channelId:string)=>(await call<EngineEvent[]>(h,'GET',`/api/events?channelId=${encodeURIComponent(channelId)}&type=message.created&limit=200`))
  .filter(e=>e.source==='human:demo-owner').map(e=>e.payload?.text);
/** The canvas notices on screen (errors from a decision would show here). */
const notices=(page:Page)=>page.locator('.canvas-notice').allTextContents();

await runChatTest('canvas links: an approval waits in Needs you; Approve hands it off, Request changes declines it with the reply, Don\'t hand off declines it at once, and a review is approved in the chat',async h=>{
  const {page,base}=h, from=h.project.channelId;
  const {canvasId,blog,link}=await linkedBoard(h);
  await call(h,'PATCH',`/api/flows/links/${link.id}`,{when:'approve',version:link.version});
  await openCanvas(page,base,canvasId);
  const needsButton=page.locator('button.canvas-needs');
  const count=async()=>Number(/\((\d+)\)$/.exec((await needsButton.getAttribute('aria-label'))??'')?.[1]);
  // A steady baseline: the flow items have answered and two reads 300 ms apart agree.
  const answered=page.waitForResponse(r=>r.url().endsWith('/api/flows/needs'));
  await refocus(page);
  await answered;
  let before=await count();
  for(let same=0;same<2;){await page.waitForTimeout(300);const next=await count();same=next===before?same+1:0;before=next;}

  // A finished turn waits for the creator's OK: Needs you counts it, and the source card's pill says what it waits for.
  await awaitingTurn(h,from,'Synthetic outline for the blog');
  await refocus(page);
  await until(count,n=>n===before+1,'Needs you counts the approval');
  await until(()=>cardOf(page,from).locator('.canvas-card-need-text').innerText(),t=>t==='Approve hand-off to Blog post','the source card\'s pill');
  assert.equal((await handoffs(h,blog)).length,0,'nothing handed off before the OK');

  // The open chat says where it stands, above the Setup line.
  await page.getByRole('button',{name:'Open chat Synthetic chat project',exact:true}).click();
  const sheet=page.getByRole('dialog',{name:'Open chat Synthetic chat project',exact:true});
  const digest=sheet.getByRole('region',{name:'Where it stands',exact:true});
  await digest.waitFor();
  assert.equal(await digest.locator('b').textContent(),'Where it stands');
  assert.match((await digest.textContent())??'',new RegExp(`^Where it stands${agentName}: .+\\.Waiting on you: `),'the agent line under the heading');
  assert.equal(await digest.locator('.wy').textContent(),'Waiting on you: Approve hand-off to Blog post');
  assert.deepEqual(await digest.locator('.gate button').allTextContents(),['Approve','Request changes',"Don't hand off"]);
  assert.equal(await sheet.locator('.canvas-chat-body > .digest + .cfg').count(),1,'the digest sits above the Setup line');

  // Approve: Blog post gets the hand-off, the toast names it, and the item is gone.
  await digest.getByRole('button',{name:'Approve',exact:true}).click();
  const [posted]=await until(()=>handoffs(h,blog),list=>list.length===1,'the approved hand-off arrives');
  assert.match(posted.payload?.text??'',/Synthetic outline for the blog$/);
  await page.locator('.canvas-notice').filter({hasText:'Handed off to "Blog post".'}).waitFor();
  assert.equal(await announced(page,'Handed off to "Blog post".'),true,'the toast is announced while the sheet is open');
  await until(()=>digest.count(),n=>n===0,'the digest goes after Approve');
  await until(()=>page.evaluate(()=>document.activeElement?.tagName??'none'),tag=>tag!=='BODY','focus stays in the chat after Approve');
  assert.equal(await sheet.evaluate(el=>el.contains(document.activeElement)),true,'focus is inside the sheet');
  await until(count,n=>n===before,'the approval left Needs you');
  assert.equal(deliveries(h,link.id)[0]?.status,'delivered');

  // Request changes, then Approve instead: the request is cancelled, so an unrelated message decides nothing.
  const box=sheet.getByRole('textbox',{name:'Message',exact:true});
  await awaitingTurn(h,from,'Synthetic second draft');
  await refocus(page);
  await digest.waitFor();
  await digest.getByRole('button',{name:'Request changes',exact:true}).click();
  await until(()=>box.getAttribute('placeholder'),p=>p==='What should change?','armed');
  await digest.getByRole('button',{name:'Approve',exact:true}).click();
  await until(()=>box.getAttribute('placeholder'),p=>p==='Message to Synthetic chat project','the placeholder is back after Approve');
  await until(()=>handoffs(h,blog),list=>list.length===2,'the second hand-off arrives');
  await until(()=>digest.count(),n=>n===0,'the digest goes after the second Approve');
  await box.fill('Synthetic unrelated note');
  await box.press('Enter');
  await until(()=>humanTexts(h,from),texts=>texts.includes('Synthetic unrelated note'),'the unrelated note is posted');
  for(let n=0;n<3;n++)await h.flowsTick();
  assert.deepEqual(deliveries(h,link.id).map(d=>d.status),['delivered','delivered'],'nothing declined');
  assert.equal((await notices(page)).some(t=>/Could not|already decided|paused/.test(t)),false,'no refusal toast');

  // Request changes, then the regular chat view: the request ends there too.
  await awaitingTurn(h,from,'Synthetic third draft');
  await refocus(page);
  await digest.waitFor();
  await digest.getByRole('button',{name:'Request changes',exact:true}).click();
  await until(()=>box.getAttribute('placeholder'),p=>p==='What should change?','armed again');
  await sheet.getByRole('button',{name:'Open in the regular chat view',exact:true}).click();
  await sheet.waitFor({state:'detached'});
  const regular=page.getByRole('textbox',{name:'Message',exact:true});
  await until(()=>regular.getAttribute('placeholder'),p=>p==='Message to Synthetic chat project','the regular chat view does not ask');
  await page.goBack();
  await digest.waitFor();

  // Request changes says in the digest what it waits for; Cancel ends it.
  const changes=digest.getByRole('button',{name:'Request changes',exact:true});
  await changes.click();
  await until(()=>box.getAttribute('placeholder'),p=>p==='What should change?','armed to cancel');
  assert.equal(await changes.getAttribute('aria-pressed'),'true');
  assert.match((await digest.getByRole('status').textContent())??'',/^Write what should change in the reply box below\. Sending it skips this hand-off\./);
  await digest.getByRole('button',{name:'Cancel',exact:true}).click();
  await until(()=>box.getAttribute('placeholder'),p=>p==='Message to Synthetic chat project','the placeholder is back after Cancel');
  assert.equal(await digest.getByRole('status').count(),0,'the waiting line goes');
  assert.equal(await changes.getAttribute('aria-pressed'),null);

  // Request changes asks in the reply box; the reply is posted here and the hand-off is declined.
  await changes.click();
  await until(()=>box.getAttribute('placeholder'),p=>p==='What should change?','the reply box asks what should change');
  assert.equal(await box.evaluate(el=>el===document.activeElement),true,'the reply box has focus');
  await box.fill('Shorter, please');
  await box.press('Enter');
  await until(async()=>(await call<EngineEvent[]>(h,'GET',`/api/events?channelId=${encodeURIComponent(from)}&type=message.created&limit=200`))
    .some(e=>e.source==='human:demo-owner'&&e.payload?.text==='Shorter, please'),ok=>ok,'the reply is posted in the source chat');
  await until(async()=>deliveries(h,link.id)[0]?.status,status=>status==='declined','the hand-off is declined');
  await until(()=>digest.count(),n=>n===0,'the digest goes after Request changes');
  await until(()=>box.getAttribute('placeholder'),p=>p!=='What should change?','the placeholder is back');
  for(let n=0;n<3;n++)await h.flowsTick();
  assert.equal((await handoffs(h,blog)).length,2,'Blog post got nothing new');
  assert.deepEqual(deliveries(h,link.id).map(d=>d.status),['declined','delivered','delivered'],'declined once');
  assert.equal((await notices(page)).some(t=>/Could not|already decided|paused/.test(t)),false,'no refusal toast after the reply');

  // Don't hand off: declined at once, nothing reaches Blog post, and the link stays on.
  await awaitingTurn(h,from,'Synthetic fourth draft');
  await refocus(page);
  await digest.waitFor();
  await digest.getByRole('button',{name:"Don't hand off",exact:true}).click();
  await page.locator('.canvas-notice').filter({hasText:'Not handed off to "Blog post".'}).waitFor();
  await until(()=>digest.count(),n=>n===0,"the digest goes after Don't hand off");
  for(let n=0;n<3;n++)await h.flowsTick();
  assert.equal((await handoffs(h,blog)).length,2,'Blog post still got nothing new');
  assert.deepEqual(deliveries(h,link.id).map(d=>d.status),['declined','declined','delivered','delivered'],'declined twice');

  // A task awaiting review in the open chat (a real deliverable): Approve marks it done.
  const task=await call<{id:string;version:number}>(h,'POST',`/api/projects/${h.project.id}/tasks`,{id:crypto.randomUUID(),title:'Synthetic launch copy',
    instructions:'Synthetic instructions',acceptanceCriteria:'Synthetic criteria',agentName});
  const taskPath=`/api/projects/${h.project.id}/tasks/${task.id}`;
  const working=await call<{version:number}>(h,'POST',`${taskPath}/dispatch`,{version:task.version});
  const result=await h.emit('message.created',{text:'Synthetic launch copy, ready'});
  await call(h,'POST',`${taskPath}/deliverables`,{version:working.version,eventId:result.id});
  await refocus(page);
  await until(()=>digest.locator('.wy').textContent().catch(()=>null),t=>t==='Waiting on you: Review Synthetic launch copy','the review waits in the digest',150);
  // Armed, then Approve: the task is done, and a later message sends nothing back.
  await digest.getByRole('button',{name:'Request changes',exact:true}).click();
  await until(()=>box.getAttribute('placeholder'),p=>p==='What should change?','armed for the review');
  await digest.getByRole('button',{name:'Approve',exact:true}).click();
  type Detail={tasks:{id:string;status:string}[];reviews:{taskId:string;decision:string}[]};
  await until(async()=>(await call<Detail>(h,'GET',`/api/projects/${h.project.id}`)).tasks.find(t=>t.id===task.id)?.status,s=>s==='done','the task is done');
  await until(()=>digest.count(),n=>n===0,'the digest goes after the review');
  await until(()=>box.getAttribute('placeholder'),p=>p==='Message to Synthetic chat project','the placeholder is back after the review');
  await box.fill('Synthetic thanks');
  await box.press('Enter');
  await until(()=>humanTexts(h,from),texts=>texts.includes('Synthetic thanks'),'the thanks is posted');
  await page.waitForTimeout(500);
  const detail=await call<Detail>(h,'GET',`/api/projects/${h.project.id}`);
  assert.equal(detail.tasks.find(t=>t.id===task.id)?.status,'done','still done');
  assert.deepEqual(detail.reviews.filter(r=>r.taskId===task.id).map(r=>r.decision),['approve'],'no request_changes');
},{canvas:true,flows:true});
