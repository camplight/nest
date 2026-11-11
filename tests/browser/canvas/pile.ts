// Loose chats pile and bottom box (Task 7) on the real engine, API and WS. Synthetic data.
import assert from 'node:assert/strict';
import type {Page} from 'playwright';
import {runChatTest,type ChatHarness} from '../support/chat-harness';

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
async function openCanvas(page:Page,base:string,id:string){
  await page.goto(`${base}/?view=canvas&canvas=${id}`);
  await page.locator('.canvas-surface .canvas-world').waitFor({state:'attached'});
  await pileOf(page).waitFor();
}
const rowFor=(page:Page,title:string)=>pileOf(page).locator('.canvas-pile-row').filter({has:page.getByRole('checkbox',{name:`Select ${title}`,exact:true})});
const inside=(area:Board['areas'][number],card:Board['cards'][number])=>{
  const cx=card.x+card.w/2,cy=card.y+80;
  return cx>=area.x&&cx<=area.x+area.w&&cy>=area.y&&cy<=area.y+area.h;
};

await runChatTest('canvas pile: 220 loose chats stay windowed, search, new area, hide and the bottom box',async h=>{
  const {page,base}=h;
  const seeded=await seedChats(h,220);
  const id=await canvasWithHarnessChat(h);
  await openCanvas(page,base,id);
  const pile=pileOf(page);
  await pile.locator('.canvas-pile-count').getByText('220',{exact:true}).waitFor();
  const rows=pile.locator('.canvas-pile-row');
  await rows.first().waitFor();
  const mounted=await rows.count();
  assert.ok(mounted>0&&mounted<40,`a windowed list: ${mounted} rows in the DOM`);
  assert.equal(await rowFor(page,'Synthetic chat project').count(),0,'a chat on this canvas is not loose');

  // Search narrows the list.
  const search=pile.getByRole('searchbox',{name:'Search loose chats',exact:true});
  await search.fill('invoice');
  await page.waitForFunction(()=>document.querySelectorAll('.canvas-pile-row').length===11);
  for(const text of await rows.allTextContents())assert.match(text,/invoice/i);

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
  await page.waitForFunction(()=>document.querySelectorAll('.canvas-pile-row').length===8);
  await pile.locator('.canvas-pile-count').getByText('217',{exact:true}).waitFor();

  // Hide is personal: the row goes, a reload keeps it gone, and the engine channel is not archived.
  const hidden=seeded.find(c=>c.name.includes('invoice')&&!picks.includes(c))!;
  await rowFor(page,hidden.name).getByRole('checkbox').check();
  const hid=page.waitForResponse(r=>r.request().method()==='POST'&&r.url().endsWith('/api/canvases/hidden'));
  await pile.getByRole('button',{name:'Hide',exact:true}).click();
  assert.equal((await hid).ok(),true);
  await rowFor(page,hidden.name).waitFor({state:'detached'});
  await page.reload();
  await pile.locator('.canvas-pile-count').getByText('216',{exact:true}).waitFor();
  await search.fill('invoice');
  await page.waitForFunction(()=>document.querySelectorAll('.canvas-pile-row').length===7);
  assert.equal(await rowFor(page,hidden.name).count(),0,'still hidden after a reload');
  const channels=await call<Channel[]>(h,'GET','/api/channels?includeArchived=1');
  assert.equal(channels.find(c=>c.id===hidden.channelId)?.archivedAt??null,null,'the engine channel is not archived');
  await pile.getByRole('checkbox',{name:'Show hidden',exact:true}).check();
  await rowFor(page,hidden.name).getByRole('button',{name:'Unhide',exact:true}).click();
  await pile.getByRole('checkbox',{name:'Show hidden',exact:true}).uncheck();
  await rowFor(page,hidden.name).waitFor();
  await search.fill('');

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
  // The canvas starts with the icon sidebar; expanded, the new project is in its shortcuts.
  await page.getByRole('button',{name:'Expand sidebar',exact:true}).click();
  await page.getByRole('list',{name:'Project shortcuts'}).getByText('Draft the launch email',{exact:true}).waitFor();
  assert.equal(await dock.getByRole('textbox',{name:'Message',exact:true}).inputValue(),'','the box is ready for the next chat');
},{canvas:true});

await runChatTest('canvas pile: Place on canvas and dragging a row place cards where asked, and Remove from canvas returns a chat',async h=>{
  const {page,base}=h;
  const seeded=await seedChats(h,4);
  const id=await canvasWithHarnessChat(h);
  await openCanvas(page,base,id);
  const pile=pileOf(page);
  await pile.locator('.canvas-pile-count').getByText('4',{exact:true}).waitFor();

  for(const chat of seeded.slice(0,2))await rowFor(page,chat.name).getByRole('checkbox').check();
  const placed=page.waitForResponse(r=>r.request().method()==='POST'&&r.url().endsWith(`/api/canvases/${id}/cards`));
  await pile.getByRole('button',{name:'Place on canvas',exact:true}).click();
  const body=JSON.parse((await placed).request().postData()!) as {cards:{x:number;y:number}[];area?:unknown};
  assert.equal(body.area,undefined,'no area');
  assert.equal(body.cards[1].x-body.cards[0].x,300,'300 px apart');
  for(const chat of seeded.slice(0,2))await page.locator(`.canvas-card[data-channel-id="${chat.channelId}"]`).waitFor();

  // Placing again at the same viewport centre does not stack the new grid on the cards already there.
  const again=page.waitForResponse(r=>r.request().method()==='POST'&&r.url().endsWith(`/api/canvases/${id}/cards`));
  await rowFor(page,seeded[2].name).getByRole('checkbox').check();
  await pile.getByRole('button',{name:'Place on canvas',exact:true}).click();
  const second=JSON.parse((await again).request().postData()!) as {cards:{x:number;y:number}[]};
  // Mounted cards are measured (canvas px, unaffected by zoom); the new grid goes below the taller one, plus a gap.
  const heightOf=(channelId:string)=>page.locator(`.canvas-card[data-channel-id="${channelId}"]`).evaluate(el=>(el as HTMLElement).offsetHeight);
  const firstRow=Math.max(...await Promise.all(seeded.slice(0,2).map(chat=>heightOf(chat.channelId))));
  assert.equal(second.cards[0].y,body.cards[0].y+firstRow+40,'below the first grid, with a gap');
  const placedHeights=new Map(await Promise.all((await board(h,id)).cards.map(async c=>[c.channelId,await heightOf(c.channelId)] as const)));
  const overlap=(a:{x:number;y:number},b:{channelId:string;x:number;y:number})=>a.x<b.x+280&&b.x<a.x+280&&a.y<b.y+placedHeights.get(b.channelId)!&&b.y<a.y+260;
  for(const other of (await board(h,id)).cards.filter(c=>c.channelId!==seeded[2].channelId))assert.ok(!overlap(second.cards[0],other),`clear of ${other.channelId}`);
  await page.locator(`.canvas-card[data-channel-id="${seeded[2].channelId}"]`).waitFor();

  // A row dropped on the surface becomes one card centred on the drop point.
  const target=seeded[3];
  const surface=(await page.locator('.canvas-surface').boundingBox())!;
  const dropped=page.waitForResponse(r=>r.request().method()==='POST'&&r.url().endsWith(`/api/canvases/${id}/cards`));
  await rowFor(page,target.name).dragTo(page.locator('.canvas-surface'),{targetPosition:{x:200,y:150}});
  const drop=JSON.parse((await dropped).request().postData()!) as {cards:{channelId:string}[]};
  assert.deepEqual(drop.cards.map(c=>c.channelId),[target.channelId]);
  const card=page.locator(`.canvas-card[data-channel-id="${target.channelId}"]`);
  await card.waitFor();
  // Offset by half the card width and CARD_HEIGHT, in screen pixels at the current zoom.
  const box=(await card.boundingBox())!, zoom=box.width/280;
  assert.ok(Math.abs(box.x+box.width/2-(surface.x+200))<=2&&Math.abs(box.y+80*zoom-(surface.y+150))<=2,`card centred on the drop point: ${box.x - surface.x},${box.y - surface.y} at ${zoom}`);
  await rowFor(page,target.name).waitFor({state:'detached'});

  // Remove from canvas on an open card: the card goes, the chat is back in the pile, and the engine chat is untouched.
  const removed=page.waitForResponse(r=>r.request().method()==='DELETE'&&r.url().includes(`/api/canvases/${id}/cards/${target.channelId}?version=`));
  await card.getByRole('button',{name:'Remove from canvas',exact:true}).click();
  assert.equal((await removed).status(),204);
  await card.waitFor({state:'detached'});
  await rowFor(page,target.name).waitFor();
  await pile.locator('.canvas-pile-count').getByText('1',{exact:true}).waitFor();
  assert.equal((await board(h,id)).cards.some(c=>c.channelId===target.channelId),false,'off the canvas');
  const channels=await call<Channel[]>(h,'GET','/api/channels');
  assert.ok(channels.some(c=>c.id===target.channelId),'the chat still exists and is not archived');
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

  // A card dragged in on the canvas lights the area up mid-drag and joins it on release.
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
