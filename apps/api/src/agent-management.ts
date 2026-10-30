import {defaultModelReference} from '@nest/orgops-client';
import {createHash} from 'node:crypto';
import {resolve} from 'node:path';
import {Hono} from 'hono';
import {HTTPException} from 'hono/http-exception';
import {bodyLimit} from 'hono/body-limit';
import {ManagedAgentInput,ProjectMemberSchema} from '@nest/schemas';
import type {ProductDb} from '@nest/db';
import type {OrgOpsClient, ManagedEngineAgent} from '@nest/orgops-client';
import {verifyManagementCapability} from '../../../skills/nest-management/scripts/capability.mjs';
export type AgentManagementConfig = {agentName:string;agentId:string;engineToken:string;defaultModelId:string;workspaceRoot:string};

/** Explicitly enabled creation and owner-scoped lookup for a trusted wrapped manager. */
export function registerAgentManagementRoutes(app:Hono,{orgops,store,config}:{orgops:OrgOpsClient;store:ProductDb;config?:AgentManagementConfig}) {
  const routes=new Hono();
  const creating=new Set<string>();
  const fail=(status:400|401|403|404|409|503,message:string):never=>{throw new HTTPException(status,{message});};
  routes.onError((error,c)=>error instanceof HTTPException ? c.json({error:error.message},error.status) : c.json({error:c.req.path.includes('/project/members')?'Project membership could not be confirmed. Check members and retry the same invitation.':'Agent creation could not be confirmed. Retry the same name and instructions to recover; do not choose a new name.'},502));
  routes.use('*',bodyLimit({maxSize:32000,onError:c=>c.json({error:'Request too large'},413)}));
  routes.use('*',async(c,next)=>{c.header('Cache-Control','no-store');await next();});
  async function requestContext(authorization:string|undefined) {
    const settings=config??fail(503,'Agent management is not configured');
    const token=authorization?.startsWith('Bearer ')?authorization.slice(7):'';
    const claims=verifyManagementCapability(token,settings.engineToken,settings.agentName)??fail(401,'Agent management capability is missing or revoked');
    const engine=orgops.agentManagement(settings.engineToken);
    const current=await engine.context(claims);
    const {manager,channel,event}=current;
    const owner=current.humans?.find(h=>event?.source===`human:${h.username}`);
    if (!manager || manager.id!==settings.agentId || manager.mode!=='WRAPPED' ||
      !channel || channel.archivedAt || !event || event.id!==claims.triggerEventId ||
      event.channelId!==channel.id || event.type!=='message.created' || !owner || owner.mustChangePassword ||
      (event.payload.targetAgentName && event.payload.targetAgentName!==settings.agentName) ||
      !channel.participants.some(p=>p.subscriberType==='AGENT'&&p.subscriberId===manager.name) ||
      !channel.participants.some(p=>p.subscriberType==='HUMAN'&&p.subscriberId===owner.username))
      fail(403,'Agent management requires the current human request in this manager’s conversation');
    return {claims,engine,owner:owner!,settings,manager:manager!,channel:channel!,humans:current.humans??[],models:current.models,runners:current.runners};
  }
  async function context(authorization:string|undefined) {
    const ctx=await requestContext(authorization);
    const model={reference:defaultModelReference(ctx.settings.defaultModelId,ctx.models)??fail(503,'No enabled default model is configured')};
    // Execution context is required for creation, not for project membership.
    const assignedRunner=ctx.runners?.find(r=>r.id===ctx.manager.assignedRunnerId&&r.online)??fail(503,'The manager’s runner is unavailable');
    return {...ctx,model,runner:assignedRunner};
  }
  function projectFor(ctx:Awaited<ReturnType<typeof requestContext>>) {
    const project=store.projects.projects(ctx.owner.id).find(project=>project.channelId===ctx.channel.id&&project.collaboration==='team');
    if(!project||ctx.channel.ownerHumanId!==ctx.owner.id)fail(403,'Project invitations require the requesting owner in a team project');
    return project!;
  }
  const projectInfo=(project:ReturnType<typeof projectFor>)=>({id:project.id,name:project.name,url:`/?view=projects&project=${encodeURIComponent(project.id)}&tab=chat`});
  routes.get('/project/members',async c=>{
    const ctx=await requestContext(c.req.header('authorization'));
    const project=projectFor(ctx);
    const agents=await ctx.engine.agents();
    const availableMembers=[...ctx.humans.map(h=>({subscriberType:'HUMAN' as const,subscriberId:h.username})),...(agents??[]).filter(a=>a.visibility==='PUBLIC'||a.ownerHumanId===ctx.owner.id).map(a=>({subscriberType:'AGENT' as const,subscriberId:a.name}))];
    const fresh=await requestContext(c.req.header('authorization'));projectFor(fresh);
    return c.json({project:projectInfo(project),members:fresh.channel.participants,availableMembers});
  });
  routes.post('/project/members',async c=>{
    if(!c.req.header('content-type')?.startsWith('application/json'))return c.json({error:'Use application/json'},415);
    const parsed=ProjectMemberSchema.safeParse(await c.req.json().catch(()=>null));
    if(!parsed.success)fail(400,'Provide one exact HUMAN or AGENT identity from project-members');
    const member=parsed.data!;
    const ctx=await requestContext(c.req.header('authorization'));const project=projectFor(ctx);
    const agent=member.subscriberType==='AGENT'?await ctx.engine.agent(member.subscriberId):null;
    if(member.subscriberType==='HUMAN'?!ctx.humans.some(h=>h.username===member.subscriberId):!agent||(agent.visibility!=='PUBLIC'&&agent.ownerHumanId!==ctx.owner.id))fail(400,'Choose an existing person or an available agent');
    const fresh=await requestContext(c.req.header('authorization'));const currentProject=projectFor(fresh);
    if(currentProject.id!==project.id||fresh.owner.id!==ctx.owner.id)fail(403,'Project invitations require the requesting owner in a team project');
    if(member.subscriberType==='HUMAN'&&!fresh.humans.some(h=>h.username===member.subscriberId))fail(400,'Choose an existing person or an available agent');
    if(member.subscriberType==='AGENT'){
      const currentAgent=await fresh.engine.agent(member.subscriberId);
      if(!currentAgent||(currentAgent.visibility!=='PUBLIC'&&currentAgent.ownerHumanId!==fresh.owner.id))fail(400,'Choose an existing person or an available agent');
    }
    const alreadyMember=fresh.channel.participants.some(p=>p.subscriberType===member.subscriberType&&p.subscriberId===member.subscriberId);
    if(!alreadyMember){
      store.db.prepare('INSERT INTO product_audit(type,actor_id,payload_json,created_at) VALUES(?,?,?,?)').run('audit.project.member.invitation.requested',ctx.owner.id,JSON.stringify({projectId:project.id,managerId:ctx.settings.agentId,triggerEventId:ctx.claims.triggerEventId,...member}),Date.now());
      try{await fresh.engine.subscribe(fresh.channel.id,member);}catch{/* Reconcile a subscription that may already have committed. */}
      const confirmed=await requestContext(c.req.header('authorization'));projectFor(confirmed);
      if(!confirmed.channel.participants.some(p=>p.subscriberType===member.subscriberType&&p.subscriberId===member.subscriberId))return c.json({error:'Project membership could not be confirmed. Check members and retry the same invitation.'},502);
      store.db.prepare('INSERT INTO product_audit(type,actor_id,payload_json,created_at) VALUES(?,?,?,?)').run('audit.project.member.invited',ctx.owner.id,JSON.stringify({projectId:project.id,managerId:ctx.settings.agentId,triggerEventId:ctx.claims.triggerEventId,...member}),Date.now());
    }
    return c.json({project:projectInfo(project),member,alreadyMember});
  });
  const publicAgent=(a:ManagedEngineAgent)=>({id:a.id,name:a.name,modelId:a.modelId,visibility:a.visibility,settingsUrl:`/?view=agents&agent=${encodeURIComponent(a.name)}`});
  routes.get('/context',async c=>{
    const ctx=await context(c.req.header('authorization'));
    return c.json({requester:ctx.owner.username,model:ctx.model.reference,operations:['agents:create','agents:get-owned','projects:members:list','projects:members:add']});
  });
  routes.get('/agents/:name',async c=>{
    const ctx=await context(c.req.header('authorization'));
    const agent=await ctx.engine.agent(c.req.param('name'));
    if(!agent||agent.ownerHumanId!==ctx.owner.id||agent.visibility!=='PRIVATE')fail(404,'No private agent with that name was found for this requester');
    // Revalidate after the lookup as membership or the manager may have changed.
    const fresh=await context(c.req.header('authorization'));
    if(fresh.owner.id!==ctx.owner.id)fail(403,'The requesting owner changed');
    return c.json({agent:publicAgent(agent!),existing:true});
  });
  routes.post('/agents',async c=>{
    if(!c.req.header('content-type')?.startsWith('application/json'))return c.json({error:'Use application/json'},415);
    const ctx=await context(c.req.header('authorization'));
    const parsed=ManagedAgentInput.safeParse(await c.req.json().catch(()=>null));
    if(!parsed.success)fail(400,'Provide an agent name, description and instructions; other fields are not accepted');
    const input=parsed.data!;
    const fingerprint=createHash('sha256').update(ctx.claims.triggerEventId+'\0'+input.name).digest('hex');
    const workspacePath=resolve(ctx.settings.workspaceRoot,ctx.owner.id,fingerprint);
    const matches=(a:ManagedEngineAgent)=>a.ownerHumanId===ctx.owner.id&&a.visibility==='PRIVATE'&&a.mode==='CLASSIC'&&a.workspacePath===workspacePath&&a.modelId===ctx.model.reference&&a.description===input.description&&a.systemInstructions===input.systemInstructions&&!a.allowOutsideWorkspace&&!a.allowOwnerHumanSecrets;
    const existing=await ctx.engine.agent(input.name);
    if(existing){if(!matches(existing))fail(409,'That agent name already exists. Its settings were kept.');return c.json({agent:publicAgent(existing),recovered:true});}
    if(creating.has(input.name))fail(409,'Agent creation is in progress. Retry the same request.');
    creating.add(input.name);
    try {
      // Recheck signed request, current membership, identity, model and runner after lookups.
      const fresh=await context(c.req.header('authorization'));
      if(fresh.owner.id!==ctx.owner.id||fresh.model.reference!==ctx.model.reference||fresh.runner.id!==ctx.runner.id)fail(409,'Agent management context changed; retry');
      let response:Response|undefined;
      try {
        response=await ctx.engine.create({...input,modelId:ctx.model.reference,workspacePath,assignedRunnerId:ctx.runner.id,ownerHumanId:ctx.owner.id,visibility:'PRIVATE',mode:'CLASSIC',desiredState:'RUNNING',runtimeState:'STOPPED',enabledSkills:[],alwaysPreloadedSkills:[],allowOutsideWorkspace:false,allowOwnerHumanSecrets:false});
      } catch { /* A timed-out POST may already have succeeded. Reconcile by unique name and exact workspace. */ }
      const created=await ctx.engine.agent(input.name);
      if(!created||!matches(created)){
        if(response?.status===400)fail(400,'The engine rejected this agent configuration');
        if(created)fail(409,'That agent name already exists. Its settings were kept.');
        throw Error('Agent creation unconfirmed');
      }
      store.db.prepare('INSERT INTO product_audit(type,actor_id,payload_json,created_at) VALUES(?,?,?,?)').run('audit.agent.management.created',ctx.owner.id,JSON.stringify({managerId:ctx.settings.agentId,agentId:created.id,triggerEventId:ctx.claims.triggerEventId}),Date.now());
      return c.json({agent:publicAgent(created),recovered:!response?.ok},response?.ok?201:200);
    } finally {creating.delete(input.name);}
  });
  routes.all('*',c=>c.json({error:'Not found'},404));
  app.route('/api/agent-management',routes);
}
