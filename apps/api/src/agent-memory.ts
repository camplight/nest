import type {Hono} from 'hono';
import type {ProductDb} from '@nest/db';
import type {OrgOpsClient} from '@nest/orgops-client';
import {AUTO_COMPACT_MEMORY_MODE} from '@nest/schemas';

type Forward=(request:Request)=>Promise<Response>;
type EngineAgent={id?:unknown;name?:unknown;memoryContextMode?:unknown};

/**
 * "Full history, summarized when long" is a Nest mode: the engine stores
 * FULL_CHANNEL_EVENTS and Nest records that it compacts the agent's long chats.
 * The engine still decides who may change the agent; Nest records the choice
 * only after the engine accepted the change.
 */
export function registerAgentMemoryRoutes(app:Hono,{store,orgops,forward,now=Date.now}:{store:ProductDb;orgops:OrgOpsClient;forward:Forward;now?:()=>number}) {
  const jobs=store.contextCompaction;
  function present(agent:EngineAgent) {
    const chosen=agent.memoryContextMode==='FULL_CHANNEL_EVENTS'&&typeof agent.id==='string'&&typeof agent.name==='string'&&jobs.autoCompact(agent.name,agent.id);
    return chosen?{...agent,memoryContextMode:AUTO_COMPACT_MEMORY_MODE}:agent;
  }
  async function presented(response:Response) {
    if(!response.ok||!response.headers.get('content-type')?.includes('application/json'))return response;
    const value=await response.json() as EngineAgent|EngineAgent[];
    const headers=new Headers(response.headers);
    headers.delete('content-length');headers.delete('content-encoding');
    return Response.json(Array.isArray(value)?value.map(present):present(value),{status:response.status,headers});
  }
  // Runners read the engine's own modes; the Nest mode is for people's settings screens.
  const fromRunner=(request:Request)=>['x-nest-runner-token','x-orgops-runner-token','authorization'].some(name=>request.headers.has(name));
  const read=async(c:{req:{raw:Request}})=>{const response=await forward(c.req.raw);return fromRunner(c.req.raw)?response:presented(response);};
  app.get('/api/agents',read);
  app.get('/api/agents/:name',read);
  app.patch('/api/agents/:name',async c=>{
    const source=c.req.raw;
    const text=await source.text();
    let body:Record<string,unknown>|null=null;
    try{const value=JSON.parse(text);if(value&&typeof value==='object'&&!Array.isArray(value))body=value;}catch{/* the engine answers malformed bodies */}
    const mode=body?.memoryContextMode;
    const autoCompact=mode===undefined?undefined:mode===AUTO_COMPACT_MEMORY_MODE;
    const engineBody=autoCompact?JSON.stringify({...body,memoryContextMode:'FULL_CHANNEL_EVENTS'}):text;
    const response=await forward(new Request(source.url,{method:'PATCH',headers:source.headers,body:engineBody}));
    if(!response.ok||autoCompact===undefined)return response;
    // The engine answers {ok:true}; read the agent back with the same credentials for its id.
    const saved=await forward(new Request(source.url,{method:'GET',headers:source.headers}));
    const agent=saved.ok?await saved.json().catch(()=>null) as EngineAgent|null:null;
    if(typeof agent?.id!=='string'||typeof agent.name!=='string')throw Error('Saved agent is unavailable');
    const actor=await orgops.currentHuman(source.headers).catch(()=>null);
    jobs.setAutoCompact({agentName:agent.name,agentId:agent.id,enabled:autoCompact,actorId:actor?.id??'engine',at:now()});
    return response;
  });
}
