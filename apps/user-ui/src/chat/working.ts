import type {EventRow} from '../types';
export type WorkingTurn={agent:string;triggerEventId:string;since:number;progressText?:string;progressEventId?:string};
type TurnAgent={name:string;desiredState?:string;updatedAt?:number};
const ENDINGS=new Set(['agent.turn.completed','agent.turn.failed','wrapper.turn.completed','wrapper.turn.failed']);
const STARTS=new Set(['agent.turn.started','wrapper.turn.started']);

/**
 * Active turns per agent and trigger, built only from whitelisted fields so no
 * tool argument or process output can reach the progress text (spec 7.5.1, 5.6).
 */
export function activeTurns(events:EventRow[],agents:ReadonlyArray<TurnAgent>):WorkingTurn[]{
  const ordered=[...events].sort((a,b)=>(a.createdAt??0)-(b.createdAt??0)||(a.id<b.id?-1:a.id>b.id?1:0));
  const active=new Map<string,WorkingTurn>(),finished=new Set<string>();
  for(const event of ordered){
    const p=event.payload&&typeof event.payload==='object'?event.payload as Record<string,unknown>:{};
    const agent=event.source.startsWith('agent:')?event.source.slice(6):typeof p.targetAgentName==='string'?p.targetAgentName:'';
    const triggerEventId=p.triggerEventId;
    if(!agent||typeof triggerEventId!=='string')continue;
    const key=JSON.stringify([agent,triggerEventId]);
    if(ENDINGS.has(event.type)){finished.add(key);active.delete(key);continue;}
    const progress=event.type==='agent.turn.phase'&&(p.phase==='codex-progress'||p.phase==='wrapped-progress')&&typeof p.text==='string'&&p.text.trim()?p.text:null;
    if(!STARTS.has(event.type)&&progress===null)continue;
    if(finished.has(key))continue;
    let turn=active.get(key);
    if(!turn){
      // A newer turn by the same agent ends its older ones.
      for(const [other,row] of active)if(row.agent===agent){active.delete(other);finished.add(other);}
      turn={agent,triggerEventId,since:event.createdAt??0};
      active.set(key,turn);
    }
    if(progress!==null){turn.progressText=progress;turn.progressEventId=event.id;}
  }
  const byName=new Map(agents.map(agent=>[agent.name,agent]));
  return [...active.values()]
    .filter(turn=>{
      const agent=byName.get(turn.agent);
      return !(agent?.desiredState==='STOPPED'&&typeof agent.updatedAt==='number'&&agent.updatedAt>turn.since);
    })
    .sort((a,b)=>a.since-b.since||(a.agent<b.agent?-1:a.agent>b.agent?1:0));
}
