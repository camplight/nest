// Canvas surface (Task 5): pan, zoom, culling, areas and card moves on the real engine and API. Synthetic data.
import assert from 'node:assert/strict';
import type {Page} from 'playwright';
import {runChatTest,type ChatHarness} from '../support/chat-harness';

type Board={canvas:{id:string;version:number};areas:{id:string;title:string;x:number;y:number;w:number;h:number;version:number}[];cards:{channelId:string;x:number;y:number;version:number}[]};

async function call<T>(h:ChatHarness,method:string,path:string,body?:unknown,cookie=h.cookie):Promise<T>{
  const response=await fetch(h.apiUrl+path,{method,headers:{cookie,'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
  if(!response.ok)throw Error(`${method} ${path}: ${response.status} ${await response.text()}`);
  return response.status===204?undefined as T:await response.json() as T;
}
const board=(h:ChatHarness,id:string)=>call<Board>(h,'GET',`/api/canvases/${id}/board`);
async function newCanvas(h:ChatHarness,name:string){
  const canvas=await call<{id:string}>(h,'POST','/api/canvases',{id:crypto.randomUUID(),name});
  return canvas.id;
}
const zoomLabel=(page:Page)=>page.getByLabel('Zoom level',{exact:true});
async function openCanvas(page:Page,base:string,id:string){
  await page.goto(`${base}/?view=canvas&canvas=${id}`);
  await page.locator('.canvas-surface .canvas-world').waitFor({state:'attached'});
  await zoomLabel(page).waitFor();
}
const cardAt=(page:Page,channelId:string)=>page.locator(`.canvas-card[data-channel-id="${channelId}"]`);
async function box(page:Page,selector:string){
  const b=await page.locator(selector).boundingBox();
  assert.ok(b,`${selector} has a box`);
  return b;
}
async function drag(page:Page,from:{x:number;y:number},to:{x:number;y:number}){
  await page.mouse.move(from.x,from.y);
  await page.mouse.down();
  await page.mouse.move((from.x+to.x)/2,(from.y+to.y)/2,{steps:4});
  await page.mouse.move(to.x,to.y,{steps:4});
  await page.mouse.up();
}
const near=(actual:number,expected:number,what:string,tolerance=1.5)=>assert.ok(Math.abs(actual-expected)<=tolerance,`${what}: expected ${expected}, got ${actual}`);

await runChatTest('canvas surface: draw, rename and move an area; culling and Fit',async h=>{
  const {page,base}=h;
  const id=await newCanvas(h,'Launch');
  await openCanvas(page,base,id);
  assert.equal(await zoomLabel(page).textContent(),'100%');
  // No dot grid: the surface carries the woven-twig texture.
  assert.match(await page.locator('.canvas-surface').evaluate(el=>getComputedStyle(el).backgroundImage),/^url\("data:image\/svg\+xml/);

  const surface=await box(page,'.canvas-surface');
  await page.getByRole('button',{name:'Area',exact:true}).click();
  const created=page.waitForResponse(r=>r.request().method()==='POST'&&r.url().endsWith(`/api/canvases/${id}/areas`));
  await drag(page,{x:surface.x+300,y:surface.y+160},{x:surface.x+1000,y:surface.y+620});
  assert.equal((await created).status(),201);
  const drawn=page.locator('[aria-label="Area New area"]');
  await drawn.waitFor();

  await drawn.getByText('New area',{exact:true}).dblclick();
  const title=page.getByRole('textbox',{name:'Area title',exact:true});
  await title.fill('Launch content');
  const renamed=page.waitForResponse(r=>r.request().method()==='PATCH'&&r.url().includes(`/api/canvases/${id}/areas/`));
  await title.press('Enter');
  assert.equal((await renamed).status(),200);
  await page.locator('[aria-label="Area Launch content"]').waitFor();

  await page.reload();
  const area=page.locator('[aria-label="Area Launch content"]');
  await area.waitFor();
  const [stored]=(await board(h,id)).areas;
  assert.equal(stored.title,'Launch content','the rename is stored');
  near(stored.w,700,'drawn width');near(stored.h,460,'drawn height');

  // One card inside the area, one far outside it (a second synthetic chat).
  const other=await call<{channelId:string}>(h,'POST','/api/projects',{id:crypto.randomUUID(),name:'Synthetic pricing chat',description:'Synthetic test project',members:[]});
  await call(h,'POST',`/api/canvases/${id}/cards`,{cards:[
    {channelId:h.project.channelId,x:stored.x+40,y:stored.y+80},
    {channelId:other.channelId,x:stored.x+3200,y:stored.y+1800},
  ]});
  await page.reload();
  const inside=cardAt(page,h.project.channelId);
  await inside.waitFor();
  assert.equal(await zoomLabel(page).textContent(),'100%','the saved view is restored');
  assert.equal(await cardAt(page,other.channelId).count(),0,'an off-screen card is not mounted');

  const areaBefore=await area.boundingBox(),cardBefore=await inside.boundingBox();
  assert.ok(areaBefore&&cardBefore);
  const bar=await box(page,'[aria-label="Area Launch content"] .canvas-area-bar');
  const moved=page.waitForResponse(r=>r.request().method()==='PATCH'&&r.url().includes('moveCards=1'));
  await drag(page,{x:bar.x+bar.width/2,y:bar.y+bar.height/2},{x:bar.x+bar.width/2+200,y:bar.y+bar.height/2});
  assert.equal((await moved).status(),200);
  const areaAfter=await area.boundingBox(),cardAfter=await inside.boundingBox();
  assert.ok(areaAfter&&cardAfter);
  near(areaAfter.x-areaBefore.x,200,'area moved on screen');
  near(cardAfter.x-cardBefore.x,200,'card inside moved on screen');
  near(cardAfter.y,cardBefore.y,'card stays level');
  const after=await board(h,id);
  near(after.areas[0].x-stored.x,200,'stored area x');
  near(after.cards.find(c=>c.channelId===h.project.channelId)!.x-(stored.x+40),200,'stored card x');
  assert.equal(after.cards.find(c=>c.channelId===other.channelId)!.x,stored.x+3200,'the card outside stays put');

  await page.getByRole('button',{name:'Fit',exact:true}).click();
  const far=cardAt(page,other.channelId);
  await far.waitFor();
  const frame=await box(page,'.canvas-surface');
  for(const card of [inside,far]){
    const b=await card.boundingBox();
    assert.ok(b);
    assert.ok(b.x>=frame.x&&b.y>=frame.y&&b.x+b.width<=frame.x+frame.width&&b.y+b.height<=frame.y+frame.height,`card inside the surface after Fit: ${JSON.stringify(b)} in ${JSON.stringify(frame)}`);
  }
  assert.ok(Number.parseInt(await zoomLabel(page).textContent()??'',10)<100,'Fit zoomed out');
},{canvas:true,viewport:{width:1440,height:900}});

await runChatTest('canvas surface: two editors move the same card and the stale one is refreshed',async h=>{
  const {page,base}=h;
  const id=await newCanvas(h,'Shared launch');
  const channelId=h.project.channelId;
  await call(h,'POST',`/api/canvases/${id}/cards`,{cards:[{channelId,x:120,y:120}]});
  await call(h,'POST',`/api/canvases/${id}/areas`,{id:crypto.randomUUID(),title:'Review',x:700,y:80,w:400,h:300});
  const mate=await h.loginAs('mate');
  const humans=await call<{id:string;username:string}[]>(h,'GET','/api/humans');
  const mateId=humans.find(person=>person.username==='mate')!.id;
  const share=async(role:'edit'|'view')=>{
    const {canvas}=await board(h,id);
    await call(h,'PUT',`/api/canvases/${id}/members`,{visibility:'shared',members:[{humanId:mateId,role}],version:canvas.version});
  };
  await share('edit');
  await openCanvas(page,base,id);
  await openCanvas(mate.page,base,id);
  const mine=cardAt(page,channelId),theirs=cardAt(mate.page,channelId);
  await mine.waitFor();await theirs.waitFor();

  // The mate's write is held at the API until the owner's lands, so the mate's is the stale one.
  const hold=h.holdNext(`/api/canvases/${id}/cards/${encodeURIComponent(channelId)}`);
  const mateStart=await theirs.boundingBox();assert.ok(mateStart);
  await drag(mate.page,{x:mateStart.x+40,y:mateStart.y+20},{x:mateStart.x+190,y:mateStart.y+20});
  await hold.started;
  const ownerStart=await mine.boundingBox();assert.ok(ownerStart);
  const ownerWrite=page.waitForResponse(r=>r.request().method()==='PATCH'&&r.url().includes('/cards/'));
  await drag(page,{x:ownerStart.x+40,y:ownerStart.y+20},{x:ownerStart.x+40,y:ownerStart.y+260});
  assert.equal((await ownerWrite).status(),200);
  const mateWrite=mate.page.waitForResponse(r=>r.request().method()==='PATCH'&&r.url().includes('/cards/'));
  hold.release();
  assert.equal((await mateWrite).status(),409);
  await mate.page.getByRole('status').getByText('Canvas changed. Refreshed.',{exact:true}).waitFor();
  const stored=(await board(h,id)).cards[0];
  assert.deepEqual([stored.x,stored.y],[120,360],'the owner\'s move stands');
  await mate.page.waitForFunction(([selector,x])=>{
    const el=document.querySelector(selector) as HTMLElement|null;
    return Boolean(el&&el.style.transform.includes(`translate(${x}px, 360px)`));
  },[`.canvas-card[data-channel-id="${channelId}"]`,120] as const);
  assert.equal(await page.getByText('Canvas changed. Refreshed.',{exact:true}).count(),0,'the winning editor sees no notice');

  // A viewer gets no drag handles and disabled tools.
  await share('view');
  await mate.page.reload();
  await theirs.waitFor();
  assert.equal(await mate.page.getByRole('button',{name:'Area',exact:true}).isDisabled(),true);
  assert.equal(await theirs.getAttribute('data-drag'),null);
  await mate.page.locator('[aria-label="Area Review"]').waitFor();
  assert.equal(await mate.page.locator('[aria-label="Area Review"] [data-drag]').count(),0);
  assert.equal(await mate.page.getByRole('button',{name:'Area options',exact:true}).count(),0);
},{canvas:true,viewport:{width:1440,height:900}});

await runChatTest('canvas surface: a two-finger pinch on a tablet zooms and the view is kept',async h=>{
  const {page,base}=h;
  const id=await newCanvas(h,'Tablet');
  await openCanvas(page,base,id);
  assert.equal(await zoomLabel(page).textContent(),'100%');
  const surface=await box(page,'.canvas-surface');
  const cx=Math.round(surface.x+surface.width/2),cy=Math.round(surface.y+surface.height/2);
  const cdp=await page.context().newCDPSession(page);
  const touch=(type:'touchStart'|'touchMove'|'touchEnd',spread:number)=>cdp.send('Input.dispatchTouchEvent',{type,
    touchPoints:type==='touchEnd'?[]:[{x:cx-spread,y:cy,id:0},{x:cx+spread,y:cy,id:1}]});
  await touch('touchStart',40);
  for(const spread of [48,56,63,70])await touch('touchMove',spread);
  await touch('touchEnd',0);
  await page.waitForFunction(()=>document.querySelector('[aria-label="Zoom level"]')?.textContent!=='100%');
  const zoomed=await zoomLabel(page).textContent();
  near(Number.parseInt(zoomed??'',10),175,'pinch zoom',10);

  const me=await call<{id:string}>(h,'GET','/api/auth/me');
  const key=`nest-canvas-view:${me.id}:${id}`;
  // The view is written shortly after it settles.
  const saved=await(await page.waitForFunction(storageKey=>localStorage.getItem(storageKey),key)).jsonValue() as string;
  assert.equal(Math.round(JSON.parse(saved).zoom*100)+'%',zoomed,'the view is saved per human and canvas');
  await page.reload();
  await zoomLabel(page).waitFor();
  assert.equal(await zoomLabel(page).textContent(),zoomed,'the saved zoom is restored');
},{canvas:true,viewport:{width:1024,height:768},hasTouch:true});

await runChatTest('canvas surface: a released press never resumes, and the area menu works from the keyboard',async h=>{
  const {page,base}=h;
  const id=await newCanvas(h,'Keyboard');
  const channelId=h.project.channelId;
  await call(h,'POST',`/api/canvases/${id}/cards`,{cards:[{channelId,x:200,y:200}]});
  await call(h,'POST',`/api/canvases/${id}/areas`,{id:crypto.randomUUID(),title:'Plans',x:600,y:100,w:400,h:300});
  await openCanvas(page,base,id);
  const card=cardAt(page,channelId);
  await card.waitFor();
  const before=await card.boundingBox();assert.ok(before);
  const surface=await box(page,'.canvas-surface');

  // Press on empty canvas, move under the drag threshold, release outside the surface, then hover back.
  const start={x:surface.x+60,y:surface.y+surface.height-60};
  await page.mouse.move(start.x,start.y);
  await page.mouse.down();
  await page.mouse.move(start.x+1,start.y);
  await page.mouse.move(surface.x-40,start.y);
  await page.mouse.up();
  await page.mouse.move(start.x,start.y,{steps:2});
  await page.mouse.move(start.x+80,start.y-60,{steps:6});
  await page.waitForTimeout(100);
  const after=await card.boundingBox();assert.ok(after);
  assert.deepEqual([after.x,after.y],[before.x,before.y],'hovering with the button up does not pan');

  // The area menu is a disclosure: Enter opens it, Tab reaches its buttons, Escape returns to the trigger.
  const trigger=page.getByRole('button',{name:'Area options',exact:true});
  await trigger.focus();
  await page.keyboard.press('Enter');
  assert.equal(await trigger.getAttribute('aria-expanded'),'true');
  const focused=()=>page.evaluate(()=>document.activeElement?.getAttribute('aria-label')||document.activeElement?.textContent?.trim()||'');
  await page.keyboard.press('Tab');
  assert.equal(await focused(),'Rename area');
  await page.keyboard.press('Tab');
  assert.equal(await focused(),'Delete area');
  await page.keyboard.press('Escape');
  assert.equal(await focused(),'Area options','Escape returns focus to the trigger');
  assert.equal(await trigger.getAttribute('aria-expanded'),'false');

  await page.keyboard.press('Enter');
  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab');
  const removed=page.waitForResponse(r=>r.request().method()==='DELETE'&&r.url().includes(`/api/canvases/${id}/areas/`));
  await page.keyboard.press('Enter');
  assert.equal((await removed).status(),204);
  await page.locator('[aria-label="Area Plans"]').waitFor({state:'detached'});
  assert.equal(await page.evaluate(()=>document.activeElement?.classList.contains('canvas-surface')),true,'focus lands on the surface after Delete');
},{canvas:true,viewport:{width:1440,height:900}});
