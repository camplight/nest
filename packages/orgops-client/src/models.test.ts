import {afterEach, expect, it, vi} from 'vitest';
import {createOrgOpsClient, providerEnvKeys} from './index';

afterEach(() => vi.unstubAllEnvs());

// The engine's /api/secrets/env answer for an agent: provider keys plus a secret that must never be forwarded.
const engineEnv = {
  OPENROUTER_API_KEY: 'fixture-openrouter-key',
  OPENAI_COMPATIBLE_API_KEY: 'fixture-compatible-key',
  OPENAI_COMPATIBLE_BASE_URL: 'https://api.fireworks.ai/inference/v1',
  UNRELATED_SECRET: 'never-forward',
};

function engine() {
  const seen: {path: string; headers: Headers}[] = [];
  const transport = (async (url: URL, init: RequestInit = {}) => {
    const path = url.pathname + url.search;
    seen.push({path, headers: new Headers(init.headers)});
    if (path === '/api/secrets/env') return Response.json(engineEnv);
    if (path === '/api/agents/Builder') return Response.json({id: 'agent-1', allowOwnerHumanSecrets: false});
    return Response.json({error: 'Not found'}, {status: 404});
  }) as unknown as typeof fetch;
  return {seen, client: createOrgOpsClient('http://engine', transport)};
}

it('offers enabled openai-compatible models with slash-separated names and skips disabled ones', () => {
  const {client} = engine();
  expect(client.nativeModels([
    {id: 'fireworks-glm', provider: 'openai-compatible', modelName: 'accounts/fireworks/models/glm-5p3', enabled: true},
    {id: 'fireworks-off', provider: 'openai-compatible', modelName: 'accounts/fireworks/models/off', enabled: false},
    {id: 'router', provider: 'openrouter', modelName: 'z-ai/glm-5.3', enabled: true},
    {id: 'unsupported', provider: 'liquid', modelName: 'lfm', enabled: true},
  ])).toEqual([
    {id: 'fireworks-glm', provider: 'openai-compatible', name: 'accounts/fireworks/models/glm-5p3', reference: 'openai-compatible:accounts/fireworks/models/glm-5p3'},
    {id: 'router', provider: 'openrouter', name: 'z-ai/glm-5.3', reference: 'openrouter:z-ai/glm-5.3'},
  ]);
});

it('returns only the model provider keys from the agent secret context', async () => {
  const {seen, client} = engine();
  expect(await client.agentModelEnv('Builder', 'runner-secret', 'openai-compatible:accounts/fireworks/models/glm-5p3')).toEqual({
    OPENAI_COMPATIBLE_API_KEY: 'fixture-compatible-key',
    OPENAI_COMPATIBLE_BASE_URL: 'https://api.fireworks.ai/inference/v1',
  });
  expect(seen[0].headers.get('x-orgops-agent-name')).toBe('Builder');
  expect(seen[0].headers.get('x-orgops-runner-token')).toBe('runner-secret');
  // OpenRouter stays the default for the OpenRouter model picker.
  expect(await client.agentModelEnv('Builder', 'runner-secret')).toEqual({
    OPENROUTER_API_KEY: 'fixture-openrouter-key', OPENROUTER_BASE_URL: undefined, OPENROUTER_HTTP_REFERER: undefined, OPENROUTER_APP_TITLE: undefined,
  });
});

it('resolves both openai-compatible keys for project naming and summaries', async () => {
  vi.stubEnv('OPENAI_COMPATIBLE_API_KEY', '');
  vi.stubEnv('OPENAI_COMPATIBLE_BASE_URL', '');
  const {client} = engine();
  const env = await client.projectNamingEnv({token: 'runner-secret', agentName: 'Builder', agentId: 'agent-1', model: 'openai-compatible:accounts/fireworks/models/glm-5p3'});
  expect(env).toEqual({OPENAI_COMPATIBLE_API_KEY: 'fixture-compatible-key', OPENAI_COMPATIBLE_BASE_URL: 'https://api.fireworks.ai/inference/v1'});
});

it('uses the process environment only when every required openai-compatible key is set there', async () => {
  const {seen, client} = engine();
  vi.stubEnv('OPENAI_COMPATIBLE_API_KEY', 'process-key');
  vi.stubEnv('OPENAI_COMPATIBLE_BASE_URL', '');
  const model = 'openai-compatible:accounts/fireworks/models/glm-5p3';
  // A key without a base URL falls through to the engine secret context.
  expect((await client.projectNamingEnv({token: 'runner-secret', agentName: 'Builder', model})).OPENAI_COMPATIBLE_API_KEY).toBe('fixture-compatible-key');
  expect(seen.some(s => s.path === '/api/secrets/env')).toBe(true);
  vi.stubEnv('OPENAI_COMPATIBLE_BASE_URL', 'https://process.example/v1');
  seen.length = 0;
  expect(await client.projectNamingEnv({model})).toEqual({OPENAI_COMPATIBLE_API_KEY: 'process-key', OPENAI_COMPATIBLE_BASE_URL: 'https://process.example/v1'});
  expect(seen).toHaveLength(0);
});

it('keeps the existing provider key mapping', () => {
  expect(providerEnvKeys('openrouter:x/y').required).toEqual(['OPENROUTER_API_KEY']);
  expect(providerEnvKeys('or').keys).toContain('OPENROUTER_APP_TITLE');
  expect(providerEnvKeys('anthropic:claude').keys).toEqual(['ANTHROPIC_API_KEY']);
  expect(providerEnvKeys('openai:gpt').keys).toEqual(['OPENAI_API_KEY']);
});
