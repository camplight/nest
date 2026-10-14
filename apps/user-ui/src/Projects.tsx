import {WorkspaceTopbar} from "./components/WorkspaceTopbar";
import {DesignIcon} from "./Dashboard";
import { useEffect, useRef, useState, type ReactNode, type FormEvent } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { Project, ProjectDetail, Task } from '@nest/schemas';
import type { Agent, EventRow, ChannelParticipant } from './types';
import { apiJson, getApiHeaders } from './api';
import { AgentAvatar } from './components/AgentAvatar';
import { ProjectCreateForm } from './ProjectCreateForm';
import './projects.css';

type Props = {userId:string; participants:ChannelParticipant[]; existingChats: {id:string;name:string;archived:boolean}[]; onChat:(id:string)=>void; projectId: string | null; taskId: string | null; tab: string; agents: Agent[]; onSelect: (project: string | null, task?: string | null, tab?: string) => void; onLoaded: (project: Project) => void; onMenu: () => void; chat: ReactNode; members: ReactNode};
const statusLabel: Record<Task['status'],string> = {queued:'Ready to send',working:'Awaiting deliverable',needs_review:'Needs review',changes_requested:'Changes requested',done:'Approved'};
function message(reason: unknown) {
  const text=reason instanceof Error ? reason.message : 'Unable to complete request';
  try {const value=JSON.parse(text);return typeof value.error==='string' ? value.error : text;} catch {return text;}
}
async function post<T>(path: string, value: unknown) {return apiJson<T>(path,{method:'POST',headers:getApiHeaders(),body:JSON.stringify(value)});}

export function Projects(props: Props) {
  const {projectId,taskId,onSelect,onMenu,agents,tab,onLoaded,chat,members}=props;
  const [query,setQuery]=useState("");
  const [projects,setProjects]=useState<Project[]>([]);
  const [detail,setDetail]=useState<ProjectDetail|null>(null);
  const [error,setError]=useState<string|null>(null);
  const [loading,setLoading]=useState(true);
  const [refresh,setRefresh]=useState(0);
  const [creating,setCreating]=useState(false);
  const createTrigger=useRef<HTMLButtonElement>(null);
  const createRequested = !projectId && tab === "new";
  useEffect(()=>{
    const controller=new AbortController();
    setLoading(true);setError(null);setDetail(null);setCreating(createRequested);
    const load=()=>{
      void apiJson<Project[] | ProjectDetail>(projectId ? `/api/projects/${encodeURIComponent(projectId)}` : '/api/projects',{signal:controller.signal})
        .then(value=>{if(controller.signal.aborted)return;if(projectId)setDetail(value as ProjectDetail);else setProjects(value as Project[]);setError(null);})
        .catch(reason=>{if(!controller.signal.aborted)setError(message(reason));})
        .finally(()=>{if(!controller.signal.aborted)setLoading(false);});
    };
    load();
    const interval=window.setInterval(load,10000);
    return ()=>{controller.abort();window.clearInterval(interval);};
  },[projectId,refresh,createRequested]);
  useEffect(() => { if (detail) onLoaded(detail); }, [detail?.id, detail?.channelId, onLoaded]);
  const selected=detail?.tasks.find(t=>t.id===taskId);
  const filteredProjects=projects.filter(project=>`${project.name} ${project.description}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  return <section className={`dashboard projects-page${projectId && tab === 'chat' ? ' project-chat-page' : ''}`} aria-label="Projects">
    <WorkspaceTopbar onMenu={onMenu} leading={<button className="dashboard-action" onClick={()=>onSelect(null)}>All projects</button>} search={<label className="dashboard-search"><DesignIcon name="search"/><input aria-label="Search projects" placeholder="Search…" value={query} onChange={event=>{setQuery(event.target.value);if(projectId||creating)onSelect(null);}}/></label>}/>

    <div className="dashboard-content">
      <div className="dashboard-title"><h1>{detail?.name ?? (projectId ? 'Project' : creating ? 'Create a project' : 'Projects')}</h1>{(!projectId || tab === "tasks") && (!creating || !!projectId) && <button ref={createTrigger} className="dashboard-action project-create" onClick={()=>projectId?setCreating(!creating):onSelect(null,null,'new')}>{creating ? 'Cancel' : projectId ? 'New task +' : 'New project +'}</button>}</div>
      {error && <div className="notice error" role="alert">{error} <button onClick={()=>setRefresh(n=>n+1)}>Refresh</button></div>}
      {loading && <p role="status">Loading projects…</p>}
      {!projectId && <>
        {creating && props.userId && <ProjectCreateForm key={props.userId} ownerId={props.userId} onCreated={p=>{onLoaded(p);onSelect(p.id);}} onCancel={()=>{setCreating(false);onSelect(null);requestAnimationFrame(()=>createTrigger.current?.focus());}} />}
        {!creating&&<div className="project-grid">{filteredProjects.map(project=><button className="dashboard-card project-summary" key={project.id} onClick={()=>onSelect(project.id)}><h2>{project.name}</h2><p>{project.description || 'Open the conversation and work with your team.'}</p><span>Open project →</span></button>)}</div>}
        {!creating && !loading && !error && projects.length>0 && !filteredProjects.length && <div className="dashboard-card dashboard-empty"><h2>No matching projects</h2><p>Try a different project name or description.</p></div>}
        {!loading && !error && !projects.length && !creating && <div className="dashboard-card dashboard-empty"><h2>Your next project starts here</h2><p>Name your project and choose who’s joining, then start chatting.</p></div>}
        {!creating && props.existingChats.length > 0 && <details className="project-existing-chats"><summary>Existing conversations ({props.existingChats.length})</summary><p>These conversations are not linked to a project you own. Your history and shared access are preserved.</p><div className="dashboard-list">{props.existingChats.map(channel=><button className="dashboard-card project-summary" key={channel.id} onClick={()=>props.onChat(channel.id)}>{channel.name}{channel.archived ? ' · Archived' : ''} →</button>)}</div></details>}
      </>}
      {detail && <>
      <nav className="project-tabs" aria-label="Project sections">{['chat','files','members'].map(section => <button key={section} aria-current={tab === section ? 'page' : undefined} onClick={() => {setCreating(false);onSelect(detail.id,null,section);}}>{section[0].toUpperCase()+section.slice(1)}</button>)}</nav>
      <div className="project-workspace"><div className="project-main">
        {tab === 'chat' && <div className="project-chat">{chat}</div>}
        {tab === 'files' && <ProjectFiles key={detail.channelId} channelId={detail.channelId} />}
        {tab === 'members' && <section className="project-members" aria-label="Project members"><p>People you add can chat and share files. The project owner manages invitations.</p>{members}</section>}
        {tab === 'tasks' && <>
        {creating && <TaskForm key={detail.id} project={detail} agents={agents} onCreated={task=>{setCreating(false);setDetail({...detail,tasks:[...detail.tasks,task]});onSelect(detail.id,task.id);}} />}
        <section aria-label="Project tasks"><div className="dashboard-section-title"><h2>Tasks <span className="dashboard-count">{detail.tasks.length}</span></h2></div><div className="dashboard-list">{detail.tasks.map(task=><button className="dashboard-card project-task-row" aria-current={task.id===taskId ? 'true' : undefined} key={task.id} onClick={()=>onSelect(detail.id,task.id)}><AgentAvatar name={task.agentName} size={36} /><span><strong>{task.title}</strong><small>{task.agentName} · Attempt {task.attempt}</small></span><span className="dashboard-pill">{statusLabel[task.status]}</span></button>)}</div>
          {!detail.tasks.length && <p className="project-muted">Create the first task with a clear brief and acceptance criteria.</p>}
        </section>
        {taskId && !selected && <p role="alert">Task not found in this project.</p>}
        {selected && <TaskPanel key={`${selected.id}:${selected.version}`} task={selected} detail={detail} onChanged={task=>setDetail(current=>current ? {...current,tasks:current.tasks.map(t=>t.id===task.id ? task : t)} : current)} onRefresh={()=>setRefresh(n=>n+1)} />}
      </>}
      </div><aside className="dashboard-card project-about"><h2>About</h2><p>{detail.description || 'A place to work together with your team.'}</p>
      {tab==='tasks'?<><h3>Human-approved progress</h3><strong>{detail.tasks.filter(t=>t.status==='done').length} / {detail.tasks.length} tasks</strong><progress aria-label="Approved tasks" value={detail.tasks.filter(t=>t.status==='done').length} max={Math.max(detail.tasks.length,1)} /><p>{detail.tasks.filter(t=>t.status==='needs_review').length} awaiting review</p></>:<><h3>Your team</h3>{props.participants.filter(member=>member.subscriberType==='AGENT'||member.subscriberType==='HUMAN').map(member=><div className="project-assignee" key={`${member.subscriberType}:${member.subscriberId}`}>{member.subscriberType==='AGENT'?<AgentAvatar name={member.subscriberId} size={32}/>:<span className="project-person-avatar" style={{width:32,height:32}} aria-hidden="true">{member.subscriberId.slice(0,2).toUpperCase()}</span>}<span>{member.subscriberId}</span></div>)}<p className="project-muted">Add people and agents in Members.</p></>}
      </aside></div></>}
    </div>
  </section>;
}

function ProjectFiles({channelId}:{channelId:string}) {
  const [events,setEvents]=useState<EventRow[]>([]);
  const [before,setBefore]=useState<number|null>(null);
  const [more,setMore]=useState(true);
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState<string|null>(null);
  const [refresh,setRefresh]=useState(0);
  useEffect(() => {
    const controller=new AbortController();setBusy(true);setError(null);
    apiJson<EventRow[]>(`/api/events?channelId=${encodeURIComponent(channelId)}&type=message.created&limit=100&order=desc${before === null ? '' : `&before=${before}`}`,{signal:controller.signal})
      .then(rows=>{if(!controller.signal.aborted){setEvents(current=>before===null ? rows : [...current,...rows.filter(row=>!current.some(e=>e.id===row.id))]);setMore(rows.length===100);}})
      .catch(reason=>{if(!controller.signal.aborted)setError(message(reason));})
      .finally(()=>{if(!controller.signal.aborted)setBusy(false);});
    return ()=>controller.abort();
  },[channelId,before,refresh]);
  const files=new Map<string,{fileId:string;name:string}>();
  for(const event of events) {
    const attachments=(event.payload as {attachments?:unknown})?.attachments;
    if(Array.isArray(attachments)) for(const file of attachments) if(file && typeof file.fileId==='string' && typeof file.name==='string') files.set(file.fileId,file);
  }
  return <section className="dashboard-card project-form" aria-label="Project files"><h2>Files shared in chat</h2><p>Upload files using Attach files in Chat. Browse older messages below to find earlier uploads.</p>{error&&<p role="alert">{error} <button onClick={()=>setRefresh(n=>n+1)}>Retry</button></p>}{busy&&<p role="status">Loading files…</p>}<ul className="project-file-list">{[...files.values()].map(file=><li key={file.fileId}><a href={`/api/files/${encodeURIComponent(file.fileId)}`} target="_blank" rel="noreferrer">{file.name} ↗</a></li>)}</ul>{!busy&&!error&&!files.size&&<p>No files in the messages loaded so far.</p>}{more&&events.length>0&&<button className="dashboard-action" disabled={busy} onClick={()=>setBefore(Math.min(...events.map(event=>event.createdAt ?? 0)))}>Load older files</button>}</section>;
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
    {['queued','changes_requested'].includes(task.status)&&<><p>The agent will join the project chat and receive this brief. Sending is safe to retry if the connection fails.</p><button className="dashboard-action project-primary" disabled={busy} onClick={()=>void action('dispatch')}>{busy?'Sending…':task.status==='changes_requested'?'Send revision to agent':'Send to agent'}</button></>}
    {task.status==='working'&&<><p>The brief was sent. Agent availability determines when work begins; it is not complete until you approve a deliverable.</p><button className="dashboard-action" disabled={busy} onClick={()=>void loadResponses()}>{busy?'Loading…':'Load agent responses'}</button>{responses&&<div className="project-responses"><p>Choose the response that delivers this task. Responses are from the assigned agent after this attempt was sent; verify that they match the brief.</p>{responses.map(response=><article className="dashboard-card" key={response.id}><div className="project-markdown"><ReactMarkdown remarkPlugins={[remarkGfm]}>{response.text}</ReactMarkdown></div><button className="dashboard-action" disabled={busy} onClick={()=>void action('deliverables',{eventId:response.id})}>Submit this response for review</button></article>)}{!responses.length&&<p>No responses yet. Check Chat or try again shortly.</p>}</div>}</>}
    {deliverables.map(deliverable=><article className="project-deliverable" key={deliverable.id}><h3>Deliverable · Attempt {deliverable.attempt}</h3><div className="project-markdown"><ReactMarkdown remarkPlugins={[remarkGfm]}>{deliverable.text}</ReactMarkdown></div>{detail.reviews.filter(r=>r.deliverableId===deliverable.id).map(review=><p className="project-prose" key={review.id}><strong>{review.decision==='approve'?'Approved':'Changes requested'}</strong>{review.feedback ? ` — ${review.feedback}` : ''}</p>)}</article>)}
    {task.status==='needs_review'&&<div className="project-review"><label>Review feedback<textarea value={feedback} maxLength={8000} rows={3} onChange={e=>setFeedback(e.target.value)} disabled={busy}/></label><div className="project-actions"><button className="dashboard-action" disabled={busy||!feedback.trim()} onClick={()=>void action('reviews',{decision:'request_changes',feedback})}>Request changes</button><button className="dashboard-action project-primary" disabled={busy} onClick={()=>void action('reviews',{decision:'approve',feedback})}>Approve deliverable</button></div></div>}
    {task.status==='done'&&<p role="status">Approved by a human. This task is complete.</p>}
  </section>;
}
