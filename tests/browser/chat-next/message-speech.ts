import assert from 'node:assert/strict';
import {runChatTest} from '../support/chat-harness';

await runChatTest('message speech: generate on demand, retry errors, close and cancel',async h=>{
  const {page}=h;
  const target=await h.emit('message.created',{text:'Synthetic speech fixture. Hello team.'});
  let requests=0, fail=true;
  // A tiny valid PCM waveform exercises the browser player without paid provider calls.
  const wav=Buffer.alloc(44+1600);
  wav.write('RIFF',0);wav.writeUInt32LE(wav.length-8,4);wav.write('WAVEfmt ',8);wav.writeUInt32LE(16,16);
  wav.writeUInt16LE(1,20);wav.writeUInt16LE(1,22);wav.writeUInt32LE(8000,24);wav.writeUInt32LE(16000,28);wav.writeUInt16LE(2,32);wav.writeUInt16LE(16,34);wav.write('data',36);wav.writeUInt32LE(1600,40);
  await page.route('**/api/speech/messages/*',async route=>{
    requests++;
    assert.equal(route.request().method(),'POST');
    assert.equal(route.request().postData(),null);
    await route.fulfill(fail?{status:502,json:{error:'Synthetic speech failure'}}:{contentType:'audio/wav',body:wav});
  });
  await page.goto(`${h.base}/?channel=${h.project.channelId}`);
  const message=page.locator(`#message-${target.id}`);
  await message.getByRole('button',{name:'Listen to message'}).waitFor();
  assert.equal(requests,0);
  await message.getByRole('button',{name:'Listen to message'}).click();
  await message.getByRole('alert').filter({hasText:'Synthetic speech failure'}).waitFor();
  fail=false;
  await message.getByRole('button',{name:'Listen to message'}).click();
  await message.locator('audio').waitFor();
  assert.equal(await message.locator('audio').getAttribute('controls'),'');
  assert.equal(requests,2);
  await message.locator('audio').evaluate(async node=>{await (node as HTMLAudioElement).play();});
  await page.setViewportSize({width:390,height:844});
  const box=await message.locator('audio').boundingBox();assert(box&&box.x>=0&&box.x+box.width<=390);
  if(process.env.CI)console.log('SPEECH_PLAYER_MOBILE_JPEG:'+(await message.screenshot({type:'jpeg',quality:75})).toString('base64'));
  await page.setViewportSize({width:1440,height:1000});
  if(process.env.CI)console.log('SPEECH_PLAYER_DESKTOP_JPEG:'+(await message.screenshot({type:'jpeg',quality:75})).toString('base64'));
  await message.getByRole('button',{name:'Close audio'}).click();
  assert.equal(await message.locator('audio').count(),0);
  await page.unroute('**/api/speech/messages/*');
  await page.route('**/api/speech/messages/*',()=>{});
  await message.getByRole('button',{name:'Listen to message'}).click();
  await message.getByRole('button',{name:'Cancel',exact:true}).click();
  assert(await message.getByRole('button',{name:'Listen to message'}).isEnabled());
});
