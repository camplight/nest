// Agents tray (Task 9): drag to invite, drag a face off to remove with Undo, the All agents picker and
// permission checks, on the real engine, API and WS. Synthetic data only.
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

await runChatTest('canvas agents: All agents finds Pip, filters by owner and area, and 30 agents keep the tray at 8',async h=>{
  const {page,base}=h;
  const workspace=mkdtempSync(join(tmpdir(),'nest-canvas-agents-'));
  // Pip plus 29 synthetic helpers: 30 agents. No helper name contains a "p" before an "i", so "pi" finds only Pip.
  for(let n=1;n<=29;n++)await call(h,'POST','/api/agents',{name:`Helper ${String(n).padStart(2,'0')}`,modelId:'test',workspacePath:join(workspace,String(n))});
  const plain=await plainChat(h,'Synthetic plain room');
  // Both chats sit in the Review area; only the project chat has Pip.
  const id=await canvasWith(h,[{channelId:h.project.channelId,x:140,y:140},{channelId:plain,x:560,y:140}],[{title:'Review',x:80,y:80,w:860,h:400}]);
  await openCanvas(page,base,id);

  const tray=page.getByRole('region',{name:'Agents',exact:true});
  await tray.locator('[data-agent]').first().waitFor();
  const faces=await tray.locator('[data-agent]').count();
  assert.ok(faces>0&&faces<=8,`the tray shows at most 8 faces: ${faces}`);
  await tray.getByRole('button',{name:'All agents (30)',exact:true}).click();
  const picker=page.getByRole('dialog',{name:'All agents',exact:true});
  await picker.waitFor();
  const rows=picker.locator('[data-agent]');
  await rows.first().waitFor();
  assert.equal(await rows.count(),30,'the picker lists every agent');

  // The engine gives only private agents an owner: these 30 public agents are all the team's.
  await picker.getByRole('radio',{name:'Yours',exact:true}).check();
  await picker.getByText('No agents match.',{exact:true}).waitFor();
  await picker.getByRole('radio',{name:'Team',exact:true}).check();
  assert.equal(await rows.count(),30);

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
  await tray.getByText('Suggested for Synthetic plain room',{exact:true}).waitFor();
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
  await tray.getByRole('button',{name:/^All agents \(\d+\)$/}).click();
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
