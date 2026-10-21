import {chromium,type Route} from 'playwright';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {createRequire} from 'node:module';
import {createEngine} from './engine';
import {createOrgOpsClient} from '../../packages/orgops-client/src/index';
import {createApp} from '../../apps/api/src/app';

const dir=mkdtempSync(join(tmpdir(),'nest-room-status-'));
const screenshots=mkdtempSync(join(tmpdir(),'nest-room-status-screenshots-'));
const engine=createEngine({projectRoot:dir,dataDir:dir,dbPath:join(dir,'engine.sqlite'),adminUser:'demo-owner',adminPass:'password',runnerToken:'fixture-runner'});
const product=createApp({connections:null,orgops:createOrgOpsClient('http://engine',async(url,init)=>engine.app.fetch(new Request(url,init))),dbPath:join(dir,'product.sqlite')});
const req=createRequire(join(process.cwd(),'apps/user-ui/package.json'));
const server=spawn(process.execPath,[join(dirname(req.resolve('vite/package.json')),'bin/vite.js'),'--host','127.0.0.1','--port','5315','--strictPort'],{cwd:join(process.cwd(),'apps/user-ui'),stdio:'pipe'});
server.stderr.on('data',chunk=>process.stderr.write(chunk));
const base='http://127.0.0.1:5315';
let browser:Awaited<ReturnType<typeof chromium.launch>>|undefined;
try {
  await new Promise<void>((resolve,reject)=>{
    const timeout=setTimeout(()=>reject(Error('Vite timeout')),20000);
    server.on('error',reject);server.on('exit',code=>reject(Error(`Vite exited ${code}`)));
    server.stdout.on('data',chunk=>{if(chunk.toString().includes('5315')){clearTimeout(timeout);resolve();}});
  });
  const login=await product.app.request('/api/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:'demo-owner',password:'password'})});
  const cookie=login.headers.getSetCookie()[0].split(';')[0];
  const headers={cookie,'content-type':'application/json'};
  async function write(path:string,body:unknown,method='POST') {
    const response=await product.app.request(path,{method,headers,body:JSON.stringify(body)});
    assert(response.ok,await response.clone().text());return response.json();
  }
  for(const [name,state] of [['Puff','RUNNING'],['Moss','STOPPED'],['Pip','STARTING'],['Pom','CRASHED']]) {
    await write('/api/agents',{name,modelId:'fixture',workspacePath:join(dir,name),runtimeState:state});
  }
  const project=await write('/api/projects',{id:crypto.randomUUID(),name:'Launch room',description:'Synthetic room for status verification.'});
  const standalone=await write('/api/channels',{name:'Demo team room',visibility:'PRIVATE'});
  for(const channelId of [project.channelId,standalone.id])for(const name of ['Puff','Moss','Pip','Pom']) {
    await write(`/api/channels/${channelId}/subscribe`,{subscriberType:'AGENT',subscriberId:name});
  }
  browser=await chromium.launch();
  const context=await browser.newContext({viewport:{width:1440,height:1000}});
  await context.addCookies([{name:'nest_session',value:cookie.slice('nest_session='.length),url:base,httpOnly:true}]);
  let directoryUnavailable=false;
  await context.routeWebSocket('**/ws',socket=>socket.close());
  await context.route('**/api/**',async(route:Route)=>{
    const r=route.request(),url=new URL(r.url());
    if(url.pathname==='/api/agents'&&r.method()==='GET'&&directoryUnavailable){await route.fulfill({status:503,json:{error:'Synthetic status outage'}});return;}
    const response=await product.app.request(url.pathname+url.search,{method:r.method(),headers:r.headers(),...(r.postDataBuffer()?{body:r.postDataBuffer()!}:{})});
    const body=Buffer.from(await response.arrayBuffer());
    await route.fulfill({status:response.status,headers:Object.fromEntries(response.headers),body});
  });
  const page=await context.newPage();page.setDefaultTimeout(15000);
  const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
  await page.goto(`${base}/?view=projects&project=${project.id}`);
  const projectPanel=page.getByRole('complementary',{name:'Project details'});
  const row=(name:string)=>projectPanel.locator('.project-assignee').filter({hasText:name});
  for(const [name,state,label] of [['Puff','running','Running'],['Moss','stopped','Stopped'],['Pip','starting','Starting'],['Pom','error','Error']]) {
    await row(name).locator(`.agent-runtime-status[data-state="${state}"]`).getByText(label,{exact:true}).waitFor();
  }
  assert.equal(await row('demo-owner').locator('.agent-runtime-status').count(),0,'People do not inherit agent runtime status');
  await page.waitForFunction(()=>Array.from(document.querySelectorAll<HTMLImageElement>('.project-about img')).every(img=>img.complete&&img.naturalWidth>0));
  await page.screenshot({path:join(screenshots,'project-desktop.png'),fullPage:true});
  await write('/api/agents/Puff/stop',{});
  await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
  await row('Puff').getByText('Stopped',{exact:true}).waitFor();
  await write('/api/agents/Puff/start',{});
  await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
  await row('Puff').getByText('Starting',{exact:true}).waitFor();
  // Refresh the permission-filtered HTTP directory even without WebSocket traffic.
  await page.clock.install();
  await write('/api/agents/Puff',{runtimeState:'RUNNING'},'PATCH');
  await page.clock.runFor(10000);
  await row('Puff').getByText('Running',{exact:true}).waitFor();
  directoryUnavailable=true;
  await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
  await row('Puff').getByText('Status unknown',{exact:true}).waitFor();
  assert.equal(await projectPanel.locator('.agent-runtime-status[data-state="unknown"]').count(),4);
  directoryUnavailable=false;
  await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
  await row('Puff').getByText('Running',{exact:true}).waitFor();
  await page.clock.resume();
  await page.setViewportSize({width:390,height:844});await page.reload();
  await projectPanel.locator('summary').click();
  await row('Puff').getByText('Running',{exact:true}).waitFor();
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await page.screenshot({path:join(screenshots,'project-mobile.png'),fullPage:true});
  await page.setViewportSize({width:1440,height:1000});
  await page.goto(`${base}/?channel=${standalone.id}`);
  const participants=page.locator('.participants-card');
  await participants.locator('article').filter({hasText:'Puff'}).getByText('Running',{exact:true}).waitFor();
  await participants.locator('article').filter({hasText:'Moss'}).getByText('Stopped',{exact:true}).waitFor();
  await page.screenshot({path:join(screenshots,'standalone-desktop.png'),fullPage:true});
  await page.setViewportSize({width:390,height:844});
  await page.getByRole('button',{name:'Manage channel',exact:true}).click();
  await page.getByRole('button',{name:'Manage participants',exact:true}).click();
  const members=page.getByRole('dialog').filter({has:page.getByRole('heading',{name:'Manage participants',exact:true})});
  await members.locator('article').filter({hasText:'Puff'}).getByText('Running',{exact:true}).waitFor();
  await members.locator('article').filter({hasText:'Pom'}).getByText('Error',{exact:true}).waitFor();
  await page.screenshot({path:join(screenshots,'members-mobile.png'),fullPage:true});
  assert.deepEqual(errors,[]);
  console.log(`PASS: project and standalone status, mobile labels, real engine controls, periodic refresh without WebSockets, focus refresh, outage/unknown and recovery. Screenshots: ${screenshots}`);
} finally {await browser?.close();server.kill('SIGTERM');product.store.close();engine.db.close();rmSync(dir,{recursive:true,force:true});}
