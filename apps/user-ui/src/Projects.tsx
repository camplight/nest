import { useEffect, useRef, useState, type ReactNode, type FormEvent } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { Project, ProjectDetail, Task } from '@nest/schemas';
import type { Agent, EventRow } from './types';
import { apiJson, getApiHeaders } from './api';
import { AgentAvatar } from './components/AgentAvatar';
import './projects.css';

type Props = {projectId: string | null; taskId: string | null; tab: string; agents: Agent[]; onSelect: (project: string | null, task?: string | null, tab?: string) => void; onLoaded: (project: Project) => void; onMenu: () => void; chat: ReactNode; members: ReactNode};
const statusLabel: Record<Task['status'],string> = {queued:'Ready to send',working:'Awaiting deliverable',needs_review:'Needs review',changes_requested:'Changes requested',done:'Approved'};
function message(reason: unknown) {
  const text=reason instanceof Error ? reason.message : 'Unable to complete request';
  try {const value=JSON.parse(text);return typeof value.error==='string' ? value.error : text;} catch {return text;}
}
async function post<T>(path: string, value: unknown) {return apiJson<T>(path,{method:'POST',headers:getApiHeaders(),body:JSON.stringify(value)});}

export function Projects(props: Props) {
  const {projectId,taskId,onSelect,onMenu,agents,tab,onLoaded,chat,members}=props;
  const [projects,setProjects]=useState<Project[]>([]);
  const [detail,setDetail]=useState<ProjectDetail|null>(null);
  const [error,setError]=useState<string|null>(null);
  const [loading,setLoading]=useState(true);
  const [refresh,setRefresh]=useState(0);
  const [creating,setCreating]=useState(false);
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
  return <section className={`dashboard projects-page${projectId && tab === 'chat' ? ' project-chat-page' : ''}`} aria-label="Projects">
    <header className="dashboard-topbar"><button className="sidebar-mobile-toggle" onClick={onMenu}>Menu</button><button className="dashboard-action" onClick={()=>onSelect(null)}>All projects</button></header>
    <div className="dashboard-content">
      <div className="dashboard-title"><h1>{detail?.name ?? (projectId ? 'Project' : 'Projects')}</h1>{(!projectId || tab === "tasks") && <button className="dashboard-action project-create" onClick={()=>setCreating(!creating)}>{creating ? 'Cancel' : projectId ? 'New task +' : 'New project +'}</button>}</div>
      {error && <div className="notice error" role="alert">{error} <button onClick={()=>setRefresh(n=>n+1)}>Refresh</button></div>}
      {loading && <p role="status">Loading projects…</p>}
      {!projectId && <>
        {creating && <ProjectForm onCreated={p=>{onLoaded(p);onSelect(p.id);}} />}
        <div className="project-grid">{projects.map(project=><button className="dashboard-card project-summary" key={project.id} onClick={()=>onSelect(project.id)}><h2>{project.name}</h2><p>{project.description || 'Open the project to plan and review your team’s work.'}</p><span>Open project →</span></button>)}</div>
        {!loading && !error && !projects.length && <div className="dashboard-card dashboard-empty"><h2>From a brief to an approved result</h2><p>Create a project, give an agent a task, and review the deliverable against your acceptance criteria.</p></div>}
      </>}
      {detail && <>
      <nav className="project-tabs" aria-label="Project sections">{['chat','tasks','files','members'].map(section => <button key={section} aria-current={tab === section ? 'page' : undefined} onClick={() => {setCreating(false);onSelect(detail.id,null,section);}}>{section[0].toUpperCase()+section.slice(1)}</button>)}</nav>
      <div className="project-workspace"><div className="project-main">
        {tab === 'chat' && <div className="project-chat">{chat}</div>}
        {tab === 'files' && <ProjectFiles key={detail.channelId} channelId={detail.channelId} />}
        {tab === 'members' && <section className="project-members" aria-label="Project members"><p>Members can access this project’s chat and files. Task planning and reviews remain private to the project owner.</p>{members}</section>}
        {tab === 'tasks' && <>
        {creating && <TaskForm key={detail.id} project={detail} agents={agents} onCreated={task=>{setCreating(false);setDetail({...detail,tasks:[...detail.tasks,task]});onSelect(detail.id,task.id);}} />}
        <section aria-label="Project tasks"><div className="dashboard-section-title"><h2>Tasks <span className="dashboard-count">{detail.tasks.length}</span></h2></div><div className="dashboard-list">{detail.tasks.map(task=><button className="dashboard-card project-task-row" aria-current={task.id===taskId ? 'true' : undefined} key={task.id} onClick={()=>onSelect(detail.id,task.id)}><AgentAvatar name={task.agentName} size={36} /><span><strong>{task.title}</strong><small>{task.agentName} · Attempt {task.attempt}</small></span><span className="dashboard-pill">{statusLabel[task.status]}</span></button>)}</div>
          {!detail.tasks.length && <p className="project-muted">Create the first task with a clear brief and acceptance criteria.</p>}
        </section>
        {taskId && !selected && <p role="alert">Task not found in this project.</p>}
        {selected && <TaskPanel key={`${selected.id}:${selected.version}`} task={selected} detail={detail} onChanged={task=>setDetail(current=>current ? {...current,tasks:current.tasks.map(t=>t.id===task.id ? task : t)} : current)} onRefresh={()=>setRefresh(n=>n+1)} />}
      </>}
      </div><aside className="dashboard-card project-about"><h2>About</h2><p>{detail.description || 'Work together toward an approved result.'}</p><h3>Human-approved progress</h3><strong>{detail.tasks.filter(t=>t.status==='done').length} / {detail.tasks.length} tasks</strong><progress aria-label="Approved tasks" value={detail.tasks.filter(t=>t.status==='done').length} max={Math.max(detail.tasks.length,1)} /><p>{detail.tasks.filter(t=>t.status==='needs_review').length} awaiting review</p><h3>Assigned agents</h3>{[...new Set(detail.tasks.map(t=>t.agentName))].map(name=><div className="project-assignee" key={name}><AgentAvatar name={name} size={36} /><span>{name}</span></div>)}<p className="project-muted">Project records are private to you. Task briefs and responses use the project chat’s visibility.</p></aside></div></>}
    </div>
  </section>;
}

function ProjectForm({onCreated}:{onCreated:(p:Project)=>void}) {
  const [saved]=useState(() => {
    try {const value=JSON.parse(sessionStorage.getItem('nest-new-project') ?? 'null'); if(value && typeof value.id==='string' && typeof value.name==='string' && typeof value.description==='string') return value as {id:string;name:string;description:string};} catch {}
    return {id:crypto.randomUUID(),name:'',description:''};
  });
  const id=useRef(saved.id);const [busy,setBusy]=useState(false);const [error,setError]=useState<string|null>(null);
  async function submit(event:FormEvent<HTMLFormElement>) {
    event.preventDefault();const form=new FormData(event.currentTarget);setBusy(true);setError(null);
    const body={id:id.current,name:String(form.get('name') ?? ''),description:String(form.get('description') ?? '')};
    try {sessionStorage.setItem('nest-new-project',JSON.stringify(body));} catch {}
    try {const project=await post<Project>('/api/projects',body);try {sessionStorage.removeItem('nest-new-project');} catch {} onCreated(project);}
    catch(reason){setError(message(reason));}finally{setBusy(false);}
  }
  return <form className="dashboard-card project-form" onSubmit={submit}><h2>New project</h2>{error&&<p role="alert">{error}</p>}<fieldset disabled={busy}><label>Project name<input name="name" defaultValue={saved.name} required maxLength={120}/></label><label>Project brief<textarea name="description" defaultValue={saved.description} rows={3} maxLength={4000}/></label><p>A private chat is created for this project. Add your team in Members, then chat or assign a task.</p><button className="dashboard-action project-primary">{busy?'Creating…':'Create project'}</button></fieldset></form>;
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
