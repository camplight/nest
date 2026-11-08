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

  // The bottom box starts a project chat that lands in the pile and the sidebar, not on the canvas.
  const cardsBefore=(await board(h,id)).cards.length;
  const dock=page.getByRole('region',{name:'Start a chat',exact:true});
  await dock.getByRole('textbox',{name:'Message',exact:true}).fill('Draft the launch email');
  const createdProject=page.waitForResponse(r=>r.request().method()==='POST'&&r.url().endsWith('/api/projects'));
  const sent=page.waitForResponse(r=>r.request().method()==='POST'&&r.url().endsWith('/api/messages'));
  const url=page.url();
  await dock.getByRole('button',{name:'Send',exact:true}).click();
  const project=await(await createdProject).json() as {channelId:string;collaboration?:string};
  assert.equal((await sent).ok(),true);
  assert.equal(project.collaboration,'team','the same chat-first project as the Projects page');
  await pile.locator('.canvas-pile-count').getByText('218',{exact:true}).waitFor();
  await search.fill('Draft the launch');
  await rowFor(page,'Draft the launch email').waitFor();
  await page.getByRole('list',{name:'Project shortcuts'}).getByText('Draft the launch email',{exact:true}).waitFor();
  assert.equal(page.url(),url,'the canvas stays open');
  assert.equal((await board(h,id)).cards.length,cardsBefore,'not placed on the canvas');
  assert.equal(await page.locator(`.canvas-card[data-channel-id="${project.channelId}"]`).count(),0);
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
  assert.equal(second.cards[0].y,body.cards[0].y+160+40,'below the first grid, with a gap');
  const overlap=(a:{x:number;y:number},b:{x:number;y:number})=>a.x<b.x+280&&b.x<a.x+280&&a.y<b.y+160&&b.y<a.y+160;
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
