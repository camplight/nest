import type {ProductDb} from '@nest/db';
import type {ReplyNudgeEngine} from '@nest/orgops-client';

type EngineEvent={id:string;type:string;source:string;channelId?:string;createdAt:number;payload:unknown};
type Mention={kind?:unknown;name?:unknown};
const PAGE=200;
/** A turn that ended longer ago than this is left alone: the person has moved on (a stale cursor must not revive it). */
export const REPLY_NUDGE_MAX_AGE_MS=10*60_000;

export const replyNudgeText=(person:string)=>`You ended your turn without replying to ${person}. Reply to them now, or say why you can't.`;

const record=(value:unknown):Record<string,unknown>=>value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:{};

/**
 * How a person's message reached this agent: it named the agent, or it named nobody in a chat where this is the
 * only agent. A message naming someone else is not this agent's to answer.
 */
function addressing(payload:Record<string,unknown>,agent:string,channelAgents:()=>Promise<string[]>):Promise<'named'|'sole'|null> {
  const targets=[payload.targetAgentName,...(Array.isArray(payload.targetAgentNames)?payload.targetAgentNames:[])].filter((name):name is string=>typeof name==='string'&&Boolean(name));
  const mentions=Array.isArray(payload.mentions)?payload.mentions as Mention[]:[];
  if(targets.includes(agent)||mentions.some(m=>m?.kind==='AGENT'&&m.name===agent))return Promise.resolve('named');
  if(targets.length||mentions.length)return Promise.resolve(null);
  return channelAgents().then(agents=>agents.length===1&&agents[0]===agent?'sole':null);
}

/**
 * Watches engine turn completions. When an agent ended a turn without answering a
 * person who was waiting for it, posts one targeted note from Nest asking it to
 * reply. The engine's idempotency key keeps that to one note per request, across
 * passes and API processes. The note's own turn is never nudged: its trigger is not
 * from a person.
 */
export function createReplyNudgeWorker({store,engine,now=Date.now}:{store:ProductDb;engine:ReplyNudgeEngine|null;now?:()=>number}) {
  const cursorStore=store.replyNudges;
  let active=false;

  async function consider(engine:ReplyNudgeEngine,completion:EngineEvent) {
    if(!completion.source.startsWith('agent:')||!completion.channelId)return;
    const agent=completion.source.slice('agent:'.length);
    const payload=record(completion.payload);
    // Stopped, or the agent scheduled its own retry.
    if(payload.cancelled===true||payload.scheduledContinuation===true||typeof payload.triggerEventId!=='string')return;
    if(now()-completion.createdAt>REPLY_NUDGE_MAX_AGE_MS)return;
    const trigger=await engine.event(payload.triggerEventId) as EngineEvent|null;
    if(!trigger||trigger.type!=='message.created'||!trigger.source.startsWith('human:')||trigger.channelId!==completion.channelId)return;
    const reached=await addressing(record(trigger.payload),agent,()=>engine.channelAgents(completion.channelId!));
    if(!reached)return;
    // In a one-agent chat every message reaches the agent; a "thanks" it rightly let pass, without doing
    // anything, is not a question left unanswered. Work on it (a tool call) and then silence is.
    if(reached==='sole'&&!await engine.usedTools(completion.channelId,agent,trigger.createdAt,completion.createdAt))return;
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
