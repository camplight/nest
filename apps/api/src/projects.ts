import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { bodyLimit } from 'hono/body-limit';
import type { ProductDb } from '@nest/db';
import type { Human, OrgOpsClient } from '@nest/orgops-client';
import { NewProjectSchema, NewTaskSchema, TaskActionSchema, SubmitDeliverableSchema, ReviewSchema, type Task, type Project } from '@nest/schemas';

type Channel = {id: string; canManage: boolean; canPost: boolean; archivedAt?: number | null};
type EngineEvent = {id: string; type: string; source: string; channelId: string; createdAt: number; payload?: {text?: unknown; nestTaskId?: unknown; nestTaskAttempt?: unknown; targetAgentName?: unknown}; idempotencyKey?: string};
export function registerProjectRoutes(app: Hono, {store, orgops}: {store: ProductDb; orgops: OrgOpsClient}) {
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
  routes.get('/api/projects', c => c.json(db.projects(c.get('human').id).filter(p=>available(c.get('channels'),p.channelId))));
  routes.post('/api/projects', async c => {
    const body = parse(NewProjectSchema,await c.req.json().catch(()=>null));
    const human=c.get('human');
    if (!available(c.get('channels'),body.channelId)) return c.json({error:'Choose an active conversation you can manage'},403);
    const existing=db.project(body.id);
    if (existing) {
      if (existing.ownerId!==human.id || existing.name!==body.name || existing.channelId!==body.channelId || existing.description!==body.description) return c.json({error:'Project ID already used'},409);
      return c.json(existing);
    }
    return c.json(db.createProject({...body,ownerId:human.id,createdAt:Date.now()}),201);
  });
  routes.get('/api/projects/:projectId', c => c.json(db.detail(owned(c.req.param('projectId'),c.get('human'),c.get('channels')))));
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
