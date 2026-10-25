// Message actions and Markdown export (Task 14, spec 7.2, 7.5.2, 5.6): what can leave the page. Synthetic data only.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import type {Locator,Page} from 'playwright';
import {runChatTest,type ChatHarness} from '../support/chat-harness';

const settled=(page:Page)=>page.waitForFunction(()=>new URL(location.href).searchParams.has('project')&&!document.querySelector('.standalone-workspace')&&!!document.querySelector('.messages-panel'));
const chatUrl=(h:ChatHarness)=>`${h.base}/?channel=${h.project.channelId}`;
const NAMES=['Copy message','Copy link','Quote'] as const;
const action=(scope:Locator,name:string)=>scope.getByRole('button',{name,exact:true});
// The action bar of one message; hidden means computed display none (the chat utilities are important).
const barDisplay=(message:Locator)=>message.locator('[data-slot="message-actions"]').evaluate(node=>getComputedStyle(node).display);
const visibleActions=(page:Page)=>page.locator('.nest-chat [data-slot="message-actions"]').evaluateAll(nodes=>nodes.filter(node=>getComputedStyle(node).display!=='none').length);
const clipboard=(page:Page)=>page.evaluate(()=>navigator.clipboard.readText());
const noOverflow=async(page:Page,message:Locator,label:string)=>{
  const box=await message.evaluate(node=>({scroll:node.scrollWidth,client:node.clientWidth}));
  assert.ok(box.scroll<=box.client,`${label}: message scrollWidth ${box.scroll} <= clientWidth ${box.client}`);
  const doc=await page.evaluate(()=>({scroll:document.documentElement.scrollWidth,inner:window.innerWidth}));
  assert.ok(doc.scroll<=doc.inner,`${label}: document scrollWidth ${doc.scroll} <= innerWidth ${doc.inner}`);
};

await runChatTest('actions: hover, focus, copy, link, export, activity',async h=>{
  const {page}=h;
  await h.context.grantPermissions(['clipboard-read','clipboard-write'],{origin:h.base});
  const rawText='Synthetic **raw** copy text';
  const first=await h.emit('message.created',{text:rawText},{source:'human:demo-owner'});
  await h.emit('tool.started',{tool:'Search',args:{query:'Synthetic query'}});
  await h.emit('process.output',{stderr:'Synthetic stderr SECRET'});
  await h.emit('tool.executed',{tool:'Search',output:'Synthetic result'});
  const linkText='Synthetic link https://example.com/synthetic';
  const second=await h.emit('message.created',{text:linkText});
  await page.goto(chatUrl(h));
  await settled(page);
  const firstMessage=page.locator(`#message-${first.id}`),secondMessage=page.locator(`#message-${second.id}`);
  await secondMessage.waitFor();

  // First statement: hovering a message shows Copy message.
  await firstMessage.hover();
  await action(firstMessage,'Copy message').waitFor({state:'visible',timeout:3000});
  for(const name of NAMES)assert.equal(await action(firstMessage,name).isVisible(),true,`hover shows ${name}`);
  assert.equal(await barDisplay(firstMessage),'flex','the hovered bar is shown');
  assert.equal(await barDisplay(secondMessage),'none','hidden actions compute display none');
  await noOverflow(page,firstMessage,'with actions shown');

  // Activity groups get no actions of their own. A group that follows a message is shown inside that message, so
  // hovering it shows that message's one action bar, below the group.
  const activity=page.locator('.nest-chat article[aria-label="Agent activity"]');
  assert.equal(await activity.count(),1,'one Agent activity article');
  await activity.hover();
  await page.waitForTimeout(150);
  for(const name of NAMES)assert.equal(await action(activity,name).count(),0,`no ${name} inside the activity group`);
  assert.ok(await visibleActions(page)<=1,'hovering an activity group shows at most its message\'s one action bar');

  // Keyboard focus within a message shows them too (spec 7.2): the link in the second message's body takes focus.
  const link=secondMessage.getByRole('link').first();
  await link.focus();
  for(const name of NAMES)await action(secondMessage,name).waitFor({state:'visible',timeout:3000});
  assert.equal(await barDisplay(secondMessage),'flex','focus within shows the bar');
  // The bar sits beside the time, before the body, so it is one Shift+Tab back from the body's link (its last action, Quote).
  await page.keyboard.press('Shift+Tab');
  assert.equal(await page.evaluate(id=>document.activeElement?.closest('[data-slot="message-actions"]')!==null&&document.activeElement?.closest('article.message')?.id===`message-${id}`&&(document.activeElement?.textContent??'').includes('Quote'),second.id),true,'Shift+Tab from the body reaches that message\'s Quote');
  await page.evaluate(()=>(document.activeElement as HTMLElement|null)?.blur());

  // Copy message: the raw text, not the rendered Markdown.
  await firstMessage.hover();
  await action(firstMessage,'Copy message').click();
  await page.waitForFunction(text=>navigator.clipboard.readText().then(value=>value===text),rawText,{timeout:3000}).catch(()=>{});
  assert.equal(await clipboard(page),rawText,'Copy message puts the raw text on the clipboard');

  // Copy link: opened in a new page, it highlights that message.
  await action(firstMessage,'Copy link').click();
  await page.waitForFunction(()=>navigator.clipboard.readText().then(value=>value.includes('message=')),undefined,{timeout:3000}).catch(()=>{});
  const url=await clipboard(page);
  assert.equal(new URL(url).searchParams.get('message'),first.id,'the link names the message');
  const other=await h.context.newPage();
  await other.goto(url);
  await other.locator(`#message-${first.id}.message-highlight`).waitFor({timeout:8000});
  await other.close();

  // Export chat inside .nest-chat downloads a .md holding both texts and no activity details.
  const exportButton=page.locator('.nest-chat').getByRole('button',{name:'Export chat',exact:true});
  assert.equal(await exportButton.count(),1,'one Export chat inside .nest-chat');
  const [download]=await Promise.all([page.waitForEvent('download',{timeout:5000}),exportButton.click()]);
  assert.match(download.suggestedFilename(),/\.md$/,'the download is a .md');
  const markdown=await readFile(await download.path(),'utf8');
  assert.ok(markdown.includes(rawText),'the export holds the first message text');
  assert.ok(markdown.includes(linkText),'the export holds the second message text');
  assert.ok(!markdown.includes('SECRET'),'the export holds no activity details');
});

await runChatTest('actions: 390 px tap toggles',async h=>{
  const {page}=h;
  const message=await h.emit('message.created',{text:'Synthetic tap target'});
  await page.goto(chatUrl(h));
  await settled(page);
  const shell=page.locator(`#message-${message.id}`);
  await shell.waitFor();
  assert.equal(await barDisplay(shell),'none','actions start hidden on touch');
  // Export chat is desktop only: at the 760 px mobile breakpoint the project panel sits where it floats.
  const exportButton=page.locator('.nest-chat').getByRole('button',{name:'Export chat',exact:true,includeHidden:true});
  assert.equal(await exportButton.count(),1,'Export chat is still rendered at 390 px');
  assert.equal(await exportButton.isVisible(),false,'Export chat is hidden at 390 px');
  await shell.getByText('Synthetic tap target',{exact:true}).tap();
  await action(shell,'Copy message').waitFor({state:'visible',timeout:3000});
  for(const name of NAMES)assert.equal(await action(shell,name).isVisible(),true,`a tap shows ${name}`);
  await noOverflow(page,shell,'390 px with actions shown');
  await shell.getByText('Synthetic tap target',{exact:true}).tap();
  await page.waitForFunction(id=>{const bar=document.querySelector(`#message-${id} [data-slot="message-actions"]`);return !!bar&&getComputedStyle(bar).display==='none';},message.id,{timeout:3000}).catch(()=>{});
  assert.equal(await barDisplay(shell),'none','a second tap hides the actions');
},{viewport:{width:390,height:844},hasTouch:true});
