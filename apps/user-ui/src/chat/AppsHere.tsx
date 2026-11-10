// "Apps here": which outside apps this chat's agents used, and how many calls read or changed something there.
// Works from the chat's engine tool.* events in the browser; Nest keeps no copy. Only app names and counts are shown.
import {useEffect,useMemo,useRef,useState} from 'react';
import {foldCalls,summarise,type AppCall} from '../app-activity';
import {IntegrationLogo} from '../components/IntegrationLogo';
import type {EventRow} from '../types';

export const WRAPPED_LIMIT="Codex and Claude Code agents only report their messages, so their app use isn't shown here.";
/** How often a still-running call is checked against the 10 minute limit. */
const TICK_MS=30_000;

export function AppsHere({calls,wrappedAgents}:{calls:AppCall[];wrappedAgents:string[]}):JSX.Element|null{
 if(!calls.length&&!wrappedAgents.length)return null;
 const summary=summarise(calls);
 return <section className="apps-here" aria-label="Apps here">
  <strong className="apps-here-title">Apps here</strong>
  {calls.length>0&&<>
   <ul className="apps-here-chips">{summary.apps.map(app=>{
    const text=`${app.appName}: ${app.reads} reads · ${app.changes} changes`;
    return <li key={app.app} className={`apps-here-chip${app.running?' is-live':''}`} title={text} aria-label={text}>
     <IntegrationLogo toolkit={app.app}/><span className="apps-here-name">{app.appName}</span><span className="apps-here-count">{app.reads+app.changes}</span>
    </li>;
   })}</ul>
   <span className="apps-here-total">{summary.reads} reads · {summary.changes} changes outside Nest</span>
  </>}
  {wrappedAgents.length>0&&<p className="apps-here-limit">{WRAPPED_LIMIT}</p>}
 </section>;
}

/**
 * The bar for a chat's loaded events (history pages plus live ones). Engine timestamps are the server's, so the
 * browser clock is used only through an offset that can only be raised by what the events show; a timer re-folds
 * so a call that never finished turns failed after 10 minutes even when the chat is quiet.
 */
export function ChatAppsHere({events,wrappedAgents}:{events:EventRow[];wrappedAgents:string[]}):JSX.Element|null{
 const tools=useMemo(()=>events.filter(event=>event.type.startsWith('tool.')),[events]);
 const [tick,setTick]=useState(0);
 const offset=useRef(0);
 const newest=useMemo(()=>tools.reduce((latest,event)=>Math.max(latest,event.createdAt??0),0),[tools]);
 if(newest)offset.current=Math.max(offset.current,newest-Date.now());
 const live=tools.some(event=>event.type==='tool.started');
 useEffect(()=>{
  if(!live)return;
  const timer=setInterval(()=>setTick(value=>value+1),TICK_MS);
  return()=>clearInterval(timer);
 },[live]);
 const calls=useMemo(()=>foldCalls(tools,Date.now()+offset.current),[tools,tick]);
 return <AppsHere calls={calls} wrappedAgents={wrappedAgents}/>;
}
