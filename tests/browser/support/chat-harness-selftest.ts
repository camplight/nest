// Self-test of the chat harness on the classic chat: two calls in one file, each on fresh servers.
import assert from 'node:assert/strict';
import {runChatTest} from './chat-harness';

await runChatTest('harness on desktop',async h=>{
  await h.emit('message.created',{text:'Synthetic harness message over WebSocket'});
  await h.page.getByText('Synthetic harness message over WebSocket',{exact:true}).waitFor({timeout:3000});
  const {fileId}=await h.upload('synthetic-note.txt',new TextEncoder().encode('Synthetic upload'),'text/plain');
  const meta=await fetch(`${h.apiUrl}/api/files/${fileId}/meta`,{headers:{cookie:h.cookie}});
  assert.equal(meta.status,200,'uploaded file has metadata');
  const hold=h.holdNext('/api/events');let answered=false;
  const held=h.emit('message.created',{text:'Synthetic held message'}).then(result=>{answered=true;return result;});
  await hold.started;await new Promise(resolve=>setTimeout(resolve,300));
  assert.equal(answered,false,'held request waits for release');
  hold.release();assert.ok((await held).id);
  // A query filter holds only the request whose search params include every pair: the unread poll passes, the channel page waits.
  const pageHold=h.holdNext('/api/events',{query:{channelId:h.project.channelId}});
  const get=(path:string)=>fetch(h.apiUrl+path,{headers:{cookie:h.cookie}});
  const timeout=(ms:number)=>new Promise<'timeout'>(resolve=>setTimeout(()=>resolve('timeout'),ms));
  const poll=await Promise.race([get('/api/events?type=message.created&limit=100&order=desc'),timeout(3000)]);
  assert.notEqual(poll,'timeout','unread poll is not held by a channelId filter');
  assert.equal((poll as Response).status,200,'unread poll answers');
  let pageAnswered=false;
  const channelPage=get(`/api/events?limit=50&order=desc&type=message.created&channelId=${h.project.channelId}`).then(response=>{pageAnswered=true;return response;});
  assert.notEqual(await Promise.race([pageHold.started,timeout(3000)]),'timeout','channel page query is held');
  await new Promise(resolve=>setTimeout(resolve,300));
  assert.equal(pageAnswered,false,'channel page query waits for release');
  pageHold.release();assert.equal((await channelPage).status,200,'released channel page query answers');
  const {page}=await h.loginAs('synthetic-second');
  await page.getByRole('button',{name:'Account',exact:true}).click();
  await page.getByRole('menu',{name:'Account menu'}).getByText('synthetic-second',{exact:true}).waitFor();
},{chatUi:'classic'});

await runChatTest('harness on a 390 px touch screen',async h=>{
  assert.deepEqual(h.page.viewportSize(),{width:390,height:844});
  await h.emit('message.created',{text:'Synthetic touch message'});
  const message=h.page.getByText('Synthetic touch message',{exact:true});
  await message.waitFor({timeout:3000});
  await message.tap();
  await h.closeWebSocket();
  await h.emit('message.created',{text:'Synthetic message while offline'});
  await new Promise(resolve=>setTimeout(resolve,1500));
  assert.equal(await h.page.getByText('Synthetic message while offline',{exact:true}).count(),0,'no WebSocket delivery while closed');
  await h.reopenWebSocket();
  await h.page.getByText('Synthetic message while offline',{exact:true}).waitFor({timeout:12000});
},{chatUi:'classic',viewport:{width:390,height:844},hasTouch:true});
