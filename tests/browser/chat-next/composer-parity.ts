// Composer parity in the new chat (Task 10): a regression guard for the composer move out of App.tsx. Send path,
// retry ids, drafts across channel switches, IME, the sending state, file-only sends and demo "Request changes".
// Synthetic data.
import assert from 'node:assert/strict';
import type {Page} from 'playwright';
import {runChatTest,type ChatHarness} from '../support/chat-harness';

type Posted={id:string;text:string;mentions:{name:string}[];attachments:{name:string}[]};
const textbox=(page:Page)=>page.getByRole('textbox',{name:'Message',exact:true});
const sendButton=(page:Page)=>page.locator('form.composer button:not([type="button"])');
const posts=(page:Page)=>{
  const bodies:Posted[]=[];
  page.on('request',request=>{if(request.method()==='POST'&&new URL(request.url()).pathname==='/api/messages')bodies.push(JSON.parse(request.postData()??'{}') as Posted);});
  return bodies;
};
const attach=async(page:Page,name:string)=>{
  await page.locator('form.composer input[type="file"]').setInputFiles({name,mimeType:'text/plain',buffer:Buffer.from('Synthetic attachment body')});
  await page.locator('.composer-attachments article',{hasText:name}).getByText(/^Ready/).waitFor();
};
const mentionPip=async(page:Page)=>{
  await textbox(page).pressSequentially(' @Pi');
  await page.getByRole('listbox',{name:'Mention people and agents'}).getByRole('option').filter({hasText:'Pip'}).click();
  await page.getByLabel('Message recipients').getByText('Ask @Pip').waitFor();
};
const otherProject=async(h:ChatHarness)=>await(await h.post('/api/projects',{id:crypto.randomUUID(),name:'Synthetic other project',description:'Synthetic test project',members:[{subscriberType:'AGENT',subscriberId:'Pip'}]})).json() as {id:string;channelId:string};
const projectLink=(page:Page,name:string)=>page.locator('.project-navigation-link',{hasText:name});
const storedDraft=(page:Page,channelId:string)=>page.evaluate(channel=>{
  for(let i=0;i<localStorage.length;i++){const name=localStorage.key(i)!;if(name.startsWith('nest:draft:')&&name.endsWith(':'+encodeURIComponent(channel)))return JSON.parse(localStorage.getItem(name)!) as {text:string};}
  return null;
},channelId);

await runChatTest('composer parity: placement, draft status and IME',async h=>{
  const {page}=h;
  await page.locator('.nest-chat').waitFor();
  const follows=await page.evaluate(()=>{
    const chat=document.querySelector('.nest-chat'),composer=document.querySelector('form.composer');
    return !!chat&&!!composer&&Boolean(chat.compareDocumentPosition(composer)&Node.DOCUMENT_POSITION_FOLLOWING)&&!chat.contains(composer);
  });
  assert.equal(follows,true,'a .composer form follows .nest-chat in document order');
  const bodies=posts(page);
  await textbox(page).fill('Synthetic IME draft');
  await page.getByText('Draft saved on this device',{exact:true}).waitFor({timeout:3000});
  await textbox(page).dispatchEvent('keydown',{key:'Enter',code:'Enter',isComposing:true,bubbles:true,cancelable:true});
  await page.waitForTimeout(800);
  assert.equal(bodies.length,0,'Enter during IME composition posts nothing');
  assert.equal(await textbox(page).inputValue(),'Synthetic IME draft','the text stays after IME Enter');
});

await runChatTest('composer parity: a 503 keeps the draft and the retry reuses the id',async h=>{
  const {page}=h;
  const bodies=posts(page);
  let failNext=true;
  await page.route('**/api/messages',route=>{
    if(route.request().method()==='POST'&&failNext){failNext=false;return route.fulfill({status:503,contentType:'application/json',body:'{"error":"Synthetic outage"}'});}
    return route.continue();
  });
  await textbox(page).fill('Synthetic retry message');
  await mentionPip(page);
  await attach(page,'synthetic-retry.txt');
  const typed=await textbox(page).inputValue();
  await sendButton(page).click();
  await page.waitForFunction(()=>document.querySelector('[role="alert"].notice'));
  await page.waitForFunction(()=>document.querySelector('form.composer button:not([type="button"])')?.textContent==='Send');
  assert.equal(bodies.length,1,'one POST before the retry');
  assert.equal(await textbox(page).inputValue(),typed,'the text is kept after a 503');
  assert.equal(await page.getByLabel('Message recipients').getByText('Ask @Pip').count(),1,'the mention is kept after a 503');
  assert.equal(await page.locator('.composer-attachments article',{hasText:'synthetic-retry.txt'}).count(),1,'the attachment is kept after a 503');
  assert.equal((await sendButton(page).innerText()).trim(),'Send','the button reads Send after a 503');
  await sendButton(page).click();
  await page.waitForFunction(()=>(document.querySelector('textarea[aria-label="Message"]') as HTMLTextAreaElement|null)?.value==='');
  assert.equal(bodies.length,2,'the retry posts once');
  assert.equal(bodies[1].id,bodies[0].id,'the retry posts the same id');
  assert.deepEqual(bodies[1].mentions.map(m=>m.name),['Pip'],'the retry carries the mention');
  assert.deepEqual(bodies[1].attachments.map(a=>a.name),['synthetic-retry.txt'],'the retry carries the attachment');
});

await runChatTest('composer parity: editing after a failure posts a new id',async h=>{
  const {page}=h;
  const bodies=posts(page);
  let failNext=true;
  await page.route('**/api/messages',route=>{
    if(route.request().method()==='POST'&&failNext){failNext=false;return route.fulfill({status:503,contentType:'application/json',body:'{"error":"Synthetic outage"}'});}
    return route.continue();
  });
  await textbox(page).fill('Synthetic first wording');
  await sendButton(page).click();
  await page.waitForFunction(()=>document.querySelector('[role="alert"].notice'));
  await page.waitForFunction(()=>document.querySelector('form.composer button:not([type="button"])')?.textContent==='Send');
  await textbox(page).fill('Synthetic second wording');
  await sendButton(page).click();
  await page.waitForFunction(()=>(document.querySelector('textarea[aria-label="Message"]') as HTMLTextAreaElement|null)?.value==='');
  assert.equal(bodies.length,2,'two POSTs');
  assert.equal(bodies[1].text,'Synthetic second wording','the edited text is posted');
  assert.notEqual(bodies[1].id,bodies[0].id,'editing after the failure posts a new id');
});

await runChatTest('composer parity: sending state and a held send across a channel switch',async h=>{
  const {page}=h;
  const other=await otherProject(h);
  await page.goto(`${h.base}/?view=projects&project=${h.project.id}`);
  await projectLink(page,'Synthetic other project').waitFor();
  // Channel B gets a draft first.
  await projectLink(page,'Synthetic other project').click();
  await page.waitForFunction(id=>new URL(location.href).searchParams.get('project')===id,other.id);
  await textbox(page).fill('Synthetic second-channel draft');
  await page.getByText('Draft saved on this device',{exact:true}).waitFor({timeout:3000});
  await projectLink(page,'Synthetic chat project').click();
  await page.waitForFunction(id=>new URL(location.href).searchParams.get('project')===id,h.project.id);
  await page.waitForFunction(()=>(document.querySelector('textarea[aria-label="Message"]') as HTMLTextAreaElement|null)?.value==='');
  // Channel A sends, held server-side.
  const hold=h.holdNext('/api/messages');
  await textbox(page).fill('Synthetic held message');
  await sendButton(page).click();
  await hold.started;
  await page.waitForFunction(()=>document.querySelector('form.composer button:not([type="button"])')?.textContent==='Sending...');
  assert.equal(await textbox(page).isDisabled(),true,'the textarea is disabled while sending');
  assert.equal(await page.getByRole('button',{name:'Attach files',exact:true}).isDisabled(),true,'Attach files is disabled while sending');
  assert.equal((await sendButton(page).innerText()).trim(),'Sending...','Send reads Sending... while sending');
  // Switch to B while the send is held, then release it.
  await projectLink(page,'Synthetic other project').click();
  await page.waitForFunction(id=>new URL(location.href).searchParams.get('project')===id,other.id);
  await page.waitForFunction(()=>(document.querySelector('textarea[aria-label="Message"]') as HTMLTextAreaElement|null)?.value==='Synthetic second-channel draft');
  hold.release();
  await page.waitForFunction(()=>document.querySelector('form.composer button:not([type="button"])')?.textContent==='Send');
  await page.waitForTimeout(800);
  assert.equal(await textbox(page).inputValue(),'Synthetic second-channel draft','the second channel keeps its draft in the textbox');
  assert.equal((await storedDraft(page,other.channelId))?.text,'Synthetic second-channel draft','the second channel keeps its saved draft');
});

await runChatTest('composer parity: a file-only send and demo Request changes',async h=>{
  const {page}=h;
  const bodies=posts(page);
  await attach(page,'synthetic-only.txt');
  await sendButton(page).click();
  await page.waitForFunction(()=>!document.querySelector('.composer-attachments article'));
  assert.equal(bodies.length,1,'one POST for the file-only send');
  assert.equal(bodies[0].text,'Attached 1 file for reference.','a file-only send posts the attachment text');

  await page.route('**/demo/launch?*',route=>route.fulfill({headers:{etag:'1'},contentType:'text/html',body:'<!doctype html><html><body><h1>Synthetic launch demo</h1></body></html>'}));
  await h.emit('message.created',{text:'Synthetic [launch demo](/demo/launch). Tell me what to change.'});
  await page.getByRole('button',{name:'Preview launch'}).click();
  await textbox(page).fill('Keep the colors.');
  await page.getByRole('complementary',{name:'Demo artifact preview'}).getByRole('button',{name:'Request changes'}).click();
  assert.equal(await textbox(page).inputValue(),`Keep the colors.\n\nPlease update ${h.base}/demo/launch: `,'Request changes appends the update line');
  assert.equal(await page.evaluate(()=>document.activeElement?.getAttribute('aria-label')),'Message','the textbox is focused');
});

// T10-V1: the composer state lives above the project tabs, so Chat -> Files -> Chat keeps a held upload and a held send.
const projectTab=(page:Page,name:string)=>page.getByRole('navigation',{name:'Project sections'}).getByRole('button',{name,exact:true});
const viaFilesTab=async(page:Page)=>{
  await projectTab(page,'Files').click();
  await page.locator('form.composer').waitFor({state:'detached'});
  await projectTab(page,'Chat').click();
  await page.locator('form.composer').waitFor();
};

await runChatTest('composer parity: a held upload and a held send survive a Files tab switch',async h=>{
  const {page}=h;
  await page.goto(`${h.base}/?view=projects&project=${h.project.id}`);
  await textbox(page).waitFor();
  const upload=h.holdNext('/api/files');
  await page.locator('form.composer input[type="file"]').setInputFiles({name:'synthetic-tab-upload.txt',mimeType:'text/plain',buffer:Buffer.from('Synthetic attachment body')});
  await upload.started;
  await viaFilesTab(page);
  upload.release();
  await page.locator('.composer-attachments article',{hasText:'synthetic-tab-upload.txt'}).getByText(/^Ready/).waitFor({timeout:5000});
  await page.locator('.composer-attachments article',{hasText:'synthetic-tab-upload.txt'}).getByRole('button',{name:/^Remove/}).click();
  await page.waitForFunction(()=>!document.querySelector('.composer-attachments article'));

  const bodies=posts(page);
  const send=h.holdNext('/api/messages');
  await textbox(page).fill('Synthetic tab-switch message');
  await sendButton(page).click();
  await send.started;
  await viaFilesTab(page);
  assert.equal((await sendButton(page).innerText()).trim(),'Sending...','Send still reads Sending... after the tab switch');
  assert.equal(await textbox(page).isDisabled(),true,'the textarea stays disabled after the tab switch');
  send.release();
  await page.waitForFunction(()=>document.querySelector('form.composer button:not([type="button"])')?.textContent==='Send');
  await page.waitForTimeout(800);
  assert.equal(await textbox(page).inputValue(),'','the sent text leaves the composer');
  assert.equal(bodies.length,1,'one POST for the held send');
  assert.equal((await storedDraft(page,h.project.channelId))?.text??'','','no sent draft is kept');
});

// T10-V2: the mention picker lives with the session, so an invite in flight survives Chat -> Files -> Chat.
await runChatTest('composer parity: a held mention invite survives a Files tab switch',async h=>{
  const {page}=h;
  const agent=await h.post('/api/agents',{name:'Quill',icon:'pip',visibility:'PUBLIC',modelId:'wrapped:none',workspacePath:'/private/tmp/claude-501/nest-chat-ui-synthetic-quill'});
  assert.ok(agent.ok,'the synthetic agent Quill is created');
  await page.goto(`${h.base}/?view=projects&project=${h.project.id}`);
  await textbox(page).waitFor();
  await textbox(page).fill('Synthetic invite draft');
  const invite=h.holdNext(`/api/projects/${h.project.id}/members`);
  await textbox(page).pressSequentially(' @Qu');
  await page.getByRole('listbox',{name:'Mention people and agents'}).getByRole('option').filter({hasText:'Quill'}).click();
  await invite.started;
  await viaFilesTab(page);
  assert.equal(await sendButton(page).isDisabled(),true,'Send stays disabled while the invite is in flight after the tab switch');
  assert.notEqual(await textbox(page).getAttribute('readonly'),null,'the textbox stays read-only while the invite is in flight');
  invite.release();
  await page.getByLabel('Message recipients').getByText('Ask @Quill').waitFor({timeout:5000});
  assert.equal(await textbox(page).inputValue(),'Synthetic invite draft @Quill ','the picked mention is inserted after the invite resolves');
});
