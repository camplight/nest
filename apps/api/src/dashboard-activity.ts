import type {Hono} from 'hono';
import type {OrgOpsClient} from '@nest/orgops-client';
import type {DashboardActivity} from '@nest/schemas';

type TurnEvent={id:string;type:string;source:string;channelId?:string;createdAt:number;payload?:{triggerEventId?:unknown}};
type RunAgent={name:string;desiredState?:string;updatedAt?:number;runtimeState?:string;lastHeartbeatAt?:number|null};
const endings=new Set(['agent.turn.completed','agent.turn.failed']);
export function dashboardActivity(events:TurnEvent[],agents:RunAgent[],channels:{id:string;name?:string;archivedAt?:number|null}[],now=Date.now()):DashboardActivity {
  const allowed=new Map(channels.filter(c=>!c.archivedAt).map(c=>[c.id,c]));
  const byName=new Map(agents.map(a=>[a.name,a]));
  const turns=new Map<string,DashboardActivity['runs'][number]>();
  const finished=new Set<string>();
  const limited=events.length>=1000;
  const boundary=limited?Math.min(...events.map(e=>e.createdAt)):-Infinity;
  for(const e of [...events].sort((a,b)=>a.createdAt-b.createdAt || Number(endings.has(a.type))-Number(endings.has(b.type)) || a.id.localeCompare(b.id))){
    if(e.createdAt<=boundary||!e.channelId||!allowed.has(e.channelId)||!e.source.startsWith('agent:'))continue;
    const agent=e.source.slice(6),trigger=e.payload?.triggerEventId;
    if(typeof trigger!=='string'||!trigger)continue;
    const key=JSON.stringify([agent,e.channelId,trigger]);
    if(endings.has(e.type)){finished.add(key);turns.delete(key);continue;}
    if(e.type!=='agent.turn.started'||finished.has(key))continue;
    // A subsequent turn supersedes an unterminated older turn in the same chat.
    for(const [id,run] of turns)if(run.agent===agent&&run.channelId===e.channelId)turns.delete(id);
    turns.set(key,{id:key,agent,channelId:e.channelId,channelName:allowed.get(e.channelId)!.name||'Conversation',startedAt:e.createdAt,state:'working'});
  }
  const runs=[...turns.values()].filter(run=>{
    const agent=byName.get(run.agent);
    const latestSignal=Math.max(run.startedAt,agent?.lastHeartbeatAt??0);
    run.state=now-latestSignal>120_000?'unconfirmed':'working';
    return !((agent?.desiredState==='STOPPED'||agent?.runtimeState==='CRASHED')&&typeof agent.updatedAt==='number'&&agent.updatedAt>=run.startedAt);
  }).sort((a,b)=>b.startedAt-a.startedAt||a.id.localeCompare(b.id));
  return {runs,limited,checkedAt:now};
}
export function registerDashboardActivityRoutes(app:Hono,orgops:OrgOpsClient){
  app.get('/api/dashboard/activity',async c=>{
    c.header('Cache-Control','private, no-store');
    const human=await orgops.currentHuman(c.req.raw.headers);
    if(!human)return c.json({error:'Unauthorized'},401);
    if(human.mustChangePassword)return c.json({error:'Complete password setup first'},403);
    try {
      const [events,agents,channels]=await Promise.all([
        orgops.humanJson<TurnEvent[]>('/api/events?typePrefix=agent.turn.&excludeTypePrefix=agent.turn.phase&order=desc&limit=1000',c.req.raw.headers),
        orgops.humanJson<RunAgent[]>('/api/agents',c.req.raw.headers),
        orgops.humanJson<{id:string;name?:string;archivedAt?:number|null}[]>('/api/channels',c.req.raw.headers),
      ]);
      return c.json(dashboardActivity(events,agents,channels));
    }catch{return c.json({error:'Live activity is unavailable. Retry shortly.'},503);}
  });
}
