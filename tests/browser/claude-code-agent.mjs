import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { tsImport } from 'tsx/esm/api';

// Admin "Claude Code" agent creation against a mocked admin API. The recipe
// below is the contract the container check (tests/container) inlines.
const recipe={kind:'claude-code',harness:'command',session:{scope:'per-channel'},setup:{checkCommand:'claude --version'},runtime:{command:'exec node',args:['/app/deploy/claude-code-bridge.mjs'],parse:'text',timeoutMs:7200000,env:{NEST_CLAUDE_PERMISSIONS:'full',NEST_CLAUDE_UID:'1000',NEST_CLAUDE_GID:'1000',NEST_CLAUDE_HOME:'/home/node',NEST_CLAUDE_CONFIG_DIR:'/home/node/.claude',NEST_CLAUDE_SECRETS:'GH_TOKEN',NEST_CLAUDE_SECRET_FILES:'SSH_PRIVATE_KEY:.ssh/id_ed25519'}},secrets:{allowedKeys:['CLAUDE_CODE_OAUTH_TOKEN','GH_TOKEN','SSH_PRIVATE_KEY']}};
const screenshots=join(process.cwd(),'docs/images/validation/claude-code-agent');mkdirSync(screenshots,{recursive:true});
const req=createRequire(join(process.cwd(),'apps/admin-ui/package.json'));
const {default:tailwindConfig}=await tsImport('../../apps/admin-ui/tailwind.config.ts',import.meta.url);
const {createServer}=await import(req.resolve('vite'));
const port=5317,base=`http://127.0.0.1:${port}`;
const server=await createServer({root:join(process.cwd(),'apps/admin-ui'),logLevel:'error',css:{postcss:{plugins:[req('tailwindcss')({...tailwindConfig,content:[join(process.cwd(),'apps/admin-ui/src/**/*.{ts,tsx}')]}),req('autoprefixer')()]}},server:{host:'127.0.0.1',port,strictPort:true}});
await server.listen();
const browser=await chromium.launch();
try {
 const now=Date.now();
 const runner=(id,displayName,online)=>({id,displayName,online,createdAt:now,updatedAt:now,lastSeenAt:now});
 let runners=[runner('runner-nest','nest',true),runner('runner-agents','nest-agents',true)];
 // An existing agent with env the form does not manage, as the container check sets it.
 const tuned={...recipe,runtime:{...recipe.runtime,env:{...recipe.runtime.env,NEST_CLAUDE_MODEL:'sonnet',NEST_CLAUDE_UPSTREAM_URL:'http://127.0.0.1:4010'}}};
 const agents=[{name:'Tuned',mode:'WRAPPED',modelId:'wrapped:none',runtimeState:'STOPPED',desiredState:'STOPPED',visibility:'PUBLIC',workspacePath:'.nest-data/workspaces/Tuned',assignedRunnerId:'runner-agents',wrappedConfig:tuned},{name:'Helper',mode:'CLASSIC',modelId:'openrouter:moonshotai/kimi-k3',runtimeState:'RUNNING',desiredState:'RUNNING',visibility:'PUBLIC',workspacePath:'.nest-data/workspaces/Helper'}];
 const posts=[],patches=[];
 const page=await browser.newPage({viewport:{width:1440,height:1000}});
 page.setDefaultTimeout(10000);
 const errors=[];page.on('pageerror',error=>errors.push(error.message));
 await page.routeWebSocket('**/ws',socket=>socket.close());
 await page.route('**/api/**',async route=>{
  const r=route.request(),path=new URL(r.url()).pathname;
  if(path==='/api/auth/me')return route.fulfill({json:{id:'admin',username:'admin'}});
  if(path==='/api/agent-models')return route.fulfill({json:{models:[{id:'kimi',name:'moonshotai/kimi-k3',provider:'openrouter',reference:'openrouter:moonshotai/kimi-k3'}],defaultModel:'openrouter:moonshotai/kimi-k3'}});
  if(path==='/api/runners')return route.fulfill({json:runners});
  if(path==='/api/events/stats')return route.fulfill({json:{total:0,byStatus:{}}});
  if(path==='/api/event-types')return route.fulfill({json:{eventTypes:[]}});
  if(path==='/api/agents'&&r.method()==='POST'){
   const body=r.postDataJSON();posts.push(body);
   agents.push({...body,runtimeState:'STOPPED',desiredState:'STOPPED'});
   return route.fulfill({status:201,json:{ok:true}});
  }
  if(path==='/api/agents/Tuned'&&r.method()==='PATCH'){patches.push(r.postDataJSON());return route.fulfill({json:{ok:true}});}
  if(path==='/api/agents')return route.fulfill({json:agents});
  return route.fulfill({json:[]});
 });
 await page.goto(base);
 const nav=page.getByRole('navigation',{name:'Administration'});
 await nav.getByRole('button',{name:'Agents',exact:true}).click();
 await page.getByRole('button',{name:'New agent',exact:true}).click();
 await page.getByPlaceholder('Agent name',{exact:true}).fill('Coder');
 assert.equal(await page.getByLabel('Workspace directory').inputValue(),'.nest-data/workspaces/default');
 await page.getByLabel('Mode',{exact:true}).selectOption('CLAUDE_CODE');
 const settings=page.getByRole('group',{name:'Claude Code settings'});
 await settings.waitFor();
 // Each Claude Code agent gets its own workspace, following the name until the operator edits it.
 assert.equal(await page.getByLabel('Workspace directory').inputValue(),'.nest-data/workspaces/Coder');
 await page.getByPlaceholder('Agent name',{exact:true}).fill('Code Review/ops');
 assert.equal(await page.getByLabel('Workspace directory').inputValue(),'.nest-data/workspaces/Code-Review-ops');
 await page.getByPlaceholder('Agent name',{exact:true}).fill('Coder');
 assert.equal(await page.getByLabel('Workspace directory').inputValue(),'.nest-data/workspaces/Coder');
 assert.equal(await page.getByLabel('Language model').count(),0,'model is hidden for Claude Code');
 assert.equal(await page.getByText('Memory context mode',{exact:true}).count(),0,'memory context is hidden');
 assert.equal(await page.getByText('Wrapped runtime config',{exact:true}).count(),0,'raw JSON is replaced by the form');
 assert.equal(await page.getByLabel('Assigned runner').inputValue(),'runner-agents','defaults to the nest-agents runner');
 assert.equal(await page.getByLabel('Turn limit in minutes').inputValue(),'120');
 // Reserved and malformed names never reach the recipe.
 await page.getByLabel('Tool secret name').fill('NEST_RUNNER_TOKEN');await page.getByRole('button',{name:'Add secret'}).click();
 await settings.getByRole('alert').filter({hasText:'are reserved'}).waitFor();
 await page.getByLabel('Secret file name').fill('SSH_PRIVATE_KEY');await page.getByLabel('Secret file path').fill('../outside');await page.getByRole('button',{name:'Add file'}).click();
 await settings.getByRole('alert').filter({hasText:"inside Claude's home"}).waitFor();
 await page.getByLabel('Tool secret name').fill('gh_token');await page.getByRole('button',{name:'Add secret'}).click();
 await page.getByLabel('Secret file path').fill('.ssh/id_ed25519');await page.getByRole('button',{name:'Add file'}).click();
 assert.equal(await settings.getByRole('alert').count(),0);
 for(const label of ['Tool secret name','Secret file name','Secret file path'])assert.equal(await page.getByLabel(label).inputValue(),'',`${label} is cleared after adding`);
 await settings.getByRole('note').filter({hasText:'Add these secrets in Admin → Secrets with scope Private, agent Coder: CLAUDE_CODE_OAUTH_TOKEN, GH_TOKEN, SSH_PRIVATE_KEY'}).waitFor();
 assert.equal(await settings.getByText('No agent container runner found',{exact:false}).count(),0);
 await settings.getByText('Generated recipe',{exact:true}).click();
 assert.deepEqual(JSON.parse(await settings.getByLabel('Generated recipe').textContent()),recipe);
 assert.equal(await page.getByText(/[\u2013\u2014]/).count(),0,'no en or em dashes in the copy');
 // Tall viewports keep the whole drawer form in one capture.
 await page.setViewportSize({width:1440,height:1900});
 await settings.evaluate(el=>{el.closest('.overflow-auto').scrollTop=0;});
 await page.screenshot({path:join(screenshots,'claude-code-create-desktop.png'),animations:'disabled'});
 await page.setViewportSize({width:390,height:2300});
 assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'no horizontal page scroll on mobile');
 for(const label of ['Mode','Claude credential','Tool secret name','Secret file path','Generated recipe']){
  const box=await page.getByLabel(label,{exact:true}).boundingBox();assert(box&&box.x>=0&&box.x+box.width<=390,`${label} fits a 390 px screen`);
 }
 assert(await settings.evaluate(el=>el.scrollWidth<=el.clientWidth),'settings do not overflow on mobile');
 await page.screenshot({path:join(screenshots,'claude-code-create-mobile.png'),animations:'disabled'});
 await page.setViewportSize({width:1440,height:1000});
 await page.getByRole('button',{name:'Create Agent',exact:true}).click();
 await page.getByText('Agent "Coder" was saved successfully.',{exact:true}).first().waitFor();
 assert.equal(posts.length,1);
 assert.equal(posts[0].workspacePath,'.nest-data/workspaces/Coder');
 assert.equal(posts[0].mode,'WRAPPED');assert.equal(posts[0].modelId,'wrapped:none');assert.equal(posts[0].assignedRunnerId,'runner-agents');
 assert.deepEqual(posts[0].wrappedConfig,recipe);assert.deepEqual(JSON.parse(posts[0].wrappedConfigJson),recipe);
 assert(!('claudeCode' in posts[0]),'form-only options are not sent');
 // Reopening a saved claude-code agent lands in the Claude Code view.
 await page.getByRole('button',{name:'Close',exact:true}).click();
 await page.getByRole('cell',{name:'Coder',exact:true}).click();
 await settings.waitFor();
 assert.equal(await page.getByLabel('Mode',{exact:true}).inputValue(),'CLAUDE_CODE');
 await settings.getByRole('list',{name:'Tool secrets'}).getByText('GH_TOKEN',{exact:true}).waitFor();
 await settings.getByRole('list',{name:'Secret files'}).getByText('~/.ssh/id_ed25519',{exact:true}).waitFor();
 // Saving an existing agent keeps env the form does not manage.
 await page.getByRole('button',{name:'Close',exact:true}).click();
 await page.getByRole('cell',{name:'Tuned',exact:true}).click();
 await settings.waitFor();
 // The drawer hydrates after the row click; wait for Tuned's values before editing, as agent-models.ts does.
 await page.waitForFunction(()=>document.querySelector('input[aria-label="Workspace directory"]')?.value==='.nest-data/workspaces/Tuned');
 await page.getByLabel('Turn limit in minutes').fill('30');
 await page.getByRole('button',{name:'Save Details',exact:true}).click();
 await page.getByText('Agent "Tuned" was saved successfully.',{exact:true}).first().waitFor();
 assert.deepEqual(patches.at(-1).wrappedConfig,{...tuned,runtime:{...tuned.runtime,timeoutMs:1800000}});
 // An edited workspace stops following the name; a plain WRAPPED agent keeps the raw JSON recipe path.
 await page.getByRole('button',{name:'Close',exact:true}).click();
 runners=[runner('runner-nest','nest',true)];
 await page.reload();await nav.getByRole('button',{name:'Agents',exact:true}).click();
 await page.getByRole('button',{name:'New agent',exact:true}).click();
 await page.getByLabel('Mode',{exact:true}).selectOption('CLAUDE_CODE');
 await page.getByLabel('Workspace directory').fill('/srv/shared');
 await page.getByPlaceholder('Agent name',{exact:true}).fill('Later');
 assert.equal(await page.getByLabel('Workspace directory').inputValue(),'/srv/shared');
 await settings.getByText('No agent container runner found. Claude Code agents need the nest-agents container (docs/CLAUDE_CODE_AGENT.md).',{exact:true}).waitFor();
 assert.equal(await page.getByLabel('Assigned runner').inputValue(),'','engine default without an agent container');
 await page.getByLabel('Mode',{exact:true}).selectOption('WRAPPED');
 await page.getByText('Wrapped runtime config',{exact:true}).waitFor();
 assert.equal(await settings.count(),0);
 assert.deepEqual(errors,[]);
 console.log(`PASS: Claude Code option, hidden model fields, runner default, per-agent workspace, kept operator env, cleared inputs, secret validation, notice, recipe preview, exact POST body, reopen view, missing runner notice, raw WRAPPED path and mobile layout. Screenshots: ${screenshots}`);
} finally {await browser.close();await server.close();}
