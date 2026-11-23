import {useId,useRef,useState,type MouseEvent,type FocusEvent} from 'react';
import {createPortal} from 'react-dom';
import type {EventRow} from '../types';
import {activity,activityDetails,appLineDetails,appLinePhrase,type ActivityIcon,type AppRedaction} from '../activity';
import type {AppCall} from '../app-activity';
import {AgentAvatar} from './AgentAvatar';
import {IntegrationLogo} from './IntegrationLogo';

function ActivityIconView({name}:{name:ActivityIcon}){
  const paths:Record<ActivityIcon,React.ReactNode>={
    thinking:<><path d="M9 18h6M10 21h4M8.3 14.5a6 6 0 1 1 7.4 0C15 15 15 16 15 16H9s0-1-.7-1.5Z"/></>,
    check:<><circle cx="12" cy="12" r="9"/><path d="m8 12 3 3 5-6"/></>,
    error:<><circle cx="12" cy="12" r="9"/><path d="M12 7v6m0 3v.1"/></>,
    terminal:<><rect x="3" y="4" width="18" height="16" rx="3"/><path d="m7 9 3 3-3 3m6 0h4"/></>,
    output:<><path d="M8 3h8l4 4v14H4V3h4m8 0v5h4M8 12h8m-8 4h6"/></>,
    tool:<><path d="m14 6 4 4-8 8-4-4 8-8ZM14 6V3h4l3 3v4h-3M6 14l-3 3v4h4l3-3"/></>,
    context:<><rect x="5" y="5" width="14" height="14" rx="3"/><path d="M9 9h6v6H9zM9 2v3m6-3v3M9 19v3m6-3v3M2 9h3m-3 6h3m14-6h3m-3 6h3"/></>,
    progress:<><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></>,
    stop:<><circle cx="12" cy="12" r="9"/><rect x="9" y="9" width="6" height="6" rx="1"/></>
  };
  return <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">{paths[name]}</svg>;
}
/** One app call as a slim line (the mock's `.act`): avatar, app icon, "Agent action · App", state, `changed`, time. */
function AppLine({call,open,onToggle,detailId,formatTime}:{call:AppCall;open:boolean;onToggle():void;detailId:string;formatTime:(time?:number)=>string}){
  return <div className={`app-line${call.state==='failed'?' is-failed':''}`} data-state={call.state}>
    <AgentAvatar name={call.agent} size={28}/>
    <div className="app-line-main">
      <button type="button" className="app-line-row" title="Show details" aria-expanded={open} aria-controls={open?detailId:undefined} onClick={onToggle}>
        <IntegrationLogo toolkit={call.app}/>
        <span className="app-line-text"><b>{call.agent}</b> {appLinePhrase(call)} · {call.appName}</span>
        {call.state==='running'&&<span className="app-line-live"><span className="app-line-dot" aria-hidden="true"/>running</span>}
        {call.state==='failed'&&<span className="app-line-failed">failed</span>}
        {call.kind==='change'&&call.state!=='failed'&&<span className="app-line-changed">changed</span>}
        <time className="app-line-time">{formatTime(call.at)}</time>
      </button>
      {open&&<pre className="app-line-details" id={detailId}>{appLineDetails(call,formatTime)}</pre>}
    </div>
  </div>;
}
type Segment={kind:'chips';events:EventRow[]}|{kind:'line';call:AppCall};
/** With the canvas flag on, app calls leave the chip strip and stand as their own lines, in order. */
function segments(events:EventRow[],apps:AppRedaction|null):Segment[]{
  if(!apps)return [{kind:'chips',events}];
  const out:Segment[]=[];
  for(const event of events){
    const call=apps.lines.get(event.id);
    if(call){out.push({kind:'line',call});continue;}
    // A result paired to an earlier start belongs to that line.
    if(apps.appEvents.has(event.id)||apps.processEvents.has(event.id))continue;
    const last=out[out.length-1];
    if(last?.kind==='chips')last.events.push(event);else out.push({kind:'chips',events:[event]});
  }
  return out;
}
/** `apps` names and redacts app calls (canvas flag on); null shows every event as before Phase 2. */
export function AgentActivity({events,tone,formatTime,apps=null}:{events:EventRow[];tone:'agent'|'system';formatTime:(time?:number)=>string;apps?:AppRedaction|null}){
  const id=useId();
  const [selected,setSelected]=useState<string|null>(null);
  const [tooltip,setTooltip]=useState<{event:EventRow;x:number;y:number;below:boolean}|null>(null);
  const current=events.find(event=>event.id===selected&&!apps?.appEvents.has(event.id)&&!apps?.processEvents.has(event.id));
  const chips=useRef(new Map<string,HTMLButtonElement>());
  // Closing returns focus to the chip that opened the card.
  function close(){if(!selected)return;const chip=chips.current.get(selected);setSelected(null);chip?.focus();}
  function showLabel(event:MouseEvent<HTMLButtonElement>|FocusEvent<HTMLButtonElement>,row:EventRow){
    const bounds=event.currentTarget.getBoundingClientRect(),below=bounds.top<70;
    setTooltip({event:row,x:Math.max(8,Math.min(bounds.left,window.innerWidth-248)),y:below?bounds.bottom+6:bounds.top-6,below});
  }
  const parts=segments(events,apps);
  if(!parts.length)return null;
  return <article className={`trace-group trace-group-${tone}`} aria-label="Agent activity">
    {parts.map((part,index)=>part.kind==='line'?
      <AppLine key={part.call.id} call={part.call} open={selected===part.call.id} detailId={`${id}-line-${index}`} formatTime={formatTime}
        onToggle={()=>setSelected(selected===part.call.id?null:part.call.id)}/>:
      <div className="trace-chips" role="group" aria-label="Agent activity events" key={part.events[0].id}>{part.events.map(event=>{
        const info=activity(event,apps),active=selected===event.id;
        return <button type="button" key={event.id} ref={node=>{if(node)chips.current.set(event.id,node);else chips.current.delete(event.id);}} className={`trace-chip trace-chip-${info.tone}${active?' trace-chip-active':''}`}
          aria-label={info.title} aria-expanded={active} aria-controls={active?`${id}-detail`:undefined} aria-describedby={tooltip?.event.id===event.id?`${id}-label`:undefined}
          onMouseEnter={e=>showLabel(e,event)} onMouseLeave={()=>setTooltip(null)} onFocus={e=>showLabel(e,event)} onBlur={()=>setTooltip(null)}
          onClick={()=>{setTooltip(null);setSelected(active?null:event.id);}}>
          <ActivityIconView name={info.icon}/>
        </button>;
      })}</div>)}
    {current&&<div className="trace-detail-card" id={`${id}-detail`} key={current.id} onKeyDown={e=>{if(e.key==='Escape'){e.stopPropagation();close();}}}>
      <div className="trace-detail-meta"><strong>{activity(current,apps).title}</strong><span>{formatTime(current.createdAt)}</span><button type="button" className="trace-detail-close" aria-label="Close details" onClick={close}>×</button></div>
      <details><summary>Details</summary><pre>{activityDetails(current,apps)}</pre></details>
    </div>}
    {tooltip&&createPortal(<div id={`${id}-label`} role="tooltip" className={`trace-tooltip${tooltip.below?' trace-tooltip-below':''}`} style={{left:tooltip.x,top:tooltip.y}}>{activity(tooltip.event,apps).title}<span>{formatTime(tooltip.event.createdAt)}</span></div>,document.body)}
  </article>;
}
