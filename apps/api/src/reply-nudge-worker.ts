import type {ProductDb} from '@nest/db';
import type {ReplyNudgeEngine} from '@nest/orgops-client';

type EngineEvent={id:string;type:string;source:string;channelId?:string;createdAt:number;payload:unknown};
type Mention={kind?:unknown;name?:unknown};
const PAGE=200;

export const replyNudgeText=(person:string)=>`You ended your turn without replying to ${person}. Reply to them now, or say why you can't.`;

const record=(value:unknown):Record<string,unknown>=>value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:{};

/** Whether a person's message was meant for this agent: named in it, or the chat's only agent when it names nobody. */
function addressedTo(payload:Record<string,unknown>,agent:string,channelAgents:()=>Promise<string[]>) {
  const targets=[payload.targetAgentName,...(Array.isArray(payload.targetAgentNames)?payload.targetAgentNames:[])].filter((name):name is string=>typeof name==='string'&&Boolean(name));
  const mentions=Array.isArray(payload.mentions)?payload.mentions as Mention[]:[];
  if(targets.includes(agent)||mentions.some(m=>m?.kind==='AGENT'&&m.name===agent))return Promise.resolve(true);
  // A message naming someone else is not this agent's to answer.
  if(targets.length||mentions.length)return Promise.resolve(false);
  return channelAgents().then(agents=>agents.length===1&&agents[0]===agent);
}

/**
 * Watches engine turn completions. When an agent ended a turn without answering a
 * person who was waiting for it, posts one targeted note from Nest asking it to
 * reply. The engine's idempotency key keeps that to one note per request, across
 * passes and API processes. The note's own turn is never nudged: its trigger is not
 * from a person.
 */
export function createReplyNudgeWorker({store,engine}:{store:ProductDb;engine:ReplyNudgeEngine|null}) {
  const cursorStore=store.replyNudges;
  let active=false;

  async function consider(engine:ReplyNudgeEngine,completion:EngineEvent) {
    if(!completion.source.startsWith('agent:')||!completion.channelId)return;
    const agent=completion.source.slice('agent:'.length);
    const payload=record(completion.payload);
    if(payload.cancelled===true||typeof payload.triggerEventId!=='string')return;
    const trigger=await engine.event(payload.triggerEventId) as EngineEvent|null;
    if(!trigger||trigger.type!=='message.created'||!trigger.source.startsWith('human:')||trigger.channelId!==completion.channelId)return;
    if(!await addressedTo(record(trigger.payload),agent,()=>engine.channelAgents(completion.channelId!)))return;
    const later=await engine.messagesAfter(completion.channelId,trigger.createdAt);
    // The agent spoke again, or the person followed up and the agent is handling that.
    if(later.some(message=>message.id!==trigger.id&&(message.source===completion.source||message.source.startsWith('human:'))))return;
    await engine.postNudge({agentName:agent,channelId:completion.channelId,triggerEventId:trigger.id,requestedFor:trigger.source,text:replyNudgeText(trigger.source.slice('human:'.length))});
  }

  async function tick() {
    if(active||!engine)return;
    active=true;
    try {
      let cursor=cursorStore.cursor();
      // Start from the newest completion; turns that ended before Nest watched are left alone.
      if(cursor===null){cursorStore.setCursor(await engine.latestTurnCompletionAt());return;}
      const page=await engine.turnCompletions(cursor,PAGE) as EngineEvent[];
      for(const completion of page) {
        try {await consider(engine,completion);}
        catch {/* Best effort: skip this one. Engine errors may contain chat text; never log raw errors. */}
        cursor=Math.max(cursor,completion.createdAt);
      }
      // A full page may stop inside a group sharing one timestamp; read that group again (nudges are idempotent).
      const first=page[0],last=page.at(-1);
      if(page.length===PAGE&&first&&last&&first.createdAt!==last.createdAt)cursor=last.createdAt-1;
      cursorStore.setCursor(cursor);
    } catch {
      // Engine unavailable: the cursor stays and the next pass retries.
    } finally {active=false;}
  }
  return {tick};
}
