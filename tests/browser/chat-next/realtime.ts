// Realtime in the new chat (Task 7, folded Task 8): another human's message, status republish dedup for the store,
// unread badges and nest-message, channel switches while a page load is held, and a WebSocket reconnect. Synthetic data.
import assert from 'node:assert/strict';
import type {Page} from 'playwright';
import {runChatTest,type ChatHarness} from '../support/chat-harness';

// Added after the tests commit (additions only): a ?channel= link to a project chat first renders in the workspace
// view, then remounts in the project view; wait for that before counting.
const settled=(page:Page)=>page.waitForFunction(()=>new URL(location.href).searchParams.has('project')&&!document.querySelector('.standalone-workspace')&&!!document.querySelector('.messages-panel'));
const runner={'content-type':'application/json','x-nest-runner-token':'fixture-runner'};
const ack=async(h:ChatHarness,id:string)=>{const response=await h.post(`/api/events/${id}/ack`,{},runner);assert.equal(response.ok,true,`ack ${id}: ${response.status}`);};
const otherProject=async(h:ChatHarness)=>await(await h.post('/api/projects',{id:crypto.randomUUID(),name:'Synthetic other project',description:'Synthetic test project',members:[{subscriberType:'AGENT',subscriberId:'Pip'}]})).json() as {id:string;channelId:string};
const projectLink=(page:Page,name:string)=>page.locator('.project-navigation-link',{hasText:name});
const nestMessages=(page:Page)=>page.evaluate(()=>(window as unknown as {__nestMessages:number}).__nestMessages);

await runChatTest('realtime: a second human posts',async h=>{
  const {page}=h;
  await page.goto(`${h.base}/?channel=${h.project.channelId}`);
  await settled(page);
  await page.getByRole('textbox',{name:'Message',exact:true}).waitFor();
  assert.equal(await page.locator('.nest-chat').count(),1,'the new chat root .nest-chat exists');
  const {page:second}=await h.loginAs('synthetic-second');
  await second.locator('.nest-chat').waitFor();
  const box=second.getByRole('textbox',{name:'Message',exact:true});
  await box.fill('Synthetic hello from the second human');
  await box.press('Enter');
  const started=Date.now();
  await page.locator('.nest-chat article.message-human').filter({hasText:'Synthetic hello from the second human'}).waitFor({timeout:3000});
  assert.ok(Date.now()-started<=3000,'appears within 3 s without reload');
  assert.equal(await page.locator('.nest-chat article.message').filter({hasText:'Synthetic hello from the second human'}).count(),1,'shown once');
});

await runChatTest('realtime: status republish counts once',async h=>{
  const {page}=h;
  const other=await otherProject(h);
  await page.goto(`${h.base}/?channel=${h.project.channelId}`);
  await settled(page);
  await page.locator('.nest-chat').waitFor();
  assert.equal(await page.locator('.nest-chat').count(),1,'the new chat root .nest-chat exists');
  await page.evaluate(()=>{const w=window as unknown as {__nestMessages:number};w.__nestMessages=0;window.addEventListener('nest-message',()=>{w.__nestMessages++;});});

  // Open channel: emitted, then republished as ACKED.
  const open=await h.emit('message.created',{text:'Synthetic open-channel message'});
  await page.locator(`#message-${open.id}`).waitFor({timeout:3000});
  await ack(h,open.id);
  await page.waitForTimeout(800);
  assert.equal(await page.locator(`#message-${open.id}`).count(),1,'exactly one #message-<id> after the republish');
  assert.equal(await nestMessages(page),1,'one nest-message for the open-channel message and its republish');

  // Closed channel: the badge goes up by one, not two.
  const closed=await h.emit('message.created',{text:'Synthetic closed-channel message'},{channelId:other.channelId});
  const badge=projectLink(page,'Synthetic other project').locator('.project-navigation-unread');
  await badge.waitFor({timeout:3000});
  assert.equal(await badge.innerText(),'1','unread badge 1 after the first sighting');
  await ack(h,closed.id);
  await page.waitForTimeout(800);
  assert.equal(await badge.innerText(),'1','unread badge still 1 after the republish');
  assert.equal(await nestMessages(page),2,'one nest-message for the closed-channel message and its republish');
  // The republish of a closed channel's event never enters the open chat.
  assert.equal(await page.locator(`#message-${closed.id}`).count(),0,'closed-channel republish not ingested into the open chat');
  await projectLink(page,'Synthetic other project').click();
  await page.locator(`#message-${closed.id}`).waitFor({timeout:5000});
  assert.equal(await page.locator(`#message-${closed.id}`).count(),1,'closed-channel message shows once when opened');
  assert.equal(await page.locator(`#message-${open.id}`).count(),0,'no message from the first channel');
});

await runChatTest('realtime: switching channels while a page load is held',async h=>{
  const {page}=h;
  const other=await otherProject(h);
  await h.emit('message.created',{text:'Synthetic first-channel message'});
  await h.emit('message.created',{text:'Synthetic other-channel message'},{channelId:other.channelId});
  await page.goto(`${h.base}/?channel=${h.project.channelId}`);
  await settled(page);
  await page.locator('.nest-chat').getByText('Synthetic first-channel message',{exact:true}).waitFor();
  assert.equal(await page.locator('.nest-chat').count(),1,'the new chat root .nest-chat exists');
  await page.evaluate(()=>{
    const w=window as unknown as {__sawOther:boolean};w.__sawOther=false;
    new MutationObserver(()=>{if(document.querySelector('.nest-chat')?.textContent?.includes('Synthetic other-channel message'))w.__sawOther=true;})
      .observe(document.body,{subtree:true,childList:true,characterData:true});
  });
  const hold=h.holdNext('/api/events',{query:{channelId:other.channelId}});
  await projectLink(page,'Synthetic other project').click();
  await hold.started;
  await projectLink(page,'Synthetic chat project').click();
  await page.locator('.nest-chat').getByText('Synthetic first-channel message',{exact:true}).waitFor({timeout:5000});
  hold.release();
  await page.waitForTimeout(1500);
  assert.equal(await page.evaluate(()=>(window as unknown as {__sawOther:boolean}).__sawOther),false,'the other channel never shows in the first');
  assert.equal(await page.locator('.nest-chat').getByText('Synthetic first-channel message',{exact:true}).count(),1,'first channel still shown');
});

await runChatTest('realtime: WebSocket closed and reopened',async h=>{
  const {page}=h;
  await page.goto(`${h.base}/?channel=${h.project.channelId}`);
  await settled(page);
  await page.locator('.nest-chat').waitFor();
  assert.equal(await page.locator('.nest-chat').count(),1,'the new chat root .nest-chat exists');
  await page.evaluate(()=>{(window as unknown as {__noReload:boolean}).__noReload=true;});
  await h.closeWebSocket();
  const offline=await h.emit('message.created',{text:'Synthetic message while the socket is down'});
  await h.reopenWebSocket();
  await page.locator(`#message-${offline.id}`).waitFor({timeout:15000});
  assert.equal(await page.evaluate(()=>(window as unknown as {__noReload?:boolean}).__noReload),true,'appeared without a reload');
  assert.equal(await page.locator(`#message-${offline.id}`).count(),1,'shown once');
});

// Added after the tests commit (T7-R1, D-T7-R1-1): republishes in any status order, a later one lowering the status
// included, keep one shell with the same text and one nest-message; the thread renders no delivery status.
await runChatTest('realtime: republishes in any status order',async h=>{
  const {page}=h;
  await page.goto(`${h.base}/?channel=${h.project.channelId}`);
  await settled(page);
  await page.locator('.nest-chat').waitFor();
  assert.equal(await page.locator('.nest-chat').count(),1,'the new chat root .nest-chat exists');
  await page.evaluate(()=>{const w=window as unknown as {__nestMessages:number};w.__nestMessages=0;window.addEventListener('nest-message',()=>{w.__nestMessages++;});});
  const message=await h.emit('message.created',{text:'Synthetic republished message'});
  await page.locator(`#message-${message.id}`).waitFor({timeout:3000});
  await ack(h,message.id);
  const failed=await h.post(`/api/events/${message.id}/fail`,{error:'Synthetic failure'},runner);
  assert.equal(failed.ok,true,`fail ${message.id}: ${failed.status}`);
  await ack(h,message.id);
  await page.waitForTimeout(800);
  const shell=page.locator(`#message-${message.id}`);
  assert.equal(await shell.count(),1,'exactly one #message-<id> after ACKED, FAILED, ACKED');
  assert.match(await shell.innerText(),/Synthetic republished message/,'the shell keeps its text');
  assert.equal(await nestMessages(page),1,'one nest-message for the message and its republishes');
  assert.equal(await page.locator('.nest-chat article.message').count(),1,'no extra message from a republish');
});
