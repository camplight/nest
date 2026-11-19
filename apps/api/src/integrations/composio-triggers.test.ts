import { describe, expect, it } from 'vitest';
import { createComposioClient, createComposioProvider, type ComposioConfig } from './composio';
import { createComposioTriggers } from './composio-triggers';
import { ProviderRequestError } from './provider';

type Seen = { method: string; path: string; query: Record<string, string>; body: unknown };

/** A Composio stand-in: it records each call and answers from `answer` (path → response). */
function fake(answer: (seen: Seen) => Response) {
  const seen: Seen[] = [];
  const config: ComposioConfig = {
    apiKey: 'service-key', instanceId: 'test', callbackUrl: 'https://nest.example/onboarding', authConfigs: {},
    fetch: async (url, init) => {
      const u = new URL(String(url));
      expect(u.origin).toBe('https://backend.composio.dev');
      expect(new Headers(init?.headers).get('x-api-key')).toBe('service-key');
      expect(init?.redirect).toBe('error');
      const call: Seen = {
        method: init?.method ?? 'GET', path: u.pathname.replace('/api/v3.1', ''),
        query: Object.fromEntries(u.searchParams), body: init?.body ? JSON.parse(String(init.body)) : undefined,
      };
      seen.push(call);
      return answer(call);
    },
  };
  return { seen, triggers: createComposioTriggers(createComposioClient(config)), config };
}

const type = (slug: string, toolkit = 'github') => ({
  slug, name: `Name ${slug}`, description: `About ${slug}`, instructions: 'x', types: [], version: '1',
  toolkit: { slug: toolkit, name: toolkit, logo: '' }, config: { type: 'object', properties: { repo: { type: 'string' } } },
  payload: { type: 'object' }, requires_webhook_endpoint_setup: false,
});

describe('Composio triggers client', () => {
  it('lists a toolkit\'s trigger types across pages, keeping only that toolkit\'s', async () => {
    const { seen, triggers } = fake(({ query }) => Response.json(query.cursor
      ? { items: [type('GITHUB_STAR_ADDED_EVENT')], next_cursor: null }
      : { items: [type('GITHUB_COMMIT_EVENT'), type('SLACK_RECEIVE_MESSAGE', 'slack')], next_cursor: 'page-2' }));
    expect(await triggers.types('github')).toEqual([
      { slug: 'GITHUB_COMMIT_EVENT', name: 'Name GITHUB_COMMIT_EVENT', description: 'About GITHUB_COMMIT_EVENT', config: { type: 'object', properties: { repo: { type: 'string' } } } },
      { slug: 'GITHUB_STAR_ADDED_EVENT', name: 'Name GITHUB_STAR_ADDED_EVENT', description: 'About GITHUB_STAR_ADDED_EVENT', config: { type: 'object', properties: { repo: { type: 'string' } } } },
    ]);
    expect(seen.map(s => [s.method, s.path, s.query])).toEqual([
      ['GET', '/triggers_types', { toolkit_slugs: 'github', limit: '50' }],
      ['GET', '/triggers_types', { toolkit_slugs: 'github', limit: '50', cursor: 'page-2' }],
    ]);
  });

  it('creates (upserts) an instance on the connected account with its egress URL', async () => {
    const { seen, triggers } = fake(() => Response.json({ trigger_id: 'ti_abc123', type: 'webhook', fallback_reason: null, polling_interval: null }, { status: 201 }));
    expect(await triggers.create({ slug: 'GITHUB_COMMIT_EVENT', accountId: 'ca_1', config: { repo: 'web' }, egressUrl: 'https://nest.example/api/hooks/composio' }))
      .toEqual({ triggerId: 'ti_abc123' });
    expect(seen).toEqual([{
      method: 'POST', path: '/trigger_instances/GITHUB_COMMIT_EVENT/upsert', query: {},
      body: { connected_account_id: 'ca_1', trigger_config: { repo: 'web' }, egress_url: 'https://nest.example/api/hooks/composio' },
    }]);
  });

  it('refuses an answer without a usable trigger id', async () => {
    const { triggers } = fake(() => Response.json({ trigger_id: '' }));
    await expect(triggers.create({ slug: 'X', accountId: 'ca_1', config: {}, egressUrl: 'https://n.example/api/hooks/composio' })).rejects.toThrow();
  });

  it('enables and disables by status; 409 (already so) is success', async () => {
    let status = 200;
    const { seen, triggers } = fake(() => Response.json({ status: 'success' }, { status }));
    await triggers.setEnabled('ti_1', false);
    await triggers.setEnabled('ti_1', true);
    status = 409;
    await triggers.setEnabled('ti_1', true);
    expect(seen.map(s => [s.method, s.path, s.body])).toEqual([
      ['PATCH', '/trigger_instances/manage/ti_1', { status: 'disable' }],
      ['PATCH', '/trigger_instances/manage/ti_1', { status: 'enable' }],
      ['PATCH', '/trigger_instances/manage/ti_1', { status: 'enable' }],
    ]);
    status = 503;
    await expect(triggers.setEnabled('ti_1', false)).rejects.toBeInstanceOf(ProviderRequestError);
  });

  it('deletes; already gone (404, 409, 410) is success, an empty answer too; a 5xx is a failure', async () => {
    let status = 204;
    const { seen, triggers } = fake(() => new Response(status === 204 ? null : '{}', { status }));
    await triggers.remove('ti/1');
    for (status of [404, 409, 410]) await triggers.remove('ti_1');
    expect(seen.map(s => [s.method, s.path])[0]).toEqual(['DELETE', '/trigger_instances/manage/ti%2F1']);
    expect(seen).toHaveLength(4);
    status = 500;
    await expect(triggers.remove('ti_1')).rejects.toBeInstanceOf(ProviderRequestError);
  });

  it('is the Composio provider\'s triggers capability', () => {
    const { config } = fake(() => Response.json({}));
    expect(createComposioProvider(config).triggers).toEqual(expect.objectContaining({ types: expect.any(Function), create: expect.any(Function) }));
  });
});
