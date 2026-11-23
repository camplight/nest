import {useState} from 'react';
import type {EventRow} from '../types';
import {connectionActionLine,turnFailureText,type AppRedaction} from '../activity';
import {AgentActivity} from './AgentActivity';
import {IntegrationLogo} from './IntegrationLogo';

function agentNameOf(events:EventRow[]):string{
  for(const event of events){
    if(event.source.startsWith('agent:'))return event.source.slice('agent:'.length);
    const named=event.payload&&typeof event.payload==='object'?(event.payload as Record<string,unknown>).agentName:undefined;
    if(typeof named==='string'&&named)return named;
  }
  return 'The agent';
}

/** One turn's activity: account changes as short lines, a failure in plain words, raw events under Details.
 *  Standalone groups (a turn with no reply) name the agent, since no reply above says whose they are. */
/** `apps` (canvas flag on) draws app calls inside Details as named lines; null keeps every event a chip. */
export function TurnActivity({events,tone,formatTime,standalone=false,apps=null}:{events:EventRow[];tone:'agent'|'system';formatTime:(time?:number)=>string;standalone?:boolean;apps?:AppRedaction|null}){
  const [open,setOpen]=useState(false);
  const lines=events.flatMap(event=>{const line=connectionActionLine(event);return line?[{event,line}]:[];});
  const failure=[...events].reverse().find(event=>event.type==='agent.turn.failed');
  const agentName=agentNameOf(events);
  return <div className="turn-activity">
    {lines.length>0&&<ul className="turn-activity-lines" aria-label="App changes">
      {lines.map(({event,line})=><li key={event.id} className={`turn-activity-line is-${line.tone}`}>
        <IntegrationLogo toolkit={line.app}/><span>{line.text}</span>
      </li>)}
    </ul>}
    {failure&&<p className="turn-activity-failure">{turnFailureText(failure,agentName)}</p>}
    <details className="turn-activity-details" onToggle={event=>setOpen(event.currentTarget.open)}>
      <summary>{standalone&&agentName!=='The agent'?`${agentName} · Details`:'Details'}</summary>
      {/* Rendered only while open: most replies never need the raw events. */}
      {open&&<AgentActivity events={events} tone={tone} formatTime={formatTime} apps={apps}/>}
    </details>
  </div>;
}
