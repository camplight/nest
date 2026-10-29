import type {EventRow} from '../types';

export type AgentStarts=Readonly<Record<string,number>>;

// These are execution lifecycle records, not agent availability/heartbeats.
export function agentLifecycleStart(event:EventRow):{agent:string;at:number}|null{
 const trusted=event.type==='agent.lifecycle.started'&&event.source==='system:runner'||
  event.type==='wrapper.lifecycle.started'&&event.source==='system:runner:wrapper';
 const at=event.createdAt;
 if(!trusted||event.payloadTruncated||typeof at!=='number'||!Number.isFinite(at)||at<=0)return null;
 const payload=event.payload&&typeof event.payload==='object'?event.payload as Record<string,unknown>:{};
 return typeof payload.targetAgentName==='string'&&payload.targetAgentName.trim()
  ?{agent:payload.targetAgentName,at}:null;
}

export function mergeAgentStarts(current:AgentStarts,updates:AgentStarts):AgentStarts{
 let next=current;
 for(const [agent,at] of Object.entries(updates))if(Number.isFinite(at)&&at>(current[agent]??0)){
  if(next===current)next={...current};
  (next as Record<string,number>)[agent]=at;
 }
 return next;
}

// Compatible with the pinned engine. Keep other channels' contents out of the
// chat store; only the latest observed lifecycle timestamp per agent survives.
export async function fetchAgentStarts(fetchJson:<T>(url:string)=>Promise<T>):Promise<AgentStarts>{
 const pages=await Promise.all(['agent.lifecycle.started','wrapper.lifecycle.started'].map(type=>
  fetchJson<EventRow[]>(`/api/events?type=${type}&limit=100&order=desc`)));
 const starts:Record<string,number>={};
 for(const event of pages.flat()){
  const start=agentLifecycleStart(event);
  if(start)starts[start.agent]=Math.max(starts[start.agent]??0,start.at);
 }
 return starts;
}
