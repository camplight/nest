import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { createRequire } from 'node:module';
const req=createRequire(join(process.cwd(),'apps/user-ui/package.json'));
const base='http://127.0.0.1:5298';
const server=spawn(process.execPath,[join(dirname(req.resolve('vite/package.json')),'bin/vite.js'),'--host','127.0.0.1','--port','5298','--strictPort'],{cwd:join(process.cwd(),'apps/user-ui'),stdio:'pipe'});
const screenshots=join(process.cwd(),'docs/images/validation/trusted-collaboration');
mkdirSync(screenshots,{recursive:true});
try {
 await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Vite readiness timeout')),20000);server.once('error',reject);server.stdout.on('data',b=>{if(b.toString().includes('5298')){clearTimeout(timer);resolve();}});server.stderr.on('data',b=>process.stderr.write(b));});
 const browser=await chromium.launch({headless:true});
 try {
 const page=await browser.newPage({viewport:{width:1440,height:1100}});
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/api/**',async route=>{
  const path=new URL(route.request().url()).pathname, method=route.request().method();let data=[];
  if(path==='/api/auth/me')data={id:'demo-owner-id',username:'demo-owner'};
  else if(path==='/api/branding')data={displayName:'Nest',logoUrl:'/brand/camplight-logo-white.svg',primaryColor:'#350956',accentColor:'#ff7557',backgroundColor:'#f8f4ff'};
  else if(path==='/api/agents'||path==='/api/agents/DemoAssistant'){const agent={name:'DemoAssistant',description:'Demo fixture for trusted collaboration.',runtimeState:'RUNNING',mode:'CLASSIC',modelId:'demo',visibility:'PRIVATE',ownerHumanId:'demo-owner-id',enabledSkills:[]};data=path==='/api/agents'?[agent]:agent;}
  else if(path==='/api/collaboration/agents')data={items:[{name:'DemoAssistant',ownerName:'demo-owner'}]};
  else if(path==='/api/collaboration/agents/DemoAssistant/chat')data={channelId:'direct-chat'};
  else if(path==='/api/channels')data=[{id:'direct-chat',name:'Direct chat',visibility:'PRIVATE',canPost:true,participants:[{subscriberType:'HUMAN',subscriberId:'demo-owner'},{subscriberType:'AGENT',subscriberId:'DemoAssistant'}]},{id:'demo-chat',name:'Demo project',visibility:'PRIVATE',canPost:true,participants:[{subscriberType:'HUMAN',subscriberId:'demo-owner'},{subscriberType:'AGENT',subscriberId:'DemoAssistant'}]}];
  else if(path==='/api/projects')data=[{id:'demo',name:'Demo project',description:'Synthetic project',channelId:'demo-chat',ownerId:'demo-owner-id',collaboration:'team',createdAt:1}];
  else if(path==='/api/projects/demo')data={id:'demo',name:'Demo project',description:'Synthetic project',channelId:'demo-chat',ownerId:'demo-owner-id',collaboration:'team',createdAt:1,tasks:[],deliverables:[],reviews:[]};
  else if(path==='/api/artifacts')data={items:[{name:'alook nest trust report',url:'/demo/alook-nest-trust-report',updatedAt:1792673872350,size:11000},{name:'launch demo',url:'/demo/launch',updatedAt:1792673872350,size:8500}]};
  else if(path==='/api/agent-models')data={models:[],defaultModel:'demo'};
  else if(path==='/api/onboarding/summary')data={setup:null};
  else if(path==='/api/mentions')data={items:[]};
  else if(path==='/api/integrations/config')data={configured:true,skillAvailable:true};
  else if(path.endsWith('/skill'))data={enabled:true,expiresAt:1900000000000,grantedToolCount:2,preloadConfigured:true};
  else if(path==='/api/integrations/agents/DemoAssistant/projects')throw Error('Retired project approvals should not be requested');
  else if(path==='/api/integrations/connections'||path==='/api/integrations/toolkits')data={items:[]};
  await route.fulfill({json:data});
 });
 await page.routeWebSocket('**/ws',()=>{});
 await page.goto(base+'/?view=agents&agent=DemoAssistant');
 await page.getByRole('heading',{name:'Connected apps',exact:true}).waitFor();
 assert.equal(await page.getByRole('heading',{name:'Project access',exact:true}).count(),0);
 await page.getByText('How access works',{exact:true}).click();
 await page.getByText('Teammates are trusted by default',{exact:false}).waitFor();
 assert.equal(await page.getByRole('button',{name:'Trust these participants with my apps'}).count(),0);
 await page.getByText('Teammates are trusted by default',{exact:false}).scrollIntoViewIfNeeded();
 await page.screenshot({path:join(screenshots,'desktop.png'),fullPage:true});
 await page.setViewportSize({width:390,height:844});
 await page.getByText('How access works',{exact:true}).scrollIntoViewIfNeeded();
 await page.screenshot({path:join(screenshots,'mobile.png'),fullPage:true});
 assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
 await page.goto(base+'/?view=agents');
 await page.getByRole('heading',{name:'Talk to a personal agent'}).waitFor();
 assert.equal(await page.getByRole('button',{name:'Requests',exact:true}).count(),0);
 assert.equal(await page.getByRole('heading',{name:'Teammate requests'}).count(),0);
 await page.getByRole('button',{name:'Chat',exact:true}).click();
 await page.waitForURL('**channel=direct-chat*');
 await page.goto(base+'/?view=projects&project=demo&tab=files');
 await page.getByRole('heading',{name:'Published artifacts',exact:true}).waitFor();
 await page.getByRole('link',{name:'alook nest trust report ↗'}).waitFor();
 assert.equal(await page.getByRole('link',{name:'launch demo ↗'}).getAttribute('href'),'/demo/launch');
 await page.screenshot({path:join(screenshots,'files-mobile.png'),fullPage:true});
 assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
 await page.setViewportSize({width:1440,height:1100});
 await page.screenshot({path:join(screenshots,'files-desktop.png'),fullPage:true});
 assert.deepEqual(errors,[]);
 console.log('PASS: trusted collaboration disclosure, no participant approval controls, mobile layout. Screenshots use mock data.');
 } finally {await browser.close();}
} finally {server.kill();}
