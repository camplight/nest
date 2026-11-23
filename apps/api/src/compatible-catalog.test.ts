import {it,expect,vi} from 'vitest';
import {createCompatibleCatalog,normalizeCompatibleModels} from './compatible-catalog';

const list={data:[
  {id:'accounts/fireworks/models/glm-5p3',kind:'HF_BASE_MODEL',supports_chat:true,supports_tools:true,supports_image_input:false,context_length:1048576,created:200},
  {id:'accounts/fireworks/routers/glm-5p3-fast',kind:'HF_BASE_MODEL',supports_chat:true,supports_tools:true,supports_image_input:false,context_length:1048576,created:200},
  {id:'accounts/fireworks/models/kimi-k3',kind:'HF_BASE_MODEL',supports_chat:true,supports_tools:true,supports_image_input:true,context_length:1048576,created:300},
  {id:'accounts/fireworks/models/qwen3-embedding-8b',kind:'EMBEDDING_MODEL',supports_chat:true,supports_tools:false},
  {id:'accounts/fireworks/models/no-tools',supports_chat:true,supports_tools:false},
  {id:'accounts/fireworks/models/not-chat',supports_chat:false,supports_tools:true},
  {id:'https://evil.test/x'},{id:'a:b'},{nope:true},
  {id:'plain-model'},
  {id:'auto',kind:'ROUTER'},{id:'firerouter/auto',kind:'ROUTER'},
]};
const details={models:[
  {name:'accounts/fireworks/models/glm-5p3',displayName:'GLM-5.3',description:'Synthetic GLM description'},
  {name:'accounts/fireworks/models/kimi-k3',displayName:'Kimi K3',description:'Synthetic Kimi description'},
]};
it('keeps tool-capable chat models, names them and lists models before routes, newest first',()=>{
  const models=normalizeCompatibleModels(list,details);
  expect(models.map(m=>m.id)).toEqual(['accounts/fireworks/models/kimi-k3','accounts/fireworks/models/glm-5p3','plain-model','accounts/fireworks/routers/glm-5p3-fast','auto','firerouter/auto']);
  expect(models.slice(-2).map(m=>m.name)).toEqual(['Auto','Firerouter auto']);
  expect(models[0]).toEqual({id:'accounts/fireworks/models/kimi-k3',name:'Kimi K3',description:'Synthetic Kimi description',context:1048576,tools:true,vision:true,created:300,route:false});
  // A route borrows its model's name; a provider without metadata gets a readable ID and unknown capabilities.
  expect(models.find(m=>m.route)?.name).toBe('GLM-5.3 (fast)');
  expect(models.find(m=>m.id==='plain-model')).toMatchObject({name:'Plain model',tools:null,vision:null,context:null});
  expect(normalizeCompatibleModels(list).find(m=>m.id.endsWith('/glm-5p3'))?.name).toBe('Glm 5.3');
});
it('reads the list with the agent key, adds Fireworks names, caches per key and never echoes the key',async()=>{
  let now=1000;
  const transport=vi.fn<typeof fetch>(async(url,init)=>{
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer synthetic-key');
    expect(init?.redirect).toBe('error');
    const u=String(url);
    if(u==='https://api.fireworks.ai/inference/v1/models')return Response.json(list);
    if(u.startsWith('https://api.fireworks.ai/v1/accounts/fireworks/models?'))return Response.json(details);
    throw Error('unexpected '+u);
  });
  const catalog=createCompatibleCatalog(transport,()=>now);
  const env={apiKey:'synthetic-key',baseUrl:'https://api.fireworks.ai/inference/v1/'};
  const first=await catalog(env);
  expect(first).toMatchObject({provider:'Fireworks',stale:false,fetchedAt:1000});
  expect(first.models[0].name).toBe('Kimi K3');
  expect(JSON.stringify(first)).not.toContain('synthetic-key');
  await catalog(env);expect(transport).toHaveBeenCalledTimes(2);
  now+=16*60_000;transport.mockImplementation(async()=>Response.json({},{status:503}));
  expect(await catalog(env)).toMatchObject({stale:true});
  now+=25*60*60_000;await expect(catalog(env)).rejects.toThrow('unavailable');
});
it('keeps the model list when Fireworks names are unavailable, and skips names for other providers',async()=>{
  const seen:string[]=[];
  const transport=vi.fn<typeof fetch>(async url=>{seen.push(String(url));return String(url).includes('/v1/accounts/')?Response.json({},{status:500}):Response.json(list);});
  const fireworks=await createCompatibleCatalog(transport)({apiKey:'k',baseUrl:'https://api.fireworks.ai/inference/v1'});
  expect(fireworks.models.find(m=>m.id.endsWith('/kimi-k3'))?.name).toBe('Kimi k3');
  const other=await createCompatibleCatalog(transport)({apiKey:'k',baseUrl:'https://llm.example.test/v1'});
  expect(other.provider).toBe('OpenAI-compatible');
  expect(seen.filter(u=>u.startsWith('https://llm.example.test'))).toEqual(['https://llm.example.test/v1/models']);
  expect(seen.filter(u=>u.includes('/v1/accounts/'))).toHaveLength(1);
});
