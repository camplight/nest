import type {ManagedEngineAgent} from './index';

/** A non-2xx engine answer to a service request. Callers branch on `status`; the body is never logged. */
export class EngineError extends Error {
  constructor(readonly status: number, path: string) {
    super(`Engine request failed (${status}) for ${path.split('?')[0]}`);
    this.name = 'EngineError';
  }
}

export type EngineEvent = {
  id: string; type: string; source: string; channelId?: string; parentEventId?: string;
  payload: Record<string, unknown>; status: string; deliverAt?: number; idempotencyKey?: string;
  createdAt: number; payloadTruncated?: boolean;
};
export type EngineChannel = {
  id: string; name: string; visibility: string; ownerHumanId: string | null; archivedAt?: number | null;
  participants: {subscriberType: string; subscriberId: string}[];
};
export type ServiceAgent = ManagedEngineAgent & {desiredState: string; description: string | null};
export type ServicePost = {type: string; source: string; channelId: string; payload: Record<string, unknown>; idempotencyKey: string; deliverAt?: number};

type EngineRequest = (path: string, init?: RequestInit) => Promise<Response>;

/** Engine calls made as Nest's service identity, authenticated by the global runner token. */
export function serviceClient(request: EngineRequest, token: string) {
  if (!token) throw Error('The engine service token is not configured');
  const drop = (response: Response) => response.body?.cancel().catch(() => undefined);
  const headers = (extra: Record<string, string> = {}) => ({'x-orgops-runner-token': token, ...extra});
  async function call(path: string, init: RequestInit = {}, allow: number[] = []) {
    const response = await request(path, {...init, headers: headers(init.headers as Record<string, string> | undefined)});
    if (!response.ok && !allow.includes(response.status)) {
      await drop(response);
      throw new EngineError(response.status, path);
    }
    return response;
  }
  const json = (body: unknown): RequestInit => ({method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(body)});
  async function maybe<T>(path: string): Promise<T | null> {
    const response = await call(path, {}, [404]);
    if (response.status === 404) { await drop(response); return null; }
    return response.json() as Promise<T>;
  }
  const get = async <T>(path: string) => (await call(path)).json() as Promise<T>;
  const name = (value: string) => encodeURIComponent(value);
  return {
    agent: (agentName: string) => maybe<ServiceAgent>(`/api/agents/${name(agentName)}`),
    createAgent: async (body: Record<string, unknown>) => (await call('/api/agents', json(body))).json() as Promise<{id: string}>,
    stopAgent: async (agentName: string) => { await drop(await call(`/api/agents/${name(agentName)}/stop`, {method: 'POST'})); },
    subscribe: async (channelId: string, member: {subscriberType: 'AGENT'; subscriberId: string}) => {
      await drop(await call(`/api/channels/${name(channelId)}/subscribe`, json(member)));
    },
    channels: () => get<EngineChannel[]>('/api/channels?includeArchived=1'),
    humans: () => get<{id: string; username: string; createdAt: number}[]>('/api/humans'),
    runners: () => get<{id: string; online: boolean}[]>('/api/runners'),
    events: (query: Record<string, string>) => get<EngineEvent[]>(`/api/events?${new URLSearchParams(query)}`),
    event: (id: string) => maybe<EngineEvent>(`/api/events/${name(id)}`),
    // 201 creates the event; 200 returns the one already stored under this idempotency key.
    post: async (input: ServicePost) => (await call('/api/events', json(input))).json() as Promise<EngineEvent>,
    // 409: the event is no longer a future scheduled event, so there is nothing left to cancel.
    async deleteEvent(id: string) {
      const response = await call(`/api/events/${name(id)}`, {method: 'DELETE'}, [409]);
      await drop(response);
      return response.status !== 409;
    },
    async upload(fileName: string, bytes: Uint8Array, mime: string) {
      const form = new FormData();
      form.append('file', new Blob([bytes], {type: mime}), fileName);
      const {id} = await (await call('/api/files', {method: 'POST', body: form})).json() as {id: string};
      return {fileId: id};
    },
  };
}
export type ServiceClient = ReturnType<typeof serviceClient>;
