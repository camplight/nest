// OrgOps 039 consolidates the prompt into soulContents. Keep Nest's published
// systemInstructions field working for saved helpers and cached clients.
export function isAgentSettingsPath(pathname: string) {
  return /^\/api\/agents(?:\/[^/]+)?$/.test(pathname);
}

export async function agentInstructionBody(body: BodyInit): Promise<string> {
  const text = typeof body === 'string' ? body : await new Response(body).text();
  let value: unknown;
  try { value = JSON.parse(text); } catch { return text; }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return text;
  const agent = value as Record<string, unknown>;
  if (!Object.hasOwn(agent, 'soulContents') && Object.hasOwn(agent, 'systemInstructions')) {
    agent.soulContents = agent.systemInstructions;
  }
  delete agent.systemInstructions;
  delete agent.soulPath;
  return JSON.stringify(agent);
}

export async function agentInstructionResponse(response: Response): Promise<Response> {
  if (!response.ok || !response.headers.get('content-type')?.includes('application/json')) return response;
  const alias = (agent: Record<string, unknown>) => ({...agent, systemInstructions: agent.soulContents ?? ''});
  const value = await response.json();
  const headers = new Headers(response.headers);
  headers.delete('content-length');
  headers.delete('content-encoding');
  return Response.json(Array.isArray(value) ? value.map(alias) : alias(value), {status: response.status, headers});
}
