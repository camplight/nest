// Composer look (Task 11, spec 7.4, 7.4.3, 7.4.5, 6.8, 6.12, 6.16): the .nest-chat-composer scope, image thumbnails,
// real upload progress, failures, the 20-file limit, autosize heights and Send inside the viewport. Synthetic data only.
import assert from 'node:assert/strict';
import type {Page} from 'playwright';
import {runChatTest,type ChatHarness} from '../support/chat-harness';

const textbox=(page:Page)=>page.getByRole('textbox',{name:'Message',exact:true});
const sendButton=(page:Page)=>page.getByRole('button',{name:'Send',exact:true});
const chip=(page:Page,name:string)=>page.locator('.composer-attachments article',{hasText:name});
const fileInput=(page:Page)=>page.locator('form.composer input[type="file"]');
const textareaHeight=(page:Page)=>textbox(page).evaluate(el=>el.getBoundingClientRect().height);
const settle=(page:Page)=>page.evaluate(()=>new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve()))));

// A small real png, rendered by the browser so the thumbnail decodes.
async function syntheticComposerPng(h:ChatHarness,label:string):Promise<Buffer>{
  const page=await h.context.newPage();
  await page.setContent(`<div style="width:160px;height:120px;background:#350956;color:white;font:14px sans-serif;padding:12px;box-sizing:border-box">SYNTHETIC TEST IMAGE ${label}</div>`);
  const bytes=await page.locator('div').screenshot();
  await page.close();
  return bytes;
}

async function sendInViewport(page:Page,label:string){
  const box=await sendButton(page).boundingBox();
  const viewport=page.viewportSize()!;
  assert.ok(box,`${label}: Send has a bounding box`);
  assert.ok(box.x>=0&&box.y>=0&&box.x+box.width<=viewport.width&&box.y+box.height<=viewport.height,`${label}: Send lies inside the ${viewport.width}x${viewport.height} viewport (${JSON.stringify(box)})`);
}

await runChatTest('composer look: scope, thumbnails, progress and failure',async h=>{
  const {page}=h;
  assert.equal(await page.locator('.nest-chat-composer form.composer').count(),1,'the composer is inside .nest-chat-composer');
  const scope=page.locator('.nest-chat-composer');
  assert.equal(await scope.getByRole('textbox',{name:'Message',exact:true}).count(),1,'the scope keeps the Message textbox');
  assert.equal(await scope.getByRole('button',{name:'Send',exact:true}).count(),1,'the scope keeps the Send button');
  assert.equal(await scope.getByRole('button',{name:'Attach files',exact:true}).count(),1,'the scope keeps Attach files');

  const classes=(await textbox(page).getAttribute('class'))??'';
  const forbidden=classes.split(/\s+/).filter(name=>/^(?:[\w-]+:)*!?(?:-?(?:h|max-h|min-h|top|bottom|left|right|inset|inset-x|inset-y|translate|translate-x|translate-y|scale|scale-x|scale-y)-.+|absolute|relative|fixed|sticky|static|transform|transform-gpu|transform-none)$/.test(name));
  assert.deepEqual(forbidden,[],`the textarea has no Tailwind height, position or transform utility (class="${classes}")`);

  await settle(page);
  const empty=await textareaHeight(page);
  assert.ok(empty>=34&&empty<=56,`the empty-chat textarea is 34 to 56 px high (${empty})`);
  await sendInViewport(page,'desktop 1440x1000');

  // Thumbnail.
  const png=await syntheticComposerPng(h,'thumbnail');
  await fileInput(page).setInputFiles({name:'synthetic-thumbnail.png',mimeType:'image/png',buffer:png});
  await chip(page,'synthetic-thumbnail.png').getByText(/^Ready/).waitFor();
  const thumb=chip(page,'synthetic-thumbnail.png').locator('img');
  assert.equal(await thumb.count(),1,'the image chip shows a thumbnail img');
  await page.waitForFunction(()=>{const img=document.querySelector('.composer-attachments article img') as HTMLImageElement|null;return !!img&&img.complete&&img.naturalWidth>0;});

  // Progress, held server-side after the body was received.
  const hold=h.holdNext('/api/files');
  await fileInput(page).setInputFiles({name:'synthetic-progress.txt',mimeType:'text/plain',buffer:Buffer.from('Synthetic progress body '.repeat(4000))});
  await hold.started;
  const progress=chip(page,'synthetic-progress.txt').getByRole('progressbar');
  await progress.waitFor();
  assert.equal(await progress.getAttribute('aria-valuemin'),'0','the progressbar has aria-valuemin 0');
  assert.equal(await progress.getAttribute('aria-valuemax'),'100','the progressbar has aria-valuemax 100');
  await page.waitForFunction(()=>Array.from(document.querySelectorAll('.composer-attachments article')).some(el=>el.textContent?.includes('synthetic-progress.txt')&&el.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow')==='100'),undefined,{timeout:5000});
  assert.match((await chip(page,'synthetic-progress.txt').innerText()),/Uploading/,'the chip still shows it is uploading at 100%');
  await h.screenshot('T11-composer-desktop-uploading');
  hold.release();
  await chip(page,'synthetic-progress.txt').getByText(/^Ready/).waitFor({timeout:5000});
  assert.equal(await chip(page,'synthetic-progress.txt').getByRole('progressbar').count(),0,'a ready chip has no progressbar');

  // Failure.
  await page.route('**/api/files',route=>route.request().method()==='POST'?route.fulfill({status:500,contentType:'application/json',body:'{"error":"Synthetic upload failure"}'}):route.continue());
  await fileInput(page).setInputFiles({name:'synthetic-failure.txt',mimeType:'text/plain',buffer:Buffer.from('Synthetic failing body')});
  await chip(page,'synthetic-failure.txt').getByText('Synthetic upload failure',{exact:true}).waitFor({timeout:5000});
  assert.equal(await page.getByRole('button',{name:'Remove synthetic-failure.txt',exact:true}).count(),1,'the failed chip has Remove <file name>');
  await page.unroute('**/api/files');
  await h.screenshot('T11-composer-desktop-chips');
  await page.getByRole('button',{name:'Remove synthetic-failure.txt',exact:true}).click();
  await chip(page,'synthetic-failure.txt').waitFor({state:'detached'});
},{viewport:{width:1440,height:1000}});

await runChatTest('composer look: 21 dropped files show the limit',async h=>{
  const {page}=h;
  await page.evaluate(()=>{
    const data=new DataTransfer();
    for(let i=0;i<21;i++)data.items.add(new File([`Synthetic limit body ${i}`],`synthetic-limit-${i}.txt`,{type:'text/plain'}));
    window.dispatchEvent(new DragEvent('drop',{dataTransfer:data,bubbles:true,cancelable:true}));
  });
  await page.getByText('You can attach up to 20 files. 1 file was not added.',{exact:true}).waitFor({timeout:5000});
  await page.waitForFunction(()=>document.querySelectorAll('.composer-attachments article').length===20);
});

await runChatTest('composer look: heights in a non-empty chat and Send at 1440x1100',async h=>{
  const {page}=h;
  await h.emit('message.created',{text:'Synthetic test message so the chat is not empty.'});
  await page.getByText('Synthetic test message so the chat is not empty.').waitFor();
  await page.waitForFunction(()=>!document.querySelector('form.composer.composer-compact'));
  await settle(page);
  const base=await textareaHeight(page);
  assert.ok(base>=34&&base<=56,`the non-empty-chat textarea starts at one line, 34 to 56 px high (${base})`);
  await sendInViewport(page,'desktop 1440x1100');
  const third=Math.max(120,Math.floor(1100/3));
  await textbox(page).fill(Array.from({length:10},(_,i)=>`Synthetic line ${i+1}`).join('\n'));
  await settle(page);
  const ten=await textareaHeight(page);
  assert.ok(ten>base,`10 lines grow the textarea (${base} -> ${ten})`);
  assert.ok(ten<=third+1,`10 lines stay within a third of the viewport (${ten} <= ${third})`);
  await textbox(page).fill(Array.from({length:40},(_,i)=>`Synthetic line ${i+1}`).join('\n'));
  await settle(page);
  const capped=await textareaHeight(page);
  assert.ok(Math.abs(capped-third)<=1,`40 lines cap the textarea at a third of the viewport (${capped} vs ${third})`);
  await sendInViewport(page,'desktop 1440x1100 with 40 lines');
  await textbox(page).fill('Synthetic composer draft');
  await h.screenshot('T11-composer-desktop-light');
},{viewport:{width:1440,height:1100}});

await runChatTest('composer look: mobile 390x844',async h=>{
  const {page}=h;
  await sendInViewport(page,'mobile 390x844 empty');
  await h.emit('message.created',{text:'Synthetic test message for the mobile composer.'});
  await page.getByText('Synthetic test message for the mobile composer.').waitFor();
  await page.waitForFunction(()=>!document.querySelector('form.composer.composer-compact'));
  const png=await syntheticComposerPng(h,'mobile');
  await fileInput(page).setInputFiles({name:'synthetic-mobile.png',mimeType:'image/png',buffer:png});
  await chip(page,'synthetic-mobile.png').getByText(/^Ready/).waitFor();
  await textbox(page).fill('Synthetic mobile draft');
  await settle(page);
  await sendInViewport(page,'mobile 390x844');
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'no horizontal page scroll at 390 px');
  await h.screenshot('T11-composer-mobile-light');
},{viewport:{width:390,height:844}});

await runChatTest('composer look: dark',async h=>{
  const {page}=h;
  await h.emit('message.created',{text:'Synthetic test message for the dark composer.'});
  await page.getByText('Synthetic test message for the dark composer.').waitFor();
  const png=await syntheticComposerPng(h,'dark');
  await fileInput(page).setInputFiles({name:'synthetic-dark.png',mimeType:'image/png',buffer:png});
  await chip(page,'synthetic-dark.png').getByText(/^Ready/).waitFor();
  await textbox(page).fill('Synthetic dark draft');
  await settle(page);
  await sendInViewport(page,'desktop dark');
  await h.screenshot('T11-composer-desktop-dark');
},{viewport:{width:1440,height:1000},colorScheme:'dark'});

// colorScheme alone does not switch Nest's theme; the brand toggle stores it as nest-theme (apps/nest-brand/Brand.tsx).
await runChatTest('composer look: dark theme',async h=>{
  const {page}=h;
  await page.evaluate(()=>localStorage.setItem('nest-theme','dark'));
  await page.reload();
  await textbox(page).waitFor();
  await page.waitForFunction(()=>document.documentElement.dataset.theme==='dark');
  await h.emit('message.created',{text:'Synthetic test message for the dark theme composer.'});
  await page.getByText('Synthetic test message for the dark theme composer.').waitFor();
  const png=await syntheticComposerPng(h,'dark theme');
  await fileInput(page).setInputFiles({name:'synthetic-dark-theme.png',mimeType:'image/png',buffer:png});
  await chip(page,'synthetic-dark-theme.png').getByText(/^Ready/).waitFor();
  await textbox(page).fill('Synthetic dark theme draft');
  await settle(page);
  await sendInViewport(page,'desktop dark theme');
  await h.screenshot('T11-composer-desktop-dark-theme');
},{viewport:{width:1440,height:1000}});
