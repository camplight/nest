import type { OpenRouterModel, OpenRouterCatalog } from '@nest/schemas';

export const modelSlug = /^[a-zA-Z0-9][a-zA-Z0-9._-]*\/[a-zA-Z0-9][a-zA-Z0-9._-]*$/;
export function normalizeModels(value: unknown): OpenRouterModel[] {
  const rows = (value as {data?: unknown[]})?.data;
  if (!Array.isArray(rows)) throw Error('Invalid catalog');
  const price = (v: unknown) => typeof v === 'string' && v.trim() && Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) * 1_000_000 : null;
  return rows.flatMap((row: any) => {
    if (!row || typeof row.id !== 'string' || !modelSlug.test(row.id) || !row.architecture?.output_modalities?.includes('text')) return [];
    return [{id:row.id, canonicalSlug:typeof row.canonical_slug==='string'?row.canonical_slug:row.id, name:typeof row.name === 'string' ? row.name : row.id,
      description:typeof row.description === 'string' ? row.description.slice(0,1200) : '',
      context:typeof row.context_length === 'number' && row.context_length > 0 ? row.context_length : null,
      inputPrice:price(row.pricing?.prompt), outputPrice:price(row.pricing?.completion),
      tools:Array.isArray(row.supported_parameters) && row.supported_parameters.includes('tools'),
      vision:Array.isArray(row.architecture?.input_modalities) && row.architecture.input_modalities.includes('image'),
      reasoning:Array.isArray(row.supported_parameters) && row.supported_parameters.includes('reasoning')}];
  });
}
export function createOpenRouterCatalog(transport: typeof fetch = fetch, now = Date.now) {
  let cached: OpenRouterCatalog | undefined;
  let pending: Promise<OpenRouterCatalog> | undefined;
  return async (): Promise<OpenRouterCatalog> => {
    if (cached && now() - cached.fetchedAt < 15 * 60_000) return cached;
    if (pending) return pending;
    pending = (async () => {
      try {
        const response = await transport('https://openrouter.ai/api/v1/models?sort=most-popular', {signal:AbortSignal.timeout(8000),redirect:'error'});
        if (!response.ok) throw Error('Catalog unavailable');
        const models = normalizeModels(await response.json());
        if (!models.length) throw Error('Empty catalog');
        cached = {models, fetchedAt:now(), stale:false};
        return cached;
      } catch {
        if (cached && now() - cached.fetchedAt < 24 * 60 * 60_000) return {...cached,stale:true};
        throw Error('OpenRouter catalog is unavailable. You can still use a configured model or enter an exact model ID.');
      } finally { pending = undefined; }
    })();
    return pending;
  };
}
