// The channel thread on assistant-ui (Task 7): message shell, activity groups, grouping, Markdown, day separators,
// scroll, deep links, empty and loading states, project footer and the 390 px layout. Synthetic data only.
import assert from 'node:assert/strict';
import type {Page} from 'playwright';
import {runChatTest,type ChatHarness} from '../support/chat-harness';

// Added after the tests commit (additions only): a ?channel= link to a project chat first renders in the workspace
// view, then remounts in the project view; wait for that before counting.
const settled=(page:Page)=>page.waitForFunction(()=>new URL(location.href).searchParams.has('project')&&!document.querySelector('.standalone-workspace')&&!!document.querySelector('.messages-panel'));
const DAY=24*60*60_000;
const chatUrl=(h:ChatHarness,query='')=>`${h.base}/?channel=${h.project.channelId}${query}`;
// Messages count per message element, never page-wide (a later working row adds names and avatars outside them).
const articles=(page:Page)=>page.locator('.nest-chat article.message');
const messageIds=(page:Page)=>page.locator('.nest-chat article.message').evaluateAll(nodes=>nodes.map(node=>node.getAttribute('data-message-id')??''));
const panelMetrics=(page:Page)=>page.locator('.nest-chat .messages-panel').evaluate(panel=>({top:panel.scrollTop,height:panel.scrollHeight,client:panel.clientHeight}));
const atBottom=async(page:Page)=>{const m=await panelMetrics(page);return m.height-m.top-m.client<4;};
async function emitMany(h:ChatHarness,count:number,label:string,source?:string){
  const ids:string[]=[];
  for(let index=0;index<count;index++)ids.push((await h.emit('message.created',{text:`${label} ${index}`},source?{source}:{})).id);
  return ids;
}
// Moves an event to an earlier time in the engine (history fixtures only), then the page reloads to read it back.
function backdate(h:ChatHarness,id:string,at:number){
  h.engineDb.prepare('UPDATE events SET created_at=?, deliver_at=? WHERE id=?').run(at,at,id);
}

await runChatTest('thread: shell, authors, activity, grouping, Markdown, days',async h=>{
  const {page}=h;
  await page.goto(chatUrl(h));
  await settled(page);
  await page.getByRole('textbox',{name:'Message',exact:true}).waitFor();
  assert.equal(await page.locator('.nest-chat').count(),1,'the new chat root .nest-chat exists');

  const yesterday=await h.emit('message.created',{text:'Synthetic yesterday note'},{source:'human:demo-owner'});
  const human=await h.emit('message.created',{text:'Synthetic human hello'},{source:'human:demo-owner'});
  const agent=await h.emit('message.created',{text:'Synthetic agent reply'});
  const wrapper=await h.emit('message.created',{text:'Synthetic wrapper notice'},{source:'system:runner:wrapper'});
  const pip=await h.emit('message.created',{text:'Synthetic Pip first'});
  const second=await h.emit('message.created',{text:'Synthetic second agent reply'},{source:'agent:Synthetic Second'});
  // Six trace events and no turn start, so the group holds exactly six chips.
  await h.emit('telemetry.context.window.updated',{agentName:'Pip',modelId:'fixture',estimatedUsedTokens:1200,contextWindowTokens:32000,estimatedAvailableTokens:30800,utilizationPct:3.75,messageCount:1,systemChars:0,systemContextChars:0,historyChars:120});
  await h.emit('tool.started',{tool:'Search',args:{query:'Synthetic query one'}});
  await h.emit('tool.executed',{tool:'Search',output:'Synthetic result one'});
  await h.emit('tool.started',{tool:'Search',args:{query:'Synthetic query two'}});
  await h.emit('tool.executed',{tool:'Search',output:'Synthetic result two'});
  await h.emit('process.exited',{exitCode:0});
  await h.emit('message.created',{text:'Synthetic after activity'},{source:'human:demo-owner'});
  const burst=[];
  for(const n of [1,2,3])burst.push((await h.emit('message.created',{text:`Synthetic burst ${n}`})).id);
  await h.emit('message.created',{text:'Synthetic break'},{source:'human:demo-owner'});
  const bold=await h.emit('message.created',{text:'Synthetic **bold** text'});
  const plain=await h.emit('message.created',{text:'Synthetic plain text'});
  const fence=await h.emit('message.created',{text:'Synthetic fence\n\n```ts\nconst synthetic = 1;\n```'});
  backdate(h,yesterday.id,Date.now()-2*DAY);
  await page.reload();
  await page.locator(`#message-${fence.id}`).waitFor();

  // Shell: each role class on exactly one element per message.
  for(const [id,role] of [[human.id,'human'],[agent.id,'agent'],[wrapper.id,'system']] as const){
    const shell=page.locator(`#message-${id}`);
    assert.equal(await shell.count(),1,`one #message-${role} element`);
    assert.equal(await shell.evaluate((node,role)=>node.tagName==='ARTICLE'&&node.classList.contains('message')&&node.classList.contains(`message-${role}`),role),true,`#message-<id> is article.message.message-${role}`);
    assert.equal(await shell.locator('.message, .message-human, .message-agent, .message-system').count(),0,`no nested message role classes inside the ${role} shell`);
  }
  const humanCount=await page.locator('.nest-chat .message-human').count(),agentCount=await page.locator('.nest-chat .message-agent').count();
  assert.equal(humanCount,4,'.message-human: exactly one element per human message');
  assert.equal(agentCount,9,'.message-agent: exactly one element per agent message');
  assert.equal(await page.locator(`#message-${agent.id} .agent-portrait img`).count(),1,'agent portrait img present');
  // The current user's own messages sit on the right without an avatar (another human's initials: tests/browser/chat.ts).
  const own=page.locator(`#message-${human.id}`);
  assert.equal(await own.locator('.message-human-avatar').count(),0,'own message has no avatar');
  assert.equal(await own.locator('[data-slot="message-focus"]').evaluate(node=>getComputedStyle(node).alignItems),'flex-end','own message is right-aligned');
  const wrapperShell=page.locator(`#message-${wrapper.id}`);
  assert.equal(await wrapperShell.getByText('system:runner:wrapper',{exact:true}).count(),1,'wrapper message shows its label');
  assert.equal(await wrapperShell.locator('.agent-portrait, .message-human-avatar, img').count(),0,'wrapper message has no avatar');

  // Two agents back to back stay two articles.
  assert.equal(await page.locator(`#message-${pip.id}.message-agent`).count(),1,'first agent article');
  assert.equal(await page.locator(`#message-${second.id}.message-agent`).count(),1,'second agent article, not merged');
  assert.equal(await page.locator(`#message-${second.id}`).getByText('Synthetic Second',{exact:true}).count(),1,'second agent shows its own name');

  // Activity group: six 22 px chips, no visible text, detail card toggles.
  const groups=page.locator('.nest-chat article[aria-label="Agent activity"]');
  assert.equal(await groups.count(),1,'one Agent activity article');
  const group=groups.first();
  assert.equal(await group.locator('.trace-chip').count(),6,'exactly 6 .trace-chip');
  for(const box of await group.locator('.trace-chip').evaluateAll(nodes=>nodes.map(node=>node.getBoundingClientRect()).map(r=>({w:r.width,h:r.height}))))
    assert.deepEqual(box,{w:22,h:22},'each chip is 22 by 22 px');
  assert.equal((await group.innerText()).trim(),'','activity group has no visible text');
  await group.locator('.trace-chip').nth(1).click();
  const card=group.locator('.trace-detail-card');
  await card.waitFor({timeout:3000});
  assert.match(await card.textContent()??'',/tool\.started/,'detail card shows the event type');
  await group.locator('.trace-chip').nth(1).click();
  await card.waitFor({state:'detached',timeout:3000});

  // Continuation: three messages from one agent within a minute.
  const burstShells=page.locator(burst.map(id=>`#message-${id}`).join(', '));
  assert.equal(await burstShells.count(),3,'three burst messages');
  assert.equal(await burstShells.locator('.message-author').filter({hasText:'Pip'}).count(),1,'agent name shown once across the burst');
  assert.equal(await burstShells.locator('time').count(),3,'time shown on each burst message');
  assert.equal(await burstShells.locator('.agent-portrait').count(),1,'avatar shown once across the burst');

  // Markdown only when the text looks like it.
  assert.equal(await page.locator(`#message-${bold.id} strong`).filter({hasText:'bold'}).count(),1,'**bold** renders strong');
  assert.equal(await page.locator(`#message-${plain.id} p`).filter({hasText:'Synthetic plain text'}).count(),1,'plain text renders p');
  assert.equal(await page.locator(`#message-${fence.id}`).getByRole('button',{name:'Copy code',exact:true}).count(),1,'a fence shows Copy code');

  // Day separators: the backdated message and today.
  assert.equal(await page.locator('.nest-chat [data-slot="day-separator"]').count(),2,'two days give two day separators');

  // Nothing the engine cannot do.
  for(const name of ['Edit','Regenerate','Reload','Stop','Cancel'])
    assert.equal(await page.locator('.nest-chat').getByRole('button',{name,exact:true}).count(),0,`no ${name} button in .nest-chat`);
});

await runChatTest('thread: 80 messages, auto-load older, new content while away',async h=>{
  const {page}=h;
  // Added after the tests commit: pin the page size to 50 (downlink 10). Chromium's estimate varies by run, and with
  // 40 two full pages hold exactly 80, so more history could still remain and the button would rightly stay.
  await h.context.addInitScript(()=>{Object.defineProperty(navigator,'connection',{configurable:true,value:{downlink:10,effectiveType:'4g',saveData:false}});});
  const ids=await emitMany(h,80,'Synthetic history');
  await page.goto(chatUrl(h));
  await settled(page);
  await page.locator(`#message-${ids[79]}`).waitFor();
  assert.equal(await page.locator('.nest-chat').count(),1,'the new chat root .nest-chat exists');
  await page.waitForFunction(()=>{const p=document.querySelector('.nest-chat .messages-panel');return !!p&&p.scrollHeight-p.scrollTop-p.clientHeight<4;},undefined,{timeout:3000}).catch(()=>{});
  assert.equal(await atBottom(page),true,'starts at the bottom');
  assert.equal(await page.locator('.nest-chat').getByRole('button',{name:'Load previous messages',exact:true}).count(),1,'Load previous messages exists while more remains');
  // Added after the tests commit (T7-R1): without a deep link no message is highlighted.
  assert.equal(await page.locator('.nest-chat .message-highlight').count(),0,'no .message-highlight without a deep link');

  const before=await messageIds(page);
  assert.ok(before.length<80,'the first page holds only part of the history');
  const first=before[0]!;
  const top=async()=>page.locator(`#message-${first}`).evaluate(node=>{const panel=node.closest('.messages-panel')!;return node.getBoundingClientRect().top-panel.getBoundingClientRect().top;});
  await page.locator('.nest-chat .messages-panel').evaluate(panel=>{panel.scrollTop=0;});
  const anchor=await top();
  await page.waitForFunction(count=>document.querySelectorAll('.nest-chat article.message').length>count,before.length,{timeout:5000});
  await page.waitForTimeout(300);
  assert.ok(Math.abs(await top()-anchor)<=4,`previous first message stays within 4 px after the prepend (moved ${Math.abs(await top()-anchor)} px)`);
  await page.waitForFunction(()=>document.querySelectorAll('.nest-chat article.message').length===80,undefined,{timeout:8000}).catch(()=>{});
  const all=await messageIds(page);
  assert.equal(new Set(all).size,all.length,'no message id repeats');
  assert.deepEqual([...all].sort(),[...ids].sort(),'every message loads exactly once');
  assert.equal(await page.locator('.nest-chat').getByRole('button',{name:'Load previous messages',exact:true}).count(),0,'Load previous messages goes once nothing remains');

  // Scrolled up with nothing new: the arrow, not New messages below.
  await page.locator('.nest-chat .messages-panel').evaluate(panel=>{panel.scrollTop=Math.max(0,panel.scrollHeight/2-panel.clientHeight);});
  await page.waitForTimeout(200);
  await page.locator('.nest-chat').getByRole('button',{name:'Scroll to latest',exact:true}).waitFor({timeout:3000});
  assert.equal(await page.getByRole('button',{name:'New messages below',exact:true}).count(),0,'no New messages below with nothing new');

  // Scrolled up, an incoming message.
  const incoming=await h.emit('message.created',{text:'Synthetic incoming while away'});
  await page.locator(`#message-${incoming.id}`).waitFor({state:'attached',timeout:3000});
  const below=page.getByRole('button',{name:'New messages below',exact:true});
  await below.waitFor({timeout:3000});
  assert.equal(await atBottom(page),false,'scrolled-up reader is not moved');
  await below.click();
  await page.waitForFunction(()=>{const p=document.querySelector('.nest-chat .messages-panel');return !!p&&p.scrollHeight-p.scrollTop-p.clientHeight<4;},undefined,{timeout:3000});
  await below.waitFor({state:'detached',timeout:3000});

  // At the bottom, incoming messages keep it pinned.
  // Added after the tests commit (T7-R1): record every insertion of the button, so a flash that the viewport clears
  // again before the next check still counts.
  await page.evaluate(()=>{
    const w=window as unknown as {__newBelowSeen:number};w.__newBelowSeen=0;
    // Inline test, no named helper: the test runner's transform would wrap a named function in an undefined __name.
    new MutationObserver(records=>{for(const record of records)for(const node of record.addedNodes)
      if(node instanceof HTMLElement&&(node.matches('.new-messages-button')||!!node.querySelector('.new-messages-button')))w.__newBelowSeen++;})
      .observe(document.querySelector('.nest-chat')!,{subtree:true,childList:true});
  });
  for(const n of [1,2]){
    const pinned=await h.emit('message.created',{text:`Synthetic pinned ${n}\n\n${'Synthetic tall line\n\n'.repeat(6)}`});
    await page.locator(`#message-${pinned.id}`).waitFor({timeout:3000});
    await page.waitForFunction(()=>{const p=document.querySelector('.nest-chat .messages-panel');return !!p&&p.scrollHeight-p.scrollTop-p.clientHeight<4;},undefined,{timeout:3000});
  }
  assert.equal(await page.getByRole('button',{name:'New messages below',exact:true}).count(),0,'pinned reader gets no New messages below');
  assert.equal(await page.evaluate(()=>(window as unknown as {__newBelowSeen:number}).__newBelowSeen),0,'New messages below never rendered while pinned');
});

// Added after the tests commit (T7-R1): with browser scroll anchoring off, as in WebKit, only the thread viewport's
// own measure-and-restore keeps the previous first message in place.
await runChatTest('thread: prepend keeps position without browser scroll anchoring',async h=>{
  const {page}=h;
  await h.context.addInitScript(()=>{
    Object.defineProperty(navigator,'connection',{configurable:true,value:{downlink:10,effectiveType:'4g',saveData:false}});
    document.addEventListener('DOMContentLoaded',()=>{const style=document.createElement('style');style.textContent='.nest-chat .messages-panel, .nest-chat .messages-panel * { overflow-anchor: none !important; }';document.head.append(style);});
  });
  const ids=await emitMany(h,80,'Synthetic unanchored history');
  await page.goto(chatUrl(h));
  await settled(page);
  await page.locator(`#message-${ids[79]}`).waitFor();
  assert.equal(await page.locator('.nest-chat').count(),1,'the new chat root .nest-chat exists');
  assert.equal(await page.locator('.nest-chat .messages-panel').evaluate(panel=>getComputedStyle(panel).overflowAnchor),'none','browser scroll anchoring is off');
  await page.waitForFunction(()=>{const p=document.querySelector('.nest-chat .messages-panel');return !!p&&p.scrollHeight-p.scrollTop-p.clientHeight<4;},undefined,{timeout:3000}).catch(()=>{});
  const before=await messageIds(page);
  assert.ok(before.length<80,'the first page holds only part of the history');
  const first=before[0]!;
  const top=async()=>page.locator(`#message-${first}`).evaluate(node=>{const panel=node.closest('.messages-panel')!;return node.getBoundingClientRect().top-panel.getBoundingClientRect().top;});
  // Not at 0: browsers never anchor at offset 0, so only a reader part way into the auto-load zone needs anchoring.
  await page.locator('.nest-chat .messages-panel').evaluate(panel=>{panel.scrollTop=60;});
  const anchor=await top();
  await page.waitForFunction(count=>document.querySelectorAll('.nest-chat article.message').length>count,before.length,{timeout:5000});
  await page.waitForTimeout(300);
  const moved=Math.abs(await top()-anchor);
  assert.ok(moved<=4,`previous first message stays within 4 px after the prepend without scroll anchoring (moved ${moved} px)`);
});

await runChatTest('thread: deep link 60 messages back',async h=>{
  const {page}=h;
  const ids=await emitMany(h,80,'Synthetic deep history');
  const target=ids[19]!;
  await page.goto(chatUrl(h,`&message=${target}`));
  await settled(page);
  const shell=page.locator(`#message-${target}`);
  await shell.waitFor({timeout:8000});
  assert.equal(await page.locator('.nest-chat').count(),1,'the new chat root .nest-chat exists');
  const inViewport=()=>shell.evaluate(node=>{const panel=node.closest('.messages-panel')!.getBoundingClientRect(),box=node.getBoundingClientRect();return box.top>=panel.top-1&&box.bottom<=panel.bottom+1;});
  await page.waitForFunction(id=>document.activeElement?.id===`message-${id}`,target,{timeout:3000});
  assert.equal(await inViewport(),true,'deep-linked message is in the viewport');
  assert.equal(await shell.evaluate(node=>node.classList.contains('message-highlight')),true,'deep-linked message is highlighted');
  assert.equal(await shell.getAttribute('tabindex'),'-1','deep-linked message is focusable');
  // Added after the tests commit (T7-R1): only the target is highlighted and focusable.
  assert.equal(await page.locator('.nest-chat .message-highlight').count(),1,'exactly one .message-highlight during a deep link');
  assert.equal(await page.locator('.nest-chat article.message[tabindex]').count(),1,'only the deep-linked message is focusable');
  // While detached: the marker sits between the target and the loaded window.
  const order=await page.locator('.nest-chat').evaluate((root,id)=>{
    const nodes=[...root.querySelectorAll('article.message, [data-slot="detached-marker"]')];
    return nodes.map(node=>node.matches('[data-slot="detached-marker"]')?'marker':node.getAttribute('data-message-id')===id?'target':'window');
  },target);
  const at=order.indexOf('target');
  assert.ok(at>=0&&order[at+1]==='marker'&&order[at+2]==='window','Earlier messages not loaded sits between the target and the window');
  assert.equal(await page.locator('.nest-chat [data-slot="detached-marker"]').filter({hasText:'Earlier messages not loaded'}).count(),1,'marker text');
  await page.waitForTimeout(1000);
  assert.equal(await inViewport(),true,'still fully in the viewport after 1 s');
  assert.equal(await shell.evaluate(node=>node.classList.contains('message-highlight')),true,'still highlighted after 1 s');

  // Scrolling up loads every message between the target and the window, each once.
  await page.locator('.nest-chat .messages-panel').hover();
  for(let step=0;step<30;step++){
    if((await messageIds(page)).length>=80&&await page.locator('.nest-chat').getByRole('button',{name:'Load previous messages',exact:true}).count()===0)break;
    await page.mouse.wheel(0,-1500);
    await page.waitForTimeout(250);
  }
  const all=await messageIds(page);
  assert.equal(new Set(all).size,all.length,'no message id repeats after paging');
  assert.deepEqual([...all].sort(),[...ids].sort(),'every message between the target and the window loads exactly once');
  assert.equal(await page.locator('.nest-chat [data-slot="detached-marker"]').count(),0,'marker goes once the window reaches the target');
});

await runChatTest('thread: older pages landing inside an existing activity group',async h=>{
  const {page}=h;
  const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
  // One tool event, then two messages, 40 times: the tool query reaches the start on the first page while the
  // message query does not, so the oldest tools first render as one group that older message pages then split.
  const messages:string[]=[];
  for(let cycle=0;cycle<40;cycle++){
    await h.emit('tool.started',{tool:'Search',args:{query:`Synthetic paging query ${cycle}`}});
    for(const n of [0,1])messages.push((await h.emit('message.created',{text:`Synthetic paging ${cycle}.${n}`})).id);
  }
  await page.goto(chatUrl(h));
  await settled(page);
  await page.locator(`#message-${messages.at(-1)}`).waitFor();
  assert.equal(await page.locator('.nest-chat').count(),1,'the new chat root .nest-chat exists');
  for(let step=0;step<10;step++){
    const more=page.locator('.nest-chat').getByRole('button',{name:'Load previous messages',exact:true});
    const before=(await messageIds(page)).length;
    // This case tests grouping across pages. Playwright scrolling the button into
    // view can itself auto-load the final page and remove the button before click.
    // Trigger paging atomically without scrolling; real scroll/click is covered above.
    const clicked=await more.evaluateAll(buttons=>{
      const button=buttons[0] as HTMLButtonElement|undefined;
      if(!button)return false;
      button.click();return true;
    });
    if(!clicked)break;
    await page.waitForFunction(previous=>{
      const root=document.querySelector('.nest-chat');
      return (root?.querySelectorAll('article.message').length??0)>previous||
        !Array.from(root?.querySelectorAll('button')??[]).some(button=>/previous messages/i.test(button.textContent??''));
    },before);
  }
  const all=await messageIds(page);
  assert.deepEqual([...all].sort(),[...messages].sort(),'every paged message renders exactly once');
  const groups=page.locator('.nest-chat article[aria-label="Agent activity"]');
  assert.equal(await groups.count(),40,'the early group split into one group per tool event');
  assert.deepEqual(await groups.evaluateAll(nodes=>nodes.map(node=>node.querySelectorAll('.trace-chip').length)),Array(40).fill(1),'each group holds its one chip');
  assert.deepEqual(errors,[],'no page error (assistant-ui rejects duplicate message ids)');
});

await runChatTest('thread: other-channel deep link, empty and loading states',async h=>{
  const {page}=h;
  const other=await(await h.post('/api/projects',{id:crypto.randomUUID(),name:'Synthetic other project',description:'Synthetic test project',members:[{subscriberType:'AGENT',subscriberId:'Pip'}]})).json() as {channelId:string};
  const elsewhere=await h.emit('message.created',{text:'Synthetic message elsewhere'},{channelId:other.channelId});
  await page.goto(chatUrl(h));
  await settled(page);
  await page.locator('.nest-chat').waitFor();
  assert.equal(await page.locator('.nest-chat').count(),1,'the new chat root .nest-chat exists');
  await page.getByText('No messages yet',{exact:true}).waitFor({timeout:5000});
  assert.equal(await page.locator('.nest-chat .messages-panel.messages-panel-empty').count(),1,'empty chat marks messages-panel-empty');

  // Added after the tests commit: the unread poll also requests /api/events, so also hold the channel's message
  // query by its exact URL (page size pinned to 50) and release it with the other hold.
  await h.context.addInitScript(()=>{Object.defineProperty(navigator,'connection',{configurable:true,value:{downlink:10,effectiveType:'4g',saveData:false}});});
  const exact=h.holdNext(`/api/events?channelId=${h.project.channelId}&limit=50&order=desc&type=message.created`);
  const hold=h.holdNext(`/api/events`,{query:{channelId:h.project.channelId}});
  await page.reload();
  await hold.started;
  await page.locator('.nest-chat').getByText('Loading messages...',{exact:true}).waitFor({timeout:5000});
  hold.release();
  exact.release();
  await page.getByText('No messages yet',{exact:true}).waitFor({timeout:5000});

  await page.goto(chatUrl(h,`&message=${elsewhere.id}`));
  await settled(page);
  await page.getByText('This mentioned message is no longer available.',{exact:true}).waitFor({timeout:5000});
  assert.equal(await page.locator(`#message-${elsewhere.id}`).count(),0,'the other channel message is not shown');
});

await runChatTest('thread: project chat footer',async h=>{
  const {page}=h;
  await h.emit('message.created',{text:'Synthetic plan: track the launch on a Trello board'});
  await page.goto(`${h.base}/?view=projects&project=${h.project.id}`);
  await page.locator('.nest-chat').waitFor();
  assert.equal(await page.locator('.nest-chat').count(),1,'the new chat root .nest-chat exists');
  await page.locator('.nest-chat').getByRole('button',{name:'Connect Trello',exact:true}).waitFor({timeout:8000});
},{connections:syntheticTrello()});

await runChatTest('thread: 390 px without horizontal scroll',async h=>{
  const {page}=h;
  const row=(cells:string[])=>`| ${cells.join(' | ')} |`;
  const columns=Array.from({length:12},(_,index)=>`Synthetic column ${index+1}`);
  await h.emit('message.created',{text:`Synthetic unbroken ${'x'.repeat(400)}`});
  await h.emit('message.created',{text:[row(columns),row(columns.map(()=>'---')),row(columns.map(()=>'synthetic cell value'))].join('\n')});
  await h.emit('message.created',{text:`\`\`\`text\n${'y'.repeat(300)}\n\`\`\``});
  await page.goto(chatUrl(h));
  await settled(page);
  await page.locator('.nest-chat table').waitFor();
  assert.equal(await page.locator('.nest-chat').count(),1,'the new chat root .nest-chat exists');
  await page.waitForTimeout(300);
  const width=await page.evaluate(()=>document.documentElement.scrollWidth);
  assert.ok(width<=390,`scrollWidth ${width} <= 390 with a long string, a 12-column table and a 300-char code line`);
},{viewport:{width:390,height:844}});

// The synthetic Trello provider, built as tests/browser/projects.ts builds it.
function syntheticTrello(){
  return {id:'synthetic',subject:(owner:string)=>owner,
    apps:async(search:string)=>({items:search==='trello'?[{slug:'trello',name:'Trello',description:'Synthetic catalog fixture',connectable:true}]:[],nextCursor:null}),
    accounts:async()=>({items:[],nextCursor:null}),
    link:async()=>({redirectUrl:'https://connect.example.test/authorize'}),
    account:async()=>{throw Error('Unexpected account call');},revoke:async()=>{},tools:async()=>({items:[],nextCursor:null}),
    tool:async()=>{throw Error('Unexpected tool call');},execute:async()=>{throw Error('No tool execution in this test');},
  };
}
