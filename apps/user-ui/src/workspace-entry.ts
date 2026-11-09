const workspaceViews = new Set(['projects', 'agents', 'community', 'dashboard']);

/** Explicit workspace destinations win over a stale onboarding pathname. */
export function canonicalWorkspaceEntry(input: URL): URL {
  const url = new URL(input);
  if (url.pathname === '/onboarding' && workspaceViews.has(url.searchParams.get('view') ?? '')) url.pathname = '/';
  return url;
}

export function isOnboardingEntry(input: URL): boolean {
  const url = canonicalWorkspaceEntry(input);
  return url.searchParams.get('view') === 'onboarding' || url.pathname === '/onboarding';
}
