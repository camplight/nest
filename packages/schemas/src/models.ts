/**
 * Display name for an engine model provider. An openai-compatible base URL is an
 * engine secret, so only server code passes `baseUrl`; browsers fall back to the
 * Fireworks model path convention (`accounts/fireworks/...`).
 */
export function modelProviderLabel(provider: string, modelName = '', baseUrl?: string): string {
  if (provider === 'openrouter' || provider === 'or') return 'OpenRouter';
  if (provider === 'openai') return 'OpenAI';
  if (provider === 'anthropic') return 'Anthropic';
  if (provider === 'openai-compatible') {
    let host = '';
    try { host = baseUrl ? new URL(baseUrl).hostname : ''; } catch { host = ''; }
    const fireworks = host ? host === 'fireworks.ai' || host.endsWith('.fireworks.ai') : modelName.startsWith('accounts/fireworks/');
    return fireworks ? 'Fireworks' : 'OpenAI-compatible';
  }
  return provider || 'Unknown provider';
}

/** `provider:model` reference split for display, e.g. `glm-5p3` and `Fireworks`. */
export function describeModelReference(reference: string, baseUrl?: string): {name: string; provider: string} {
  const split = reference.indexOf(':');
  if (split < 0) return {name: reference, provider: ''};
  const provider = reference.slice(0, split), modelName = reference.slice(split + 1);
  const name = provider === 'openai-compatible' ? modelName.split('/').pop() || modelName : modelName;
  return {name, provider: modelProviderLabel(provider, modelName, baseUrl)};
}
