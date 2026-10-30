// Browser harness for the chat-next suites: a real engine, product API and WebSocket gateway
// (the codex-progress.mjs topology) behind a fresh Vite dev server, one set per runChatTest call.
import {mkdirSync,mkdtempSync,realpathSync,rmSync} from 'node:fs';
import type {IncomingMessage,Server} from 'node:http';
import {createRequire} from 'node:module';
import type {Duplex} from 'node:stream';
import {tmpdir} from 'node:os';
import {basename,join} from 'node:path';
import {once} from 'node:events';
import {serve} from '@hono/node-server';
import {chromium,type Browser,type BrowserContext,type Page} from 'playwright';
import type {Database} from 'better-sqlite3';
import {createEngine} from '../engine';
import {createOrgOpsClient} from '../../../packages/orgops-client/src/index';
import {createApp} from '../../../apps/api/src/app';
import {attachEngineWebSocket} from '../../../apps/api/src/websocket';
import type {ConnectionProvider} from '../../../apps/api/src/integrations/provider';

export type ChatHarness={
  page:Page;context:BrowserContext;base:string;apiUrl:string;cookie:string;
  engineDb:Database; // the engine database, for fixtures only
  project:{id:string;channelId:string};
  post(path:string,body:unknown,headers?:Record<string,string>):Promise<Response>;
  emit(type:string,payload:unknown,opts?:{source?:string;channelId?:string;parentEventId?:string}):Promise<{id:string}>;
  upload(name:string,bytes:Uint8Array,mime:string):Promise<{fileId:string}>;
  loginAs(username:string):Promise<{page:Page}>;
  holdNext(path:string,options?:{query?:Record<string,string>}):{started:Promise<void>;release():void};
  closeWebSocket():Promise<void>;reopenWebSocket():Promise<void>;
  screenshot(name:string):Promise<string>;
};
export type ChatTestOptions={
  viewport?:{width:number;height:number};
  chatUi?:'next'|'classic'|'unset';
  colorScheme?:'light'|'dark';
  reducedMotion?:'reduce';
  hasTouch?:boolean;
  fakeMedia?:boolean;
  connections?:unknown; // a ConnectionProvider, as projects.ts builds it
};

const root=join(import.meta.dirname,'../../..');
const owner={username:'demo-owner',password:'password'},runnerToken='fixture-runner';
export const agentName='Pip';
let exitTimer:NodeJS.Timeout|undefined;

const isAssertion=(error:unknown)=>error instanceof Error&&(error.name==='TimeoutError'||error.name==='AssertionError'||(error as {code?:string}).code==='ERR_ASSERTION');
const closeServer=(server:Server,sockets:Set<Duplex>)=>new Promise<void>(resolve=>{for(const socket of sockets)socket.destroy();server.close(()=>resolve());});
const track=(server:Server)=>{const sockets=new Set<Duplex>();server.on('connection',socket=>{sockets.add(socket);socket.once('close',()=>sockets.delete(socket));});return sockets;};

/**
 * Runs one browser test against fresh servers. A Playwright TimeoutError or an AssertionError prints
 * `RELAY-ASSERT <message>`; any other error prints its stack. Either sets process.exitCode = 1 and
 * returns, so later calls in the same file still run; nothing outlives the call.
 */
export async function runChatTest(name:string,fn:(h:ChatHarness)=>Promise<void>,options:ChatTestOptions={}):Promise<void>{
  clearTimeout(exitTimer);
  console.log(`RUN ${name}`);
  const cleanup:(()=>Promise<void>|void)[]=[];
  try{
    await fn(await setup(options,cleanup));
    console.log(`PASS ${name}`);
  }catch(error){
    process.exitCode=1;
    if(isAssertion(error))console.log(`RELAY-ASSERT ${String((error as Error).message).replace(/\s+/g,' ').trim()}`);
    else console.error(error instanceof Error?error.stack:error);
    console.log(`FAIL ${name}`);
  }finally{
    for(const step of cleanup.reverse()){try{await step();}catch(error){console.error('teardown:',error);}}
    // A stray handle must not keep the process alive after the last call.
    exitTimer=setTimeout(()=>process.exit(process.exitCode??0),5000);exitTimer.unref();
  }
}

async function setup(options:ChatTestOptions,cleanup:(()=>Promise<void>|void)[]):Promise<ChatHarness>{
  const dir=mkdtempSync(join(realpathSync(tmpdir()),'nest-chat-harness-'));
  cleanup.push(()=>rmSync(dir,{recursive:true,force:true}));
  const engine=createEngine({dbPath:join(dir,'engine.sqlite'),projectRoot:dir,dataDir:dir,adminUser:owner.username,adminPass:owner.password,runnerToken});
  cleanup.push(()=>engine.db.close());
  const upstream=serve({fetch:engine.app.fetch,hostname:'127.0.0.1',port:0}) as Server;
  const upstreamSockets=track(upstream);engine.injectWebSocket(upstream);await once(upstream,'listening');
  cleanup.push(()=>closeServer(upstream,upstreamSockets));
  const engineUrl=`http://127.0.0.1:${(upstream.address() as {port:number}).port}`;
  const product=createApp({orgops:createOrgOpsClient(engineUrl),dbPath:join(dir,'product.sqlite'),connections:(options.connections as ConnectionProvider|undefined)??null});
  cleanup.push(()=>product.store.db.close());

  // holdNext: the matching request's body is read in full before `started` resolves.
  // A hold matches the pathname (or pathname plus search, exactly) and, with a query filter, every given search param pair.
  const holds:{path:string;query:Record<string,string>;started:()=>void;gate:Promise<void>}[]=[];
  const matches=(hold:typeof holds[number],url:URL)=>(hold.path===url.pathname||hold.path===url.pathname+url.search)
    &&Object.entries(hold.query).every(([key,value])=>url.searchParams.getAll(key).includes(value));
  const fetch=async(request:Request,env?:unknown)=>{
    const url=new URL(request.url),index=holds.findIndex(hold=>matches(hold,url));
    if(index<0)return product.app.fetch(request,env);
    const [hold]=holds.splice(index,1);
    const body=request.method==='GET'||request.method==='HEAD'?undefined:await request.arrayBuffer();
    hold.started();await hold.gate;
    return product.app.fetch(new Request(request.url,{method:request.method,headers:request.headers,body}),env);
  };
  const api=serve({fetch,hostname:'127.0.0.1',port:0}) as Server;
  const apiSockets=track(api);attachEngineWebSocket(api,engineUrl);
  // closeWebSocket: the gateway's upgrade listener only sees upgrades while the socket is open.
  let wsOpen=true;const upgraded=new Set<Duplex>();
  const gateway=api.listeners('upgrade') as ((request:IncomingMessage,socket:Duplex,head:Buffer)=>void)[];
  api.removeAllListeners('upgrade');
  api.on('upgrade',(request:IncomingMessage,socket:Duplex,head:Buffer)=>{
    if(!wsOpen){socket.destroy();return;}
    upgraded.add(socket);socket.once('close',()=>upgraded.delete(socket));
    for(const listener of gateway)listener.call(api,request,socket,head);
  });
  await once(api,'listening');
  cleanup.push(()=>closeServer(api,new Set([...apiSockets,...upgraded])));
  const apiUrl=`http://127.0.0.1:${(api.address() as {port:number}).port}`;

  const uiRequire=createRequire(join(root,'apps/user-ui/package.json'));
  const {createServer}=await import(uiRequire.resolve('vite')) as typeof import('vite');
  const vite=await createServer({root:join(root,'apps/user-ui'),logLevel:'warn',server:{host:'127.0.0.1',port:0,proxy:{'/api':apiUrl}}});
  cleanup.push(()=>vite.close());
  await vite.listen();
  const base=`http://127.0.0.1:${(vite.httpServer!.address() as {port:number}).port}`;

  const post=(path:string,body:unknown,headers?:Record<string,string>)=>globalThis.fetch(apiUrl+path,{method:'POST',headers:headers??{cookie,'content-type':'application/json'},body:JSON.stringify(body)});
  const must=async(response:Promise<Response>,what:string)=>{const result=await response;if(!result.ok)throw Error(`${what}: ${result.status} ${await result.text()}`);return result;};
  const login=async(username:string,password:string)=>{
    const response=await must(post('/api/auth/login',{username,password},{'content-type':'application/json'}),`login ${username}`);
    return response.headers.getSetCookie()[0].split(';')[0];
  };
  const cookie=await login(owner.username,owner.password);
  await must(post('/api/agents',{name:agentName,icon:'pip',visibility:'PUBLIC',modelId:'wrapped:none',workspacePath:join(dir,'workspace')}),'create agent');
  const project=await(await must(post('/api/projects',{id:crypto.randomUUID(),name:'Synthetic chat project',description:'Synthetic test project',members:[{subscriberType:'AGENT',subscriberId:agentName}]}),'create project')).json() as {id:string;channelId:string};

  const browser:Browser=await chromium.launch(options.fakeMedia?{args:['--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream']}:{});cleanup.push(()=>browser.close());
  const openContext=async(sessionCookie:string)=>{
    const context=await browser.newContext({viewport:options.viewport??{width:1440,height:1000},colorScheme:options.colorScheme,reducedMotion:options.reducedMotion,hasTouch:options.hasTouch});
    await context.addCookies([{name:'nest_session',value:sessionCookie.slice('nest_session='.length),url:base,httpOnly:true}]);
    await context.addInitScript(ws=>{(globalThis as {__NEST_USER_UI_CONFIG__?:unknown}).__NEST_USER_UI_CONFIG__={wsBaseUrl:ws};},apiUrl.replace('http:','ws:')+'/ws');
    if(options.chatUi!=='unset')await context.addInitScript(value=>{try{localStorage.setItem('nest:chat-ui',value);}catch{}},options.chatUi??'next');
    const page=await context.newPage();page.setDefaultTimeout(15000);
    page.on('pageerror',error=>console.error('pageerror:',error.message));
    return {context,page};
  };
  const {context,page}=await openContext(cookie);
  await page.goto(`${base}/?view=projects&project=${project.id}`);
  await page.getByRole('textbox',{name:'Message',exact:true}).waitFor();

  return {
    page,context,base,apiUrl,cookie,engineDb:engine.db as unknown as Database,project,post,
    async emit(type,payload,opts={}){
      const response=await must(post('/api/events',{type,source:opts.source??`agent:${agentName}`,channelId:opts.channelId??project.channelId,payload,...(opts.parentEventId?{parentEventId:opts.parentEventId}:{})},{'content-type':'application/json','x-nest-runner-token':runnerToken}),`emit ${type}`);
      return {id:((await response.json()) as {id:string}).id};
    },
    async upload(name,bytes,mime){
      const form=new FormData();form.append('file',new Blob([bytes],{type:mime}),name);
      const response=await must(globalThis.fetch(apiUrl+'/api/files',{method:'POST',headers:{cookie},body:form}),`upload ${name}`);
      return {fileId:((await response.json()) as {id:string}).id};
    },
    async loginAs(username){
      if(username!==owner.username){
        const invite=await post('/api/humans/invite',{username,tempPassword:owner.password});
        if(!invite.ok&&invite.status!==409)throw Error(`invite ${username}: ${invite.status} ${await invite.text()}`);
        engine.db.prepare('UPDATE humans SET must_change_password=0 WHERE username=?').run(username);
        const member=await post(`/api/projects/${project.id}/members`,{subscriberType:'HUMAN',subscriberId:username});
        if(!member.ok&&member.status!==409)throw Error(`add ${username} to the project: ${member.status} ${await member.text()}`);
      }
      // The human joins the harness project's channel and opens it (a member who does not own the project gets no project page).
      const second=await openContext(await login(username,owner.password));
      await second.page.goto(username===owner.username?`${base}/?view=projects&project=${project.id}`:`${base}/?channel=${project.channelId}`);
      await second.page.getByRole('textbox',{name:'Message',exact:true}).waitFor();
      return {page:second.page};
    },
    holdNext(path,options={}){
      let started!:()=>void,release!:()=>void;
      const startedPromise=new Promise<void>(resolve=>{started=resolve;}),gate=new Promise<void>(resolve=>{release=resolve;});
      holds.push({path,query:options.query??{},started,gate});cleanup.push(()=>release()); // teardown runs in reverse, so a held request is released before the servers close
      return {started:startedPromise,release};
    },
    async closeWebSocket(){wsOpen=false;for(const socket of upgraded)socket.destroy();},
    async reopenWebSocket(){wsOpen=true;},
    async screenshot(name){
      const dir=process.env.NEST_CHAT_SHOTS_DIR||join('/private/tmp/claude-501/nest-chat-ui-shots',basename(process.cwd()));
      mkdirSync(dir,{recursive:true});const path=join(dir,`${name}.png`);
      await page.screenshot({path,fullPage:true});return path;
    },
  };
}
