// The live ring shown when hovering or focusing a working row (spec: working ring on hover).
// Action names only: ringState never carries arguments, outputs or paths.
import {useEffect,useMemo,useRef,useState,type ReactNode} from 'react';
import {motion,useReducedMotion} from 'motion/react';
import {BotIcon,BrainIcon,CheckIcon,FileTextIcon,MessageSquareIcon,TerminalIcon,WrenchIcon,XIcon} from 'lucide-react';
import type {EventRow} from '../types';
import {AgentAvatar} from '../components/AgentAvatar';
import {IntegrationLogo} from '../components/IntegrationLogo';
import {elapsed,finishedText,ringState,ringStatusText,type FinishedTurn,type RingStation} from './ring';
import {cn} from './ui/lib/utils';

const W=340,H=236,CX=W/2,CY=H/2-8,RX=126,RY=82;
const ICONS:Record<string,ReactNode>={
 shell:<TerminalIcon className="size-4"/>,files:<FileTextIcon className="size-4"/>,memory:<BrainIcon className="size-4"/>,
 messages:<MessageSquareIcon className="size-4"/>,agents:<BotIcon className="size-4"/>,other:<WrenchIcon className="size-4"/>,
};
// Stations share the ellipse evenly, rotated so one or two sit beside the avatar rather than above and below it.
const position=(index:number,count:number)=>{
 const start=count===1?0:-Math.PI/2+Math.PI/count;
 const angle=start+index*(2*Math.PI/Math.max(count,1));
 return {x:CX+RX*Math.cos(angle),y:CY+RY*Math.sin(angle)};
};
const ago=(ms:number)=>ms<2000?'now':elapsed(ms);

/** The live ring of an open turn, or with `finished` a still picture of a finished one (no timer, motion or ages). */
export function WorkingRing({agent,since,events,finished}:{agent:string;since:number;events:readonly EventRow[];finished?:FinishedTurn}){
 const state=useMemo(()=>ringState(events,agent,since),[events,agent,since]);
 const reduced=useReducedMotion()||Boolean(finished);
 const [now,setNow]=useState(()=>Date.now());
 useEffect(()=>{
  if(finished)return;
  const id=window.setInterval(()=>setNow(Date.now()),1000);return ()=>window.clearInterval(id);
 },[finished]);
 const empty=state.stations.length===0;
 // Pulse only for actions that arrive while the card is open: counts seen at mount never pulse.
 const seen=useRef<Map<string,number>|null>(null);
 const [pulses,setPulses]=useState<{id:number;key:string}[]>([]);
 const pulseId=useRef(0);
 useEffect(()=>{
  const counts=new Map(state.stations.map(station=>[station.key,station.count]));
  if(seen.current&&!reduced){
   const fresh=state.stations.filter(station=>station.count>(seen.current!.get(station.key)??0));
   if(fresh.length)setPulses(current=>[...current,...fresh.map(station=>({id:++pulseId.current,key:station.key}))]);
  }
  seen.current=counts;
 },[state,reduced]);
 const placed=state.stations.map((station,index)=>({station,...position(index,state.stations.length)}));
 return <div className="working-ring w-[min(380px,calc(100vw-32px))] text-foreground">
  <div className="flex items-baseline justify-between gap-3 text-sm">
   <strong className="working-ring-status min-w-0 truncate font-semibold">{finished?finishedText(agent,finished):ringStatusText(agent,state.status,now)}</strong>
   <span className="flex shrink-0 gap-1.5 text-xs text-muted-foreground">{!finished&&<><span>{elapsed(now-since)}</span><span aria-hidden="true">·</span></>}<span>{state.actions} {state.actions===1?'action':'actions'}</span></span>
  </div>
  <div className="relative mx-auto mt-1" style={{width:W,maxWidth:'100%',aspectRatio:`${W}/${H}`}}>
   <svg viewBox={`0 0 ${W} ${H}`} className="absolute inset-0 size-full overflow-visible" aria-hidden="true">
    {/* Before the first action, a faint orbit shows where stations will appear. */}
    {empty&&<ellipse className="working-ring-orbit fill-none stroke-border" cx={CX} cy={CY} rx={RX} ry={RY} strokeWidth={1} strokeDasharray="3 5"/>}
    {placed.map(({station,x,y})=><line key={station.key} x1={CX} y1={CY} x2={x} y2={y} className="stroke-border" strokeWidth={1}/>)}
    {state.thinking&&!reduced&&<motion.circle cx={CX} cy={CY} r={24} fill="none" className="stroke-primary" strokeWidth={2}
     initial={{scale:1,opacity:.6}} animate={{scale:1.5,opacity:0}} transition={{duration:1.1,repeat:Infinity,ease:'easeOut'}} style={{transformOrigin:`${CX}px ${CY}px`}}/>}
    {pulses.map(pulse=>{
     const target=placed.find(item=>item.station.key===pulse.key);
     if(!target)return null;
     const failed=target.station.failed;
     return <motion.circle key={pulse.id} className={cn('ring-pulse',failed?'is-failed':'fill-primary')} r={4} cx={CX} cy={CY}
      initial={{x:0,y:0,opacity:1}} animate={{x:target.x-CX,y:target.y-CY,opacity:.85}} transition={{duration:.45,ease:'easeIn'}}
      onAnimationComplete={()=>setPulses(current=>current.filter(item=>item.id!==pulse.id))}/>;
    })}
   </svg>
   <div className="absolute -translate-x-1/2 -translate-y-1/2" style={{left:`${CX/W*100}%`,top:`${CY/H*100}%`}}><AgentAvatar name={agent} size={44}/></div>
   {placed.map(({station,x,y})=><Station key={station.key} station={station} left={x/W*100} top={y/H*100}/>)}
  </div>
  {/* Room for all five entries from the start, so the card never grows (or flips) while it is open. */}
  <ul className="working-ring-feed m-0 mt-1 min-h-[126px] list-none border-t border-border p-0 pt-2 text-[12.5px]">
   {empty&&<li className="working-ring-empty py-0.5 text-muted-foreground">{`No actions yet. Tools and apps ${agent} uses will appear here.`}</li>}
   {state.feed.map(entry=><li key={entry.id} className={cn('flex items-center gap-2 py-0.5',entry.failed&&'is-failed')}>
    {entry.failed?<XIcon aria-label="failed" className="size-3.5 shrink-0"/>:<CheckIcon aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground"/>}
    <span className="min-w-0 truncate">{entry.text}</span>
    {entry.count>1&&<span className="shrink-0 text-[11px] text-muted-foreground">×{entry.count}</span>}
    {!finished&&<span className="ms-auto shrink-0 text-[11px] text-muted-foreground">{ago(now-entry.at)}</span>}
   </li>)}
  </ul>
 </div>;
}

function Station({station,left,top}:{station:RingStation;left:number;top:number}){
 return <div className="working-ring-station absolute flex w-20 -translate-x-1/2 -translate-y-[18px] flex-col items-center text-center" style={{left:`${left}%`,top:`${top}%`}}>
  <span className={cn('grid size-9 place-items-center overflow-hidden rounded-full border bg-muted text-foreground',
   station.failed?'is-failed':station.count?'border-primary/60':'border-border')}>
   {station.app?<IntegrationLogo toolkit={station.app}/>:ICONS[station.key]??ICONS.other}
  </span>
  <span className="mt-0.5 max-w-full truncate text-[11px] leading-4">{station.label}</span>
  <span className="text-[10px] leading-3 text-muted-foreground">×{station.count}</span>
 </div>;
}
