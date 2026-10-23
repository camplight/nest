import {useEffect, useId, useLayoutEffect, useRef, useState} from 'react';
import {createPortal} from 'react-dom';
import './quick-tour.css';

const steps = [
  {target:'agents', title:'Meet your agents', text:'Open Agents to create your personal assistant or chat with a teammate’s agent. You choose the apps and tools your own agent can use.'},
  {target:'projects', title:'Start with a conversation', text:'Open Projects and describe what you want to do. Invite people and agents with @mentions. Your project’s Files tab keeps uploads and published reports within reach.'},
  {target:'community', title:'Give your agent new skills', text:'Explore Community for reusable skills. Start with one small task, review the result, and ask your agent for changes in chat.'},
];
const keyFor = (user:string) => `nest.quick-tour.v1:${encodeURIComponent(user)}`;
export function tourSeen(user:string) {try{return localStorage.getItem(keyFor(user))==='seen';}catch{return false;}}
export function rememberTour(user:string) {try{localStorage.setItem(keyFor(user),'seen');}catch{/* Tour remains usable when storage is unavailable. */}}

export function QuickTour({onClose}:{onClose:()=>void}) {
  const [step,setStep]=useState(0);
  const [rect,setRect]=useState<DOMRect|null>(null);
  const [size,setSize]=useState({width:window.innerWidth,height:window.innerHeight});
  const previousFocus=useRef(document.activeElement as HTMLElement|null);
  const dialog=useRef<HTMLDivElement>(null), heading=useRef<HTMLHeadingElement>(null);
  const titleId=useId(), descriptionId=useId(), maskId=useId().replaceAll(':','');
  const current=steps[step];
  useEffect(()=>{
    const previous=previousFocus.current;
    const shell=document.querySelector<HTMLElement>('.app-shell');
    const wasInert=shell?.inert;
    if(shell)shell.inert=true;
    return()=>{if(shell)shell.inert=!!wasInert;previous?.focus();};
  },[]);
  useLayoutEffect(()=>{
    const target=document.querySelector<HTMLElement>(`[data-tour="${current.target}"]`);
    target?.scrollIntoView({block:'nearest',behavior:'instant'});
    const update=()=>{setRect(target?.getBoundingClientRect()??null);setSize({width:window.innerWidth,height:window.innerHeight});};
    update();heading.current?.focus();
    const observer=new ResizeObserver(update);if(target)observer.observe(target);
    window.addEventListener('resize',update);document.addEventListener('scroll',update,true);
    // Sidebar transitions can move the target without resizing it.
    const timer=setTimeout(update,350);
    return()=>{observer.disconnect();clearTimeout(timer);window.removeEventListener('resize',update);document.removeEventListener('scroll',update,true);};
  },[current]);
  const width=Math.min(360,size.width-24);
  const desktop=size.width>=760;
  const left=desktop&&rect?Math.min(size.width-width-12,rect.right+24):12;
  const top=desktop&&rect?Math.max(12,Math.min(rect.top,size.height-320)):undefined;
  return createPortal(<div className="quick-tour-layer" onKeyDown={event=>{
    if(event.key==='Escape'){event.preventDefault();onClose();}
    if(event.key==='Tab'){
      const buttons=[...dialog.current!.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
      const index=buttons.indexOf(document.activeElement as HTMLButtonElement);
      event.preventDefault();buttons[(index+(event.shiftKey?-1:1)+buttons.length)%buttons.length]?.focus();
    }
  }}>
    <svg className="quick-tour-shade" aria-hidden="true" width="100%" height="100%"><defs><mask id={maskId}><rect width="100%" height="100%" fill="white"/>{rect&&rect.width>0&&<rect x={rect.left-4} y={rect.top-4} width={rect.width+8} height={rect.height+8} rx="10" fill="black"/>}</mask></defs><rect width="100%" height="100%" fill="rgba(15,8,27,.72)" mask={`url(#${maskId})`}/>{rect&&rect.width>0&&<rect x={rect.left-4} y={rect.top-4} width={rect.width+8} height={rect.height+8} rx="10" fill="none" stroke="#ffb688" strokeWidth="3"/>}</svg>
    <div ref={dialog} className="quick-tour-card" role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={descriptionId} style={{width,left,top,bottom:desktop?undefined:12}}>
      <div className="quick-tour-meta"><span>QUICK START · {step+1} OF {steps.length}</span><button onClick={onClose} aria-label="Skip tour">Skip</button></div>
      <h2 ref={heading} tabIndex={-1} id={titleId}>{current.title}</h2><p id={descriptionId}>{current.text}</p>
      <div className="quick-tour-footer"><div className="quick-tour-dots" aria-hidden="true">{steps.map((s,i)=><span key={s.target} data-active={i===step}/>)}</div><div>{step>0&&<button onClick={()=>setStep(step-1)}>Back</button>}<button className="quick-tour-next" onClick={()=>step===steps.length-1?onClose():setStep(step+1)}>{step===steps.length-1?'Get started':'Next'}</button></div></div>
    </div>
  </div>,document.body);
}
