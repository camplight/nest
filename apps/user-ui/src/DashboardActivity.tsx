import {useEffect,useState} from 'react';
import type {DashboardActivity as Activity} from '@nest/schemas';
import {apiJson} from './api';
import {AgentAvatar} from './components/AgentAvatar';
import './dashboard-activity.css';

export function DashboardActivity({onSelect,query}:{onSelect:(id:string)=>void;query:string}){
  const [activity,setActivity]=useState<Activity|null>(null);
  const [error,setError]=useState(false);
  const [attempt,setAttempt]=useState(0);
  useEffect(()=>{
    let stopped=false,pending=false;
    const controller=new AbortController();
    async function refresh(){
      if(pending||stopped||document.visibilityState==='hidden')return;
      pending=true;
      try {
        const next=await apiJson<Activity>('/api/dashboard/activity',{signal:controller.signal});
        if(!next||!Array.isArray(next.runs))throw Error('Invalid activity');
        if(!stopped){setActivity(next);setError(false);}
      }catch{if(!stopped){setError(true);setActivity(null);}}
      finally{pending=false;}
    }
    void refresh();
    const timer=window.setInterval(()=>void refresh(),15_000);
    const visible=()=>{void refresh();};
    window.addEventListener('focus',visible);document.addEventListener('visibilitychange',visible);
    return ()=>{stopped=true;controller.abort();clearInterval(timer);window.removeEventListener('focus',visible);document.removeEventListener('visibilitychange',visible);};
  },[attempt]);
  const runs=activity?.runs.filter(run=>`${run.agent} ${run.channelName}`.toLowerCase().includes(query.toLowerCase()))??[];
  return <section className="dashboard-live" aria-label="Active runs">
    <div className="dashboard-section-title"><h2>Active runs {activity&&<span className="dashboard-pill">{activity.runs.length}{activity.limited?'+':''}</span>}</h2><button className="dashboard-action" onClick={()=>setAttempt(n=>n+1)}>Refresh runs</button></div>
    {error?<p role="alert">Live activity is unavailable. <button onClick={()=>setAttempt(n=>n+1)}>Retry activity</button></p>:!activity?<p role="status">Loading active runs…</p>:<>
      {runs.length>0?<div className="dashboard-live-list">{runs.map(run=><article className="dashboard-card dashboard-live-run" key={run.id}>
        <AgentAvatar name={run.agent}/><div><strong>{run.agent}</strong><p>{run.channelName}</p><small>Started {new Date(run.startedAt).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})}</small></div><span className="dashboard-live-state" data-state={run.state}>{run.state==='unconfirmed'?'Status unconfirmed':'Working'}</span><button className="dashboard-action" onClick={()=>onSelect(run.channelId)} aria-label={`Open ${run.agent} run`}>Open chat →</button>
      </article>)}</div>:<p className="dashboard-live-empty">{query?'No matching active runs.':'No active runs reported.'}</p>}
      <small className="dashboard-live-note">Updates every 15 seconds.{activity.limited?' Showing recent activity; older runs may be outside the available history.':''}</small>
    </>}
  </section>;
}
