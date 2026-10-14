import {useRef,useState,type FormEvent} from 'react';
import type {Project} from '@nest/schemas';
import {apiJson,getApiHeaders} from './api';

export function ProjectSettings({project,onSaved}:{project:Project;onSaved:(project:Project)=>void}) {
  const ref=useRef<HTMLDialogElement>(null);
  const [name,setName]=useState(project.name),[description,setDescription]=useState(project.description);
  const [expected,setExpected]=useState({name:project.name,description:project.description});
  const [busy,setBusy]=useState(false),[error,setError]=useState<string|null>(null);
  function open(){setName(project.name);setDescription(project.description);setExpected({name:project.name,description:project.description});setError(null);ref.current?.showModal();}
  async function save(event:FormEvent){
    event.preventDefault();setBusy(true);setError(null);
    try{const updated=await apiJson<Project>(`/api/projects/${project.id}`,{method:'PATCH',headers:getApiHeaders(),body:JSON.stringify({name,description,expected})});onSaved(updated);ref.current?.close();}
    catch(reason){const text=reason instanceof Error?reason.message:'Could not save your project.';try{setError(JSON.parse(text).error??text);}catch{setError(text);}}
    finally{setBusy(false);}
  }
  return <><button type="button" className="dashboard-action" onClick={open}>Project settings</button><dialog ref={ref} className="project-settings-dialog" aria-labelledby={`project-settings-${project.id}`} onCancel={event=>{if(busy)event.preventDefault();}}><form className="project-form" onSubmit={save}>
    <h2 id={`project-settings-${project.id}`}>Project settings</h2>
    {error&&<p role="alert">{error}</p>}
    <fieldset disabled={busy}><label>Name<input aria-label="Project name" autoFocus required maxLength={120} value={name} onChange={event=>setName(event.target.value)}/></label><label>Description<textarea aria-label="Project description" maxLength={4000} rows={4} value={description} onChange={event=>setDescription(event.target.value)}/></label></fieldset>
    <div className="project-actions"><button type="button" className="dashboard-action" disabled={busy} onClick={()=>ref.current?.close()}>Cancel</button><button className="dashboard-action project-primary" disabled={busy||!name.trim()}>{busy?'Saving…':'Save changes'}</button></div>
  </form></dialog></>;
}
