import type {ProductDb,CompactionJob} from '@nest/db';
import type {ContextCompactionEngine} from '@nest/orgops-client';
import {engineIgnoredPrefixes,planCompaction,shouldCompact,summarizeHistory,type HistorySummarizer} from './context-compaction';

type Reading={id:string;channelId?:string;createdAt:number;payload:{agentName?:unknown;memoryContextMode?:unknown;historyChars?:unknown;historyMaxChars?:unknown}};
type Outcome={status:'compacted'|'skipped';cutoffEventId?:string;more?:boolean};

/**
 * Watches the runner's context-window telemetry and, for agents whose owner chose
 * "Full history, summarized when long", posts an engine compaction boundary once a
 * chat reaches three quarters of the agent's history budget. Every API process may
 * poll: SQLite leases coordinate the work and a stale worker cannot post.
 */
export function createContextCompactionWorker({store,engine,summarize=summarizeHistory,now=Date.now}:{store:ProductDb;engine:ContextCompactionEngine|null;summarize?:HistorySummarizer;now?:()=>number}) {
  const jobs=store.contextCompaction;
  let active=false;

  async function scan(engine:ContextCompactionEngine) {
    let cursor=jobs.cursor();
    // Start from the newest reading; older chats are compacted when they next run.
    if(cursor===null){jobs.setCursor(await engine.latestTelemetryAt());return;}
    const optedIn=jobs.optedInAgentNames();
    for(const reading of await engine.telemetry(cursor) as Reading[]) {
      cursor=Math.max(cursor,reading.createdAt);
      const {agentName,memoryContextMode,historyChars,historyMaxChars}=reading.payload??{};
      if(typeof agentName!=='string'||!optedIn.has(agentName)||memoryContextMode!=='FULL_CHANNEL_EVENTS'||!reading.channelId)continue;
      if(typeof historyChars!=='number'||typeof historyMaxChars!=='number'||!shouldCompact({historyChars,historyMaxChars}))continue;
      jobs.enqueue({agentName,channelId:reading.channelId,triggerEventId:reading.id,historyMaxChars,at:now()});
    }
    jobs.setCursor(cursor);
  }

  async function compact(engine:ContextCompactionEngine,job:CompactionJob):Promise<Outcome> {
    const agent=await engine.agent(job.agent_name);
    if(!agent||agent.mode==='WRAPPED'||agent.memoryContextMode!=='FULL_CHANNEL_EVENTS'||!jobs.autoCompact(agent.name,agent.id))return {status:'skipped'};
    const model=await engine.modelReference(agent.modelId);
    if(!model)return {status:'skipped'};
    const boundary=await engine.boundary(agent.name,job.channel_id);
    const page=await engine.channelEvents(job.channel_id,boundary?.cutoffAt,engineIgnoredPrefixes);
    const plan=planCompaction(page.events,{historyMaxChars:job.history_max_chars,truncated:page.truncated});
    if(!plan)return {status:'skipped'};
    const env=await engine.modelEnv(agent.name,model);
    const summary=await summarize({model,env,agentName:agent.name,previousSummary:boundary?.summary,events:plan.older});
    // Someone may have compacted or cleared the chat while the summary was written.
    const current=await engine.boundary(agent.name,job.channel_id);
    if(current?.eventId!==boundary?.eventId||!jobs.holds(job,now()))return {status:'skipped'};
    const result=await engine.compact(agent.name,{channelId:job.channel_id,summary,cutoffAt:plan.cutoff.createdAt,cutoffEventId:plan.cutoff.id,
      reason:'Nest summarized the older part of a long chat',idempotencyKey:`nest-compact:${agent.name}:${job.channel_id}:${plan.cutoff.id}`});
    return result==='compacted'?{status:'compacted',cutoffEventId:plan.cutoff.id,more:plan.more}:{status:'skipped'};
  }

  async function tick() {
    if(active||!engine)return;
    active=true;
    let job:CompactionJob|undefined;
    try {
      await scan(engine);
      job=jobs.lease(now());
      if(!job)return;
      jobs.finish(job,{...await compact(engine,job),at:now()});
    } catch {
      if(job)jobs.fail(job,now());
      // Provider and engine errors may contain credentials or chat text; never log raw errors.
    } finally {active=false;}
  }
  return {tick};
}
