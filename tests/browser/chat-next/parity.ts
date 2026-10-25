// Parity default (Task 17, spec 10): with no ?chatUi, no nest:chat-ui and no VITE_NEST_CHAT_UI the new chat renders.
// Run with VITE_NEST_CHAT_UI unset. The working row is placed after its trigger on the default chat (from T9-V1).
// Synthetic data.
import assert from 'node:assert/strict';
import {agentName,runChatTest} from '../support/chat-harness';

await runChatTest('parity: the unset default renders the new chat',async h=>{
  const {page}=h;
  // The harness has opened h.project's chat (?view=projects&project=<id>).
  await page.locator('.messages-panel').first().waitFor();
  assert.equal(await page.locator('.nest-chat').count(),1,'a project chat has .nest-chat');

  const m1=await h.emit('message.created',{text:'@Pip synthetic parity request',targetAgentName:agentName},{source:'human:demo-owner'});
  await page.locator(`#message-${m1.id}`).waitFor();
  assert.equal(await page.locator(`#message-${m1.id}`).count(),1,'one #message-<id>');
  assert.equal(await page.locator('.message-human').count(),1,'one .message-human');
  await h.emit('agent.turn.started',{triggerEventId:m1.id});
  await page.locator(`#message-${m1.id} + .working-row`).filter({hasText:agentName}).waitFor();
  assert.equal(await page.locator('.working-row').count(),1,'one working row, directly after its trigger');
},{chatUi:'unset'});
