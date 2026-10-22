// Only previews hosted by this Nest instance can be embedded.
export function demoArtifacts(text: string, origin: string): string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(/https?:\/\/[^\s<>"')\]]+|\/demo\/[^\s<>"')\]]+/g)) {
    try {
      const url = new URL(match[0], origin);
      if (url.origin !== origin || url.username || url.password) continue;
      const slug = /^\/demo\/([a-z0-9]+(?:-[a-z0-9]+)*)\/?$/.exec(url.pathname)?.[1];
      if (slug && slug.length <= 64) found.add('/demo/' + slug);
    } catch { /* Ordinary prose is not an artifact URL. */ }
  }
  return [...found];
}
