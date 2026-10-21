// Accept only local demo destinations. Never use a caller-supplied URL as an
// arbitrary post-login redirect, including protocol-relative or escaped paths.
export function demoReturnTo(search: string, hash = ''): string | null {
  const value = new URLSearchParams(search).get('returnTo');
  if (!value?.startsWith('/demo/') || /[\\\u0000-\u0020]/.test(value)) return null;
  try {
    const url = new URL(value, 'https://nest.invalid');
    if (url.origin !== 'https://nest.invalid' || !url.pathname.startsWith('/demo/')) return null;
    if (!url.hash && hash) url.hash = hash;
    return url.pathname + url.search + url.hash;
  } catch { return null; }
}

const key = 'nest-demo-login-return';
// Google callbacks return to the root UI. Keep the destination in this tab only,
// with a short expiry, rather than expanding the engine's OAuth redirect policy.
export function rememberDemoReturnTo(path: string) {
  try {
    if (demoReturnTo('?returnTo=' + encodeURIComponent(path))) {
      window.sessionStorage.setItem(key, JSON.stringify({path, expires: Date.now() + 10 * 60_000}));
    }
  } catch { /* Browsers may disable session storage. Login itself remains usable. */ }
}
export function pendingDemoReturnTo(): string | null {
  try {
    const saved = JSON.parse(window.sessionStorage.getItem(key) ?? 'null');
    if (typeof saved?.path !== 'string' || typeof saved?.expires !== 'number' || saved.expires < Date.now()) {
      clearDemoReturnTo();
      return null;
    }
    return demoReturnTo('?returnTo=' + encodeURIComponent(saved.path));
  } catch { return null; }
}
export function clearDemoReturnTo() {
  try { window.sessionStorage.removeItem(key); } catch {}
}
