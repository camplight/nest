import {useId,useState,type MouseEvent,type FocusEvent} from 'react';
import {createPortal} from 'react-dom';
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
  return <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">{paths[name]}</svg>;
}
export function AgentActivity({events,tone,formatTime,progressEvents=[]}:{events:EventRow[];tone:'agent'|'system';formatTime:(time?:number)=>string;progressEvents?:EventRow[]}){
  const id=useId();
  const [selected,setSelected]=useState<string|null>(null);
  const [tooltip,setTooltip]=useState<{event:EventRow;x:number;y:number;below:boolean}|null>(null);
  const current=events.find(event=>event.id===selected);
  function showLabel(event:MouseEvent<HTMLButtonElement>|FocusEvent<HTMLButtonElement>,row:EventRow){
    const bounds=event.currentTarget.getBoundingClientRect(),below=bounds.top<70;
    setTooltip({event:row,x:Math.max(8,Math.min(bounds.left,window.innerWidth-248)),y:below?bounds.bottom+6:bounds.top-6,below});
  }
  return <article className={`trace-group trace-group-${tone}`} aria-label="Agent activity">
    <div className="trace-chips" role="group" aria-label="Agent activity events">{events.map(event=>{
      const info=activity(event),active=selected===event.id;
      return <button type="button" key={event.id} className={`trace-chip trace-chip-${info.tone}${active?' trace-chip-active':''}`}
        aria-label={info.title} aria-expanded={active} aria-controls={active?`${id}-detail`:undefined} aria-describedby={tooltip?.event.id===event.id?`${id}-label`:undefined}
        onMouseEnter={e=>showLabel(e,event)} onMouseLeave={()=>setTooltip(null)} onFocus={e=>showLabel(e,event)} onBlur={()=>setTooltip(null)}
        onClick={()=>{setTooltip(null);setSelected(active?null:event.id);}}>
        <ActivityIconView name={info.icon}/>
      </button>;
    })}</div>
    {progressEvents.map(event=><p className="trace-progress" role="status" key={event.id}>
      <strong>{event.source.slice(6)}:</strong> {String((event.payload as {text:string}).text)}
    </p>)}
    {current&&<div className="trace-detail-card" id={`${id}-detail`} key={current.id}>
      <div className="trace-detail-meta"><strong>{activity(current).title}</strong><span>{formatTime(current.createdAt)}</span></div>
      <details><summary>Details</summary><pre>{activityDetails(current)}</pre></details>
    </div>}
    {tooltip&&createPortal(<div id={`${id}-label`} role="tooltip" className={`trace-tooltip${tooltip.below?' trace-tooltip-below':''}`} style={{left:tooltip.x,top:tooltip.y}}>{activity(tooltip.event).title}<span>{formatTime(tooltip.event.createdAt)}</span></div>,document.body)}
  </article>;
}
