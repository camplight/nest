import {canonicalWorkspaceEntry} from './workspace-entry';

const key = 'nest-workspace-login-return';
const origin = 'https://nest.invalid';

// Keep OAuth return intent in this browser tab, without expanding the engine's
// redirect allowlist. Accept only workspace paths, never arbitrary URLs.
export function workspaceLoginDestination(path: string): string | null {
  if (!path.startsWith('/') || path.startsWith('//') || /[\\\u0000-\u0020]/.test(path)) return null;
  const url = canonicalWorkspaceEntry(new URL(path, origin));
  if (url.origin !== origin || !['/', '/onboarding'].includes(url.pathname)) return null;
  if (!url.searchParams.has('view') && !url.searchParams.has('channel') && !url.searchParams.has('share') && url.pathname !== '/onboarding') return null;
  url.searchParams.delete('authError');
  return url.pathname + url.search + url.hash;
}

export function rememberWorkspaceLoginReturn(path: string, storage?: Storage) {
  try {
    storage ??= sessionStorage;
    const destination = workspaceLoginDestination(path);
    if (destination) storage.setItem(key, JSON.stringify({path: destination, expires: Date.now() + 10 * 60_000}));
    else storage.removeItem(key);
  } catch { /* Login still works when storage is unavailable. */ }
}

export function consumeWorkspaceLoginReturn(current: string, storage?: Storage): string | null {
  try {
    storage ??= sessionStorage;
    const saved = JSON.parse(storage.getItem(key) ?? 'null');
    storage.removeItem(key);
    // A newly opened explicit destination always wins over an earlier attempt.
    if (workspaceLoginDestination(current)) return null;
    if (typeof saved?.path !== 'string' || typeof saved?.expires !== 'number' || saved.expires <= Date.now()) return null;
    return workspaceLoginDestination(saved.path);
  } catch { return null; }
}
