import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ProductDb } from '@nest/db';
import { DEFAULT_AGENT_MODEL_ID, EngineError, isEngineOutage, type EngineEvent, type OrgOpsClient, type ServiceAgent, type ServiceClient } from '@nest/orgops-client';

/** The engine description that marks the agent Nest made; an agent without it is never adopted. */
export const SWITCHYARD_MARKER = 'Nest service identity for hand-offs, scheduled runs, webhooks and fork seeds. It never takes turns.';
export const SWITCHYARD_SETTING = 'switchyard.agent';
const CACHE_MS = 60_000;

export type SwitchyardKind = 'handoff' | 'run' | 'webhook' | 'app-event' | 'fork-seed' | 'note';
export type SwitchyardState = { ok: true; name: string } | { ok: false; reason: 'no-service-token' | 'name-taken' | 'engine-unavailable' };
export type SwitchyardPost = {
  channelId: string; text: string;
  /** The agent to wake; null targets the service agent itself, so nobody wakes ("just context"). */
  target: string | null;
  kind: SwitchyardKind; setBy: string; idempotencyKey: string;
  attachments?: { fileId: string; name: string; mime?: string; size?: number }[];
  deliverAt?: number; type?: 'message.created' | 'agent.scheduled.trigger'; meta?: Record<string, string>;
};

/** Thrown by join and post when the service identity cannot be used. */
export class SwitchyardUnavailableError extends Error {
  constructor(readonly reason: Extract<SwitchyardState, { ok: false }>['reason']) {
    super(`The Switchyard service agent is unavailable (${reason})`);
    this.name = 'SwitchyardUnavailableError';
  }
}

/** The service agent is missing and no SYSTEM-role creator is configured, so Nest cannot make it. */
class SwitchyardNoCreatorError extends Error {
  constructor() {
    super('it does not exist and no creator is configured (set NEST_MANAGEMENT_AGENT_NAME to a SYSTEM-role agent)');
    this.name = 'SwitchyardNoCreatorError';
  }
}
/** The engine refused to create the service agent (403): a scoped token, or a creator without the SYSTEM role. */
class SwitchyardCreateRefusedError extends EngineError {
  constructor(readonly problem: string) { super(403, '/api/agents'); }
}

const defaultWorkspaceRoot = () =>
  resolve(fileURLToPath(new URL('../../../../', import.meta.url)), process.env.NEST_ENGINE_DATA_DIR ?? '.nest-data', 'workspaces/managed');

/**
 * Nest's service identity: a real engine agent that stays stopped, so it never takes turns.
 * Nest posts as it with the global runner token, which keeps its requested `agent:<name>` source.
 * The engine accepts its owner and visibility only from a SYSTEM-role agent, so Nest creates it as `creator`
 * (default `NEST_MANAGEMENT_AGENT_NAME`, Nest's management agent); an existing agent is adopted without one.
 */
export function createSwitchyard({ store, orgops, token, name, creator, workspaceRoot, defaultModelId, now = Date.now, log = line => console.warn(line) }: {
  store: ProductDb; orgops: OrgOpsClient; token: string | undefined; name?: string;
  /** The SYSTEM-role agent the service agent is created as; empty means none. */
  creator?: string;
  workspaceRoot?: string; defaultModelId?: string; now?: () => number; log?: (line: string) => void;
}) {
  const agentName = name || process.env.NEST_SWITCHYARD_AGENT_NAME || 'Switchyard';
  const creatorName = (creator ?? process.env.NEST_MANAGEMENT_AGENT_NAME ?? '').trim();
  const root = workspaceRoot ?? defaultWorkspaceRoot();
  // The cached adoption verdict: which agent is ours, or that the name is taken. Never its run state.
  type Verdict = { state: SwitchyardState; at: number; agentId?: string; ownerId?: string };
  let cached: Verdict | null = null;
  let checking: Promise<SwitchyardState> | null = null;
  let reported: string | null = null;

  const audit = (type: string, payload: Record<string, unknown>) =>
    store.db.prepare('INSERT INTO product_audit(type,actor_id,payload_json,created_at) VALUES (?,?,?,?)').run(type, 'system', JSON.stringify(payload), Date.now());
  const remember = (agent: ServiceAgent) =>
    store.db.prepare('INSERT INTO product_settings VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json')
      .run(SWITCHYARD_SETTING, JSON.stringify({ id: agent.id, name: agent.name }));
  // Adopt only the agent Nest made: the marker, the instance owner and a private classic agent.
  const ours = (agent: ServiceAgent, ownerId: string | undefined) =>
    agent.description === SWITCHYARD_MARKER && agent.ownerHumanId === ownerId && agent.visibility === 'PRIVATE' && agent.mode === 'CLASSIC';
  /** One line per change of problem; only a status or an error name, never a body or the token. */
  function report(problem: string | null) {
    if (problem === reported) return;
    reported = problem;
    if (problem) log(`[switchyard] service agent ${agentName} unavailable: ${problem}`);
  }
  const describe = (error: unknown) =>
    error instanceof SwitchyardNoCreatorError ? error.message : error instanceof SwitchyardCreateRefusedError ? error.problem
      : error instanceof EngineError ? `engine status ${error.status}` : error instanceof Error ? error.name : 'unknown error';

  async function stopIfStarted(service: ServiceClient, agent: ServiceAgent) {
    if (agent.desiredState === 'STOPPED') return;
    await service.stopAgent(agentName);
    audit('audit.flows.service_agent.stopped', { agentName, agentId: agent.id, desiredState: agent.desiredState });
  }

  async function check(service: ServiceClient): Promise<Verdict> {
    const humans = await service.humans();
    const owner = [...humans].sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0) || a.id.localeCompare(b.id))[0];
    if (!owner) throw new Error('The engine has no humans');
    let agent = await service.agent(agentName);
    if (!agent) {
      if (!creatorName) throw new SwitchyardNoCreatorError();
      let createError: unknown = null;
      try {
        await service.createAgent({
          name: agentName, description: SWITCHYARD_MARKER, modelId: defaultModelId || DEFAULT_AGENT_MODEL_ID,
          workspacePath: resolve(root, 'switchyard'), ownerHumanId: owner.id, visibility: 'PRIVATE', mode: 'CLASSIC',
          desiredState: 'STOPPED', runtimeState: 'STOPPED', emitAuditEvents: false,
          enabledSkills: [], alwaysPreloadedSkills: [], allowOutsideWorkspace: false, allowOwnerHumanSecrets: false,
        }, creatorName);
      } catch (error) { createError = error; /* A concurrent create or a lost response: reconcile by name below. */ }
      agent = await service.agent(agentName);
      if (!agent && createError instanceof EngineError && createError.status === 403)
        throw new SwitchyardCreateRefusedError(`engine status 403 creating it as ${creatorName} (needs the global runner token and a creator with the SYSTEM role)`);
      if (!agent) throw createError ?? new Error('The created service agent could not be read back');
    }
    if (!ours(agent, owner.id)) return { state: { ok: false, reason: 'name-taken' }, at: now() };
    await stopIfStarted(service, agent);
    remember(agent);
    return { state: { ok: true, name: agentName }, at: now(), agentId: agent.id, ownerId: owner.id };
  }

  /** The adoption verdict, cached for 60 s; `fresh` when this call read the agent from the engine. */
  async function adoption(): Promise<{ state: SwitchyardState; fresh: boolean }> {
    if (!token) return { state: { ok: false, reason: 'no-service-token' }, fresh: false };
    if (cached && now() - cached.at < CACHE_MS) return { state: cached.state, fresh: false };
    checking ??= (async () => {
      try {
        const verdict = await check(orgops.service(token));
        cached = verdict;
        report(verdict.state.ok ? null : 'the name belongs to an agent Nest did not create');
        return verdict.state;
      } catch (error) {
        cached = null;
        report(describe(error));
        // An outage or a missing creator is a state; a 4xx (a wrong or scoped token, a creator without the SYSTEM
        // role, a rejected agent) or a bug is thrown, and availability reports it as engine-unavailable.
        if (isEngineOutage(error) || error instanceof SwitchyardNoCreatorError) return { ok: false, reason: 'engine-unavailable' } as const;
        throw error;
      } finally { checking = null; }
    })();
    return { state: await checking, fresh: true };
  }

  /** Create, adopt or re-stop the service agent. Only the adoption verdict is cached (60 s). */
  const ensure = async (): Promise<SwitchyardState> => (await adoption()).state;

  /**
   * Before every join, post and drain: the agent must still be ours and stopped. A started agent
   * would take turns in every chat it has joined, so it is stopped before anything is sent.
   */
  async function usable(): Promise<ServiceClient> {
    const { state, fresh } = await adoption();
    if (!state.ok) throw new SwitchyardUnavailableError(state.reason);
    const service = orgops.service(token!);
    if (fresh) return service;
    const verdict = cached;
    const agent = await service.agent(agentName);
    if (!agent || !verdict || agent.id !== verdict.agentId || !ours(agent, verdict.ownerId)) {
      // Replaced or edited since the verdict: decide again from scratch.
      cached = null;
      const again = await ensure();
      if (!again.ok) throw new SwitchyardUnavailableError(again.reason);
      return service;
    }
    await stopIfStarted(service, agent);
    return service;
  }

  // Chats the current service agent has joined in this process, as `<agentId>:<channelId>`. A re-created agent has
  // another id, so it joins again before its first post in each chat.
  const joined = new Set<string>();
  const joinKey = (channelId: string) => `${cached?.agentId ?? ''}:${channelId}`;
  async function subscribe(service: ServiceClient, channelId: string) {
    await service.subscribe(channelId, { subscriberType: 'AGENT', subscriberId: agentName });
    joined.add(joinKey(channelId));
  }

  return {
    name: agentName,
    ensure,
    /** Subscribe the service agent to a chat; the engine ignores a repeat. */
    async join(channelId: string): Promise<void> {
      await subscribe(await usable(), channelId);
    },
    /**
     * Post as `agent:<name>`, joining the chat first if this agent has not yet in this process (after a rename or a
     * re-creation, the new agent is not in the old one's chats). The idempotency key makes a retry return the event
     * already stored; an event under the key that Nest did not post (another source, type, chat or key) is refused
     * as a conflict (EngineError 409), never taken as Nest's receipt.
     */
    async post(input: SwitchyardPost): Promise<EngineEvent> {
      const service = await usable();
      if (!joined.has(joinKey(input.channelId))) await subscribe(service, input.channelId);
      const type = input.type ?? 'message.created', source = `agent:${agentName}`;
      const event = await service.post({
        type, source, channelId: input.channelId,
        idempotencyKey: input.idempotencyKey, ...(input.deliverAt === undefined ? {} : { deliverAt: input.deliverAt }),
        payload: {
          text: input.text, targetAgentName: input.target ?? agentName,
          ...(input.attachments?.length ? { attachments: input.attachments } : {}),
          nestSwitchyard: { ...input.meta, kind: input.kind, setBy: input.setBy },
        },
      });
      if (event.source !== source || event.type !== type || event.channelId !== input.channelId || event.idempotencyKey !== input.idempotencyKey) {
        log(`[switchyard] event ${event.id} under a Nest key was not posted by ${agentName}; refused`);
        throw new EngineError(409, '/api/events');
      }
      return event;
    },
    /** One read of the service agent's due receipts, which marks them delivered. Returns the events read. */
    async drain(): Promise<number> {
      let service: ServiceClient;
      try { service = await usable(); } catch (error) {
        if (error instanceof SwitchyardUnavailableError) return 0;
        throw error;
      }
      return (await service.events({ agentName, limit: '500' })).length;
    },
  };
}
export type Switchyard = ReturnType<typeof createSwitchyard>;
