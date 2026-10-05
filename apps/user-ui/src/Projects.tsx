import { useEffect, useRef, useState, type FormEvent } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { Project, ProjectDetail, Task } from '@nest/schemas';
import type { Agent, Channel } from './types';
import { apiJson, getApiHeaders } from './api';
import { AgentAvatar } from './components/AgentAvatar';
import './projects.css';

type Props = {projectId: string | null; taskId: string | null; channels: Channel[]; agents: Agent[]; onSelect: (project: string | null, task?: string | null) => void; onChat: (id: string) => void; onMenu: () => void; onNewConversation: () => void};
const statusLabel: Record<Task['status'],string> = {queued:'Ready to send',working:'Awaiting deliverable',needs_review:'Needs review',changes_requested:'Changes requested',done:'Approved'};
function message(reason: unknown) {
  const text=reason instanceof Error ? reason.message : 'Unable to complete request';
  try {const value=JSON.parse(text);return typeof value.error==='string' ? value.error : text;} catch {return text;}
}
async function post<T>(path: string, value: unknown) {return apiJson<T>(path,{method:'POST',headers:getApiHeaders(),body:JSON.stringify(value)});}

export function Projects(props: Props) {
  const {projectId,taskId,onSelect,onMenu,channels,agents,onChat,onNewConversation}=props;
  const [projects,setProjects]=useState<Project[]>([]);
  const [detail,setDetail]=useState<ProjectDetail|null>(null);
  const [error,setError]=useState<string|null>(null);
  const [loading,setLoading]=useState(true);
  const [refresh,setRefresh]=useState(0);
  const [creating,setCreating]=useState(false);
  useEffect(()=>{
    const controller=new AbortController();
    setLoading(true);setError(null);setDetail(null);setCreating(false);
    const load=()=>{
      void apiJson<Project[] | ProjectDetail>(projectId ? `/api/projects/${encodeURIComponent(projectId)}` : '/api/projects',{signal:controller.signal})
        .then(value=>{if(controller.signal.aborted)return;if(projectId)setDetail(value as ProjectDetail);else setProjects(value as Project[]);setError(null);})
        .catch(reason=>{if(!controller.signal.aborted)setError(message(reason));})
        .finally(()=>{if(!controller.signal.aborted)setLoading(false);});
    };
    load();
    const interval=window.setInterval(load,10000);
    return ()=>{controller.abort();window.clearInterval(interval);};
  },[projectId,refresh]);
  const selected=detail?.tasks.find(t=>t.id===taskId);
  return <section className="dashboard projects-page" aria-label="Projects">
    <header className="dashboard-topbar"><button className="sidebar-mobile-toggle" onClick={onMenu}>Menu</button><button className="dashboard-action" onClick={()=>onSelect(null)}>All projects</button>{detail && <button className="dashboard-action" onClick={()=>onChat(detail.channelId)}>Open conversation →</button>}</header>
    <div className="dashboard-content">
      <div className="dashboard-title"><h1>{detail?.name ?? (projectId ? 'Project' : 'Projects')}</h1><button className="dashboard-action project-create" onClick={()=>setCreating(!creating)}>{creating ? 'Cancel' : projectId ? 'New task +' : 'New project +'}</button></div>
      {error && <div className="notice error" role="alert">{error} <button onClick={()=>setRefresh(n=>n+1)}>Refresh</button></div>}
      {loading && <p role="status">Loading projects…</p>}
      {!projectId && <>
        {creating && <ProjectForm channels={channels} onCreated={p=>onSelect(p.id)} onNewConversation={onNewConversation} />}
        <div className="project-grid">{projects.map(project=><button className="dashboard-card project-summary" key={project.id} onClick={()=>onSelect(project.id)}><h2>{project.name}</h2><p>{project.description || 'Open the project to plan and review your team’s work.'}</p><span>View tasks →</span></button>)}</div>
        {!loading && !error && !projects.length && <div className="dashboard-card dashboard-empty"><h2>From a brief to an approved result</h2><p>Create a project, give an agent a task, and review the deliverable against your acceptance criteria.</p></div>}
      </>}
      {detail && <div className="project-workspace"><div className="project-main">
        {creating && <TaskForm key={detail.id} project={detail} agents={agents} onCreated={task=>{setCreating(false);setDetail({...detail,tasks:[...detail.tasks,task]});onSelect(detail.id,task.id);}} />}
        <section aria-label="Project tasks"><div className="dashboard-section-title"><h2>Tasks <span className="dashboard-count">{detail.tasks.length}</span></h2></div><div className="dashboard-list">{detail.tasks.map(task=><button className="dashboard-card project-task-row" aria-current={task.id===taskId ? 'true' : undefined} key={task.id} onClick={()=>onSelect(detail.id,task.id)}><AgentAvatar name={task.agentName} size={36} /><span><strong>{task.title}</strong><small>{task.agentName} · Attempt {task.attempt}</small></span><span className="dashboard-pill">{statusLabel[task.status]}</span></button>)}</div>
          {!detail.tasks.length && <p className="project-muted">Create the first task with a clear brief and acceptance criteria.</p>}
        </section>
        {taskId && !selected && <p role="alert">Task not found in this project.</p>}
        {selected && <TaskPanel key={`${selected.id}:${selected.version}`} task={selected} detail={detail} onChanged={task=>setDetail(current=>current ? {...current,tasks:current.tasks.map(t=>t.id===task.id ? task : t)} : current)} onRefresh={()=>setRefresh(n=>n+1)} />}
      </div><aside className="dashboard-card project-about"><h2>About</h2><p>{detail.description || 'Work together toward an approved result.'}</p><h3>Human-approved progress</h3><strong>{detail.tasks.filter(t=>t.status==='done').length} / {detail.tasks.length} tasks</strong><progress aria-label="Approved tasks" value={detail.tasks.filter(t=>t.status==='done').length} max={Math.max(detail.tasks.length,1)} /><p>{detail.tasks.filter(t=>t.status==='needs_review').length} awaiting review</p><h3>Assigned agents</h3>{[...new Set(detail.tasks.map(t=>t.agentName))].map(name=><div className="project-assignee" key={name}><AgentAvatar name={name} size={36} /><span>{name}</span></div>)}<p className="project-muted">Project records are private to you. Task briefs and responses use the linked conversation’s visibility.</p></aside></div>}
    </div>
  </section>;
}

function ProjectForm({channels,onCreated,onNewConversation}:{channels:Channel[];onCreated:(p:Project)=>void;onNewConversation:()=>void}) {
  const id=useRef(crypto.randomUUID());const [busy,setBusy]=useState(false);const [error,setError]=useState<string|null>(null);
  async function submit(event:FormEvent<HTMLFormElement>) {
    event.preventDefault();const form=new FormData(event.currentTarget);setBusy(true);setError(null);
    try {onCreated(await post<Project>('/api/projects',{id:id.current,name:form.get('name'),description:form.get('description'),channelId:form.get('channelId')}));}
    catch(reason){setError(message(reason));}finally{setBusy(false);}
  }
  const options=channels.filter(c=>c.canManage&&c.canPost&&!c.archivedAt);
  return <form className="dashboard-card project-form" onSubmit={submit}><h2>New project</h2>{error&&<p role="alert">{error}</p>}<fieldset disabled={busy}><label>Project name<input name="name" required maxLength={120}/></label><label>Project brief<textarea name="description" rows={3} maxLength={4000}/></label><label>Conversation<select name="channelId" required defaultValue=""><option value="" disabled>Choose a conversation you manage</option>{options.map(c=><option key={c.id} value={c.id}>{c.name} · {c.visibility?.toLowerCase()}</option>)}</select></label><p>Task briefs will be shared with this conversation’s participants. Use a dedicated conversation to keep project work together.</p><button type="button" className="dashboard-action" onClick={onNewConversation}>Create a conversation</button><button className="dashboard-action project-primary" disabled={!options.length}>{busy?'Creating…':'Create project'}</button></fieldset></form>;
}
function TaskForm({project,agents,onCreated}:{project:Project;agents:Agent[];onCreated:(t:Task)=>void}) {
  const id=useRef(crypto.randomUUID());const [busy,setBusy]=useState(false);const [error,setError]=useState<string|null>(null);
  async function submit(event:FormEvent<HTMLFormElement>){event.preventDefault();const form=new FormData(event.currentTarget);setBusy(true);setError(null);try{onCreated(await post<Task>(`/api/projects/${project.id}/tasks`,{id:id.current,title:form.get('title'),instructions:form.get('instructions'),acceptanceCriteria:form.get('criteria'),agentName:form.get('agent')}));}catch(reason){setError(message(reason));}finally{setBusy(false);}}
  return <form className="dashboard-card project-form" onSubmit={submit}><h2>New task</h2>{error&&<p role="alert">{error}</p>}<fieldset disabled={busy}><label>Task title<input name="title" required maxLength={200}/></label><label>Brief<textarea name="instructions" required rows={4} maxLength={12000}/></label><label>Acceptance criteria<textarea name="criteria" required rows={3} maxLength={8000}/></label><label>Assign agent<select name="agent" required defaultValue=""><option value="" disabled>Choose an agent</option>{agents.map(a=><option key={a.name} value={a.name}>{a.name}</option>)}</select></label><p>Creating a task saves the brief. You’ll send it to the agent from the task page.</p><button className="dashboard-action project-primary">{busy?'Saving…':'Create task'}</button></fieldset></form>;
}
function TaskPanel({task,detail,onChanged,onRefresh}:{task:Task;detail:ProjectDetail;onChanged:(t:Task)=>void;onRefresh:()=>void}) {
  const [busy,setBusy]=useState(false);const [error,setError]=useState<string|null>(null);
  const [responses,setResponses]=useState<{id:string;text:string;createdAt:number}[]|null>(null);
  const [feedback,setFeedback]=useState('');
  const path=`/api/projects/${task.projectId}/tasks/${task.id}`;
  async function action(action:string,body:object={}) {setBusy(true);setError(null);try{const next=await post<Task>(`${path}/${action}`,{version:task.version,...body});onChanged(next);onRefresh();}catch(reason){setError(message(reason));}finally{setBusy(false);}}
  async function loadResponses(){setBusy(true);setError(null);try{setResponses(await apiJson(`${path}/responses`));}catch(reason){setError(message(reason));}finally{setBusy(false);}}
  const deliverables=detail.deliverables.filter(d=>d.taskId===task.id);
  return <section className="dashboard-card project-task-detail" aria-label="Task details"><div className="dashboard-section-title"><h2>{task.title}</h2><span className="dashboard-pill">{statusLabel[task.status]}</span></div>
    {error&&<div role="alert">{error} <button onClick={onRefresh}>Refresh task</button></div>}
    <h3>Brief</h3><p className="project-prose">{task.instructions}</p><h3>Acceptance criteria</h3><p className="project-prose">{task.acceptanceCriteria}</p>
    {task.feedback&&<><h3>Requested changes</h3><p className="project-prose">{task.feedback}</p></>}
    {['queued','changes_requested'].includes(task.status)&&<><p>The agent will join the linked conversation and receive this brief. Sending is safe to retry if the connection fails.</p><button className="dashboard-action project-primary" disabled={busy} onClick={()=>void action('dispatch')}>{busy?'Sending…':task.status==='changes_requested'?'Send revision to agent':'Send to agent'}</button></>}
    {task.status==='working'&&<><p>The brief was sent. Agent availability determines when work begins; it is not complete until you approve a deliverable.</p><button className="dashboard-action" disabled={busy} onClick={()=>void loadResponses()}>{busy?'Loading…':'Load agent responses'}</button>{responses&&<div className="project-responses"><p>Choose the response that delivers this task. Responses are from the assigned agent after this attempt was sent; verify that they match the brief.</p>{responses.map(response=><article className="dashboard-card" key={response.id}><div className="project-markdown"><ReactMarkdown remarkPlugins={[remarkGfm]}>{response.text}</ReactMarkdown></div><button className="dashboard-action" disabled={busy} onClick={()=>void action('deliverables',{eventId:response.id})}>Submit this response for review</button></article>)}{!responses.length&&<p>No responses yet. Check the conversation or try again shortly.</p>}</div>}</>}
    {deliverables.map(deliverable=><article className="project-deliverable" key={deliverable.id}><h3>Deliverable · Attempt {deliverable.attempt}</h3><div className="project-markdown"><ReactMarkdown remarkPlugins={[remarkGfm]}>{deliverable.text}</ReactMarkdown></div>{detail.reviews.filter(r=>r.deliverableId===deliverable.id).map(review=><p className="project-prose" key={review.id}><strong>{review.decision==='approve'?'Approved':'Changes requested'}</strong>{review.feedback ? ` — ${review.feedback}` : ''}</p>)}</article>)}
    {task.status==='needs_review'&&<div className="project-review"><label>Review feedback<textarea value={feedback} maxLength={8000} rows={3} onChange={e=>setFeedback(e.target.value)} disabled={busy}/></label><div className="project-actions"><button className="dashboard-action" disabled={busy||!feedback.trim()} onClick={()=>void action('reviews',{decision:'request_changes',feedback})}>Request changes</button><button className="dashboard-action project-primary" disabled={busy} onClick={()=>void action('reviews',{decision:'approve',feedback})}>Approve deliverable</button></div></div>}
    {task.status==='done'&&<p role="status">Approved by a human. This task is complete.</p>}
  </section>;
}
