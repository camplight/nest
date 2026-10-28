import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { createRequire } from 'node:module';
const uiRequire = createRequire(join(process.cwd(), 'apps/user-ui/package.json'));
const viteCli = join(dirname(uiRequire.resolve('vite/package.json')), 'bin/vite.js');
const screenshotDir = mkdtempSync(join(tmpdir(), 'nest-agents-'));
const base = 'http://127.0.0.1:5297';
const server = spawn(process.execPath, [viteCli, '--host', '127.0.0.1', '--port', '5297', '--strictPort'], { cwd: join(process.cwd(), 'apps/user-ui'), stdio: 'pipe' });
server.stderr.on('data', chunk => process.stderr.write(chunk));
try {
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('UI server readiness timeout')), 20000);
    server.on('error', error => { clearTimeout(timeout); reject(error); });
    server.on('exit', code => { clearTimeout(timeout); reject(new Error(`UI server exited: ${code}`)); });
    server.stdout.on('data', chunk => { if (chunk.toString().includes('5297')) { clearTimeout(timeout); resolve(); } });
  });
const browser = await chromium.launch({headless:true});
try {
const page = await browser.newPage({viewport:{width:1440,height:1100}});
page.setDefaultTimeout(10000);
const errors=[];page.on('pageerror',e=>errors.push(e.message));
const agents=[{name:'NestSystem',description:'Your partner in building Nest.',runtimeState:'RUNNING',mode:'WRAPPED',workspacePath:'/workspace/nest',visibility:'PUBLIC'}, {name:'Research & Design',description:'Research the next release.',runtimeState:'STOPPED',mode:'CLASSIC',modelId:'test-model',systemInstructions:'Research carefully.',enabledSkills:['research'],visibility:'PRIVATE',ownerHumanId:'me'}, {name:'PrivateAgent',visibility:'PRIVATE',ownerHumanId:'other',mode:'CLASSIC'}];
let releaseNotifications;
const notificationGate=new Promise(resolve=>{releaseNotifications=resolve;});
let fullHealthRequests=0;
let connectionRequests=0;
let failConnections=true;
let releaseConnections;
const connectionGate=new Promise(resolve=>{releaseConnections=resolve;});
let malformedDirectory=false;
let malformedCatalog=false;let failModels=false;let failSave=false;const writes=[];
await page.route('**/api/**',async route=>{
 const path=new URL(route.request().url()).pathname; let data=[];
 if(path==='/api/branding')data={displayName:'Camplight',logoUrl:'/brand/camplight-logo-white.svg',primaryColor:'#350956',accentColor:'#ff7557',backgroundColor:'#f8f4ff'};
 else if(path==='/api/auth/me')data={id:'me',username:'admin'};
 else if(path==='/api/agent-models'){
 if(failModels)return route.fulfill({status:503,json:{error:'Unavailable'}});
 data={models:[{id:'kimi',name:'moonshotai/kimi-k3',provider:'openrouter',reference:'openrouter:moonshotai/kimi-k3'},{id:'gemini',name:'google/gemini-2.5-flash',provider:'openrouter',reference:'openrouter:google/gemini-2.5-flash'}],defaultModel:'openrouter:moonshotai/kimi-k3'};
 }
 else if(path==='/api/openrouter-models'&&malformedCatalog)data=[];
 else if(path==='/api/openrouter-models')data={models:[{id:'moonshotai/kimi-k3',name:'Kimi fixture',description:'Synthetic test catalog. Text tools.',tools:true,vision:false,reasoning:true,context:128000,inputPrice:1,outputPrice:2},{id:'google/gemini-2.5-flash',name:'Gemini fixture',description:'Synthetic test catalog. Images and tools.',tools:true,vision:true,reasoning:true,context:1000000,inputPrice:0.3,outputPrice:2.5}],fetchedAt:1793200000000,stale:false};
 else if(path.endsWith('/model-check')){const model=route.request().postDataJSON().model;return route.fulfill(model==='google/gemini-2.5-flash'?{json:{reference:'openrouter:'+model,latencyMs:250,tools:true}}:{status:422,json:{error:'Synthetic check failed; saved model unchanged'}});}
 else if(path==='/api/events'){await notificationGate;data=[];}
 else if(path==='/api/mentions')data={items:[]};
 else if(path==='/api/projects/dashboard')data={projects:[],tasks:{total:0,finished:0,needsReview:0,changesRequested:0},reviews:[],changes:[]};
 else if(path==='/api/community/skills')data={skills:[],total:0,offset:0,limit:8};
 else if(path==='/api/onboarding/summary')data={setup:null};
 else if(path==='/api/onboarding'){fullHealthRequests++;return route.fulfill({status:503,json:{error:'Health is unavailable'}});}
 else if(path==='/api/integrations/config'){
 connectionRequests++;await connectionGate;
 return route.fulfill(failConnections?{status:503,json:{error:'Unavailable'}}:{json:{configured:false}});
 }
 else if(path==='/api/collaboration/agents')data=malformedDirectory?[]:{items:[]};
 else if(path==='/api/agents')data=agents;
 else if(path.startsWith('/api/agents/')){
 const name=decodeURIComponent(path.slice('/api/agents/'.length));const agent=agents.find(a=>a.name===name);
 if(!agent)return route.fulfill({status:404,json:{error:'Not found'}});
 if(route.request().method()==='PATCH'){
 if(failSave)return route.fulfill({status:403,json:{error:'Forbidden'}});
 const changes=route.request().postDataJSON();writes.push(changes);Object.assign(agent,changes);data={ok:true};
 }else data=agent;
 } else if(path==='/api/humans')data=[{username:'admin'}];
 else if(path==='/api/channels')data=[{id:'chat',name:'general',visibility:'PUBLIC',participants:[]}];
 await route.fulfill({json:data});
});
await page.routeWebSocket('**/ws',()=>{});
await page.goto(`${base}/`);
await page.getByRole('heading',{name:'Dashboard',exact:true}).waitFor();
await page.getByRole('navigation',{name:'Main navigation'}).getByRole('button',{name:'Agents',exact:true}).click();
await page.getByRole('button',{name:'Manage NestSystem'}).waitFor();
assert.equal(await page.getByText('Loading agents…',{exact:true}).count(),0);
releaseNotifications();
assert.equal(new URL(page.url()).searchParams.get('view'),'agents');
assert.equal(await page.getByRole('navigation').getByRole('button',{name:'Agents',exact:true}).getAttribute('aria-current'),'page');
assert.equal(await page.getByText('PrivateAgent',{exact:true}).count(),0);
await page.waitForFunction(()=>Array.from(document.querySelectorAll('.agent-portrait img')).every(i=>i.complete&&i.naturalWidth===305));
await page.screenshot({path:join(screenshotDir, 'nest-agents-directory.png'),fullPage:true});
await page.getByRole('button',{name:'Manage Research & Design',exact:true}).focus();
await page.keyboard.press('Enter');
await page.getByLabel('About this agent',{exact:true}).waitFor();
assert.equal(new URL(page.url()).searchParams.get('agent'),'Research & Design');
await page.reload();await page.getByLabel('About this agent',{exact:true}).waitFor();
assert.equal(fullHealthRequests,0);
assert.equal(await page.getByLabel('Additional instructions').isVisible(),false);
assert.equal(await page.getByText('Runtime details',{exact:true}).isVisible(),false);
// A stalled optional capability must not block editing or page navigation.
await page.getByRole('status').filter({hasText:'Loading connection settings'}).waitFor();
await page.getByLabel('About this agent',{exact:true}).fill('Editable while connections load');
releaseConnections();await page.getByRole('button',{name:'Retry connections'}).waitFor();
assert.equal(await page.getByLabel('About this agent',{exact:true}).inputValue(),'Editable while connections load');
failConnections=false;await page.getByRole('button',{name:'Retry connections'}).click();
await page.getByRole('heading',{name:'App connections are being prepared'}).waitFor();
await page.locator('.agent-advanced > summary').focus();await page.keyboard.press('Enter');
await page.getByLabel('Additional instructions',{exact:true}).waitFor();
await page.getByLabel('Language model',{exact:true}).selectOption('openrouter:moonshotai/kimi-k3');
await page.getByLabel('About this agent',{exact:true}).fill('Updated research description');
await page.getByLabel('Additional instructions',{exact:true}).fill('Deliver sources and evidence.');
await page.getByRole('button',{name:'Save settings'}).click();await page.getByText('Settings saved.',{exact:true}).waitFor();
assert.deepEqual(writes.at(-1),{description:'Updated research description',systemInstructions:'Deliver sources and evidence.',modelId:'openrouter:moonshotai/kimi-k3'});
await page.reload();assert.equal(await page.getByLabel('About this agent',{exact:true}).inputValue(),'Updated research description');
assert.equal(await page.getByLabel('Language model').inputValue(),'openrouter:moonshotai/kimi-k3');
failSave=true;await page.getByLabel('About this agent',{exact:true}).fill('Retain on error');await page.getByRole('button',{name:'Save settings'}).click();await page.getByRole('alert').filter({hasText:'Forbidden'}).waitFor();assert.equal(await page.getByLabel('About this agent',{exact:true}).inputValue(),'Retain on error');
await page.getByLabel('About this agent',{exact:true}).fill('Updated research description');failSave=false;
await page.reload();await page.getByLabel('Language model').waitFor();
await page.getByRole('button',{name:/Gemini fixture/}).click();
await page.getByRole('button',{name:'Connect',exact:true}).click();
await page.getByRole('status').filter({hasText:'Tool-call check passed'}).waitFor();
assert.equal(await page.getByLabel('Language model').inputValue(),'openrouter:google/gemini-2.5-flash');
await page.getByLabel('Exact OpenRouter model ID').fill('vendor/missing');
await page.getByRole('button',{name:'Connect',exact:true}).click();
await page.getByRole('status').filter({hasText:'Synthetic check failed'}).waitFor();
assert.equal(await page.getByLabel('Language model').inputValue(),'openrouter:google/gemini-2.5-flash');
await page.getByLabel('Image input',{exact:true}).check();
assert.equal(await page.getByRole('button',{name:/Kimi fixture/}).count(),0);
await page.getByLabel('Image input',{exact:true}).uncheck();
await page.getByRole('button',{name:/Gemini fixture/}).click();
await page.getByLabel('Search OpenRouter models').fill('nothing matches');
await page.getByText('No matching tool-capable models.',{exact:false}).waitFor();
await page.getByLabel('Search OpenRouter models').fill('');
await page.screenshot({path:join(screenshotDir, 'nest-agent-details.png'),fullPage:true});
if(process.env.CI)console.log('MODEL_PICKER_DESKTOP_JPEG:'+ (await page.locator('.model-picker').screenshot({type:'jpeg',quality:65})).toString('base64'));

await page.setViewportSize({width:390,height:844});await page.screenshot({path:join(screenshotDir,'nest-agent-model-mobile.png'),fullPage:true});
assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
await page.getByRole('button',{name:'Connect',exact:true}).click();await page.getByRole('status').filter({hasText:'Tool-call check passed'}).waitFor();
if(process.env.CI){await page.setViewportSize({width:390,height:1700});console.log('MODEL_PICKER_MOBILE_JPEG:'+(await page.locator('.model-picker').screenshot({type:'jpeg',quality:65})).toString('base64'));}
await page.setViewportSize({width:1440,height:1100});
malformedCatalog=true;await page.reload();await page.getByRole('button',{name:'Retry catalog'}).waitFor();
assert(await page.getByLabel('About this agent',{exact:true}).isEnabled());
malformedCatalog=false;await page.getByRole('button',{name:'Retry catalog'}).click();await page.getByRole('button',{name:/Gemini fixture/}).waitFor();
failModels=true;await page.reload();await page.getByRole('button',{name:'Retry models'}).waitFor();assert(await page.getByLabel('Language model').isDisabled());
failModels=false;await page.getByRole('button',{name:'Retry models'}).click();await page.getByLabel('Language model').selectOption('openrouter:moonshotai/kimi-k3');
await page.getByRole('button',{name:'All agents'}).click();await page.getByRole('button',{name:'Manage NestSystem'}).click();
await page.locator('.agent-advanced > summary').click();await page.getByText('This wrapped agent manages',{exact:false}).waitFor();assert.equal(await page.getByLabel('Additional instructions').count(),0);
await page.getByLabel('About this agent',{exact:true}).fill('Wrapped description');
await page.getByRole('button',{name:'Save settings'}).click();await page.getByText('Settings saved.',{exact:true}).waitFor();
assert.deepEqual(writes.at(-1),{description:'Wrapped description'});
await page.goBack();await page.getByRole('heading',{name:'Agents',exact:true}).waitFor();
await page.goForward();await page.getByRole('heading',{name:'Agent details'}).waitFor();
await page.goto(`${base}/?view=agents&agent=PrivateAgent`);await page.getByLabel('About this agent',{exact:true}).waitFor();assert(await page.getByLabel('About this agent',{exact:true}).isDisabled());assert(await page.getByRole('button',{name:'Save settings'}).isDisabled());
await page.goto(`${base}/?view=agents&agent=missing`);await page.getByRole('alert').filter({hasText:'Not found'}).waitFor();
await page.goto(`${base}/?channel=chat`);await page.getByRole('navigation').getByRole('button',{name:'Agents',exact:true}).click();assert(!new URL(page.url()).searchParams.has('channel'));
await page.getByRole('navigation').getByRole('button',{name:'Dashboard',exact:true}).click();await page.getByRole('button',{name:'Account',exact:true}).click();await page.getByRole('menuitem',{name:'Your agents',exact:true}).click();await page.getByRole('button',{name:'Manage NestSystem',exact:true}).click();await page.getByRole('heading',{name:'Agent details'}).waitFor();
await page.setViewportSize({width:390,height:844});await page.screenshot({path:join(screenshotDir, 'nest-agent-mobile.png'),fullPage:true});
assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
await page.getByRole('button',{name:'Menu',exact:true}).click();assert.equal(await page.getByRole('navigation').getByRole('button',{name:'Agents',exact:true}).getAttribute('aria-current'),'page');
malformedDirectory=true;await page.goto(`${base}/?view=agents`);await page.getByRole('alert').filter({hasText:'Shared agents are unavailable'}).waitFor();await page.getByRole('button',{name:'Manage NestSystem',exact:true}).waitFor();
assert.equal(fullHealthRequests,0);assert(connectionRequests>0);assert.deepEqual(errors,[]);console.log('PASS: directory, selected navigation, encoded direct links, reload, history, settings persistence, failed saves, private read-only, wrapped settings, missing agents, chat links, dashboard links, mobile and avatar assets.');
console.log(`Screenshots: ${screenshotDir}`);
} finally { await browser.close(); }
} finally { server.kill('SIGTERM'); }

// Keep inline composer completion in the existing browser CI entry point.
await import('./mentions.mjs');
await import('./targeted-mentions.ts');
