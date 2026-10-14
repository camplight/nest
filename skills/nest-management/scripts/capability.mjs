import {createHmac, timingSafeEqual} from 'node:crypto';
const prefix = 'nest_management';
const mac = (payload, key) => createHmac('sha256', key).update('nest:agent-management:v1:' + payload).digest('base64url');
export function createManagementCapability(context, key) {
  if (!key || !context.agentName || !context.channelId || !context.triggerEventId) throw Error('Management request context missing');
  const payload = Buffer.from(JSON.stringify({v:1, ...context})).toString('base64url');
  return `${prefix}.${payload}.${mac(payload,key)}`;
}
export function verifyManagementCapability(token, key, agentName) {
  if (!key || typeof token !== 'string' || token.length > 4096) return null;
  const [kind,payload,signature,extra] = token.split('.');
  if (kind !== prefix || !payload || !signature || extra !== undefined) return null;
  const expected = Buffer.from(mac(payload,key));
  const supplied = Buffer.from(signature);
  if (expected.length !== supplied.length || !timingSafeEqual(expected,supplied)) return null;
  try {
    const claims = JSON.parse(Buffer.from(payload,'base64url').toString('utf8'));
    if (claims.v !== 1 || claims.agentName !== agentName ||
      !['agentName','channelId','triggerEventId'].every(k=>typeof claims[k]==='string' && claims[k].length>0 && claims[k].length<=200)) return null;
    return claims;
  } catch { return null; }
}
// Called by the trusted bridge before spawning Codex. No engine credential escapes.
export function managementEnvironment(env) {
  return {
    NEST_MANAGEMENT_TOKEN:createManagementCapability({
      agentName:env.ORGOPS_WRAPPED_AGENT_NAME||'NestSystem',
      channelId:env.ORGOPS_WRAPPED_CHANNEL_ID||env.NEST_WRAPPED_CHANNEL_ID,
      triggerEventId:env.ORGOPS_WRAPPED_TRIGGER_EVENT_ID||env.NEST_WRAPPED_TRIGGER_EVENT_ID,
    },env.ORGOPS_RUNNER_TOKEN),
    NEST_MANAGEMENT_URL:env.ORGOPS_MANAGEMENT_URL||'http://127.0.0.1:8789',
  };
}
