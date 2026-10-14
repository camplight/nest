import {useEffect,useRef,useState,type FormEvent} from 'react';
import {NewProjectSchema,type Project,type ProjectMember,type ProjectMemberOption} from '@nest/schemas';
import {apiJson,getApiHeaders} from './api';
import {AgentAvatar} from './components/AgentAvatar';

type Draft={id:string;name:string;description:string;members:ProjectMember[];submitted:boolean;ownerId:string;collaboration:'private'|'team'};
const storageKey='nest-new-project';
const memberKey=(member:ProjectMember)=>`${member.subscriberType}:${member.subscriberId}`;
function restore(ownerId:string):Draft {
  try {
    const saved=JSON.parse(sessionStorage.getItem(storageKey)??'null');
    if(saved&&(!saved.ownerId||saved.ownerId===ownerId)&&NewProjectSchema.shape.id.safeParse(saved.id).success&&typeof saved.name==='string'&&typeof saved.description==='string')
      return {id:saved.id,name:saved.name,description:saved.description,members:NewProjectSchema.shape.members.parse(saved.members),submitted:saved.submitted===true||!saved.ownerId,ownerId,collaboration:saved.collaboration==='team'?'team':'private'};
  }catch{}
  return {id:crypto.randomUUID(),name:'',description:'',members:[],submitted:false,ownerId,collaboration:'team'};
}
function errorText(reason:unknown) {
  if(reason instanceof TypeError)return 'We couldn’t reach Nest. Please try again in a moment.';
  const text=reason instanceof Error?reason.message:'Unable to create your project. Please try again.';
  try{const value=JSON.parse(text);return value.error?.startsWith('The engine is unavailable')?'We couldn’t finish setting up your project. Please try again.':typeof value.error==='string'?value.error:text;}catch{return text;}
}
function MemberAvatar({member,size=32}:{member:ProjectMember;size?:number}) {
  return member.subscriberType==='AGENT'?<AgentAvatar name={member.subscriberId} size={size}/>:<span className="project-person-avatar" aria-hidden="true" style={{width:size,height:size}}>{member.subscriberId.slice(0,2).toUpperCase()}</span>;
}

export function ProjectCreateForm({ownerId,onCreated,onCancel}:{ownerId:string;onCreated:(project:Project)=>void;onCancel:()=>void}) {
  const [draft,setDraft]=useState(()=>restore(ownerId));
  const [descriptionOpen,setDescriptionOpen]=useState(Boolean(draft.description));
  const [busy,setBusy]=useState(false),[error,setError]=useState<string|null>(null);
  const [expanded,setExpanded]=useState(draft.members.length>0),[search,setSearch]=useState('');
  const [options,setOptions]=useState<ProjectMemberOption[]>([]),[loading,setLoading]=useState(false),[rosterError,setRosterError]=useState<string|null>(null),[refresh,setRefresh]=useState(0);
  const searchRef=useRef<HTMLInputElement>(null);
  const mounted=useRef(true);
  useEffect(()=>{mounted.current=true;return ()=>{mounted.current=false;};},[]);
  useEffect(()=>{try{sessionStorage.setItem(storageKey,JSON.stringify(draft));}catch{}},[draft]);
  useEffect(()=>{
    if(!expanded)return;
    const controller=new AbortController();setLoading(true);setRosterError(null);
    void apiJson<{members:ProjectMemberOption[]}>('/api/projects/members',{signal:controller.signal})
      .then(value=>{if(!controller.signal.aborted)setOptions(value.members);})
      .catch(()=>{if(!controller.signal.aborted)setRosterError('We couldn’t load your team. Try again, or create the project on your own.');})
      .finally(()=>{if(!controller.signal.aborted)setLoading(false);});
    return ()=>controller.abort();
  },[expanded,refresh]);
  const locked=busy||draft.submitted;
  function toggle(member:ProjectMember) {
    setDraft(current=>({...current,members:current.members.some(value=>memberKey(value)===memberKey(member))?current.members.filter(value=>memberKey(value)!==memberKey(member)):[...current.members,{subscriberType:member.subscriberType,subscriberId:member.subscriberId}]}));
  }
  async function submit(event:FormEvent<HTMLFormElement>) {
    event.preventDefault();setBusy(true);setError(null);
    const next={...draft,submitted:true};setDraft(next);
    try{sessionStorage.setItem(storageKey,JSON.stringify(next));}catch{}
    try{
      const project=await apiJson<Project>('/api/projects',{method:'POST',headers:getApiHeaders(),body:JSON.stringify({id:next.id,name:next.name,description:next.description,members:next.members,collaboration:next.collaboration})});
      try{if(JSON.parse(sessionStorage.getItem(storageKey)??'null')?.id===next.id)sessionStorage.removeItem(storageKey);}catch{}
      if(mounted.current)onCreated(project);
    }catch(reason){
      setError(errorText(reason));
      try{if(JSON.parse(reason instanceof Error?reason.message:'null')?.canEdit)setDraft(current=>({...current,submitted:false}));}catch{}
    }finally{setBusy(false);}
  }
  const matching=options.filter(member=>`${member.subscriberId} ${member.description??''}`.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()));
  return <form className="dashboard-card project-form project-create-form" aria-label="Create a project" onSubmit={submit}>
    <div className="project-create-intro"><h2>Start with a name</h2><p>The rest is optional.</p></div>
    <fieldset disabled={locked}>
      <label>Project name<input name="name" value={draft.name} onChange={event=>setDraft(current=>({...current,name:event.target.value}))} placeholder="e.g. Website launch" autoFocus required maxLength={120}/></label>
      {descriptionOpen?<label><span>Description <span className="project-field-optional">Optional</span></span><textarea name="description" aria-label="Description (optional)" value={draft.description} onChange={event=>setDraft(current=>({...current,description:event.target.value}))} placeholder="What would you like to work on?" rows={2} maxLength={4000}/></label>:<button className="project-inline-action project-add-description" type="button" onClick={()=>setDescriptionOpen(true)}>Add a description</button>}
      <section className="project-team-picker" aria-labelledby="project-team-title">
        <div className="project-team-heading"><div><h3 id="project-team-title">Your team</h3><p>You’re already included.</p></div><button type="button" className="dashboard-action" aria-expanded={expanded} aria-controls="project-member-picker" onClick={()=>{setExpanded(value=>!value);if(!expanded)requestAnimationFrame(()=>searchRef.current?.focus());}}>{expanded?'Done':'Add people or agents'}</button></div>
        {draft.members.length>0&&<ul className="project-selected-members" aria-label="Selected teammates">{draft.members.map(member=><li key={memberKey(member)}><MemberAvatar member={member} size={24}/><span>{member.subscriberId}</span><button type="button" aria-label={`Remove ${member.subscriberId}`} onClick={()=>toggle(member)}>×</button></li>)}</ul>}
        {expanded&&<div id="project-member-picker" className="project-member-picker">
          <input ref={searchRef} type="search" aria-label="Search people or agents" placeholder="Search people or agents…" value={search} onChange={event=>setSearch(event.target.value)} onKeyDown={event=>{if(event.key==='Enter')event.preventDefault();}}/>
          {loading&&<p role="status">Loading your team…</p>}
          {rosterError&&<p role="alert">{rosterError} <button type="button" className="project-inline-action" onClick={()=>setRefresh(value=>value+1)}>Try again</button></p>}
          {!loading&&!rosterError&&<div className="project-member-options">{(['HUMAN','AGENT'] as const).map(kind=>{
            const group=matching.filter(member=>member.subscriberType===kind);
            return group.length>0&&<fieldset key={kind}><legend>{kind==='HUMAN'?'People':'Agents'}</legend>{group.map(member=>{
              const checked=draft.members.some(selected=>memberKey(selected)===memberKey(member));
              return <label className="project-member-option" key={memberKey(member)}><MemberAvatar member={member}/><span className="project-member-name"><strong>{member.subscriberId}</strong><small>{member.subscriberType==='HUMAN'?'Person':member.description||'Agent'}</small></span><input type="checkbox" aria-label={`Add ${kind==='HUMAN'?'person':'agent'} ${member.subscriberId}`} checked={checked} disabled={!checked&&draft.members.length>=50} onChange={()=>toggle(member)}/></label>;
            })}</fieldset>;
          })}{!matching.length&&<p>{search?'No matches. Try another name.':'No teammates to add yet. You can add them later.'}</p>}</div>}
        </div>}
        <p className="project-team-access">{draft.collaboration==='team'?'Everyone you add can open this project, chat and share files.':'People you add can use this project’s chat and files.'}</p>
      </section>
    </fieldset>
    {error&&<div className="notice error" role="alert">{error}{draft.submitted&&<p>Your project details are saved. Try again to finish.</p>}</div>}
    <div className="project-create-footer"><span>A private conversation, ready for your team.</span><div><button type="button" className="dashboard-action" disabled={busy} onClick={onCancel}>Cancel</button><button type="submit" className="dashboard-action project-primary" disabled={busy||!draft.name.trim()}>{busy?'Creating…':draft.submitted?'Retry creation':'Create project'}</button></div></div>
  </form>;
}
