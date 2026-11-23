// Working row (Task 9, spec 7.5.1, anti-goals 5.2, 5.3, 5.6): one row per active agent turn, placed after its trigger
// message (or last when the trigger is not loaded), carrying only the latest progress text. Synthetic data.
import assert from 'node:assert/strict';
import type {Page} from 'playwright';
import {createCodexOutput} from '../../../deploy/nestsystem-bridge.mjs';
import {createWrappedProgressPublisher} from '../../../packages/orgops-client/src/wrapped-progress.mjs';
import {agentName,runChatTest,type ChatHarness} from '../support/chat-harness';

const SECRETS=['private command','private arguments'];
const human=(h:ChatHarness,text:string)=>h.emit('message.created',{text,targetAgentName:agentName},{source:'human:demo-owner'});
const progress=(h:ChatHarness,triggerEventId:string,text:string)=>
  h.emit('agent.turn.phase',{phase:'wrapped-progress',text,triggerEventId,command:SECRETS[0],arguments:SECRETS[1]});
const rows=(page:Page)=>page.locator('.working-row');
const rowAfter=(page:Page,id:string)=>page.locator(`#message-${id} + .working-row`);
// The last message or working row in the list, in document order.
const lastListEntry=(page:Page)=>page.evaluate(()=>{
  const entries=[...document.querySelectorAll('.messages-panel article.message, .messages-panel .working-row')];
  return entries.at(-1)?.className??'';
});
const noSecret=async(page:Page)=>{
  const body=await page.locator('body').innerText();
  for(const secret of SECRETS){
    assert.equal(body.includes(secret),false,`"${secret}" is not on the page`);
    for(const text of await page.locator('.trace-progress').allInnerTexts())assert.equal(text.includes(secret),false,`"${secret}" is not in .trace-progress`);
  }
};

await runChatTest('working row: start, progress, move and completion',async h=>{
  const {page}=h;
  const m1=await human(h,'@Pip synthetic first request');
  await page.locator(`#message-${m1.id}`).waitFor();
  await h.emit('agent.turn.started',{triggerEventId:m1.id});
  await rowAfter(page,m1.id).filter({hasText:agentName}).waitFor();
  const box=page.getByRole('textbox',{name:'Message',exact:true});
  await box.fill('Synthetic follow-up draft');
  assert.equal(await page.getByRole('button',{name:'Send',exact:true}).isEnabled(),true,'Send is enabled while the agent works');
  await box.fill('');

  await progress(h,m1.id,'Synthetic progress one');
  await page.locator('.trace-progress').filter({hasText:'Synthetic progress one'}).waitFor();
  await progress(h,m1.id,'Synthetic progress two');
  const line=page.locator('.trace-progress');
  await line.filter({hasText:'Synthetic progress two'}).waitFor();
  assert.equal(await line.count(),1,'exactly one .trace-progress');
  assert.equal(await page.getByText('Synthetic progress one').count(),0,'the first progress text is gone');
  assert.equal(await page.locator('.message-agent').count(),0,'progress is not an agent message');
  assert.equal(await page.getByRole('status').filter({hasText:'Synthetic progress two'}).count(),1,'one status names the latest progress');
  assert.equal(await rows(page).count(),1,'one working row');

  // Codex output with private tool data: only the agent message text reaches the row (anti-goal 5.6).
  const output=createCodexOutput({publishProgress:createWrappedProgressPublisher({
    env:{ORGOPS_WRAPPED_AGENT_NAME:agentName,ORGOPS_WRAPPED_CHANNEL_ID:h.project.channelId,ORGOPS_WRAPPED_TRIGGER_EVENT_ID:m1.id,ORGOPS_RUNNER_TOKEN:'fixture-runner',ORGOPS_API_URL:h.apiUrl},
    // The harness reaches the engine through the product API, which takes the Nest runner header.
    fetchImpl:(url,init)=>{const headers=new Headers(init?.headers);headers.set('x-nest-runner-token',headers.get('x-orgops-runner-token')??'');headers.delete('x-orgops-runner-token');return fetch(url,{...init,headers});},
  })});
  const write=(event:unknown)=>output.write(JSON.stringify(event)+'\n');
  write({type:'item.completed',item:{id:'update-1',type:'agent_message',text:'Synthetic codex progress'}});
  write({type:'item.started',item:{id:'tool-1',type:'command_execution',command:SECRETS[0]}});
  write({type:'item.started',item:{id:'tool-2',type:'mcp_tool_call',arguments:SECRETS[1]}});
  await line.filter({hasText:'Synthetic codex progress'}).waitFor();
  await noSecret(page);

  // A newer turn by the same agent moves the row to its trigger.
  const m2=await human(h,'@Pip synthetic second request');
  await page.locator(`#message-${m2.id}`).waitFor();
  await h.emit('agent.turn.started',{triggerEventId:m2.id});
  await rowAfter(page,m2.id).filter({hasText:agentName}).waitFor();
  assert.equal(await rows(page).count(),1,'still one working row');
  assert.equal(await rowAfter(page,m1.id).count(),0,'no row after the first trigger');
  assert.equal(await page.locator('article.message').count(),2,'article.message count equals the loaded message.created count');
  await noSecret(page);

  await h.emit('agent.turn.completed',{triggerEventId:m2.id});
  await page.waitForFunction(()=>document.querySelectorAll('.working-row').length===0);
  await page.reload();
  await page.locator(`#message-${m2.id}`).waitFor();
  await page.waitForTimeout(500);
  assert.equal(await rows(page).count(),0,'no working row after reload');
  assert.equal(await page.locator('article.message').count(),2,'article.message count equals the loaded message.created count after reload');
});

await runChatTest('working row: wrapper turns',async h=>{
  const {page}=h;
  const m=await human(h,'@Pip synthetic wrapped request');
  await page.locator(`#message-${m.id}`).waitFor();
  await h.emit('wrapper.turn.started',{targetAgentName:agentName,triggerEventId:m.id},{source:'system:runner:wrapper'});
  await rowAfter(page,m.id).filter({hasText:agentName}).waitFor();
  await h.emit('wrapper.turn.completed',{targetAgentName:agentName,triggerEventId:m.id},{source:'system:runner:wrapper'});
  await page.waitForFunction(()=>document.querySelectorAll('.working-row').length===0);
});

await runChatTest('working row: start-less page and agent stop',async h=>{
  const {page}=h;
  // The fixture agent is the harness's Pip, created as codex-progress.mjs creates its agent (POST /api/agents with
  // name, icon, visibility, modelId wrapped:none and a workspace path, no desiredState). The engine defaults its
  // desiredState to RUNNING and, with no runner, its runtimeState to STOPPED; its updatedAt is its creation time,
  // which is before the turn starts, so the row shows until a stop sets desiredState STOPPED with a later updatedAt.
  const m=await human(h,'@Pip synthetic long request');
  await page.locator(`#message-${m.id}`).waitFor();
  await h.emit('agent.turn.started',{triggerEventId:m.id});
  // More phases than the largest adaptive page (50), so the start is outside the loaded page after a reload.
  for(let index=1;index<=70;index++)await progress(h,m.id,`Synthetic phase ${index} of 70`);
  await page.reload();
  await page.locator('.working-row .trace-progress').filter({hasText:'Synthetic phase 70 of 70'}).waitFor();
  assert.equal(await rows(page).count(),1,'one working row after reload');
  assert.equal(await page.getByText('Synthetic phase 69 of 70').count(),0,'only the latest phase shows');

  const stop=await h.post(`/api/agents/${agentName}/stop`,{});
  assert.equal(stop.ok,true,`stop: ${stop.status}`);
  await page.waitForFunction(()=>document.querySelectorAll('.working-row').length===0,undefined,{timeout:11000});
});

await runChatTest('working row: trigger outside the loaded page',async h=>{
  const {page}=h;
  const m=await human(h,'@Pip synthetic early request');
  for(let index=1;index<=55;index++)await h.emit('message.created',{text:`Synthetic later message ${index}`},{source:'human:demo-owner'});
  await h.emit('agent.turn.started',{triggerEventId:m.id});
  await page.reload();
  await page.locator('article.message').filter({hasText:'Synthetic later message 55'}).waitFor();
  await rows(page).filter({hasText:agentName}).waitFor();
  assert.equal(await page.locator(`#message-${m.id}`).count(),0,'the trigger is not loaded');
  assert.match(await lastListEntry(page),/\bworking-row\b/,'the row is last in the list');
  assert.equal(await rows(page).count(),1,'one working row');
});
