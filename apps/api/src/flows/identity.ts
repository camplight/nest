import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ProductDb } from '@nest/db';
import { DEFAULT_AGENT_MODEL_ID, type EngineEvent, type OrgOpsClient, type ServiceAgent } from '@nest/orgops-client';

/** The engine description that marks the agent Nest made; an agent without it is never adopted. */
export const SWITCHYARD_MARKER = 'Nest service identity for hand-offs, scheduled runs, webhooks and fork seeds. It never takes turns.';
export const SWITCHYARD_SETTING = 'switchyard.agent';
const CACHE_MS = 60_000;

export type SwitchyardKind = 'handoff' | 'run' | 'webhook' | 'fork-seed' | 'note';
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

const defaultWorkspaceRoot = () =>
  resolve(fileURLToPath(new URL('../../../../', import.meta.url)), process.env.NEST_ENGINE_DATA_DIR ?? '.nest-data', 'workspaces/managed');

/**
 * Nest's service identity: a real engine agent that stays stopped, so it never takes turns.
 * Nest posts as it with the global runner token, which keeps its requested `agent:<name>` source.
 */
export function createSwitchyard({ store, orgops, token, name, workspaceRoot, defaultModelId, now = Date.now }: {
  store: ProductDb; orgops: OrgOpsClient; token: string | undefined; name?: string;
  workspaceRoot?: string; defaultModelId?: string; now?: () => number;
}) {
  const agentName = name || process.env.NEST_SWITCHYARD_AGENT_NAME || 'Switchyard';
  const root = workspaceRoot ?? defaultWorkspaceRoot();
  let cached: { state: SwitchyardState; at: number } | null = null;
  let checking: Promise<SwitchyardState> | null = null;

  const audit = (type: string, payload: Record<string, unknown>) =>
    store.db.prepare('INSERT INTO product_audit(type,actor_id,payload_json,created_at) VALUES (?,?,?,?)').run(type, 'system', JSON.stringify(payload), Date.now());
  const remember = (agent: ServiceAgent) =>
    store.db.prepare('INSERT INTO product_settings VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json')
      .run(SWITCHYARD_SETTING, JSON.stringify({ id: agent.id, name: agent.name }));

  async function check(service: ReturnType<OrgOpsClient['service']>): Promise<SwitchyardState> {
    const humans = await service.humans();
    const owner = [...humans].sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0) || a.id.localeCompare(b.id))[0];
    if (!owner) return { ok: false, reason: 'engine-unavailable' };
    // Adopt only the agent Nest made: the marker, the instance owner and a private classic agent.
    const ours = (agent: ServiceAgent) =>
      agent.description === SWITCHYARD_MARKER && agent.ownerHumanId === owner.id && agent.visibility === 'PRIVATE' && agent.mode === 'CLASSIC';
    let agent = await service.agent(agentName);
    if (!agent) {
      try {
        await service.createAgent({
          name: agentName, description: SWITCHYARD_MARKER, modelId: defaultModelId || DEFAULT_AGENT_MODEL_ID,
          workspacePath: resolve(root, 'switchyard'), ownerHumanId: owner.id, visibility: 'PRIVATE', mode: 'CLASSIC',
          desiredState: 'STOPPED', runtimeState: 'STOPPED', emitAuditEvents: false,
          enabledSkills: [], alwaysPreloadedSkills: [], allowOutsideWorkspace: false, allowOwnerHumanSecrets: false,
        });
      } catch { /* A concurrent create or a lost response: reconcile by name below. */ }
      agent = await service.agent(agentName);
      if (!agent) return { ok: false, reason: 'engine-unavailable' };
    }
    if (!ours(agent)) return { ok: false, reason: 'name-taken' };
    if (agent.desiredState !== 'STOPPED') {
      await service.stopAgent(agentName);
      audit('audit.flows.service_agent.stopped', { agentName, agentId: agent.id, desiredState: agent.desiredState });
    }
    remember(agent);
    return { ok: true, name: agentName };
  }

  /** Create, adopt or re-stop the service agent. A usable or name-taken answer is cached for 60 s. */
  async function ensure(): Promise<SwitchyardState> {
    if (!token) return { ok: false, reason: 'no-service-token' };
    if (cached && now() - cached.at < CACHE_MS) return cached.state;
    checking ??= (async () => {
      try {
        const state = await check(orgops.service(token));
        // An engine outage is retried on the next call rather than remembered.
        cached = state.ok || state.reason === 'name-taken' ? { state, at: now() } : null;
        return state;
      } catch {
        cached = null;
        return { ok: false, reason: 'engine-unavailable' } as const;
      } finally { checking = null; }
    })();
    return checking;
  }

  async function usable() {
    const state = await ensure();
    if (!state.ok) throw new SwitchyardUnavailableError(state.reason);
    return orgops.service(token!);
  }

  return {
    name: agentName,
    ensure,
    /** Subscribe the service agent to a chat; the engine ignores a repeat. */
    async join(channelId: string): Promise<void> {
      await (await usable()).subscribe(channelId, { subscriberType: 'AGENT', subscriberId: agentName });
    },
    /** Post as `agent:<name>`. The idempotency key makes a retry return the event already stored. */
    async post(input: SwitchyardPost): Promise<EngineEvent> {
      const service = await usable();
      return service.post({
        type: input.type ?? 'message.created', source: `agent:${agentName}`, channelId: input.channelId,
        idempotencyKey: input.idempotencyKey, ...(input.deliverAt === undefined ? {} : { deliverAt: input.deliverAt }),
        payload: {
          text: input.text, targetAgentName: input.target ?? agentName,
          ...(input.attachments?.length ? { attachments: input.attachments } : {}),
          nestSwitchyard: { ...input.meta, kind: input.kind, setBy: input.setBy },
        },
      });
    },
    /** One read of the service agent's due receipts, which marks them delivered. Returns the events read. */
    async drain(): Promise<number> {
      if (!(await ensure()).ok) return 0;
      return (await orgops.service(token!).events({ agentName, limit: '500' })).length;
    },
  };
}
export type Switchyard = ReturnType<typeof createSwitchyard>;
