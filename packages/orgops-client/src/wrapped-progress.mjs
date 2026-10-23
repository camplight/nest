import { createHash } from 'node:crypto';

/** Progress phases the chat renders. `codex-progress` stays for installed NestSystem bridges. */
export const WRAPPED_PROGRESS_PHASES = ['codex-progress', 'wrapped-progress'];

/** Only the trusted wrapper calls this adapter; its credential never reaches the wrapped runtime. */
export function createWrappedProgressPublisher({env = process.env, fetchImpl = fetch, timeoutMs = 2500, phase = 'codex-progress'} = {}) {
  if (!WRAPPED_PROGRESS_PHASES.includes(phase)) throw Error('Unknown wrapped progress phase');
  const agentName = env.ORGOPS_WRAPPED_AGENT_NAME || env.NEST_WRAPPED_AGENT_NAME;
  const channelId = env.ORGOPS_WRAPPED_CHANNEL_ID || env.NEST_WRAPPED_CHANNEL_ID;
  const triggerEventId = env.ORGOPS_WRAPPED_TRIGGER_EVENT_ID || env.NEST_WRAPPED_TRIGGER_EVENT_ID;
  const token = env.ORGOPS_RUNNER_TOKEN;
  if (!agentName || !channelId || !triggerEventId || !token) throw Error('Wrapped progress context missing');
  const origin = new URL(env.ORGOPS_API_URL || 'http://127.0.0.1:8788');
  if (!['http:', 'https:'].includes(origin.protocol) || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) {
    throw Error('Wrapped progress requires an engine HTTP origin');
  }
  return async ({id, text}) => {
    if (typeof id !== 'string' || !id || typeof text !== 'string' || !text.trim()) return;
    const identity = createHash('sha256').update(JSON.stringify([agentName, channelId, triggerEventId, id])).digest('hex');
    const body = JSON.stringify({
      type: 'agent.turn.phase', source: `agent:${agentName}`, channelId,
      parentEventId: triggerEventId, status: 'DELIVERED',
      idempotencyKey: `nest:${phase}:${identity}`,
      payload: {phase, text: text.trim().slice(0, 1600), triggerEventId},
    });
    // A committed response can be lost. Retrying the same identity cannot duplicate it.
    for (let attempt = 0; attempt < 2; attempt++) {
      let response;
      try {
        response = await fetchImpl(new URL('/api/events', origin), {
          method: 'POST', redirect: 'error',
          headers: {'content-type': 'application/json', 'x-orgops-runner-token': token},
          body, signal: AbortSignal.timeout(timeoutMs),
        });
        // Do not log or retain an engine response body, which can contain private context.
        await response.body?.cancel();
      } catch {
        if (attempt === 0) continue;
        throw Error('Wrapped progress unavailable');
      }
      if (response.ok) return;
      if (response.status < 500 || attempt === 1) throw Error('Wrapped progress unavailable');
    }
  };
}
