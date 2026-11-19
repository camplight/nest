import {ProjectBrief} from './ProjectBrief';
import {useRef,useState,type FormEvent,type MouseEvent} from 'react';
import type {Project,ProjectMember} from '@nest/schemas';
import type {Agent,ChannelParticipant} from './types';
import {apiJson,getApiHeaders} from './api';
import {ProjectSettings} from './ProjectSettings';
import {ProjectMemberPicker} from './components/ProjectMemberPicker';
import {AgentAvatar} from './components/AgentAvatar';
import {AgentRuntimeStatus} from './components/AgentRuntimeStatus';


export function ProjectContext({project,participants,agents,owner,viewer,onSaved,onMembersChanged,onOpenAgent}:{project:Project;participants:ChannelParticipant[];agents:Agent[];owner:boolean;viewer?:string;onSaved:(project:Project)=>void;onMembersChanged:()=>Promise<void>;onOpenAgent?:(name:string)=>void}) {
  const [expanded,setExpanded]=useState(()=>window.matchMedia('(min-width:1101px)').matches);
  const dialog=useRef<HTMLDialogElement>(null);
  const [selected,setSelected]=useState<ProjectMember[]>([]),[busy,setBusy]=useState(false),[error,setError]=useState<string|null>(null);
  const people=participants.filter(p=>p.subscriberType==='HUMAN'),agentMembers=participants.filter(p=>p.subscriberType==='AGENT');
  // The owner removes people and agents (never themselves) after an inline confirmation in the member's row.
  const [removing,setRemoving]=useState<string|null>(null),[removeBusy,setRemoveBusy]=useState(false),[removeError,setRemoveError]=useState<string|null>(null);
  const memberKey=(member:ChannelParticipant)=>`${member.subscriberType}:${member.subscriberId}`;
  const removable=(member:ChannelParticipant)=>owner&&(member.subscriberType==='HUMAN'||member.subscriberType==='AGENT')&&!(member.subscriberType==='HUMAN'&&member.subscriberId===viewer);
  async function remove(member:ChannelParticipant){
    setRemoveBusy(true);setRemoveError(null);
    try{
      await apiJson(`/api/projects/${project.id}/members`,{method:'DELETE',headers:getApiHeaders(),body:JSON.stringify({subscriberType:member.subscriberType,subscriberId:member.subscriberId})});
      await onMembersChanged();setRemoving(null);
    }catch{setRemoveError(`We couldn’t confirm ${member.subscriberId} was removed. Try again.`);await onMembersChanged().catch(()=>{});}
    finally{setRemoveBusy(false);}
  }
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
        <h2>About this project</h2>{owner?<ProjectSettings key={project.id} project={project} onSaved={onSaved}/>:<ProjectBrief text={project.description||'A place to work together with your team.'}/>}
        <div className="project-context-team-heading"><h3>People & agents</h3><span>{people.length+agentMembers.length}</span></div>
        {participants.map(member=>{
          // An agent the person can open links (avatar and name) to its settings; a plain left-click stays in the app.
          const opens=member.subscriberType==='AGENT'&&onOpenAgent&&agents.some(agent=>agent.name===member.subscriberId);
          const href=`/?view=agents&agent=${encodeURIComponent(member.subscriberId)}&tab=settings`;
          const open=(event:MouseEvent<HTMLAnchorElement>)=>{if(event.button!==0||event.metaKey||event.ctrlKey||event.shiftKey||event.altKey)return;event.preventDefault();onOpenAgent?.(member.subscriberId);};
          const avatar=member.subscriberType==='AGENT'?<AgentAvatar name={member.subscriberId} size={32}/>:<span className="project-person-avatar" style={{width:32,height:32}} aria-hidden="true">{member.subscriberId.slice(0,2).toUpperCase()}</span>;
          if(removing===memberKey(member))return <div role="group" aria-label={`Remove ${member.subscriberId}?`} className="project-assignee project-member-remove-confirm" key={memberKey(member)}>
            <p>{member.subscriberId} loses access to this chat and its files.</p>
            {removeError&&<p role="alert">{removeError}</p>}
            <div className="project-actions"><button type="button" className="dashboard-action" disabled={removeBusy} onClick={()=>{setRemoving(null);setRemoveError(null);}}>Cancel</button><button type="button" className="dashboard-action project-danger" disabled={removeBusy} onClick={()=>void remove(member)}>{removeBusy?'Removing…':'Remove'}</button></div>
          </div>;
          return <div className="project-assignee" key={memberKey(member)}>{opens
          // The name is the link keyboards and screen readers use; the avatar is the same target for the mouse only.
          ?<a className="project-assignee-avatar-link" href={href} onClick={open} tabIndex={-1} aria-hidden="true">{avatar}</a>:avatar}<span>{opens
          ?<a className="project-assignee-link" href={href} onClick={open}>{member.subscriberId}</a>
          :<span>{member.subscriberId}</span>}<small>{member.subscriberType==='AGENT'?<>Agent · <AgentRuntimeStatus state={agents.find(agent=>agent.name===member.subscriberId)?.runtimeState}/></>:member.subscriberType==='HUMAN'?'Person':'Team'}</small></span>{removable(member)&&<button type="button" className="project-member-remove" aria-label={`Remove ${member.subscriberId} from this project`} title={`Remove ${member.subscriberId}`} disabled={removeBusy} onClick={()=>{setRemoving(memberKey(member));setRemoveError(null);}}><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg></button>}</div>;})}
        {owner&&<><button type="button" className="dashboard-action project-invite" onClick={()=>{setSelected([]);setError(null);dialog.current?.showModal();}}>Add people or agents</button></>}
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
