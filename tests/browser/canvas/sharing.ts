// Canvas switcher and sharing (Task 10): two sessions on the real engine, API and WS. Synthetic data.
import assert from 'node:assert/strict';
import type {Page} from 'playwright';
import {runChatTest,type ChatHarness} from '../support/chat-harness';

async function call<T>(h:ChatHarness,method:string,path:string,body?:unknown):Promise<T>{
  const response=await fetch(h.apiUrl+path,{method,headers:{cookie:h.cookie,'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
  if(!response.ok)throw Error(`${method} ${path}: ${response.status} ${await response.text()}`);
  return response.status===204?undefined as T:await response.json() as T;
}
const cardAt=(page:Page,channelId:string)=>page.locator(`.canvas-card[data-channel-id="${channelId}"]`);
const switcher=(page:Page)=>page.getByRole('button',{name:'Switch canvas',exact:true});
const menu=(page:Page)=>page.getByRole('menu',{name:'Canvases',exact:true});
async function drag(page:Page,from:{x:number;y:number},to:{x:number;y:number}){
  await page.mouse.move(from.x,from.y);
  await page.mouse.down();
  await page.mouse.move((from.x+to.x)/2,(from.y+to.y)/2,{steps:4});
  await page.mouse.move(to.x,to.y,{steps:4});
  await page.mouse.up();
}
/** The owner's Share dialog: pick the visibility and each person's role, then Save. */
async function share(page:Page,visibility:'Private'|'Shared with chosen people',people:{username:string;role?:'Can edit'|'Can view'}[]=[]){
  await page.getByRole('button',{name:'Share',exact:true}).click();
  const dialog=page.getByRole('dialog',{name:'Share canvas',exact:true});
  await dialog.waitFor();
  await dialog.getByRole('radio',{name:visibility,exact:true}).check();
  for(const person of people){
    const box=dialog.getByRole('checkbox',{name:person.username,exact:true});
    if(!await box.isChecked())await box.check();
    await dialog.getByRole('combobox',{name:`Access for ${person.username}`,exact:true}).selectOption({label:person.role??'Can view'});
  }
  const saved=page.waitForResponse(r=>r.request().method()==='PUT'&&r.url().endsWith('/members'));
  await dialog.getByRole('button',{name:'Save',exact:true}).click();
  assert.equal((await saved).status(),200);
  await dialog.waitFor({state:'detached'});
}

await runChatTest('canvas sharing: view, locked card, edit, unshare and delete',async h=>{
  const {page,base}=h;
  const secret='Hidden roadmap rehearsal';
  const hidden=(await call<{id:string}>(h,'POST','/api/channels',{name:secret,visibility:'PRIVATE'})).id;
  const {id}=await call<{id:string}>(h,'POST','/api/canvases',{id:crypto.randomUUID(),name:'Launch'});
  await call(h,'POST',`/api/canvases/${id}/cards`,{cards:[{channelId:h.project.channelId,x:120,y:120},{channelId:hidden,x:620,y:120}]});
  const mate=await h.loginAs('mate');
  await page.goto(`${base}/?view=canvas&canvas=${id}`);
  await cardAt(page,h.project.channelId).waitFor();

  // View access.
  await share(page,'Shared with chosen people',[{username:'mate',role:'Can view'}]);
  await mate.page.goto(`${base}/?view=canvas`);
  const theirs=cardAt(mate.page,h.project.channelId);
  await theirs.waitFor();
  assert.equal(new URL(mate.page.url()).searchParams.get('canvas'),id,'a lone shared canvas opens by itself');
  await switcher(mate.page).click();
  const shared=menu(mate.page);
  await shared.getByText('Shared with you',{exact:true}).waitFor();
  assert.ok(await shared.getByRole('menuitem',{name:/Launch/}).getByText('Can view',{exact:true}).count());
  await mate.page.keyboard.press('Escape');
  assert.equal(await mate.page.getByText('Shared by demo-owner',{exact:true}).count(),1,'others see who shared it');
  assert.equal(await mate.page.getByRole('button',{name:'Share',exact:true}).count(),0,'only the owner shares');
  assert.equal(await theirs.getAttribute('data-drag'),null);
  assert.equal(await mate.page.getByRole('button',{name:'Area',exact:true}).isDisabled(),true);

  // A chat the teammate is not in stays private, in the whole page.
  const locked=cardAt(mate.page,hidden);
  await locked.waitFor();
  await locked.getByText('Private chat',{exact:true}).waitFor();
  await locked.getByText('Owner: demo-owner',{exact:true}).waitFor();
  assert.ok(!(await mate.page.content()).includes(secret),'the private chat title is nowhere on the page');

  // Edit access reaches the teammate on the next poll, without a reload.
  await share(page,'Shared with chosen people',[{username:'mate',role:'Can edit'}]);
  await mate.page.waitForFunction(selector=>document.querySelector(selector)?.getAttribute('data-drag')==='card',`.canvas-card[data-channel-id="${h.project.channelId}"]`,{timeout:9000});
  const start=await theirs.boundingBox();assert.ok(start);
  const write=mate.page.waitForResponse(r=>r.request().method()==='PATCH'&&r.url().includes('/cards/'));
  await drag(mate.page,{x:start.x+40,y:start.y+20},{x:start.x+190,y:start.y+20});
  assert.equal((await write).status(),200);
  await page.waitForFunction(selector=>{
    const x=Number.parseFloat((document.querySelector(selector) as HTMLElement|null)?.style.transform.match(/translate\((-?[\d.]+)px/)?.[1]??'');
    return x>=265&&x<=275;
  },`.canvas-card[data-channel-id="${h.project.channelId}"]`,{timeout:9000});

  // Unsharing: the teammate is told, and the menu opens.
  await share(page,'Private');
  await mate.page.getByText('This canvas is no longer shared with you',{exact:true}).waitFor({timeout:9000});
  await menu(mate.page).waitFor();
  assert.equal(await menu(mate.page).getByRole('menuitem',{name:/Launch/}).count(),0,'the canvas left their list');
  assert.equal(new URL(mate.page.url()).searchParams.get('canvas'),id,'no redirect loop');

  // Delete: confirmation says chats stay; then the first-canvas prompt.
  await switcher(page).click();
  await menu(page).getByRole('menuitem',{name:'Delete canvas…',exact:true}).click();
  const confirm=page.getByRole('dialog',{name:'Delete canvas',exact:true});
  await confirm.getByText('Delete canvas "Launch"? The chats on it are not deleted.',{exact:true}).waitFor();
  await confirm.getByRole('button',{name:'Delete canvas',exact:true}).click();
  await page.getByRole('heading',{name:'Create your first canvas',exact:true}).waitFor();
  const channels=await call<{id:string}[]>(h,'GET','/api/channels');
  assert.ok([h.project.channelId,hidden].every(channel=>channels.some(c=>c.id===channel)),'the chats still exist');
  await page.goto(`${base}/?channel=${hidden}`);
  await page.getByRole('textbox',{name:'Message',exact:true}).waitFor();
},{canvas:true,viewport:{width:1440,height:900}});

await runChatTest('canvas switcher: new canvas, rename, and the nav does not stack history',async h=>{
  const {page,base}=h;
  const first=(await call<{id:string}>(h,'POST','/api/canvases',{id:crypto.randomUUID(),name:'Launch'})).id;
  await page.goto(`${base}/?view=canvas&canvas=${first}`);
  await page.locator('.canvas-name').getByText('Launch',{exact:true}).waitFor();

  await switcher(page).click();
  await menu(page).getByText('Yours',{exact:true}).waitFor();
  await menu(page).getByRole('menuitem',{name:'New canvas',exact:true}).click();
  const naming=page.getByRole('dialog',{name:'New canvas',exact:true});
  await naming.getByRole('textbox',{name:'Canvas name',exact:true}).fill('Roadmap');
  await naming.getByRole('button',{name:'Create canvas',exact:true}).click();
  await page.locator('.canvas-name').getByText('Roadmap',{exact:true}).waitFor();
  assert.notEqual(new URL(page.url()).searchParams.get('canvas'),first);

  await switcher(page).click();
  await menu(page).getByRole('menuitem',{name:'Rename',exact:true}).click();
  const renaming=page.getByRole('dialog',{name:'Rename canvas',exact:true});
  await renaming.getByRole('textbox',{name:'Canvas name',exact:true}).fill('Roadmap 2027');
  await renaming.getByRole('button',{name:'Rename',exact:true}).click();
  await page.locator('.canvas-name').getByText('Roadmap 2027',{exact:true}).waitFor();

  await switcher(page).click();
  await menu(page).getByRole('menuitem',{name:/Launch/}).click();
  await page.locator('.canvas-name').getByText('Launch',{exact:true}).waitFor();

  // Clicking Canvas while on a canvas re-opens the most recent one without a duplicate entry.
  const before=await page.evaluate(()=>history.length);
  await page.getByRole('navigation',{name:'Main navigation'}).getByRole('button',{name:'Canvas',exact:true}).click();
  await page.locator('.canvas-name').waitFor();
  assert.ok(await page.evaluate(()=>history.length)<=before,'no extra history entry');
  assert.equal(await page.getByRole('heading',{name:'Create your first canvas',exact:true}).count(),0);
},{canvas:true,viewport:{width:1440,height:900}});
