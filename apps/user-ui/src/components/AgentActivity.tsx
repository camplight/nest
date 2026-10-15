import {useState} from 'react';
import type {EventRow} from '../types';
import {activity,activityDetails,type ActivityIcon} from '../activity';

function ActivityIconView({name}:{name:ActivityIcon}){
  const paths:Record<ActivityIcon,React.ReactNode>={
    thinking:<><path d="M9 18h6M10 21h4M8.3 14.5a6 6 0 1 1 7.4 0C15 15 15 16 15 16H9s0-1-.7-1.5Z"/></>,
    check:<><circle cx="12" cy="12" r="9"/><path d="m8 12 3 3 5-6"/></>,
    error:<><circle cx="12" cy="12" r="9"/><path d="M12 7v6m0 3v.1"/></>,
    terminal:<><rect x="3" y="4" width="18" height="16" rx="3"/><path d="m7 9 3 3-3 3m6 0h4"/></>,
    output:<><path d="M8 3h8l4 4v14H4V3h4m8 0v5h4M8 12h8m-8 4h6"/></>,
    tool:<><path d="m14 6 4 4-8 8-4-4 8-8ZM14 6V3h4l3 3v4h-3M6 14l-3 3v4h4l3-3"/></>,
    context:<><rect x="5" y="5" width="14" height="14" rx="3"/><path d="M9 9h6v6H9zM9 2v3m6-3v3M9 19v3m6-3v3M2 9h3m-3 6h3m14-6h3m-3 6h3"/></>,
    progress:<><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></>
  };
  return <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">{paths[name]}</svg>;
}
export function AgentActivity({events,tone,formatTime}:{events:EventRow[];tone:'agent'|'system';formatTime:(time?:number)=>string}){
  const [selected,setSelected]=useState<string|null>(null);
  const latest=events.at(-1)!;
  // Context telemetry can follow a terminal event; do not let it hide that result.
  const summaryEvent=[...events].reverse().find(e=>e.type!=='telemetry.context.window.updated')??latest;
  const summary=activity(summaryEvent);
  const current=events.find(e=>e.id===selected);
  return <article className={`trace-group trace-group-${tone}`} aria-label="Agent activity">
    <div className={`activity-summary activity-${summary.tone}`}><ActivityIconView name={summary.icon}/><strong>{summary.title}</strong><time>{formatTime(summaryEvent.createdAt)}</time></div>
    {summary.tone==='danger'&&<p className="activity-explanation">{summary.description}</p>}
    <details className="activity-history"><summary>Activity · {events.length} {events.length===1?'step':'steps'}</summary>
      <div className="activity-steps" aria-label="Activity steps">{events.map(event=>{
        const info=activity(event);
        return <button type="button" key={event.id} className={`activity-step activity-${info.tone}`} aria-expanded={selected===event.id} onClick={()=>setSelected(selected===event.id?null:event.id)}><ActivityIconView name={info.icon}/><span>{info.title}</span><time>{formatTime(event.createdAt)}</time></button>;
      })}</div>
      {current&&<div className="trace-detail-card" key={current.id}><strong>{activity(current).title}</strong><p>{activity(current).description}</p><details><summary>Technical details</summary><pre>{activityDetails(current)}</pre></details></div>}
    </details>
  </article>;
}
