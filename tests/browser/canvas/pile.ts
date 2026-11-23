// Loose chats (the top-bar toggle and its drawer) and the bottom box (Task 7) on the real engine, API and WS. Synthetic data.
import assert from 'node:assert/strict';
import type {Page} from 'playwright';
import {agentName,runChatTest,type ChatHarness} from '../support/chat-harness';

type Board={areas:{id:string;title:string;x:number;y:number;w:number;h:number}[];cards:{channelId:string;x:number;y:number;w:number}[]};
type Channel={id:string;archivedAt?:number|null};

async function call<T>(h:ChatHarness,method:string,path:string,body?:unknown):Promise<T>{
  const response=await fetch(h.apiUrl+path,{method,headers:{cookie:h.cookie,'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
  if(!response.ok)throw Error(`${method} ${path}: ${response.status} ${await response.text()}`);
  return response.status===204?undefined as T:await response.json() as T;
}
const board=(h:ChatHarness,id:string)=>call<Board>(h,'GET',`/api/canvases/${id}/board`);
/** Synthetic project chats through the product API, ten at a time. Every 20th is about invoices. */
async function seedChats(h:ChatHarness,count:number){
  const created:{name:string;channelId:string}[]=[];
  for(let start=0;start<count;start+=10){
    const batch=Array.from({length:Math.min(10,count-start)},(_,i)=>start+i);
    created.push(...await Promise.all(batch.map(async i=>{
      const name=i%20===0?`Synthetic invoice chat ${i}`:`Synthetic chat ${i}`;
      const project=await call<{channelId:string}>(h,'POST','/api/projects',{id:crypto.randomUUID(),name,description:'Synthetic test project',members:[]});
      return {name,channelId:project.channelId};
    })));
  }
  return created;
}
/** A canvas holding only the harness project's chat, so every seeded chat is loose. */
async function canvasWithHarnessChat(h:ChatHarness){
  const {id}=await call<{id:string}>(h,'POST','/api/canvases',{id:crypto.randomUUID(),name:'Pile launch'});
  await call(h,'POST',`/api/canvases/${id}/cards`,{cards:[{channelId:h.project.channelId,x:0,y:0}]});
  return id;
}
const pileOf=(page:Page)=>page.getByRole('complementary',{name:'Loose chats',exact:true});
const toggleOf=(page:Page)=>page.locator('.canvas-loose-button');
/** The top-bar count, once it reads `n`. */
const countIs=(page:Page,n:number)=>toggleOf(page).locator('.canvas-loose-count').getByText(String(n),{exact:true}).waitFor();
/** Opens the drawer from the top bar (it starts closed). */
async function openDrawer(page:Page){
  if(await pileOf(page).count())return;
  await toggleOf(page).click();
  await pileOf(page).waitFor();
}
async function openCanvas(page:Page,base:string,id:string,drawer=true){
  await page.goto(`${base}/?view=canvas&canvas=${id}`);
  await page.locator('.canvas-surface .canvas-world').waitFor({state:'attached'});
  await toggleOf(page).waitFor();
  if(drawer)await openDrawer(page);
}
const rowFor=(page:Page,title:string)=>pileOf(page).locator('.canvas-drawer-row').filter({has:page.getByRole('checkbox',{name:`Select ${title}`,exact:true})});
/** Waits (polling from Node) until the drawer holds exactly `n` rows. */
async function rowsAre(page:Page,n:number,what='rows in the drawer'){
  let count=-1;
  for(let i=0;i<100&&count!==n;i++){count=await page.locator('.canvas-drawer-row').count();if(count!==n)await page.waitForTimeout(100);}
  assert.equal(count,n,what);
}
const inside=(area:Board['areas'][number],card:Board['cards'][number])=>{
  const cx=card.x+card.w/2,cy=card.y+80;
  return cx>=area.x&&cx<=area.x+area.w&&cy>=area.y&&cy<=area.y+area.h;
};

await runChatTest('canvas pile: 220 loose chats stay windowed, search, new area, archive and the bottom box',async h=>{
  const {page,base}=h;
  const seeded=await seedChats(h,220);
  const id=await canvasWithHarnessChat(h);
  await openCanvas(page,base,id,false);
  // The top bar's toggle carries the count; the drawer starts closed.
  await countIs(page,220);
  assert.equal(await toggleOf(page).getAttribute('title'),'Plain chats that aren\'t on the canvas yet');
  assert.equal(await toggleOf(page).locator('.canvas-loose-count').getAttribute('data-hot'),null,'nothing needs you, so the count is not coral');
  assert.equal(await pileOf(page).count(),0,'closed until asked for');
  await openDrawer(page);
  const pile=pileOf(page);
  await pile.getByRole('heading',{name:'Loose chats · 220',exact:true}).waitFor();
  await pile.locator('.canvas-drawer-group').getByText('Today · 220',{exact:true}).waitFor();
  const rows=pile.locator('.canvas-drawer-row');
  await rows.first().waitFor();
  const mounted=await rows.count();
  assert.ok(mounted>0&&mounted<40,`a windowed list: ${mounted} rows in the DOM`);
  assert.equal(await rowFor(page,'Synthetic chat project').count(),0,'a chat on this canvas is not loose');

  // Search narrows the list.
  const search=pile.getByRole('searchbox',{name:'Search loose chats',exact:true});
  assert.equal(await search.getAttribute('placeholder'),'Search loose chats');
  assert.equal(await search.evaluate(el=>document.activeElement===el),true,'opening from the toggle focuses the search');
  await search.fill('invoice');
  await rowsAre(page,11);
  for(const text of await rows.locator('.canvas-drawer-title').allTextContents())assert.match(text,/invoice/i);

  // Three selected, then one area around them in one placeCards call.
  const picks=seeded.filter(c=>c.name.includes('invoice')).slice(0,3);
  for(const pick of picks)await rowFor(page,pick.name).getByRole('checkbox').check();
  const placed=page.waitForResponse(r=>r.request().method()==='POST'&&r.url().endsWith(`/api/canvases/${id}/cards`));
  await pile.getByRole('button',{name:'New area from these',exact:true}).click();
  assert.equal((await placed).ok(),true);
  const body=JSON.parse((await placed).request().postData()!) as {cards:unknown[];area?:{title:string}};
  assert.equal(body.cards.length,3);assert.equal(body.area?.title,'New area');
  await page.locator('[aria-label="Area New area"]').waitFor();
  // The new area is framed with its title open for typing (the mock's areaFromChats), and the toast says what to do next.
  await page.locator('.canvas-notice').getByText('New area with 3 chats. Rename it, and add context they should all share.',{exact:true}).waitFor();
  const areaTitle=page.getByRole('textbox',{name:'Area title',exact:true});
  await areaTitle.waitFor();
  assert.equal(await areaTitle.evaluate(el=>document.activeElement===el),true,'the new area\'s title has focus');
  await areaTitle.press('Enter');
  await areaTitle.waitFor({state:'detached'});
  const after=await board(h,id);
  assert.equal(after.areas.length,1,'one area');
  const placedCards=after.cards.filter(card=>picks.some(p=>p.channelId===card.channelId));
  assert.equal(placedCards.length,3,'three cards');
  assert.ok(placedCards.every(card=>inside(after.areas[0],card)),'the area wraps its cards');
  for(const pick of picks)await page.locator(`.canvas-card[data-channel-id="${pick.channelId}"]`).waitFor();
  // The drawer closed with the new area (the mock's areaFromChats); the count dropped by three.
  await pile.waitFor({state:'detached'});
  await countIs(page,217);
  await openDrawer(page);
  await search.fill('invoice');
  await rowsAre(page,8);

  // Archive: a chat the person manages is archived for everyone (the engine archive, through Nest), a reload keeps it
  // out of the list, Show archived lists it tagged with Unarchive, and Unarchive brings it back.
  const hidden=seeded.find(c=>c.name.includes('invoice')&&!picks.includes(c))!;
  await rowFor(page,hidden.name).getByRole('checkbox').check();
  await pile.getByRole('toolbar',{name:'Selected chats',exact:true}).getByText('1 selected',{exact:true}).waitFor();
  assert.equal(await pile.getByRole('button',{name:'Place on canvas',exact:true}).count(),0,'rows drag onto the canvas instead');
  const archivedCall=page.waitForResponse(r=>r.request().method()==='POST'&&r.url().endsWith(`/api/channels/${hidden.channelId}/archive`));
  await pile.getByRole('button',{name:'Archive',exact:true}).click();
  assert.equal((await archivedCall).ok(),true);
  await page.locator('.canvas-notice').getByText('Archived 1',{exact:true}).waitFor();
  await rowFor(page,hidden.name).waitFor({state:'detached'});
  await page.reload();
  await countIs(page,216);
  await openDrawer(page);
  await search.fill('invoice');
  await rowsAre(page,7);
  assert.equal(await rowFor(page,hidden.name).count(),0,'still archived after a reload');
  const archivedNow=await call<Channel[]>(h,'GET','/api/channels?includeArchived=1');
  assert.notEqual(archivedNow.find(c=>c.id===hidden.channelId)?.archivedAt??null,null,'the engine channel is archived');
  await pile.getByRole('checkbox',{name:'Show archived',exact:true}).check();
  await rowFor(page,hidden.name).getByText('Archived',{exact:true}).waitFor();
  await rowFor(page,hidden.name).getByRole('button',{name:'Unarchive',exact:true}).click();
  await pile.getByRole('checkbox',{name:'Show archived',exact:true}).uncheck();
  await rowFor(page,hidden.name).waitFor();
  const restored=await call<Channel[]>(h,'GET','/api/channels?includeArchived=1');
  assert.equal(restored.find(c=>c.id===hidden.channelId)?.archivedAt??null,null,'the engine channel is unarchived');
  await search.fill('');

  // Scrolled far down, closed and opened again, the drawer opens at the top with its first rows mounted.
  const list=pile.locator('.canvas-drawer-list');
  await list.evaluate(el=>{el.scrollTop=200*48;});
  await pile.locator('.canvas-drawer-row[aria-posinset="200"]').waitFor();
  assert.equal(await pile.locator('.canvas-drawer-row[aria-posinset="1"]').count(),0,'the top rows are windowed out while scrolled');
  await pile.getByRole('button',{name:'Close',exact:true}).click();
  await pile.waitFor({state:'detached'});
  await openDrawer(page);
  assert.equal(await list.evaluate(el=>el.scrollTop),0,'reopened at the top');
  await pile.locator('.canvas-drawer-group').getByText(/^Today · \d+$/).waitFor();
  await pile.locator('.canvas-drawer-row[aria-posinset="1"]').waitFor();
  const top=(await list.boundingBox())!, firstRow=(await pile.locator('.canvas-drawer-row[aria-posinset="1"]').boundingBox())!;
  assert.ok(firstRow.y>=top.y&&firstRow.y+firstRow.height<=top.y+top.height,'the first row is in view, not a blank list');

  // The bottom box starts a project chat that stays in sight: placed in the view and opened beside the canvas.
  const cardsBefore=(await board(h,id)).cards.length;
  const dock=page.getByRole('region',{name:'Start a chat',exact:true});
  await dock.getByRole('textbox',{name:'Message',exact:true}).fill('Draft the launch email');
  const createdProject=page.waitForResponse(r=>r.request().method()==='POST'&&r.url().endsWith('/api/projects'));
  const sent=page.waitForResponse(r=>r.request().method()==='POST'&&r.url().endsWith('/api/messages'));
  const placedNew=page.waitForResponse(r=>r.request().method()==='POST'&&r.url().endsWith(`/api/canvases/${id}/cards`));
  await dock.getByRole('button',{name:'Send',exact:true}).click();
  const project=await(await createdProject).json() as {channelId:string;collaboration?:string};
  assert.equal((await sent).ok(),true);
  assert.equal(project.collaboration,'team','the same chat-first project as the Projects page');
  assert.equal((await placedNew).status(),201,'the new chat is placed on the canvas');
  const fresh=page.locator(`.canvas-card[data-channel-id="${project.channelId}"]`);
  await fresh.waitFor();
  await page.waitForFunction(()=>document.querySelector('.canvas-chat')?.getAttribute('data-mode')==='split');
  const opened=new URL(page.url()).searchParams;
  assert.equal(opened.get('chat'),project.channelId,'the new chat opens beside the canvas');
  assert.equal(opened.get('view'),'canvas','the canvas stays open');
  const withNew=await board(h,id);
  assert.equal(withNew.cards.length,cardsBefore+1);
  const box=(await fresh.boundingBox())!, stage=(await page.locator('.canvas-surface').boundingBox())!;
  assert.ok(box.x>=stage.x&&box.x+box.width<=stage.x+stage.width&&box.y>=stage.y&&box.y+box.height<=stage.y+stage.height,'the new card is in view');
  await rowFor(page,'Draft the launch email').waitFor({state:'detached'});
  // Escape with focus in the drawer closes it (and only it), and focus goes back to the toggle.
  await search.focus();
  await page.keyboard.press('Escape');
  await pile.waitFor({state:'detached'});
  assert.equal(await toggleOf(page).evaluate(el=>document.activeElement===el),true,'focus returns to the toggle');
  assert.equal(await page.locator('.canvas-chat[data-mode="split"]').count(),1,'the split chat stays open');
  // The canvas starts with the icon sidebar; expanded, the new project is in its shortcuts.
  await page.getByRole('button',{name:'Expand sidebar',exact:true}).click();
  await page.getByRole('list',{name:'Project shortcuts'}).getByText('Draft the launch email',{exact:true}).waitFor();
  assert.equal(await dock.getByRole('textbox',{name:'Message',exact:true}).inputValue(),'','the box is ready for the next chat');
},{canvas:true});

await runChatTest('canvas pile: dragging rows places cards where asked, and Remove from canvas returns a chat',async h=>{
  const {page,base}=h;
  const seeded=await seedChats(h,5);
  const id=await canvasWithHarnessChat(h);
  await openCanvas(page,base,id);
  const pile=pileOf(page);
  await countIs(page,5);
  // Right of the harness chat's card (and clear of the drawer), so only the first grid is in the second one's way.
  const dropAt={x:1180,y:200};
  const dragSelected=async(chats:typeof seeded)=>{
    for(const chat of chats)await rowFor(page,chat.name).getByRole('checkbox').check();
    const transfer=await page.evaluateHandle(()=>new DataTransfer());
    await rowFor(page,chats[0].name).dispatchEvent('dragstart',{dataTransfer:transfer});
    const surface=(await page.locator('.canvas-surface').boundingBox())!;
    const at={clientX:surface.x+dropAt.x,clientY:surface.y+dropAt.y};
    const placed=page.waitForResponse(r=>r.request().method()==='POST'&&r.url().endsWith(`/api/canvases/${id}/cards`));
    await page.locator('.canvas-surface').dispatchEvent('dragover',{dataTransfer:transfer,...at});
    await page.locator('.canvas-surface').dispatchEvent('drop',{dataTransfer:transfer,...at});
    return JSON.parse((await placed).request().postData()!) as {cards:{x:number;y:number}[];area?:unknown};
  };

  const body=await dragSelected(seeded.slice(0,2));
  assert.equal(body.area,undefined,'no area');
  assert.equal(body.cards[1].x-body.cards[0].x,300,'300 px apart');
  for(const chat of seeded.slice(0,2))await page.locator(`.canvas-card[data-channel-id="${chat.channelId}"]`).waitFor();

  // Dropping a grid again at the same point does not stack it on the cards already there.
  const second=await dragSelected(seeded.slice(2,4));
  // Mounted cards are measured (canvas px, unaffected by zoom); the new grid goes below the taller one, plus a gap.
  const heightOf=(channelId:string)=>page.locator(`.canvas-card[data-channel-id="${channelId}"]`).evaluate(el=>(el as HTMLElement).offsetHeight);
  const firstRow=Math.max(...await Promise.all(seeded.slice(0,2).map(chat=>heightOf(chat.channelId))));
  assert.equal(second.cards[0].y,body.cards[0].y+firstRow+40,'below the first grid, with a gap');
  const placedHeights=new Map(await Promise.all((await board(h,id)).cards.map(async c=>[c.channelId,await heightOf(c.channelId)] as const)));
  const overlap=(a:{x:number;y:number},b:{channelId:string;x:number;y:number})=>a.x<b.x+280&&b.x<a.x+280&&a.y<b.y+placedHeights.get(b.channelId)!&&b.y<a.y+260;
  for(const other of (await board(h,id)).cards.filter(c=>!seeded.slice(2,4).some(s=>s.channelId===c.channelId)))assert.ok(!overlap(second.cards[0],other),`clear of ${other.channelId}`);
  await page.locator(`.canvas-card[data-channel-id="${seeded[2].channelId}"]`).waitFor();

  // A row dragged onto the surface becomes one card centred on the drop point.
  const target=seeded[4];
  const surface=(await page.locator('.canvas-surface').boundingBox())!;
  const dropped=page.waitForResponse(r=>r.request().method()==='POST'&&r.url().endsWith(`/api/canvases/${id}/cards`));
  await rowFor(page,target.name).dragTo(page.locator('.canvas-surface'),{targetPosition:{x:500,y:150}});
  const drop=JSON.parse((await dropped).request().postData()!) as {cards:{channelId:string}[]};
  assert.deepEqual(drop.cards.map(c=>c.channelId),[target.channelId]);
  const card=page.locator(`.canvas-card[data-channel-id="${target.channelId}"]`);
  await card.waitFor();
  // Offset by half the card width and CARD_HEIGHT, in screen pixels at the current zoom.
  const box=(await card.boundingBox())!, zoom=box.width/280;
  assert.ok(Math.abs(box.x+box.width/2-(surface.x+500))<=2&&Math.abs(box.y+80*zoom-(surface.y+150))<=2,`card centred on the drop point: ${box.x - surface.x},${box.y - surface.y} at ${zoom}`);
  await rowFor(page,target.name).waitFor({state:'detached'});

  // Remove from canvas on an open card: the card goes, the chat is back in the pile, and the engine chat is untouched.
  const removed=page.waitForResponse(r=>r.request().method()==='DELETE'&&r.url().includes(`/api/canvases/${id}/cards/${target.channelId}?version=`));
  await card.getByRole('button',{name:'Remove from canvas',exact:true}).click();
  assert.equal((await removed).status(),204);
  await card.waitFor({state:'detached'});
  await rowFor(page,target.name).waitFor();
  await countIs(page,1);
  assert.equal((await board(h,id)).cards.some(c=>c.channelId===target.channelId),false,'off the canvas');
  const channels=await call<Channel[]>(h,'GET','/api/channels');
  assert.ok(channels.some(c=>c.id===target.channelId),'the chat still exists and is not archived');
},{canvas:true});

await runChatTest('canvas drawer: a left drawer from the top bar with a hot count, chips, day groups, reasons, and Escape after the sheet',async h=>{
  const {page,base}=h;
  await page.setViewportSize({width:1440,height:900});
  // Loose: the harness chat (a mention will make it need you), a chat where Pip is working, a quiet one and an old one.
  const working=await call<{channelId:string}>(h,'POST','/api/projects',{id:crypto.randomUUID(),name:'Synthetic working chat',description:'Synthetic test project',
    members:[{subscriberType:'AGENT',subscriberId:agentName}]});
  const [quiet,old]=await seedChats(h,2);
  const {id}=await call<{id:string}>(h,'POST','/api/canvases',{id:crypto.randomUUID(),name:'Drawer launch'});
  // A message ten days ago is the old chat's last activity.
  const stale=await h.emit('message.created',{text:'Synthetic old note'},{source:'human:demo-owner',channelId:old.channelId});
  h.engineDb.prepare('UPDATE events SET created_at=? WHERE id=?').run(Date.now()-10*24*3_600_000,stale.id);
  const trigger=await h.emit('message.created',{text:'Synthetic trigger'},{source:'human:demo-owner',channelId:working.channelId});
  await h.emit('agent.turn.started',{triggerEventId:trigger.id},{source:`agent:${agentName}`,channelId:working.channelId});
  await h.emit('agent.turn.phase',{triggerEventId:trigger.id,phase:'codex-progress',text:'Drafting the launch post'},{source:`agent:${agentName}`,channelId:working.channelId});
  const at=Date.now();
  h.engineDb.prepare("UPDATE agents SET desired_state='RUNNING', runtime_state='RUNNING', last_heartbeat_at=?, updated_at=? WHERE name=?").run(at,at,agentName);
  await openCanvas(page,base,id,false);
  await countIs(page,4);

  // A second person mentions the owner in a loose chat: the top-bar count turns coral.
  const bob=await h.loginAs('demo-bob');
  const sent=await bob.page.evaluate(async channelId=>(await fetch('/api/messages',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({
    id:crypto.randomUUID(),channelId,text:'@demo-owner please check the refund',mentions:[{kind:'HUMAN',name:'demo-owner',start:0,end:11}],attachments:[]})})).status,h.project.channelId);
  assert.equal(sent,201);
  await toggleOf(page).locator('.canvas-loose-count[data-hot]').waitFor();
  assert.match(await toggleOf(page).innerText(),/Loose chats\s*4/);

  // The drawer floats over the left of the canvas, which keeps its width, under the Area tool.
  const stage=page.locator('.canvas-stage');
  const before=(await stage.boundingBox())!;
  await openDrawer(page);
  const pile=pileOf(page);
  const drawer=(await pile.boundingBox())!, after=(await stage.boundingBox())!;
  assert.ok(drawer.x-after.x<40&&drawer.x>=after.x,`the drawer is at the canvas's left (${drawer.x-after.x} px in)`);
  assert.equal(after.width,before.width,'the canvas keeps its full width');
  assert.ok(Math.abs(drawer.width-370)<=1,`370 px wide (${drawer.width})`);
  const tools=(await page.getByRole('toolbar',{name:'Canvas tools',exact:true}).boundingBox())!;
  assert.ok(drawer.y>=tools.y+tools.height,'below the Area tool');
  const tray=(await page.locator('.canvas-tray').boundingBox())!;
  assert.ok(drawer.y+drawer.height<=tray.y,'clear of the agent tray');

  // Chips with counts, day groups (Older folds behind Show) and each row's second line.
  const chip=(label:string)=>pile.getByRole('group',{name:'Show',exact:true}).getByRole('button',{name:new RegExp(`^${label} \\d+$`)});
  const chipText=async(label:string)=>(await chip(label).innerText()).replace(/\s+/g,' ');
  await pile.locator('.canvas-drawer-line.is-hot').getByText('Needs you: @demo-owner please check the refund',{exact:true}).waitFor();
  await rowFor(page,'Synthetic working chat').locator('.canvas-drawer-line').getByText('Pip · Drafting the launch post',{exact:true}).waitFor();
  assert.equal(await chipText('All'),'All 4');
  assert.equal(await chipText('Needs you'),'Needs you 1');
  assert.equal(await chipText('Working'),'Working 1');
  assert.equal(await chipText('Done'),'Done 2');
  await pile.locator('.canvas-drawer-group').getByText('Today · 3',{exact:true}).waitFor();
  await pile.locator('.canvas-drawer-group').getByText('Older · 1',{exact:true}).waitFor();
  assert.equal(await rowFor(page,old.name).count(),0,'Older is folded');
  await pile.getByRole('button',{name:'Show older chats',exact:true}).click();
  await rowFor(page,old.name).waitFor();
  assert.equal(await rowFor(page,quiet.name).getAttribute('title'),'Click to open · drag onto the canvas to place');
  await chip('Working').click();
  await rowsAre(page,1,'Working');
  await rowFor(page,'Synthetic working chat').waitFor();
  await chip('All').click();
  await rowsAre(page,4,'All');
  // The agent filter and a search over agent names (Pip is in the harness chat and the working one).
  await pile.getByRole('combobox',{name:'Agent',exact:true}).selectOption(agentName);
  await rowsAre(page,2,'with Pip');
  await pile.getByRole('combobox',{name:'Agent',exact:true}).selectOption('');
  await pile.getByRole('searchbox',{name:'Search loose chats',exact:true}).fill(agentName.toLowerCase());
  await rowsAre(page,2,'searching for pip');
  await pile.getByRole('searchbox',{name:'Search loose chats',exact:true}).fill('');
  // A selected row is marked.
  await rowFor(page,quiet.name).getByRole('checkbox').check();
  assert.notEqual(await rowFor(page,quiet.name).getAttribute('data-selected'),null,'a ticked row is marked selected');
  await pile.getByRole('button',{name:'Clear',exact:true}).click();

  // A press on the canvas leaves the drawer open; the agent picker and the drawer take turns.
  const surface=(await page.locator('.canvas-surface').boundingBox())!;
  await page.mouse.click(surface.x+surface.width-200,surface.y+surface.height/2);
  assert.equal(await pile.count(),1,'still open after a canvas press');
  await page.locator('.canvas-tray').getByRole('button',{name:/^All \d+ agents$/}).click();
  await page.getByRole('dialog',{name:'All agents',exact:true}).waitFor();
  assert.equal(await pile.count(),0,'the picker closed the drawer');
  await toggleOf(page).click();
  await pile.waitFor();
  assert.equal(await page.getByRole('dialog',{name:'All agents',exact:true}).count(),0,'the drawer closed the picker');

  // A row opens its chat as the plain sheet, beside the drawer when it fits; the drawer stays open.
  await rowFor(page,quiet.name).locator('.canvas-drawer-title').click();
  const sheet=page.locator('.canvas-chat[data-place="loose"]');
  await sheet.waitFor();
  const placed=(await sheet.boundingBox())!, open=(await pile.boundingBox())!;
  assert.ok(placed.x>=open.x+open.width,`the sheet keeps clear of the drawer (${placed.x} vs ${open.x+open.width})`);
  // Escape with focus in the sheet closes the sheet only.
  await sheet.focus();
  await page.keyboard.press('Escape');
  await sheet.waitFor({state:'detached'});
  assert.equal(await pile.count(),1,'one Escape closed only the sheet');
  // Escape with focus in the drawer closes the drawer only, even over an open sheet.
  await rowFor(page,quiet.name).locator('.canvas-drawer-title').click();
  await sheet.waitFor();
  await pile.getByRole('searchbox',{name:'Search loose chats',exact:true}).click();
  await page.keyboard.press('Escape');
  await pile.waitFor({state:'detached'});
  assert.equal(await sheet.count(),1,'one Escape closed only the drawer');
  // ✕ closes it too.
  await page.keyboard.press('Escape');
  await sheet.waitFor({state:'detached'});
  await openDrawer(page);
  await pile.getByRole('button',{name:'Close',exact:true}).click();
  await pile.waitFor({state:'detached'});
  // With no sheet open and focus on the canvas, Escape closes the drawer and leaves focus where it was.
  await openDrawer(page);
  await page.locator('.canvas-surface').focus();
  await page.keyboard.press('Escape');
  await pile.waitFor({state:'detached'});
  assert.equal(await page.evaluate(()=>document.activeElement?.classList.contains('canvas-surface')),true,'focus stays on the canvas');
},{canvas:true});

await runChatTest('canvas drawer: a loose chat is placed on the canvas with the keyboard alone, from the sheet\'s More menu or its Area picker',async h=>{
  const {page,base}=h;
  await page.setViewportSize({width:1440,height:900});
  const [first,second]=await seedChats(h,2);
  const id=await canvasWithHarnessChat(h);
  await openCanvas(page,base,id,false);
  await countIs(page,2);
  const focusedIs=(selector:string)=>page.evaluate(s=>Boolean(document.activeElement?.matches(s)),selector);
  /** Tabs (at most 30 times) until focus is on the element matching `selector`. */
  const tabTo=async(selector:string,what:string)=>{
    for(let i=0;i<30&&!await focusedIs(selector);i++)await page.keyboard.press('Tab');
    assert.equal(await focusedIs(selector),true,`Tab reaches ${what}`);
  };

  // The toggle opens the drawer with the search focused; a search, then Tab to the row and Enter opens it as the plain sheet.
  await toggleOf(page).focus();
  await page.keyboard.press('Enter');
  const pile=pileOf(page);
  await pile.waitFor();
  assert.equal(await focusedIs('.canvas-drawer-search'),true);
  await page.keyboard.type(first.name);
  await rowsAre(page,1,'the searched chat');
  await tabTo('.canvas-drawer-open','the row');
  await page.keyboard.press('Enter');
  const sheet=page.locator('.canvas-chat[data-mode="focus"]');
  await page.locator('.canvas-chat[data-place="loose"]').waitFor();

  // More chat actions → Place on canvas: one card at the view's centre, and the sheet opens in place over it.
  await tabTo('.canvas-chat [aria-label="More chat actions"]','More chat actions');
  await page.keyboard.press('Enter');
  const menu=sheet.getByRole('group',{name:'More chat actions',exact:true});
  const area=menu.getByRole('combobox',{name:'Area',exact:true});
  assert.deepEqual(await area.locator('option').allTextContents(),['Not on this canvas','No area (on the canvas)'],'a canvas without areas still offers the canvas');
  await tabTo('.canvas-chat-menu-item[title^="Put this chat on the canvas"]','Place on canvas');
  const placed=page.waitForResponse(r=>r.request().method()==='POST'&&r.url().endsWith(`/api/canvases/${id}/cards`));
  await page.keyboard.press('Enter');
  const body=JSON.parse((await placed).request().postData()!) as {cards:{channelId:string}[];area?:unknown};
  assert.equal((await placed).status(),201);
  assert.deepEqual(body.cards.map(c=>c.channelId),[first.channelId]);
  assert.equal(body.area,undefined,'no area');
  const card=page.locator(`.canvas-card[data-channel-id="${first.channelId}"]`);
  await card.waitFor();
  await page.locator('.canvas-chat[data-place="card"]').waitFor();
  assert.equal(await focusedIs('.canvas-chat [aria-label="More chat actions"]'),true,'focus stays in the sheet, on More');
  // The camera moves to present the new card; poll from Node until the sheet has settled on it.
  let over=false, last='';
  for(let i=0;i<50&&!over;i++){
    const cardBox=await card.boundingBox(), sheetBox=await sheet.boundingBox();
    last=JSON.stringify({sheetBox,cardBox});
    over=Boolean(cardBox&&sheetBox&&Math.abs(cardBox.x-sheetBox.x)<=24&&Math.abs(cardBox.y-sheetBox.y)<=24);
    if(!over)await page.waitForTimeout(100);
  }
  assert.ok(over,`the sheet sits over its new card: ${last}`);
  await countIs(page,1);
  await page.keyboard.press('Escape');
  await sheet.waitFor({state:'detached'});

  // The Area picker's No area (on the canvas) does the same for another loose chat. It comes after the areas, so a
  // first arrow press (which commits a closed select on Windows and Linux) never places the chat by accident.
  const zoneId=crypto.randomUUID();
  await call(h,'POST',`/api/canvases/${id}/areas`,{id:zoneId,title:'Far zone',x:4000,y:4000,w:400,h:300,tint:'pip'});
  await page.goto(`${base}/?view=canvas&canvas=${id}&chat=${second.channelId}&mode=focus`);
  await page.locator('.canvas-chat[data-place="loose"]').waitFor();
  await tabTo('.canvas-chat [aria-label="More chat actions"]','More chat actions');
  await page.keyboard.press('Enter');
  await tabTo('.canvas-chat-area select','the Area picker');
  assert.deepEqual(await area.locator('option').allTextContents(),['Not on this canvas','Far zone','No area (on the canvas)'],'the canvas comes last');
  const onCanvas=page.waitForResponse(r=>r.request().method()==='POST'&&r.url().endsWith(`/api/canvases/${id}/cards`));
  await page.keyboard.press('End');
  assert.equal((await onCanvas).status(),201);
  await page.locator(`.canvas-card[data-channel-id="${second.channelId}"]`).waitFor();
  await page.locator('.canvas-chat[data-place="card"]').waitFor();
  const cards=(await board(h,id)).cards;
  const a=cards.find(c=>c.channelId===first.channelId)!, b=cards.find(c=>c.channelId===second.channelId)!;
  assert.ok(Math.abs(a.x-b.x)>=280||Math.abs(a.y-b.y)>=160,'the second card is placed clear of the first');
  const zone=(await board(h,id)).areas.find(z=>z.id===zoneId)!;
  assert.equal(inside(zone,b),false,'on the canvas, in no area');
  await countIs(page,0);
},{canvas:true});

await runChatTest('canvas areas: dropping chats into an area lights it up, they join it and it grows to fit them',async h=>{
  const {page,base}=h;
  await page.setViewportSize({width:1440,height:900});
  const seeded=await seedChats(h,3);
  const id=await canvasWithHarnessChat(h);
  const areaId=crypto.randomUUID();
  await call(h,'POST',`/api/canvases/${id}/areas`,{id:areaId,title:'Landing zone',x:600,y:0,w:400,h:300,tint:'pip'});
  await openCanvas(page,base,id);
  const area=page.locator(`.canvas-area[data-area-id="${areaId}"]`);
  await area.waitFor();

  // Dragging a selected row carries every selected chat.
  for(const chat of seeded)await rowFor(page,chat.name).getByRole('checkbox').check();
  const transfer=await page.evaluateHandle(()=>new DataTransfer());
  await rowFor(page,seeded[0].name).dispatchEvent('dragstart',{dataTransfer:transfer});
  const carried=await transfer.evaluate(d=>d.getData('application/x-nest-chat').split('\n'));
  assert.deepEqual([...carried].sort(),seeded.map(c=>c.channelId).sort(),'the drag carries the whole selection');

  // Over the area, it lights up and says where the chats will land.
  const target=(await area.boundingBox())!;
  const at={clientX:target.x+target.width/2,clientY:target.y+target.height/2};
  const surface=page.locator('.canvas-surface');
  await surface.dispatchEvent('dragover',{dataTransfer:transfer,...at});
  await page.locator(`.canvas-area.is-drop-target[data-area-id="${areaId}"]`).waitFor();
  await area.getByText('Place in Landing zone · shares its context',{exact:true}).waitFor();

  // Dropped there: three cards in a grid, the area grows to hold all of them, and each card carries its stripe.
  const placed=page.waitForResponse(r=>r.request().method()==='POST'&&r.url().endsWith(`/api/canvases/${id}/cards`));
  const grown=page.waitForResponse(r=>r.request().method()==='PATCH'&&r.url().includes(`/api/canvases/${id}/areas/${areaId}`));
  await surface.dispatchEvent('drop',{dataTransfer:transfer,...at});
  assert.equal((await placed).status(),201);
  assert.ok((await grown).ok(),'the area is resized to fit');
  await area.getByText('Place in Landing zone · shares its context',{exact:true}).waitFor({state:'detached'});
  const after=await board(h,id);
  const zone=after.areas.find(a=>a.id===areaId)!;
  assert.ok(zone.w>400&&zone.h>300,`the area grew (${zone.w}x${zone.h})`);
  for(const chat of seeded){
    const card=after.cards.find(c=>c.channelId===chat.channelId)!;
    assert.ok(inside(zone,card),`${chat.name} belongs to the area`);
    assert.ok(card.x>=zone.x&&card.x+card.w<=zone.x+zone.w&&card.y>=zone.y&&card.y+160<=zone.y+zone.h,`${chat.name} fits inside the area`);
    const shown=page.locator(`.canvas-card[data-channel-id="${chat.channelId}"]`);
    await shown.and(page.locator('.in-area[data-tint="pip"]')).waitFor();
    await shown.getByText('In area Landing zone',{exact:true}).waitFor({state:'attached'});
  }

  // Escape with the area's menu open closes only the menu; the drawer stays.
  const options=area.getByRole('button',{name:'Area options',exact:true});
  await options.focus();
  await page.keyboard.press('Enter');
  assert.equal(await options.getAttribute('aria-expanded'),'true');
  await page.keyboard.press('Escape');
  assert.equal(await options.getAttribute('aria-expanded'),'false');
  assert.equal(await pileOf(page).count(),1,'one Escape closed only the area menu');

  // A card dragged in on the canvas lights the area up mid-drag and joins it on release.
  // The drawer floats over the canvas's left, where this card sits: close it first.
  await pileOf(page).getByRole('button',{name:'Close',exact:true}).click();
  await pileOf(page).waitFor({state:'detached'});
  const outside=page.locator(`.canvas-card[data-channel-id="${h.project.channelId}"]`);
  assert.equal(await outside.evaluate(e=>e.classList.contains('in-area')),false,'a card outside areas has no stripe');
  // Membership follows the card's centre, so aim that (not the grab point) at the area's middle.
  const from=(await outside.locator('.canvas-card-title').boundingBox())!;
  const body=(await outside.boundingBox())!;
  const into=(await area.boundingBox())!;
  const grab={x:from.x+from.width/2,y:from.y+from.height/2};
  const centre={x:body.x+body.width/2,y:body.y+body.height/2};
  await page.mouse.move(grab.x,grab.y);
  await page.mouse.down();
  await page.mouse.move(into.x+into.width/2+grab.x-centre.x,into.y+into.height/2+grab.y-centre.y,{steps:8});
  await page.locator(`.canvas-area.is-drop-target[data-area-id="${areaId}"]`).waitFor();
  const moved=page.waitForResponse(r=>r.request().method()==='PATCH'&&r.url().includes(`/api/canvases/${id}/cards/${h.project.channelId}`));
  await page.mouse.up();
  assert.ok((await moved).ok());
  await outside.and(page.locator('.in-area')).waitFor();
  assert.equal(await page.locator('.canvas-area.is-drop-target').count(),0,'the highlight ends with the drag');
  // The area may also grow to hold it fully; the follow-up resize lands just after the move.
  let fits=false;
  for(let i=0;i<40&&!fits;i++){
    const b=await board(h,id), zone=b.areas.find(a=>a.id===areaId)!, card=b.cards.find(c=>c.channelId===h.project.channelId)!;
    fits=inside(zone,card)&&card.x>=zone.x&&card.x+card.w<=zone.x+zone.w&&card.y+160<=zone.y+zone.h;
    if(!fits)await page.waitForTimeout(100);
  }
  assert.ok(fits,'the moved card belongs to the area and fits inside it');
},{canvas:true});

await runChatTest('canvas areas: the open chat header moves its chat into an area, out of it, and places a loose chat there',async h=>{
  const {page,base}=h;
  await page.setViewportSize({width:1440,height:900});
  const [inArea,loose]=await seedChats(h,2);
  const id=await canvasWithHarnessChat(h);
  const areaId=crypto.randomUUID();
  await call(h,'POST',`/api/canvases/${id}/areas`,{id:areaId,title:'Landing zone',x:600,y:0,w:400,h:300,tint:'pip'});
  await call(h,'POST',`/api/canvases/${id}/cards`,{cards:[{channelId:inArea.channelId,x:632,y:72}]});
  const fits=(zone:Board['areas'][number],card:Board['cards'][number])=>inside(zone,card)&&card.x>=zone.x&&card.x+card.w<=zone.x+zone.w&&card.y>=zone.y&&card.y+160<=zone.y+zone.h;
  const settle=async(check:(b:Board)=>boolean)=>{for(let i=0;i<40;i++){const b=await board(h,id);if(check(b))return b;await page.waitForTimeout(100);}return board(h,id);};

  // Into an area: a free spot beside the card already there, the area grows to hold it, and the card gets its stripe.
  await page.goto(`${base}/?view=canvas&canvas=${id}&chat=${h.project.channelId}&mode=split`);
  // The Area picker is in the header's More menu, which closes once a choice is made (its value is read while closed).
  const picker=page.locator('.canvas-chat .canvas-chat-area select');
  const openMenu=async()=>{
    await page.locator('.canvas-chat').getByRole('button',{name:'More chat actions',exact:true}).click();
    await page.locator('.canvas-chat').getByRole('combobox',{name:'Area',exact:true}).waitFor();
  };
  await openMenu();
  assert.equal(await picker.inputValue(),'','not in an area yet');
  const moved=page.waitForResponse(r=>r.request().method()==='PATCH'&&r.url().includes(`/api/canvases/${id}/cards/${h.project.channelId}`));
  await picker.selectOption({label:'Landing zone'});
  assert.ok((await moved).ok());
  const joined=await settle(b=>{const zone=b.areas.find(a=>a.id===areaId)!;return fits(zone,b.cards.find(c=>c.channelId===h.project.channelId)!);});
  const zone=joined.areas.find(a=>a.id===areaId)!, card=joined.cards.find(c=>c.channelId===h.project.channelId)!, neighbour=joined.cards.find(c=>c.channelId===inArea.channelId)!;
  assert.ok(fits(zone,card),'the chat fits inside the area');
  assert.ok(card.x>=neighbour.x+neighbour.w||card.y>=neighbour.y+160,'it does not cover the card already there');
  assert.equal(await picker.inputValue(),areaId);
  await page.locator(`.canvas-card.in-area[data-channel-id="${h.project.channelId}"]`).waitFor();

  // No area: out beside the area, in none.
  const out=page.waitForResponse(r=>r.request().method()==='PATCH'&&r.url().includes(`/api/canvases/${id}/cards/${h.project.channelId}`));
  await openMenu();
  await picker.selectOption({label:'No area'});
  assert.ok((await out).ok());
  const left=await board(h,id);
  const after=left.cards.find(c=>c.channelId===h.project.channelId)!;
  assert.ok(left.areas.every(a=>!inside(a,after)),'the chat left every area');
  assert.equal(await picker.inputValue(),'');

  // A loose chat opened from the pile is placed straight into the area.
  await page.goto(`${base}/?view=canvas&canvas=${id}&chat=${loose.channelId}&mode=split`);
  const placed=page.waitForResponse(r=>r.request().method()==='POST'&&r.url().endsWith(`/api/canvases/${id}/cards`));
  await openMenu();
  assert.equal(await picker.locator('option[value=""]').textContent(),'Not on this canvas');
  await picker.selectOption({label:'Landing zone'});
  assert.equal((await placed).status(),201);
  const landed=await settle(b=>{const z=b.areas.find(a=>a.id===areaId)!,c=b.cards.find(c=>c.channelId===loose.channelId);return Boolean(c&&fits(z,c));});
  assert.ok(fits(landed.areas.find(a=>a.id===areaId)!,landed.cards.find(c=>c.channelId===loose.channelId)!),'the loose chat lands inside the area');
  await page.locator(`.canvas-card.in-area[data-channel-id="${loose.channelId}"]`).waitFor();
},{canvas:true});
