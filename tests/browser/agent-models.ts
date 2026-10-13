import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import tailwindConfig from '../../apps/admin-ui/tailwind.config';
import { createApp as createEngine } from '../../vendor/orgops/apps/api/src/app';
import { createOrgOpsClient } from '../../packages/orgops-client/src/index';
import { createApp } from '../../apps/api/src/app';
const dir=mkdtempSync(join(tmpdir(),'nest-model-browser-'));
const screenshots=mkdtempSync(join(tmpdir(),'nest-model-screenshots-'));
const engine=createEngine({projectRoot:dir, dataDir:dir, dbPath:join(dir,'engine.sqlite'),adminUser:'owner',adminPass:'test-password'});
const product=createApp({defaultAgentModelId:'kimi',orgops:createOrgOpsClient('http://engine',async (url,init)=>engine.app.fetch(new Request(url,init))),dbPath:join(dir,'product.sqlite')});
const req=createRequire(join(process.cwd(),'apps/admin-ui/package.json'));
const {createServer}=await import(req.resolve('vite'));
const server=await createServer({root:join(process.cwd(),'apps/admin-ui'),css:{postcss:{plugins:[req('tailwindcss')({...tailwindConfig,content:[join(process.cwd(),'apps/admin-ui/src/**/*.{ts,tsx}')]}),req('autoprefixer')()]}},server:{host:'127.0.0.1',port:5306,strictPort:true}});
await server.listen();
const browser=await chromium.launch();
try {
 const login=await product.app.request('/api/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:'owner',password:'test-password'})});
 const cookie=login.headers.getSetCookie()[0].split(';')[0];
 const headers={cookie,'content-type':'application/json'};
 for(const [id,modelName] of [['kimi','moonshotai/kimi-k3'],['qwen','qwen/qwen3.8-27b']]){
  assert.equal((await product.app.request('/api/models',{method:'POST',headers,body:JSON.stringify({id,provider:'openrouter',modelName,enabled:true})})).status,201);
 }
 const page=await browser.newPage({viewport:{width:1440,height:1000}});
 await page.context().addCookies([{name:'nest_session',value:cookie.slice('nest_session='.length),url:'http://127.0.0.1:5306'}]);
 await page.routeWebSocket('**/ws',socket=>socket.close());
 await page.route('**/api/**',async route=>{
  const r=route.request(),u=new URL(r.url());
  const result=await product.app.request(u.pathname+u.search,{method:r.method(),headers:r.headers(),...(r.postDataBuffer()?{body:r.postDataBuffer()!}:{})});
  await route.fulfill({status:result.status,headers:Object.fromEntries(result.headers),body:Buffer.from(await result.arrayBuffer())});
 });
 await page.goto('http://127.0.0.1:5306');
 await page.getByRole('navigation',{name:'Administration'}).getByRole('button',{name:'Agents',exact:true}).click();
 await page.getByRole('button',{name:'New agent',exact:true}).click();
 await page.getByPlaceholder('Agent name',{exact:true}).fill('PuffTest');
 await page.getByRole('option',{name:'Instance default · openrouter:moonshotai/kimi-k3',exact:true}).waitFor({state:'attached'});
 assert.equal(await page.getByLabel('Language model').inputValue(),'');
 await page.screenshot({path:join(screenshots,'admin-model-desktop.png'),fullPage:true,animations:"disabled"});
 await page.setViewportSize({width:390,height:844});
 await page.screenshot({path:join(screenshots,'admin-model-mobile.png'),fullPage:true,animations:"disabled"});
 const modelBox=await page.getByLabel('Language model').boundingBox();
 assert(modelBox && modelBox.x >= 0 && modelBox.x+modelBox.width <= 390);
 assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
 await page.setViewportSize({width:1440,height:1000});
 await page.getByRole('button',{name:'Create Agent',exact:true}).click();
 await assert.doesNotReject(async()=>{
  for(let i=0;i<50;i++){
   const r=await product.app.request('/api/agents/PuffTest',{headers});
   if(r.ok){assert.equal((await r.json()).modelId,'openrouter:moonshotai/kimi-k3');return;}
   await new Promise(r=>setTimeout(r,100));
  }throw Error('Agent not created');
 });
 // The engine insert completes before the creation drawer hydrates. Wait for
 // the saved model in the edit form before changing it; otherwise hydration
 // can overwrite the edit on faster Linux runners.
 await page.getByRole('button',{name:'Save Details',exact:true}).waitFor();
 await page.waitForFunction(() => document.querySelector<HTMLSelectElement>('select[aria-label="Language model"]')?.value === 'openrouter:moonshotai/kimi-k3');
 await page.getByLabel('Language model').selectOption('openrouter:qwen/qwen3.8-27b');
 await page.getByRole('button',{name:'Save Details',exact:true}).click();
 await page.getByText('Agent "PuffTest" was saved successfully.',{exact:true}).first().waitFor();
 assert.equal((await (await product.app.request('/api/agents/PuffTest',{headers})).json()).modelId,'openrouter:qwen/qwen3.8-27b');
 console.log(`PASS: admin default creation and model changes against actual engine. Screenshots: ${screenshots}`);
} finally {await browser.close();await server.close();product.store.close();engine.db.close();rmSync(dir,{recursive:true,force:true});}

await import('./agent-requests');
