import { createHash } from 'node:crypto';
import { modelProviderLabel, type CompatibleCatalog, type CompatibleModel } from '@nest/schemas';

// OpenAI-compatible model names may nest paths (Fireworks: accounts/fireworks/models/glm-5p3) but never contain ':'.
export const compatibleModelName = /^[a-zA-Z0-9][a-zA-Z0-9._-]*(?:\/[a-zA-Z0-9][a-zA-Z0-9._-]*)*$/;
const FIREWORKS_NAMES = 'https://api.fireworks.ai/v1/accounts/fireworks/models?pageSize=200&filter=supports_serverless%3Dtrue';
type Details = Map<string, {name: string; description: string}>;

const lastSegment = (id: string) => id.split('/').pop() || id;
/** `glm-5p3-fast` reads as `Glm 5.3 fast` when the provider gives no display name. */
function readable(segment: string) {
  const text = segment.replace(/(\d)p(\d)/g, '$1.$2').replaceAll('-', ' ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}
function detailsFrom(value: unknown): Details {
  const rows = (value as {models?: unknown[]})?.models;
  const details: Details = new Map();
  if (!Array.isArray(rows)) return details;
  for (const row of rows as any[]) {
    if (typeof row?.name === 'string' && typeof row.displayName === 'string' && row.displayName.trim())
      details.set(row.name, {name: row.displayName.trim().slice(0, 120), description: typeof row.description === 'string' ? row.description.slice(0, 600) : ''});
  }
  return details;
}
function nameFor(id: string, route: boolean, details: Details) {
  const own = details.get(id);
  if (own) return own;
  const segment = lastSegment(id);
  if (route) {
    // A route (Fireworks `routers/glm-5p3-fast`) takes the name of the model it serves, plus its variant.
    let best: {segment: string; detail: {name: string; description: string}} | undefined;
    for (const [modelId, detail] of details) {
      const base = lastSegment(modelId);
      if (segment.startsWith(base + '-') && (!best || base.length > best.segment.length)) best = {segment: base, detail};
    }
    if (best) return {name: `${best.detail.name} (${segment.slice(best.segment.length + 1).replaceAll('-', ' ')})`, description: best.detail.description};
  }
  // Outside `accounts/…` the whole ID names it, so `auto` and `firerouter/auto` stay distinct.
  return {name: readable(id.startsWith('accounts/') ? segment : id.replaceAll('/', '-')), description: ''};
}
/** Tool-capable chat models from an OpenAI-compatible `/models` list: models newest first, then routes. */
export function normalizeCompatibleModels(list: unknown, names?: unknown): CompatibleModel[] {
  const rows = (list as {data?: unknown[]})?.data;
  if (!Array.isArray(rows)) throw Error('Invalid model list');
  const details = detailsFrom(names);
  const flag = (v: unknown) => typeof v === 'boolean' ? v : null;
  const models = (rows.slice(0, 1000) as any[]).flatMap((row): CompatibleModel[] => {
    if (!row || typeof row.id !== 'string' || row.id.length > 180 || !compatibleModelName.test(row.id)) return [];
    // Agents need chat with tools; embeddings and models that say otherwise are left out.
    if (row.kind === 'EMBEDDING_MODEL' || row.supports_chat === false || row.supports_tools === false) return [];
    const route = row.id.includes('/routers/') || row.kind === 'ROUTER';
    const {name, description} = nameFor(row.id, route, details);
    return [{id: row.id, name, description,
      context: typeof row.context_length === 'number' && row.context_length > 0 ? row.context_length : null,
      tools: flag(row.supports_tools), vision: flag(row.supports_image_input),
      created: typeof row.created === 'number' ? row.created : null, route}];
  });
  return models.sort((a, b) => Number(a.route) - Number(b.route) || (b.created ?? -1) - (a.created ?? -1));
}
const isFireworks = (baseUrl: string) => { const host = new URL(baseUrl).hostname; return host === 'fireworks.ai' || host.endsWith('.fireworks.ai'); };

/** The agent's provider model list, read server-side with its own key; keys and the base URL never leave Nest. */
export function createCompatibleCatalog(transport: typeof fetch = fetch, now = Date.now) {
  const cache = new Map<string, CompatibleCatalog>();
  const pending = new Map<string, Promise<CompatibleCatalog>>();
  async function read(url: string, apiKey: string) {
    const response = await transport(url, {headers: {authorization: `Bearer ${apiKey}`, accept: 'application/json'}, signal: AbortSignal.timeout(8000), redirect: 'error'});
    if (!response.ok) throw Error('Model list unavailable');
    return response.json();
  }
  return async ({apiKey, baseUrl}: {apiKey: string; baseUrl: string}): Promise<CompatibleCatalog> => {
    const base = new URL(baseUrl);
    if (base.protocol !== 'https:' && base.protocol !== 'http:') throw Error('Unsupported base URL');
    const root = base.toString().replace(/\/+$/, '');
    const key = createHash('sha256').update(`${root}\n${apiKey}`).digest('hex');
    const hit = cache.get(key);
    if (hit && now() - hit.fetchedAt < 15 * 60_000) return hit;
    const running = pending.get(key);
    if (running) return running;
    const work = (async () => {
      try {
        const fireworks = isFireworks(root);
        const [list, names] = await Promise.all([
          read(`${root}/models`, apiKey),
          // Display names are a nicety; the list works without them.
          fireworks ? read(FIREWORKS_NAMES, apiKey).catch(() => undefined) : undefined,
        ]);
        const models = normalizeCompatibleModels(list, names);
        if (!models.length) throw Error('Empty model list');
        const catalog = {provider: modelProviderLabel('openai-compatible', '', root), models, fetchedAt: now(), stale: false};
        if (cache.size >= 20 && !cache.has(key)) cache.delete(cache.keys().next().value!);
        cache.set(key, catalog);
        return catalog;
      } catch {
        if (hit && now() - hit.fetchedAt < 24 * 60 * 60_000) return {...hit, stale: true};
        throw Error('The provider’s model list is unavailable. You can still enter an exact model ID.');
      } finally { pending.delete(key); }
    })();
    pending.set(key, work);
    return work;
  };
}
