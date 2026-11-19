import {useState} from 'react';
export function ProjectBrief({text}:{text:string}) {
  const [expanded,setExpanded]=useState(false);
  const long=text.length>240;
  return <><p className={`project-prose${long&&!expanded?' project-brief-clamped':''}`}>{text}</p>{long&&<button type="button" className="project-inline-action project-brief-toggle" aria-expanded={expanded} onClick={()=>setExpanded(!expanded)}>{expanded?'Show less':'Read full description'}</button>}</>;
}
