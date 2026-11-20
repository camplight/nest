import type {Hono} from 'hono';
import type {ProductDb} from '@nest/db';
import type {OrgOpsClient} from '@nest/orgops-client';
import {AUTO_COMPACT_MEMORY_MODE} from '@nest/schemas';

type Forward=(request:Request)=>Promise<Response>;
type EngineAgent={id?:unknown;name?:unknown;memoryContextMode?:unknown};

/**
 * The engine's half of "Full history, summarized when long": the body to send (the Nest mode becomes
 * FULL_CHANNEL_EVENTS, which the engine accepts) and whether Nest should record the choice once the
 * engine has (undefined when the body names no mode).
 */
export function engineMemoryBody(text:string):{body:string;autoCompact:boolean|undefined} {
  let body:Record<string,unknown>|null=null;
  try{const value=JSON.parse(text);if(value&&typeof value==='object'&&!Array.isArray(value))body=value;}catch{/* the engine answers malformed bodies */}
  const mode=body?.memoryContextMode;
  const autoCompact=mode===undefined?undefined:mode===AUTO_COMPACT_MEMORY_MODE;
  return {body:autoCompact?JSON.stringify({...body,memoryContextMode:'FULL_CHANNEL_EVENTS'}):text,autoCompact};
}

/**
 * Records the choice for an agent the engine has just saved: reads it back with the same credentials for
 * its id (the engine's writes answer without one) and pins the choice to that id.
 */
export function createMemoryModeRecorder({store,orgops,now=Date.now}:{store:ProductDb;orgops:OrgOpsClient;now?:()=>number}) {
  return async function record(headers:Headers,agentName:string,enabled:boolean) {
    const saved=await orgops.request(`/api/agents/${encodeURIComponent(agentName)}`,{headers});
    const agent=saved.ok?await saved.json().catch(()=>null) as EngineAgent|null:null;
    if(typeof agent?.id!=='string'||typeof agent.name!=='string')throw Error('Saved agent is unavailable');
    const actor=await orgops.currentHuman(headers).catch(()=>null);
    store.contextCompaction.setAutoCompact({agentName:agent.name,agentId:agent.id,enabled,actorId:actor?.id??'engine',at:now()});
  };
}

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
  const record=createMemoryModeRecorder({store,orgops,now});
  app.patch('/api/agents/:name',async c=>{
    const source=c.req.raw;
    const {body,autoCompact}=engineMemoryBody(await source.text());
    const response=await forward(new Request(source.url,{method:'PATCH',headers:source.headers,body}));
    if(!response.ok||autoCompact===undefined)return response;
    await record(source.headers,c.req.param('name'),autoCompact);
    return response;
  });
}
