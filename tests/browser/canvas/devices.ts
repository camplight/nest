// Devices, theme and scale (Task 12): phone list, tablet pinch, light and dark contrast, 150 cards and reload,
// on the real engine, API and WS. Synthetic data.
import assert from 'node:assert/strict';
import {mkdtempSync,realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {Page} from 'playwright';
import {agentName,runChatTest,type ChatHarness} from '../support/chat-harness';

async function call<T>(h:ChatHarness,method:string,path:string,body?:unknown,cookie=h.cookie):Promise<T>{
  const response=await fetch(h.apiUrl+path,{method,headers:{cookie,'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
  if(!response.ok)throw Error(`${method} ${path}: ${response.status} ${await response.text()}`);
  return response.status===204?undefined as T:await response.json() as T;
}
/** Runs `task` over `items`, `size` at a time, so seeding stays quick without flooding the engine. */
async function inBatches<T,R>(items:T[],size:number,task:(item:T,index:number)=>Promise<R>):Promise<R[]>{
  const results:R[]=[];
  for(let i=0;i<items.length;i+=size)results.push(...await Promise.all(items.slice(i,i+size).map((item,j)=>task(item,i+j))));
  return results;
}
const newProject=(h:ChatHarness,name:string,agents:string[]=[agentName])=>call<{id:string;channelId:string}>(h,'POST','/api/projects',
  {id:crypto.randomUUID(),name,description:'Synthetic test project',members:agents.map(subscriberId=>({subscriberType:'AGENT',subscriberId}))});
const newCanvas=async(h:ChatHarness,name:string)=>(await call<{id:string}>(h,'POST','/api/canvases',{id:crypto.randomUUID(),name})).id;
const newArea=(h:ChatHarness,canvasId:string,area:{title:string;x:number;y:number;w:number;h:number})=>
  call(h,'POST',`/api/canvases/${canvasId}/areas`,{id:crypto.randomUUID(),...area});
const cardAt=(page:Page,channelId:string)=>page.locator(`.canvas-card[data-channel-id="${channelId}"]`);
const zoomLabel=(page:Page)=>page.getByLabel('Zoom level',{exact:true});
async function shareWith(h:ChatHarness,canvasId:string,username:string,role:'edit'|'view'){
  const humans=await call<{id:string;username:string}[]>(h,'GET','/api/humans');
  const {canvas}=await call<{canvas:{version:number}}>(h,'GET',`/api/canvases/${canvasId}/board`);
  await call(h,'PUT',`/api/canvases/${canvasId}/members`,{visibility:'shared',members:[{humanId:humans.find(p=>p.username===username)!.id,role}],version:canvas.version});
}
/** Fixture: a turn that began 25 minutes ago with no later agent signal, while Pip keeps running (as in cards.ts). */
async function quietTurn(h:ChatHarness,channelId:string){
  const trigger=await h.emit('message.created',{text:'Synthetic trigger'},{source:'human:demo-owner',channelId});
  const turn=await h.emit('agent.turn.started',{triggerEventId:trigger.id},{source:`agent:${agentName}`,channelId});
  h.engineDb.prepare('UPDATE events SET created_at=? WHERE id IN (?,?)').run(Date.now()-25*60_000-5_000,trigger.id,turn.id);
  const at=Date.now();
  h.engineDb.prepare("UPDATE agents SET desired_state='RUNNING', runtime_state='RUNNING', last_heartbeat_at=?, updated_at=? WHERE name=?").run(at,at,agentName);
}
async function failedTurn(h:ChatHarness,channelId:string){
  const trigger=await h.emit('message.created',{text:'Synthetic trigger'},{source:'human:demo-owner',channelId});
  await h.emit('agent.turn.started',{triggerEventId:trigger.id},{source:`agent:${agentName}`,channelId});
  await h.emit('agent.turn.failed',{triggerEventId:trigger.id,error:'Synthetic failure'},{source:`agent:${agentName}`,channelId});
}
async function useTheme(page:Page,theme:'light'|'dark'){
  await page.evaluate(value=>localStorage.setItem('nest-theme',value),theme);
  await page.reload();
  await page.waitForFunction(value=>document.documentElement.dataset.theme===value,theme);
}

/** tsx names inner functions with an `__name` helper that a page script does not have. */
const keepNames=(page:Page)=>page.evaluate('globalThis.__name??=(fn=>fn)');

type Contrast={text:string;ratio:number;color:string;background:string};
/**
 * The contrast of every visible text run in the mounted cards, from computed styles: the text colour is
 * composited over the stack of ancestor backgrounds on a 1×1 canvas, then compared by WCAG relative luminance.
 */
async function cardContrasts(page:Page):Promise<Contrast[]>{
  await keepNames(page);
  return page.evaluate(()=>{
    const canvas=document.createElement('canvas');canvas.width=canvas.height=1;
    const ctx=canvas.getContext('2d',{willReadFrequently:true})!;
    const paint=(colors:string[])=>{
      ctx.clearRect(0,0,1,1);ctx.fillStyle='#ffffff';ctx.fillRect(0,0,1,1);
      for(const color of colors){ctx.fillStyle='#010203';ctx.fillStyle=color;ctx.fillRect(0,0,1,1);}
      const [r,g,b]=ctx.getImageData(0,0,1,1).data;return [r,g,b];
    };
    const luminance=(rgb:number[])=>{
      const [r,g,b]=rgb.map(v=>{const c=v/255;return c<=0.04045?c/12.92:((c+0.055)/1.055)**2.4;});
      return 0.2126*r+0.7152*g+0.0722*b;
    };
    const results:Contrast[]=[];
    for(const card of document.querySelectorAll<HTMLElement>('.canvas-card')){
      for(const element of [card,...card.querySelectorAll<HTMLElement>('*')]){
        const text=[...element.childNodes].filter(node=>node.nodeType===Node.TEXT_NODE).map(node=>node.textContent??'').join('').trim();
        if(!text)continue;
        const box=element.getBoundingClientRect(),style=getComputedStyle(element);
        if(box.width<=1||box.height<=1||style.visibility!=='visible')continue;
        const layers:string[]=[];
        for(let node:HTMLElement|null=element;node;node=node.parentElement){
          const background=getComputedStyle(node).backgroundColor;
          if(background&&background!=='rgba(0, 0, 0, 0)'&&background!=='transparent')layers.unshift(background);
        }
        const back=paint(layers),fore=paint([...layers,style.color]);
        const [a,b]=[luminance(back),luminance(fore)].sort((x,y)=>y-x);
        results.push({text:text.slice(0,40),ratio:Math.round((a+0.05)/(b+0.05)*100)/100,color:style.color,background:layers.at(-1)??'none'});
      }
    }
    return results;
  });
}
async function assertContrast(page:Page,what:string,expect:string[]){
  const all=await cardContrasts(page);
  for(const text of expect)assert.ok(all.some(item=>item.text.startsWith(text)),`${what}: measured "${text}" (${JSON.stringify(all.map(i=>i.text))})`);
  const low=all.filter(item=>item.ratio<4.5);
  assert.deepEqual(low,[],`${what}: card text below 4.5:1`);
  return Math.min(...all.map(item=>item.ratio));
}

await runChatTest('canvas devices: a phone gets the list with areas, needs you and loose chats, and opens chats full screen',async h=>{
  const {page,base}=h;
  const hidden=(await call<{id:string}>(h,'POST','/api/channels',{name:'Hidden roadmap rehearsal',visibility:'PRIVATE'})).id;
  const placed=await newProject(h,'Synthetic placed chat');
  const loose=await newProject(h,'Synthetic loose chat');
  const id=await newCanvas(h,'Phone launch');
  await newArea(h,id,{title:'Launch content',x:0,y:0,w:900,h:500});
  await newArea(h,id,{title:'Review',x:1200,y:0,w:600,h:500});
  await call(h,'POST',`/api/canvases/${id}/cards`,{cards:[
    {channelId:h.project.channelId,x:60,y:80},{channelId:placed.channelId,x:400,y:80},
    {channelId:hidden,x:1260,y:80},
  ]});
  const mate=await h.loginAs('mate');
  await shareWith(h,id,'mate','view');

  await page.goto(`${base}/?view=canvas&canvas=${id}`);
  const list=page.getByRole('region',{name:'Canvas list',exact:true});
  await list.waitFor();
  assert.equal(await page.locator('.canvas-surface').count(),0,'no free canvas on a phone');
  assert.equal(await page.locator('.canvas-drawer, .canvas-tray').count(),0,'no open Loose chats drawer or agent tray on a phone');
  assert.equal(await page.locator('[data-drag]').count(),0,'nothing to drag on a phone');
  const tabs=list.getByRole('tablist',{name:'Sections',exact:true});
  assert.deepEqual(await tabs.getByRole('tab').evaluateAll(els=>els.map(el=>el.firstChild?.textContent)),['Areas','Needs you','Loose chats']);
  assert.equal(await tabs.getByRole('tab',{name:/^Areas/}).getAttribute('aria-selected'),'true','Areas is the first segment');
  // The bottom box stays.
  await page.getByRole('region',{name:'Start a chat',exact:true}).waitFor();

  // Areas expand to their chats; a chat outside every area is listed after them.
  const area=list.getByRole('button',{name:/^Launch content/});
  assert.equal(await area.getAttribute('aria-expanded'),'false');
  await area.tap();
  assert.equal(await area.getAttribute('aria-expanded'),'true');
  const launch=list.getByRole('list',{name:'Chats in Launch content',exact:true});
  assert.deepEqual(await launch.getByRole('button').evaluateAll(els=>els.map(el=>el.querySelector('.canvas-phone-title')?.textContent)),['Synthetic chat project','Synthetic placed chat']);

  // Tapping a chat opens it in focus, over the whole body.
  await launch.getByRole('button',{name:/^Synthetic placed chat/}).tap();
  const chat=page.locator('.canvas-chat');
  await chat.waitFor();
  assert.equal(await chat.getAttribute('data-mode'),'focus');
  assert.equal(new URL(page.url()).searchParams.get('chat'),placed.channelId);
  const chatBox=(await chat.boundingBox())!,bodyBox=(await page.locator('.canvas-body').boundingBox())!;
  assert.ok(Math.abs(chatBox.width-bodyBox.width)<=1&&Math.abs(chatBox.height-bodyBox.height)<=1,`the chat fills the body: ${JSON.stringify(chatBox)} vs ${JSON.stringify(bodyBox)}`);
  await chat.getByRole('textbox',{name:'Message',exact:true}).waitFor();
  await chat.getByRole('button',{name:'Close',exact:true}).tap();
  await chat.waitFor({state:'detached'});
  await list.waitFor();

  // Loose chats lists the person's chats that are not on this canvas, and they open too.
  await tabs.getByRole('tab',{name:/^Loose chats/}).tap();
  const looseList=list.getByRole('list',{name:'Loose chats',exact:true});
  await looseList.getByRole('button',{name:/^Synthetic loose chat/}).waitFor();
  assert.equal(await looseList.getByRole('button',{name:/^Synthetic placed chat/}).count(),0,'a placed chat is not loose');
  await list.getByRole('searchbox',{name:'Search loose chats',exact:true}).fill('nothing matches this');
  assert.equal(await looseList.getByRole('button').count(),0,'the search filters the list');
  await list.getByRole('searchbox',{name:'Search loose chats',exact:true}).fill('loose');
  await looseList.getByRole('button',{name:/^Synthetic loose chat/}).tap();
  await chat.waitFor();
  assert.equal(new URL(page.url()).searchParams.get('chat'),loose.channelId);
  await chat.getByRole('button',{name:'Close',exact:true}).tap();
  await chat.waitFor({state:'detached'});

  // The top bar's Loose chats toggle shrinks to its icon and count. A phone has no drawer: the toggle selects the
  // list's own Loose chats segment and brings it into view.
  const toggle=page.locator('.canvas-loose-button');
  assert.equal(await toggle.locator('.canvas-loose-count').innerText(),'1');
  assert.equal(await toggle.locator('.canvas-loose-label').evaluate(el=>el.getBoundingClientRect().width<=1),true,'the label is visually hidden');
  assert.ok((await toggle.boundingBox())!.width<=72,'icon and count only');
  assert.equal(await toggle.getAttribute('aria-expanded'),null,'nothing to expand on a phone');
  await tabs.getByRole('tab',{name:/^Areas/}).tap();
  await list.evaluate(el=>el.closest('.canvas-phone-stage')?.scrollTo?.(0,10_000));
  await toggle.tap();
  const looseTab=tabs.getByRole('tab',{name:/^Loose chats/});
  for(let i=0;i<50&&await looseTab.getAttribute('aria-selected')!=='true';i++)await page.waitForTimeout(100);
  assert.equal(await looseTab.getAttribute('aria-selected'),'true','the toggle selects Loose chats');
  assert.equal(await looseTab.evaluate(el=>document.activeElement===el),true,'focus moves to the tab');
  await looseList.getByRole('button',{name:/^Synthetic loose chat/}).waitFor();
  const tabsBox=(await tabs.boundingBox())!,shown=(await page.locator('.canvas-body').boundingBox())!;
  assert.ok(tabsBox.y>=shown.y-1&&tabsBox.y<shown.y+shown.height,`the segments are in view: ${JSON.stringify(tabsBox)}`);
  assert.equal(await page.locator('.canvas-drawer').count(),0,'no second, full-screen drawer');

  // Needs you lists a real mention from the mate, and opens its chat.
  await tabs.getByRole('tab',{name:/^Needs you/}).tap();
  assert.equal(await list.getByText('Nothing needs you right now.',{exact:true}).count(),1);
  const sent=await mate.page.evaluate(async channelId=>(await fetch('/api/messages',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({
    id:crypto.randomUUID(),channelId,text:'@demo-owner please check the plan',mentions:[{kind:'HUMAN',name:'demo-owner',start:0,end:11}],attachments:[]})})).status,h.project.channelId);
  assert.equal(sent,201);
  const needs=list.getByRole('list',{name:'Needs you',exact:true});
  const item=needs.getByRole('button').first();
  await item.waitFor();
  assert.match(await item.innerText(),/Synthetic chat project/);
  assert.match(await item.innerText(),/mate/);
  await item.tap();
  await chat.waitFor();
  assert.equal(new URL(page.url()).searchParams.get('chat'),h.project.channelId);
  await chat.getByRole('button',{name:'Close',exact:true}).tap();
  await chat.waitFor({state:'detached'});

  // The Menu button opens the sidebar, as in the other views.
  await page.getByRole('button',{name:'Menu',exact:true}).tap();
  await page.locator('.sidebar-mobile-open').waitFor({state:'visible'});
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'no horizontal page scroll at 390 px');

  // A viewer who is not in a chat sees it as a private row that never opens.
  await mate.page.goto(`${base}/?view=canvas&canvas=${id}`);
  const theirs=mate.page.getByRole('region',{name:'Canvas list',exact:true});
  await theirs.waitFor();
  await theirs.getByRole('button',{name:/^Review/}).tap();
  const review=theirs.getByRole('list',{name:'Chats in Review',exact:true});
  const locked=review.getByRole('listitem').first();
  await locked.waitFor();
  assert.match(await locked.innerText(),/Private chat/);
  assert.match(await locked.innerText(),/demo-owner/);
  assert.equal(await locked.getByRole('button').count(),0,'a locked row has nothing to tap');
  assert.equal(await mate.page.getByText('Hidden roadmap rehearsal').count(),0,'the title stays hidden');
  await locked.tap();
  await mate.page.waitForTimeout(200);
  assert.equal(await mate.page.locator('.canvas-chat').count(),0,'a locked row never opens');
},{canvas:true,viewport:{width:390,height:844},hasTouch:true});

await runChatTest('canvas devices: a tablet keeps the surface and a pinch zooms',async h=>{
  const {page,base}=h;
  const id=await newCanvas(h,'Tablet launch');
  await call(h,'POST',`/api/canvases/${id}/cards`,{cards:[{channelId:h.project.channelId,x:120,y:120}]});
  await page.goto(`${base}/?view=canvas&canvas=${id}`);
  await cardAt(page,h.project.channelId).waitFor();
  assert.equal(await page.locator('.canvas-phone').count(),0,'no phone list at 1024 px');
  await zoomLabel(page).waitFor();
  const before=Number.parseInt(await zoomLabel(page).textContent()??'',10);
  const surface=(await page.locator('.canvas-surface').boundingBox())!;
  const cx=Math.round(surface.x+surface.width/2),cy=Math.round(surface.y+surface.height/2);
  const cdp=await page.context().newCDPSession(page);
  const touch=(type:'touchStart'|'touchMove'|'touchEnd',spread:number)=>cdp.send('Input.dispatchTouchEvent',{type,
    touchPoints:type==='touchEnd'?[]:[{x:cx-spread,y:cy,id:0},{x:cx+spread,y:cy,id:1}]});
  await touch('touchStart',40);
  for(const spread of [48,56,63,70])await touch('touchMove',spread);
  await touch('touchEnd',0);
  await page.waitForFunction(label=>document.querySelector('[aria-label="Zoom level"]')?.textContent!==label,`${before}%`);
  const after=Number.parseInt(await zoomLabel(page).textContent()??'',10);
  assert.ok(Math.abs(after-before*1.75)<=10,`pinch zoom: ${before}% -> ${after}%`);
},{canvas:true,viewport:{width:1024,height:768},hasTouch:true});

await runChatTest('canvas devices: card text keeps 4.5:1 contrast in light and dark, and focus shows in forced colours',async h=>{
  const {page,base}=h;
  const hidden=(await call<{id:string}>(h,'POST','/api/channels',{name:'Hidden roadmap rehearsal',visibility:'PRIVATE'})).id;
  const failing=await newProject(h,'Synthetic failing chat');
  const id=await newCanvas(h,'Theme launch');
  await newArea(h,id,{title:'Launch content',x:0,y:0,w:1000,h:420});
  await call(h,'POST',`/api/canvases/${id}/cards`,{cards:[
    {channelId:h.project.channelId,x:40,y:80},{channelId:failing.channelId,x:360,y:80},{channelId:hidden,x:680,y:80},
  ]});
  await quietTurn(h,h.project.channelId);
  await failedTurn(h,failing.channelId);
  const {fileId}=await h.upload('synthetic-brief.txt',new TextEncoder().encode('Synthetic brief'),'text/plain');
  assert.equal((await h.post('/api/messages',{id:crypto.randomUUID(),channelId:h.project.channelId,text:'Synthetic brief attached',mentions:[],
    attachments:[{fileId,name:'synthetic-brief.txt',mime:'text/plain'}]})).ok,true);
  const mate=await h.loginAs('mate');
  await shareWith(h,id,'mate','view');
  // The mate joins the failing chat and mentions the owner there: its card gets the coral Needs you pill.
  assert.equal((await h.post(`/api/channels/${failing.channelId}/subscribe`,{subscriberType:'HUMAN',subscriberId:'mate'})).ok,true);
  const mentioned=await mate.page.evaluate(async channelId=>(await fetch('/api/messages',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({
    id:crypto.randomUUID(),channelId,text:'@demo-owner pick a hook',mentions:[{kind:'HUMAN',name:'demo-owner',start:0,end:11}],attachments:[]})})).status,failing.channelId);
  assert.equal(mentioned,201);

  await page.goto(`${base}/?view=canvas&canvas=${id}`);
  const ratios:Record<string,number>={};
  for(const theme of ['dark','light'] as const){
    await useTheme(page,theme);
    const quiet=cardAt(page,h.project.channelId);
    await quiet.getByText('quiet for 25 min',{exact:true}).waitFor();
    await cardAt(page,failing.channelId).getByText('ran into an error',{exact:true}).waitFor();
    await quiet.getByRole('link',{name:'synthetic-brief.txt',exact:true}).waitFor();
    await quiet.locator('.canvas-card-activity').waitFor();
    await cardAt(page,failing.channelId).locator('.canvas-card-need').getByText('mate: @demo-owner pick a hook',{exact:true}).waitFor();
    ratios[`owner ${theme}`]=await assertContrast(page,`owner, ${theme}`,['Synthetic chat project','quiet for 25 min','ran into an error','synthetic-brief.txt','Nudge Pip','mate: @demo-owner','Open']);

    await useTheme(mate.page,theme);
    await mate.page.goto(`${base}/?view=canvas&canvas=${id}`);
    await cardAt(mate.page,hidden).getByText('Private chat',{exact:true}).waitFor();
    ratios[`viewer ${theme}`]=await assertContrast(mate.page,`viewer, ${theme}`,['Private chat','Owner: demo-owner']);
  }
  console.log(`contrast minimums: ${JSON.stringify(ratios)}`);

  // In forced colours the card's focus ring (a box-shadow) is dropped; an outline must remain.
  await page.emulateMedia({forcedColors:'active'});
  await cardAt(page,h.project.channelId).locator('.canvas-card-open').focus();
  const ring=await cardAt(page,h.project.channelId).evaluate(el=>{const s=getComputedStyle(el);return {style:s.outlineStyle,width:s.outlineWidth};});
  assert.equal(ring.style,'solid',`the focused card keeps an outline in forced colours: ${JSON.stringify(ring)}`);
  assert.notEqual(ring.width,'0px');
},{canvas:true,viewport:{width:1440,height:900},colorScheme:'dark'});

// The scale fixture: 6 areas in 3 columns × 2 rows, each holding 25 chats in a 5 × 5 grid.
const COLUMNS=5,STEP={x:300,y:200},PAD=48,TOP=96,AREA={w:PAD+(COLUMNS-1)*STEP.x+280+PAD,h:TOP+4*STEP.y+160+PAD},GAP=400;
const MIN_FPS=30,PAN_MS=2000;
/** A scripted wheel pan on the surface for `ms`, measured by requestAnimationFrame timestamps in the page. */
async function panFps(page:Page,ms:number){
  await keepNames(page);
  return page.evaluate(async duration=>{
    const surface=document.querySelector<HTMLElement>('.canvas-surface')!;
    const r=surface.getBoundingClientRect();
    const times:number[]=[];
    await new Promise<void>(resolve=>{
      const step=(time:number)=>{
        times.push(time);
        surface.dispatchEvent(new WheelEvent('wheel',{deltaX:10,deltaY:3,clientX:r.left+r.width/2,clientY:r.top+r.height/2,bubbles:true,cancelable:true}));
        if(time-times[0]<duration)requestAnimationFrame(step);else resolve();
      };
      requestAnimationFrame(step);
    });
    return {frames:times.length,fps:(times.length-1)/((times.at(-1)!-times[0])/1000)};
  },ms);
}

await runChatTest('canvas devices: 150 cards and 30 agents stay culled, smooth and fit',async h=>{
  const {page,base}=h;
  const started=Date.now();
  const workspace=mkdtempSync(join(realpathSync(tmpdir()),'nest-canvas-scale-'));
  const agents=[agentName,...Array.from({length:29},(_,i)=>`Scale${String(i+1).padStart(2,'0')}`)];
  await inBatches(agents.slice(1),10,name=>call(h,'POST','/api/agents',{name,icon:'pip',visibility:'PUBLIC',modelId:'wrapped:none',workspacePath:join(workspace,name)}));
  const chats=await inBatches(Array.from({length:150},(_,i)=>i),10,i=>newProject(h,`Scale chat ${String(i+1).padStart(3,'0')}`,[agents[i%30],agents[(i+11)%30]]));
  const id=await newCanvas(h,'Scale launch');
  const areaNames=['Alpha','Bravo','Charlie','Delta','Echo','Foxtrot'].map(name=>`Zone ${name}`);
  const origin=(a:number)=>({x:(a%3)*(AREA.w+GAP),y:Math.floor(a/3)*(AREA.h+GAP)});
  for(const [a,title] of areaNames.entries())await newArea(h,id,{title,...origin(a),...AREA});
  const cards=chats.map((chat,i)=>{
    const a=Math.floor(i/25),n=i%25,o=origin(a);
    return {channelId:chat.channelId,x:o.x+PAD+(n%COLUMNS)*STEP.x,y:o.y+TOP+Math.floor(n/COLUMNS)*STEP.y};
  });
  await inBatches([cards.slice(0,100),cards.slice(100)],1,batch=>call(h,'POST',`/api/canvases/${id}/cards`,{cards:batch}));
  const board=await call<{cards:unknown[];areas:unknown[]}>(h,'GET',`/api/canvases/${id}/board`);
  assert.equal(board.cards.length,150);assert.equal(board.areas.length,6);
  console.log(`scale fixture seeded in ${Date.now()-started} ms`);

  // The Loose chats drawer starts closed and floats over the canvas, so the surface has the width of a mid-range laptop screen.
  await page.goto(`${base}/?view=canvas&canvas=${id}`);
  await page.locator('.canvas-area').first().waitFor();

  // Fit to one area (search for it, as a person would): culling keeps the rest unmounted.
  await page.getByRole('button',{name:'Search',exact:true}).click();
  const dialog=page.getByRole('dialog',{name:'Search the canvas',exact:true});
  await page.keyboard.type('Zone Echo');
  await dialog.getByRole('group',{name:'Areas',exact:true}).getByRole('option',{name:/Zone Echo/}).waitFor();
  await page.keyboard.press('Enter');
  await dialog.waitFor({state:'detached'});
  const echo=page.locator('[aria-label="Area Zone Echo"]');
  await page.waitForFunction(()=>{
    const area=document.querySelector('[aria-label="Area Zone Echo"]'),surface=document.querySelector('.canvas-surface');
    if(!area||!surface)return false;
    const a=area.getBoundingClientRect(),s=surface.getBoundingClientRect();
    return a.left>=s.left&&a.right<=s.right&&a.top>=s.top&&a.bottom<=s.bottom&&(a.width>=s.width*0.7||a.height>=s.height*0.7);
  });
  await page.waitForTimeout(500);
  const mounted=await page.locator('.canvas-card').count();
  console.log(`fit to one area at ${await zoomLabel(page).textContent()}: ${mounted} of 150 cards mounted`);
  assert.ok(mounted>=25,`the area's own 25 cards are mounted: ${mounted}`);
  assert.ok(mounted<60,`fewer than 60 cards mounted at fit-to-area: ${mounted}`);
  assert.ok(await echo.isVisible());

  // A scripted 2 s pan keeps at least 30 frames a second.
  const before=await page.locator('.canvas-world').getAttribute('style');
  const pan=await panFps(page,PAN_MS);
  console.log(`pan at fit-to-area: ${pan.fps.toFixed(1)} fps over ${pan.frames} frames`);
  assert.notEqual(await page.locator('.canvas-world').getAttribute('style'),before,'the pan moved the canvas');
  assert.ok(pan.fps>=MIN_FPS,`pan averages ${pan.fps.toFixed(1)} fps (at least ${MIN_FPS})`);

  // Fit shows every area at once.
  await page.getByRole('button',{name:'Fit',exact:true}).click();
  await page.waitForTimeout(300);
  const frame=(await page.locator('.canvas-surface').boundingBox())!;
  for(const title of areaNames){
    const b=await page.locator(`[aria-label="Area ${title}"]`).boundingBox();
    assert.ok(b,`${title} is mounted after Fit`);
    assert.ok(b.x>=frame.x-1&&b.y>=frame.y-1&&b.x+b.width<=frame.x+frame.width+1&&b.y+b.height<=frame.y+frame.height+1,`${title} inside the surface after Fit: ${JSON.stringify(b)} in ${JSON.stringify(frame)}`);
  }
  const atFit=await page.locator('.canvas-card').count();
  const wide=await panFps(page,PAN_MS);
  console.log(`Fit at ${await zoomLabel(page).textContent()}: ${atFit} cards mounted; pan ${wide.fps.toFixed(1)} fps over ${wide.frames} frames`);
  assert.ok(wide.fps>=MIN_FPS,`pan at Fit averages ${wide.fps.toFixed(1)} fps (at least ${MIN_FPS})`);
},{canvas:true,viewport:{width:1440,height:900}});

await runChatTest('canvas devices: a reload restores the view position and the open chat',async h=>{
  const {page,base}=h;
  const id=await newCanvas(h,'Reload launch');
  await call(h,'POST',`/api/canvases/${id}/cards`,{cards:[{channelId:h.project.channelId,x:300,y:200}]});
  await page.goto(`${base}/?view=canvas&canvas=${id}`);
  const card=cardAt(page,h.project.channelId);
  await card.waitFor();
  await page.getByRole('button',{name:'Zoom in',exact:true}).click();
  const surface=(await page.locator('.canvas-surface').boundingBox())!;
  await page.mouse.move(surface.x+surface.width/2,surface.y+surface.height/2);
  await page.mouse.wheel(-137,-61);
  const me=await call<{id:string}>(h,'GET','/api/auth/me');
  const key=`nest-canvas-view:${me.id}:${id}`;
  // The view is written shortly after it settles; wait for the panned one.
  await page.waitForFunction(storageKey=>{const v=JSON.parse(localStorage.getItem(storageKey)??'null');return v&&v.zoom>1&&v.x!==0;},key);
  await page.waitForTimeout(400);
  const zoom=await zoomLabel(page).textContent(),before=(await card.boundingBox())!;
  assert.notEqual(zoom,'100%');
  await page.reload();
  await card.waitFor();
  assert.equal(await zoomLabel(page).textContent(),zoom,'the zoom is restored');
  const back=(await card.boundingBox())!;
  assert.ok(Math.abs(back.x-before.x)<=2&&Math.abs(back.y-before.y)<=2,`the card is where it was: ${JSON.stringify(before)} -> ${JSON.stringify(back)}`);

  // Opening in place brings the card to 100% under its sheet; a reload restores the chat and that view.
  await card.locator('.canvas-card-title').click();
  const chat=page.locator('.canvas-chat');
  await chat.waitFor();
  await page.waitForFunction(storageKey=>JSON.parse(localStorage.getItem(storageKey)??'null')?.zoom===1,key);
  // Polled from Node until the card stops moving (the camera has settled), rather than a fixed sleep.
  const steady=async()=>{
    let last='';
    for(let i=0;i<80;i++){const now=JSON.stringify(await card.boundingBox());if(now===last)return JSON.parse(now) as {x:number;y:number};last=now;await new Promise(r=>setTimeout(r,60));}
    throw Error('the card did not settle');
  };
  const opened=await steady();
  // The saved view is the settled one on screen (saving trails the last move by a moment).
  await page.waitForFunction(storageKey=>{
    const v=JSON.parse(localStorage.getItem(storageKey)??'null'),m=/translate\(([-\d.]+)px, ([-\d.]+)px\)/.exec((document.querySelector('.canvas-world') as HTMLElement|null)?.style.transform??'');
    return Boolean(v&&m&&v.zoom===1&&Math.abs(v.x-Number(m[1]))<0.5&&Math.abs(v.y-Number(m[2]))<0.5);
  },key);
  await page.reload();
  await chat.waitFor();
  assert.equal(new URL(page.url()).searchParams.get('chat'),h.project.channelId,'the open chat is restored');
  assert.equal(await chat.getAttribute('data-mode'),'focus');
  await card.waitFor();
  const after=await steady();
  assert.equal(await zoomLabel(page).textContent(),'100%','the zoom is restored');
  assert.ok(Math.abs(after.x-opened.x)<=2&&Math.abs(after.y-opened.y)<=2,`the card is where it was: ${JSON.stringify(opened)} -> ${JSON.stringify(after)}`);
  const sheet=(await chat.boundingBox())!;
  assert.ok(Math.abs(sheet.x-after.x)<=24&&Math.abs(sheet.y-after.y)<=24,`the restored sheet is over its card: ${JSON.stringify(sheet)}`);
},{canvas:true,viewport:{width:1440,height:900}});
