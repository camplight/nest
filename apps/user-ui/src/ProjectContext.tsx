import {ProjectBrief} from './ProjectBrief';
import {useCallback,useEffect,useRef,useState,type FormEvent} from 'react';
import type {Project,ProjectAccessNotification,ProjectMember} from '@nest/schemas';
import type {Agent,ChannelParticipant} from './types';
import {apiJson,getApiHeaders} from './api';
import {decideProjectAccess,loadProjectAccessRequests,revokeProjectMember} from './project-access';
import {ProjectSettings} from './ProjectSettings';
import {ProjectMemberPicker} from './components/ProjectMemberPicker';
import {ProjectAccessRequestList} from './components/ProjectAccessRequestList';
import {AgentAvatar} from './components/AgentAvatar';
import {AgentRuntimeStatus} from './components/AgentRuntimeStatus';

export function ProjectContext({project,participants,agents,owner,ownerUsername,onSaved,onMembersChanged}:{project:Project;participants:ChannelParticipant[];agents:Agent[];owner:boolean;ownerUsername:string;onSaved:(project:Project)=>void;onMembersChanged:()=>Promise<void>}) {
  const [expanded,setExpanded]=useState(()=>window.matchMedia('(min-width:1101px)').matches);
  const dialog=useRef<HTMLDialogElement>(null);
  const [selected,setSelected]=useState<ProjectMember[]>([]),[busy,setBusy]=useState(false),[error,setError]=useState<string|null>(null);
  const [requests,setRequests]=useState<ProjectAccessNotification[]>([]),[accessBusy,setAccessBusy]=useState<string|null>(null),[memberBusy,setMemberBusy]=useState<string|null>(null),[accessError,setAccessError]=useState<string|null>(null);
  const people=participants.filter(p=>p.subscriberType==='HUMAN'),agentMembers=participants.filter(p=>p.subscriberType==='AGENT');

  const loadRequests=useCallback(async(signal?:AbortSignal)=>{
    if(!owner){setRequests([]);return;}
    const items=await loadProjectAccessRequests(signal);
    if(!signal?.aborted){setRequests(items.filter(item=>item.projectId===project.id));setAccessError(null);}
  },[owner,project.id]);

  useEffect(()=>{
    if(!owner){setRequests([]);return;}
    const controller=new AbortController();
    void loadRequests(controller.signal).catch(()=>{if(!controller.signal.aborted)setAccessError('Could not load project access requests.');});
    return()=>controller.abort();
  },[loadRequests,owner]);

  async function invite(event:FormEvent){
    event.preventDefault();setBusy(true);setError(null);
    try{
      for(const member of selected)await apiJson(`/api/projects/${project.id}/members`,{method:'POST',headers:getApiHeaders(),body:JSON.stringify(member)});
      await onMembersChanged();setSelected([]);dialog.current?.close();
    }catch{setError('We couldn’t confirm every invitation. Retry to finish; people already added won’t be duplicated.');await onMembersChanged().catch(()=>{});}
    finally{setBusy(false);}
  }

  async function decide(item:ProjectAccessNotification,decision:'approve'|'deny'){
    setAccessBusy(item.id);setAccessError(null);
    try{await decideProjectAccess(item.projectId,item.id,decision);await Promise.all([loadRequests(),onMembersChanged()]);}
    catch{setAccessError(`Could not ${decision} this request. Retry safely.`);}
    finally{setAccessBusy(null);}
  }

  async function remove(username:string){
    if(!window.confirm(`Remove ${username} from this project? They will immediately lose project chat and file access. They can request access again later.`))return;
    setMemberBusy(username);setAccessError(null);
    try{await revokeProjectMember(project.id,username);await Promise.all([onMembersChanged(),loadRequests()]);}
    catch{setAccessError(`Could not confirm removal of ${username}. Retry safely.`);}
    finally{setMemberBusy(null);}
  }

  return <aside className="dashboard-card project-about" aria-label="Project details">
    <details className="project-context-disclosure" open={expanded} onToggle={event=>setExpanded(event.currentTarget.open)}>
      <summary>Project details <span>{people.length} {people.length===1?'person':'people'} · {agentMembers.length} {agentMembers.length===1?'agent':'agents'}</span></summary>
      <div className="project-context-body">
        <h2>About this project</h2>{owner?<ProjectSettings key={project.id} project={project} onSaved={onSaved}/>:<ProjectBrief text={project.description||'A place to work together with your team.'}/>}
        {owner&&requests.length>0&&<section className="project-access-pending" aria-labelledby="project-access-pending-heading"><h3 id="project-access-pending-heading">Pending access requests</h3><ProjectAccessRequestList items={requests} busyId={accessBusy} onApprove={item=>void decide(item,'approve')} onDeny={item=>void decide(item,'deny')}/></section>}
        {owner&&accessError&&<p role="alert">{accessError} <button className="project-inline-action" onClick={()=>void loadRequests()}>Retry</button></p>}
        <div className="project-context-team-heading"><h3>People & agents</h3><span>{people.length+agentMembers.length}</span></div>
        {participants.map(member=><div className="project-assignee" key={`${member.subscriberType}:${member.subscriberId}`}>
          {member.subscriberType==='AGENT'?<AgentAvatar name={member.subscriberId} size={32}/>:<span className="project-person-avatar" style={{width:32,height:32}} aria-hidden="true">{member.subscriberId.slice(0,2).toUpperCase()}</span>}
          <span><span>{member.subscriberId}</span><small>{member.subscriberType==='AGENT'?<>Agent · <AgentRuntimeStatus state={agents.find(agent=>agent.name===member.subscriberId)?.runtimeState}/></>:member.subscriberType==='HUMAN'?'Person':'Team'}</small></span>
          {owner&&member.subscriberType==='HUMAN'&&member.subscriberId!==ownerUsername&&<button type="button" className="project-inline-action project-remove-access" aria-label={`Remove access for ${member.subscriberId}`} disabled={memberBusy!==null} onClick={()=>void remove(member.subscriberId)}>{memberBusy===member.subscriberId?'Removing…':'Remove access'}</button>}
        </div>)}
        {owner&&<button type="button" className="dashboard-action project-invite" onClick={()=>{setSelected([]);setError(null);dialog.current?.showModal();}}>Add people or agents</button>}
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
