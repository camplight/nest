import type {Hono} from 'hono';
import type {OrgOpsClient} from '@nest/orgops-client';
import type {ProductDb} from '@nest/db';

/** Normal chat admission for the installation's registered personal agents. */
export function registerCollaborationRoutes(app:Hono,{orgops,store,engineToken}:{orgops:OrgOpsClient;store:ProductDb;engineToken?:string}) {
  const agents=createPersonalAgentDirectory({store,orgops,engineToken});
  app.get('/api/assistants',async c=>{const human=await orgops.currentHuman(c.req.raw.headers);if(!human)return c.json({error:'Sign in required'},401);if(human.mustChangePassword)return c.json({error:'Complete password setup first'},403);c.header('Cache-Control','no-store');return c.json({items:(await agents()).map(a=>({agentName:a.name,ownerName:a.ownerName,description:'Shared personal agent',yours:a.ownerName===human.username}))});});
  app.get('/api/collaboration/agents',async c=>{
    const human=await orgops.currentHuman(c.req.raw.headers);
    if(!human)return c.json({error:'Sign in required'},401);
    if(human.mustChangePassword)return c.json({error:'Complete password setup first'},403);
    c.header('Cache-Control','no-store');
    return c.json({items:await agents()});
  });
  app.post('/api/collaboration/agents/:name/chat',async c=>{
    const human=await orgops.currentHuman(c.req.raw.headers);
    if(!human)return c.json({error:'Sign in required'},401);
    if(human.mustChangePassword)return c.json({error:'Complete password setup first'},403);
    if(!(await agents()).some(a=>a.name===c.req.param('name')))return c.json({error:'Agent unavailable'},404);
    // Engine's direct-channel operation is idempotent for this exact participant pair.
    const response=await orgops.humanRequest('/api/channels/direct',c.req.raw.headers,'POST',{
      participants:[{subscriberType:'HUMAN',subscriberId:human.username},{subscriberType:'AGENT',subscriberId:c.req.param('name')}],
    });
    if(!response.ok)throw Error('Could not open conversation');
    const result=await response.json() as {id:string};
    return c.json({channelId:result.id});
  });
}

export function createPersonalAgentDirectory({store,orgops,engineToken}:{store:ProductDb;orgops:OrgOpsClient;engineToken?:string}) {
  return async function agents() {
    if(!engineToken)return [];
    const meta=await orgops.assistantDirectory(engineToken);
    const registered=store.db.prepare('SELECT name,agent_id,owner_id FROM product_personal_agents').all() as {name:string;agent_id:string;owner_id:string}[];
    return registered.flatMap(row=>{
      const agent=meta.agents.find(a=>a.id===row.agent_id&&a.name===row.name&&a.ownerHumanId===row.owner_id&&a.visibility==='PRIVATE'&&a.mode!=='WRAPPED');
      const owner=meta.humans.find(h=>h.id===row.owner_id);
      return agent&&owner?[{name:agent.name,ownerName:owner.username}]:[];
    });
  }
}
