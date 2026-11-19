import {randomBytes} from 'node:crypto';
import {Hono} from 'hono';
import {bodyLimit} from 'hono/body-limit';
import {DEFAULT_SPEECH_SETTINGS, SpeechSettingsSchema} from '@nest/schemas';
import type {ProductDb} from '@nest/db';
import type {Human, OrgOpsClient} from '@nest/orgops-client';
import {spokenText, relaySpeech, type SpeechProvider} from './fish-audio';

type Agent = {id:string; name:string; ownerHumanId?:string|null};
type Message = {id:string; type:string; source:string; channelId?:string; payloadTruncated?:boolean; payload?:{text?:unknown}};
export function registerSpeechRoutes(app:Hono, {store,orgops,provider}:{store:ProductDb;orgops:OrgOpsClient;provider?:SpeechProvider}) {
  const routes=new Hono<{Variables:{human:Human}}>();
  routes.use('*', bodyLimit({maxSize:4096, onError:c=>c.json({error:'Speech request too large'},413)}));
  routes.use('*', async(c,next)=>{
    c.header('Cache-Control','no-store');
    const human=await orgops.currentHuman(c.req.raw.headers);
    if (!human) return c.json({error:'Sign in to use speech'},401);
    if (human.mustChangePassword) return c.json({error:'Complete password setup first'},403);
    c.set('human',human); await next();
  });
  async function agent(name:string, headers:Headers):Promise<Agent|null> {
    const r=await orgops.humanRequest('/api/agents/'+encodeURIComponent(name),headers);
    if (r.status===403 || r.status===404) return null;
    if (!r.ok) throw Error('Agent unavailable');
    return r.json() as Promise<Agent>;
  }
  function settings(id:string) {
    const row=store.db.prepare('SELECT settings_json FROM product_agent_speech WHERE agent_id=?').get(id) as {settings_json:string}|undefined;
    return row?SpeechSettingsSchema.parse(JSON.parse(row.settings_json)):DEFAULT_SPEECH_SETTINGS;
  }
  async function canManage(a:Agent,h:Human,headers:Headers) {
    return a.ownerHumanId===h.id || await orgops.isOwner(h,headers);
  }
  routes.get('/agents/:name',async c=>{
    const a=await agent(c.req.param('name'),c.req.raw.headers);
    if (!a) return c.json({error:'Agent not found'},404);
    return c.json({settings:settings(a.id),available:Boolean(provider),canManage:await canManage(a,c.get('human'),c.req.raw.headers)});
  });
  routes.put('/agents/:name',async c=>{
    const a=await agent(c.req.param('name'),c.req.raw.headers);
    if (!a) return c.json({error:'Agent not found'},404);
    if (!await canManage(a,c.get('human'),c.req.raw.headers)) return c.json({error:'Only the agent owner or instance owner can configure speech'},403);
    const parsed=SpeechSettingsSchema.safeParse(await c.req.json().catch(()=>null));
    if (!parsed.success) return c.json({error:'Choose a voice ID, speaking style and speed between 0.5 and 2'},400);
    store.db.prepare('INSERT INTO product_agent_speech VALUES (?,?,?,?) ON CONFLICT(agent_id) DO UPDATE SET settings_json=excluded.settings_json, updated_by=excluded.updated_by, updated_at=excluded.updated_at')
      .run(a.id,JSON.stringify(parsed.data),c.get('human').id,Date.now());
    return c.json({settings:parsed.data,available:Boolean(provider),canManage:true});
  });
  const recent=new Map<string,{start:number;count:number}>(), active=new Set<string>();
  const tickets=new Map<string,{human:string;eventId:string;expires:number}>();
  routes.post('/messages/:id',async c=>{
    const now=Date.now();
    for(const [token,ticket] of tickets)if(ticket.expires<=now)tickets.delete(token);
    if(tickets.size>=1000)return c.json({error:'Speech is busy. Try again shortly.'},429);
    // Prepare without generating: native media GETs require a single-use ticket.
    return prepare(c,false);
  });
  routes.get('/streams/:token',async c=>{
    if(c.req.method!=='GET')return c.body(null,405);
    const token=c.req.param('token'),ticket=tickets.get(token);
    if(!ticket || ticket.human!==c.get('human').id || ticket.expires<=Date.now())return c.json({error:'Playback expired. Choose Listen again.'},404);
    tickets.delete(token);
    return prepare(c,true,ticket.eventId);
  });
  async function prepare(c:import('hono').Context<{Variables:{human:Human}}>, play:boolean, eventId=c.req.param('id')) {
    const headers=c.req.raw.headers;
    const r=await orgops.humanRequest('/api/events/'+encodeURIComponent(eventId),headers);
    if (r.status===403 || r.status===404) return c.json({error:'Message not found'},404);
    if (!r.ok) throw Error('Message unavailable');
    const event=await r.json() as Message;
    if (event.type!=='message.created' || !event.source.startsWith('agent:') || !event.channelId || event.payloadTruncated || typeof event.payload?.text!=='string') return c.json({error:'This message cannot be read aloud'},400);
    // Recheck live channel access independently of event-detail visibility.
    const channels=await orgops.humanJson<{id:string}[]>('/api/channels?includeArchived=1',headers);
    if (!channels.some(ch=>ch.id===event.channelId)) return c.json({error:'Message not found'},404);
    const a=await agent(event.source.slice(6),headers);
    if (!a) return c.json({error:'Agent not found'},404);
    const config=settings(a.id);
    if (!config.enabled) return c.json({error:'Speech is disabled for this agent. Its owner can enable it in agent settings.'},409);
    if (!provider) return c.json({error:'Fish Audio is not configured. Ask your administrator to finish speech setup.'},503);
    const text=spokenText(event.payload.text);
    if (!text || text.length>5000) return c.json({error:'Speech supports messages with 1–5,000 spoken characters'},400);
    const human=c.get('human').id, now=Date.now();
    for (const [id,entry] of recent) if (now-entry.start>=60_000) recent.delete(id);
    const usage=recent.get(human)??{start:now,count:0};
    if (active.has(human) || active.size>=4 || (!play && usage.count>=10)) {c.header('Retry-After','60');return c.json({error:'Speech is busy. Try again in a minute.'},429);}
    if(!play) {
      usage.count++;recent.set(human,usage);
      const token=randomBytes(24).toString('hex');
      tickets.set(token,{human,eventId,expires:now+60_000});
      return c.json({url:'/api/speech/streams/'+token});
    }
    active.add(human);
    const abort=new AbortController();
    const signal=AbortSignal.any([c.req.raw.signal,abort.signal,AbortSignal.timeout(60_000)]);
    try {
      const audio=await provider!(text,config,signal);
      return new Response(relaySpeech(audio,abort,signal,()=>active.delete(human)),{headers:{
        'Content-Type':'audio/mpeg','Cache-Control':'no-store','X-Content-Type-Options':'nosniff',
        'Accept-Ranges':'none','X-Accel-Buffering':'no',
      }});
    } catch {abort.abort();active.delete(human);return c.json({error:'Could not generate speech. Please try again.'},502);}
  }
  app.route('/api/speech',routes);
}
