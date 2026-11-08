// Live cards (Task 6): status, quiet and Nudge, artifacts and compact zoom on the real engine, API and WS. Synthetic data.
import assert from 'node:assert/strict';
import type {Page} from 'playwright';
import {agentName,runChatTest,type ChatHarness} from '../support/chat-harness';

type EventRow={id:string;type:string;source:string;createdAt:number;channelId?:string;payload?:Record<string,unknown>};

async function call<T>(h:ChatHarness,method:string,path:string,body?:unknown):Promise<T>{
  const response=await fetch(h.apiUrl+path,{method,headers:{cookie:h.cookie,'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
  if(!response.ok)throw Error(`${method} ${path}: ${response.status} ${await response.text()}`);
  return response.status===204?undefined as T:await response.json() as T;
}
/** A canvas holding the harness project's chat, which has Pip as its agent. */
async function canvasWithChat(h:ChatHarness){
  const {id}=await call<{id:string}>(h,'POST','/api/canvases',{id:crypto.randomUUID(),name:'Live launch'});
  await call(h,'POST',`/api/canvases/${id}/cards`,{cards:[{channelId:h.project.channelId,x:120,y:120}]});
  return id;
}
async function openCanvas(page:Page,base:string,id:string,channelId:string){
  await page.goto(`${base}/?view=canvas&canvas=${id}`);
  const card=page.locator(`.canvas-card[data-channel-id="${channelId}"]`);
  await card.waitFor();
  return card;
}
/** The runner's view of Pip: running and heartbeating now, so a turn begun earlier is still live (Ruling R5). */
function pipRunning(h:ChatHarness){
  const at=Date.now();
  h.engineDb.prepare("UPDATE agents SET desired_state='RUNNING', runtime_state='RUNNING', last_heartbeat_at=?, updated_at=? WHERE name=?").run(at,at,agentName);
}

await runChatTest('canvas cards: a started turn shows working without a reload',async h=>{
  const {page,base}=h;
  const id=await canvasWithChat(h);
  pipRunning(h);
  const card=await openCanvas(page,base,id,h.project.channelId);
  await card.locator(`[data-agent="${agentName}"]`).waitFor();
  const navigations:string[]=[];
  page.on('framenavigated',frame=>{if(frame===page.mainFrame())navigations.push(frame.url());});
  const trigger=await h.emit('message.created',{text:'Synthetic trigger'},{source:'human:demo-owner'});
  await h.emit('agent.turn.started',{triggerEventId:trigger.id},{source:`agent:${agentName}`,channelId:h.project.channelId});
  await card.getByText(`${agentName} is working`,{exact:true}).waitFor();
  assert.deepEqual(navigations,[],'no reload');
  assert.equal(await card.locator(`[data-agent="${agentName}"]`).getAttribute('data-state'),'working','the face carries the state dot');
},{canvas:true});

await runChatTest('canvas cards: a 25 minute old turn reads quiet, never done, and Nudge posts a targeted message',async h=>{
  const {page,base}=h;
  const id=await canvasWithChat(h);
  // Fixture: a turn that began 25 minutes ago with no later agent signal, while Pip keeps running.
  const trigger=await h.emit('message.created',{text:'Synthetic trigger'},{source:'human:demo-owner'});
  const turn=await h.emit('agent.turn.started',{triggerEventId:trigger.id},{source:`agent:${agentName}`,channelId:h.project.channelId});
  const began=Date.now()-25*60_000-5_000;
  h.engineDb.prepare('UPDATE events SET created_at=? WHERE id IN (?,?)').run(began,trigger.id,turn.id);
  pipRunning(h);
  const agent=h.engineDb.prepare('SELECT desired_state AS desired, runtime_state AS runtime, updated_at AS updated FROM agents WHERE name=?').get(agentName) as {desired:string;runtime:string;updated:number};
  assert.equal(agent.desired,'RUNNING','not stopped, so activeTurns keeps the turn');
  assert.ok(agent.updated>began);

  const card=await openCanvas(page,base,id,h.project.channelId);
  await card.getByText(`${agentName} quiet for 25 min`,{exact:true}).waitFor();
  assert.equal(await card.getByText('Done',{exact:true}).count(),0,'elapsed time never reads as done');

  const held=h.holdNext('/api/messages');
  const nudge=card.getByRole('button',{name:`Nudge ${agentName}`,exact:true});
  await nudge.click();
  await held.started;
  assert.equal(await nudge.isDisabled(),true,'disabled while the request is in flight');
  held.release();
  let found:EventRow|undefined;
  for(let attempt=0;attempt<50&&!found;attempt++){
    const events=await call<EventRow[]>(h,'GET',`/api/events?type=message.created&channelId=${h.project.channelId}&order=desc&limit=20`);
    found=events.find(event=>event.payload?.targetAgentName===agentName);
    if(!found)await new Promise(resolve=>setTimeout(resolve,100));
  }
  assert.ok(found,'the nudge reached the engine as a targeted message');
  assert.equal(found.payload?.text,`@${agentName} are you still on this? Please post a short status update.`);
  assert.equal(found.source,'human:demo-owner');
  await nudge.and(page.locator(':enabled')).waitFor();
  assert.equal(await card.getByText('Done',{exact:true}).count(),0);

  // A tool event is a mid-turn signal from Pip (Ruling R13): the card is working again, and stays so across a refresh.
  await h.emit('tool.executed',{tool:'synthetic'},{source:`agent:${agentName}`,channelId:h.project.channelId});
  await card.getByText(`${agentName} is working`,{exact:true}).waitFor();
  const seed=(part:string)=>page.waitForResponse(r=>r.url().includes(part));
  const reseeded=Promise.all(['/api/events?typePrefix=agent.turn.','/api/events?type=message.created&order=desc&limit=500','/api/events?type=agent.lifecycle.started','/api/mentions'].map(seed));
  await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
  await reseeded;
  await page.waitForTimeout(500); // the refresh settles and publishes on the next frame
  assert.equal(await card.getByText(`${agentName} is working`,{exact:true}).count(),1,'still working after a refresh');
  assert.equal(await card.getByText(`${agentName} quiet for`,{exact:false}).count(),0);
},{canvas:true});

await runChatTest('canvas cards: an uploaded file shows as a chip, and compact zoom keeps only the title and faces',async h=>{
  const {page,base}=h;
  const id=await canvasWithChat(h);
  pipRunning(h);
  const card=await openCanvas(page,base,id,h.project.channelId);
  const {fileId}=await h.upload('synthetic-brief.txt',new TextEncoder().encode('Synthetic brief'),'text/plain');
  const sent=await h.post('/api/messages',{id:crypto.randomUUID(),channelId:h.project.channelId,text:'Synthetic brief attached',mentions:[],attachments:[{fileId,name:'synthetic-brief.txt',mime:'text/plain'}]});
  assert.equal(sent.ok,true,`send: ${sent.status}`);
  const chip=card.getByRole('link',{name:'synthetic-brief.txt',exact:true});
  await chip.waitFor();
  assert.equal(await chip.getAttribute('href'),`/api/files/${encodeURIComponent(fileId)}`,'the chip opens the existing file link');

  const trigger=await h.emit('message.created',{text:'Synthetic trigger'},{source:'human:demo-owner'});
  await h.emit('agent.turn.started',{triggerEventId:trigger.id},{source:`agent:${agentName}`,channelId:h.project.channelId});
  const status=card.locator('.canvas-card-status');
  await status.getByText(`${agentName} is working`,{exact:true}).waitFor();

  const zoomOut=page.getByRole('button',{name:'Zoom out',exact:true});
  for(let i=0;i<4;i++)await zoomOut.click();
  await page.getByLabel('Zoom level',{exact:true}).getByText('41%',{exact:true}).waitFor();
  await status.waitFor({state:'hidden'});
  assert.equal(await card.locator('.canvas-card-title').isVisible(),true,'the title stays');
  assert.equal(await card.locator(`[data-agent="${agentName}"]`).isVisible(),true,'the faces stay');
  assert.equal(await chip.isVisible(),false,'the artifact strip is hidden');
},{canvas:true});
