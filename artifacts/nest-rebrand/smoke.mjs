const { chromium } = await import(process.env.NEST_PLAYWRIGHT || 'playwright');
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
const root = process.cwd();
const servers = [];
for (const [app, port] of [['user-ui',5290],['admin-ui',5273]]) {
 const base = path.join(root,'apps',app,'dist');
 const server = createServer(async(req,res)=>{
  try { const name = req.url.split('?')[0]; const file = path.join(base,name==='/'?'index.html':name); const data = await readFile(file); res.setHeader('Content-Type',({'.html':'text/html','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.ttf':'font/ttf'})[path.extname(file)] || 'application/octet-stream'); res.end(data); } catch { res.writeHead(404);res.end(); }
 });
 await new Promise(resolve=>server.listen(port,'127.0.0.1',resolve));servers.push(server);
}
const browser = await chromium.launch({headless:true, executablePath: process.env.NEST_CHROMIUM || "/Users/altras/Library/Caches/ms-playwright/chromium_headless_shell-1223/chrome-headless-shell-mac-arm64/chrome-headless-shell"});
try {
 for(const [app,port] of [['user',5290],['admin',5273]]) {
  const page = await browser.newPage({viewport:{width:1440,height:1000}});
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  let authenticated=false;
  const messages=[{id:'event-1',type:'message.created',source:'agent:Atlas',createdAt:Date.now(),payload:{text:'The project is ready for your review.'},status:'PROCESSED'}];
  await page.route('**/api/**', async route=>{
   const url=new URL(route.request().url()); let data=[];let status=200;
   if(url.pathname==='/api/auth/me'){data=authenticated?{id:'user-1',username:'Alex',mustChangePassword:false}:{};status=authenticated?200:401;}
   else if(url.pathname==='/api/auth/login'){authenticated=true;data={};}
   else if(url.pathname==='/api/auth/logout'){authenticated=false;data={};}
   else if(url.pathname==='/api/channels')data=[{id:'channel-1',name:'website-redesign',description:'A shared space for the next chapter.',canManage:true,ownerHumanId:'user-1',participants:[{subscriberType:'HUMAN',subscriberId:'Alex'},{subscriberType:'AGENT',subscriberId:'Atlas'}]}];
   else if(url.pathname==='/api/events/stats')data={total:1,byStatus:{PROCESSED:1}};
   else if(url.pathname==='/api/event-types')data={eventTypes:[]};
   else if(url.pathname==='/api/events') { if(route.request().method()==='POST'){messages.push({id:'event-2',...route.request().postDataJSON(),createdAt:Date.now()});data={};}else data=messages.filter(e=>(!url.searchParams.has('type') || e.type===url.searchParams.get('type')) && (!url.searchParams.has('typePrefix') || e.type.startsWith(url.searchParams.get('typePrefix')))); }
   await route.fulfill({status,contentType:'application/json',body:JSON.stringify(data)});
  });
  await page.goto(`http://127.0.0.1:${port}`);
  await page.getByText('Sign in to Nest', {exact:true}).waitFor();
  await page.evaluate(()=>document.fonts.ready);
  await page.screenshot({path:`artifacts/nest-rebrand/${app}-login.png`,fullPage:true,animations:"disabled"});
  await page.getByLabel('Password',{exact:true}).fill('test-password');
  await page.getByRole('button',{name:app==='user'?'Continue':'Sign in',exact:true}).click();
  await page.getByRole('button',{name:'Switch to dark theme'}).waitFor();
  if(app==='user') {
   await page.getByText('The project is ready for your review.').waitFor();
   await page.getByRole('textbox',{name:'Message',exact:true}).fill('Looks good.');
   await page.getByRole('button',{name:'Send',exact:true}).click();
   await page.getByText('Looks good.',{exact:true}).waitFor();
   await page.getByLabel('Search channels').fill('missing');
   await page.getByText('No channels match "missing".').waitFor();
   await page.getByLabel('Search channels').fill('');
  } else {await page.getByRole('heading',{name:'dashboard',exact:true}).waitFor();}
  await page.screenshot({path:`artifacts/nest-rebrand/${app}-desktop.png`,fullPage:true,animations:"disabled"});
  await page.getByRole('button',{name:'Switch to dark theme'}).click();
  assert.equal(await page.locator('html').getAttribute('data-theme'),'dark');
  await page.screenshot({path:`artifacts/nest-rebrand/${app}-dark.png`,fullPage:true,animations:"disabled"});
  await page.reload();
  await page.getByRole('button',{name:'Switch to light theme'}).waitFor();
  await page.getByRole('button',{name:'Switch to light theme'}).click();
  await page.setViewportSize({width:390,height:844});
  await page.screenshot({path:`artifacts/nest-rebrand/${app}-mobile.png`,fullPage:true,animations:"disabled"});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,`${app} mobile overflow`);
  if(app==='admin') {
   await page.getByRole('button',{name:'Menu',exact:true}).click();
   await page.getByRole('button',{name:'Agents',exact:true}).click();
   await page.getByRole('heading',{name:'agents',exact:true}).waitFor();
   for (const [nav,heading] of [['API keys','api keys'],['Agent invites','agent invites']]) {
    await page.getByRole('button',{name:'Menu',exact:true}).click();
    await page.getByRole('button',{name:nav,exact:true}).click();
    await page.getByRole('heading',{name:heading,exact:true}).first().waitFor();
   }
  }
  if(app==='user') {
   await page.getByRole('button',{name:'Menu',exact:true}).click();
   await page.getByRole('button',{name:'New conversation'}).click();
   await page.locator('.conversation-dialog').waitFor();
  }
  assert.deepEqual(errors,[],`${app} runtime errors`);
  console.log(`${app}: login, authenticated render, theme persistence, mobile layout${app==='user'?', message sending, channel filtering':', navigation'} passed`);
  await page.close();
 }
} finally {await browser.close();for(const server of servers)server.close();}
