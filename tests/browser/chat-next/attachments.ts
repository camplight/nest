// Message attachments and the image zoom (Task 13, spec 6.6, 7.1.4): previews, SVG as a link only, links that stay links. Synthetic data only.
import assert from 'node:assert/strict';
import type {Locator,Page} from 'playwright';
import {runChatTest,type ChatHarness} from '../support/chat-harness';

const settled=(page:Page)=>page.waitForFunction(()=>new URL(location.href).searchParams.has('project')&&!document.querySelector('.standalone-workspace')&&!!document.querySelector('.messages-panel'));
const chatUrl=(h:ChatHarness)=>`${h.base}/?channel=${h.project.channelId}`;
const link=(scope:Locator|Page,name:string)=>scope.getByRole('link',{name,exact:true});
const img=(scope:Locator|Page,name:string)=>scope.getByRole('img',{name,exact:true});
const FALLBACK='Preview unavailable. Open the file using the link above.';

// A small real png, rendered by the browser so the preview decodes.
async function syntheticPng(h:ChatHarness,label:string):Promise<Uint8Array>{
  const page=await h.context.newPage();
  await page.setContent(`<div style="width:320px;height:160px;background:#350956;color:white;font:20px sans-serif;padding:20px;box-sizing:border-box">SYNTHETIC TEST ARTWORK ${label}</div>`);
  const bytes=await page.locator('div').screenshot();
  await page.close();
  return bytes;
}

// The zoom must be a plain left click only; the dialog is named by the file name (ImageZoom).
async function zoomOnPlainClick(page:Page,scope:Locator,name:string,label:string){
  await link(scope,`Open ${name}`).click();
  const dialog=page.getByRole('dialog',{name,exact:true});
  await dialog.waitFor({timeout:3000});
  assert.equal(await dialog.getByRole('link',{name:'Open original',exact:true}).count(),1,`${label}: the dialog has Open original`);
  assert.equal(await page.locator('.nest-chat-portal [role=dialog]').count(),1,`${label}: the dialog renders inside .nest-chat-portal`);
  await page.keyboard.press('Escape');
  await dialog.waitFor({state:'hidden',timeout:3000});
}

await runChatTest('attachments: previews, zoom, SVG link only, fallback',async h=>{
  const {page,context}=h;
  const chart='synthetic-chart.png',vector='synthetic-diagram.svg',missing='synthetic-missing.png',human='synthetic-human-photo.png';
  const chartBytes=await syntheticPng(h,'chart');
  const {fileId}=await h.upload(chart,chartBytes,'image/png');
  const agent=await h.emit('message.created',{text:'Synthetic test data: a chart and its source.',attachments:[
    {fileId,name:chart,mime:'image/png',size:chartBytes.length},
    {fileId,name:vector,mime:'image/svg+xml',size:320},
  ]});
  await page.goto(chatUrl(h));
  await settled(page);
  const agentMessage=page.locator(`#message-${agent.id}`);
  await agentMessage.waitFor();

  // First statement: the preview link targets the file, and a plain click opens the zoom, not a page.
  const open=link(agentMessage,`Open ${chart}`);
  assert.equal(await open.getAttribute('href'),`/api/files/${fileId}`,'Open link targets /api/files/<id>');
  const popups:Page[]=[];
  const onPage=(opened:Page)=>{popups.push(opened);};
  context.on('page',onPage);
  await open.click();
  const dialog=page.getByRole('dialog');
  await dialog.waitFor({timeout:3000});

  // The dialog has Open original.
  assert.equal(await dialog.getByRole('link',{name:'Open original',exact:true}).count(),1,'the dialog has Open original');
  assert.equal(await page.locator('.nest-chat-portal [role=dialog]').count(),1,'the dialog renders inside .nest-chat-portal');
  await page.waitForTimeout(200);
  assert.equal(popups.length,0,'a plain click opens no new page');
  await page.keyboard.press('Escape');
  await dialog.waitFor({state:'hidden',timeout:3000});
  context.off('page',onPage);

  // A modified click (platform modifier, and shift) is a normal link: a new page and no dialog.
  for(const modifiers of [['ControlOrMeta'],['Shift']] as const){
    const [opened]=await Promise.all([context.waitForEvent('page',{timeout:5000}),open.click({modifiers:[...modifiers]})]);
    await opened.close();
    await page.waitForTimeout(200);
    assert.equal(await page.getByRole('dialog').count(),0,`${modifiers.join('+')} click opens no dialog`);
  }

  // While the dialog is closed, exactly one img per preview, named by the file name.
  assert.equal(await img(page,chart).count(),1,'one img named by the file name');
  await img(page,chart).evaluate((node:HTMLImageElement)=>node.decode());

  // SVG is a link only, never an img.
  assert.equal(await img(page,vector).count(),0,'no img for the SVG attachment');
  assert.equal(await link(agentMessage,vector).getAttribute('href'),`/api/files/${fileId}`,'the SVG keeps its file link');
  assert.equal(await link(agentMessage,`Open ${vector}`).count(),0,'the SVG has no preview link');

  // A missing file keeps its link and shows the fallback.
  const broken=await h.emit('message.created',{text:'Synthetic test data: a missing image.',attachments:[{fileId:'missing-synthetic-image',name:missing,mime:'image/png'}]});
  const brokenMessage=page.locator(`#message-${broken.id}`);
  await brokenMessage.getByText(FALLBACK,{exact:true}).waitFor({timeout:8000});
  assert.equal(await link(brokenMessage,missing).count(),1,'the missing file keeps one text link');
  assert.equal(await img(page,missing).count(),0,'the failed preview leaves no img');

  // A human message renders the same structure: link, preview and zoom on a plain click.
  const humanBytes=await syntheticPng(h,'human');
  const upload=await h.upload(human,humanBytes,'image/png');
  const mine=await h.emit('message.created',{text:'Synthetic test data: a human upload.',attachments:[{fileId:upload.fileId,name:human,mime:'image/png',size:humanBytes.length}]},{source:'human:demo-owner'});
  const humanMessage=page.locator(`#message-${mine.id}`);
  await humanMessage.waitFor({timeout:8000});
  assert.equal(await link(humanMessage,`Open ${human}`).getAttribute('href'),`/api/files/${upload.fileId}`,'human: Open link targets the file');
  assert.equal(await link(humanMessage,human).count(),1,'human: the text link is named by the file name');
  assert.equal(await img(humanMessage,human).count(),1,'human: one preview img');
  await zoomOnPlainClick(page,humanMessage,human,'human');

  // The text link's accessible name is the file name exactly; mime and size follow it.
  assert.equal(await link(agentMessage,chart).count(),1,'the text link is named by the file name');
  assert.equal(await agentMessage.locator('li.message-attachment').count(),2,'one li.message-attachment per file');
  assert.match(await agentMessage.locator('li.message-attachment').first().innerText(),/image\/png • \d/,'mime and size are shown');
});
