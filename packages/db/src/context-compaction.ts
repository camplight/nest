import {randomUUID} from 'node:crypto';
import type Database from 'better-sqlite3';

export type CompactionJob={agent_name:string;channel_id:string;trigger_event_id:string|null;history_max_chars:number;attempts:number;lease:string};
const MAX_ATTEMPTS=5;
const LEASE_MS=600_000;
/** A chat compacted moments ago is not compacted again for a few minutes. */
export const COMPACTION_COOLDOWN_MS=300_000;
/** A chat whose compaction failed five times is retried at most hourly. */
const FAILED_RETRY_MS=3_600_000;
const CURSOR_KEY='context_compaction_cursor';

// Product state for Nest-side chat compaction. Engine state (agents, events,
// boundaries) is read and written only through the engine API.
export function createContextCompactionStore(db:Database.Database) {
  return {
    /** The agent id guards against a deleted agent's choice applying to a new agent with the same name. */
    autoCompact(agentName:string,agentId:string) {
      return Boolean(db.prepare('SELECT 1 FROM product_agent_memory WHERE agent_name=? AND agent_id=? AND auto_compact=1').get(agentName,agentId));
    },
    setAutoCompact(input:{agentName:string;agentId:string;enabled:boolean;actorId:string;at:number}) {
      db.transaction(()=>{
        db.prepare(`INSERT INTO product_agent_memory(agent_name,agent_id,auto_compact,updated_by,updated_at) VALUES(?,?,?,?,?)
          ON CONFLICT(agent_name) DO UPDATE SET agent_id=excluded.agent_id,auto_compact=excluded.auto_compact,updated_by=excluded.updated_by,updated_at=excluded.updated_at`)
          .run(input.agentName,input.agentId,input.enabled?1:0,input.actorId,input.at);
        db.prepare('INSERT INTO product_audit(type,actor_id,payload_json,created_at) VALUES(?,?,?,?)')
          .run('audit.agent.memory.updated',input.actorId,JSON.stringify({agentName:input.agentName,autoCompact:input.enabled}),input.at);
      })();
    },
    optedInAgentNames() {
      return new Set((db.prepare('SELECT agent_name FROM product_agent_memory WHERE auto_compact=1').all() as {agent_name:string}[]).map(row=>row.agent_name));
    },
    cursor():number|null {
      const row=db.prepare('SELECT value_json FROM product_settings WHERE key=?').get(CURSOR_KEY) as {value_json:string}|undefined;
      const value=row?Number(JSON.parse(row.value_json)):NaN;
      return Number.isFinite(value)?value:null;
    },
    setCursor(value:number) {
      db.prepare('INSERT INTO product_settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json').run(CURSOR_KEY,JSON.stringify(value));
    },
    /** Queues a chat unless it is already queued, running, or was compacted within the cooldown. */
    enqueue(input:{agentName:string;channelId:string;triggerEventId:string;historyMaxChars:number;at:number}) {
      db.prepare(`INSERT INTO product_context_compactions(agent_name,channel_id,status,trigger_event_id,history_max_chars,next_at) VALUES(?,?,'pending',?,?,?)
        ON CONFLICT(agent_name,channel_id) DO UPDATE SET status='pending',trigger_event_id=excluded.trigger_event_id,history_max_chars=excluded.history_max_chars,attempts=0,next_at=excluded.next_at
        WHERE product_context_compactions.status<>'pending' AND product_context_compactions.lease_until<=excluded.next_at
          AND COALESCE(product_context_compactions.compacted_at,0)<=excluded.next_at-?
          AND (product_context_compactions.status<>'failed' OR product_context_compactions.next_at<=excluded.next_at-?)`)
        .run(input.agentName,input.channelId,input.triggerEventId,input.historyMaxChars,input.at,COMPACTION_COOLDOWN_MS,FAILED_RETRY_MS);
    },
    lease(at:number):CompactionJob|undefined {
      return db.transaction(()=>{
        db.prepare("UPDATE product_context_compactions SET status='failed',lease=NULL WHERE status='pending' AND attempts>=? AND lease_until<=?").run(MAX_ATTEMPTS,at);
        const row=db.prepare("SELECT * FROM product_context_compactions WHERE status='pending' AND attempts<? AND next_at<=? AND lease_until<=? ORDER BY next_at LIMIT 1").get(MAX_ATTEMPTS,at,at) as CompactionJob|undefined;
        if(!row)return undefined;
        const lease=randomUUID();
        db.prepare('UPDATE product_context_compactions SET attempts=attempts+1,lease=?,lease_until=? WHERE agent_name=? AND channel_id=?').run(lease,at+LEASE_MS,row.agent_name,row.channel_id);
        return {...row,lease,attempts:row.attempts+1};
      })();
    },
    holds(job:CompactionJob,at:number) {
      return Boolean(db.prepare('SELECT 1 FROM product_context_compactions WHERE agent_name=? AND channel_id=? AND lease=? AND lease_until>?').get(job.agent_name,job.channel_id,job.lease,at));
    },
    /** `more` queues the next step of a long backlog right away. */
    finish(job:CompactionJob,input:{status:'compacted'|'skipped';at:number;cutoffEventId?:string;more?:boolean}) {
      db.prepare(`UPDATE product_context_compactions SET status=?,lease=NULL,lease_until=0,attempts=0,next_at=?,
        cutoff_event_id=COALESCE(?,cutoff_event_id),compacted_at=CASE WHEN ?='compacted' THEN ? ELSE compacted_at END
        WHERE agent_name=? AND channel_id=? AND lease=?`)
        .run(input.more?'pending':input.status,input.at,input.cutoffEventId??null,input.status,input.at,job.agent_name,job.channel_id,job.lease);
    },
    fail(job:CompactionJob,at:number) {
      db.prepare('UPDATE product_context_compactions SET status=?,next_at=?,lease=NULL,lease_until=0 WHERE agent_name=? AND channel_id=? AND lease=?')
        .run(job.attempts>=MAX_ATTEMPTS?'failed':'pending',at+Math.min(900_000,30_000*2**(job.attempts-1)),job.agent_name,job.channel_id,job.lease);
    },
  };
}
export type ContextCompactionStore=ReturnType<typeof createContextCompactionStore>;
