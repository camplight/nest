import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { createRequire } from 'node:module';
import { createApp as createEngine } from '../../vendor/orgops/apps/api/src/app';
import { createOrgOpsClient } from '../../packages/orgops-client/src/index';
import { createApp } from '../../apps/api/src/app';

const dir=mkdtempSync(join(tmpdir(),'nest-project-browser-'));
const screenshots=mkdtempSync(join(tmpdir(),'nest-project-screenshots-'));
const previousRoot=process.env.ORGOPS_PROJECT_ROOT;process.env.ORGOPS_PROJECT_ROOT=dir;
const engine=createEngine({dbPath:join(dir,'engine.sqlite'),dataDir:dir,adminUser:'owner',adminPass:'test-password',runnerToken:'test-runner'});
if(previousRoot===undefined)delete process.env.ORGOPS_PROJECT_ROOT;else process.env.ORGOPS_PROJECT_ROOT=previousRoot;
const orgops=createOrgOpsClient('http://engine',(async(url,init)=>engine.app.fetch(new Request(url,init))) as typeof fetch);
const product=createApp({orgops,dbPath:join(dir,'product.sqlite')});
const uiRequire=createRequire(join(process.cwd(),'apps/user-ui/package.json'));
const viteCli=join(dirname(uiRequire.resolve('vite/package.json')),'bin/vite.js');
const server=spawn(process.execPath,[viteCli,'--host','127.0.0.1','--port','5298','--strictPort'],{cwd:join(process.cwd(),'apps/user-ui'),stdio:'pipe'});
server.stderr.on('data',chunk=>process.stderr.write(chunk));
try {
  await new Promise<void>((resolve,reject)=>{
    const timeout=setTimeout(()=>reject(new Error('UI readiness timeout')),20000);
    server.on('error',e=>{clearTimeout(timeout);reject(e);});
    server.on('exit',code=>{clearTimeout(timeout);reject(new Error(`UI exited: ${code}`));});
    server.stdout.on('data',chunk=>{if(chunk.toString().includes('5298')){clearTimeout(timeout);resolve();}});
  });
  const browser=await chromium.launch({headless:true});
  try {
    const page=await browser.newPage({viewport:{width:1440,height:1100}});page.setDefaultTimeout(15000);
    const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
    const login=await product.app.request('/api/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:'owner',password:'test-password'})});
    assert.equal(login.status,200);
    const cookie=login.headers.get('set-cookie')!.split(';')[0];
    const headers={cookie,'content-type':'application/json'};
    const channelResponse=await product.app.request('/api/channels',{method:'POST',headers,body:JSON.stringify({name:'Website launch',visibility:'PRIVATE'})});
    const channelId=(await channelResponse.json()).id;
    const created=await product.app.request('/api/agents',{method:'POST',headers,body:JSON.stringify({name:'Builder',modelId:'test-model',workspacePath:join(dir,'workspace')})});assert.equal(created.status,201);
    await page.context().addCookies([{name:'nest_session',value:cookie.slice('nest_session='.length),url:'http://127.0.0.1:5298',httpOnly:true}]);
    // Relay browser requests into the real product + engine HTTP handlers. No
    // mocked product state, mutations, permissions or event validation.
    await page.route('**/api/**',async route=>{
      const request=route.request();const url=new URL(request.url());
      const response=await product.app.request(url.pathname+url.search,{method:request.method(),headers:request.headers(),...(request.postDataBuffer()?{body:new Uint8Array(request.postDataBuffer()!)}:{})});
      await route.fulfill({status:response.status,headers:Object.fromEntries(response.headers),body:Buffer.from(await response.arrayBuffer())});
    });
    await page.routeWebSocket('**/ws',()=>{});
    const emit=async(text:string)=>{
      const r=await product.app.request('/api/events',{method:'POST',headers:{'content-type':'application/json','x-nest-runner-token':'test-runner'},body:JSON.stringify({type:'message.created',source:'agent:Builder',channelId,payload:{text}})});assert.equal(r.status,201);
    };
    await page.goto('http://127.0.0.1:5298/');await page.getByRole('heading',{name:'Dashboard',exact:true}).waitFor();
    const nav=page.getByRole('navigation',{name:'Main navigation'});
    await nav.getByRole('button',{name:'Projects',exact:true}).click();assert.equal(new URL(page.url()).searchParams.get('view'),'projects');
    await page.getByRole('button',{name:'New project +',exact:true}).click();
    await page.getByRole('textbox',{name:'Project name',exact:true}).fill('Website launch');
    await page.getByRole('textbox',{name:'Project brief',exact:true}).fill('Ship an accessible landing page.');
    await page.getByRole('combobox',{name:'Conversation',exact:true}).selectOption(channelId);
    await page.getByRole('button',{name:'Create project',exact:true}).click();
    await page.getByRole('heading',{name:'Website launch',exact:true}).waitFor();
    assert(new URL(page.url()).searchParams.get('project'));
    await page.getByRole('button',{name:'New task +',exact:true}).click();
    await page.getByRole('textbox',{name:'Task title',exact:true}).fill('Build the landing page');
    await page.getByRole('textbox',{name:'Brief',exact:true}).fill('Implement the launch page with keyboard navigation.');
    await page.getByRole('textbox',{name:'Acceptance criteria',exact:true}).fill('Visible keyboard focus. Tests pass.');
    await page.getByRole('combobox',{name:'Assign agent',exact:true}).selectOption('Builder');
    await page.getByRole('button',{name:'Create task',exact:true}).click();
    await page.getByRole('button',{name:'Send to agent',exact:true}).waitFor();
    const deepLink=page.url();assert(new URL(deepLink).searchParams.get('task'));
    await page.reload();await page.getByRole('button',{name:'Send to agent',exact:true}).click();
    await page.getByRole('button',{name:'Load agent responses',exact:true}).waitFor();
    await emit('## First deliverable\nThe landing page is ready. [Review the code](https://example.com/pr/1).');
    await page.getByRole('button',{name:'Load agent responses',exact:true}).click();
    await page.getByRole('button',{name:'Submit this response for review',exact:true}).click();
    await page.getByRole('button',{name:'Approve deliverable',exact:true}).waitFor();
    assert(await page.getByRole('button',{name:'Request changes',exact:true}).isDisabled());
    await page.getByRole('textbox',{name:'Review feedback',exact:true}).fill('Add visible keyboard focus styles.');
    await page.getByRole('button',{name:'Request changes',exact:true}).click();
    await page.getByRole('button',{name:'Send revision to agent',exact:true}).click();
    await page.getByRole('button',{name:'Load agent responses',exact:true}).waitFor();
    await emit('## Revised deliverable\nKeyboard focus styles are included. All tests pass. [Review the code](https://example.com/pr/2).');
    await page.getByRole('button',{name:'Load agent responses',exact:true}).click();
    await page.getByRole('button',{name:'Submit this response for review',exact:true}).waitFor();
    assert.equal(await page.getByRole('button',{name:'Submit this response for review',exact:true}).count(),1);
    await page.getByRole('button',{name:'Submit this response for review',exact:true}).click();
    await page.getByRole('button',{name:'Approve deliverable',exact:true}).click();
    await page.getByText('Approved by a human. This task is complete.',{exact:true}).waitFor();
    await page.reload();await page.getByText('Approved by a human. This task is complete.',{exact:true}).waitFor();
    assert.equal(await nav.getByRole('button',{name:'Projects',exact:true}).getAttribute('aria-current'),'page');
    await page.screenshot({path:join(screenshots,'project-approved.png'),fullPage:true});
    await page.getByRole('button',{name:'All projects',exact:true}).click();await page.getByRole('heading',{name:'Projects',exact:true}).waitFor();
    await page.goBack();await page.getByText('Approved by a human. This task is complete.',{exact:true}).waitFor();
    await page.setViewportSize({width:390,height:844});await page.getByRole('button',{name:'New task +',exact:true}).waitFor({state:'visible'});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
    await page.screenshot({path:join(screenshots,'project-mobile.png'),fullPage:true});
    await page.getByRole('button',{name:'Menu',exact:true}).click();assert.equal(await nav.getByRole('button',{name:'Projects',exact:true}).getAttribute('aria-current'),'page');
    assert.deepEqual(errors,[]);
    const id=new URL(deepLink).searchParams.get('project')!;
    const detail=product.store.projects.detail(product.store.projects.project(id)!);
    assert.equal(detail.tasks[0].status,'done');assert.equal(detail.deliverables.length,2);assert.equal(detail.reviews.length,2);
    console.log(`PASS: real API project creation, task assignment, targeted dispatch, revision, deliverable approval, persistence, history and mobile. Screenshots: ${screenshots}`);
  } finally {await browser.close();}
} finally {server.kill('SIGTERM');product.store.close();engine.db.close();rmSync(dir,{recursive:true,force:true});}
