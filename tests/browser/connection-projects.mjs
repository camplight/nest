import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { createRequire } from 'node:module';
const req=createRequire(join(process.cwd(),'apps/user-ui/package.json'));
const base='http://127.0.0.1:5298';
const server=spawn(process.execPath,[join(dirname(req.resolve('vite/package.json')),'bin/vite.js'),'--host','127.0.0.1','--port','5298','--strictPort'],{cwd:join(process.cwd(),'apps/user-ui'),stdio:'pipe'});
const screenshots=join(process.cwd(),'docs/images/validation/project-connections');
mkdirSync(screenshots,{recursive:true});
try {
 await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Vite readiness timeout')),20000);server.once('error',reject);server.stdout.on('data',b=>{if(b.toString().includes('5298')){clearTimeout(timer);resolve();}});server.stderr.on('data',b=>process.stderr.write(b));});
 const browser=await chromium.launch({headless:true});
 try {
 const page=await browser.newPage({viewport:{width:1440,height:1100}});
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 let approved=false, stale=false;
 const project={projectId:'demo-project',name:'Demo launch project',participants:[{subscriberType:'HUMAN',subscriberId:'demo-owner'},{subscriberType:'HUMAN',subscriberId:'demo-colleague'},{subscriberType:'AGENT',subscriberId:'DemoAssistant'}],audienceHash:'a'.repeat(64)};
 await page.route('**/api/**',async route=>{
  const path=new URL(route.request().url()).pathname, method=route.request().method();let data=[];
  if(path==='/api/auth/me')data={id:'demo-owner-id',username:'demo-owner'};
  else if(path==='/api/branding')data={displayName:'Nest',logoUrl:'/brand/camplight-logo-white.svg',primaryColor:'#350956',accentColor:'#ff7557',backgroundColor:'#f8f4ff'};
  else if(path==='/api/agents'||path==='/api/agents/DemoAssistant'){const agent={name:'DemoAssistant',description:'Demo fixture for project connection approval.',runtimeState:'RUNNING',mode:'CLASSIC',modelId:'demo',visibility:'PRIVATE',ownerHumanId:'demo-owner-id',enabledSkills:[]};data=path==='/api/agents'?[agent]:agent;}
  else if(path==='/api/agent-models')data={models:[],defaultModel:'demo'};
  else if(path==='/api/onboarding/summary')data={setup:null};
  else if(path==='/api/mentions')data={items:[]};
  else if(path==='/api/integrations/config')data={configured:true,skillAvailable:true};
  else if(path.endsWith('/skill'))data={enabled:true,expiresAt:1900000000000,grantedToolCount:2,preloadConfigured:true};
  else if(path.endsWith('/projects/demo-project')){
   if(method==='PUT'){assert.deepEqual(route.request().postDataJSON(),{audienceHash:'a'.repeat(64),acknowledgeSharedAccess:true});if(stale)return route.fulfill({status:409,json:{error:'Audience changed'}});approved=true;}else {assert.equal(method,'DELETE');approved=false;}
   data={ok:true};
  }
  else if(path==='/api/integrations/agents/DemoAssistant/projects')data={projects:[{...project,approved}]};
  else if(path==='/api/integrations/connections'||path==='/api/integrations/toolkits')data={items:[]};
  await route.fulfill({json:data});
 });
 await page.routeWebSocket('**/ws',()=>{});
 await page.goto(base+'/?view=agents&agent=DemoAssistant');
 await page.getByRole('heading',{name:'Project access',exact:true}).waitFor();
 await page.getByRole('button',{name:'Trust these participants with my apps'}).waitFor();
 await page.getByRole('heading',{name:'Project access',exact:true}).scrollIntoViewIfNeeded();
 await page.screenshot({path:join(screenshots,'desktop.png'),fullPage:true});
 await page.getByRole('button',{name:'Trust these participants with my apps'}).click();
 await page.getByText('Approved for these participants.',{exact:true}).waitFor();
 await page.getByRole('button',{name:'Remove project approval'}).click();
 await page.getByRole('button',{name:'Trust these participants with my apps'}).waitFor();
 stale=true;await page.getByRole('button',{name:'Trust these participants with my apps'}).click();
 await page.getByRole('alert').filter({hasText:'Project access was not confirmed'}).waitFor();
 assert.equal(approved,false);
 await page.getByRole('button',{name:'Reload project access'}).click();
 await page.setViewportSize({width:390,height:844});
 await page.getByRole('heading',{name:'Project access',exact:true}).scrollIntoViewIfNeeded();
 await page.screenshot({path:join(screenshots,'mobile.png'),fullPage:true});
 await page.getByRole('button',{name:'Trust these participants with my apps'}).scrollIntoViewIfNeeded();
 await page.screenshot({path:join(screenshots,'mobile-actions.png'),fullPage:true});
 assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
 assert.deepEqual(errors,[]);
 console.log('PASS: project audience disclosure, explicit approval, revocation, stale-roster error, reload, mobile layout. Screenshots use mock demo data.');
 } finally {await browser.close();}
} finally {server.kill();}
