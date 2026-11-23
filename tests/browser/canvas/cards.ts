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
  const row=card.locator('.canvas-card-row[data-kind="agent"]');
  await card.locator('.canvas-card-row[data-state="working"]').waitFor();
  assert.deepEqual(navigations,[],'no reload');
  assert.equal(await card.locator(`[data-agent="${agentName}"]`).getAttribute('data-state'),'working','the face carries the state');
  assert.equal(await row.locator('.canvas-card-who').innerText(),agentName);
  assert.equal(await row.locator('.canvas-card-what').innerText(),'working','no progress line yet');
  await card.locator('.canvas-card-calm').getByText('Moving',{exact:true}).waitFor();
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
  const what=card.locator('.canvas-card-row[data-kind="agent"] .canvas-card-what');
  await what.getByText('quiet for 25 min',{exact:true}).waitFor();
  assert.equal(await card.locator('.canvas-card-row[data-kind="agent"]').getAttribute('data-state'),'quiet','elapsed time never reads as done');
  assert.equal(await card.locator('.canvas-card-zz').count(),1,'a quiet row shows z z instead of a dot');

  const held=h.holdNext('/api/messages');
  const nudge=card.locator('.canvas-card-foot').getByRole('button',{name:`Nudge ${agentName}`,exact:true});
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
  assert.notEqual(await card.locator('.canvas-card-row[data-kind="agent"]').getAttribute('data-state'),'done');

  // A tool event is a mid-turn signal from Pip (Ruling R13): the card is working again, and stays so across a refresh.
  await h.emit('tool.executed',{tool:'synthetic'},{source:`agent:${agentName}`,channelId:h.project.channelId});
  await card.locator('.canvas-card-row[data-kind="agent"][data-state="working"]').waitFor();
  const seed=(part:string)=>page.waitForResponse(r=>r.url().includes(part));
  const reseeded=Promise.all(['/api/events?typePrefix=agent.turn.','/api/events?type=message.created&order=desc&limit=500','/api/events?type=agent.lifecycle.started','/api/mentions'].map(seed));
  await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
  await reseeded;
  await page.waitForTimeout(500); // the refresh settles and publishes on the next frame
  assert.equal(await card.locator('.canvas-card-row[data-kind="agent"]').getAttribute('data-state'),'working','still working after a refresh');
  assert.equal(await what.getByText('quiet for',{exact:false}).count(),0);
},{canvas:true});

await runChatTest('canvas cards: posted files show as typed tiles on the card and in the chat, and compact zoom keeps only the title and faces',async h=>{
  const {page,base}=h;
  const id=await canvasWithChat(h);
  pipRunning(h);
  // Records every file tile that gets the pop (`is-new`), on this load and after a reload.
  await page.addInitScript(`window.__popped=[];new MutationObserver(()=>{for(const el of document.querySelectorAll('.canvas-file-tile.is-new')){const n=el.querySelector('.canvas-file-name')?.textContent;if(n&&!window.__popped.includes(n))window.__popped.push(n);}}).observe(document,{subtree:true,childList:true,attributes:true,attributeFilter:['class']});`);
  const popped=()=>page.evaluate(()=>(window as unknown as {__popped:string[]}).__popped);
  const card=await openCanvas(page,base,id,h.project.channelId);
  // Two older files, then the agent's report: a PDF, a spreadsheet with no specific type (as the agent upload tool
  // sends one) and a picture. A 264 px card has four slots: the three newest and +2.
  const older=await Promise.all(['synthetic-old-a.txt','synthetic-old-b.txt'].map(name=>h.upload(name,new TextEncoder().encode('Synthetic'),'text/plain')));
  const sent=await h.post('/api/messages',{id:crypto.randomUUID(),channelId:h.project.channelId,text:'Synthetic notes attached',mentions:[],
    attachments:older.map(({fileId},i)=>({fileId,name:`synthetic-old-${'ab'[i]}.txt`,mime:'text/plain'}))});
  assert.equal(sent.ok,true,`send: ${sent.status}`);
  const shot=await h.context.newPage();
  await shot.setContent('<div style="width:200px;height:120px;background:linear-gradient(90deg,#350956,#5dbc20)"></div>');
  const pngBytes=await shot.locator('div').screenshot();
  await shot.close();
  const pdf=await h.upload('Q3 report.pdf',new TextEncoder().encode('%PDF-1.4 synthetic'),'application/pdf');
  const xlsx=await h.upload('Q3 model.xlsx',new Uint8Array(5*1024),'application/octet-stream');
  const png=await h.upload('Q3 chart.png',pngBytes,'image/png');
  await h.emit('message.created',{text:'Synthetic Q3 report',attachments:[
    {fileId:pdf.fileId,name:'Q3 report.pdf',mime:'application/pdf',size:18},
    {fileId:xlsx.fileId,name:'Q3 model.xlsx',mime:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',size:5*1024},
    {fileId:png.fileId,name:'Q3 chart.png',mime:'image/png',size:pngBytes.length},
  ]},{source:`agent:${agentName}`});

  const files=card.getByRole('list',{name:'Files',exact:true});
  const more=files.getByRole('button',{name:'2 more files',exact:true});
  await more.waitFor();
  const tiles=files.locator('.canvas-file-tile:not(.is-more)');
  assert.deepEqual(await tiles.evaluateAll(els=>els.map(el=>el.getAttribute('data-kind'))),['doc','sheet','image'],'typed tiles, newest first');
  assert.equal(await more.innerText(),'+2');
  for(const [name,fileId,type] of [['Q3 report.pdf',pdf.fileId,'PDF'],['Q3 model.xlsx',xlsx.fileId,'Excel spreadsheet'],['Q3 chart.png',png.fileId,'Image']]){
    const tile=files.getByRole('link',{name,exact:true});
    assert.equal(await tile.getAttribute('href'),`/api/files/${encodeURIComponent(fileId)}`,`${name} opens its file`);
    assert.equal(await tile.getAttribute('title'),`${name} · ${type}`);
  }
  const preview=files.getByRole('link',{name:'Q3 chart.png',exact:true});
  const picture=preview.locator('img.canvas-file-preview');
  assert.equal(await picture.getAttribute('src'),`/api/files/${encodeURIComponent(png.fileId)}`,'the picture is its own preview');
  assert.equal(await picture.getAttribute('loading'),'lazy');
  for(let i=0;i<50&&!await picture.evaluate((img:HTMLImageElement)=>img.complete&&img.naturalWidth>0);i++)await new Promise(r=>setTimeout(r,100));
  assert.equal(await picture.evaluate((img:HTMLImageElement)=>img.naturalWidth>0),true,'the preview loads');
  assert.equal(await preview.locator('.canvas-file-glyph').isVisible(),false,'and its glyph steps aside');
  // Files that arrive while the canvas is open pop in once; the class leaves when the pop ends, so nothing replays.
  for(const name of ['Q3 report.pdf','Q3 model.xlsx','Q3 chart.png'])assert.ok((await popped()).includes(name),`${name} popped: ${await popped()}`);
  for(let i=0;i<50&&await files.locator('.canvas-file-tile.is-new').count()>0;i++)await new Promise(r=>setTimeout(r,100));
  assert.equal(await files.locator('.canvas-file-tile.is-new').count(),0,'the pop ends');
  const row=(await files.boundingBox())!,cardBox=(await card.boundingBox())!;
  assert.ok(row.x+row.width<=cardBox.x+cardBox.width,'the row stays inside the card');

  // The chat shows the same files as tiles named by file, type and size; no raw MIME type is printed anywhere.
  await more.click();
  const chat=page.locator('.canvas-chat');
  await chat.waitFor();
  const message=chat.locator('.message').filter({hasText:'Synthetic Q3 report'});
  const messageFiles=message.getByRole('list',{name:'Files',exact:true});
  await messageFiles.getByRole('link',{name:'Q3 model.xlsx, Excel spreadsheet, 5.0 KB',exact:true}).waitFor();
  await messageFiles.getByRole('link',{name:/^Q3 report\.pdf, PDF, \d+ B$/}).waitFor();
  assert.equal(await messageFiles.getByRole('link',{name:'Q3 model.xlsx, Excel spreadsheet, 5.0 KB',exact:true}).getAttribute('title'),'Excel spreadsheet · 5.0 KB');
  assert.equal(await message.locator('.message-attachments').count(),0,'no Attachments box');
  assert.equal(await page.getByText('application/vnd',{exact:false}).count(),0,'no raw MIME type in the page');
  await chat.getByRole('button',{name:'Close',exact:true}).click();
  await chat.waitFor({state:'detached'});
  const chip=files.getByRole('link',{name:'Q3 report.pdf',exact:true});

  const trigger=await h.emit('message.created',{text:'Synthetic trigger'},{source:'human:demo-owner'});
  await h.emit('agent.turn.started',{triggerEventId:trigger.id},{source:`agent:${agentName}`,channelId:h.project.channelId});
  const status=card.locator('.canvas-card-row[data-kind="agent"] .canvas-card-what');
  await card.locator('.canvas-card-row[data-kind="agent"][data-state="working"]').waitFor();

  const zoomOut=page.getByRole('button',{name:'Zoom out',exact:true});
  for(let i=0;i<4;i++)await zoomOut.click();
  await page.getByLabel('Zoom level',{exact:true}).getByText('41%',{exact:true}).waitFor();
  await status.waitFor({state:'hidden'});
  assert.equal(await card.locator('.canvas-card-title').isVisible(),true,'the title stays');
  assert.equal(await card.locator(`[data-agent="${agentName}"]`).isVisible(),true,'the faces stay');
  assert.equal(await chip.isVisible(),false,'the file tiles are hidden');
  const footWidth=(await card.locator('.canvas-card-foot').boundingBox())?.width??0;
  assert.ok(footWidth<=1,`the footer is clipped until it has focus: ${footWidth} px`);
  const face=await card.locator(`[data-agent="${agentName}"] .agent-portrait`).boundingBox();
  assert.ok(face&&Math.abs(face.width-40*0.41)<2,`40 px faces at compact zoom: ${face?.width}`);

  // Back from compact zoom the tiles show again without popping a second time.
  const zoomIn=page.getByRole('button',{name:'Zoom in',exact:true});
  for(let i=0;i<4;i++)await zoomIn.click();
  await chip.waitFor();
  assert.equal(await files.locator('.canvas-file-tile.is-new').count(),0,'back from compact zoom nothing pops again');

  // A cold open pops nothing: the files were there before the canvas mounted, however late the seed lands.
  await page.reload();
  await page.locator(`.canvas-card[data-channel-id="${h.project.channelId}"]`).getByRole('button',{name:'2 more files',exact:true}).waitFor();
  await new Promise(r=>setTimeout(r,1500));
  assert.deepEqual(await popped(),[],'no tile pops on a reload');
},{canvas:true});
