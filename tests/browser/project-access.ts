import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync,rmSync} from 'node:fs';
import {createRequire} from 'node:module';
import {tmpdir} from 'node:os';
import {dirname,join} from 'node:path';
import {chromium,type BrowserContext,type Page,type Route} from 'playwright';
import {createApp} from '../../apps/api/src/app';
import {createOrgOpsClient} from '../../packages/orgops-client/src/index';
import {createEngine} from './engine';

const dir=mkdtempSync(join(tmpdir(),'nest-project-access-browser-'));
const screenshots=mkdtempSync(join(tmpdir(),'nest-project-access-screenshots-'));
const previousRoot=process.env.ORGOPS_PROJECT_ROOT;process.env.ORGOPS_PROJECT_ROOT=dir;
const engine=createEngine({dbPath:join(dir,'engine.sqlite'),dataDir:dir,adminUser:'owner',adminPass:'test-password',runnerToken:'fixture-runner'});
if(previousRoot===undefined)delete process.env.ORGOPS_PROJECT_ROOT;else process.env.ORGOPS_PROJECT_ROOT=previousRoot;
const orgops=createOrgOpsClient('http://engine',(async(url,init)=>engine.app.fetch(new Request(url,init))) as typeof fetch);
const product=createApp({orgops,dbPath:join(dir,'product.sqlite')});
const uiRequire=createRequire(join(process.cwd(),'apps/user-ui/package.json'));
const viteCli=join(dirname(uiRequire.resolve('vite/package.json')),'bin/vite.js');
const server=spawn(process.execPath,[viteCli,'--host','127.0.0.1','--port','5304','--strictPort'],{cwd:join(process.cwd(),'apps/user-ui'),stdio:'pipe'});
server.stderr.on('data',chunk=>process.stderr.write(chunk));

async function waitForUi(){
  await new Promise<void>((resolve,reject)=>{
    const timeout=setTimeout(()=>reject(new Error('UI readiness timeout')),20_000);
    server.on('error',error=>{clearTimeout(timeout);reject(error);});
    server.on('exit',code=>{clearTimeout(timeout);reject(new Error(`UI exited: ${code}`));});
    server.stdout.on('data',chunk=>{if(chunk.toString().includes('5304')){clearTimeout(timeout);resolve();}});
  });
}

async function login(username:string){
  const response=await product.app.request('/api/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username,password:'test-password'})});
  assert.equal(response.status,200,await response.text());
  return response.headers.get('set-cookie')!.split(';')[0];
}

async function contextFor(browser:import('playwright').Browser,cookie:string):Promise<BrowserContext>{
  const context=await browser.newContext({viewport:{width:1280,height:900}});
  await context.addCookies([{name:'nest_session',value:cookie.slice('nest_session='.length),url:'http://127.0.0.1:5304',httpOnly:true}]);
  return context;
}

async function openNotifications(page:Page){
  await page.getByRole('button',{name:'Notifications',exact:true}).click();
  return page.getByRole('dialog',{name:'Notifications',exact:true});
}

try{
  await waitForUi();
  const browser=await chromium.launch({headless:true});
  try{
    const ownerCookie=await login('owner');
    const ownerHeaders={cookie:ownerCookie,'content-type':'application/json'};
    const invited=await product.app.request('/api/humans/invite',{method:'POST',headers:ownerHeaders,body:JSON.stringify({username:'requester@example.com',tempPassword:'test-password'})});
    assert.equal(invited.status,201,await invited.text());
    engine.db.prepare('UPDATE humans SET must_change_password=0 WHERE username=?').run('requester@example.com');
    const requesterCookie=await login('requester@example.com');
    const projectId=crypto.randomUUID();
    const created=await product.app.request('/api/projects',{method:'POST',headers:ownerHeaders,body:JSON.stringify({id:projectId,name:'Project Nightingale',description:'Private launch details',members:[],collaboration:'private'})});
    assert.equal(created.status,201,await created.text());

    let loseFirstRequestResponse=true;
    const submittedRequestIds:string[]=[];
    const relay=async(route:Route)=>{
      const request=route.request(),url=new URL(request.url());
      const response=await product.app.request(url.pathname+url.search,{method:request.method(),headers:request.headers(),...(request.postDataBuffer()?{body:new Uint8Array(request.postDataBuffer()!)}:{})});
      if(url.pathname==='/api/mentions'){
        await route.fulfill({status:502,json:{error:'Synthetic mention outage'}});return;
      }
      if(url.pathname===`/api/projects/${projectId}/access-requests`&&request.method()==='POST'){
        submittedRequestIds.push((request.postDataJSON() as {id:string}).id);
        if(loseFirstRequestResponse){loseFirstRequestResponse=false;await route.fulfill({status:502,json:{error:'Synthetic lost response'}});return;}
      }
      await route.fulfill({status:response.status,headers:Object.fromEntries(response.headers),body:Buffer.from(await response.arrayBuffer())});
    };

    const ownerContext=await contextFor(browser,ownerCookie),requesterContext=await contextFor(browser,requesterCookie);
    try{
      const errors:string[]=[];
      const ownerPage=await ownerContext.newPage(),requesterPage=await requesterContext.newPage();
      for(const page of [ownerPage,requesterPage]){
        page.setDefaultTimeout(15_000);page.on('pageerror',error=>errors.push(error.message));
        await page.route('**/api/**',relay);await page.routeWebSocket('**/ws',socket=>socket.close());
      }

      await ownerPage.goto('http://127.0.0.1:5304/?view=dashboard');
      await ownerPage.getByRole('heading',{name:'Dashboard',exact:true}).waitFor();
      await requesterPage.goto(`http://127.0.0.1:5304/?view=projects&project=${projectId}&tab=chat`);
      await requesterPage.getByRole('heading',{name:'This project is private',exact:true}).waitFor();
      assert.equal(await requesterPage.getByText('Project Nightingale',{exact:true}).count(),0,'The access gate does not disclose project metadata');
      await requesterPage.screenshot({path:join(screenshots,'request-gate-desktop.png'),fullPage:true});
      await requesterPage.setViewportSize({width:390,height:844});
      assert(await requesterPage.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
      await requesterPage.screenshot({path:join(screenshots,'request-gate-mobile.png'),fullPage:true});
      await requesterPage.setViewportSize({width:1280,height:900});
      await requesterPage.getByRole('button',{name:'Request access',exact:true}).click();
      const retryAlert=requesterPage.getByRole('alert').filter({hasText:'Synthetic lost response'});
      await retryAlert.waitFor();await retryAlert.getByRole('button',{name:'Retry',exact:true}).click();
      await requesterPage.getByRole('heading',{name:'Access requested',exact:true}).waitFor();
      assert.equal(submittedRequestIds.length,2);assert.equal(submittedRequestIds[0],submittedRequestIds[1],'An uncertain submission retries the same request UUID');
      assert.equal((product.store.db.prepare('SELECT COUNT(*) AS count FROM product_project_access_requests WHERE project_id=?').get(projectId) as {count:number}).count,1,'Retry does not duplicate the durable request');

      await ownerPage.reload();
      const firstNotifications=await openNotifications(ownerPage);
      await firstNotifications.getByRole('alert').filter({hasText:'Could not load mentions'}).waitFor();
      await firstNotifications.getByText('requester@example.com requested access to Project Nightingale',{exact:true}).waitFor();
      await firstNotifications.getByRole('button',{name:'Deny requester@example.com for Project Nightingale',exact:true}).click();
      await firstNotifications.getByText('No pending project access requests.',{exact:true}).waitFor();

      await requesterPage.reload();
      await requesterPage.getByRole('heading',{name:'Your request was not approved',exact:true}).waitFor();
      assert.equal(await requesterPage.getByText('Project Nightingale',{exact:true}).count(),0,'A denied requester still sees no project metadata');
      await requesterPage.getByRole('button',{name:'Request again',exact:true}).click();
      await requesterPage.getByRole('heading',{name:'Access requested',exact:true}).waitFor();

      await ownerPage.reload();
      const secondNotifications=await openNotifications(ownerPage);
      await secondNotifications.getByRole('button',{name:'Approve requester@example.com for Project Nightingale',exact:true}).click();
      await secondNotifications.getByText('No pending project access requests.',{exact:true}).waitFor();
      await requesterPage.getByRole('heading',{name:'Project Nightingale',level:1,exact:true}).waitFor({timeout:15_000});
      const composer=requesterPage.getByRole('textbox',{name:'Message',exact:true});
      await composer.waitFor();
      assert.equal(product.store.projects.project(projectId)?.collaboration,'team');
      await composer.fill('Requester can now use project chat');
      await requesterPage.getByRole('button',{name:'Send',exact:true}).click();
      await requesterPage.getByText('Requester can now use project chat',{exact:true}).waitFor();
      await requesterPage.locator('input[type=file]').setInputFiles({name:'access-brief.txt',mimeType:'text/plain',buffer:Buffer.from('Confirmed project file access')});
      await requesterPage.getByRole('button',{name:'Send',exact:true}).click();
      await requesterPage.getByRole('link',{name:'access-brief.txt',exact:true}).waitFor();
      const projectSections=requesterPage.getByRole('navigation',{name:'Project sections'});
      await projectSections.getByRole('button',{name:'Files',exact:true}).click();
      await requesterPage.getByRole('heading',{name:'Files shared in chat',exact:true}).waitFor();
      await requesterPage.getByRole('link',{name:'access-brief.txt ↗',exact:true}).waitFor();
      await requesterPage.screenshot({path:join(screenshots,'approved-project-desktop.png'),fullPage:true});
      await requesterPage.setViewportSize({width:390,height:844});
      assert(await requesterPage.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
      await requesterPage.screenshot({path:join(screenshots,'approved-project-mobile.png'),fullPage:true});
      await requesterPage.setViewportSize({width:1280,height:900});
      await projectSections.getByRole('button',{name:'Chat',exact:true}).click();
      await requesterPage.getByText('Requester can now use project chat',{exact:true}).waitFor();

      await ownerPage.goto(`http://127.0.0.1:5304/?view=projects&project=${projectId}&tab=chat`);
      await ownerPage.getByRole('heading',{name:'Project Nightingale',level:1,exact:true}).waitFor();
      ownerPage.once('dialog',async dialog=>{
        assert.match(dialog.message(),/immediately lose project chat and file access/i);
        await dialog.accept();
      });
      await ownerPage.getByRole('button',{name:'Remove access for requester@example.com',exact:true}).click();
      await ownerPage.getByRole('button',{name:'Remove access for requester@example.com',exact:true}).waitFor({state:'hidden'});
      await requesterPage.reload();
      await requesterPage.getByRole('heading',{name:'This project is private',exact:true}).waitFor();
      assert.equal(await requesterPage.getByText('Project Nightingale',{exact:true}).count(),0,'Revocation returns to the generic metadata-free gate');
      await requesterPage.getByRole('button',{name:'Request access',exact:true}).click();
      await requesterPage.getByRole('heading',{name:'Access requested',exact:true}).waitFor();
      assert.equal((product.store.db.prepare("SELECT COUNT(*) AS count FROM product_project_access_requests WHERE project_id=? AND status IN ('pending','approving')").get(projectId) as {count:number}).count,1,'A revoked member can create one new active request');
      assert.deepEqual(errors,[]);
      console.log(`PASS: project access request retry/idempotency, private denial, owner notification isolation, approval, chat/files, live unlock, revocation and re-request. Screenshots: ${screenshots}`);
    }finally{await ownerContext.close();await requesterContext.close();}
  }finally{await browser.close();}
}finally{
  server.kill('SIGTERM');product.store.close();engine.db.close();rmSync(dir,{recursive:true,force:true});rmSync(screenshots,{recursive:true,force:true});
}
