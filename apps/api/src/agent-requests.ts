import {Hono} from 'hono';
import type {ProductDb,AgentRequestRow} from '@nest/db';
import type {OrgOpsClient,Human} from '@nest/orgops-client';
import type {AgentRequest} from '@nest/schemas';

/** Retired workflow: retain participant-only history, never dispatch or release new replies. */
export function registerAgentRequestRoutes(app:Hono,{store,orgops,engineToken}:{store:ProductDb;orgops:OrgOpsClient;engineToken?:string}) {
 const routes=new Hono<{Variables:{human:Human}}>();
 for(const path of ['/assistants','/assistants/*','/agent-requests','/agent-requests/*'])routes.use(path,async(c,next)=>{
  c.header('Cache-Control','no-store');
  const human=await orgops.currentHuman(c.req.raw.headers);
  if(!human)return c.json({error:'Sign in required'},401);
  if(human.mustChangePassword)return c.json({error:'Complete password setup first'},403);
  c.set('human',human);
  if(c.req.method!=='GET')return c.json({error:'Teammate requests are retired. Open a normal agent conversation. Existing requests are history only.'},410);
  await next();
 });
   function view(
    row: AgentRequestRow,
    human: Human,
    humans: { id: string; username: string }[],
  ): AgentRequest {
    // No private channel/event IDs or unreleased engine responses leave this boundary.
    return {
      id: row.id,
      agentName: row.agent_name,
      ownerName:
        humans.find((h) => h.id === row.owner_id)?.username ??
        "Former teammate",
      requesterName:
        humans.find((h) => h.id === row.requester_id)?.username ??
        "Former teammate",
      title: row.title,
      brief: row.brief,
      status: row.status,
      version: row.version,
      isOwner: row.owner_id === human.id,
      reply: row.status === "completed" ? row.reply : null,
      feedback: row.feedback,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

 async function humans(){return engineToken?(await orgops.assistantDirectory(engineToken)).humans:[];}
 routes.get('/agent-requests',async c=>{
  const offset=Number(c.req.query('offset')??0),limit=Number(c.req.query('limit')??50),direction=c.req.query('direction')??'all';
  if(!Number.isInteger(offset)||offset<0||!Number.isInteger(limit)||limit<1||limit>100||!['all','incoming','outgoing'].includes(direction))return c.json({error:'Invalid page'},400);
  const human=c.get('human'),rows=store.agentRequests.list(human.id,offset,limit+1,direction as 'all'|'incoming'|'outgoing'),people=await humans();
  return c.json({items:rows.slice(0,limit).map(row=>view(row,human,people)),hasMore:rows.length>limit,retired:true});
 });
 routes.get('/agent-requests/:id',async c=>{const row=store.agentRequests.request(c.req.param('id')),human=c.get('human');if(!row||(row.owner_id!==human.id&&row.requester_id!==human.id))return c.json({error:'Request not found'},404);return c.json(view(row,human,await humans()));});
 for(const path of ['/assistants','/assistants/*','/agent-requests/*'])routes.get(path,c=>c.json({error:'This workflow has been retired. Use normal agent chat.'},410));
 app.route('/api',routes);
}
