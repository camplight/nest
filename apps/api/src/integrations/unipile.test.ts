import {describe,it,expect,vi,afterEach} from 'vitest';
import {createUnipileProvider,unipileConfigFromEnv,LINKEDIN_TOOLKIT} from './unipile';
import {connectionRegistry} from './registry';
import type {ConnectionProvider} from './provider';
const rawAccount={id:'acc_a',provider:'linkedin',account_scope_id:'scope_alice',status:'running',is_locked:false};
function fixture() {
 const requests:{url:URL;method:string;body:any}[]=[];
 let account={...rawAccount};
 let failure=0;
 const transport=vi.fn(async(input: any,init: any)=>{
   const url=new URL(String(input)),method=init.method,body=init.body?JSON.parse(init.body):undefined;
   requests.push({url,method,body});
   expect(url.origin).toBe('https://api.unipile.com');
   expect(init.headers['X-API-KEY']).toBe('private-key');
   expect(init.redirect).toBe('error');
   if(failure)return new Response('private-key and message bodies',{status:failure});
   let result: unknown={data:[],next_cursor:null};
   if(url.pathname==='/v2/accounts/acc_a')result=method==='DELETE'?{success:true}:account;
   if(url.pathname==='/v2/accounts/')result={data:[account],has_more:false};
   if(url.pathname==='/v2/auth/link')result={link:'https://auth.unipile.com/session'};
   if(url.pathname==='/v2/acc_a/posts' && method==='POST')result={id:'post_1'};
   return Response.json(result);
 });
 const provider=createUnipileProvider({apiKey:'private-key',callbackUrl:'https://nest.example/onboarding',ownerScopes:{alice:'scope_alice',bob:'scope_bob'},fetch:transport as typeof fetch});
 return {provider,requests,transport,setAccount:(v:Partial<typeof rawAccount>)=>{account={...account,...v};},fail:(status:number)=>{failure=status;}};
}
afterEach(()=>vi.unstubAllEnvs());
describe('Unipile account boundary',()=>{
 it('creates hosted links in the owner scope; unknown owners cannot connect',async()=>{
  const f=fixture();
  expect(await f.provider.link('alice',LINKEDIN_TOOLKIT)).toEqual({redirectUrl:'https://auth.unipile.com/session'});
  expect(f.requests[0].body).toMatchObject({providers:['linkedin'],account_scope_id:'scope_alice',redirect_uri:'https://nest.example/onboarding'});
  await expect(f.provider.link('mallory',LINKEDIN_TOOLKIT)).rejects.toThrow();
  expect(f.requests).toHaveLength(1);
 });
 it('filters accounts by owner scope and rejects a foreign response',async()=>{
  const f=fixture();
  expect((await f.provider.accounts('alice')).items[0].subject).toBe('scope_alice');
  expect(f.requests[0].url.searchParams.get('account_scope_id')).toBe('scope_alice');
  f.setAccount({account_scope_id:'scope_bob'});
  await expect(f.provider.accounts('alice')).rejects.toThrow('ownership');
  expect(await f.provider.accounts('unknown')).toEqual({items:[],nextCursor:null});
 });
 it('fails closed on duplicate scopes, malformed setup and unsafe redirect URLs',()=>{
  expect(()=>createUnipileProvider({apiKey:'key',callbackUrl:'https://nest.example',ownerScopes:{a:'same',b:'same'}})).toThrow('unique');
  expect(()=>createUnipileProvider({apiKey:'key',callbackUrl:'http://nest.example',ownerScopes:{}})).toThrow('HTTPS');
  vi.stubEnv('NEST_UNIPILE_API_KEY','key');
  vi.stubEnv('NEST_UNIPILE_CALLBACK_URL','');
  expect(()=>unipileConfigFromEnv()).toThrow('Incomplete');
 });
 it('does not redirect the human to a provider-supplied foreign origin',async()=>{
  const p=createUnipileProvider({apiKey:'key',callbackUrl:'https://nest.example',ownerScopes:{a:'scope_a'},fetch:async()=>Response.json({link:'https://evil.example/session'})});
  await expect(p.link('a',LINKEDIN_TOOLKIT)).rejects.toThrow('authorization URL');
 });
 it.each(['disconnected','errored','partial','degraded'])('blocks execution when status is %s',async status=>{
  const f=fixture(),bound=await f.provider.account('acc_a'); f.setAccount({status});
  await expect(f.provider.execute(bound,'LINKEDIN_LIST_CHATS',{})).rejects.toThrow('unavailable');
  expect(f.requests.some(r=>r.url.pathname.endsWith('/chats'))).toBe(false);
 });
 it('blocks a changed scope and locked account immediately before execution',async()=>{
  const f=fixture(),bound=await f.provider.account('acc_a');
  f.setAccount({account_scope_id:'scope_bob'});
  await expect(f.provider.execute(bound,'LINKEDIN_LIST_CHATS',{})).rejects.toThrow();
  f.setAccount({account_scope_id:'scope_alice',is_locked:true});
  await expect(f.provider.execute(bound,'LINKEDIN_LIST_CHATS',{})).rejects.toThrow();
 });
});
describe('LinkedIn tools',()=>{
 it('keeps account IDs out of arguments and sends paginated messages to the bound account',async()=>{
  const f=fixture(),bound=await f.provider.account('acc_a');
  await f.provider.execute(bound,'LINKEDIN_LIST_MESSAGES',{chat_id:'a/b',cursor:'page2',limit:20});
  const last=f.requests.at(-1)!;
  expect(last.url.pathname).toBe('/v2/acc_a/chats/a%2Fb/messages');
  expect(last.url.searchParams.get('cursor')).toBe('page2');
  expect(last.url.searchParams.get('limit')).toBe('20');
  const count=f.requests.length;
  await expect(f.provider.execute(bound,'LINKEDIN_LIST_MESSAGES',{chat_id:'chat',account_id:'victim'})).rejects.toThrow();
  await expect(f.provider.execute(bound,'LINKEDIN_GET_PROFILE',{user_id:'..'})).rejects.toThrow();
  expect(f.requests).toHaveLength(count);
 });
 it('requests explicit profile sections without dropping repeated parameters',async()=>{
  const f=fixture(),bound=await f.provider.account('acc_a');
  await f.provider.execute(bound,'LINKEDIN_GET_PROFILE',{user_id:'someone',with_sections:['linkedin_experience','linkedin_skills']});
  expect(f.requests.at(-1)!.url.searchParams.getAll('with_sections')).toEqual(['linkedin_experience','linkedin_skills']);
 });
 it('separates personal and company publishing and returns the publication ID',async()=>{
  const f=fixture(),bound=await f.provider.account('acc_a');
  expect(await f.provider.execute(bound,'LINKEDIN_PUBLISH_PERSONAL',{text:'A post'})).toEqual({id:'post_1'});
  expect(f.requests.at(-1)!.body).toEqual({text:'A post'});
  await expect(f.provider.execute(bound,'LINKEDIN_PUBLISH_PERSONAL',{text:'A post',company_id:'123'})).rejects.toThrow();
  await f.provider.execute(bound,'LINKEDIN_PUBLISH_COMPANY',{text:'Company news',company_id:'123'});
  expect(f.requests.at(-1)!.body).toEqual({text:'Company news',post_as:'123'});
 });
 it('does not leak response secrets or retry failed requests',async()=>{
  const f=fixture();f.fail(429);
  await expect(f.provider.account('acc_a')).rejects.toThrow('429');
  expect(f.requests).toHaveLength(1);
  await expect(f.provider.account('acc_a')).rejects.not.toThrow('private-key');
 });
 it('lists only supported exact grants',async()=>{
  const f=fixture();const page=await f.provider.tools(LINKEDIN_TOOLKIT,'');
  expect(page.items).toHaveLength(8);
  expect(page.items.every(t=>!('schema' in t)&&!('path' in t))).toBe(true);
  await expect(f.provider.tool('LINKEDIN_SEND_MESSAGE')).rejects.toThrow();
 });
});
describe('multiple connection providers',()=>{
 it('paginates providers without changing existing provider identity or routing',async()=>{
  const f=fixture();
  const legacy={...f.provider,id:'composio',toolkits:undefined,apps:vi.fn(async()=>({items:[{slug:'trello',name:'Trello',description:'',connectable:true}],nextCursor:null}))} satisfies ConnectionProvider;
  const registry=connectionRegistry([legacy,f.provider]);
  const first=await registry.page(undefined,p=>p.apps(''));
  expect(first.items[0].slug).toBe('trello');
  const second=await registry.page(first.nextCursor!,p=>p.apps(''));
  expect(second.items[0].slug).toBe(LINKEDIN_TOOLKIT);
  expect(second.nextCursor).toBeNull();
  expect(registry.get('composio')).toBe(legacy);
  expect(registry.forToolkit(LINKEDIN_TOOLKIT)).toBe(f.provider);
  expect(registry.forToolkit('trello')).toBe(legacy);
 });
 it('rejects unknown providers in cursors and preserves legacy remote cursors',async()=>{
  const f=fixture(),registry=connectionRegistry([f.provider]);
  const fetchPage=vi.fn(async()=>({items:[],nextCursor:null}));
  await registry.page('old-remote-cursor',fetchPage);
  expect(fetchPage).toHaveBeenCalledWith(f.provider,'old-remote-cursor');
  await expect(registry.page('nest-provider:'+Buffer.from(JSON.stringify({provider:'unknown'})).toString('base64url'),fetchPage)).rejects.toThrow();
 });
});
