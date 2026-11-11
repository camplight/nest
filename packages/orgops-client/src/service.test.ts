import {expect, it} from 'vitest';
import {createOrgOpsClient, EngineError, EngineUnreachableError, isEngineOutage} from './index';

function recording(answer: (url: URL, init: RequestInit) => Response) {
  const seen: {method: string; path: string; headers: Headers; body: unknown}[] = [];
  const transport = (async (url: URL, init: RequestInit = {}) => {
    seen.push({method: init.method ?? 'GET', path: url.pathname + url.search, headers: new Headers(init.headers), body: init.body});
    return answer(url, init);
  }) as unknown as typeof fetch;
  return {seen, client: createOrgOpsClient('http://engine', transport)};
}

it('posts as the service with the runner token and returns the stored event', async () => {
  const {seen, client} = recording(() => Response.json({id: 'e1', type: 'message.created', source: 'agent:Switchyard', payload: {text: 'hi'}, status: 'PENDING', createdAt: 1}, {status: 201}));
  const event = await client.service('runner-secret').post({type: 'message.created', source: 'agent:Switchyard', channelId: 'c1', payload: {text: 'hi'}, idempotencyKey: 'nest:test:1'});
  expect(event.id).toBe('e1');
  expect(seen).toHaveLength(1);
  expect(seen[0]).toMatchObject({method: 'POST', path: '/api/events'});
  expect(seen[0].headers.get('x-orgops-runner-token')).toBe('runner-secret');
  expect(seen[0].headers.get('content-type')).toBe('application/json');
  expect(JSON.parse(String(seen[0].body))).toEqual({type: 'message.created', source: 'agent:Switchyard', channelId: 'c1', payload: {text: 'hi'}, idempotencyKey: 'nest:test:1'});
});

it('maps a 409 delete to false and throws EngineError with the status otherwise', async () => {
  let status = 409;
  const {seen, client} = recording(() => Response.json({error: 'no'}, {status}));
  const service = client.service('runner-secret');
  expect(await service.deleteEvent('e1')).toBe(false);
  expect(seen[0]).toMatchObject({method: 'DELETE', path: '/api/events/e1'});
  expect(seen[0].headers.get('x-orgops-runner-token')).toBe('runner-secret');
  status = 403;
  const failure = await service.deleteEvent('e1').catch(error => error);
  expect(failure).toBeInstanceOf(EngineError);
  expect(failure.status).toBe(403);
  status = 200;
  expect(await service.deleteEvent('e1')).toBe(true);
});

it('answers null for a missing agent or event, and refuses an empty token', async () => {
  const {client} = recording(() => Response.json({error: 'Not found'}, {status: 404}));
  expect(await client.service('runner-secret').agent('Switchyard')).toBeNull();
  expect(await client.service('runner-secret').event('e1')).toBeNull();
  expect(() => client.service('')).toThrow();
});

it('treats only an unreachable engine or a 5xx answer as an outage', async () => {
  const down = createOrgOpsClient('http://engine', (async () => { throw new TypeError('fetch failed'); }) as unknown as typeof fetch);
  const unreachable = await down.service('runner-secret').humans().catch(error => error);
  expect(unreachable).toBeInstanceOf(EngineUnreachableError);
  expect(isEngineOutage(unreachable)).toBe(true);
  for (const [status, outage] of [[503, true], [500, true], [403, false], [400, false], [401, false]] as const) {
    const {client} = recording(() => Response.json({error: 'x'}, {status}));
    const error = await client.service('runner-secret').humans().catch(failure => failure);
    expect(error).toMatchObject({name: 'EngineError', status});
    expect(isEngineOutage(error)).toBe(outage);
  }
  expect(isEngineOutage(new Error('bug'))).toBe(false);
});
