import {generateProjectDetails,type ProjectNamer} from './project-naming';
import {PROJECT_KICKOFF_GUIDANCE} from './project-guidance';
import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { bodyLimit } from 'hono/body-limit';
import type { ProductDb } from '@nest/db';
import type { Human, OrgOpsClient } from '@nest/orgops-client';
import { ProjectMemberSchema, NewProjectSchema, ProjectSettingsSchema, ProjectNamingSchema, NewTaskSchema, TaskActionSchema, SubmitDeliverableSchema, ReviewSchema, type Task, type Project, type ProjectDashboard, type DashboardTask, type ProjectMemberOption } from '@nest/schemas';

type Channel = {id: string; canManage: boolean; canPost: boolean; archivedAt?: number | null; ownerHumanId?: string; participants?:{subscriberType:string;subscriberId:string}[]; metadata?: {nestProjectChat?: string}};
type EngineEvent = {id: string; type: string; source: string; channelId: string; createdAt: number; payload?: {text?: unknown; nestTaskId?: unknown; nestTaskAttempt?: unknown; targetAgentName?: unknown}; idempotencyKey?: string};
export function registerProjectRoutes(app: Hono, {store, orgops, namingModelId, namingEnv, namer=generateProjectDetails}: {store: ProductDb; orgops: OrgOpsClient; namingModelId?:string; namingEnv?:(model:string)=>Promise<Record<string,string|undefined>>; namer?:ProjectNamer}) {
  const routes = new Hono<{Variables: {human: Human; channels: Channel[]}}>();
  const db = store.projects;
  routes.onError((error, c) => {
    if (error instanceof HTTPException) return c.json({error: error.message}, error.status);
    console.error('Project request failed:', error.name);
    return c.json({error:'The engine is unavailable. Existing project records are retained; refresh and retry.'},502);
  });
  routes.use('/api/projects/*', bodyLimit({maxSize:64_000,onError:c=>c.json({error:'Request too large'},413)}));
  routes.use('/api/projects/*', async (c, next) => {
    const human = await orgops.currentHuman(c.req.raw.headers);
    if (!human) return c.json({error:'Unauthorized'},401);
    if (human.mustChangePassword) return c.json({error:'Complete password setup first'},403);
    c.set('human',human);
    c.set('channels',await orgops.humanJson<Channel[]>('/api/channels',c.req.raw.headers));
    c.header('Cache-Control','no-store');
    await next();
  });
  function available(channels: Channel[], id: string) { return channels.some(c=>c.id===id && c.canManage && c.canPost && !c.archivedAt); }
  function canView(project:Project,human:Human,channels:Channel[]) {
    if(project.ownerId===human.id)return available(channels,project.channelId);
    return project.collaboration==='team'&&channels.some(channel=>channel.id===project.channelId&&channel.canPost&&!channel.archivedAt&&channel.participants?.some(member=>member.subscriberType==='HUMAN'&&member.subscriberId===human.username));
  }
  function visibleProjects(human:Human,channels:Channel[]) {
    const teamChannels=channels.filter(channel=>channel.canPost&&!channel.archivedAt&&channel.participants?.some(member=>member.subscriberType==='HUMAN'&&member.subscriberId===human.username)).map(channel=>channel.id);
    return db.projects(human.id,teamChannels).filter(project=>canView(project,human,channels));
  }
  function owned(id: string, human: Human, channels: Channel[]): Project {
    const value = db.project(id);
    if (!value || value.ownerId !== human.id || !available(channels,value.channelId)) throw new HTTPException(404,{message:'Project unavailable or conversation access has changed'});
    return value;
  }
  function taskFor(project: Project, id: string) {
    const task = db.task(id);
    if (!task || task.projectId !== project.id) throw new HTTPException(404,{message:'Task not found'});
    return task;
  }
  function parse<T>(schema: {safeParse(value: unknown): {success: true; data: T} | {success: false; error: {issues: {message: string}[]}}}, value: unknown): T {
    const result = schema.safeParse(value);
    if (!result.success) throw new HTTPException(400,{message:result.error.issues.map(i=>i.message).join('; ')});
    return result.data;
  }
  function current(task: Task, version: number) {
    if (task.version !== version) throw new HTTPException(409,{message:'This task changed. Refresh before trying again.'});
  }
  function update(task: Task, patch: Partial<Task>, actor: string, extra?: Parameters<typeof db.changeTask>[3]) {
    const next = {...task,...patch,version:task.version+1,updatedAt:Date.now()};
    if (!db.changeTask(task,next,actor,extra)) throw new HTTPException(409,{message:'This task changed. Refresh before trying again.'});
    return next;
  }
  function candidate(event: EngineEvent, project: Project, task: Task) {
    return event.type==='message.created' && event.source===`agent:${task.agentName}` && event.channelId===project.channelId &&
      task.dispatchedAt !== null && event.createdAt>task.dispatchedAt && typeof event.payload?.text==='string' && event.payload.text.trim().length>0;
  }
  routes.get('/api/projects', c => c.json(visibleProjects(c.get('human'),c.get('channels'))));
  async function memberOptions(headers:HeadersInit,human:Human):Promise<ProjectMemberOption[]> {
    const [humans,agents]=await Promise.all([
      orgops.humanJson<{username:string}[]>('/api/humans',headers),
      orgops.humanJson<{name:string;description?:string;visibility?:string;ownerHumanId?:string|null}[]>('/api/agents',headers),
    ]);
    return [
      ...humans.filter(person=>person.username!==human.username).map(person=>({subscriberType:'HUMAN' as const,subscriberId:person.username})),
      ...agents.filter(agent=>agent.visibility==='PUBLIC'||agent.ownerHumanId===human.id).map(agent=>({subscriberType:'AGENT' as const,subscriberId:agent.name,description:agent.description})),
    ];
  }
  routes.get('/api/projects/members',async c=>{
    const human=c.get('human'),headers=c.req.raw.headers;
    const members=await memberOptions(headers,human);
    const mapping=store.db.prepare('SELECT name,agent_id FROM product_personal_agents WHERE owner_id=?').get(human.id) as {name:string;agent_id:string|null}|undefined;
    let personalAgent:ProjectMemberOption|null=null;
    if(mapping?.agent_id&&members.some(m=>m.subscriberType==='AGENT'&&m.subscriberId===mapping.name)){
      const response=await orgops.humanRequest(`/api/agents/${encodeURIComponent(mapping.name)}`,headers);
      if(response.ok){const agent=await response.json() as {id:string;visibility:string;ownerHumanId:string;mode:string};
        if(agent.id===mapping.agent_id&&agent.ownerHumanId===human.id&&agent.visibility==='PRIVATE'&&(agent.mode==='CLASSIC'||agent.mode==='RLM'))personalAgent=members.find(m=>m.subscriberType==='AGENT'&&m.subscriberId===mapping.name)!;
      }else if(response.status!==404&&response.status!==403)throw Error('Engine unavailable');
    }
    return c.json({members,personalAgent});
  });
  routes.get('/api/projects/dashboard', c => {
    const visible = visibleProjects(c.get('human'),c.get('channels'));
    const summary: ProjectDashboard = {projects:[],tasks:{total:0,finished:0,needsReview:0,changesRequested:0},reviews:[],changes:[]};
    for (const project of visible) {
      const tasks = db.tasks(project.id);
      const finishedTasks = tasks.filter(t=>t.status==='done').length;
      const needsReview = tasks.filter(t=>t.status==='needs_review').length;
      const changesRequested = tasks.filter(t=>t.status==='changes_requested').length;
      summary.projects.push({project,totalTasks:tasks.length,finishedTasks,needsReview,changesRequested,workingTasks:tasks.filter(t=>t.status==='working').length,assignedAgents:new Set(tasks.map(t=>t.agentName)).size});
      summary.tasks.total+=tasks.length; summary.tasks.finished+=finishedTasks;
      summary.tasks.needsReview+=needsReview; summary.tasks.changesRequested+=changesRequested;
      for (const task of tasks) {
        const item: DashboardTask = {id:task.id,projectId:project.id,title:task.title,agentName:task.agentName,updatedAt:task.updatedAt,status:task.status};
        if (task.status==='needs_review') summary.reviews.push(item);
        if (task.status==='changes_requested') summary.changes.push(item);
      }
    }
    summary.reviews.sort((a,b)=>b.updatedAt-a.updatedAt || a.id.localeCompare(b.id));
    summary.changes.sort((a,b)=>b.updatedAt-a.updatedAt || a.id.localeCompare(b.id));
    return c.json(summary);
  });
  routes.post('/api/projects', async c => {
    const body = parse(NewProjectSchema,await c.req.json().catch(()=>null));
    const human=c.get('human');
    const members=[...new Map(body.members.filter(member=>member.subscriberType!=='HUMAN'||member.subscriberId!==human.username).map(member=>[`${member.subscriberType}:${member.subscriberId}`,member])).values()]
      .sort((a,b)=>a.subscriberType.localeCompare(b.subscriberType)||a.subscriberId.localeCompare(b.subscriberId));
    // Keep empty-member reservations byte-compatible with older creation retries.
    const request=JSON.stringify({name:body.name,description:body.description,channelId:body.channelId ?? null,...(members.length?{members}:{}),...(body.collaboration==='team'?{collaboration:'team'}:{})});
    const existing=db.project(body.id);
    if (existing) {
      if(existing.ownerId!==human.id)return c.json({error:'Project ID already used'},409);
      const reserved=store.db.prepare('SELECT request_json FROM product_project_chats WHERE project_id=?').get(body.id) as {request_json:string}|undefined;
      // Editable metadata must not change the identity of a completed creation.
      if(reserved ? reserved.request_json!==request : existing.name!==body.name||existing.description!==body.description||(body.channelId&&existing.channelId!==body.channelId)||(existing.collaboration??'private')!==body.collaboration||members.length>0)return c.json({error:'Project ID already used'},409);
      owned(body.id,human,c.get('channels'));
      return c.json(existing);
    }
    if(members.length){
      const options=await memberOptions(c.req.raw.headers,human);
      if(members.some(member=>!options.some(option=>option.subscriberType===member.subscriberType&&option.subscriberId===member.subscriberId)))
        return c.json({error:'Someone selected is no longer available. Check your team and try again.',canEdit:!store.db.prepare('SELECT 1 FROM product_project_chats WHERE project_id=?').get(body.id)},400);
      // Engine detail reads enforce current visibility before any invitation writes.
      const selectedAgents=await Promise.all(members.filter(member=>member.subscriberType==='AGENT').map(member=>orgops.humanJson<{visibility:string;ownerHumanId:string|null}>(`/api/agents/${encodeURIComponent(member.subscriberId)}`,c.req.raw.headers)));
      if(selectedAgents.some(agent=>agent.visibility!=='PUBLIC'&&agent.ownerHumanId!==human.id))return c.json({error:'An agent’s access has changed. Check your team and try again.',canEdit:!store.db.prepare('SELECT 1 FROM product_project_chats WHERE project_id=?').get(body.id)},403);
    }
    let channelId=body.channelId;
    if (channelId && !available(c.get('channels'),channelId)) return c.json({error:'Choose an active chat you can manage'},403);
    // A durable reservation survives a lost response/restart. The private engine
    // channel carries a random recovery marker; names are never used as identity.
    const marker=randomUUID();
    const claimed=store.db.prepare('INSERT OR IGNORE INTO product_project_chats VALUES (?,?,?,?)').run(body.id,human.id,request,marker).changes;
    const reservation=store.db.prepare('SELECT owner_id,request_json,marker FROM product_project_chats WHERE project_id=?').get(body.id) as {owner_id:string;request_json:string;marker:string};
    if (reservation.owner_id!==human.id || reservation.request_json!==request) return c.json({error:'Project ID already used'},409);
    if (!channelId) {
      if (claimed) {
        const created=await orgops.humanJson<{id:string}>('/api/channels',c.req.raw.headers,{
          name:`nest-project-${reservation.marker}`,description:body.description,visibility:'PRIVATE',metadata:{nestProjectChat:marker,nestKickoffGuidance:PROJECT_KICKOFF_GUIDANCE},
        });
        channelId=created.id;
      } else {
        const channels=await orgops.humanJson<Channel[]>('/api/channels',c.req.raw.headers);
        channelId=channels.find(channel=>channel.ownerHumanId===human.id && channel.metadata?.nestProjectChat===reservation.marker && available(channels,channel.id))?.id;
        if (!channelId) return c.json({error:'Chat creation is still unconfirmed. Refresh and retry; Nest will not create a duplicate chat.'},409);
      }
    }
    // Idempotent subscriptions let a retry finish partial setup after a lost
    // response or restart. Never publish a completed project before its team joins.
    if(members.length){
      const channels=await orgops.humanJson<Channel[]>('/api/channels',c.req.raw.headers);
      const channel=channels.find(channel=>channel.id===channelId);
      if(!channel||!available(channels,channel.id))return c.json({error:'Project conversation access has changed'},403);
      for(const member of members){
        if(!channel.participants?.some(current=>current.subscriberType===member.subscriberType&&current.subscriberId===member.subscriberId))
          await orgops.humanJson(`/api/channels/${encodeURIComponent(channelId!)}/subscribe`,c.req.raw.headers,member);
      }
    }
    // Another retry may have finished while this request awaited the engine.
    const completed=db.project(body.id);
    if (completed) return c.json(completed);
    return c.json(db.createProject({id:body.id,name:body.name,description:body.description,channelId,ownerId:human.id,createdAt:Date.now(),collaboration:body.collaboration}),201);
  });
  routes.get('/api/projects/:projectId', c => {
    const project=db.project(c.req.param('projectId'));
    if(!project||!canView(project,c.get('human'),c.get('channels')))throw new HTTPException(404,{message:'Project unavailable or conversation access has changed'});
    return c.json(db.detail(project));
  });
  routes.post('/api/projects/:projectId/members',async c=>{
    const human=c.get('human'),headers=c.req.raw.headers;
    const project=owned(c.req.param('projectId'),human,c.get('channels'));
    const member=parse(ProjectMemberSchema,await c.req.json().catch(()=>null));
    const options=await memberOptions(headers,human);
    if(member.subscriberType==='HUMAN'&&member.subscriberId===human.username)return c.json({status:'joined'});
    if(!options.some(m=>m.subscriberType===member.subscriberType&&m.subscriberId===member.subscriberId))return c.json({error:'This teammate is no longer available'},400);
    if(member.subscriberType==='AGENT'){
      const agent=await orgops.humanJson<{visibility:string;ownerHumanId:string|null}>(`/api/agents/${encodeURIComponent(member.subscriberId)}`,headers);
      if(agent.visibility!=='PUBLIC'&&agent.ownerHumanId!==human.id)return c.json({error:'Agent access changed'},403);
    }
    const channels=await orgops.humanJson<Channel[]>('/api/channels',headers);owned(project.id,human,channels);
    const present=(list:Channel[])=>list.find(ch=>ch.id===project.channelId)?.participants?.some(m=>m.subscriberType===member.subscriberType&&m.subscriberId===member.subscriberId);
    if(!present(channels)){
      try{await orgops.humanJson(`/api/channels/${encodeURIComponent(project.channelId)}/subscribe`,headers,member);}catch{/* Reconcile an uncertain subscription before reporting failure. */}
      const confirmed=await orgops.humanJson<Channel[]>('/api/channels',headers);owned(project.id,human,confirmed);
      if(!present(confirmed))return c.json({error:'Invitation is unconfirmed. Retry to finish safely.'},502);
      store.db.prepare('INSERT INTO product_audit(type,actor_id,payload_json,created_at) VALUES(?,?,?,?)').run('audit.project.member.added',human.id,JSON.stringify({projectId:project.id,...member}),Date.now());
    }
    return c.json({status:'joined'});
  });
  const naming=new Set<string>();
  routes.post('/api/projects/:projectId/suggest-details',async c=>{
    const human=c.get('human');const project=owned(c.req.param('projectId'),human,c.get('channels'));
    const body=parse(ProjectNamingSchema,await c.req.json().catch(()=>null));
    if(!db.openingMessage(project,body.messageRequestId))return c.json({error:'A confirmed opening message from this project owner is required'},400);
    if(!db.canNameProject(project.id)||project.name!==body.expected.name||project.description!==body.expected.description)return c.json({status:'kept'});
    if(!namingModelId)return c.json({status:'unavailable'});
    if(naming.has(project.id))return c.json({status:'pending'},202);
    naming.add(project.id);
    try{
      const model=await orgops.nativeModelReference(namingModelId,c.req.raw.headers);
      if(!model)return c.json({status:'unavailable'});
      const receipt=db.openingMessage(project,body.messageRequestId)!;
      const event=await orgops.humanJson<{id:string;channelId:string;source:string;type:string;payload:{text?:unknown}}>(`/api/events/${encodeURIComponent(receipt.eventId)}`,c.req.raw.headers);
      if(event.id!==receipt.eventId||event.channelId!==project.channelId||event.source!==`human:${human.username}`||event.type!=='message.created'||typeof event.payload.text!=='string')return c.json({status:'unavailable'});
      const env=await namingEnv?.(model);
      const proposed=await namer({text:event.payload.text,model,env});
      const details=parse(NewProjectSchema.pick({name:true,description:true}),proposed);
      const freshHuman=await orgops.currentHuman(c.req.raw.headers);
      if(!freshHuman||freshHuman.id!==human.id||freshHuman.mustChangePassword)return c.json({status:'kept'});
      const channels=await orgops.humanJson<Channel[]>('/api/channels',c.req.raw.headers);owned(project.id,freshHuman,channels);
      const updated=db.updateProject(project.id,human.id,details,body.expected,'ai');
      return c.json({status:updated?'named':'kept'});
    }catch{return c.json({status:'unavailable'});}finally{naming.delete(project.id);}
  });
  routes.patch('/api/projects/:projectId',async c=>{
    const project=owned(c.req.param('projectId'),c.get('human'),c.get('channels'));
    const body=parse(ProjectSettingsSchema,await c.req.json().catch(()=>null));
    const updated=db.updateProject(project.id,c.get('human').id,{name:body.name,description:body.description},body.expected);
    if(!updated)return c.json({error:'Project details changed. Reopen settings to load the latest version.'},409);
    return c.json(updated);
  });
  routes.post('/api/projects/:projectId/tasks', async c => {
    const project=owned(c.req.param('projectId'),c.get('human'),c.get('channels'));
    const body=parse(NewTaskSchema,await c.req.json().catch(()=>null));
    const agents=await orgops.humanJson<{name:string}[]>('/api/agents',c.req.raw.headers);
    if (!agents.some(a=>a.name===body.agentName)) return c.json({error:'Agent not available'},400);
    // GET enforces engine visibility (the engine list can contain more records).
    await orgops.humanJson(`/api/agents/${encodeURIComponent(body.agentName)}`,c.req.raw.headers);
    const existing=db.task(body.id);
    if (existing) {
      if (existing.projectId!==project.id || ['title','instructions','acceptanceCriteria','agentName'].some(key=>existing[key as keyof Task]!==body[key as keyof typeof body])) return c.json({error:'Task ID already used'},409);
      return c.json(existing);
    }
    const now=Date.now();
    return c.json(db.createTask({...body,projectId:project.id,version:0,status:'queued',attempt:1,dispatchEventId:null,dispatchedAt:null,feedback:'',deliverableId:null,createdAt:now,updatedAt:now},c.get('human').id),201);
  });
  routes.post('/api/projects/:projectId/tasks/:taskId/dispatch', async c => {
    const project=owned(c.req.param('projectId'),c.get('human'),c.get('channels'));
    const task=taskFor(project,c.req.param('taskId'));
    const body=parse(TaskActionSchema,await c.req.json().catch(()=>null));
    current(task,body.version);
    if (!['queued','changes_requested'].includes(task.status)) return c.json({error:'Only queued tasks or requested revisions can be sent'},409);
    const headers=c.req.raw.headers;
    await orgops.humanJson(`/api/agents/${encodeURIComponent(task.agentName)}`,headers);
    await orgops.humanJson(`/api/channels/${encodeURIComponent(project.channelId)}/subscribe`,headers,{subscriberType:'AGENT',subscriberId:task.agentName});
    const event=await orgops.humanJson<EngineEvent>('/api/events',headers,{
      type:'message.created', source:`human:${c.get('human').username}`, channelId:project.channelId, idempotencyKey:`nest:task:${task.id}:attempt:${task.attempt}`,
      payload:{targetAgentName:task.agentName,nestTaskId:task.id,nestTaskAttempt:task.attempt,text:[
        `Nest task ${task.id} — attempt ${task.attempt}: ${task.title}`,
        `Project: ${project.name}`,task.instructions,`Acceptance criteria:\n${task.acceptanceCriteria}`,
        ...(task.feedback ? [`Human review — changes required:\n${task.feedback}`] : []),
        'Return your deliverable in this conversation, including useful artifact links and a summary against the acceptance criteria. Identify this task ID in your final response. A human will select the deliverable and approve it; do not claim human acceptance.',
      ].join('\n\n')},
    });
    // Same idempotency key survives network timeouts and process restarts.
    if (!event.id || event.channelId!==project.channelId || event.idempotencyKey!==`nest:task:${task.id}:attempt:${task.attempt}` || event.source!==`human:${c.get('human').username}` || event.payload?.nestTaskId!==task.id || event.payload?.nestTaskAttempt!==task.attempt || event.payload?.targetAgentName!==task.agentName) throw new HTTPException(409,{message:'Dispatch receipt does not match this task. Review the linked conversation before retrying.'});
    return c.json(update(task,{status:'working',dispatchEventId:event.id,dispatchedAt:event.createdAt},c.get('human').id));
  });
  routes.get('/api/projects/:projectId/tasks/:taskId/responses', async c => {
    const project=owned(c.req.param('projectId'),c.get('human'),c.get('channels'));
    const task=taskFor(project,c.req.param('taskId'));
    if (task.status!=='working') return c.json([]);
    const query=new URLSearchParams({channelId:project.channelId,type:'message.created',source:`agent:${task.agentName}`,after:String(task.dispatchedAt),limit:'100',order:'desc'});
    const events=await orgops.humanJson<EngineEvent[]>(`/api/events?${query}`,c.req.raw.headers);
    return c.json(events.filter(e=>candidate(e,project,task)).map(e=>({id:e.id,text:e.payload!.text,createdAt:e.createdAt})));
  });
  routes.post('/api/projects/:projectId/tasks/:taskId/deliverables', async c => {
    const project=owned(c.req.param('projectId'),c.get('human'),c.get('channels'));
    const task=taskFor(project,c.req.param('taskId'));
    const body=parse(SubmitDeliverableSchema,await c.req.json().catch(()=>null));
    current(task,body.version);
    if (task.status!=='working') return c.json({error:'Task is not awaiting an agent response'},409);
    const event=await orgops.humanJson<EngineEvent>(`/api/events/${encodeURIComponent(body.eventId)}`,c.req.raw.headers);
    if (!candidate(event,project,task)) return c.json({error:'Choose a response from the assigned agent after this attempt was sent'},400);
    const deliverable={id:randomUUID(),taskId:task.id,attempt:task.attempt,eventId:event.id,text:event.payload!.text as string,submittedBy:c.get('human').id,createdAt:Date.now()};
    return c.json(update(task,{status:'needs_review',deliverableId:deliverable.id},c.get('human').id,{deliverable}));
  });
  routes.post('/api/projects/:projectId/tasks/:taskId/reviews', async c => {
    const project=owned(c.req.param('projectId'),c.get('human'),c.get('channels'));
    const task=taskFor(project,c.req.param('taskId'));
    const body=parse(ReviewSchema,await c.req.json().catch(()=>null));
    current(task,body.version);
    if (task.status!=='needs_review' || !task.deliverableId) return c.json({error:'Select a deliverable before reviewing'},409);
    const review={id:randomUUID(),taskId:task.id,deliverableId:task.deliverableId,decision:body.decision,feedback:body.feedback,reviewerId:c.get('human').id,createdAt:Date.now()};
    return c.json(update(task,body.decision==='approve' ? {status:'done'} : {status:'changes_requested',attempt:task.attempt+1,dispatchEventId:null,dispatchedAt:null,deliverableId:null,feedback:body.feedback},c.get('human').id,{review}));
  });
  routes.all('/api/projects/*',c=>c.json({error:'Not found'},404));
  app.route('/',routes);
}
