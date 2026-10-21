import {useRef,useState,type FormEvent} from 'react';
import type {Project,ProjectMember} from '@nest/schemas';
import type {Agent,ChannelParticipant} from './types';
import {apiJson,getApiHeaders} from './api';
import {ProjectSettings} from './ProjectSettings';
import {ProjectMemberPicker} from './components/ProjectMemberPicker';
import {AgentAvatar} from './components/AgentAvatar';
import {AgentRuntimeStatus} from './components/AgentRuntimeStatus';

export function ProjectContext({project,participants,agents,owner,onSaved,onMembersChanged,onManage}:{project:Project;participants:ChannelParticipant[];agents:Agent[];owner:boolean;onSaved:(project:Project)=>void;onMembersChanged:()=>Promise<void>;onManage?:()=>void}) {
  const [expanded,setExpanded]=useState(()=>window.matchMedia('(min-width:1101px)').matches);
  const dialog=useRef<HTMLDialogElement>(null);
  const [selected,setSelected]=useState<ProjectMember[]>([]),[busy,setBusy]=useState(false),[error,setError]=useState<string|null>(null);
  const people=participants.filter(p=>p.subscriberType==='HUMAN'),agentMembers=participants.filter(p=>p.subscriberType==='AGENT');
  async function invite(event:FormEvent){
    event.preventDefault();setBusy(true);setError(null);
    try{
      for(const member of selected)await apiJson(`/api/projects/${project.id}/members`,{method:'POST',headers:getApiHeaders(),body:JSON.stringify(member)});
      await onMembersChanged();setSelected([]);dialog.current?.close();
    }catch{setError('We couldn’t confirm every invitation. Retry to finish; people already added won’t be duplicated.');await onMembersChanged().catch(()=>{});}
    finally{setBusy(false);}
  }
  return <aside className="dashboard-card project-about" aria-label="Project details">
    <details className="project-context-disclosure" open={expanded} onToggle={event=>setExpanded(event.currentTarget.open)}>
      <summary>Project details <span>{people.length} {people.length===1?'person':'people'} · {agentMembers.length} {agentMembers.length===1?'agent':'agents'}</span></summary>
      <div className="project-context-body">
        <h2>About this project</h2>{owner?<ProjectSettings key={project.id} project={project} onSaved={onSaved}/>:<p className="project-prose">{project.description||'A place to work together with your team.'}</p>}
        <div className="project-context-team-heading"><h3>People & agents</h3><span>{people.length+agentMembers.length}</span></div>
        {participants.map(member=><div className="project-assignee" key={`${member.subscriberType}:${member.subscriberId}`}>{member.subscriberType==='AGENT'?<AgentAvatar name={member.subscriberId} size={32}/>:<span className="project-person-avatar" style={{width:32,height:32}} aria-hidden="true">{member.subscriberId.slice(0,2).toUpperCase()}</span>}<span><span>{member.subscriberId}</span><small>{member.subscriberType==='AGENT'?<>Agent · <AgentRuntimeStatus state={agents.find(agent=>agent.name===member.subscriberId)?.runtimeState}/></>:member.subscriberType==='HUMAN'?'Person':'Team'}</small></span></div>)}
        {owner&&<><button type="button" className="dashboard-action project-invite" onClick={()=>{setSelected([]);setError(null);dialog.current?.showModal();}}>Add people or agents</button>{onManage&&<button type="button" className="project-inline-action" onClick={onManage}>Sharing and advanced settings</button>}</>}
        {!owner&&<p className="project-muted">The project owner manages invitations.</p>}
      </div>
    </details>
    <dialog ref={dialog} className="project-settings-dialog" aria-label="Add people or agents" onCancel={event=>{if(busy)event.preventDefault();}}>
      <form className="project-form" onSubmit={invite}><h2>Add people or agents</h2><p>They’ll be able to chat and access this project’s files. Personal account permissions are unchanged.</p>
        <ProjectMemberPicker members={selected} exclude={participants.filter((p):p is ProjectMember=>p.subscriberType==='HUMAN'||p.subscriberType==='AGENT')} onChange={setSelected} disabled={busy}/>
        {error&&<p role="alert">{error}</p>}
        <div className="project-actions"><button type="button" className="dashboard-action" disabled={busy} onClick={()=>dialog.current?.close()}>Cancel</button><button className="dashboard-action project-primary" disabled={busy||!selected.length}>{busy?'Adding…':'Add to project'}</button></div>
      </form>
    </dialog>
  </aside>;
}
