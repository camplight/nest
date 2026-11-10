// Which of a chat's agents may use apps without Nest being able to see it. Honesty wins: an agent whose mode is
// unknown (the list has not loaded, or it is not visible to the viewer) is counted as wrapped.
import type {Agent} from '../types';

type Participant={subscriberType:string;subscriberId:string};

export function unseenAppAgents(participants:readonly Participant[]|undefined,agents:readonly Pick<Agent,'name'|'mode'>[]):string[]{
 return (participants??[]).filter(p=>{
  if(p.subscriberType!=='AGENT')return false;
  const mode=agents.find(agent=>agent.name===p.subscriberId)?.mode;
  return mode!=='CLASSIC';
 }).map(p=>p.subscriberId);
}
