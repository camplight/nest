// Agents tray (Task 9, design batch D2): drag to invite, drag a face off to remove with Undo, pins, the All agents
// picker with live statuses and filters, and permission checks, on the real engine, API and WS. Synthetic data only.
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {Locator,Page} from 'playwright';
import {agentName,runChatTest,type ChatHarness} from '../support/chat-harness';

type Channel={id:string;participants?:{subscriberType:string;subscriberId:string}[]};

async function call<T>(h:ChatHarness,method:string,path:string,body?:unknown):Promise<T>{
  const response=await fetch(h.apiUrl+path,{method,headers:{cookie:h.cookie,'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
  if(!response.ok)throw Error(`${method} ${path}: ${response.status} ${await response.text()}`);
  return response.status===204?undefined as T:await response.json() as T;
}
/** The engine's membership as the owner reads it through the API, polled until it matches. */
async function engineHasPip(h:ChatHarness,channelId:string,expected:boolean){
  let has=!expected;
  for(let attempt=0;attempt<50&&has!==expected;attempt++){
    const channels=await call<Channel[]>(h,'GET','/api/channels');
    has=Boolean(channels.find(c=>c.id===channelId)?.participants?.some(p=>p.subscriberType==='AGENT'&&p.subscriberId===agentName));
    if(has!==expected)await new Promise(resolve=>setTimeout(resolve,100));
  }
  assert.equal(has,expected,`engine lists ${agentName} as an AGENT participant: ${expected}`);
}
/** The picker's rows, once they settle on exactly these agent names (order ignored). */
async function expectRows(rows:Locator,names:string[]){
  let seen:string[]=[];
  for(let attempt=0;attempt<50;attempt++){
    seen=(await rows.evaluateAll(list=>list.map(row=>row.getAttribute('data-agent')??''))).sort();
    if(seen.join('\n')===names.join('\n'))return;
    await new Promise(resolve=>setTimeout(resolve,100));
  }
  assert.deepEqual(seen,names);
}
/** Polls a condition from Node (a page-side waitForFunction with an async callback resolves at once). */
async function until<T>(read:()=>Promise<T>,ok:(value:T)=>boolean,what:string):Promise<T>{
  let value=await read();
  for(let attempt=0;attempt<50&&!ok(value);attempt++){await new Promise(resolve=>setTimeout(resolve,100));value=await read();}
  assert.ok(ok(value),`${what}: ${JSON.stringify(value)}`);
  return value;
}
/** The tray's pinned faces, in order, and whether the Pinned label leads them. */
const pinnedTray=(tray:Locator)=>tray.evaluate(section=>({
  label:section.querySelector('.canvas-tray-label')?.textContent??null,
  afterLabel:section.querySelector('.canvas-tray-label')?.nextElementSibling?.getAttribute('data-group')??null,
  names:[...section.querySelectorAll('[data-group="pinned"] [data-agent]')].map(face=>face.getAttribute('data-agent')),
}));
/** Pip running and heartbeating now, with a turn open in the chat. */
async function startTurn(h:ChatHarness,channelId:string){
  const trigger=await h.emit('message.created',{text:'Synthetic trigger'},{source:'human:demo-owner',channelId});
  await h.emit('agent.turn.started',{triggerEventId:trigger.id},{source:`agent:${agentName}`,channelId});
  const at=Date.now();
  h.engineDb.prepare("UPDATE agents SET desired_state='RUNNING', runtime_state='RUNNING', last_heartbeat_at=?, updated_at=? WHERE name=?").run(at,at,agentName);
}
async function canvasWith(h:ChatHarness,cards:{channelId:string;x:number;y:number}[],areas:{title:string;x:number;y:number;w:number;h:number}[]=[]){
  const {id}=await call<{id:string}>(h,'POST','/api/canvases',{id:crypto.randomUUID(),name:'Agents board'});
  await call(h,'POST',`/api/canvases/${id}/cards`,{cards});
  for(const area of areas)await call(h,'POST',`/api/canvases/${id}/areas`,{id:crypto.randomUUID(),...area});
  return id;
}
const plainChat=async(h:ChatHarness,name:string)=>(await call<{id:string}>(h,'POST','/api/channels',{name,visibility:'PRIVATE'})).id;
const cardAt=(page:Page,channelId:string)=>page.locator(`.canvas-card[data-channel-id="${channelId}"]`);
async function openCanvas(page:Page,base:string,id:string){
  await page.goto(`${base}/?view=canvas&canvas=${id}`);
  await page.locator('.canvas-card').first().waitFor();
}
async function centre(locator:Locator){const b=await locator.boundingBox();assert.ok(b);return {x:b.x+b.width/2,y:b.y+b.height/2,box:b};}
/** A point `gap` px outside the card, on whichever side has the most room on the surface. */
async function beside(page:Page,card:Locator,from:{x:number;y:number},gap:number){
  const c=(await centre(card)).box,s=(await centre(page.locator('.canvas-surface'))).box;
  const room={left:c.x-s.x,right:s.x+s.width-(c.x+c.width),below:s.y+s.height-(c.y+c.height)};
  const side=(Object.keys(room) as (keyof typeof room)[]).reduce((a,b)=>room[b]>room[a]?b:a);
  assert.ok(room[side]>gap+10,`room beside the card: ${JSON.stringify(room)}`);
  return side==='left'?{x:c.x-gap,y:from.y}:side==='right'?{x:c.x+c.width+gap,y:from.y}:{x:from.x,y:c.y+c.height+gap};
}
/** A pointer drag in small steps, as a person would. */
async function drag(page:Page,from:{x:number;y:number},to:{x:number;y:number}){
  await page.mouse.move(from.x,from.y);
  await page.mouse.down();
  await page.mouse.move((from.x+to.x)/2,(from.y+to.y)/2,{steps:5});
  await page.mouse.move(to.x,to.y,{steps:5});
  await page.mouse.up();
}

await runChatTest('canvas agents: drag Pip onto a card to invite, drag the face off to remove, Undo restores',async h=>{
  const {page,base}=h;
  const channelId=await plainChat(h,'Synthetic plain room');
  const id=await canvasWith(h,[{channelId,x:120,y:120}]);
  await openCanvas(page,base,id);
  const card=cardAt(page,channelId);
  assert.equal(await card.locator(`[data-agent="${agentName}"]`).count(),0,'not in the chat yet');

  const tray=page.getByRole('region',{name:'Agents',exact:true});
  const trayPip=tray.locator(`[data-agent="${agentName}"]`);
  assert.equal(await trayPip.getAttribute('draggable'),'true');
  await trayPip.dragTo(card);
  const face=card.locator(`[data-agent="${agentName}"]`);
  await face.waitFor();
  await engineHasPip(h,channelId,true);

  // A face dropped within 80 px of its card stays.
  const start=await centre(face);
  assert.equal(await face.getAttribute('data-drag'),'face','a manager can drag the face');
  const unsubscribes:string[]=[];
  page.on('request',request=>{if(request.url().includes('/unsubscribe'))unsubscribes.push(request.url());});
  await drag(page,start,await beside(page,card,start,40));
  await page.waitForTimeout(300);
  assert.equal(unsubscribes.length,0,'a short drag removes nobody');
  assert.equal(await face.count(),1);

  // More than 80 px outside the card removes them, with Undo.
  await drag(page,start,await beside(page,card,start,140));
  const toast=page.getByRole('status').filter({hasText:`Removed ${agentName}`});
  await toast.waitFor();
  await face.waitFor({state:'detached'});
  await engineHasPip(h,channelId,false);
  await toast.getByRole('button',{name:'Undo',exact:true}).click();
  await face.waitFor();
  await engineHasPip(h,channelId,true);
},{canvas:true});

await runChatTest('canvas agents: All agents finds Pip, filters by owner and area, and 30 agents keep the tray at the pin limit',async h=>{
  const {page,base}=h;
  const workspace=mkdtempSync(join(tmpdir(),'nest-canvas-agents-'));
  // Pip plus 29 synthetic helpers: 30 agents. No helper name contains a "p" before an "i", so "pi" finds only Pip.
  for(let n=1;n<=29;n++)await call(h,'POST','/api/agents',{name:`Helper ${String(n).padStart(2,'0')}`,modelId:'test',workspacePath:join(workspace,String(n))});
  const plain=await plainChat(h,'Synthetic plain room');
  // Both chats sit in the Review area; only the project chat has Pip.
  const id=await canvasWith(h,[{channelId:h.project.channelId,x:140,y:140},{channelId:plain,x:560,y:140}],[{title:'Review',x:80,y:80,w:860,h:400}]);
  await openCanvas(page,base,id);

  // The engine makes the creating human an agent's owner, public or private, so the seed, the owner groups and
  // the Yours chip follow the engine's ownerHumanId: Yours first, everyone else's under their owner's team.
  const agents=await call<{name:string;ownerHumanId:string|null}[]>(h,'GET','/api/agents');
  const me=agents.find(agent=>agent.name==='Helper 01')!.ownerHumanId;
  assert.ok(me,'the creating human owns the agents it created');
  const byName=(a:string,b:string)=>a.localeCompare(b);
  const yours=agents.filter(agent=>agent.ownerHumanId===me).map(agent=>agent.name).sort(byName);
  const team=agents.filter(agent=>agent.ownerHumanId!==me).map(agent=>agent.name).sort(byName);
  assert.ok(yours.includes('Helper 01'),'agents this human created are yours');

  // Before any pins the tray seeds exactly 7: own agents by name, then the team's.
  const tray=page.getByRole('region',{name:'Agents',exact:true});
  const seed=[...yours,...team].slice(0,7);
  const seeded=await until(()=>pinnedTray(tray),tray=>tray.names.join()===seed.join(),'the seeded tray');
  assert.equal(seeded.label,'Pinned');
  const all=tray.getByRole('button',{name:'All 30 agents',exact:true});
  assert.equal(await all.innerText(),'All 30');
  await all.click();
  const picker=page.getByRole('dialog',{name:'All agents',exact:true});
  await picker.waitFor();
  const rows=picker.locator('[data-agent]');
  await rows.first().waitFor();
  assert.equal(await rows.count(),30,'the picker lists every agent');

  await expectRows(picker.getByRole('region',{name:'Yours',exact:true}).locator('[data-agent]'),[...yours].sort());
  await expectRows(picker.locator('.canvas-picker-group:not([aria-label="Yours"]) [data-agent]'),[...team].sort());
  // Headings: Yours · n first, then `{owner}'s team · n` (or `Team · n` without an owner), by label.
  const humans=await call<{id:string;username:string}[]>(h,'GET','/api/humans');
  const teamCounts=new Map<string,number>();
  for(const agent of agents.filter(agent=>agent.ownerHumanId!==me)){
    const owner=humans.find(person=>person.id===agent.ownerHumanId)?.username;
    const label=owner?`${owner}'s team`:'Team';
    teamCounts.set(label,(teamCounts.get(label)??0)+1);
  }
  const headings=[`Yours · ${yours.length}`,...[...teamCounts].sort(([a],[b])=>a.localeCompare(b)).map(([label,n])=>`${label} · ${n}`)];
  assert.deepEqual(await picker.locator('.canvas-picker-group-head').evaluateAll(list=>list.map(head=>head.textContent)),headings);
  const chip=(label:string)=>picker.getByRole('button',{name:label,exact:true});
  await chip('Yours').click();
  assert.equal(await chip('Yours').getAttribute('aria-pressed'),'true');
  await expectRows(rows,[...yours].sort());
  // Nobody is working: Working shows the empty state.
  await chip('Working').click();
  await picker.getByText('No agents match.',{exact:true}).waitFor();
  assert.equal(await rows.count(),0);
  await chip('All').click();
  await expectRows(rows,[...agents.map(agent=>agent.name)].sort());

  await picker.getByLabel('Area',{exact:true}).selectOption({label:'Review'});
  assert.deepEqual(await rows.evaluateAll(list=>list.map(row=>row.getAttribute('data-agent'))),[agentName],'only agents in that area\'s cards');
  await picker.getByLabel('Area',{exact:true}).selectOption({label:'All areas'});

  await picker.getByRole('searchbox',{name:'Search agents',exact:true}).fill('pi');
  await picker.locator(`[data-agent="${agentName}"]`).waitFor();
  assert.equal(await rows.first().getAttribute('data-agent'),agentName,'Pip ranks first for "pi"');

  // Selecting the plain card puts Review's agents (Pip) first in the tray as a suggestion.
  await page.keyboard.press('Escape');
  await picker.waitFor({state:'detached'});
  const plainCard=cardAt(page,plain);
  const head=(await centre(plainCard.locator('.canvas-card-title'))).box;
  await page.mouse.click(head.x+4,head.y+4);
  // A click opens the chat; close it so the card stays selected.
  await page.getByRole('button',{name:'Close',exact:true}).click();
  await tray.getByText('Suggested for this chat',{exact:true}).waitFor();
  assert.equal(await tray.getByText('Pinned',{exact:true}).count(),0,'the Pinned label gives way to suggestions');
  assert.equal(await tray.locator('[data-agent]').first().getAttribute('data-agent'),agentName);
},{canvas:true});

await runChatTest('canvas agents: faces on a chat you cannot manage do not drag, and a drop there is refused',async h=>{
  const {page,base}=h;
  const channelId=await plainChat(h,'Synthetic owner room');
  const locked=await plainChat(h,'Synthetic locked room');
  const id=await canvasWith(h,[{channelId,x:120,y:120},{channelId:locked,x:520,y:120}]);
  const mate=await h.loginAs('mate');
  // The mate is a member of the owner's private chat, so can read it but not manage it.
  await call(h,'POST',`/api/channels/${channelId}/subscribe`,{subscriberType:'HUMAN',subscriberId:'mate'});
  await call(h,'POST',`/api/channels/${channelId}/subscribe`,{subscriberType:'AGENT',subscriberId:agentName});
  const humans=await call<{id:string;username:string}[]>(h,'GET','/api/humans');
  const mateId=humans.find(person=>person.username==='mate')!.id;
  const {canvas}=await call<{canvas:{version:number}}>(h,'GET',`/api/canvases/${id}/board`);
  await call(h,'PUT',`/api/canvases/${id}/members`,{visibility:'shared',members:[{humanId:mateId,role:'edit'}],version:canvas.version});

  await openCanvas(mate.page,base,id);
  const card=cardAt(mate.page,channelId);
  const face=card.locator(`[data-agent="${agentName}"]`);
  await face.waitFor();
  assert.equal(await face.getAttribute('data-drag'),null,'no drag handle on a face the mate cannot remove');
  await cardAt(mate.page,locked).and(mate.page.locator('[data-access="locked"]')).waitFor();

  const requests:string[]=[];
  mate.page.on('request',request=>{if(/\/(subscribe|unsubscribe|members)$/.test(new URL(request.url()).pathname))requests.push(request.url());});
  const tray=mate.page.getByRole('region',{name:'Agents',exact:true});
  await tray.getByRole('button',{name:/^All \d+ agents$/}).click();
  const picker=mate.page.getByRole('dialog',{name:'All agents',exact:true});
  const pip=picker.locator(`[data-agent="${agentName}"]`);
  await pip.dragTo(card);
  await mate.page.getByRole('status').filter({hasText:'You can\'t add people to this chat'}).waitFor();
  // A locked card is no drop target at all.
  await pip.dragTo(cardAt(mate.page,locked));
  await mate.page.keyboard.press('Escape');
  await picker.waitFor({state:'detached'});
  // Dragging the face away removes nobody (at most it moves the card, as a press anywhere on it would).
  const start=await centre(face);
  await drag(mate.page,start,await beside(mate.page,card,start,140));
  await mate.page.waitForTimeout(300);
  assert.deepEqual(requests,[],'no membership request for a chat the mate cannot manage');
  await engineHasPip(h,channelId,true);
},{canvas:true});

await runChatTest('canvas agents: stars pin agents to the tray across reloads, up to 7, and rows say who is free or working',async h=>{
  const {page,base}=h;
  const workspace=mkdtempSync(join(tmpdir(),'nest-canvas-pins-'));
  // Pip plus 7 synthetic helpers: 8 agents, one more than the pin limit.
  const helpers=Array.from({length:7},(_,n)=>`Helper ${String(n+1).padStart(2,'0')}`);
  // Helper 01 has a role, so the search can find it by role.
  for(const name of helpers)await call(h,'POST','/api/agents',{name,modelId:'test',workspacePath:join(workspace,name),...(name==='Helper 01'?{description:'Synthetic zephyrology'}:{})});
  const plain=await plainChat(h,'Synthetic plain room');
  const id=await canvasWith(h,[{channelId:h.project.channelId,x:140,y:140},{channelId:plain,x:560,y:140}]);
  await openCanvas(page,base,id);
  const tray=page.getByRole('region',{name:'Agents',exact:true});
  const pinsSaved=()=>call<{agentNames:string[];saved:boolean}>(h,'GET','/api/canvases/agent-pins');

  // Nothing saved yet: the tray seeds 7 of the 8 agents under the Pinned label.
  const seeded=(await until(()=>pinnedTray(tray),tray=>tray.names.length===7,'the seeded tray')) as {label:string|null;names:string[]};
  assert.equal(seeded.label,'Pinned');
  assert.deepEqual(await pinsSaved(),{agentNames:[],saved:false});
  const outside=[agentName,...helpers].find(name=>!seeded.names.includes(name))!;

  await tray.getByRole('button',{name:'All 8 agents',exact:true}).click();
  const picker=page.getByRole('dialog',{name:'All agents',exact:true});
  await picker.getByRole('heading',{name:'Agents · 8',exact:true}).waitFor();
  await picker.getByText('Drag any agent onto a chat · ☆ pins it to the tray',{exact:true}).waitFor();
  assert.equal(await picker.getByRole('searchbox',{name:'Search agents',exact:true}).getAttribute('placeholder'),'Search by name, role or owner');
  const row=(name:string)=>picker.locator(`.canvas-picker-row[data-agent="${name}"]`);
  const status=(name:string)=>row(name).locator('.canvas-picker-status');
  assert.equal(await status(agentName).innerText(),'free');
  // One constant name per star; aria-pressed carries the state, and the seeded agents count as pinned.
  const star=(name:string)=>picker.getByRole('button',{name:`Pin ${name} to tray`,exact:true});
  for(const name of seeded.names)assert.equal(await star(name).getAttribute('aria-pressed'),'true',`${name} is seeded as pinned`);
  assert.equal(await star(outside).getAttribute('aria-pressed'),'false');
  assert.equal(await star(outside).getAttribute('title'),'Pin to tray');
  assert.equal(await star(seeded.names[0]).getAttribute('title'),'Unpin');

  // Seven seeded: an eighth is refused with the notice, and nothing is saved.
  await star(outside).click();
  await page.getByRole('status').filter({hasText:'You can pin up to 7 agents. Unpin one first.'}).waitFor();
  assert.equal(await star(outside).getAttribute('aria-pressed'),'false');
  assert.deepEqual(await pinsSaved(),{agentNames:[],saved:false});

  // The first unstar saves the seed without that agent: the tray keeps the other six, never one face.
  const dropped=seeded.names[2],kept=seeded.names.filter(name=>name!==dropped);
  await star(dropped).click();
  assert.equal(await star(dropped).getAttribute('aria-pressed'),'false');
  await until(()=>pinnedTray(tray),tray=>tray.names.join()===kept.join()&&tray.afterLabel==='pinned','the seed minus one after the label');
  await until(pinsSaved,pins=>pins.saved&&pins.agentNames.join()===kept.join(),'the seed minus one saved');

  // Starring appends after the Pinned label's existing faces; unstarring takes it out again.
  await star(outside).click();
  assert.equal(await star(outside).getAttribute('aria-pressed'),'true');
  const order=[...kept,outside];
  await until(()=>pinnedTray(tray),tray=>tray.names.join()===order.join(),`${outside} appended`);
  await until(pinsSaved,pins=>pins.agentNames.join()===order.join(),`${outside} saved`);
  await star(outside).click();
  await until(()=>pinnedTray(tray),tray=>tray.names.join()===kept.join(),`${outside} unpinned`);
  await star(outside).click();
  await until(pinsSaved,pins=>pins.agentNames.join()===order.join(),`${outside} pinned again`);

  // Two quick presses with no wait between them: saves go one at a time, so the server ends on the newest list.
  const unstarred=kept[0],final=[...order.filter(name=>name!==unstarred),dropped];
  await star(unstarred).click();
  await star(dropped).click();
  await until(pinsSaved,pins=>pins.agentNames.join()===final.join(),'the newest list saved after two quick presses');

  // Pins survive a reload, in their order, with their stars.
  await page.reload();
  await page.locator('.canvas-card').first().waitFor();
  await until(()=>pinnedTray(tray),tray=>tray.names.join()===final.join(),'pins after reload');
  await tray.getByRole('button',{name:'All 8 agents',exact:true}).click();
  await until(()=>star(dropped).getAttribute('aria-pressed'),pressed=>pressed==='true',`${dropped} starred after reload`);
  assert.equal(await star(unstarred).getAttribute('aria-pressed'),'false');

  // Pip starts working on the placed project chat: its row says so, and the chips split working from free.
  await startTurn(h,h.project.channelId);
  await until(()=>status(agentName).innerText(),text=>text==='in 1 chat','Pip\'s status');
  assert.match(await status(agentName).getAttribute('class')??'',/is-busy/);
  assert.equal(await status('Helper 01').innerText(),'free');
  const rows=picker.locator('.canvas-picker-row');
  await picker.getByRole('button',{name:'Working',exact:true}).click();
  await expectRows(rows,[agentName]);
  await picker.getByRole('button',{name:'Free now',exact:true}).click();
  await expectRows(rows,[...helpers].sort());
  await picker.getByRole('button',{name:'All',exact:true}).click();
  await expectRows(rows,[agentName,...helpers].sort());

  // Search finds an agent by its role, not only its name.
  await picker.getByRole('searchbox',{name:'Search agents',exact:true}).fill('zephyr');
  await expectRows(rows,['Helper 01']);
},{canvas:true});
