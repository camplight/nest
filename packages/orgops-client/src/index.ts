export type Human = { id: string; username: string; mustChangePassword: boolean; createdAt?: number };
const hopHeaders = ['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'host', 'content-length'];

export function engineHeaders(input: HeadersInit): Headers {
  const headers = new Headers(input);
  const connectionTokens = (headers.get('connection') ?? '').split(',').map(x => x.trim()).filter(Boolean);
  for (const key of [...hopHeaders, ...connectionTokens]) headers.delete(key);
  for (const suffix of ['runner-token', 'agent-name', 'channel-id']) {
    const value = headers.get(`x-nest-${suffix}`);
    if (value !== null) headers.set(`x-orgops-${suffix}`, value);
    headers.delete(`x-nest-${suffix}`);
  }
  const cookies = (headers.get('cookie') ?? '').split(';').map(x => x.trim());
  const nest = cookies.find(x => x.startsWith('nest_session='));
  if (nest !== undefined) {
    headers.set('cookie', [...cookies.filter(x => !/^(nest_session|orgops_session)=/.test(x)), `orgops_session=${nest.slice('nest_session='.length)}`].filter(Boolean).join('; '));
  }
  return headers;
}

export function productHeaders(input: Headers): Headers {
  const headers = new Headers(input);
  for (const key of hopHeaders) headers.delete(key);
  // fetch transparently decompresses the body. Do not forward stale encoding/length.
  headers.delete('content-encoding');
  headers.delete('set-cookie');
  for (const cookie of input.getSetCookie()) headers.append('set-cookie', cookie.replace(/^orgops_session=/, 'nest_session='));
  return headers;
}

export function createOrgOpsClient(baseUrl: string, transport: typeof fetch = fetch) {
  const base = new URL(baseUrl);
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.pathname !== '/' || base.search || base.hash) throw new Error('ORGOPS_URL must be an HTTP origin');
  async function request(path: string, init: RequestInit = {}) {
    if (!path.startsWith('/') || path.startsWith('//')) throw new Error('Expected an engine-relative path');
    const url = new URL(base.origin + path);
    if (url.origin !== base.origin) throw new Error('Invalid engine path');
    return transport(url, { ...init, headers: engineHeaders(init.headers ?? {}), redirect: 'manual', signal: init.signal ?? AbortSignal.timeout(30_000) });
  }
  async function currentHuman(headers: HeadersInit): Promise<Human | null> {
    // Runner credentials must never turn a product settings request into an owner request.
    const humanHeaders = new Headers(headers);
    for (const name of ['x-nest-runner-token', 'x-orgops-runner-token', 'authorization']) humanHeaders.delete(name);
    const result = await request('/api/auth/me', {headers: humanHeaders});
    if (result.status === 401 || result.status === 403) return null;
    if (!result.ok) throw new Error('OrgOps identity lookup failed');
    const user = await result.json() as Human;
    return user.id && user.username !== 'runner' ? user : null;
  }
  async function isOwner(user: Human, headers: HeadersInit) {
    if (user.mustChangePassword) return false;
    const humanHeaders = new Headers(headers);
    for (const name of ['x-nest-runner-token', 'x-orgops-runner-token', 'authorization']) humanHeaders.delete(name);
    const result = await request('/api/humans', {headers: humanHeaders});
    if (!result.ok) throw new Error('OrgOps owner lookup failed');
    const humans = await result.json() as Human[];
    humans.sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0) || a.id.localeCompare(b.id));
    return humans[0]?.id === user.id;
  }
  function humanHeaders(input: HeadersInit) {
    const headers = new Headers(input);
    for (const name of ['authorization', 'x-nest-runner-token', 'x-orgops-runner-token', 'x-nest-agent-name', 'x-orgops-agent-name', 'x-nest-channel-id', 'x-orgops-channel-id']) headers.delete(name);
    return headers;
  }
  async function humanJson<T>(path: string, input: HeadersInit, body?: unknown): Promise<T> {
    const headers = humanHeaders(input);
    if (body !== undefined) headers.set('content-type', 'application/json');
    const result = await request(path, {headers, method: body === undefined ? 'GET' : 'POST', ...(body !== undefined ? {body: JSON.stringify(body)} : {})});
    if (!result.ok) throw new Error(`Engine request failed (${result.status})`);
    return result.json() as Promise<T>;
  }
  return { request, currentHuman, isOwner, humanJson, baseUrl: base.origin };
}
export type OrgOpsClient = ReturnType<typeof createOrgOpsClient>;
