import {useEffect,useRef,useState,type FormEvent} from 'react';
import {NewProjectSchema,type Project,type ProjectMember} from '@nest/schemas';
import {apiJson,getApiHeaders} from './api';
import {ProjectMemberPicker} from './components/ProjectMemberPicker';

type Draft={id:string;name:string;description:string;members:ProjectMember[];submitted:boolean;ownerId:string;collaboration:'private'|'team'};
const storageKey='nest-new-project';
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
export function ProjectCreateForm({ownerId,onCreated,onCancel}:{ownerId:string;onCreated:(project:Project)=>void;onCancel:()=>void}) {
  const [draft,setDraft]=useState(()=>restore(ownerId));
  const [descriptionOpen,setDescriptionOpen]=useState(Boolean(draft.description));
  const [busy,setBusy]=useState(false),[error,setError]=useState<string|null>(null);
  const mounted=useRef(true);
  useEffect(()=>{mounted.current=true;return ()=>{mounted.current=false;};},[]);
  useEffect(()=>{try{sessionStorage.setItem(storageKey,JSON.stringify(draft));}catch{}},[draft]);
  const locked=busy||draft.submitted;
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
  return <form className="dashboard-card project-form project-create-form" aria-label="Create a project" onSubmit={submit}>
    <div className="project-create-intro"><h2>Start with a name</h2><p>The rest is optional.</p></div>
    <fieldset disabled={locked}>
      <label>Project name<input name="name" value={draft.name} onChange={event=>setDraft(current=>({...current,name:event.target.value}))} placeholder="e.g. Website launch" autoFocus required maxLength={120}/></label>
      {descriptionOpen?<label><span>Description <span className="project-field-optional">Optional</span></span><textarea name="description" aria-label="Description (optional)" value={draft.description} onChange={event=>setDraft(current=>({...current,description:event.target.value}))} placeholder="What would you like to work on?" rows={2} maxLength={4000}/></label>:<button className="project-inline-action project-add-description" type="button" onClick={()=>setDescriptionOpen(true)}>Add a description</button>}
      <section className="project-team-picker" aria-labelledby="project-team-title">
        <div className="project-team-heading"><div><h3 id="project-team-title">Your team</h3><p>You’re already included.</p></div></div>
        <ProjectMemberPicker members={draft.members} disabled={locked} onChange={members=>setDraft(current=>({...current,members}))}/>
        <p className="project-team-access">{draft.collaboration==='team'?'Everyone you add can open this project, chat and share files.':'People you add can use this project’s chat and files.'}</p>
      </section>
    </fieldset>
    {error&&<div className="notice error" role="alert">{error}{draft.submitted&&<p>Your project details are saved. Try again to finish.</p>}</div>}
    <div className="project-create-footer"><span>A private conversation, ready for your team.</span><div><button type="button" className="dashboard-action" disabled={busy} onClick={onCancel}>Cancel</button><button type="submit" className="dashboard-action project-primary" disabled={busy||!draft.name.trim()}>{busy?'Creating…':draft.submitted?'Retry creation':'Create project'}</button></div></div>
  </form>;
}
