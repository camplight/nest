// Needs you and canvas search (Task 11) on the real engine, API and WS. Synthetic data.
import assert from 'node:assert/strict';
import type {Page} from 'playwright';
import {runChatTest,type ChatHarness} from '../support/chat-harness';

async function call<T>(h:ChatHarness,method:string,path:string,body?:unknown):Promise<T>{
  const response=await fetch(h.apiUrl+path,{method,headers:{cookie:h.cookie,'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
  if(!response.ok)throw Error(`${method} ${path}: ${response.status} ${await response.text()}`);
  return response.status===204?undefined as T:await response.json() as T;
}
const needsButton=(page:Page,count:number)=>page.getByRole('button',{name:`Needs you (${count})`,exact:true});
const searchDialog=(page:Page)=>page.getByRole('dialog',{name:'Search the canvas',exact:true});

await runChatTest('canvas find: Needs you from a real mention, jump to the chat, search and the composer shortcut',async h=>{
  const {page,base}=h;
  // The harness project chat is placed; an invoice project chat stays loose.
  const loose=await call<{channelId:string}>(h,'POST','/api/projects',{id:crypto.randomUUID(),name:'Synthetic invoice chat',description:'Synthetic test project',members:[]});
  const {id}=await call<{id:string}>(h,'POST','/api/canvases',{id:crypto.randomUUID(),name:'Find launch'});
  await call(h,'POST',`/api/canvases/${id}/cards`,{cards:[{channelId:h.project.channelId,x:200,y:200}]});
  await page.goto(`${base}/?view=canvas&canvas=${id}`);
  await page.locator('.canvas-surface .canvas-world').waitFor({state:'attached'});
  await needsButton(page,0).waitFor();

  // A second human mentions the owner in the placed chat, through the normal send path.
  const bob=await h.loginAs('demo-bob');
  const sent=await bob.page.evaluate(async channelId=>{
    const response=await fetch('/api/messages',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({
      id:crypto.randomUUID(),channelId,text:'@demo-owner please review the plan',mentions:[{kind:'HUMAN',name:'demo-owner',start:0,end:11}],attachments:[]})});
    return response.status;
  },h.project.channelId);
  assert.equal(sent,201);
  await needsButton(page,1).waitFor();

  // The item names the chat and the sender; clicking it centres the card and opens the chat in focus.
  await needsButton(page,1).click();
  const item=page.getByRole('list',{name:'Needs you'}).getByRole('button').first();
  assert.match(await item.innerText(),/Synthetic chat project/);
  assert.match(await item.innerText(),/demo-bob/);
  await item.click();
  const chat=page.locator('.canvas-chat');
  // The card was centred at a readable zoom (at least 0.8 of its 280 px width) while the chat opened.
  await page.waitForFunction(id=>{const card=document.querySelector(`.canvas-card[data-channel-id="${id}"]`);return !!card&&card.getBoundingClientRect().width>=224-1;},h.project.channelId);
  await chat.waitFor();
  assert.equal(await chat.getAttribute('data-mode'),'focus');
  assert.equal(new URL(page.url()).searchParams.get('chat'),h.project.channelId);
  await page.getByRole('button',{name:'Close',exact:true}).click();
  await chat.waitFor({state:'detached'});

  // Ctrl+K and "invoice" lists the loose chat under Chats elsewhere; Enter opens it.
  await page.locator('.canvas-surface').click({position:{x:5,y:5}});
  await page.keyboard.press('Control+k');
  const dialog=searchDialog(page);
  await dialog.waitFor();
  await page.keyboard.type('invoice');
  const group=dialog.getByRole('group',{name:'Chats elsewhere',exact:true});
  await group.getByRole('option',{name:/Synthetic invoice chat/}).waitFor();
  assert.equal(await dialog.getByRole('group',{name:'On this canvas',exact:true}).count(),0);
  await page.keyboard.press('Enter');
  await chat.waitFor();
  assert.equal(new URL(page.url()).searchParams.get('chat'),loose.channelId);
  await dialog.waitFor({state:'detached'});
  assert.match(await chat.locator('.canvas-chat-title').innerText(),/Synthetic invoice chat/);

  // The shortcut does nothing while typing in the composer.
  const composer=chat.getByRole('textbox',{name:'Message',exact:true});
  await composer.click();
  await page.keyboard.press('Control+k');
  assert.equal(await dialog.count(),0,'the composer keeps Ctrl+K');
  await page.getByRole('button',{name:'Close',exact:true}).click();
  await chat.waitFor({state:'detached'});

  // A card on this canvas is found by name and opens.
  await page.locator('.canvas-surface').click({position:{x:5,y:5}});
  await page.keyboard.press('Control+k');
  await dialog.waitFor();
  await page.keyboard.type('synthetic chat');
  await dialog.getByRole('group',{name:'On this canvas',exact:true}).getByRole('option').first().waitFor();
  await page.keyboard.press('Enter');
  await chat.waitFor();
  assert.equal(new URL(page.url()).searchParams.get('chat'),h.project.channelId);
  await page.getByRole('button',{name:'Close',exact:true}).click();
  await chat.waitFor({state:'detached'});

  // Escape closes the search without acting.
  await page.locator('.canvas-surface').click({position:{x:5,y:5}});
  await page.keyboard.press('Control+k');
  await dialog.waitFor();
  await page.keyboard.press('Escape');
  await dialog.waitFor({state:'detached'});
  assert.equal(await chat.count(),0);
},{canvas:true});
