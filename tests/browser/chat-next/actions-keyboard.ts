// Keyboard reach for message actions (Task 14B, spec 7.2): every message shell is a Tab stop, and focus inside it
// reveals Copy message, Copy link and Quote as the next stops. Synthetic data only.
import assert from 'node:assert/strict';
import type {Locator,Page} from 'playwright';
import {runChatTest,type ChatHarness} from '../support/chat-harness';

const settled=(page:Page)=>page.waitForFunction(()=>new URL(location.href).searchParams.has('project')&&!document.querySelector('.standalone-workspace')&&!!document.querySelector('.messages-panel'));
const chatUrl=(h:ChatHarness,extra='')=>`${h.base}/?channel=${h.project.channelId}${extra}`;
const NAMES=['Copy message','Copy link','Quote'] as const;
const action=(scope:Locator,name:string)=>scope.getByRole('button',{name,exact:true});
const barDisplay=(message:Locator)=>message.locator('[data-slot="message-actions"]').evaluate(node=>getComputedStyle(node).display);
const visibleActions=(page:Page)=>page.locator('.nest-chat [data-slot="message-actions"]').evaluateAll(nodes=>nodes.filter(node=>getComputedStyle(node).display!=='none').length);
// Where focus is: the message it sits in, whether it is that message's shell (not a control inside it), and the
// action it is on, if any.
const focusAt=(page:Page)=>page.evaluate(()=>{
  const active=document.activeElement as HTMLElement|null;
  const message=active?.closest<HTMLElement>('article.message')??null;
  const control=active?.closest('button,a,input,textarea,select,summary,[role="button"]')??null;
  const bar=active?.closest('[data-slot="message-actions"]')??null;
  return {
    message:message?.getAttribute('data-message-id')??null,
    shell:!!message&&!control,
    action:bar?(active?.textContent??'').trim():null,
    activity:!!active?.closest('article[aria-label="Agent activity"]'),
    composer:active?.getAttribute('aria-label')==='Message',
  };
});
const shellFocused=async(page:Page,id:string,label:string)=>{
  const at=await focusAt(page);
  assert.equal(at.message,id,`${label}: focus is in message ${id}`);
  assert.equal(at.shell,true,`${label}: the message shell itself has focus, not a control inside it`);
};
const actionsShown=async(page:Page,message:Locator,label:string)=>{
  assert.equal(await barDisplay(message),'flex',`${label}: the focused shell shows its action bar`);
  for(const name of NAMES)assert.equal(await action(message,name).isVisible(),true,`${label}: ${name} is visible`);
};
// The three actions are the next Tab stops after a focused shell.
const tabThroughActions=async(page:Page,id:string,label:string)=>{
  for(const name of NAMES){
    await page.keyboard.press('Tab');
    const at=await focusAt(page);
    assert.equal(at.message,id,`${label}: Tab stays in message ${id} for ${name}`);
    assert.equal(at.action,name,`${label}: the next Tab stop is ${name}`);
  }
};
const seedThree=async(h:ChatHarness)=>[
  await h.emit('message.created',{text:'Synthetic keyboard note one'},{source:'human:demo-owner'}),
  await h.emit('message.created',{text:'Synthetic keyboard reply two'}),
  await h.emit('message.created',{text:'Synthetic keyboard note three'},{source:'human:demo-owner'}),
].map(event=>event.id);

await runChatTest('actions keyboard: Tab backwards from the composer',async h=>{
  const {page}=h;
  const ids=await seedThree(h);
  await page.goto(chatUrl(h));
  await settled(page);
  await page.locator(`#message-${ids[2]}`).waitFor();
  assert.equal(await visibleActions(page),0,'no action bar shows before any focus');
  const composer=page.getByRole('textbox',{name:'Message',exact:true});
  await composer.focus();
  // Shift+Tab walks back from the composer; each message shell must be met, last message first.
  const met:string[]=[];
  for(let step=0;step<40&&met.length<ids.length;step++){
    await page.keyboard.press('Shift+Tab');
    const at=await focusAt(page);
    if(at.message&&at.shell&&!met.includes(at.message))met.push(at.message);
  }
  assert.deepEqual(met,[...ids].reverse(),'Shift+Tab from the composer reaches each message shell, newest first');
  // Focus now sits on the first shell; forwards, each shell shows its actions and they are the next Tab stops.
  for(const [index,id] of ids.entries()){
    const label=`message ${index+1}`;
    await shellFocused(page,id,label);
    await actionsShown(page,page.locator(`#message-${id}`),label);
    await tabThroughActions(page,id,label);
    await page.keyboard.press('Tab');
    if(index===ids.length-1)assert.notEqual((await focusAt(page)).message,id,'after the last Quote, Tab leaves the last message');
  }
},{chatUi:'next'});

await runChatTest('actions keyboard: Tab forwards from the page start',async h=>{
  const {page}=h;
  const ids=await seedThree(h);
  await page.goto(chatUrl(h));
  await settled(page);
  await page.locator(`#message-${ids[2]}`).waitFor();
  await page.evaluate(()=>{(document.activeElement as HTMLElement|null)?.blur();window.getSelection()?.removeAllRanges();});
  const met:string[]=[];
  let composerReached=false;
  for(let step=0;step<120&&!composerReached;step++){
    await page.keyboard.press('Tab');
    const at=await focusAt(page);
    composerReached=at.composer;
    if(!at.message||!at.shell)continue;
    if(!met.includes(at.message))met.push(at.message);
    const message=page.locator(`#message-${at.message}`);
    await actionsShown(page,message,`from the page start, message ${met.length}`);
    await tabThroughActions(page,at.message,`from the page start, message ${met.length}`);
  }
  assert.deepEqual(met,ids,'Tab from the page start reaches each message shell in order');
},{chatUi:'next'});

await runChatTest('actions keyboard: activity groups get no actions',async h=>{
  const {page}=h;
  const note=await h.emit('message.created',{text:'Synthetic keyboard before activity'},{source:'human:demo-owner'});
  await h.emit('tool.started',{tool:'Search',args:{query:'Synthetic query'}});
  await h.emit('tool.executed',{tool:'Search',output:'Synthetic result'});
  await h.emit('message.created',{text:'Synthetic keyboard after activity'});
  await page.goto(chatUrl(h));
  await settled(page);
  await page.locator(`#message-${note.id}`).waitFor();
  const activity=page.locator('.nest-chat article[aria-label="Agent activity"]');
  assert.equal(await activity.count(),1,'one Agent activity article');
  for(const name of NAMES)assert.equal(await action(activity,name).count(),0,`no ${name} inside the activity group`);
  assert.equal(await activity.locator('[data-slot="message-actions"]').count(),0,'no action bar inside the activity group');
  assert.equal(await activity.evaluate(node=>!node.matches('article.message')),true,'the activity group is not a message shell');
  await page.evaluate(()=>(document.activeElement as HTMLElement|null)?.blur());
  let shells=0;
  for(let step=0;step<120;step++){
    await page.keyboard.press('Tab');
    const at=await focusAt(page);
    if(at.composer)break;
    if(at.message&&at.shell)shells++;
    // A group shown inside a message reveals only that message's one bar (its own actions are checked above).
    if(at.activity)assert.ok(await visibleActions(page)<=1,'focus inside the activity group shows at most its message\'s bar');
  }
  assert.equal(shells,2,'Tab meets both message shells and no shell for the activity group');
},{chatUi:'next'});

await runChatTest('actions keyboard: deep link keeps focus and highlight',async h=>{
  const {page}=h;
  const ids=await seedThree(h);
  const target=ids[1]!;
  await page.goto(chatUrl(h,`&message=${target}`));
  await settled(page);
  const shell=page.locator(`#message-${target}`);
  await shell.waitFor({timeout:8000});
  await page.waitForFunction(id=>document.activeElement?.id===`message-${id}`,target,{timeout:3000});
  assert.equal(await shell.evaluate(node=>node.classList.contains('message-highlight')),true,'deep-linked message is highlighted');
  assert.equal(await page.locator('.nest-chat .message-highlight').count(),1,'exactly one .message-highlight');
  await actionsShown(page,shell,'deep-linked message');
},{chatUi:'next'});
