// Quote-reply in the new chat (Task 16, spec 7.2.3, 7.2.4, 7.3, 7.4.4, 7.4.5): Quote and Quote selection fill the
// composer and set a reply target, the send carries replyTo and nothing else, and replies link back to their target.
// Synthetic test data only.
import assert from 'node:assert/strict';
import type {Locator,Page} from 'playwright';
import {runChatTest,type ChatHarness} from '../support/chat-harness';

type Posted={id:string;text:string;mentions:unknown[];replyTo?:string;targetAgentName?:unknown;targetAgentNames?:unknown};
const settled=(page:Page)=>page.waitForFunction(()=>new URL(location.href).searchParams.has('project')&&!document.querySelector('.standalone-workspace')&&!!document.querySelector('.messages-panel'));
const chatUrl=(h:ChatHarness)=>`${h.base}/?channel=${h.project.channelId}`;
const textbox=(page:Page)=>page.getByRole('textbox',{name:'Message',exact:true});
const sendButton=(page:Page)=>page.locator('form.composer button:not([type="button"])');
const composerChip=(page:Page)=>page.locator('form.composer').getByText('Replying to Pip',{exact:true});
const replyLink=(scope:Locator)=>scope.getByRole('button',{name:'Replying to Pip'});
const posts=(page:Page)=>{
  const bodies:Posted[]=[];
  page.on('request',request=>{if(request.method()==='POST'&&new URL(request.url()).pathname==='/api/messages')bodies.push(JSON.parse(request.postData()??'{}') as Posted);});
  return bodies;
};
const quote=async(page:Page,message:Locator)=>{
  await message.hover();
  await message.getByRole('button',{name:'Quote',exact:true}).click();
};
const toEnd=(page:Page)=>textbox(page).evaluate(node=>{const area=node as HTMLTextAreaElement;area.focus();area.setSelectionRange(area.value.length,area.value.length);});
const sent=(page:Page)=>page.waitForFunction(()=>(document.querySelector('textarea[aria-label="Message"]') as HTMLTextAreaElement|null)?.value==='');
// Selects `part` inside the first text node under `selector` that holds it, the way a reader drags across it.
const selectPart=(page:Page,selector:string,part:string)=>page.evaluate(({selector,part})=>{
  const scope=document.querySelector(selector);
  if(!scope)throw new Error(`no ${selector}`);
  const walker=document.createTreeWalker(scope,NodeFilter.SHOW_TEXT);
  for(let node=walker.nextNode();node;node=walker.nextNode()){
    const at=node.textContent?.indexOf(part)??-1;
    if(at<0)continue;
    const range=document.createRange();
    range.setStart(node,at);range.setEnd(node,at+part.length);
    const selection=window.getSelection()!;
    selection.removeAllRanges();selection.addRange(range);
    return;
  }
  throw new Error(`no "${part}" under ${selector}`);
},{selector,part});
// Tailwind size, inset, position and transform utilities, with any variant prefix (spec 7.4.5).
const LAYOUT_UTILITY=/^-?(?:w-|h-|size-|min-w-|min-h-|max-w-|max-h-|top-|left-|right-|bottom-|inset-|translate-|scale-|rotate-)|^(?:absolute|fixed|relative|sticky|transform)$/;
const layoutUtilities=(classes:string)=>classes.split(/\s+/).filter(Boolean).filter(token=>LAYOUT_UTILITY.test(token.split(':').pop()!.replace(/^!/,'')));

await runChatTest('quote-reply: quote, send, see the link, follow it',async h=>{
  const {page}=h;
  const target=await h.emit('message.created',{text:'Synthetic test data: Pip first line\nSynthetic second line'});
  await page.goto(chatUrl(h));
  await settled(page);
  const original=page.locator(`#message-${target.id}`);
  await original.waitFor();

  // First statement: Quote on Pip's message shows the reply chip.
  await quote(page,original);
  await composerChip(page).waitFor({timeout:3000});
  const value=await textbox(page).inputValue();
  assert.ok(value.startsWith('> **Pip** wrote:\n> Synthetic test data: Pip first line\n> Synthetic second line\n\n'),`the composer starts with the blockquote (got ${JSON.stringify(value)})`);

  const bodies=posts(page);
  await toEnd(page);
  await textbox(page).pressSequentially('Synthetic reply text');
  await sendButton(page).click();
  await sent(page);
  assert.equal(bodies.length,1,'one POST for the reply');
  const body=bodies[0]!;
  assert.equal(body.replyTo,target.id,'the send carries replyTo');
  assert.equal('targetAgentName' in body,false,'the reply adds no targetAgentName');
  assert.equal('targetAgentNames' in body,false,'the reply adds no targetAgentNames');
  assert.deepEqual(body.mentions,[],'the reply adds no mention the user did not type');
  assert.equal(await composerChip(page).count(),0,'the chip leaves after a confirmed send');

  const reply=page.locator('.nest-chat article.message',{hasText:'Synthetic reply text'});
  await replyLink(reply).waitFor({timeout:5000});
  await replyLink(reply).click();
  await page.locator(`#message-${target.id}.message-highlight`).waitFor({timeout:3000});
});

await runChatTest('quote-reply: cancel removes chip and quote, reload keeps the chip',async h=>{
  const {page}=h;
  const target=await h.emit('message.created',{text:'Synthetic test data: cancel target'});
  await page.goto(chatUrl(h));
  await settled(page);
  const original=page.locator(`#message-${target.id}`);
  await original.waitFor();
  await quote(page,original);
  await composerChip(page).waitFor({timeout:3000});
  await toEnd(page);
  await textbox(page).pressSequentially('Synthetic kept text');
  await page.getByText('Draft saved on this device',{exact:true}).waitFor({timeout:3000});

  await page.reload();
  await settled(page);
  await composerChip(page).waitFor({timeout:5000});
  assert.ok((await textbox(page).inputValue()).startsWith('> **Pip** wrote:'),'reload keeps the quote');

  await page.locator('form.composer').getByRole('button',{name:'Cancel reply'}).click();
  assert.equal(await composerChip(page).count(),0,'Cancel reply removes the chip');
  assert.equal(await textbox(page).inputValue(),'Synthetic kept text','Cancel reply removes the quote and keeps the typed text');
  await page.reload();
  await settled(page);
  await textbox(page).waitFor();
  await page.waitForFunction(()=>(document.querySelector('textarea[aria-label="Message"]') as HTMLTextAreaElement|null)?.value==='Synthetic kept text');
  assert.equal(await composerChip(page).count(),0,'a cancelled reply stays cancelled after reload');
});

await runChatTest('quote-reply: a failed send keeps the target, cancelling it posts a new id',async h=>{
  const {page}=h;
  const target=await h.emit('message.created',{text:'Synthetic test data: retry target'});
  const bodies=posts(page);
  let failNext=true;
  await page.route('**/api/messages',route=>{
    if(route.request().method()==='POST'&&failNext){failNext=false;return route.fulfill({status:503,contentType:'application/json',body:'{"error":"Synthetic outage"}'});}
    return route.continue();
  });
  await page.goto(chatUrl(h));
  await settled(page);
  const original=page.locator(`#message-${target.id}`);
  await original.waitFor();
  await quote(page,original);
  await composerChip(page).waitFor({timeout:3000});
  await toEnd(page);
  await textbox(page).pressSequentially('Synthetic retry reply');
  const typed=await textbox(page).inputValue();
  await sendButton(page).click();
  await page.waitForFunction(()=>document.querySelector('[role="alert"].notice'));
  await page.waitForFunction(()=>document.querySelector('form.composer button:not([type="button"])')?.textContent==='Send');
  assert.equal(bodies.length,1,'one POST before the retry');
  assert.equal(bodies[0]!.replyTo,target.id,'the failed send carried replyTo');
  assert.equal(await composerChip(page).count(),1,'a failed send keeps the reply target');
  assert.equal(await textbox(page).inputValue(),typed,'a failed send keeps the text');

  // Same text without the reply: only replyTo differs, so the id must change.
  await page.locator('form.composer').getByRole('button',{name:'Cancel reply'}).click();
  await textbox(page).fill(typed);
  await sendButton(page).click();
  await sent(page);
  assert.equal(bodies.length,2,'the retry posts once');
  assert.equal(bodies[1]!.text,bodies[0]!.text,'the retry posts the same text');
  assert.equal(bodies[1]!.replyTo,undefined,'the retry carries no replyTo');
  assert.notEqual(bodies[1]!.id,bodies[0]!.id,'cancelling the reply before the retry posts a new id');
});

await runChatTest('quote-reply: a target outside the loaded page still links',async h=>{
  const {page}=h;
  const target=await h.emit('message.created',{text:'Synthetic test data: far target'});
  for(let index=0;index<60;index++)await h.emit('message.created',{text:`Synthetic filler ${index}`},{source:'human:demo-owner'});
  const reply=await h.emit('message.created',{text:'Synthetic far reply',inReplyTo:target.id});
  const lookup=page.waitForRequest(request=>request.method()==='GET'&&new URL(request.url()).pathname===`/api/events/${target.id}`,{timeout:10000});
  await page.goto(chatUrl(h));
  await settled(page);
  const replyShell=page.locator(`#message-${reply.id}`);
  await replyShell.waitFor();
  assert.equal(await page.locator(`#message-${target.id}`).count(),0,'the target is outside the loaded page');
  await lookup;
  await replyLink(replyShell).waitFor({timeout:5000});
  await replyLink(replyShell).click();
  await page.locator(`#message-${target.id}.message-highlight`).waitFor({timeout:8000});
});

await runChatTest('quote-reply: Quote selection quotes only the selected part, never activity',async h=>{
  const {page}=h;
  const target=await h.emit('message.created',{text:'Synthetic test data alpha beta gamma'});
  await h.emit('tool.started',{tool:'Search',args:{query:'Synthetic query'}});
  await h.emit('tool.executed',{tool:'Search',output:'Synthetic result'});
  await page.goto(chatUrl(h));
  await settled(page);
  await page.locator(`#message-${target.id}`).waitFor();

  await selectPart(page,`#message-${target.id} [data-slot="message-focus"]`,'beta');
  const button=page.getByRole('button',{name:'Quote selection',exact:true});
  await button.waitFor({timeout:3000});
  const toolbar=page.locator('[data-slot="selection-toolbar"]');
  assert.equal(await toolbar.count(),1,'one selection toolbar');
  const classes=await toolbar.getAttribute('class')??'';
  console.log(`selection toolbar class: ${classes}`);
  assert.deepEqual(layoutUtilities(classes),[],'the selection toolbar has no Tailwind size, position or transform utilities');
  await button.click();
  await composerChip(page).waitFor({timeout:3000});
  assert.equal(await textbox(page).inputValue(),'> **Pip** wrote:\n> beta\n\n','Quote selection quotes only the selected part');

  await page.evaluate(()=>window.getSelection()?.removeAllRanges());
  await button.waitFor({state:'detached',timeout:3000});
  const group=page.locator('.nest-chat article[aria-label="Agent activity"]').first();
  await group.locator('.trace-chip').first().click();
  const card=group.locator('.trace-detail-card');
  await card.waitFor({timeout:3000});
  await selectPart(page,'.nest-chat .trace-detail-card','Details');
  await page.waitForTimeout(500);
  assert.equal(await page.evaluate(()=>window.getSelection()?.toString()),'Details','text in the activity card is selected');
  assert.equal(await button.count(),0,'selecting text in an activity detail card shows no Quote selection');
});

await runChatTest('quote-reply: a reply into another channel shows no link',async h=>{
  const {page}=h;
  const other=await(await h.post('/api/projects',{id:crypto.randomUUID(),name:'Synthetic other project',description:'Synthetic test project',members:[{subscriberType:'AGENT',subscriberId:'Pip'}]})).json() as {id:string;channelId:string};
  const elsewhere=await h.emit('message.created',{text:'Synthetic test data: other channel target'},{channelId:other.channelId});
  const reply=await h.emit('message.created',{text:'Synthetic cross-channel reply',inReplyTo:elsewhere.id});
  const lookup=page.waitForResponse(response=>new URL(response.url()).pathname===`/api/events/${elsewhere.id}`,{timeout:10000});
  await page.goto(chatUrl(h));
  await settled(page);
  const replyShell=page.locator(`#message-${reply.id}`);
  await replyShell.waitFor();
  await lookup;
  await page.waitForTimeout(500);
  assert.equal(await replyShell.getByRole('button',{name:/^Replying to/}).count(),0,'a reply into another channel shows no reply link');
});
