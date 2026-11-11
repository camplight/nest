// "Apps here": which outside apps this chat's agents used, and how many calls read or changed something there.
// Works from the chat's engine tool.* events in the browser; Nest keeps no copy. Only app names and counts are shown.
import {useEffect,useMemo,useState} from 'react';
import {serverClock,type ServerClock} from '../server-clock';
import {countOf,foldCalls,summarise,type AppCall} from '../app-activity';
import {IntegrationLogo} from '../components/IntegrationLogo';
import type {EventRow} from '../types';

const count=countOf;
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
    const text=`${app.appName}: ${count(app.reads,'read')} · ${count(app.changes,'change')}`;
    return <li key={app.app} className={`apps-here-chip${app.running?' is-live':''}`} title={text} aria-label={text}>
     <IntegrationLogo toolkit={app.app}/><span className="apps-here-name">{app.appName}</span><span className="apps-here-count">{app.reads+app.changes}</span>
    </li>;
   })}</ul>
   <span className="apps-here-total">{count(summary.reads,'read')}{summary.changes?<> · <b>{count(summary.changes,'change')}</b> outside Nest</>:' · nothing changed outside Nest'}</span>
  </>}
  {wrappedAgents.length>0&&<p className="apps-here-limit">{WRAPPED_LIMIT}</p>}
 </section>;
}

/** Re-reads the server clock every 30 seconds while `active`, so a call stuck running turns failed in a quiet chat. */
export function useServerTick(active:boolean,clock:ServerClock,setNow:(now:number)=>void):void{
 useEffect(()=>{
  if(!active)return;
  const timer=setInterval(()=>setNow(clock.serverNow()),TICK_MS);
  return()=>clearInterval(timer);
 },[active,clock,setNow]);
}

/** What the loaded tool events teach the clock: history can only raise the offset. */
export function noteToolTimes(tools:EventRow[],clock:ServerClock):void{
 const newest=tools.reduce((latest,event)=>Math.max(latest,event.createdAt??0),0);
 if(newest)clock.noteServerTime(newest);
}
/** The calls at server time `now`: a call still running 10 minutes on turns failed, even with no new events. */
export function chatCalls(tools:EventRow[],now:number):AppCall[]{
 return foldCalls(tools,now);
}

/**
 * The bar for a chat's loaded events (history pages plus live ones). Time is the shared server clock; a timer
 * re-reads it while any call is running, so a call that never finished turns failed after 10 minutes in a quiet chat.
 */
export function ChatAppsHere({events,wrappedAgents,clock=serverClock}:{events:EventRow[];wrappedAgents:string[];clock?:ServerClock}):JSX.Element|null{
 const tools=useMemo(()=>events.filter(event=>event.type.startsWith('tool.')),[events]);
 const [now,setNow]=useState(()=>clock.serverNow());
 useEffect(()=>{noteToolTimes(tools,clock);setNow(clock.serverNow());},[tools,clock]);
 const calls=useMemo(()=>chatCalls(tools,now),[tools,now]);
 const running=calls.some(call=>call.state==='running');
 useServerTick(running,clock,setNow);
 return <AppsHere calls={calls} wrappedAgents={wrappedAgents}/>;
}
