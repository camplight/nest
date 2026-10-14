import {useState,type FormEvent} from 'react';
import type {Project} from '@nest/schemas';
import {apiJson,getApiHeaders} from './api';

export function ProjectSettings({project,onSaved}:{project:Project;onSaved:(project:Project)=>void}) {
  const [editing,setEditing]=useState(false);
  const [name,setName]=useState(project.name),[description,setDescription]=useState(project.description);
  const [expected,setExpected]=useState({name:project.name,description:project.description});
  const [busy,setBusy]=useState(false),[error,setError]=useState<string|null>(null);
  function open(){setName(project.name);setDescription(project.description);setExpected({name:project.name,description:project.description});setError(null);setEditing(true);}
  async function save(event:FormEvent){
    event.preventDefault();setBusy(true);setError(null);
    try{const updated=await apiJson<Project>(`/api/projects/${project.id}`,{method:'PATCH',headers:getApiHeaders(),body:JSON.stringify({name,description,expected})});onSaved(updated);setEditing(false);}
    catch(reason){const text=reason instanceof Error?reason.message:'Could not save your project.';try{setError(JSON.parse(text).error??text);}catch{setError(text);}}
    finally{setBusy(false);}
  }
  if(!editing)return <><p className="project-prose">{project.description||'Describe the goal as you chat. You can add a brief here anytime.'}</p><button type="button" className="project-inline-action" onClick={open}>Edit project details</button></>;
  return <form className="project-form project-inline-details" aria-label="Edit project details" onSubmit={save}>
    {error&&<p role="alert">{error}</p>}
    <fieldset disabled={busy}><label>Name<input aria-label="Project name" autoFocus required maxLength={120} value={name} onChange={event=>setName(event.target.value)}/></label><label>Brief<textarea aria-label="Project description" maxLength={4000} rows={6} value={description} onChange={event=>setDescription(event.target.value)}/></label></fieldset>
    <div className="project-actions"><button type="button" className="dashboard-action" disabled={busy} onClick={()=>setEditing(false)}>Cancel</button><button className="dashboard-action project-primary" disabled={busy||!name.trim()}>{busy?'Saving…':'Save changes'}</button></div>
  </form>;
}
